// AI provider config, sourced entirely from env (Cloudflare secrets) — a single
// active provider selected by AI_PROVIDER. No DB storage. The resolved shape is
// exactly what the analysis-config callback hands to the compute plane and what
// packages/runner's ProviderConfig expects: { name, model, apiKey, accountId }.

import type { Env } from '../env'

export type AiKind = 'anthropic' | 'openai' | 'workers_ai'

export interface AiProviderConfig {
  name: AiKind
  model: string
  apiKey: string | null
  accountId: string | null
}

function isAiKind(v: string | undefined): v is AiKind {
  return v === 'anthropic' || v === 'openai' || v === 'workers_ai'
}

/**
 * Resolve the single configured AI provider from env, or null if not (fully)
 * configured. anthropic/openai need an API key; workers_ai needs a key + account
 * id. All need a model.
 */
export function resolveAiProvider(env: Env): AiProviderConfig | null {
  const name = env.AI_PROVIDER
  const model = env.AI_MODEL
  const apiKey = env.AI_API_KEY ?? null
  const accountId = env.AI_ACCOUNT_ID ?? null
  if (!isAiKind(name) || !model) return null
  if (name === 'workers_ai') {
    if (!apiKey || !accountId) return null
  } else if (!apiKey) {
    return null
  }
  return { name, model, apiKey, accountId }
}

export function aiConfigured(env: Env): boolean {
  return resolveAiProvider(env) !== null
}

export interface CheckResult {
  ok: boolean
  detail: string | null
}

/**
 * Live connectivity check: hit the provider's (free) models-list endpoint to
 * confirm the key works. No token spend. `fetchImpl` is injectable for tests.
 */
export async function aiCheck(env: Env, fetchImpl: typeof fetch = fetch): Promise<CheckResult> {
  const provider = resolveAiProvider(env)
  if (!provider) return { ok: false, detail: 'not configured' }
  try {
    const res = await aiModelsRequest(provider, fetchImpl)
    if (res.ok) return { ok: true, detail: `${provider.name} · ${provider.model}` }
    const body = await res.text().catch(() => '')
    return { ok: false, detail: `HTTP ${res.status} ${body.slice(0, 120)}`.trim() }
  } catch (err) {
    return { ok: false, detail: (err as Error).message }
  }
}

function aiModelsRequest(provider: AiProviderConfig, doFetch: typeof fetch): Promise<Response> {
  switch (provider.name) {
    case 'anthropic':
      return doFetch('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': provider.apiKey ?? '',
          'anthropic-version': '2023-06-01',
        },
      })
    case 'openai':
      return doFetch('https://api.openai.com/v1/models', {
        headers: { authorization: `Bearer ${provider.apiKey ?? ''}` },
      })
    case 'workers_ai':
      return doFetch(
        `https://api.cloudflare.com/client/v4/accounts/${provider.accountId}/ai/models/search?per_page=1`,
        { headers: { authorization: `Bearer ${provider.apiKey ?? ''}` } },
      )
  }
}
