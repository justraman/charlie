// AI flow-draft review. Drafts are NOT runnable: they live only in flow_drafts
// until an editor approves one, which mints a real flow + flow_version v1. The
// approved version is human-authored (the AI is credited in origin/diff_summary
// but a person owns it), and the approval is audited — the human gate the docs
// require before a draft can ever run or be scheduled.

import { type FlowBody, summarizeFlowDiff } from '@charlie/flow-core'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { createDb, type Db } from '../db/client'
import { flow_drafts, flow_versions, flows } from '../db/schema'
import type { AppBindings } from '../env'
import { writeAudited } from '../lib/audit'
import { clientIp, HttpError, userAgent } from '../lib/http'
import { uuidv7 } from '../lib/ids'
import { authenticate, authorize } from '../middleware/auth'

const flowDrafts = new Hono<AppBindings>()

interface DraftRow {
  id: string
  org_id: string
  project_id: string
  analysis_id: string | null
  name: string
  description: string | null
  engines: string
  steps: string
  load_profile: string | null
  reasoning: string | null
  source_refs: string | null
  status: string
  origin: string
  approved_flow_id: string | null
  created_at: string
}

function draftDto(row: DraftRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    analysisId: row.analysis_id,
    name: row.name,
    description: row.description,
    engines: JSON.parse(row.engines) as string[],
    steps: JSON.parse(row.steps),
    loadProfile: row.load_profile ? JSON.parse(row.load_profile) : null,
    reasoning: row.reasoning,
    sourceRefs: row.source_refs ? JSON.parse(row.source_refs) : [],
    status: row.status,
    origin: row.origin,
    approvedFlowId: row.approved_flow_id,
    createdAt: row.created_at,
  }
}

const DRAFT_COLS = {
  id: flow_drafts.id,
  org_id: flow_drafts.org_id,
  project_id: flow_drafts.project_id,
  analysis_id: flow_drafts.analysis_id,
  name: flow_drafts.name,
  description: flow_drafts.description,
  engines: flow_drafts.engines,
  steps: flow_drafts.steps,
  load_profile: flow_drafts.load_profile,
  reasoning: flow_drafts.reasoning,
  source_refs: flow_drafts.source_refs,
  status: flow_drafts.status,
  origin: flow_drafts.origin,
  approved_flow_id: flow_drafts.approved_flow_id,
  created_at: flow_drafts.created_at,
}

async function loadDraft(db: Db, orgId: string, id: string): Promise<DraftRow> {
  const row = await db
    .select(DRAFT_COLS)
    .from(flow_drafts)
    .where(and(eq(flow_drafts.id, id), eq(flow_drafts.org_id, orgId)))
    .get()
  if (!row) throw new HttpError('not_found', 'Draft not found')
  return row
}

// --- GET /api/projects/:projectId/flow-drafts (viewer) ----------------------
flowDrafts.get(
  '/projects/:projectId/flow-drafts',
  authenticate,
  authorize({ capability: 'projects.view' }),
  async (c) => {
    const { orgId } = c.get('auth')
    const projectId = c.req.param('projectId')
    const status = c.req.query('status') ?? 'draft'
    const db = createDb(c.env.DB)
    const rows = await db
      .select(DRAFT_COLS)
      .from(flow_drafts)
      .where(
        and(
          eq(flow_drafts.project_id, projectId),
          eq(flow_drafts.org_id, orgId),
          eq(flow_drafts.status, status),
        ),
      )
      .orderBy(desc(flow_drafts.created_at))
    return c.json({ drafts: rows.map(draftDto) })
  },
)

// --- POST /api/flow-drafts/:id/approve (editor) — draft → flow + v1 ----------
flowDrafts.post(
  '/flow-drafts/:id/approve',
  authenticate,
  authorize({ capability: 'flows.write' }),
  async (c) => {
    const actor = c.get('auth')
    const db = createDb(c.env.DB)
    const draft = await loadDraft(db, actor.orgId, c.req.param('id'))
    if (draft.status !== 'draft') {
      throw new HttpError('conflict', `Draft is already ${draft.status}`)
    }

    const clash = await db
      .select({ id: flows.id })
      .from(flows)
      .where(
        and(
          eq(flows.project_id, draft.project_id),
          eq(flows.name, draft.name),
          isNull(flows.deleted_at),
        ),
      )
      .limit(1)
      .get()
    if (clash) {
      throw new HttpError(
        'conflict',
        `A flow named "${draft.name}" already exists — rename it first`,
      )
    }

    const flowId = uuidv7()
    const versionId = uuidv7()
    const now = new Date().toISOString()
    const steps = JSON.parse(draft.steps)
    const loadProfile = draft.load_profile ? JSON.parse(draft.load_profile) : null
    const body: FlowBody = { steps, loadProfile }
    const diff = `${summarizeFlowDiff(null, body)} (approved from AI draft)`

    await writeAudited(
      db,
      [
        // origin = 'ai' credits the model; the version author is the approver.
        db.insert(flows).values({
          id: flowId,
          project_id: draft.project_id,
          name: draft.name,
          description: draft.description,
          current_version_id: null,
          engines: draft.engines,
          origin: 'ai',
          created_by: actor.actorId,
          created_at: now,
          updated_at: now,
        }),
        db.insert(flow_versions).values({
          id: versionId,
          flow_id: flowId,
          version: 1,
          steps: draft.steps,
          load_profile: draft.load_profile,
          author_id: actor.actorId,
          diff_summary: diff,
          created_at: now,
        }),
        db.update(flows).set({ current_version_id: versionId }).where(eq(flows.id, flowId)),
        db
          .update(flow_drafts)
          .set({ status: 'approved', approved_flow_id: flowId, updated_at: now })
          .where(eq(flow_drafts.id, draft.id)),
      ],
      {
        orgId: actor.orgId,
        actorId: actor.actorId,
        actorKind: actor.actorKind,
        action: 'flow.approve_draft',
        entityType: 'flow',
        entityId: flowId,
        after: {
          name: draft.name,
          origin: 'ai',
          fromDraft: draft.id,
          analysisId: draft.analysis_id,
          version: 1,
        },
        ip: clientIp(c),
        userAgent: userAgent(c),
      },
    )

    return c.json({ flowId, draftId: draft.id, status: 'approved' }, 201)
  },
)

// --- POST /api/flow-drafts/:id/reject (editor) ------------------------------
flowDrafts.post(
  '/flow-drafts/:id/reject',
  authenticate,
  authorize({ capability: 'flows.write' }),
  async (c) => {
    const actor = c.get('auth')
    const db = createDb(c.env.DB)
    const draft = await loadDraft(db, actor.orgId, c.req.param('id'))
    if (draft.status !== 'draft')
      throw new HttpError('conflict', `Draft is already ${draft.status}`)
    const now = new Date().toISOString()
    await writeAudited(
      db,
      [
        db
          .update(flow_drafts)
          .set({ status: 'rejected', updated_at: now })
          .where(eq(flow_drafts.id, draft.id)),
      ],
      {
        orgId: actor.orgId,
        actorId: actor.actorId,
        actorKind: actor.actorKind,
        action: 'flow.reject_draft',
        entityType: 'flow_draft',
        entityId: draft.id,
        before: { name: draft.name },
        after: { status: 'rejected' },
        ip: clientIp(c),
        userAgent: userAgent(c),
      },
    )
    return c.json({ ok: true })
  },
)

export default flowDrafts
