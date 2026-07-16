// Flow → k6 HTTP scenario compiler and load-profile presets. Pure and engine-
// free so it can be unit-tested with plain `tsc`/`bun test`; the runner's k6
// entrypoint (which imports the k6 runtime modules) consumes the compiled
// output. See docs/TEST_ENGINES.md for the action→HTTP mapping.
//
// Compilation intent (from the action table):
//   goto        → HTTP request (GET), follow redirects
//   fill        → contributes a field to the next form POST body
//   submit      → HTTP POST of the collected fields to the current URL
//   extract     → capture a token from the *response* (regex only in HTTP mode)
//   waitFor(ms) → think-time sleep after the current request
//   setHeader   → header applied to subsequent requests
//   click       → no HTTP analogue (navigation edges are inferred) → skipped
//   assert text → response-body `contains` check on the current request
//   assert dom  → no HTTP analogue → skipped
//
// Placeholders are NOT resolved here. `{{secrets.*}}` are resolved by the runner
// (which holds the decrypted bundle) before k6 runs; `{{vars.*}}` are resolved
// per-iteration in the k6 runtime from values captured by `extract`.

import type { FlowStep, LoadProfile } from './schema'

export type K6Method = 'GET' | 'POST'

/** A regex capture applied to a request's response body, bound to `{{vars.as}}`. */
export interface K6Capture {
  as: string
  regex: string
}

/** A response-body `contains` check derived from an `assert` text step. */
export interface K6BodyCheck {
  contains: string
}

export interface K6Request {
  method: K6Method
  /** Relative to the environment base_url (resolved in the k6 runtime) or absolute. */
  url: string
  headers: Record<string, string>
  /** Present for POSTs built from preceding `fill` steps. */
  formBody?: Record<string, string>
  /** Body-`contains` checks (from `assert` text steps) run against the response. */
  bodyChecks: K6BodyCheck[]
  /** Regex captures pulled from the response into vars for later requests. */
  captures: K6Capture[]
  /** Think-time (ms) to sleep after this request, from a following `waitFor(ms)`. */
  thinkTimeMs?: number
  label?: string
}

/** A step with no HTTP analogue, surfaced in the report as "not applicable". */
export interface NotApplicableStep {
  index: number
  action: string
  reason: string
}

export interface K6Scenario {
  name: string
  requests: K6Request[]
  /** Steps skipped in load mode (clicks, DOM asserts, selector-only extracts). */
  notApplicable: NotApplicableStep[]
}

/**
 * Derive a form field name from a CSS selector, best-effort. Prefers an explicit
 * `[name="x"]`, then an id (`#x`), then a bare word; falls back to a sanitized
 * form of the whole selector. Documented as heuristic — authors targeting load
 * accuracy should use `input[name=...]` selectors.
 */
export function fieldNameFromSelector(selector: string): string {
  const byName = selector.match(/\[name\s*=\s*["']?([^"'\]]+)["']?\]/)
  if (byName?.[1]) return byName[1]
  const byId = selector.match(/#([A-Za-z0-9_-]+)/)
  if (byId?.[1]) return byId[1]
  const bareId = selector.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*$/)
  if (bareId?.[1]) return bareId[1]
  return selector.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'field'
}

/**
 * Compile a flow's steps into an HTTP scenario. `flowName` labels the scenario
 * (and shows in the report). The scenario keeps placeholders intact.
 */
export function compileK6Scenario(steps: FlowStep[], flowName: string): K6Scenario {
  const requests: K6Request[] = []
  const notApplicable: NotApplicableStep[] = []
  // Fields accumulated by `fill` since the last request, consumed by `submit`.
  let pendingFields: Record<string, string> = {}
  // Headers accumulated by `setHeader`, applied to every subsequent request.
  const headers: Record<string, string> = {}
  // The URL of the most recent navigation — the POST target for `submit`.
  let currentUrl: string | undefined

  const last = (): K6Request | undefined => requests[requests.length - 1]

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]!
    switch (step.action) {
      case 'goto': {
        currentUrl = step.url
        requests.push({
          method: 'GET',
          url: step.url,
          headers: { ...headers },
          bodyChecks: [],
          captures: [],
          label: step.label,
        })
        break
      }
      case 'submit': {
        // POST the collected fields to the current page URL (best-effort: the
        // form's action is unknown without a DOM).
        requests.push({
          method: 'POST',
          url: currentUrl ?? '/',
          headers: { ...headers },
          formBody: { ...pendingFields },
          bodyChecks: [],
          captures: [],
          label: step.label,
        })
        pendingFields = {}
        break
      }
      case 'fill': {
        pendingFields[fieldNameFromSelector(step.selector)] = step.value
        break
      }
      case 'setHeader': {
        headers[step.name] = step.value
        break
      }
      case 'waitFor': {
        if (typeof step.ms === 'number') {
          const l = last()
          if (l) l.thinkTimeMs = (l.thinkTimeMs ?? 0) + step.ms
          // A selector wait has no HTTP meaning; a pure ms wait with no prior
          // request is dropped (nothing to sleep after yet).
        } else {
          notApplicable.push({
            index,
            action: 'waitFor',
            reason: 'selector wait has no HTTP analogue',
          })
        }
        break
      }
      case 'extract': {
        if (step.regex) {
          const l = last()
          if (l) l.captures.push({ as: step.as, regex: step.regex })
          else
            notApplicable.push({
              index,
              action: 'extract',
              reason: 'no preceding request to capture from',
            })
        } else {
          notApplicable.push({
            index,
            action: 'extract',
            reason: 'selector-only extract has no HTTP analogue (use `regex`)',
          })
        }
        break
      }
      case 'assert': {
        if (step.text !== undefined) {
          const l = last()
          if (l) l.bodyChecks.push({ contains: step.text })
          else
            notApplicable.push({
              index,
              action: 'assert',
              reason: 'no preceding request to assert against',
            })
        } else {
          notApplicable.push({
            index,
            action: 'assert',
            reason: 'DOM state assertion has no HTTP analogue',
          })
        }
        break
      }
      case 'click': {
        notApplicable.push({
          index,
          action: 'click',
          reason: 'clicks have no HTTP analogue (navigation edges are inferred)',
        })
        break
      }
    }
  }

  return { name: flowName, requests, notApplicable }
}

// --- Load profiles ----------------------------------------------------------

export interface ResolvedLoadProfile {
  profile: LoadProfile['profile']
  stages: { duration: string; target: number }[]
  thresholds: Record<string, string[]>
}

// Sensible defaults; a flow's loadProfile overrides stages and/or thresholds.
const DEFAULT_THRESHOLDS: Record<string, string[]> = {
  http_req_failed: ['rate<0.01'],
  http_req_duration: ['p(95)<800'],
}

const PROFILE_PRESETS: Record<LoadProfile['profile'], ResolvedLoadProfile> = {
  // Does it work at all: a handful of VUs, briefly.
  smoke: {
    profile: 'smoke',
    stages: [{ duration: '30s', target: 5 }],
    thresholds: DEFAULT_THRESHOLDS,
  },
  // Expected peak: ramp to target, hold, ramp down.
  load: {
    profile: 'load',
    stages: [
      { duration: '30s', target: 50 },
      { duration: '2m', target: 50 },
      { duration: '30s', target: 0 },
    ],
    thresholds: DEFAULT_THRESHOLDS,
  },
  // Find the breaking point: ramp beyond the expected target.
  stress: {
    profile: 'stress',
    stages: [
      { duration: '1m', target: 100 },
      { duration: '2m', target: 200 },
      { duration: '2m', target: 300 },
      { duration: '1m', target: 0 },
    ],
    thresholds: DEFAULT_THRESHOLDS,
  },
}

/**
 * Resolve the effective stages + thresholds for a run. Starts from the named
 * profile preset and lets the flow's `loadProfile` override either dimension.
 */
export function resolveLoadProfile(
  profile: LoadProfile['profile'],
  override?: LoadProfile | null,
): ResolvedLoadProfile {
  const preset = PROFILE_PRESETS[profile] ?? PROFILE_PRESETS.smoke
  return {
    profile,
    stages: override?.stages && override.stages.length > 0 ? override.stages : preset.stages,
    thresholds:
      override?.thresholds && Object.keys(override.thresholds).length > 0
        ? override.thresholds
        : preset.thresholds,
  }
}

// --- Summary parsing --------------------------------------------------------

/** The headline load metrics denormalized into `reports.load_summary`. */
export interface LoadSummary {
  /** http_req_duration percentiles, ms. */
  p50: number | null
  p95: number | null
  p99: number | null
  /** Requests per second (http_reqs rate). */
  rps: number | null
  /** Failed-request rate 0..1 (http_req_failed). */
  errorRate: number | null
  /** Total requests issued. */
  requests: number | null
  /** Passed / total non-threshold checks. */
  checksPassed: number | null
  checksTotal: number | null
  /** Per-threshold pass/fail, naming the offending metric. */
  thresholds: { metric: string; expression: string; ok: boolean }[]
  /** Overall: true iff every threshold held. */
  passed: boolean
}

// Minimal shape of the k6 end-of-test summary we read (from handleSummary(data)).
interface K6MetricValues {
  values?: Record<string, number>
  thresholds?: Record<string, { ok?: boolean; fails?: number }>
}
interface K6SummaryData {
  metrics?: Record<string, K6MetricValues>
  root_group?: unknown
}

function pct(m: K6MetricValues | undefined, key: string): number | null {
  const v = m?.values?.[key]
  return typeof v === 'number' ? v : null
}

/**
 * Turn a k6 summary object (the argument k6 hands to `handleSummary`) into a
 * LoadSummary. `expectedThresholds` is the resolved threshold map so we can
 * report an entry per expression even if k6's summary omits an un-breached one.
 */
export function summarizeK6(
  raw: unknown,
  expectedThresholds: Record<string, string[]>,
): LoadSummary {
  const data = (raw ?? {}) as K6SummaryData
  const metrics = data.metrics ?? {}
  const dur = metrics.http_req_duration
  const reqs = metrics.http_reqs
  const failed = metrics.http_req_failed
  const checks = metrics.checks

  const thresholds: LoadSummary['thresholds'] = []
  for (const [metric, expressions] of Object.entries(expectedThresholds)) {
    const reported = metrics[metric]?.thresholds ?? {}
    for (const expression of expressions) {
      // k6 keys threshold results by the full expression string.
      const entry = reported[expression]
      const ok = entry ? entry.ok !== false && (entry.fails ?? 0) === 0 : true
      thresholds.push({ metric, expression, ok })
    }
  }

  const checksTotal =
    (checks?.values?.passes ?? 0) + (checks?.values?.fails ?? 0) || (checks?.values?.passes ?? null)

  return {
    p50: pct(dur, 'p(50)') ?? pct(dur, 'med'),
    p95: pct(dur, 'p(95)'),
    p99: pct(dur, 'p(99)'),
    rps: reqs?.values?.rate ?? null,
    errorRate: failed?.values?.rate ?? null,
    requests: reqs?.values?.count ?? null,
    checksPassed: checks?.values?.passes ?? null,
    checksTotal: typeof checksTotal === 'number' ? checksTotal : null,
    thresholds,
    passed: thresholds.every((t) => t.ok),
  }
}
