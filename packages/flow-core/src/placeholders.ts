// Placeholder resolution for {{secrets.NAME}} and {{vars.NAME}}. Secrets come
// from the environment's decrypted secret map (compute plane only); vars come
// from values bound by earlier `extract` steps. Resolution happens at run time,
// never at authoring time — the control plane stores the raw placeholders.

import type { FlowStep } from './schema'

const PLACEHOLDER_RE = /\{\{\s*(secrets|vars)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

export interface PlaceholderRef {
  kind: 'secrets' | 'vars'
  name: string
}

export interface PlaceholderSources {
  secrets?: Record<string, string>
  vars?: Record<string, string>
}

export type MissingBehavior = 'throw' | 'empty' | 'keep'

export class PlaceholderError extends Error {
  constructor(ref: PlaceholderRef) {
    super(`Unresolved placeholder {{${ref.kind}.${ref.name}}}`)
    this.name = 'PlaceholderError'
  }
}

/** Every {{secrets.*}} / {{vars.*}} reference found in `text`, in order. */
export function findPlaceholders(text: string): PlaceholderRef[] {
  const refs: PlaceholderRef[] = []
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    refs.push({ kind: m[1] as PlaceholderRef['kind'], name: m[2]! })
  }
  return refs
}

/**
 * Replace placeholders in `text` with values from `sources`. On a missing key:
 * 'throw' (default) surfaces a PlaceholderError, 'empty' substitutes '', 'keep'
 * leaves the token untouched.
 */
export function resolvePlaceholders(
  text: string,
  sources: PlaceholderSources,
  onMissing: MissingBehavior = 'throw',
): string {
  return text.replace(PLACEHOLDER_RE, (whole, kind: PlaceholderRef['kind'], name: string) => {
    const bag = kind === 'secrets' ? sources.secrets : sources.vars
    const value = bag?.[name]
    if (value !== undefined) return value
    if (onMissing === 'empty') return ''
    if (onMissing === 'keep') return whole
    throw new PlaceholderError({ kind, name })
  })
}

// String-valued step fields that may contain placeholders.
const RESOLVABLE_FIELDS = ['url', 'value', 'text', 'name'] as const

/** Return a copy of `step` with placeholders resolved in its string fields. */
export function resolveStepPlaceholders(
  step: FlowStep,
  sources: PlaceholderSources,
  onMissing: MissingBehavior = 'throw',
): FlowStep {
  const copy = { ...step } as Record<string, unknown>
  for (const field of RESOLVABLE_FIELDS) {
    const v = copy[field]
    if (typeof v === 'string') copy[field] = resolvePlaceholders(v, sources, onMissing)
  }
  return copy as FlowStep
}
