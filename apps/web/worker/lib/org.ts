// Single-org helpers. v1 is self-host / one organization; the row is created
// lazily on the first successful login from the bootstrap env vars.

import type { Db } from '../db/client'
import { organization } from '../db/schema'
import { uuidv7 } from './ids'

export interface Organization {
  id: string
  name: string
  allowedEmailDomains: string[]
}

function parseDomains(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map((d) => String(d).toLowerCase()) : []
  } catch {
    return []
  }
}

export async function getOrganization(db: Db): Promise<Organization | null> {
  const row = await db
    .select({
      id: organization.id,
      name: organization.name,
      allowed_email_domains: organization.allowed_email_domains,
    })
    .from(organization)
    .limit(1)
    .get()
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
  db: Db,
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
  await db.insert(organization).values({
    id,
    name: bootstrap.name,
    allowed_email_domains: JSON.stringify(domains),
    settings: '{}',
    created_at: now,
    updated_at: now,
  })

  return { id, name: bootstrap.name, allowedEmailDomains: domains }
}
