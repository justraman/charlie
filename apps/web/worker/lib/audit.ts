// Audit trail. Every mutating request records who did what, with before/after
// snapshots. The audit row is committed in the SAME D1 batch (atomic
// transaction) as the mutation, so an action and its record commit together —
// there is no window where a change is applied but unlogged, or vice versa.

import type { BatchItem } from 'drizzle-orm/batch'
import type { Db } from '../db/client'
import { audit_log } from '../db/schema'
import { uuidv7 } from './ids'

/** A Drizzle statement that can ride in a `db.batch([...])`. */
export type Mutation = BatchItem<'sqlite'>

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

/** Build the INSERT statement for an audit row (a batchable Drizzle insert). */
export function auditStatement(db: Db, entry: AuditEntry): Mutation {
  return db.insert(audit_log).values({
    id: uuidv7(),
    org_id: entry.orgId,
    actor_id: entry.actorId,
    actor_kind: entry.actorKind,
    action: entry.action,
    entity_type: entry.entityType,
    entity_id: entry.entityId,
    before: serialize(entry.before),
    after: serialize(entry.after),
    ip: entry.ip ?? null,
    user_agent: entry.userAgent ?? null,
    created_at: new Date().toISOString(),
  })
}

/**
 * Commit one or more mutation statements together with their audit record in a
 * single atomic D1 batch. Use this for every mutating endpoint.
 */
export async function writeAudited(
  db: Db,
  mutations: Mutation[],
  entry: AuditEntry,
): Promise<void> {
  // Audit row first makes the array a statically non-empty tuple (satisfying
  // Drizzle's batch signature without a cast). The whole batch is one atomic
  // D1 transaction, so ordering within it does not affect the guarantee, and
  // audit_log has no FKs into the mutated rows.
  await db.batch([auditStatement(db, entry), ...mutations])
}

/**
 * Write a standalone audit row (no accompanying mutation) — for login,
 * logout, and denied-access events, which the spec audits even though they
 * change no domain entity.
 */
export async function writeAudit(db: Db, entry: AuditEntry): Promise<void> {
  await auditStatement(db, entry)
}
