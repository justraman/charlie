import { describe, expect, test } from 'bun:test'
import {
  constantTimeEqual,
  decryptString,
  encryptString,
  fromBase64Url,
  sha256Hex,
  toBase64Url,
} from '../worker/lib/crypto'

function randomKekBase64(): string {
  const raw = new Uint8Array(32)
  crypto.getRandomValues(raw)
  let binary = ''
  for (const b of raw) binary += String.fromCharCode(b)
  return btoa(binary)
}

describe('sha256Hex', () => {
  test('known vectors', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})

describe('constantTimeEqual', () => {
  test('equal strings', () => {
    expect(constantTimeEqual('hunter2', 'hunter2')).toBe(true)
  })
  test('different strings of equal length', () => {
    expect(constantTimeEqual('hunter2', 'hunter3')).toBe(false)
  })
  test('different lengths', () => {
    expect(constantTimeEqual('short', 'longer-value')).toBe(false)
    expect(constantTimeEqual('', 'x')).toBe(false)
  })
})

describe('base64url', () => {
  test('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 62, 63])
    expect(Array.from(fromBase64Url(toBase64Url(bytes)))).toEqual(Array.from(bytes))
  })
  test('produces url-safe output (no + / =)', () => {
    const bytes = new Uint8Array(48)
    crypto.getRandomValues(bytes)
    const encoded = toBase64Url(bytes)
    expect(encoded).not.toMatch(/[+/=]/)
  })
})

describe('AES-GCM envelope', () => {
  test('encrypt then decrypt round-trips', async () => {
    const kek = randomKekBase64()
    const plaintext = JSON.stringify({ token: 'secret-value', n: 42 })
    const ct = await encryptString(plaintext, kek)
    expect(ct).not.toContain('secret-value')
    expect(await decryptString(ct, kek)).toBe(plaintext)
  })

  test('different key fails to decrypt', async () => {
    const ct = await encryptString('data', randomKekBase64())
    await expect(decryptString(ct, randomKekBase64())).rejects.toThrow()
  })

  test('rejects a KEK that is not 32 bytes', async () => {
    const shortKek = btoa('too-short')
    await expect(encryptString('data', shortKek)).rejects.toThrow(/32 bytes/)
  })
})
