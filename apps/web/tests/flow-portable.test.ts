// Import/export planning against a project's existing flows. The DB read
// (`loadProjectFlows`) is the only part not covered here; everything the
// endpoints decide — conflicts, reference resolution, cycles, versioning — is
// pure and exercised directly.

import { describe, expect, test } from 'bun:test'
import { FLOW_DOCUMENT_FORMAT, type FlowDocument, parseFlowDocument } from '@charlie/flow-core'
import {
  buildFlowDocument,
  documentFilename,
  type ImportMode,
  planFlowImport,
  type ProjectFlow,
  withDependencies,
} from '../worker/lib/flow-portable'
import { HttpError } from '../worker/lib/http'

function projectFlow(over: Partial<ProjectFlow> & { id: string; name: string }): ProjectFlow {
  return {
    description: null,
    kind: 'steps',
    engines: ['playwright'],
    steps: [{ action: 'goto', url: '/' }],
    loadProfile: null,
    code: null,
    currentVersionId: `v-${over.id}`,
    currentVersion: 1,
    ...over,
  }
}

function doc(...flows: unknown[]): FlowDocument {
  const r = parseFlowDocument({ format: FLOW_DOCUMENT_FORMAT, flows })
  if (!r.success) throw new Error(JSON.stringify(r.error.issues, null, 2))
  return r.data
}

function plan(d: FlowDocument, existing: ProjectFlow[] = [], mode: ImportMode = 'create') {
  let n = 0
  return planFlowImport({ doc: d, existing, mode, newId: () => `new-${++n}` })
}

const loginDoc = {
  name: 'login',
  steps: [
    { action: 'goto', url: '/login' },
    { action: 'fill', selector: '#email', value: '{{secrets.TEST_EMAIL}}' },
  ],
}

describe('export', () => {
  const login = projectFlow({ id: 'f-login', name: 'login' })
  const checkout = projectFlow({
    id: 'f-checkout',
    name: 'checkout',
    steps: [
      { action: 'useFlow', flowId: 'f-login' },
      { action: 'goto', url: '/cart' },
    ],
  })
  const all = [checkout, login]

  test('rewrites useFlow ids to names', () => {
    const d = buildFlowDocument([checkout], all, { project: 'storefront' })
    expect(d.format).toBe(FLOW_DOCUMENT_FORMAT)
    expect(d.project).toBe('storefront')
    expect(d.flows[0]).toMatchObject({
      name: 'checkout',
      steps: [{ action: 'useFlow', flow: 'login' }, { action: 'goto', url: '/cart' }],
    })
  })

  test('exports a code flow as its code spec', () => {
    const suite = projectFlow({
      id: 'f-suite',
      name: 'suite',
      kind: 'code',
      steps: [],
      code: { repo: 'acme/e2e', grep: '@smoke' },
    })
    const d = buildFlowDocument([suite], [suite])
    expect(d.flows[0]).toEqual({
      name: 'suite',
      kind: 'code',
      engines: ['playwright'],
      code: { repo: 'acme/e2e', grep: '@smoke' },
    })
  })

  test('a dangling reference is a 400, not a broken file', () => {
    expect(() => buildFlowDocument([checkout], [checkout])).toThrow(HttpError)
  })

  test('withDependencies pulls in transitively referenced flows', () => {
    expect(withDependencies([checkout], all).map((f) => f.name)).toEqual(['checkout', 'login'])
    expect(withDependencies([login], all).map((f) => f.name)).toEqual(['login'])
  })

  test('an export round-trips back into an import plan', () => {
    const exported = buildFlowDocument(all, all)
    const reparsed = parseFlowDocument(JSON.parse(JSON.stringify(exported)))
    expect(reparsed.success).toBe(true)
    if (!reparsed.success) return
    const p = plan(reparsed.data)
    expect(p.created).toBe(2)
    const imported = p.flows.find((f) => f.name === 'checkout')!
    const loginId = p.flows.find((f) => f.name === 'login')!.flowId
    expect(imported.steps[0]).toEqual({ action: 'useFlow', flowId: loginId })
  })

  test('documentFilename slugifies', () => {
    expect(documentFilename('Guest Checkout!')).toBe('guest-checkout.charlie-flows.json')
    expect(documentFilename('***')).toBe('flows.charlie-flows.json')
  })
})

describe('planFlowImport — creating', () => {
  test('plans a v1 create for each new flow', () => {
    const p = plan(doc(loginDoc, { name: 'search', steps: [{ action: 'goto', url: '/s' }] }))
    expect(p.created).toBe(2)
    expect(p.updated).toBe(0)
    expect(p.flows.map((f) => [f.name, f.action, f.version])).toEqual([
      ['login', 'create', 1],
      ['search', 'create', 1],
    ])
  })

  test('reports the secrets the document expects', () => {
    expect(plan(doc(loginDoc)).secrets).toEqual(['TEST_EMAIL'])
  })

  test('resolves a useFlow reference to a flow created in the same import', () => {
    const p = plan(doc({ name: 'checkout', steps: [{ action: 'useFlow', flow: 'login' }] }, loginDoc))
    const loginId = p.flows.find((f) => f.name === 'login')!.flowId
    const checkout = p.flows.find((f) => f.name === 'checkout')!
    expect(checkout.steps).toEqual([{ action: 'useFlow', flowId: loginId }])
    // Dependencies are planned first.
    expect(p.flows.map((f) => f.name)).toEqual(['login', 'checkout'])
  })

  test('resolves a useFlow reference to a flow already in the project', () => {
    const existing = [projectFlow({ id: 'f-login', name: 'login' })]
    const p = plan(doc({ name: 'checkout', steps: [{ action: 'useFlow', flow: 'login' }] }), existing)
    expect(p.flows[0]?.steps).toEqual([{ action: 'useFlow', flowId: 'f-login' }])
  })

  test('rejects an unresolvable useFlow reference', () => {
    expect(() =>
      plan(doc({ name: 'checkout', steps: [{ action: 'useFlow', flow: 'nope' }] })),
    ).toThrow(/no such flow is in this document or in the project/)
  })

  test('rejects a useFlow reference to an existing code flow', () => {
    const existing = [
      projectFlow({ id: 'f-s', name: 'suite', kind: 'code', steps: [], code: { repo: 'a/b' } }),
    ]
    expect(() =>
      plan(doc({ name: 'checkout', steps: [{ action: 'useFlow', flow: 'suite' }] }), existing),
    ).toThrow(/code flow/)
  })

  test('a name clash is a 409 listing every clashing name', () => {
    const existing = [projectFlow({ id: 'f-login', name: 'login' })]
    try {
      plan(doc(loginDoc), existing)
      throw new Error('expected a conflict')
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError)
      expect((err as HttpError).code).toBe('conflict')
      expect((err as HttpError).details).toEqual({ conflicts: ['login'] })
    }
  })
})

describe('planFlowImport — upserting', () => {
  const existing = [
    projectFlow({
      id: 'f-login',
      name: 'login',
      currentVersion: 3,
      description: 'the old description',
    }),
  ]

  test('an existing name becomes the next version of that flow', () => {
    const p = plan(doc(loginDoc), existing, 'upsert')
    expect(p.created).toBe(0)
    expect(p.updated).toBe(1)
    expect(p.flows[0]).toMatchObject({ flowId: 'f-login', action: 'version', version: 4 })
    expect(p.flows[0]?.previousSteps).toEqual(existing[0]!.steps)
  })

  test('keeps the existing description when the document omits one', () => {
    expect(plan(doc(loginDoc), existing, 'upsert').flows[0]?.description).toBe(
      'the old description',
    )
    const withDesc = plan(doc({ ...loginDoc, description: 'new' }), existing, 'upsert')
    expect(withDesc.flows[0]?.description).toBe('new')
  })

  test('changing a flow between steps and code is a 409', () => {
    expect(() =>
      plan(doc({ kind: 'code', name: 'login', code: { repo: 'a/b' } }), existing, 'upsert'),
    ).toThrow(/fixed at creation/)
  })

  test('mixes creates and versions in one document', () => {
    const p = plan(doc(loginDoc, { name: 'new-one', steps: [{ action: 'goto', url: '/' }] }), existing, 'upsert')
    expect([p.created, p.updated]).toEqual([1, 1])
  })

  test('rejects an upsert that would close a cycle with an existing flow', () => {
    // checkout (existing) → login. Re-versioning login to reference checkout
    // would make the pair mutually recursive.
    const withCheckout = [
      ...existing,
      projectFlow({
        id: 'f-checkout',
        name: 'checkout',
        steps: [{ action: 'useFlow', flowId: 'f-login' }],
      }),
    ]
    expect(() =>
      plan(
        doc({ name: 'login', steps: [{ action: 'useFlow', flow: 'checkout' }] }),
        withCheckout,
        'upsert',
      ),
    ).toThrow(/useFlow cycle/)
  })

  test('allows re-versioning a shared flow that closes no cycle', () => {
    const withCheckout = [
      ...existing,
      projectFlow({
        id: 'f-checkout',
        name: 'checkout',
        steps: [{ action: 'useFlow', flowId: 'f-login' }],
      }),
    ]
    const p = plan(doc({ name: 'login', steps: [{ action: 'goto', url: '/login2' }] }), withCheckout, 'upsert')
    expect(p.updated).toBe(1)
  })
})
