import { describe, expect, test } from 'bun:test'
import { redact } from '../worker/lib/audit'

describe('redact', () => {
  test('redacts secret-looking keys but keeps structure', () => {
    const input = {
      name: 'qa env',
      base_url: 'https://qa.example.com',
      secrets: { API_TOKEN: 'abc123' },
      password: 'p@ss',
      client_secret: 'xyz',
      config_ciphertext: 'deadbeef',
      nested: { authorization: 'Bearer zzz', keep: 'visible' },
    }
    const out = redact(input) as Record<string, unknown>
    expect(out.name).toBe('qa env')
    expect(out.base_url).toBe('https://qa.example.com')
    expect(out.secrets).toBe('[redacted]')
    expect(out.password).toBe('[redacted]')
    expect(out.client_secret).toBe('[redacted]')
    expect(out.config_ciphertext).toBe('[redacted]')
    const nested = out.nested as Record<string, unknown>
    expect(nested.authorization).toBe('[redacted]')
    expect(nested.keep).toBe('visible')
  })

  test('recurses through arrays', () => {
    const out = redact([{ token: 't1' }, { token: 't2', ok: 1 }]) as Record<string, unknown>[]
    expect(out[0]!.token).toBe('[redacted]')
    expect(out[1]!.token).toBe('[redacted]')
    expect(out[1]!.ok).toBe(1)
  })

  test('passes through primitives and null', () => {
    expect(redact('hello')).toBe('hello')
    expect(redact(42)).toBe(42)
    expect(redact(null)).toBe(null)
  })
})
