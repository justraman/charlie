// AI flow-draft review. Drafts are NOT runnable: they live only in flow_drafts
// until an editor approves one, which mints a real flow + flow_version v1. The
// approved version is human-authored (the AI is credited in origin/diff_summary
// but a person owns it), and the approval is audited — the human gate the docs
// require before a draft can ever run or be scheduled.

import { type FlowBody, summarizeFlowDiff } from '@charlie/flow-core'
import { Hono } from 'hono'
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

const DRAFT_COLS =
  'id, org_id, project_id, analysis_id, name, description, engines, steps, load_profile, reasoning, source_refs, status, origin, approved_flow_id, created_at'

async function loadDraft(db: D1Database, orgId: string, id: string): Promise<DraftRow> {
  const row = await db
    .prepare(`SELECT ${DRAFT_COLS} FROM flow_drafts WHERE id = ? AND org_id = ?`)
    .bind(id, orgId)
    .first<DraftRow>()
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
    const rows = await c.env.DB.prepare(
      `SELECT ${DRAFT_COLS} FROM flow_drafts
         WHERE project_id = ? AND org_id = ? AND status = ? ORDER BY created_at DESC`,
    )
      .bind(projectId, orgId, status)
      .all<DraftRow>()
    return c.json({ drafts: rows.results.map(draftDto) })
  },
)

// --- POST /api/flow-drafts/:id/approve (editor) — draft → flow + v1 ----------
flowDrafts.post(
  '/flow-drafts/:id/approve',
  authenticate,
  authorize({ capability: 'flows.write' }),
  async (c) => {
    const actor = c.get('auth')
    const draft = await loadDraft(c.env.DB, actor.orgId, c.req.param('id'))
    if (draft.status !== 'draft') {
      throw new HttpError('conflict', `Draft is already ${draft.status}`)
    }

    const clash = await c.env.DB.prepare(
      `SELECT 1 FROM flows WHERE project_id = ? AND name = ? AND deleted_at IS NULL`,
    )
      .bind(draft.project_id, draft.name)
      .first()
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
      c.env.DB,
      [
        // origin = 'ai' credits the model; the version author is the approver.
        c.env.DB.prepare(
          `INSERT INTO flows
             (id, project_id, name, description, current_version_id, engines, origin,
              created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, ?, 'ai', ?, ?, ?)`,
        ).bind(
          flowId,
          draft.project_id,
          draft.name,
          draft.description,
          draft.engines,
          actor.actorId,
          now,
          now,
        ),
        c.env.DB.prepare(
          `INSERT INTO flow_versions
             (id, flow_id, version, steps, load_profile, author_id, diff_summary, created_at)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
        ).bind(versionId, flowId, draft.steps, draft.load_profile, actor.actorId, diff, now),
        c.env.DB.prepare(`UPDATE flows SET current_version_id = ? WHERE id = ?`).bind(
          versionId,
          flowId,
        ),
        c.env.DB.prepare(
          `UPDATE flow_drafts SET status = 'approved', approved_flow_id = ?, updated_at = ? WHERE id = ?`,
        ).bind(flowId, now, draft.id),
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
    const draft = await loadDraft(c.env.DB, actor.orgId, c.req.param('id'))
    if (draft.status !== 'draft')
      throw new HttpError('conflict', `Draft is already ${draft.status}`)
    const now = new Date().toISOString()
    await writeAudited(
      c.env.DB,
      [
        c.env.DB.prepare(
          `UPDATE flow_drafts SET status = 'rejected', updated_at = ? WHERE id = ?`,
        ).bind(now, draft.id),
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
