// Single-org helpers. v1 is self-host / one organization; the row is created
// lazily on the first successful login from the bootstrap env vars.

import { uuidv7 } from './ids'

export interface Organization {
  id: string
  name: string
  allowedEmailDomains: string[]
}

interface OrgRow {
  id: string
  name: string
  allowed_email_domains: string
}

function parseDomains(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map((d) => String(d).toLowerCase()) : []
  } catch {
    return []
  }
}

export async function getOrganization(db: D1Database): Promise<Organization | null> {
  const row = await db
    .prepare(`SELECT id, name, allowed_email_domains FROM organization LIMIT 1`)
    .first<OrgRow>()
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    allowedEmailDomains: parseDomains(row.allowed_email_domains),
  }
}

/**
 * Return the org, creating it from bootstrap config if it does not exist yet.
 * `domainsCsv` is the comma-separated ALLOWED_EMAIL_DOMAINS var.
 */
export async function ensureOrganization(
  db: D1Database,
  bootstrap: { name: string; domainsCsv: string },
): Promise<Organization> {
  const existing = await getOrganization(db)
  if (existing) return existing

  const domains = bootstrap.domainsCsv
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)

  const id = uuidv7()
  const now = new Date().toISOString()
  await db
    .prepare(
      `INSERT INTO organization (id, name, allowed_email_domains, settings, created_at, updated_at)
       VALUES (?, ?, ?, '{}', ?, ?)`,
    )
    .bind(id, bootstrap.name, JSON.stringify(domains), now, now)
    .run()

  return { id, name: bootstrap.name, allowedEmailDomains: domains }
}
