import { describe, expect, test } from 'bun:test'
import { ROLE_RANK, roleHasCapability } from '../shared/roles'

describe('role → capability matrix', () => {
  test('viewer can only view', () => {
    expect(roleHasCapability('viewer', 'projects.view')).toBe(true)
    expect(roleHasCapability('viewer', 'runs.trigger')).toBe(false)
    expect(roleHasCapability('viewer', 'flows.write')).toBe(false)
    expect(roleHasCapability('viewer', 'members.manage')).toBe(false)
  })

  test('editor can trigger runs and author flows but not manage secrets/members', () => {
    expect(roleHasCapability('editor', 'runs.trigger')).toBe(true)
    expect(roleHasCapability('editor', 'flows.write')).toBe(true)
    expect(roleHasCapability('editor', 'schedules.manage')).toBe(true)
    expect(roleHasCapability('editor', 'secrets.manage')).toBe(false)
    expect(roleHasCapability('editor', 'members.manage')).toBe(false)
    expect(roleHasCapability('editor', 'apikeys.manage')).toBe(false)
  })

  test('admin can manage secrets, members, integrations, api keys', () => {
    expect(roleHasCapability('admin', 'secrets.manage')).toBe(true)
    expect(roleHasCapability('admin', 'members.manage')).toBe(true)
    expect(roleHasCapability('admin', 'integrations.manage')).toBe(true)
    expect(roleHasCapability('admin', 'apikeys.manage')).toBe(true)
    expect(roleHasCapability('admin', 'org.admin')).toBe(false)
  })

  test('owner has every capability including org.admin', () => {
    expect(roleHasCapability('owner', 'org.admin')).toBe(true)
    expect(roleHasCapability('owner', 'members.manage')).toBe(true)
    expect(roleHasCapability('owner', 'projects.view')).toBe(true)
  })

  test('rank is strictly increasing', () => {
    expect(ROLE_RANK.viewer).toBeLessThan(ROLE_RANK.editor)
    expect(ROLE_RANK.editor).toBeLessThan(ROLE_RANK.admin)
    expect(ROLE_RANK.admin).toBeLessThan(ROLE_RANK.owner)
  })
})
