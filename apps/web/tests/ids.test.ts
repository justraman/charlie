import { describe, expect, test } from 'bun:test'
import { uuidv7 } from '../worker/lib/ids'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('uuidv7', () => {
  test('has the v7 version and variant nibbles', () => {
    for (let i = 0; i < 100; i++) {
      expect(uuidv7()).toMatch(UUID_RE)
    }
  })

  test('ids from later timestamps sort after earlier ones', () => {
    const early = uuidv7(1_000_000_000_000)
    const late = uuidv7(2_000_000_000_000)
    expect(early < late).toBe(true)
  })

  test('is unique across many draws at the same instant', () => {
    const now = 1_710_000_000_000
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) seen.add(uuidv7(now))
    expect(seen.size).toBe(1000)
  })
})
