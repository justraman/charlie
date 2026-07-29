import { describe, expect, test } from 'bun:test'
import {
  documentSecretRefs,
  FLOW_DOCUMENT_FORMAT,
  type FlowDocument,
  FlowReferenceError,
  fromPortableSteps,
  MAX_FLOWS_PER_DOCUMENT,
  normalizeFlowDocumentInput,
  orderFlowsForImport,
  parseFlowDocument,
  toPortableSteps,
  validateFlowDocument,
} from '../src/portable'
import type { FlowStep } from '../src/schema'

const login = {
  name: 'login',
  engines: ['playwright'],
  steps: [
    { action: 'goto', url: '/login' },
    { action: 'fill', selector: '#email', value: '{{secrets.TEST_EMAIL}}' },
    { action: 'fill', selector: '#password', value: '{{secrets.TEST_PASSWORD}}' },
    { action: 'submit', selector: 'form' },
  ],
}

function doc(...flows: unknown[]): FlowDocument {
  const r = parseFlowDocument({ format: FLOW_DOCUMENT_FORMAT, flows })
  if (!r.success) throw new Error(JSON.stringify(r.error.issues, null, 2))
  return r.data
}

describe('parseFlowDocument', () => {
  test('accepts a full document', () => {
    const r = parseFlowDocument({
      format: FLOW_DOCUMENT_FORMAT,
      exportedAt: '2026-07-30T00:00:00.000Z',
      project: 'storefront',
      notes: 'exported for review',
      flows: [login],
    })
    expect(r.success).toBe(true)
  })

  test('defaults kind and engines on a minimal flow', () => {
    const r = parseFlowDocument({ name: 'x', steps: [{ action: 'goto', url: '/' }] })
    expect(r.success).toBe(true)
    if (!r.success) return
    expect(r.data.flows[0]).toMatchObject({ kind: 'steps', engines: ['playwright'] })
  })

  test('rejects an unknown top-level key', () => {
    const r = parseFlowDocument({ format: FLOW_DOCUMENT_FORMAT, flows: [login], extra: 1 })
    expect(r.success).toBe(false)
  })

  test('rejects a wrong format tag', () => {
    const r = parseFlowDocument({ format: 'charlie.flows/v99', flows: [login] })
    expect(r.success).toBe(false)
  })

  test('rejects an unknown step field, pointing at the step', () => {
    const r = parseFlowDocument({
      format: FLOW_DOCUMENT_FORMAT,
      flows: [{ name: 'x', steps: [{ action: 'goto', url: '/', selector: '#nope' }] }],
    })
    expect(r.success).toBe(false)
    if (r.success) return
    expect(r.error.issues[0]?.path.join('.')).toContain('flows.0.steps.0')
  })

  test('rejects a useFlow step that uses a raw id instead of a name', () => {
    const r = parseFlowDocument({
      format: FLOW_DOCUMENT_FORMAT,
      flows: [{ name: 'x', steps: [{ action: 'useFlow', flowId: 'abc' }] }],
    })
    expect(r.success).toBe(false)
  })

  test('rejects an empty flow list and an empty step list', () => {
    expect(parseFlowDocument({ format: FLOW_DOCUMENT_FORMAT, flows: [] }).success).toBe(false)
    expect(parseFlowDocument({ name: 'x', steps: [] }).success).toBe(false)
  })

  test('rejects more flows than the document limit', () => {
    const many = Array.from({ length: MAX_FLOWS_PER_DOCUMENT + 1 }, (_, i) => ({
      ...login,
      name: `f${i}`,
    }))
    expect(parseFlowDocument({ format: FLOW_DOCUMENT_FORMAT, flows: many }).success).toBe(false)
  })

  test('accepts a code flow', () => {
    const r = parseFlowDocument({
      format: FLOW_DOCUMENT_FORMAT,
      flows: [{ kind: 'code', name: 'suite', code: { repo: 'acme/e2e', grep: '@smoke' } }],
    })
    expect(r.success).toBe(true)
  })

  test('rejects a code flow carrying steps', () => {
    const r = parseFlowDocument({
      format: FLOW_DOCUMENT_FORMAT,
      flows: [
        { kind: 'code', name: 'suite', code: { repo: 'acme/e2e' }, steps: [{ action: 'goto' }] },
      ],
    })
    expect(r.success).toBe(false)
  })
})

describe('normalizeFlowDocumentInput', () => {
  test('wraps a bare array of flows', () => {
    expect(normalizeFlowDocumentInput([login])).toEqual({
      format: FLOW_DOCUMENT_FORMAT,
      flows: [login],
    })
  })

  test('wraps a single bare flow', () => {
    expect(normalizeFlowDocumentInput(login)).toEqual({
      format: FLOW_DOCUMENT_FORMAT,
      flows: [login],
    })
  })

  test('adds a missing format tag to an otherwise complete document', () => {
    expect(normalizeFlowDocumentInput({ flows: [login] })).toEqual({
      flows: [login],
      format: FLOW_DOCUMENT_FORMAT,
    })
  })

  test('leaves an unrecognizable value untouched for Zod to reject', () => {
    expect(normalizeFlowDocumentInput('nope')).toBe('nope')
    expect(parseFlowDocument('nope').success).toBe(false)
    expect(parseFlowDocument(null).success).toBe(false)
  })
})

describe('validateFlowDocument', () => {
  const checkout = {
    name: 'checkout',
    steps: [
      { action: 'useFlow', flow: 'login' },
      { action: 'goto', url: '/cart' },
    ],
  }

  test('a well-formed document has no issues', () => {
    expect(validateFlowDocument(doc(login, checkout))).toEqual([])
  })

  test('allows a reference to a flow outside the document', () => {
    expect(validateFlowDocument(doc(checkout))).toEqual([])
  })

  test('flags duplicate flow names', () => {
    const issues = validateFlowDocument(doc(login, { ...login, description: 'dupe' }))
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toContain('Duplicate flow name "login"')
  })

  test('flags a self-reference', () => {
    const issues = validateFlowDocument(
      doc({ name: 'loop', steps: [{ action: 'useFlow', flow: 'loop' }] }),
    )
    expect(issues[0]?.message).toContain('cannot include itself')
  })

  test('flags a reference to a code flow', () => {
    const issues = validateFlowDocument(
      doc({ kind: 'code', name: 'suite', code: { repo: 'a/b' } }, checkout, {
        name: 'x',
        steps: [{ action: 'useFlow', flow: 'suite' }],
      }),
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toContain('it is a code flow')
  })

  test('flags a mutual cycle once', () => {
    const issues = validateFlowDocument(
      doc(
        { name: 'a', steps: [{ action: 'useFlow', flow: 'b' }] },
        { name: 'b', steps: [{ action: 'useFlow', flow: 'a' }] },
      ),
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toContain('useFlow cycle')
  })

  test('flags a three-flow cycle', () => {
    const issues = validateFlowDocument(
      doc(
        { name: 'a', steps: [{ action: 'useFlow', flow: 'b' }] },
        { name: 'b', steps: [{ action: 'useFlow', flow: 'c' }] },
        { name: 'c', steps: [{ action: 'useFlow', flow: 'a' }] },
      ),
    )
    expect(issues).toHaveLength(1)
  })
})

describe('orderFlowsForImport', () => {
  test('puts referenced flows before the flows that reference them', () => {
    const d = doc({ name: 'checkout', steps: [{ action: 'useFlow', flow: 'login' }] }, login, {
      name: 'account',
      steps: [{ action: 'useFlow', flow: 'checkout' }],
    })
    expect(orderFlowsForImport(d).map((f) => f.name)).toEqual(['login', 'checkout', 'account'])
  })

  test('keeps input order when nothing references anything', () => {
    const d = doc(login, { name: 'z', steps: [{ action: 'goto', url: '/' }] })
    expect(orderFlowsForImport(d).map((f) => f.name)).toEqual(['login', 'z'])
  })

  test('still returns every flow when a cycle is present', () => {
    const d = doc(
      { name: 'a', steps: [{ action: 'useFlow', flow: 'b' }] },
      { name: 'b', steps: [{ action: 'useFlow', flow: 'a' }] },
    )
    expect(orderFlowsForImport(d)).toHaveLength(2)
  })
})

describe('documentSecretRefs', () => {
  test('collects distinct secret placeholders, sorted', () => {
    const d = doc(login, {
      name: 'other',
      steps: [
        { action: 'goto', url: '/u/{{secrets.TEST_EMAIL}}' },
        { action: 'setHeader', name: 'x-key', value: '{{secrets.API_KEY}}' },
        { action: 'fill', selector: '#a', value: '{{vars.csrf}}' },
      ],
    })
    expect(documentSecretRefs(d)).toEqual(['API_KEY', 'TEST_EMAIL', 'TEST_PASSWORD'])
  })
})

describe('step id ↔ name conversion', () => {
  const stored: FlowStep[] = [
    { action: 'goto', url: '/' },
    { action: 'useFlow', flowId: 'id-login', label: 'sign in' },
  ]

  test('round-trips through the portable form', () => {
    const portable = toPortableSteps(stored, new Map([['id-login', 'login']]))
    expect(portable[1]).toEqual({ action: 'useFlow', flow: 'login', label: 'sign in' })
    expect(fromPortableSteps(portable, new Map([['login', 'id-login']]))).toEqual(stored)
  })

  test('export fails when a referenced flow is gone', () => {
    expect(() => toPortableSteps(stored, new Map())).toThrow(FlowReferenceError)
  })

  test('import fails when a referenced name cannot be resolved', () => {
    const portable = toPortableSteps(stored, new Map([['id-login', 'login']]))
    expect(() => fromPortableSteps(portable, new Map())).toThrow(/neither in this document/)
  })
})
