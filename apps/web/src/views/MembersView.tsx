import { ROLES, type Role } from '@shared/roles'
import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '@/auth/AuthContext'
import { ApiError, api } from '@/lib/api'
import styles from './MembersView.module.css'

interface Member {
  id: string
  email: string
  name: string | null
  avatarUrl: string | null
  role: Role
  lastLoginAt: string | null
  createdAt: string
  active: boolean
}

interface ApiKey {
  id: string
  name: string
  scopes: string[]
  expiresAt: string | null
  lastUsedAt: string | null
  revokedAt: string | null
  createdAt: string
  keyPrefix: string
}

const ALL_SCOPES = ['runs:write', 'runs:read', 'reports:read', 'flows:read']

function fmtDate(iso: string | null) {
  return iso ? new Date(iso).toLocaleString() : '—'
}

export function MembersView() {
  const { user } = useAuth()
  const [members, setMembers] = useState<Member[]>([])
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [showKeyForm, setShowKeyForm] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [newKeyScopes, setNewKeyScopes] = useState<string[]>(['runs:read'])
  const [createdToken, setCreatedToken] = useState<string | null>(null)

  const fail = useCallback(
    (err: unknown) => setError(err instanceof ApiError ? err.message : String(err)),
    [],
  )

  const load = useCallback(async () => {
    setError(null)
    try {
      const [m, k] = await Promise.all([
        api.get<{ members: Member[] }>('/api/members'),
        api.get<{ apiKeys: ApiKey[] }>('/api/api-keys'),
      ])
      setMembers(m.members)
      setApiKeys(k.apiKeys)
    } catch (err) {
      fail(err)
    }
  }, [fail])

  useEffect(() => {
    void load()
  }, [load])

  async function changeRole(member: Member, role: Role) {
    if (role === member.role) return
    setBusy(true)
    setError(null)
    try {
      await api.patch(`/api/members/${member.id}`, { role })
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
      await load()
    }
  }

  async function deactivate(member: Member) {
    if (!confirm(`Deactivate ${member.email}? Their sessions will be revoked.`)) return
    setBusy(true)
    setError(null)
    try {
      await api.delete(`/api/members/${member.id}`)
      await load()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  function toggleScope(scope: string) {
    setNewKeyScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    )
  }

  async function createKey() {
    setBusy(true)
    setError(null)
    setCreatedToken(null)
    try {
      const res = await api.post<{ token: string }>('/api/api-keys', {
        name: newKeyName.trim(),
        scopes: newKeyScopes,
      })
      setCreatedToken(res.token)
      setNewKeyName('')
      setNewKeyScopes(['runs:read'])
      setShowKeyForm(false)
      await load()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  async function revokeKey(key: ApiKey) {
    if (!confirm(`Revoke API key "${key.name}"? This cannot be undone.`)) return
    setBusy(true)
    try {
      await api.delete(`/api/api-keys/${key.id}`)
      await load()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="container">
      <h1>Members</h1>
      {error && <p className="error">{error}</p>}

      <div className={`card ${styles.card}`}>
        <table>
          <thead>
            <tr>
              <th>Member</th>
              <th>Role</th>
              <th>Last login</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id}>
                <td>
                  <div className={styles.member}>
                    <strong>{m.name || m.email}</strong>
                    <span className="muted">{m.email}</span>
                  </div>
                </td>
                <td>
                  <select
                    value={m.role}
                    disabled={busy || m.id === user?.id}
                    onChange={(e) => changeRole(m, e.target.value as Role)}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="muted">{fmtDate(m.lastLoginAt)}</td>
                <td>
                  <span className={`badge ${m.active ? 'owner' : ''}`}>
                    {m.active ? 'active' : 'inactive'}
                  </span>
                </td>
                <td className={styles.right}>
                  {m.active && m.id !== user?.id && m.role !== 'owner' && (
                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={busy}
                      onClick={() => deactivate(m)}
                    >
                      Deactivate
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className={styles.sectionHead}>
        <h2>API keys</h2>
        <button type="button" className="btn" onClick={() => setShowKeyForm((v) => !v)}>
          {showKeyForm ? 'Cancel' : 'New key'}
        </button>
      </div>

      {createdToken && (
        <div className={`card ${styles.tokenReveal}`}>
          <p>
            <strong>Copy this key now — it will not be shown again:</strong>
          </p>
          <code className={styles.token}>{createdToken}</code>
          <button type="button" className="btn" onClick={() => setCreatedToken(null)}>
            Dismiss
          </button>
        </div>
      )}

      {showKeyForm && (
        <div className="card">
          <label className={styles.field}>
            Name
            <input
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              placeholder="CI pipeline"
            />
          </label>
          <div className={styles.field}>
            Scopes
            <div className={styles.scopes}>
              {ALL_SCOPES.map((s) => (
                <label key={s} className={styles.scope}>
                  <input
                    type="checkbox"
                    checked={newKeyScopes.includes(s)}
                    onChange={() => toggleScope(s)}
                  />
                  {s}
                </label>
              ))}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !newKeyName.trim() || newKeyScopes.length === 0}
            onClick={createKey}
          >
            Create key
          </button>
        </div>
      )}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Scopes</th>
              <th>Last used</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {apiKeys.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No API keys yet.
                </td>
              </tr>
            )}
            {apiKeys.map((k) => (
              <tr key={k.id}>
                <td>
                  <strong>{k.name}</strong>
                  <div className="muted">{k.keyPrefix}</div>
                </td>
                <td>
                  {k.scopes.map((s) => (
                    <span key={s} className={`badge ${styles.scopeBadge}`}>
                      {s}
                    </span>
                  ))}
                </td>
                <td className="muted">{fmtDate(k.lastUsedAt)}</td>
                <td>
                  <span className={`badge ${k.revokedAt ? '' : 'owner'}`}>
                    {k.revokedAt ? 'revoked' : 'active'}
                  </span>
                </td>
                <td className={styles.right}>
                  {!k.revokedAt && (
                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={busy}
                      onClick={() => revokeKey(k)}
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
