import { describe, expect, test } from 'bun:test'
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose'
import {
  buildGoogleAuthUrl,
  emailDomain,
  generatePkce,
  verifyGoogleIdToken,
} from '../worker/lib/oidc'

const CLIENT_ID = 'charlie-client.apps.googleusercontent.com'
const ISSUER = 'https://accounts.google.com'
const KID = 'test-key-1'

// Build a signing key + a matching local JWKS resolver so we can exercise
// verification exactly as production does, minus the network round-trip.
async function makeSigner() {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
  const pubJwk = (await exportJWK(publicKey)) as JWK
  pubJwk.kid = KID
  pubJwk.alg = 'RS256'
  pubJwk.use = 'sig'
  const jwks = createLocalJWKSet({ keys: [pubJwk] })

  async function sign(claims: Record<string, unknown>, opts?: { expSecFromNow?: number }) {
    const nowSec = Math.floor(Date.now() / 1000)
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + (opts?.expSecFromNow ?? 3600))
      .sign(privateKey)
  }
  return { jwks, sign }
}

const baseClaims = {
  sub: '1234567890',
  email: 'qa@Example.com',
  email_verified: true,
  name: 'QA Engineer',
  picture: 'https://example.com/a.png',
  nonce: 'nonce-abc',
}

describe('verifyGoogleIdToken', () => {
  test('accepts a valid token and normalizes claims', async () => {
    const { jwks, sign } = await makeSigner()
    const token = await sign(baseClaims)
    const identity = await verifyGoogleIdToken(token, {
      clientId: CLIENT_ID,
      jwks,
      expectedNonce: 'nonce-abc',
    })
    expect(identity.sub).toBe('1234567890')
    expect(identity.email).toBe('qa@example.com') // lowercased
    expect(identity.emailVerified).toBe(true)
    expect(identity.name).toBe('QA Engineer')
  })

  test('accepts email_verified as the string "true"', async () => {
    const { jwks, sign } = await makeSigner()
    const token = await sign({ ...baseClaims, email_verified: 'true' })
    const identity = await verifyGoogleIdToken(token, { clientId: CLIENT_ID, jwks })
    expect(identity.emailVerified).toBe(true)
  })

  test('rejects a wrong audience', async () => {
    const { jwks, sign } = await makeSigner()
    const token = await sign(baseClaims)
    await expect(verifyGoogleIdToken(token, { clientId: 'someone-else', jwks })).rejects.toThrow(
      /verification failed/,
    )
  })

  test('rejects an expired token beyond clock tolerance', async () => {
    const { jwks, sign } = await makeSigner()
    const token = await sign(baseClaims, { expSecFromNow: -120 })
    await expect(
      verifyGoogleIdToken(token, { clientId: CLIENT_ID, jwks, clockToleranceSec: 30 }),
    ).rejects.toThrow(/verification failed/)
  })

  test('tolerates small clock skew within the window', async () => {
    const { jwks, sign } = await makeSigner()
    const token = await sign(baseClaims, { expSecFromNow: -20 })
    const identity = await verifyGoogleIdToken(token, {
      clientId: CLIENT_ID,
      jwks,
      clockToleranceSec: 60,
    })
    expect(identity.sub).toBe('1234567890')
  })

  test('rejects a nonce mismatch', async () => {
    const { jwks, sign } = await makeSigner()
    const token = await sign(baseClaims)
    await expect(
      verifyGoogleIdToken(token, { clientId: CLIENT_ID, jwks, expectedNonce: 'different' }),
    ).rejects.toThrow(/nonce/)
  })

  test('rejects a token signed by an unknown key', async () => {
    const { sign } = await makeSigner()
    const other = await makeSigner()
    const token = await sign(baseClaims)
    await expect(
      verifyGoogleIdToken(token, { clientId: CLIENT_ID, jwks: other.jwks }),
    ).rejects.toThrow()
  })
})

describe('generatePkce', () => {
  test('challenge is the S256 of the verifier, url-safe', async () => {
    const { verifier, challenge } = await generatePkce()
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
    const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    expect(challenge).toBe(expected)
    expect(challenge).not.toMatch(/[+/=]/)
  })
})

describe('buildGoogleAuthUrl', () => {
  test('includes required OIDC + PKCE params', () => {
    const url = new URL(
      buildGoogleAuthUrl({
        clientId: CLIENT_ID,
        redirectUri: 'http://localhost:8787/api/auth/google/callback',
        state: 'state123',
        codeChallenge: 'chal',
        nonce: 'nonce',
      }),
    )
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toContain('openid')
    expect(url.searchParams.get('state')).toBe('state123')
  })
})

describe('emailDomain', () => {
  test('extracts and lowercases the domain', () => {
    expect(emailDomain('QA@Example.COM')).toBe('example.com')
    expect(emailDomain('no-at-sign')).toBe('')
  })
})
