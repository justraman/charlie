// GitHub webhook signature verification. GitHub signs the raw request body with
// the shared webhook secret (HMAC-SHA256) and sends it as `X-Hub-Signature-256:
// sha256=<hex>`. We recompute over the exact bytes and compare in constant time.

const encoder = new TextEncoder()

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/** Constant-time string comparison (avoids leaking match length via timing). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Verify GitHub's `X-Hub-Signature-256` header against the raw body. Returns
 * false on any missing/malformed input rather than throwing.
 */
export async function verifyGithubSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | undefined | null,
): Promise<boolean> {
  if (!secret || !signatureHeader?.startsWith('sha256=')) return false
  const provided = signatureHeader.slice('sha256='.length)
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody))
  return timingSafeEqual(provided, toHex(mac))
}
