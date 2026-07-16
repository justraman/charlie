import { describe, expect, test } from 'bun:test'
import {
  findPlaceholders,
  PlaceholderError,
  resolvePlaceholders,
  resolveStepPlaceholders,
} from '../src/placeholders'

describe('findPlaceholders', () => {
  test('finds secrets and vars refs in order', () => {
    const refs = findPlaceholders('{{secrets.TOKEN}}/{{vars.id}} and {{ secrets.OTHER }}')
    expect(refs).toEqual([
      { kind: 'secrets', name: 'TOKEN' },
      { kind: 'vars', name: 'id' },
      { kind: 'secrets', name: 'OTHER' },
    ])
  })
})

describe('resolvePlaceholders', () => {
  const sources = { secrets: { TOKEN: 'abc' }, vars: { id: '42' } }

  test('substitutes known values', () => {
    expect(resolvePlaceholders('Bearer {{secrets.TOKEN}} #{{vars.id}}', sources)).toBe(
      'Bearer abc #42',
    )
  })

  test('throws on a missing key by default', () => {
    expect(() => resolvePlaceholders('{{secrets.NOPE}}', sources)).toThrow(PlaceholderError)
  })

  test('empty mode substitutes empty string', () => {
    expect(resolvePlaceholders('x{{vars.missing}}y', sources, 'empty')).toBe('xy')
  })

  test('keep mode leaves the token', () => {
    expect(resolvePlaceholders('{{vars.missing}}', sources, 'keep')).toBe('{{vars.missing}}')
  })
})

describe('resolveStepPlaceholders', () => {
  test('resolves url/value/name/text fields only', () => {
    const step = resolveStepPlaceholders(
      { action: 'fill', selector: '#email', value: '{{secrets.EMAIL}}' },
      { secrets: { EMAIL: 'qa@example.com' } },
    )
    expect(step).toEqual({ action: 'fill', selector: '#email', value: 'qa@example.com' })
  })
})
