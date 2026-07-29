// Run-level HTML report helpers. The runner uploads each code flow's monocart
// output under runs/{runId}/{shard}/{flow}/monocart/ (entrypoint report.html);
// these helpers locate the entrypoints among a run's artifact keys and, when a
// run produced several reports, render a small index page linking to each.
// Kept free of Hono/DO so they can be unit-tested directly.

export const MONOCART_REPORT_SUFFIX = '/monocart/report.html'

/** R2 key of the generated multi-report index page for a run. */
export function reportIndexKey(runId: string): string {
  return `runs/${runId}/report/index.html`
}

/**
 * Extract monocart report entrypoint keys from the raw
 * `shard_results.artifact_keys` JSON columns of a run's shards.
 */
export function findHtmlReportKeys(artifactKeyRows: (string | null)[]): string[] {
  const keys: string[] = []
  for (const raw of artifactKeyRows) {
    if (!raw) continue
    try {
      const arr = JSON.parse(raw) as unknown
      if (!Array.isArray(arr)) continue
      for (const k of arr) {
        if (typeof k === 'string' && k.endsWith(MONOCART_REPORT_SUFFIX)) keys.push(k)
      }
    } catch {
      /* ignore malformed */
    }
  }
  return keys
}

/** The run-relative path of an artifact key (`runs/{runId}/<path>`), or null. */
export function runRelativePath(runId: string, key: string): string | null {
  const prefix = `runs/${runId}/`
  return key.startsWith(prefix) ? key.slice(prefix.length) : null
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * A minimal index page for runs with more than one monocart report (one per
 * code flow). Links are absolute paths into /api/runs/:id/report/* so the page
 * works from wherever it is served on the app origin.
 */
export function buildReportIndexHtml(runId: string, keys: string[]): string {
  const items = keys
    .map((key) => {
      const rel = runRelativePath(runId, key)
      if (!rel) return null
      // runs/{id}/{shard}/{flow}/monocart/report.html → label "flow (shard N)"
      const parts = rel.split('/')
      const label = parts.length >= 3 ? `${parts[1]} (shard ${parts[0]})` : rel
      const href = `/api/runs/${runId}/report/${rel}`
      return `      <li><a href="${escapeHtml(href)}">${escapeHtml(label)}</a></li>`
    })
    .filter(Boolean)
    .join('\n')
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Charlie run reports — ${escapeHtml(runId)}</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 640px; margin: 3rem auto; padding: 0 1rem; }
      li { margin: 0.5rem 0; }
    </style>
  </head>
  <body>
    <h1>Run reports</h1>
    <p>Run <code>${escapeHtml(runId)}</code> produced ${keys.length} Playwright reports:</p>
    <ul>
${items}
    </ul>
  </body>
</html>
`
}
