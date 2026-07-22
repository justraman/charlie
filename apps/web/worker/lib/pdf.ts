// A tiny, dependency-free PDF writer — just enough to render a one-page k6 load
// report (a title, run metadata, a metrics table with a baseline comparison, and
// a thresholds table). We deliberately avoid a PDF library so the Worker bundle
// stays lean: PDFs are plain text object graphs and the base-14 fonts (Helvetica
// / Helvetica-Bold) need no embedding, so a few hundred lines cover our needs.
//
// The document is pure ASCII (non-ASCII text is transliterated to '?'), which
// keeps byte offsets — needed for the xref table — trivial to compute.

// --- Low-level document builder --------------------------------------------

const encoder = new TextEncoder()

/** Escape a string for a PDF literal `( … )` and drop non-ASCII. */
function pdfText(s: string): string {
  let out = ''
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`
    else if (code >= 32 && code < 127) out += ch
    else out += '?'
  }
  return out
}

interface PageContent {
  ops: string[]
}

/**
 * Accumulates page-content operators (text + lines) and serializes the whole
 * file with a correct cross-reference table. Coordinates are PDF points with the
 * origin at the bottom-left; callers use the top-left helpers on `PdfPage`.
 */
class PdfDocument {
  private readonly pageWidth = 595 // A4 portrait, points
  private readonly pageHeight = 842
  private readonly pages: PageContent[] = []

  newPage(): PdfPage {
    const content: PageContent = { ops: [] }
    this.pages.push(content)
    return new PdfPage(content, this.pageWidth, this.pageHeight)
  }

  build(): Uint8Array {
    // Object numbering: 1 = Catalog, 2 = Pages, 3 = Helvetica, 4 = Helvetica-Bold,
    // then per page a Page object and its Contents stream.
    const objects: string[] = []
    const pageObjNums: number[] = []
    const firstPageObj = 5
    for (let i = 0; i < this.pages.length; i++) pageObjNums.push(firstPageObj + i * 2)

    objects.push('<< /Type /Catalog /Pages 2 0 R >>')
    objects.push(
      `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${this.pages.length} >>`,
    )
    objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>')

    for (let i = 0; i < this.pages.length; i++) {
      const pageNum = pageObjNums[i]!
      const contentNum = pageNum + 1
      objects.push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.pageWidth} ${this.pageHeight}] ` +
          `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentNum} 0 R >>`,
      )
      const stream = this.pages[i]!.ops.join('\n')
      objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
    }

    // Serialize with a byte-accurate xref table.
    let body = '%PDF-1.4\n'
    const offsets: number[] = []
    objects.forEach((obj, idx) => {
      offsets.push(body.length)
      body += `${idx + 1} 0 obj\n${obj}\nendobj\n`
    })
    const xrefOffset = body.length
    const count = objects.length + 1
    body += `xref\n0 ${count}\n`
    body += '0000000000 65535 f \n'
    for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`
    body += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`

    return encoder.encode(body)
  }
}

/** A drawing surface for one page. Uses a top-left coordinate convention. */
class PdfPage {
  constructor(
    private readonly content: PageContent,
    readonly width: number,
    readonly height: number,
  ) {}

  /** Draw text with its baseline at (x, yTop-from-top). `bold` selects F2. */
  text(x: number, yTop: number, size: number, value: string, bold = false): void {
    const y = this.height - yTop
    this.content.ops.push(
      `BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${pdfText(value)}) Tj ET`,
    )
  }

  /** Draw a horizontal rule from x1..x2 at the given distance from the top. */
  hline(x1: number, x2: number, yTop: number, gray = 0.8): void {
    const y = this.height - yTop
    this.content.ops.push(
      `${gray} G 0.5 w ${x1.toFixed(2)} ${y.toFixed(2)} m ${x2.toFixed(2)} ${y.toFixed(2)} l S 0 G`,
    )
  }
}

// --- k6 report ---------------------------------------------------------------

export interface LoadDeltaMetric {
  current: number | null
  previous: number | null
  /** Signed percentage change from previous → current, or null if incomputable. */
  deltaPct: number | null
  /** True when the change is an improvement (lower latency/errors, higher rps). */
  better: boolean | null
}

export interface LoadComparison {
  baselineRunId: string
  baselineAt: string | null
  p50: LoadDeltaMetric
  p95: LoadDeltaMetric
  p99: LoadDeltaMetric
  rps: LoadDeltaMetric
  errorRate: LoadDeltaMetric
}

export interface K6PdfInput {
  runId: string
  project: string
  environment: string
  profile: string
  status: string // passed | failed
  createdAt: string
  summary: {
    p50: number | null
    p95: number | null
    p99: number | null
    rps: number | null
    errorRate: number | null
    requests: number | null
    checksPassed: number | null
    checksTotal: number | null
    thresholds: { metric: string; expression: string; ok: boolean }[]
  }
  comparison?: LoadComparison | null
}

// PDF text is base-14 Helvetica in ASCII only, so use plain '-' for "no value"
// (a unicode em dash would transliterate to '?').
const fmtMs = (v: number | null) => (v == null ? '-' : `${Math.round(v)} ms`)
const fmtRps = (v: number | null) => (v == null ? '-' : `${v.toFixed(1)}/s`)
const fmtPct = (v: number | null) => (v == null ? '-' : `${(v * 100).toFixed(2)}%`)
const fmtDelta = (d: LoadDeltaMetric | undefined) => {
  if (!d || d.deltaPct == null) return '-'
  const sign = d.deltaPct > 0 ? '+' : ''
  const arrow = d.better == null ? '' : d.better ? '  (better)' : '  (worse)'
  return `${sign}${d.deltaPct.toFixed(1)}%${arrow}`
}

/** Render a k6 load report to a single-page PDF. Returns the raw bytes. */
export function buildK6ReportPdf(input: K6PdfInput): Uint8Array {
  const doc = new PdfDocument()
  const page = doc.newPage()
  const left = 56
  const right = page.width - 56
  let y = 64

  page.text(left, y, 20, 'Charlie k6 Load Report', true)
  y += 26
  page.text(
    left,
    y,
    11,
    `${input.project} / ${input.environment} / k6(${input.profile}) - ${input.status}`,
  )
  y += 16
  page.text(left, y, 9, `Run ${input.runId}`)
  y += 12
  page.text(left, y, 9, input.createdAt)
  y += 18
  page.hline(left, right, y)
  y += 22

  // Metrics table.
  const s = input.summary
  const c = input.comparison
  page.text(left, y, 13, 'Metrics', true)
  y += 20
  const cols = { metric: left, value: 200, baseline: 320, change: 440 }
  page.text(cols.metric, y, 9, 'METRIC', true)
  page.text(cols.value, y, 9, 'CURRENT', true)
  page.text(cols.baseline, y, 9, 'BASELINE', true)
  page.text(cols.change, y, 9, 'CHANGE', true)
  y += 6
  page.hline(left, right, y)
  y += 16

  const rows: [string, string, string, string][] = [
    ['p50 latency', fmtMs(s.p50), fmtMs(c?.p50.previous ?? null), fmtDelta(c?.p50)],
    ['p95 latency', fmtMs(s.p95), fmtMs(c?.p95.previous ?? null), fmtDelta(c?.p95)],
    ['p99 latency', fmtMs(s.p99), fmtMs(c?.p99.previous ?? null), fmtDelta(c?.p99)],
    ['requests/sec', fmtRps(s.rps), fmtRps(c?.rps.previous ?? null), fmtDelta(c?.rps)],
    [
      'error rate',
      fmtPct(s.errorRate),
      fmtPct(c?.errorRate.previous ?? null),
      fmtDelta(c?.errorRate),
    ],
    ['total requests', s.requests == null ? '-' : String(s.requests), '-', '-'],
    [
      'checks passed',
      s.checksTotal == null ? '-' : `${s.checksPassed ?? 0}/${s.checksTotal}`,
      '-',
      '-',
    ],
  ]
  for (const [metric, value, baseline, change] of rows) {
    page.text(cols.metric, y, 10, metric)
    page.text(cols.value, y, 10, value)
    page.text(cols.baseline, y, 10, baseline)
    page.text(cols.change, y, 10, change)
    y += 15
    page.hline(left, right, y - 5, 0.9)
  }

  if (!c) {
    y += 8
    page.text(left, y, 9, 'No previous run with the same settings to compare against.')
  }

  // Thresholds table.
  y += 30
  page.text(left, y, 13, 'Thresholds', true)
  y += 20
  if (s.thresholds.length === 0) {
    page.text(left, y, 10, 'No thresholds configured.')
  } else {
    page.text(left, y, 9, 'RESULT', true)
    page.text(left + 70, y, 9, 'METRIC', true)
    page.text(left + 220, y, 9, 'EXPRESSION', true)
    y += 6
    page.hline(left, right, y)
    y += 16
    for (const t of s.thresholds) {
      page.text(left, y, 10, t.ok ? 'PASS' : 'FAIL')
      page.text(left + 70, y, 10, t.metric)
      page.text(left + 220, y, 10, t.expression)
      y += 15
      page.hline(left, right, y - 5, 0.9)
    }
  }

  return doc.build()
}
