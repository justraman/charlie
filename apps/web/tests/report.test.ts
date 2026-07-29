import { describe, expect, test } from 'bun:test'
import {
  buildReportIndexHtml,
  findHtmlReportKeys,
  reportIndexKey,
  runRelativePath,
} from '../worker/lib/report'

describe('findHtmlReportKeys', () => {
  test('collects monocart entrypoints across shards, ignoring other artifacts', () => {
    const rows = [
      JSON.stringify([
        'runs/r1/0/checkout/monocart/report.html',
        'runs/r1/0/checkout/monocart/data.js',
        'runs/r1/0/checkout/trace-0.zip',
        'runs/r1/0/checkout/log.txt',
      ]),
      JSON.stringify(['runs/r1/1/signup/monocart/report.html']),
    ]
    expect(findHtmlReportKeys(rows)).toEqual([
      'runs/r1/0/checkout/monocart/report.html',
      'runs/r1/1/signup/monocart/report.html',
    ])
  })

  test('tolerates null and malformed rows', () => {
    expect(findHtmlReportKeys([null, 'not json', JSON.stringify({ nope: 1 })])).toEqual([])
  })
})

describe('runRelativePath', () => {
  test('strips the run prefix', () => {
    expect(runRelativePath('r1', 'runs/r1/0/checkout/monocart/report.html')).toBe(
      '0/checkout/monocart/report.html',
    )
  })
  test('rejects keys outside the run', () => {
    expect(runRelativePath('r1', 'runs/r2/0/x/monocart/report.html')).toBeNull()
  })
})

describe('buildReportIndexHtml', () => {
  test('links each report through /api/runs/:id/report/*', () => {
    const html = buildReportIndexHtml('r1', [
      'runs/r1/0/checkout/monocart/report.html',
      'runs/r1/1/signup/monocart/report.html',
    ])
    expect(html).toContain('href="/api/runs/r1/report/0/checkout/monocart/report.html"')
    expect(html).toContain('checkout (shard 0)')
    expect(html).toContain('signup (shard 1)')
  })
  test('escapes markup in run ids', () => {
    const html = buildReportIndexHtml('<r1>', [])
    expect(html).not.toContain('<r1>')
    expect(html).toContain('&lt;r1&gt;')
  })
})

describe('reportIndexKey', () => {
  test('lives under the run prefix so the serving route can reach it', () => {
    expect(runRelativePath('r1', reportIndexKey('r1'))).toBe('report/index.html')
  })
})
