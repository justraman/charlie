import { describe, expect, test } from 'bun:test'
import { bearerToken, formatApiKey, generateApiKeySecret, parseApiKey } from '../worker/lib/apikeys'

describe('api key format/parse', () => {
  test('round-trips a formatted key', () => {
    const keyId = '0192f3aa-bbbb-7ccc-8ddd-eeeeffff0000'
    const secret = generateApiKeySecret()
    const token = formatApiKey('live', keyId, secret)
    const parsed = parseApiKey(token)
    expect(parsed).not.toBeNull()
    expect(parsed?.env).toBe('live')
    expect(parsed?.keyId).toBe(keyId)
    expect(parsed?.secret).toBe(secret)
  })

  test('generated secret is 64 hex chars with no underscores', () => {
    const secret = generateApiKeySecret()
    expect(secret).toMatch(/^[0-9a-f]{64}$/)
  })

  test('rejects malformed tokens', () => {
    expect(parseApiKey('nope')).toBeNull()
    expect(parseApiKey('charlie_live')).toBeNull()
    expect(parseApiKey('charlie_live_keyid')).toBeNull()
    expect(parseApiKey('charlie_live_keyid_secret_extra')).toBeNull()
    expect(parseApiKey('wrongprefix_live_keyid_secret')).toBeNull()
  })
})

describe('bearerToken', () => {
  test('extracts a bearer token case-insensitively', () => {
    expect(bearerToken('Bearer abc.def')).toBe('abc.def')
    expect(bearerToken('bearer   xyz')).toBe('xyz')
  })
  test('returns null for missing or non-bearer headers', () => {
    expect(bearerToken(null)).toBeNull()
    expect(bearerToken(undefined)).toBeNull()
    expect(bearerToken('Basic abc')).toBeNull()
  })
})
