// AI provider abstraction + adapters. Each adapter turns a repo surface into
// FlowDraft[] under a strict structured-output contract (validated by flow-core;
// malformed output is retried once, then rejected — never executed). A fake
// provider (CHARLIE_FAKE_AI=1) derives deterministic drafts from the surface so
// the whole pipeline is testable without an API key.
//
// Safety: only the extracted surface (+ optional excerpts) is sent to the model.
// Environment secrets are never available here; the model is instructed to emit
// {{secrets.NAME}} placeholders for sensitive fields.

import { type FlowDraft, flowDraftArraySchema } from '@charlie/flow-core'
import type { FormSurface, RepoSurface } from './surface'

export interface ProviderConfig {
  name: 'anthropic' | 'openai' | 'workers_ai'
  model: string
  apiKey: string | null
  accountId: string | null
}

const SYSTEM_PROMPT = [
  'You are Charlie, drafting end-to-end test flows from a web app’s static surface.',
  'Return ONLY a JSON array of flow drafts. Each draft:',
  '{ "name": string, "description"?: string, "engines": ["playwright"],',
  '  "steps": FlowStep[], "reasoning"?: string, "sourceRefs"?: [{"file":string,"route"?:string}] }',
  'FlowStep actions: goto{url}, click{selector}, fill{selector,value}, submit{selector},',
  'waitFor{selector|ms}, assert{selector,state}|{text}, extract{selector|regex,as}, setHeader{name,value}.',
  'Rules: prefer stable selectors (data-test, aria, roles) over brittle CSS/nth-child.',
  'Use {{secrets.NAME}} placeholders for credentials/tokens — NEVER invent secret values.',
  'Reference only routes/forms present in the surface. Note any guesses in "reasoning".',
  'Output valid JSON only, no prose, no code fences.',
].join('\n')

export interface AiProvider {
  name: ProviderConfig['name']
  analyze(surface: RepoSurface): Promise<FlowDraft[]>
}

/** Pull the first JSON array/object out of a model response (tolerates fences/prose). */
function extractJson(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const start = trimmed.search(/[[{]/)
    const end = Math.max(trimmed.lastIndexOf(']'), trimmed.lastIndexOf('}'))
    if (start !== -1 && end > start) return JSON.parse(trimmed.slice(start, end + 1))
    throw new Error('no JSON found in model response')
  }
}

function validate(raw: unknown): FlowDraft[] {
  // Accept either a bare array or { drafts: [...] }.
  const arr = Array.isArray(raw) ? raw : (raw as { drafts?: unknown })?.drafts
  const parsed = flowDraftArraySchema.safeParse(arr)
  if (!parsed.success)
    throw new Error(`draft validation failed: ${parsed.error.message.slice(0, 300)}`)
  return parsed.data
}

function userPrompt(surface: RepoSurface): string {
  return `Surface (framework=${surface.framework.join(',') || 'unknown'}):\n${JSON.stringify(
    { routes: surface.routes, forms: surface.forms, testIds: surface.testIds.slice(0, 60) },
    null,
    2,
  )}\n\nDraft up to 6 realistic flows.`
}

// --- Real adapters (exercised with a live key on the compute plane) ---------

async function callAnthropic(cfg: ProviderConfig, surface: RepoSurface): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': cfg.apiKey ?? '',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt(surface) }],
    }),
  })
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = (await res.json()) as { content?: { text?: string }[] }
  return data.content?.map((b) => b.text ?? '').join('') ?? ''
}

async function callOpenai(cfg: ProviderConfig, surface: RepoSurface): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.apiKey ?? ''}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `${userPrompt(surface)}\nReturn {"drafts": FlowDraft[]}.` },
      ],
      response_format: { type: 'json_object' },
    }),
  })
  if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  return data.choices?.[0]?.message?.content ?? ''
}

async function callWorkersAi(cfg: ProviderConfig, surface: RepoSurface): Promise<string> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/ai/run/${cfg.model}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.apiKey ?? ''}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt(surface) },
      ],
    }),
  })
  if (!res.ok) throw new Error(`workers_ai ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = (await res.json()) as { result?: { response?: string } }
  return data.result?.response ?? ''
}

function realProvider(cfg: ProviderConfig): AiProvider {
  const call =
    cfg.name === 'anthropic' ? callAnthropic : cfg.name === 'openai' ? callOpenai : callWorkersAi
  return {
    name: cfg.name,
    async analyze(surface) {
      // One retry: models occasionally wrap output or miss a field.
      let lastErr: unknown
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return validate(extractJson(await call(cfg, surface)))
        } catch (err) {
          lastErr = err
        }
      }
      throw new Error(`provider produced no valid drafts: ${(lastErr as Error).message}`)
    },
  }
}

// --- Fake provider (deterministic, no network) ------------------------------

function secretPlaceholder(field: string): string {
  const f = field.toLowerCase()
  if (/e-?mail/.test(f)) return '{{secrets.TEST_EMAIL}}'
  if (/pass|pwd/.test(f)) return '{{secrets.TEST_PASSWORD}}'
  if (/token|secret|api[-_]?key|otp/.test(f)) return `{{secrets.${field.toUpperCase()}}}`
  if (/user|login|account/.test(f)) return '{{secrets.TEST_USER}}'
  return 'charlie-test'
}

function formDraft(form: FormSurface, testIds: string[]): FlowDraft {
  const route = form.route ?? '/'
  const name = (route.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'form').slice(0, 40)
  const steps: FlowDraft['steps'] = [{ action: 'goto', url: route }]
  for (const f of form.fields) {
    steps.push({ action: 'fill', selector: `[name="${f.name}"]`, value: secretPlaceholder(f.name) })
  }
  steps.push({ action: 'submit', selector: 'form' })
  steps.push(
    testIds[0]
      ? { action: 'assert', selector: `[data-test="${testIds[0]}"]`, state: 'visible' }
      : { action: 'assert', selector: 'body', state: 'visible' },
  )
  return {
    name: `submit-${name}`,
    description: `Fill and submit the form at ${route}.`,
    engines: ['playwright'],
    steps,
    reasoning: `Found a <form> with fields ${form.fields
      .map((f) => f.name)
      .join(', ')} in ${form.file}. Sensitive fields use {{secrets.*}} placeholders.`,
    sourceRefs: [{ file: form.file, route }],
  }
}

function navDraft(surface: RepoSurface): FlowDraft | null {
  const routes = surface.routes
    .map((r) => r.path)
    .filter((p) => p.startsWith('/') && !p.includes(':') && !p.includes('*'))
    .slice(0, 5)
  if (routes.length === 0) return null
  const steps: FlowDraft['steps'] = []
  for (const p of routes) {
    steps.push({ action: 'goto', url: p })
    steps.push({ action: 'assert', selector: 'body', state: 'visible' })
  }
  return {
    name: 'navigation-smoke',
    description: 'Visit the main routes and assert each renders.',
    engines: ['playwright'],
    steps,
    reasoning: `Discovered ${routes.length} static route(s); this smoke flow checks each loads.`,
    sourceRefs: surface.routes
      .filter((r) => routes.includes(r.path))
      .slice(0, 5)
      .map((r) => ({ file: r.file, route: r.path })),
  }
}

function fakeProvider(): AiProvider {
  return {
    name: 'anthropic',
    async analyze(surface) {
      const testIds = surface.testIds.map((t) => t.id)
      const drafts: FlowDraft[] = []
      // Attach a route to forms where the same file also declared one.
      for (const form of surface.forms.slice(0, 4)) {
        const route = surface.routes.find((r) => r.file === form.file)?.path
        drafts.push(formDraft({ ...form, route }, testIds))
      }
      const nav = navDraft(surface)
      if (nav) drafts.push(nav)
      // Guarantee at least one draft even for a bare repo.
      if (drafts.length === 0) {
        drafts.push({
          name: 'home-smoke',
          engines: ['playwright'],
          steps: [
            { action: 'goto', url: '/' },
            { action: 'assert', selector: 'body', state: 'visible' },
          ],
          reasoning: 'No routes/forms detected; drafted a minimal home-page smoke check.',
        })
      }
      return validate(drafts)
    },
  }
}

/** Pick the provider implementation. Fake mode short-circuits the network. */
export function getProvider(cfg: ProviderConfig): AiProvider {
  if (process.env.CHARLIE_FAKE_AI === '1') return fakeProvider()
  return realProvider(cfg)
}
