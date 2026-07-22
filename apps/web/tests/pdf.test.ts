import { describe, expect, test } from 'bun:test'
import { buildK6ReportPdf, type K6PdfInput } from '../worker/lib/pdf'

const baseInput: K6PdfInput = {
  runId: '0190aa00-0000-7000-8000-000000000000',
  project: 'checkout',
  environment: 'staging',
  profile: 'load',
  status: 'passed',
  createdAt: '2026-07-23T12:00:00.000Z',
  summary: {
    p50: 120,
    p95: 190,
    p99: 240,
    rps: 42.5,
    errorRate: 0.004,
    requests: 5100,
    checksPassed: 5090,
    checksTotal: 5100,
    thresholds: [
      { metric: 'http_req_duration', expression: 'p(95)<800', ok: true },
      { metric: 'http_req_failed', expression: 'rate<0.01', ok: true },
    ],
  },
}

describe('buildK6ReportPdf', () => {
  test('emits a well-formed PDF with header, xref and EOF', () => {
    const bytes = buildK6ReportPdf(baseInput)
    const s = new TextDecoder().decode(bytes)
    expect(s.startsWith('%PDF-1.4')).toBe(true)
    expect(s).toContain('/Type /Catalog')
    expect(s).toContain('/BaseFont /Helvetica')
    expect(s).toContain('xref')
    expect(s).toContain('trailer')
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true)
    expect(bytes.byteLength).toBeGreaterThan(500)
  })

  test('xref offsets point at the right object headers', () => {
    const s = new TextDecoder().decode(buildK6ReportPdf(baseInput))
    // Parse the startxref offset and confirm the xref keyword lives there.
    const m = s.match(/startxref\n(\d+)\n%%EOF$/)
    expect(m).not.toBeNull()
    const xrefOffset = Number(m![1])
    expect(s.slice(xrefOffset, xrefOffset + 4)).toBe('xref')

    // Each "n" entry offset should land on "<n> 0 obj".
    const entryRe = /^(\d{10}) 00000 n $/gm
    let idx = 0
    let mm: RegExpExecArray | null
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
    while ((mm = entryRe.exec(s)) !== null) {
      idx++
      const off = Number(mm[1])
      expect(s.slice(off).startsWith(`${idx} 0 obj`)).toBe(true)
    }
    expect(idx).toBeGreaterThan(4)
  })

  test('renders comparison and escapes parentheses in text without throwing', () => {
    const bytes = buildK6ReportPdf({
      ...baseInput,
      project: 'checkout (v2)',
      comparison: {
        baselineRunId: 'prev',
        baselineAt: '2026-07-22T12:00:00.000Z',
        p50: { current: 120, previous: 150, deltaPct: -20, better: true },
        p95: { current: 190, previous: 170, deltaPct: 11.8, better: false },
        p99: { current: 240, previous: 240, deltaPct: 0, better: null },
        rps: { current: 42.5, previous: 40, deltaPct: 6.25, better: true },
        errorRate: { current: 0.004, previous: 0.002, deltaPct: 100, better: false },
      },
    })
    const s = new TextDecoder().decode(bytes)
    expect(s).toContain('checkout \\(v2\\)')
    expect(bytes.byteLength).toBeGreaterThan(500)
  })
})
