// Audit trail. Every mutating request records who did what, with before/after
// snapshots. The audit row is committed in the SAME D1 batch (atomic
// transaction) as the mutation, so an action and its record commit together —
// there is no window where a change is applied but unlogged, or vice versa.

import { uuidv7 } from './ids'

export type ActorKind = 'user' | 'api_key' | 'system'

export interface AuditEntry {
  orgId: string
  actorId: string | null
  actorKind: ActorKind
  action: string // dotted verb: 'member.role_change', 'apikey.create', ...
  entityType: string
  entityId: string | null
  before?: unknown
  after?: unknown
  ip?: string | null
  userAgent?: string | null
}

// Keys whose values must never be persisted in plaintext to the audit log.
// The *fact* of a change is still recorded (the key remains, value redacted).
const SECRET_KEY =
  /secret|password|passwd|token|api[-_]?key|ciphertext|private[-_]?key|authorization|cookie|kek/i

/** Deep-clone `value`, replacing secret-looking fields with a redaction marker. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v)
    }
    return out
  }
  return value
}

function serialize(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return JSON.stringify(redact(value))
}

/** Build the INSERT statement for an audit row (unbound side effects). */
export function auditStatement(db: D1Database, entry: AuditEntry): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_log
        (id, org_id, actor_id, actor_kind, action, entity_type, entity_id,
         before, after, ip, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      uuidv7(),
      entry.orgId,
      entry.actorId,
      entry.actorKind,
      entry.action,
      entry.entityType,
      entry.entityId,
      serialize(entry.before),
      serialize(entry.after),
      entry.ip ?? null,
      entry.userAgent ?? null,
      new Date().toISOString(),
    )
}

/**
 * Commit one or more mutation statements together with their audit record in a
 * single atomic D1 batch. Use this for every mutating endpoint.
 */
export async function writeAudited(
  db: D1Database,
  mutations: D1PreparedStatement[],
  entry: AuditEntry,
): Promise<void> {
  await db.batch([...mutations, auditStatement(db, entry)])
}

/**
 * Write a standalone audit row (no accompanying mutation) — for login,
 * logout, and denied-access events, which the spec audits even though they
 * change no domain entity.
 */
export async function writeAudit(db: D1Database, entry: AuditEntry): Promise<void> {
  await auditStatement(db, entry).run()
}
