// Shared between Worker (authorization) and SPA (UI gating). The SPA MUST NOT
// treat these as a security boundary — the Worker re-checks every request — but
// they let the UI hide affordances a role cannot use.

export const ROLES = ['viewer', 'editor', 'admin', 'owner'] as const
export type Role = (typeof ROLES)[number]

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}

// Capabilities are the unit of authorization. Routes require a capability;
// roles are granted a set of them. Mirrors the matrix in docs/AUTH.md.
export const CAPABILITIES = [
  'projects.view',
  'runs.trigger',
  // Editor-level content authoring: create/edit projects, environments, flows.
  'flows.write',
  'schedules.manage',
  // Destructive: soft-deleting a project or environment (admin+).
  'projects.delete',
  'secrets.manage',
  'integrations.manage',
  'members.manage',
  'apikeys.manage',
  'org.admin',
] as const
export type Capability = (typeof CAPABILITIES)[number]

// Higher roles inherit everything a lower role can do; the matrix is expressed
// as the incremental grant per level for readability, then flattened.
const VIEWER: Capability[] = ['projects.view']
const EDITOR: Capability[] = [...VIEWER, 'runs.trigger', 'flows.write', 'schedules.manage']
const ADMIN: Capability[] = [
  ...EDITOR,
  'projects.delete',
  'secrets.manage',
  'integrations.manage',
  'members.manage',
  'apikeys.manage',
]
const OWNER: Capability[] = [...ADMIN, 'org.admin']

export const ROLE_CAPABILITIES: Record<Role, ReadonlySet<Capability>> = {
  viewer: new Set(VIEWER),
  editor: new Set(EDITOR),
  admin: new Set(ADMIN),
  owner: new Set(OWNER),
}

export function roleHasCapability(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].has(capability)
}

// Ordering for "at least this role" comparisons (e.g. don't let an admin
// demote an owner). Higher number = more privilege.
export const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3,
}
