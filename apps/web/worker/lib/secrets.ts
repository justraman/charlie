// Environment secrets are stored as AES-GCM ciphertext of a JSON {name:value}
// map (environments.secrets_ciphertext). Plaintext is decrypted only
// server-side and injected into dispatched runs; it is NEVER serialized back to
// a client. API responses carry a masked map instead.

import { decryptString, encryptString } from './crypto'
import { HttpError } from './http'

export const SECRET_MASK = '•••set'

function requireKek(kek: string | undefined): string {
  if (!kek) throw new HttpError('internal', 'CHARLIE_KEK is not configured')
  return kek
}

export async function encryptSecrets(
  secrets: Record<string, string>,
  kek: string | undefined,
): Promise<string> {
  return encryptString(JSON.stringify(secrets), requireKek(kek))
}

export async function decryptSecrets(
  ciphertext: string | null,
  kek: string | undefined,
): Promise<Record<string, string>> {
  if (!ciphertext) return {}
  const json = await decryptString(ciphertext, requireKek(kek))
  const parsed = JSON.parse(json)
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
}

/** A client-safe view: secret names present, values masked. */
export async function maskedSecrets(
  ciphertext: string | null,
  kek: string | undefined,
): Promise<Record<string, string>> {
  const secrets = await decryptSecrets(ciphertext, kek)
  const masked: Record<string, string> = {}
  for (const name of Object.keys(secrets)) masked[name] = SECRET_MASK
  return masked
}

/**
 * Merge an incoming patch into the existing secret map. A value of `null`
 * deletes that key; any other string sets it. Returns the new map (or null if
 * it ends up empty, so we can store NULL ciphertext).
 */
export function applySecretPatch(
  existing: Record<string, string>,
  patch: Record<string, string | null>,
): Record<string, string> {
  const next = { ...existing }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete next[k]
    else next[k] = v
  }
  return next
}
