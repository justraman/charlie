// Execute one shard: fetch the run bundle, run this shard's slice of flows, post
// a shard-result. The heavy lifting (step dispatch, placeholder resolution,
// event emission) lives in @charlie/flow-core; the engine only supplies an
// adapter. A fake engine (CHARLIE_FAKE_ENGINE=1) runs the whole callback
// handshake without a browser — used for local integration testing.

import { executeFlow, type FlowStep } from '@charlie/flow-core'
import type { Browser } from 'playwright-core'
import {
  type Bundle,
  type BundleFlow,
  fetchBundle,
  finalize,
  postShardResult,
  presign,
  type RunnerConfig,
  uploadArtifact,
} from './api'
import { runK6Shard } from './k6-engine'
import { PlaywrightAdapter } from './playwright-adapter'

export interface ExecuteOptions {
  cfg: RunnerConfig
  runId: string
  shardIndex: number
  engine: 'playwright' | 'k6'
}

interface FlowResult {
  flow: string
  status: 'passed' | 'failed'
  durationMs?: number
  failedStep?: number
  error?: string
}

/** Round-robin: shard i runs flows whose index ≡ i (mod expectedShards). */
function flowsForShard(bundle: Bundle, shardIndex: number): BundleFlow[] {
  const total = Math.max(1, bundle.expectedShards)
  return bundle.flows.filter((_, i) => i % total === shardIndex)
}

function uploaderFor(cfg: RunnerConfig, runId: string, shard: number, flowName: string) {
  return async (name: string, bytes: Uint8Array, contentType: string): Promise<string> => {
    const { uploadUrl, key } = await presign(cfg, runId, shard, `${flowName}/${name}`)
    await uploadArtifact(cfg, uploadUrl, bytes, contentType)
    return key
  }
}

export async function runExecute(opts: ExecuteOptions): Promise<void> {
  const { cfg, runId, shardIndex, engine } = opts
  const bundle = await fetchBundle(cfg, runId)
  const flows = flowsForShard(bundle, shardIndex)
  const results: FlowResult[] = []
  const artifactKeys: string[] = []

  const fake = process.env.CHARLIE_FAKE_ENGINE === '1'

  if (engine === 'k6') {
    // k6 drives concurrency internally (VUs/stages); the engine compiles the
    // flows, runs k6, and posts a load_summary as this shard's result.
    await runK6Shard(cfg, bundle, flows, shardIndex)
    return
  }

  if (fake) {
    for (const flow of flows) {
      // A flow whose name contains "fail" fails, to exercise both paths.
      const failed = /fail/i.test(flow.name)
      const upload = uploaderFor(cfg, runId, shardIndex, flow.name)
      const key = await upload(
        'marker.txt',
        new TextEncoder().encode(`ran ${flow.name}`),
        'text/plain',
      )
      artifactKeys.push(key)
      results.push(
        failed
          ? { flow: flow.name, status: 'failed', failedStep: 0, error: 'synthetic failure' }
          : { flow: flow.name, status: 'passed', durationMs: 5 },
      )
    }
  } else {
    const { chromium } = await import('playwright-core')
    let browser: Browser | undefined
    try {
      browser = await chromium.launch({ headless: true })
      const context = await browser.newContext()
      await context.setExtraHTTPHeaders(bundle.environment.headers)
      for (const flow of flows) {
        const page = await context.newPage()
        const adapter = new PlaywrightAdapter(
          page,
          context,
          bundle.environment.baseUrl,
          uploaderFor(cfg, runId, shardIndex, flow.name),
          bundle.environment.headers,
        )
        const started = Date.now()
        const run = await executeFlow(flow.steps as FlowStep[], {
          adapter,
          secrets: bundle.environment.secrets,
          vars: {},
        })
        for (const s of run.steps) {
          if (s.artifacts)
            for (const k of Object.values(s.artifacts))
              if (k.startsWith('runs/')) artifactKeys.push(k)
        }
        results.push({
          flow: flow.name,
          status: run.status,
          durationMs: Date.now() - started,
          failedStep: run.failedStepIndex,
          error: run.steps.find((s) => s.error)?.error,
        })
        await page.close()
      }
    } finally {
      await browser?.close()
    }
  }

  const shardStatus = results.some((r) => r.status === 'failed') ? 'failed' : 'passed'
  await postShardResult(cfg, runId, {
    shardIndex,
    status: shardStatus,
    runner: 'github-actions',
    flowResults: results,
    artifactKeys,
  })
}

export async function runFetchFlow(cfg: RunnerConfig, runId: string): Promise<void> {
  const bundle = await fetchBundle(cfg, runId)
  console.info(
    `[charlie] fetched bundle for run ${runId}: engine=${bundle.engine} flows=${bundle.flows
      .map((f) => f.name)
      .join(',')} shards=${bundle.expectedShards}`,
  )
}

export async function runFinalize(cfg: RunnerConfig, runId: string): Promise<void> {
  await finalize(cfg, runId)
  console.info(`[charlie] finalized run ${runId}`)
}
