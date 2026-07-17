import { AlertCircleIcon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '@/auth/AuthContext'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiError, api } from '@/lib/api'
import { cn } from '@/lib/utils'

interface Environment {
  id: string
  name: string
  baseUrl: string
  headers: Record<string, string>
  secrets: Record<string, string> // masked
}

interface Draft {
  adds: { k: string; v: string }[]
  removes: string[]
}

function emptyDraft(): Draft {
  return { adds: [], removes: [] }
}

export function EnvironmentPanel({ projectId }: { projectId: string }) {
  const { can } = useAuth()
  const [envs, setEnvs] = useState<Environment[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})

  const fail = useCallback(
    (err: unknown) => setError(err instanceof ApiError ? err.message : String(err)),
    [],
  )
  const draftFor = (id: string) => drafts[id] ?? emptyDraft()

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await api.get<{ environments: Environment[] }>(
        `/api/projects/${projectId}/environments`,
      )
      setEnvs(res.environments)
    } catch (err) {
      fail(err)
    }
  }, [projectId, fail])

  useEffect(() => {
    void load()
  }, [load])

  async function createEnv() {
    setBusy(true)
    setError(null)
    try {
      await api.post(`/api/projects/${projectId}/environments`, {
        name: name.trim(),
        baseUrl: baseUrl.trim(),
      })
      setName('')
      setBaseUrl('')
      setShowForm(false)
      await load()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  function updateDraft(id: string, fn: (d: Draft) => Draft) {
    setDrafts((prev) => ({ ...prev, [id]: fn(prev[id] ?? emptyDraft()) }))
  }

  function toggleRemove(id: string, secretName: string) {
    updateDraft(id, (d) => ({
      ...d,
      removes: d.removes.includes(secretName)
        ? d.removes.filter((n) => n !== secretName)
        : [...d.removes, secretName],
    }))
  }

  function addRow(id: string) {
    updateDraft(id, (d) => ({ ...d, adds: [...d.adds, { k: '', v: '' }] }))
  }

  function editRow(id: string, i: number, field: 'k' | 'v', value: string) {
    updateDraft(id, (d) => ({
      ...d,
      adds: d.adds.map((row, j) => (j === i ? { ...row, [field]: value } : row)),
    }))
  }

  async function saveSecrets(env: Environment) {
    const d = draftFor(env.id)
    const patch: Record<string, string | null> = {}
    for (const secretName of d.removes) patch[secretName] = null
    for (const { k, v } of d.adds) if (k.trim()) patch[k.trim()] = v
    if (Object.keys(patch).length === 0) return
    setBusy(true)
    setError(null)
    try {
      await api.patch(`/api/environments/${env.id}`, { secrets: patch })
      setDrafts((prev) => ({ ...prev, [env.id]: emptyDraft() }))
      await load()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  async function removeEnv(env: Environment) {
    if (!confirm(`Delete environment "${env.name}"?`)) return
    setBusy(true)
    try {
      await api.delete(`/api/environments/${env.id}`)
      await load()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Environments</CardTitle>
        {can('flows.write') && (
          <CardAction>
            <Button
              type="button"
              variant={showForm ? 'outline' : 'default'}
              size="sm"
              onClick={() => setShowForm((v) => !v)}
            >
              {showForm ? 'Cancel' : 'Add environment'}
            </Button>
          </CardAction>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {showForm && (
          <div className="max-w-md space-y-4 rounded-lg border p-4">
            <div className="space-y-2">
              <Label htmlFor="env-name">Name</Label>
              <Input
                id="env-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="qa"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="env-base-url">Base URL</Label>
              <Input
                id="env-base-url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://qa.example.com"
              />
            </div>
            <Button type="button" disabled={busy || !name || !baseUrl} onClick={createEnv}>
              Create
            </Button>
          </div>
        )}

        {envs.length === 0 && (
          <p className="text-muted-foreground text-sm">No environments yet.</p>
        )}

        {envs.map((env) => {
          const d = draftFor(env.id)
          return (
            <div key={env.id} className="space-y-3 rounded-lg border p-4">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm">
                  <strong className="font-medium">{env.name}</strong>
                  <span className="text-muted-foreground"> — {env.baseUrl}</span>
                </div>
                {can('projects.delete') && (
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={busy}
                    onClick={() => removeEnv(env)}
                  >
                    Delete
                  </Button>
                )}
              </div>

              <div className="space-y-2 border-t pt-3">
                <div className="text-muted-foreground text-xs uppercase tracking-wide">
                  Secrets
                </div>
                {Object.keys(env.secrets).length === 0 && d.adds.length === 0 && (
                  <div className="text-muted-foreground text-sm">None set.</div>
                )}
                <ul className="space-y-1">
                  {Object.entries(env.secrets).map(([secretName, mask]) => (
                    <li key={secretName} className="flex items-center gap-2">
                      <code
                        className={cn(
                          'text-sm',
                          d.removes.includes(secretName) && 'line-through opacity-50',
                        )}
                      >
                        {secretName}
                      </code>
                      <span className="text-muted-foreground text-sm">{mask}</span>
                      {can('secrets.manage') && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          className="text-destructive"
                          onClick={() => toggleRemove(env.id, secretName)}
                        >
                          {d.removes.includes(secretName) ? 'undo' : 'remove'}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>

                {can('secrets.manage') ? (
                  <>
                    {d.adds.map((row, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and transient
                      <div key={i} className="flex gap-2">
                        <Input
                          value={row.k}
                          onChange={(e) => editRow(env.id, i, 'k', e.target.value)}
                          placeholder="SECRET_NAME"
                        />
                        <Input
                          value={row.v}
                          onChange={(e) => editRow(env.id, i, 'v', e.target.value)}
                          placeholder="value (write-only)"
                          type="password"
                        />
                      </div>
                    ))}
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => addRow(env.id)}
                      >
                        + Add secret
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        disabled={busy}
                        onClick={() => saveSecrets(env)}
                      >
                        Save secrets
                      </Button>
                    </div>
                  </>
                ) : (
                  <p className="text-muted-foreground text-xs">
                    Secret values are managed by admins.
                  </p>
                )}
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
