// Control-plane HTTP client. Every call is authorized by the run-scoped token
// (CHARLIE_RUN_TOKEN), which authorizes exactly one run's callbacks.

import type { FlowStep, LoadProfile } from '@charlie/flow-core'

export interface RunnerConfig {
  apiUrl: string
  runToken: string
}

export interface BundleFlow {
  flowId: string
  name: string
  steps: FlowStep[]
  loadProfile: LoadProfile | null
}

export interface Bundle {
  runId: string
  engine: 'playwright' | 'k6'
  profile: string
  expectedShards: number
  environment: {
    baseUrl: string
    headers: Record<string, string>
    secrets: Record<string, string>
    authConfig: unknown
  }
  flows: BundleFlow[]
}

function authHeaders(cfg: RunnerConfig): Record<string, string> {
  return { authorization: `Bearer ${cfg.runToken}` }
}

async function okJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.url}: ${(await res.text()).slice(0, 300)}`)
  return res.json() as Promise<T>
}

export function fetchBundle(cfg: RunnerConfig, runId: string): Promise<Bundle> {
  return fetch(`${cfg.apiUrl}/api/runs/${runId}/bundle`, { headers: authHeaders(cfg) }).then((r) =>
    okJson<Bundle>(r),
  )
}

// payload mirrors the worker's ShardResultPayload; the worker validates it (Zod).
export async function postShardResult(
  cfg: RunnerConfig,
  runId: string,
  payload: unknown,
): Promise<void> {
  await okJson(
    await fetch(`${cfg.apiUrl}/api/runs/${runId}/shard-result`, {
      method: 'POST',
      headers: { ...authHeaders(cfg), 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
}

export function presign(
  cfg: RunnerConfig,
  runId: string,
  shard: number,
  name: string,
): Promise<{ key: string; uploadUrl: string; method: string }> {
  return fetch(`${cfg.apiUrl}/api/runs/${runId}/artifacts/presign`, {
    method: 'POST',
    headers: { ...authHeaders(cfg), 'content-type': 'application/json' },
    body: JSON.stringify({ shard, name }),
  }).then((r) => okJson(r))
}

export async function uploadArtifact(
  cfg: RunnerConfig,
  uploadUrl: string,
  bytes: Uint8Array | ArrayBuffer,
  contentType: string,
): Promise<void> {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { ...authHeaders(cfg), 'content-type': contentType },
    body: bytes as BodyInit,
  })
  if (!res.ok) throw new Error(`artifact upload failed: ${res.status}`)
}

export async function finalize(cfg: RunnerConfig, runId: string): Promise<void> {
  await okJson(
    await fetch(`${cfg.apiUrl}/api/runs/${runId}/finalize`, {
      method: 'POST',
      headers: authHeaders(cfg),
    }),
  )
}
