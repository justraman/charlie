// Execute one shard: fetch the run bundle, run this shard's slice of flows, post
// a shard-result. The heavy lifting (step dispatch, placeholder resolution,
// event emission) lives in @charlie/flow-core; the engine only supplies an
// adapter. A fake engine (CHARLIE_FAKE_ENGINE=1) runs the whole callback
// handshake without a browser — used for local integration testing.

import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeFlow, type FlowStep, type StepEvent } from '@charlie/flow-core'
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
  // Artifact keys must match the presign name regex (/^[\w.\-/]+$/), so fold any
  // spaces/punctuation in the flow name into underscores.
  const safeFlow = flowName.replace(/[^\w.-]/g, '_') || 'flow'
  return async (name: string, bytes: Uint8Array, contentType: string): Promise<string> => {
    const { uploadUrl, key } = await presign(cfg, runId, shard, `${safeFlow}/${name}`)
    await uploadArtifact(cfg, uploadUrl, bytes, contentType)
    return key
  }
}

/** Render the executor's step events into a human-readable per-flow log. */
function formatStepEvent(e: StepEvent): string | null {
  const label = e.label ? ` (${e.label})` : ''
  if (e.type === 'step-start') return `→ step ${e.index} ${e.action}${label}`
  if (e.type === 'step-end')
    return `  ✓ step ${e.index} ${e.action} — ${e.status} (${e.durationMs}ms)`
  if (e.type === 'error')
    return `  ✗ step ${e.index} ${e.action} — FAILED (${e.durationMs}ms): ${e.error}`
  return null
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
      for (let flowIdx = 0; flowIdx < flows.length; flowIdx++) {
        const flow = flows[flowIdx]!
        const page = await context.newPage()
        const upload = uploaderFor(cfg, runId, shardIndex, flow.name)

        // Per-flow log: browser console + page errors + each step's result.
        // Captured for passing and failing flows alike so every run has a log.
        const log: string[] = [`flow: ${flow.name}`, `shard: ${shardIndex}`, '']
        page.on('console', (msg) => log.push(`  [console:${msg.type()}] ${msg.text()}`))
        page.on('pageerror', (err) => log.push(`  [pageerror] ${err.message}`))
        const emit = (e: StepEvent) => {
          const line = formatStepEvent(e)
          if (line) log.push(line)
        }

        // A Playwright trace (viewable at trace.playwright.dev or via
        // `npx playwright show-trace trace.zip`) is our "report" — captured for
        // every flow regardless of outcome, not only on failure.
        let traceOn = false
        try {
          await context.tracing.start({ screenshots: true, snapshots: true, sources: true })
          traceOn = true
        } catch (err) {
          console.error(`[charlie] tracing.start failed for ${flow.name}:`, err)
        }

        const adapter = new PlaywrightAdapter(
          page,
          context,
          bundle.environment.baseUrl,
          upload,
          bundle.environment.headers,
        )
        const started = Date.now()
        const run = await executeFlow(
          flow.steps as FlowStep[],
          { adapter, secrets: bundle.environment.secrets, vars: {} },
          { emit },
        )
        const durationMs = Date.now() - started

        // Failure screenshots emitted by the executor's captureOnFail path.
        for (const s of run.steps) {
          if (s.artifacts)
            for (const k of Object.values(s.artifacts))
              if (k.startsWith('runs/')) artifactKeys.push(k)
        }

        // Final screenshot — a quick visual the UI renders inline, on pass too.
        try {
          const shot = await page.screenshot({ fullPage: true })
          artifactKeys.push(await upload('final.png', shot, 'image/png'))
        } catch (err) {
          console.error(`[charlie] final screenshot failed for ${flow.name}:`, err)
        }

        // Stop + upload the trace.
        if (traceOn) {
          const tracePath = join(tmpdir(), `charlie-trace-${shardIndex}-${flowIdx}.zip`)
          try {
            await context.tracing.stop({ path: tracePath })
            const bytes = new Uint8Array(await readFile(tracePath))
            artifactKeys.push(await upload('trace.zip', bytes, 'application/zip'))
          } catch (err) {
            console.error(`[charlie] trace capture failed for ${flow.name}:`, err)
          } finally {
            await unlink(tracePath).catch(() => {})
          }
        }

        // Upload the log last so it records the final status.
        log.push('', `status: ${run.status}`, `durationMs: ${durationMs}`)
        if (run.failedStepIndex !== undefined) log.push(`failedStep: ${run.failedStepIndex}`)
        try {
          artifactKeys.push(
            await upload('log.txt', new TextEncoder().encode(log.join('\n')), 'text/plain'),
          )
        } catch (err) {
          console.error(`[charlie] log upload failed for ${flow.name}:`, err)
        }

        results.push({
          flow: flow.name,
          status: run.status,
          durationMs,
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
