// Expand `useFlow` steps into a flat step list. A `useFlow` step references
// another `steps` flow in the same project (e.g. a shared "login" flow); at run
// time (and for authoring validation) we inline the referenced flow's *current*
// version steps in place, recursively. Engines only ever see a flat list, so the
// executor / k6 compiler / runner need no knowledge of composition.
//
// The referenced flow's current version (not a pinned snapshot) is used, so
// editing a shared login flow propagates to every flow that includes it.

import type { FlowStep } from '@charlie/flow-core'
import { and, eq, isNull } from 'drizzle-orm'
import type { Db } from '../db/client'
import { flow_versions, flows } from '../db/schema'
import { HttpError } from './http'

// Bounds recursion in case a cycle slips past the visited-set (belt and braces).
const MAX_DEPTH = 15

export interface ExpandOptions {
  /** Flow ids already on the current inclusion path (cycle detection). */
  visited?: Set<string>
  depth?: number
}

/**
 * Return `steps` with every `useFlow` replaced by the referenced flow's expanded
 * steps. References must be `steps` flows in `projectId`. Throws HttpError on a
 * missing/foreign/code reference, a cycle, or excessive nesting.
 */
export async function expandFlowSteps(
  db: Db,
  projectId: string,
  steps: FlowStep[],
  opts: ExpandOptions = {},
): Promise<FlowStep[]> {
  const visited = opts.visited ?? new Set<string>()
  const depth = opts.depth ?? 0
  if (depth > MAX_DEPTH) {
    throw new HttpError('bad_request', 'useFlow nesting is too deep (possible cycle)')
  }

  const out: FlowStep[] = []
  for (const step of steps) {
    if (step.action !== 'useFlow') {
      out.push(step)
      continue
    }
    const refId = step.flowId
    if (visited.has(refId)) {
      throw new HttpError('bad_request', `useFlow cycle detected (flow ${refId} includes itself)`)
    }

    const ref = await db
      .select({
        kind: flows.kind,
        current_version_id: flows.current_version_id,
        steps: flow_versions.steps,
        code_spec: flow_versions.code_spec,
      })
      .from(flows)
      .leftJoin(flow_versions, eq(flow_versions.id, flows.current_version_id))
      .where(and(eq(flows.id, refId), eq(flows.project_id, projectId), isNull(flows.deleted_at)))
      .get()

    if (!ref || !ref.current_version_id) {
      throw new HttpError(
        'bad_request',
        `useFlow references a missing flow (${refId}) in this project`,
      )
    }
    if (ref.kind === 'code') {
      throw new HttpError('bad_request', `useFlow cannot reference a code flow (${refId})`)
    }

    const refSteps = JSON.parse(ref.steps ?? '[]') as FlowStep[]
    const expanded = await expandFlowSteps(db, projectId, refSteps, {
      visited: new Set([...visited, refId]),
      depth: depth + 1,
    })
    out.push(...expanded)
  }
  return out
}
