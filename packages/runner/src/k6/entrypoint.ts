// The k6 script. It is NOT run under Bun/Node — esbuild bundles it (with the
// `k6*` imports left external) into plain JS that the k6 runtime executes. The
// compiled scenarios, resolved options, and base URL are supplied by the
// `virtual:charlie-scenario` module esbuild injects at bundle time.
//
// `{{secrets.*}}` placeholders are already resolved by the runner before the
// bundle is built; this script resolves `{{vars.*}}` per iteration from values
// captured by `extract` steps.

import {
  baseUrl,
  options as injectedOptions,
  scenarios,
  summaryPath,
} from 'virtual:charlie-scenario'
import { check, group, sleep } from 'k6'
import http from 'k6/http'

// k6 reads `options` at init to size VUs, stages, and thresholds.
export const options = injectedOptions

const VAR_RE = /\{\{\s*vars\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

function resolveVars(text: string, vars: Record<string, string>): string {
  return text.replace(VAR_RE, (_whole, name: string) => vars[name] ?? '')
}

function absolute(url: string): string {
  if (/^https?:\/\//i.test(url)) return url
  const base = baseUrl.replace(/\/$/, '')
  return url.startsWith('/') ? base + url : `${base}/${url}`
}

function mapValues(obj: Record<string, string>, fn: (v: string) => string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of Object.keys(obj)) out[k] = fn(obj[k]!)
  return out
}

// One VU iteration = run every selected flow's request sequence once.
export default function run(): void {
  for (const scenario of scenarios) {
    group(scenario.name, () => {
      const vars: Record<string, string> = {}
      for (const req of scenario.requests) {
        const url = absolute(resolveVars(req.url, vars))
        const headers = mapValues(req.headers, (v) => resolveVars(v, vars))
        const label = req.label ?? `${req.method} ${req.url}`

        const res =
          req.method === 'POST'
            ? http.post(
                url,
                mapValues(req.formBody ?? {}, (v) => resolveVars(v, vars)),
                {
                  headers,
                },
              )
            : http.get(url, { headers })

        // Status check: any non-error response counts as reachable.
        check(res, { [`${label}: status < 400`]: (r) => r.status > 0 && r.status < 400 })
        // Body-`contains` checks (from `assert` text steps).
        for (const bc of req.bodyChecks) {
          check(res, {
            [`${label}: body contains ${bc.contains}`]: (r) =>
              String(r.body ?? '').indexOf(bc.contains) !== -1,
          })
        }
        // Regex captures → vars for subsequent requests.
        for (const cap of req.captures) {
          const m = new RegExp(cap.regex).exec(String(res.body ?? ''))
          vars[cap.as] = m ? (m[1] ?? m[0] ?? '') : ''
        }
        if (req.thinkTimeMs && req.thinkTimeMs > 0) sleep(req.thinkTimeMs / 1000)
      }
    })
  }
}

// k6 hands the end-of-test summary here; we write it where the runner reads it.
export function handleSummary(data: unknown): Record<string, string> {
  return { [summaryPath]: JSON.stringify(data) }
}
