import { describe, expect, test } from 'bun:test'
import { verifyGithubSignature } from '../worker/lib/webhook'

// Compute the signature the way GitHub does, so the test is self-contained.
async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `sha256=${hex}`
}

describe('verifyGithubSignature', () => {
  const secret = 'top-secret-webhook-value'
  const body = '{"ref":"refs/heads/main","after":"abc"}'

  test('accepts a correct signature', async () => {
    const sig = await sign(secret, body)
    expect(await verifyGithubSignature(secret, body, sig)).toBe(true)
  })

  test('rejects a tampered body', async () => {
    const sig = await sign(secret, body)
    expect(await verifyGithubSignature(secret, `${body} `, sig)).toBe(false)
  })

  test('rejects a wrong secret', async () => {
    const sig = await sign('other-secret', body)
    expect(await verifyGithubSignature(secret, body, sig)).toBe(false)
  })

  test('rejects missing or malformed headers', async () => {
    expect(await verifyGithubSignature(secret, body, undefined)).toBe(false)
    expect(await verifyGithubSignature(secret, body, 'deadbeef')).toBe(false)
    expect(await verifyGithubSignature('', body, await sign(secret, body))).toBe(false)
  })
})
