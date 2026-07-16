// API-key token format: `charlie_{env}_{keyId}_{secret}` (see docs/AUTH.md).
// Only SHA-256(secret) is ever stored (api_keys.secret_hash). The secret half
// is hex so the token splits cleanly on '_' — keyId is a UUID (hyphens, no
// underscores) and the env label is alphanumeric, so exactly three delimiters.

const PREFIX = 'charlie'

export interface ParsedApiKey {
  env: string
  keyId: string
  secret: string
}

/** 32 bytes of entropy as 64 lowercase hex chars — no '_' to confuse parsing. */
export function generateApiKeySecret(): string {
  const buf = new Uint8Array(32)
  crypto.getRandomValues(buf)
  let hex = ''
  for (const b of buf) hex += b.toString(16).padStart(2, '0')
  return hex
}

export function formatApiKey(env: string, keyId: string, secret: string): string {
  return `${PREFIX}_${env}_${keyId}_${secret}`
}

/** Returns the token parts, or null if it is not a well-formed Charlie key. */
export function parseApiKey(token: string): ParsedApiKey | null {
  if (!token.startsWith(`${PREFIX}_`)) return null
  const parts = token.split('_')
  // [charlie, env, keyId, secret]
  if (parts.length !== 4) return null
  const [prefix, env, keyId, secret] = parts as [string, string, string, string]
  if (prefix !== PREFIX || !env || !keyId || !secret) return null
  return { env, keyId, secret }
}

/** Pull a bearer token out of an Authorization header, or null. */
export function bearerToken(authorization: string | null | undefined): string | null {
  if (!authorization) return null
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
  return match?.[1] ? match[1].trim() : null
}
