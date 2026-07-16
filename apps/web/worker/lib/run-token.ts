// Run-scoped callback tokens. The compute plane (GitHub Actions) authenticates
// its callbacks — shard-result, artifact presign, finalize, bundle fetch — with
// one of these, and nothing else. It is a short-lived HS256 JWT carrying only
// the run id. "Expires on terminal status" is enforced by the callback
// middleware (which checks run status), on top of the hard TTL here.

import { jwtVerify, SignJWT } from 'jose'
import type { Env } from '../env'

const DEFAULT_TTL_SEC = 6 * 60 * 60 // 6 hours (docs/EXECUTION_PLAN "Run token TTL")
const encoder = new TextEncoder()

/** The signing key: a dedicated secret, or CHARLIE_KEK as a fallback. */
export function runTokenSecret(env: Env): Uint8Array {
  const secret = env.CHARLIE_RUN_TOKEN_SECRET ?? env.CHARLIE_KEK
  if (!secret) throw new Error('CHARLIE_RUN_TOKEN_SECRET (or CHARLIE_KEK) must be set')
  return encoder.encode(secret)
}

async function signScoped(
  scope: string,
  sub: string,
  secret: Uint8Array,
  ttlSec: number,
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000)
  return new SignJWT({ scope })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(sub)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + ttlSec)
    .sign(secret)
}

export async function signRunToken(
  runId: string,
  secret: Uint8Array,
  ttlSec: number = DEFAULT_TTL_SEC,
): Promise<string> {
  return signScoped('run', runId, secret, ttlSec)
}

/** Analysis-scoped callback token: authorizes an ai-analyze job's callbacks
 *  (config fetch + draft ingest) for exactly one analysis. */
export async function signAnalysisToken(
  analysisId: string,
  secret: Uint8Array,
  ttlSec: number = DEFAULT_TTL_SEC,
): Promise<string> {
  return signScoped('analysis', analysisId, secret, ttlSec)
}

export class RunTokenError extends Error {
  override name = 'RunTokenError'
}

async function verifyScoped(token: string, secret: Uint8Array, scope: string): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] })
    if (payload.scope !== scope || typeof payload.sub !== 'string') {
      throw new RunTokenError(`not a ${scope} token`)
    }
    return payload.sub
  } catch (err) {
    if (err instanceof RunTokenError) throw err
    throw new RunTokenError(`invalid ${scope} token: ${(err as Error).message}`)
  }
}

/** Verify signature + expiry and return the run id the token authorizes. */
export async function verifyRunToken(token: string, secret: Uint8Array): Promise<string> {
  return verifyScoped(token, secret, 'run')
}

/** Verify + return the analysis id an analysis token authorizes. */
export async function verifyAnalysisToken(token: string, secret: Uint8Array): Promise<string> {
  return verifyScoped(token, secret, 'analysis')
}
