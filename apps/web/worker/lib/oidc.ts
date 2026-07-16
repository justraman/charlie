// Google OpenID Connect. Split into pure, injectable pieces so token
// verification can be exercised against a local JWKS in unit tests without
// hitting Google (see oidc.test.ts).

import { createRemoteJWKSet, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from 'jose'
import { fromBase64Url, sha256Hex, toBase64Url } from './crypto'

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const GOOGLE_JWKS_URL = new URL('https://www.googleapis.com/oauth2/v3/certs')
// Google publishes tokens under both spellings; accept either.
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

/** Lazily-cached remote key set (jose caches keys and honours rotation). */
let cachedJwks: JWTVerifyGetKey | undefined
export function googleJwks(): JWTVerifyGetKey {
  if (!cachedJwks) cachedJwks = createRemoteJWKSet(GOOGLE_JWKS_URL)
  return cachedJwks
}

export interface Pkce {
  verifier: string
  challenge: string
}

/** RFC 7636 S256 PKCE pair. Verifier is 43 chars of base64url entropy. */
export async function generatePkce(): Promise<Pkce> {
  const raw = new Uint8Array(32)
  crypto.getRandomValues(raw)
  const verifier = toBase64Url(raw)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const challenge = toBase64Url(new Uint8Array(digest))
  return { verifier, challenge }
}

export interface AuthUrlParams {
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
  nonce: string
  scope?: string
}

export function buildGoogleAuthUrl(p: AuthUrlParams): string {
  const url = new URL(GOOGLE_AUTH_ENDPOINT)
  url.searchParams.set('client_id', p.clientId)
  url.searchParams.set('redirect_uri', p.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', p.scope ?? 'openid email profile')
  url.searchParams.set('state', p.state)
  url.searchParams.set('nonce', p.nonce)
  url.searchParams.set('code_challenge', p.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('access_type', 'online')
  url.searchParams.set('prompt', 'select_account')
  return url.toString()
}

export interface TokenExchangeParams {
  clientId: string
  clientSecret: string
  code: string
  redirectUri: string
  codeVerifier: string
  fetchImpl?: typeof fetch
}

export interface TokenResponse {
  id_token: string
  access_token?: string
  expires_in?: number
  token_type?: string
}

export async function exchangeCodeForTokens(p: TokenExchangeParams): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: p.code,
    client_id: p.clientId,
    client_secret: p.clientSecret,
    redirect_uri: p.redirectUri,
    code_verifier: p.codeVerifier,
  })
  const doFetch = p.fetchImpl ?? fetch
  const res = await doFetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new OidcError(`token exchange failed (${res.status}): ${detail.slice(0, 300)}`)
  }
  const json = (await res.json()) as TokenResponse
  if (!json.id_token) throw new OidcError('token response missing id_token')
  return json
}

export class OidcError extends Error {
  override name = 'OidcError'
}

export interface GoogleIdentity {
  sub: string
  email: string
  emailVerified: boolean
  name: string | null
  picture: string | null
}

export interface VerifyParams {
  clientId: string
  /** Injectable for tests; defaults to Google's remote JWKS. */
  jwks?: JWTVerifyGetKey
  /** The nonce we issued at /start; rejects tokens that don't echo it. */
  expectedNonce?: string
  /** Seconds of clock skew to tolerate (default 60). */
  clockToleranceSec?: number
}

/**
 * Verifies a Google ID token's signature, issuer, audience, and expiry, then
 * returns the identity claims. Throws OidcError on any failure.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  params: VerifyParams,
): Promise<GoogleIdentity> {
  let payload: JWTPayload
  try {
    const result = await jwtVerify(idToken, params.jwks ?? googleJwks(), {
      issuer: GOOGLE_ISSUERS,
      audience: params.clientId,
      clockTolerance: params.clockToleranceSec ?? 60,
    })
    payload = result.payload
  } catch (err) {
    throw new OidcError(`id_token verification failed: ${(err as Error).message}`)
  }

  if (params.expectedNonce && payload.nonce !== params.expectedNonce) {
    throw new OidcError('id_token nonce mismatch')
  }

  const email = typeof payload.email === 'string' ? payload.email : null
  const sub = typeof payload.sub === 'string' ? payload.sub : null
  if (!email || !sub) throw new OidcError('id_token missing email or sub')

  return {
    sub,
    email: email.toLowerCase(),
    // Google sends email_verified as a boolean or the string "true".
    emailVerified: payload.email_verified === true || payload.email_verified === 'true',
    name: typeof payload.name === 'string' ? payload.name : null,
    picture: typeof payload.picture === 'string' ? payload.picture : null,
  }
}

/** Extract the registrable-ish domain (portion after '@'), lowercased. */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@')
  return at === -1 ? '' : email.slice(at + 1).toLowerCase()
}

// Re-exported so tests that build fixture challenges share the exact codec.
export const _internal = { fromBase64Url, sha256Hex }
