// Cryptographic primitives, all on the Web Crypto API (available identically in
// Workers, Bun, and modern Node). No Node 'crypto' import, so this runs on the
// edge unchanged.

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** SHA-256 of a string, hex-encoded. Used for session-token and API-key hashes. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input))
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

/** A URL-safe random token. `bytes` of entropy (default 32 → 256 bits). */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return toBase64Url(buf)
}

/**
 * Constant-time string comparison. Runs in time proportional to the longer
 * input and never short-circuits on the first differing byte, so it does not
 * leak match length via timing.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a)
  const bb = encoder.encode(b)
  // Fold the length difference into the accumulator so unequal lengths still
  // take the full loop and always fail.
  let diff = ab.length ^ bb.length
  const len = Math.max(ab.length, bb.length)
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0)
  }
  return diff === 0
}

// --- AES-256-GCM envelope encryption for at-rest secrets --------------------
// KEK (CHARLIE_KEK) is a base64-encoded 32-byte key held in Workers Secrets.
// Ciphertext layout: base64url( iv(12) || ciphertext+tag ).

async function importKek(kekBase64: string): Promise<CryptoKey> {
  const raw = fromBase64(kekBase64)
  if (raw.length !== 32) {
    throw new Error('CHARLIE_KEK must decode to exactly 32 bytes (256-bit AES key)')
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function encryptString(plaintext: string, kekBase64: string): Promise<string> {
  const key = await importKek(kekBase64)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext)),
  )
  const out = new Uint8Array(iv.length + ct.length)
  out.set(iv, 0)
  out.set(ct, iv.length)
  return toBase64Url(out)
}

export async function decryptString(ciphertext: string, kekBase64: string): Promise<string> {
  const key = await importKek(kekBase64)
  const bytes = fromBase64Url(ciphertext)
  const iv = bytes.subarray(0, 12)
  const ct = bytes.subarray(12)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
  return decoder.decode(pt)
}
