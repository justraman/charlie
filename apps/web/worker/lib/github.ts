// GitHub App integration for the dispatch path (docs/CI_INTEGRATION.md).
// The App private key mints a short app JWT, which is exchanged for a
// per-installation token (cached until just before expiry). That token
// dispatches the reusable workflow, resolves the created run id, and cancels
// runs. All network calls take an injectable `fetchImpl` for unit testing.

import { importPKCS8, SignJWT } from 'jose'
import type { Env } from '../env'

const GH_API = 'https://api.github.com'
const DEFAULT_WORKFLOW = 'charlie-run.yml'
const DEFAULT_REF = 'main'
const UA = 'charlie-control-plane'

export function githubConfigured(env: Env): boolean {
  return Boolean(
    env.GITHUB_APP_ID &&
      env.GITHUB_APP_PRIVATE_KEY &&
      env.GITHUB_INSTALLATION_ID &&
      env.GITHUB_RUNNER_REPO,
  )
}

/** A ~10-minute App JWT (RS256), used only to mint installation tokens. */
export async function createAppJwt(
  appId: string,
  privateKeyPem: string,
  now: number = Date.now(),
): Promise<string> {
  const key = await importPKCS8(privateKeyPem, 'RS256')
  const iat = Math.floor(now / 1000) - 30 // clock-skew cushion
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(appId)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 570) // < 10 min
    .sign(key)
}

interface CachedToken {
  token: string
  expiresAtMs: number
}
const tokenCache = new Map<string, CachedToken>()

export interface GithubDeps {
  fetchImpl?: typeof fetch
  now?: () => number
}

/** Mint (or reuse a cached) installation access token. */
export async function getInstallationToken(env: Env, deps: GithubDeps = {}): Promise<string> {
  const doFetch = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  const installationId = env.GITHUB_INSTALLATION_ID!
  const cached = tokenCache.get(installationId)
  // Refresh 60s before expiry.
  if (cached && cached.expiresAtMs - 60_000 > now()) return cached.token

  const jwt = await createAppJwt(env.GITHUB_APP_ID!, env.GITHUB_APP_PRIVATE_KEY!, now())
  const res = await doFetch(`${GH_API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: 'application/vnd.github+json',
      'user-agent': UA,
    },
  })
  if (!res.ok) {
    throw new Error(
      `installation token failed (${res.status}): ${(await res.text()).slice(0, 300)}`,
    )
  }
  const json = (await res.json()) as { token: string; expires_at: string }
  tokenCache.set(installationId, { token: json.token, expiresAtMs: Date.parse(json.expires_at) })
  return json.token
}

function repoOf(env: Env): string {
  return env.GITHUB_RUNNER_REPO!
}

/** Dispatch the reusable workflow with string inputs. Returns the dispatch time. */
export async function dispatchWorkflow(
  env: Env,
  inputs: Record<string, string>,
  deps: GithubDeps = {},
): Promise<{ dispatchedAt: string }> {
  const doFetch = deps.fetchImpl ?? fetch
  const token = await getInstallationToken(env, deps)
  const workflow = env.RUNNER_WORKFLOW_FILE ?? DEFAULT_WORKFLOW
  const ref = env.GITHUB_RUNNER_REF ?? DEFAULT_REF
  const url = `${GH_API}/repos/${repoOf(env)}/actions/workflows/${workflow}/dispatches`
  const dispatchedAt = new Date((deps.now ?? Date.now)()).toISOString()
  const res = await doFetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': UA,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ref, inputs }),
  })
  if (res.status !== 204) {
    throw new Error(`workflow_dispatch failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
  }
  return { dispatchedAt }
}

/**
 * GitHub doesn't return the run id from dispatch, so we list recent
 * workflow_dispatch runs and match by run-name (which embeds the runId) or the
 * newest created after `sinceIso`.
 */
export async function resolveRunId(
  env: Env,
  opts: { runId: string; sinceIso: string },
  deps: GithubDeps = {},
): Promise<string | null> {
  const doFetch = deps.fetchImpl ?? fetch
  const token = await getInstallationToken(env, deps)
  const workflow = env.RUNNER_WORKFLOW_FILE ?? DEFAULT_WORKFLOW
  const url =
    `${GH_API}/repos/${repoOf(env)}/actions/workflows/${workflow}/runs` +
    `?event=workflow_dispatch&per_page=30`
  const res = await doFetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': UA,
    },
  })
  if (!res.ok) return null
  const body = (await res.json()) as {
    workflow_runs?: Array<{
      id: number
      name?: string
      run_started_at?: string
      created_at?: string
    }>
  }
  const runs = body.workflow_runs ?? []
  // Prefer a run whose run-name embeds our runId (set via `run-name:` in the workflow).
  const byName = runs.find((r) => r.name?.includes(opts.runId))
  if (byName) return String(byName.id)
  const sinceMs = Date.parse(opts.sinceIso)
  const recent = runs
    .filter((r) => r.created_at && Date.parse(r.created_at) >= sinceMs - 5_000)
    .sort((a, b) => Date.parse(b.created_at!) - Date.parse(a.created_at!))
  return recent[0] ? String(recent[0].id) : null
}

export async function cancelWorkflowRun(
  env: Env,
  ghaRunId: string,
  deps: GithubDeps = {},
): Promise<boolean> {
  const doFetch = deps.fetchImpl ?? fetch
  const token = await getInstallationToken(env, deps)
  const res = await doFetch(`${GH_API}/repos/${repoOf(env)}/actions/runs/${ghaRunId}/cancel`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': UA,
    },
  })
  // 202 accepted; 409 if already completed.
  return res.status === 202
}

/** Test seam: clear the installation-token cache. */
export function _clearTokenCache(): void {
  tokenCache.clear()
}
