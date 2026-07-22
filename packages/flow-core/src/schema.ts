// The engine-agnostic flow format (see docs/TEST_ENGINES.md). One authored
// flow runs as Playwright (E2E) or k6 (load). Steps are a discriminated union
// on `action`; each variant is a strict object so unknown fields are rejected
// at the API boundary with a 400.

import { z } from 'zod'

export const ENGINES = ['playwright', 'k6'] as const
export type Engine = (typeof ENGINES)[number]

export const ASSERT_STATES = ['visible', 'hidden', 'attached', 'detached'] as const

// Fields every step may carry regardless of action.
const commonStepFields = {
  /** Optional human label shown in the editor and event stream. */
  label: z.string().max(200).optional(),
  /** Capture screenshot + trace on this step's failure (E2E). */
  captureOnFail: z.boolean().optional(),
  /** Per-step timeout override (ms). */
  timeout: z.number().int().positive().max(600_000).optional(),
}

const gotoStep = z.strictObject({
  action: z.literal('goto'),
  /** Relative to the environment base_url, or absolute. */
  url: z.string().min(1),
  ...commonStepFields,
})

const clickStep = z.strictObject({
  action: z.literal('click'),
  selector: z.string().min(1),
  ...commonStepFields,
})

const fillStep = z.strictObject({
  action: z.literal('fill'),
  selector: z.string().min(1),
  value: z.string(),
  ...commonStepFields,
})

const waitForStep = z
  .strictObject({
    action: z.literal('waitFor'),
    selector: z.string().min(1).optional(),
    ms: z.number().int().nonnegative().max(600_000).optional(),
    ...commonStepFields,
  })
  .refine((s) => s.selector !== undefined || s.ms !== undefined, {
    message: 'waitFor requires either `selector` or `ms`',
  })

const assertStep = z
  .strictObject({
    action: z.literal('assert'),
    selector: z.string().min(1).optional(),
    state: z.enum(ASSERT_STATES).optional(),
    text: z.string().optional(),
    ...commonStepFields,
  })
  .refine((s) => (s.selector !== undefined && s.state !== undefined) || s.text !== undefined, {
    message: 'assert requires `selector` + `state`, or `text`',
  })

const extractStep = z
  .strictObject({
    action: z.literal('extract'),
    selector: z.string().min(1).optional(),
    regex: z.string().min(1).optional(),
    /** Variable name the extracted value is bound to ({{vars.NAME}}). */
    as: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a valid variable name'),
    ...commonStepFields,
  })
  .refine((s) => s.selector !== undefined || s.regex !== undefined, {
    message: 'extract requires either `selector` or `regex`',
  })

const submitStep = z.strictObject({
  action: z.literal('submit'),
  selector: z.string().min(1),
  ...commonStepFields,
})

const setHeaderStep = z.strictObject({
  action: z.literal('setHeader'),
  name: z.string().min(1),
  value: z.string(),
  ...commonStepFields,
})

// A reusable-group step: inline another steps flow here (e.g. a shared "login"
// flow run before the rest). It is a pure reference — the control plane expands
// it into the referenced flow's current steps when building a run, so engines
// only ever see a flat step list (see docs/TEST_ENGINES.md, "Composing flows").
const useFlowStep = z.strictObject({
  action: z.literal('useFlow'),
  /** Id of another `steps` flow in the same project to inline at this position. */
  flowId: z.string().min(1).max(64),
  ...commonStepFields,
})

export const stepSchema = z.discriminatedUnion('action', [
  gotoStep,
  clickStep,
  fillStep,
  waitForStep,
  assertStep,
  extractStep,
  submitStep,
  setHeaderStep,
  useFlowStep,
])

export type FlowStep = z.infer<typeof stepSchema>
export type StepAction = FlowStep['action']

export const loadStageSchema = z.strictObject({
  /** k6 duration string, e.g. "30s", "2m". */
  duration: z.string().regex(/^\d+(ms|s|m|h)$/, 'must be a k6 duration like "30s" or "2m"'),
  target: z.number().int().nonnegative(),
})

export const loadProfileSchema = z.strictObject({
  profile: z.enum(['smoke', 'load', 'stress']),
  stages: z.array(loadStageSchema).min(1).optional(),
  /** Map of k6 metric name → threshold expressions, e.g. { "http_req_duration": ["p(95)<800"] }. */
  thresholds: z.record(z.string(), z.array(z.string())).optional(),
})

export type LoadProfile = z.infer<typeof loadProfileSchema>

export const flowDefinitionSchema = z.strictObject({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  engines: z.array(z.enum(ENGINES)).min(1),
  steps: z.array(stepSchema).min(1),
  loadProfile: loadProfileSchema.nullish(),
})

export type FlowDefinition = z.infer<typeof flowDefinitionSchema>

/** The versioned body only (steps + loadProfile) — what a new version stores. */
export const flowBodySchema = z.strictObject({
  steps: z.array(stepSchema).min(1),
  loadProfile: loadProfileSchema.nullish(),
})

export type FlowBody = z.infer<typeof flowBodySchema>

// --- Code flows --------------------------------------------------------------
// A flow is one of two kinds. A `steps` flow is the engine-agnostic JSON above.
// A `code` flow instead points at real Playwright test files in a GitHub repo,
// for journeys too complex to express as steps. Code flows are Playwright-only
// (there is no HTTP compilation), and are run by checking out the repo on the
// compute plane and invoking `playwright test` — see docs/CUSTOM_TESTS.md.

export const FLOW_KINDS = ['steps', 'code'] as const
export type FlowKind = (typeof FLOW_KINDS)[number]

/** owner/repo, matching GitHub's naming (letters, digits, `.`, `_`, `-`). */
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

// The pointer a code flow stores: which repo, which ref, and how to select the
// specs to run. The runner injects the target environment via env vars
// (CHARLIE_BASE_URL, CHARLIE_SECRET_*) — the repo's playwright.config reads them.
export const codeSpecSchema = z.strictObject({
  /** GitHub "owner/repo" holding the Playwright project. */
  repo: z.string().regex(REPO_RE, 'must be "owner/repo"'),
  /** Branch, tag, or commit SHA. Default branch when omitted. */
  ref: z.string().min(1).max(200).optional(),
  /** Path within the repo containing the Playwright project (its package.json). */
  workingDir: z.string().max(400).optional(),
  /** Positional `playwright test` argument — a spec file, directory, or pattern. */
  testFilter: z.string().max(400).optional(),
  /** `playwright test --grep` title filter. */
  grep: z.string().max(400).optional(),
  /** Override the dependency-install command (auto-detected from lockfile otherwise). */
  installCommand: z.string().max(400).optional(),
  /** Override the whole test command (advanced escape hatch). */
  testCommand: z.string().max(400).optional(),
})

export type CodeSpec = z.infer<typeof codeSpecSchema>

// Code flows only ever run under Playwright.
const codeFlowFields = {
  kind: z.literal('code'),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  engines: z.array(z.literal('playwright')).min(1).default(['playwright']),
  code: codeSpecSchema,
}

export const codeFlowDefinitionSchema = z.strictObject(codeFlowFields)
export type CodeFlowDefinition = z.infer<typeof codeFlowDefinitionSchema>

/** The versioned body of a code flow — the code pointer only. */
export const codeFlowBodySchema = z.strictObject({
  kind: z.literal('code'),
  code: codeSpecSchema,
})
export type CodeFlowBody = z.infer<typeof codeFlowBodySchema>

// The create payload for POST /flows accepts either kind. `kind` is the
// discriminant; when absent we default to 'steps' so pre-`kind` clients (and the
// existing API surface) keep working unchanged.
const stepsFlowCreateSchema = flowDefinitionSchema.extend({
  kind: z.literal('steps').default('steps'),
})

export const flowCreateSchema = z.preprocess(
  (v) =>
    v && typeof v === 'object' && !Array.isArray(v) && !('kind' in v)
      ? { ...(v as Record<string, unknown>), kind: 'steps' }
      : v,
  z.discriminatedUnion('kind', [stepsFlowCreateSchema, codeFlowDefinitionSchema]),
)

export type FlowCreate = z.infer<typeof flowCreateSchema>

// The structured-output contract for AI flow generation (docs/AI_FLOWGEN.md).
// A provider must return an array of these; the ingest endpoint validates each
// against this schema and rejects malformed output (never executes blind). The
// draft carries the model's reasoning + the source references it used so a human
// can review before approving into a real flow.
export const sourceRefSchema = z.strictObject({
  /** File the surface/interaction was drawn from, repo-relative. */
  file: z.string().min(1).max(400),
  /** Optional route/URL path the draft exercises. */
  route: z.string().max(400).optional(),
  /** Optional 1-line note on what this reference contributed. */
  note: z.string().max(400).optional(),
})

export const flowDraftSchema = z.strictObject({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  engines: z.array(z.enum(ENGINES)).min(1).default(['playwright']),
  steps: z.array(stepSchema).min(1),
  loadProfile: loadProfileSchema.nullish(),
  /** Why the model drafted this flow (shown in the review UI). */
  reasoning: z.string().max(4000).optional(),
  /** The source files/routes the draft references. */
  sourceRefs: z.array(sourceRefSchema).max(50).optional(),
})

export type SourceRef = z.infer<typeof sourceRefSchema>
export type FlowDraft = z.infer<typeof flowDraftSchema>

/** Validate a provider's raw output as FlowDraft[]. Returns the parsed drafts
 *  or throws a ZodError the caller can surface/retry on. */
export const flowDraftArraySchema = z.array(flowDraftSchema).min(1).max(20)
