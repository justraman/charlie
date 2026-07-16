import { describe, expect, test } from 'bun:test'
import { summarizeFlowDiff } from '../src/diff'
import type { FlowBody } from '../src/schema'

const base: FlowBody = {
  steps: [
    { action: 'goto', url: '/' },
    { action: 'click', selector: '#a' },
  ],
}

describe('summarizeFlowDiff', () => {
  test('null prev → initial version', () => {
    expect(summarizeFlowDiff(null, base)).toBe('Initial version.')
  })

  test('identical → no changes', () => {
    expect(summarizeFlowDiff(base, structuredClone(base))).toBe('No changes.')
  })

  test('added step', () => {
    const next: FlowBody = { steps: [...base.steps, { action: 'submit', selector: 'form' }] }
    expect(summarizeFlowDiff(base, next)).toContain('Added 1 step')
  })

  test('modified step is described', () => {
    const next: FlowBody = {
      steps: [
        { action: 'goto', url: '/home' },
        { action: 'click', selector: '#a' },
      ],
    }
    const summary = summarizeFlowDiff(base, next)
    expect(summary).toContain('Modified 1 step')
    expect(summary).toContain('goto')
  })

  test('load profile change is noted', () => {
    const next: FlowBody = { steps: base.steps, loadProfile: { profile: 'smoke' } }
    expect(summarizeFlowDiff(base, next)).toContain('Changed load profile')
  })
})
