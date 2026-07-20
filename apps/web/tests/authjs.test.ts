import { describe, expect, test } from 'bun:test'
import { emailDomain, isEmailAllowed } from '../worker/lib/authjs'

describe('emailDomain', () => {
  test('extracts and lowercases the domain', () => {
    expect(emailDomain('Alice@Example.com')).toBe('example.com')
    expect(emailDomain('bob@corp.example.co.uk')).toBe('corp.example.co.uk')
  })

  test('handles plus-addressing and multiple dots', () => {
    expect(emailDomain('a.b+tag@sub.example.com')).toBe('sub.example.com')
  })

  test('returns empty string for a malformed address', () => {
    expect(emailDomain('no-at-sign')).toBe('')
    expect(emailDomain('')).toBe('')
  })
})

describe('isEmailAllowed (company-domain gate)', () => {
  const allowed = ['example.com', 'corp.example.com']

  test('admits an allowed domain, case-insensitively', () => {
    expect(isEmailAllowed('user@example.com', allowed)).toBe(true)
    expect(isEmailAllowed('USER@Example.com', allowed)).toBe(true)
    expect(isEmailAllowed('user@corp.example.com', allowed)).toBe(true)
  })

  test('rejects a domain not on the allow-list', () => {
    expect(isEmailAllowed('user@gmail.com', allowed)).toBe(false)
    // A subdomain of an allowed domain is NOT implicitly allowed.
    expect(isEmailAllowed('user@evil.example.com', allowed)).toBe(false)
  })

  test('rejects empty / malformed / null addresses', () => {
    expect(isEmailAllowed('', allowed)).toBe(false)
    expect(isEmailAllowed('not-an-email', allowed)).toBe(false)
    expect(isEmailAllowed(null, allowed)).toBe(false)
    expect(isEmailAllowed(undefined, allowed)).toBe(false)
  })

  test('rejects everything when the allow-list is empty', () => {
    expect(isEmailAllowed('user@example.com', [])).toBe(false)
  })
})
