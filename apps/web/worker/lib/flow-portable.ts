// Import/export of flows as a portable JSON document (docs/FLOW_IMPORT_EXPORT.md).
//
// The document format itself lives in @charlie/flow-core (`portable.ts`) and
// knows nothing about the database. This module is the bridge: it reads a
// project's flows into that format, and turns an uploaded document back into
// concrete flow + flow_version rows.
//
// The interesting part is `useFlow`. In storage a reference is a flow id; in a
// document it is a flow *name*, because ids are meaningless outside the project
// that minted them. Import therefore resolves every name against (a) the flows
// being imported alongside it and (b) the flows already in the target project —
// and refuses the upload if anything is unresolvable, points at a code flow, or
// would close a reference cycle. All of that is checked BEFORE a single row is
// written, so an import either lands whole or not at all.

import {
  type CodeSpec,
  documentSecretRefs,
  FLOW_DOCUMENT_FORMAT,
  type FlowDocument,
  FlowReferenceError,
  type FlowStep,
  fromPortableSteps,
  type LoadProfile,
  orderFlowsForImport,
  type PortableFlow,
  toPortableSteps,
} from '@charlie/flow-core'
import { and, asc, eq, isNull } from 'drizzle-orm'
import type { Db } from '../db/client'
import { flow_versions, flows as flowsTable } from '../db/schema'
import { HttpError } from './http'

/** A project's flow with its current version body, as import/export needs it. */
export interface ProjectFlow {
  id: string
  name: string
  description: string | null
  kind: 'steps' | 'code'
  engines: string[]
  steps: FlowStep[]
  loadProfile: LoadProfile | null
  code: CodeSpec | null
  currentVersionId: string | null
  currentVersion: number | null
}

/** Every live flow in the project, with its current version body. */
export async function loadProjectFlows(db: Db, projectId: string): Promise<ProjectFlow[]> {
  const rows = await db
    .select({
      id: flowsTable.id,
      name: flowsTable.name,
      description: flowsTable.description,
      kind: flowsTable.kind,
      engines: flowsTable.engines,
      current_version_id: flowsTable.current_version_id,
      steps: flow_versions.steps,
      load_profile: flow_versions.load_profile,
      code_spec: flow_versions.code_spec,
      version: flow_versions.version,
    })
    .from(flowsTable)
    .leftJoin(flow_versions, eq(flow_versions.id, flowsTable.current_version_id))
    .where(and(eq(flowsTable.project_id, projectId), isNull(flowsTable.deleted_at)))
    .orderBy(asc(flowsTable.name))

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    kind: r.kind === 'code' ? 'code' : 'steps',
    engines: JSON.parse(r.engines) as string[],
    steps: r.steps ? (JSON.parse(r.steps) as FlowStep[]) : [],
    loadProfile: r.load_profile ? (JSON.parse(r.load_profile) as LoadProfile) : null,
    code: r.code_spec ? (JSON.parse(r.code_spec) as CodeSpec) : null,
    currentVersionId: r.current_version_id,
    currentVersion: r.version,
  }))
}

// --- export ------------------------------------------------------------------

function toPortableFlow(flow: ProjectFlow, nameById: Map<string, string>): PortableFlow {
  const base = {
    name: flow.name,
    ...(flow.description ? { description: flow.description } : {}),
  }
  if (flow.kind === 'code') {
    if (!flow.code) {
      throw new HttpError('bad_request', `Code flow "${flow.name}" has no code spec to export`)
    }
    return { ...base, kind: 'code', engines: ['playwright'], code: flow.code }
  }
  return {
    ...base,
    kind: 'steps',
    engines: flow.engines.filter((e): e is 'playwright' | 'k6' => e === 'playwright' || e === 'k6'),
    steps: toPortableSteps(flow.steps, nameById),
    ...(flow.loadProfile ? { loadProfile: flow.loadProfile } : {}),
  }
}

/**
 * `seed` plus every flow it reaches through `useFlow`, so the document is
 * self-contained and can be imported into an empty project. Returns them in
 * `all` order (alphabetical by name) for a stable, diffable file.
 */
export function withDependencies(seed: ProjectFlow[], all: ProjectFlow[]): ProjectFlow[] {
  const byId = new Map(all.map((f) => [f.id, f]))
  const included = new Set<string>()

  const visit = (flow: ProjectFlow): void => {
    if (included.has(flow.id)) return
    included.add(flow.id)
    for (const step of flow.steps) {
      if (step.action !== 'useFlow') continue
      const target = byId.get(step.flowId)
      if (target) visit(target)
    }
  }
  for (const flow of seed) visit(flow)
  return all.filter((f) => included.has(f.id))
}

export interface DocumentMeta {
  project?: string
  notes?: string
}

/** Build the downloadable document for `flows` (ids resolved to names via `all`). */
export function buildFlowDocument(
  flows: ProjectFlow[],
  all: ProjectFlow[],
  meta: DocumentMeta = {},
): FlowDocument {
  const nameById = new Map(all.map((f) => [f.id, f.name]))
  try {
    return {
      format: FLOW_DOCUMENT_FORMAT,
      exportedAt: new Date().toISOString(),
      ...(meta.project ? { project: meta.project } : {}),
      ...(meta.notes ? { notes: meta.notes } : {}),
      flows: flows.map((f) => toPortableFlow(f, nameById)),
    }
  } catch (err) {
    if (err instanceof FlowReferenceError) throw new HttpError('bad_request', err.message)
    throw err
  }
}

// --- import ------------------------------------------------------------------

export type ImportMode = 'create' | 'upsert'

/** One flow the import will write: a brand-new flow, or a new version of an
 *  existing one. Steps are already resolved to storage form (ids, not names). */
export interface PlannedFlow {
  flowId: string
  name: string
  kind: 'steps' | 'code'
  /** 'create' mints the flow + v1; 'version' appends a version to an existing flow. */
  action: 'create' | 'version'
  engines: string[]
  description: string | null
  steps: FlowStep[]
  loadProfile: LoadProfile | null
  code: CodeSpec | null
  /** Version number this import will write (1 for a new flow). */
  version: number
  /** Previous version body, for the diff summary (null for a new flow). */
  previousSteps: FlowStep[] | null
  previousLoadProfile: LoadProfile | null
  previousCode: CodeSpec | null
}

export interface ImportPlan {
  flows: PlannedFlow[]
  created: number
  updated: number
  /** `{{secrets.NAME}}` references the imported flows expect at run time. */
  secrets: string[]
}

export interface PlanOptions {
  doc: FlowDocument
  existing: ProjectFlow[]
  mode: ImportMode
  /** Id generator for new flows (uuidv7 in the Worker; deterministic in tests). */
  newId: () => string
}

/**
 * Resolve an uploaded document against the target project's flows and produce
 * the exact writes to perform. Throws HttpError (409 on name/kind conflicts,
 * 400 on unresolvable references or cycles) without touching the database.
 */
export function planFlowImport({ doc, existing, mode, newId }: PlanOptions): ImportPlan {
  const existingByName = new Map(existing.map((f) => [f.name, f]))

  if (mode === 'create') {
    const clashes = doc.flows.filter((f) => existingByName.has(f.name)).map((f) => f.name)
    if (clashes.length) {
      throw new HttpError(
        'conflict',
        `${clashes.length} flow(s) already exist in this project: ${clashes.join(', ')}. Rename them in the file, or import with mode "upsert" to add a new version instead.`,
        { conflicts: clashes },
      )
    }
  }

  // Assign every imported flow an id up front (reusing the existing id when
  // upserting) so `useFlow` names can be resolved before anything is written.
  const idByName = new Map(existing.map((f) => [f.name, f.id]))
  for (const flow of doc.flows) {
    if (!idByName.has(flow.name)) idByName.set(flow.name, newId())
  }

  const importedNames = new Set(doc.flows.map((f) => f.name))
  const planned: PlannedFlow[] = []

  for (const flow of orderFlowsForImport(doc)) {
    const prior = existingByName.get(flow.name)
    const flowId = idByName.get(flow.name)!

    if (prior && prior.kind !== flow.kind) {
      throw new HttpError(
        'conflict',
        `Flow "${flow.name}" already exists as a ${prior.kind} flow; the document defines it as ${flow.kind}. A flow's type is fixed at creation.`,
      )
    }

    if (flow.kind === 'code') {
      planned.push({
        flowId,
        name: flow.name,
        kind: 'code',
        action: prior ? 'version' : 'create',
        engines: ['playwright'],
        description: flow.description ?? prior?.description ?? null,
        steps: [],
        loadProfile: null,
        code: flow.code,
        version: (prior?.currentVersion ?? 0) + 1,
        previousSteps: null,
        previousLoadProfile: null,
        previousCode: prior?.code ?? null,
      })
      continue
    }

    // Every useFlow target must resolve, and must be a steps flow.
    for (const step of flow.steps) {
      if (step.action !== 'useFlow') continue
      if (importedNames.has(step.flow)) continue
      const target = existingByName.get(step.flow)
      if (!target) {
        throw new HttpError(
          'bad_request',
          `Flow "${flow.name}" references "${step.flow}" via useFlow, but no such flow is in this document or in the project.`,
        )
      }
      if (target.kind === 'code') {
        throw new HttpError(
          'bad_request',
          `Flow "${flow.name}" references the code flow "${step.flow}" via useFlow, which is not allowed.`,
        )
      }
    }

    let steps: FlowStep[]
    try {
      steps = fromPortableSteps(flow.steps, idByName)
    } catch (err) {
      if (err instanceof FlowReferenceError) throw new HttpError('bad_request', err.message)
      throw err
    }

    planned.push({
      flowId,
      name: flow.name,
      kind: 'steps',
      action: prior ? 'version' : 'create',
      engines: flow.engines,
      description: flow.description ?? prior?.description ?? null,
      steps,
      loadProfile: flow.loadProfile ?? null,
      code: null,
      version: (prior?.currentVersion ?? 0) + 1,
      previousSteps: prior ? prior.steps : null,
      previousLoadProfile: prior?.loadProfile ?? null,
      previousCode: null,
    })
  }

  assertNoReferenceCycle(existing, planned)

  return {
    flows: planned,
    created: planned.filter((f) => f.action === 'create').length,
    updated: planned.filter((f) => f.action === 'version').length,
    secrets: documentSecretRefs(doc),
  }
}

/**
 * Cycle check over the project's reference graph *as it will be after* the
 * import: existing flows, with imported/upserted flows overriding their steps.
 * Upserting a shared flow is the case that matters — a brand-new flow cannot be
 * referenced by an existing one, but a re-versioned one can.
 */
function assertNoReferenceCycle(existing: ProjectFlow[], planned: PlannedFlow[]): void {
  const refs = new Map<string, string[]>()
  const nameById = new Map<string, string>()
  const collect = (steps: FlowStep[]) =>
    steps.filter((s) => s.action === 'useFlow').map((s) => s.flowId)

  for (const flow of existing) {
    refs.set(flow.id, collect(flow.steps))
    nameById.set(flow.id, flow.name)
  }
  for (const flow of planned) {
    refs.set(flow.flowId, collect(flow.steps))
    nameById.set(flow.flowId, flow.name)
  }

  const done = new Set<string>()
  const walk = (id: string, path: string[]): void => {
    const at = path.indexOf(id)
    if (at !== -1) {
      const names = [...path.slice(at), id].map((x) => nameById.get(x) ?? x)
      throw new HttpError(
        'bad_request',
        `Importing this document would create a useFlow cycle: ${names.join(' → ')}`,
      )
    }
    if (done.has(id)) return
    for (const ref of refs.get(id) ?? []) walk(ref, [...path, id])
    done.add(id)
  }
  for (const id of refs.keys()) walk(id, [])
}

/** `checkout` → `checkout.charlie-flows.json`; used for the download filename. */
export function documentFilename(base: string): string {
  const slug =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'flows'
  return `${slug}.charlie-flows.json`
}
