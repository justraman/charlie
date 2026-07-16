// k6 load engine (compute plane). Compiles the run's flows into HTTP scenarios,
// bundles the k6 entrypoint with esbuild (k6 can't import Node at runtime, so
// the scenario is baked in via a virtual module), runs `k6 run`, parses the
// end-of-test summary into a load_summary, and posts it as the shard result.
// Pass/fail is decided by the resolved thresholds (see docs/TEST_ENGINES.md).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import {
  compileK6Scenario,
  type K6Scenario,
  type LoadProfile,
  type LoadSummary,
  resolveLoadProfile,
  resolvePlaceholders,
  summarizeK6,
} from '@charlie/flow-core'
import { build, type Plugin } from 'esbuild'
import type { Bundle, BundleFlow, RunnerConfig } from './api'
import { postShardResult } from './api'

const SUMMARY_FILE = 'summary.json'

interface InjectedScenario {
  options: { stages: { duration: string; target: number }[]; thresholds: Record<string, string[]> }
  scenarios: K6Scenario[]
  baseUrl: string
  summaryPath: string
}

// esbuild plugin that satisfies `import ... from 'virtual:charlie-scenario'`
// with the compiled scenario + resolved options.
function scenarioPlugin(data: InjectedScenario): Plugin {
  return {
    name: 'charlie-scenario',
    setup(b) {
      b.onResolve({ filter: /^virtual:charlie-scenario$/ }, () => ({
        path: 'virtual:charlie-scenario',
        namespace: 'charlie-scenario',
      }))
      b.onLoad({ filter: /.*/, namespace: 'charlie-scenario' }, () => ({
        contents: [
          `export const options = ${JSON.stringify(data.options)};`,
          `export const scenarios = ${JSON.stringify(data.scenarios)};`,
          `export const baseUrl = ${JSON.stringify(data.baseUrl)};`,
          `export const summaryPath = ${JSON.stringify(data.summaryPath)};`,
        ].join('\n'),
        loader: 'js',
      }))
    },
  }
}

// Resolve {{secrets.*}} across a scenario's request strings, keeping {{vars.*}}
// for runtime resolution in the k6 entrypoint. Secrets never leave this process
// except baked into the ephemeral bundle on the compute-plane runner.
function resolveSecretsInScenario(
  scenario: K6Scenario,
  secrets: Record<string, string>,
): K6Scenario {
  const sub = (s: string) => resolvePlaceholders(s, { secrets }, 'keep')
  const subMap = (m: Record<string, string>) => {
    const out: Record<string, string> = {}
    for (const k of Object.keys(m)) out[k] = sub(m[k]!)
    return out
  }
  return {
    ...scenario,
    requests: scenario.requests.map((r) => ({
      ...r,
      url: sub(r.url),
      headers: subMap(r.headers),
      formBody: r.formBody ? subMap(r.formBody) : undefined,
    })),
  }
}

function compileScenarios(bundle: Bundle, flows: BundleFlow[]): K6Scenario[] {
  return flows.map((f) =>
    resolveSecretsInScenario(compileK6Scenario(f.steps, f.name), bundle.environment.secrets),
  )
}

// The flow's own loadProfile overrides the run profile's stage/threshold preset.
function resolveOptions(bundle: Bundle, flows: BundleFlow[]) {
  const override: LoadProfile | null = flows.find((f) => f.loadProfile)?.loadProfile ?? null
  const profile = (bundle.profile as LoadProfile['profile']) ?? 'smoke'
  const resolved = resolveLoadProfile(profile, override)
  return { stages: resolved.stages, thresholds: resolved.thresholds }
}

/** Build a synthetic summary so the whole handshake + report is testable
 *  without a k6 binary (CHARLIE_FAKE_ENGINE=1). The `stress` profile (or a flow
 *  named to suggest failure) breaches the latency threshold so both the pass and
 *  fail paths are exercised. */
function fakeSummary(flows: BundleFlow[], profile: string): unknown {
  const breach = profile === 'stress' || flows.some((f) => /breach|fail/i.test(f.name))
  const p95 = breach ? 1200 : 420
  return {
    metrics: {
      http_req_duration: {
        values: { 'p(50)': 110, 'p(95)': p95, 'p(99)': p95 + 200, med: 110 },
        thresholds: { 'p(95)<800': { ok: !breach, fails: breach ? 1 : 0 } },
      },
      http_req_failed: { values: { rate: 0.002 }, thresholds: { 'rate<0.01': { ok: true } } },
      http_reqs: { values: { count: 1234, rate: 20.5 } },
      checks: { values: { passes: 42, fails: 0 } },
    },
  }
}

export interface K6ShardResult {
  status: 'passed' | 'failed' | 'errored'
  summary: LoadSummary | null
  scenarios: K6Scenario[]
}

/** Run this shard's k6 load test end to end and post the shard result. */
export async function runK6Shard(
  cfg: RunnerConfig,
  bundle: Bundle,
  flows: BundleFlow[],
  shardIndex: number,
): Promise<K6ShardResult> {
  const scenarios = compileScenarios(bundle, flows)
  const options = resolveOptions(bundle, flows)
  const fake = process.env.CHARLIE_FAKE_ENGINE === '1'

  let summary: LoadSummary | null = null
  let status: K6ShardResult['status'] = 'errored'

  if (fake) {
    summary = summarizeK6(fakeSummary(flows, bundle.profile), options.thresholds)
    status = summary.passed ? 'passed' : 'failed'
  } else {
    const dir = `${process.env.RUNNER_TEMP || '/tmp'}/charlie-k6-${bundle.runId}-${shardIndex}`
    try {
      mkdirSync(dir, { recursive: true })
      const injected: InjectedScenario = {
        options,
        scenarios,
        baseUrl: bundle.environment.baseUrl,
        summaryPath: SUMMARY_FILE,
      }
      const built = await build({
        entryPoints: [new URL('./k6/entrypoint.ts', import.meta.url).pathname],
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'neutral',
        target: 'es2017',
        external: ['k6', 'k6/*'],
        plugins: [scenarioPlugin(injected)],
        logLevel: 'silent',
      })
      const code = built.outputFiles?.[0]?.text
      if (!code) throw new Error('esbuild produced no output')
      writeFileSync(`${dir}/script.js`, code)

      const proc = Bun.spawnSync(['k6', 'run', '--quiet', 'script.js'], {
        cwd: dir,
        env: process.env,
      })
      // k6 exits 99 when a threshold breaks; the summary is written regardless.
      const summaryPath = `${dir}/${SUMMARY_FILE}`
      if (!existsSync(summaryPath)) {
        const stderr = new TextDecoder().decode(proc.stderr).slice(0, 500)
        throw new Error(`k6 wrote no summary (exit=${proc.exitCode}). ${stderr}`)
      }
      summary = summarizeK6(JSON.parse(readFileSync(summaryPath, 'utf8')), options.thresholds)
      status = summary.passed ? 'passed' : 'failed'
    } catch (err) {
      status = 'errored'
      summary = null
      console.error(`[charlie] k6 shard ${shardIndex} errored:`, err)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const flowResults = scenarios.map((s) => ({
    flow: s.name,
    status: (status === 'passed' ? 'passed' : 'failed') as 'passed' | 'failed',
  }))

  await postShardResult(cfg, bundle.runId, {
    shardIndex,
    status,
    runner: 'github-actions',
    flowResults,
    metrics: summary,
    runtimeIssues: scenarios.flatMap((s) => s.notApplicable),
  })

  return { status, summary, scenarios }
}
