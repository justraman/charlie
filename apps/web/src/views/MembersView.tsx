import { ROLES, type Role } from '@shared/roles'
import { AlertCircleIcon, KeyIcon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '@/auth/AuthContext'
import { PageHeader } from '@/components/page-header'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ApiError, api } from '@/lib/api'

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

function initials(member: Member) {
  return (member.name || member.email || '?').slice(0, 1).toUpperCase()
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

  const [deactivateTarget, setDeactivateTarget] = useState<Member | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null)

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
    setBusy(true)
    setError(null)
    try {
      await api.delete(`/api/members/${member.id}`)
      await load()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
      setDeactivateTarget(null)
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
    setBusy(true)
    try {
      await api.delete(`/api/api-keys/${key.id}`)
      await load()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
      setRevokeTarget(null)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Members"
        description="Manage who can access this instance, their roles, and API keys."
      />

      {error && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Last login</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground py-8 text-center">
                  No members yet.
                </TableCell>
              </TableRow>
            )}
            {members.map((m) => (
              <TableRow key={m.id}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <Avatar>
                      {m.avatarUrl && <AvatarImage src={m.avatarUrl} alt="" />}
                      <AvatarFallback>{initials(m)}</AvatarFallback>
                    </Avatar>
                    <div className="flex flex-col leading-tight">
                      <span className="font-medium">{m.name || m.email}</span>
                      <span className="text-muted-foreground text-xs">{m.email}</span>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <Select
                    value={m.role}
                    disabled={busy || m.id === user?.id}
                    onValueChange={(value) => changeRole(m, value as Role)}
                  >
                    <SelectTrigger size="sm" className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ROLES.map((r) => (
                        <SelectItem key={r} value={r}>
                          {r}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell className="text-muted-foreground">{fmtDate(m.lastLoginAt)}</TableCell>
                <TableCell>
                  {m.active ? (
                    <Badge className="border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                      active
                    </Badge>
                  ) : (
                    <Badge variant="outline">inactive</Badge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {m.active && m.id !== user?.id && m.role !== 'owner' && (
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      disabled={busy}
                      onClick={() => setDeactivateTarget(m)}
                    >
                      Deactivate
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>API keys</CardTitle>
          <CardDescription>
            Programmatic access tokens for CI and automation.
          </CardDescription>
          <CardAction>
            <Button type="button" variant="outline" onClick={() => setShowKeyForm((v) => !v)}>
              {showKeyForm ? 'Cancel' : 'New key'}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          {createdToken && (
            <div className="border-primary/50 bg-primary/5 space-y-3 rounded-lg border p-4">
              <p className="text-sm font-medium">
                Copy this key now — it will not be shown again:
              </p>
              <code className="bg-muted block rounded-md px-3 py-2 font-mono text-sm break-all">
                {createdToken}
              </code>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setCreatedToken(null)}
              >
                Dismiss
              </Button>
            </div>
          )}

          {showKeyForm && (
            <div className="bg-muted/30 space-y-4 rounded-lg border p-4">
              <div className="max-w-sm space-y-2">
                <Label htmlFor="new-key-name">Name</Label>
                <Input
                  id="new-key-name"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  placeholder="CI pipeline"
                />
              </div>
              <div className="space-y-2">
                <Label>Scopes</Label>
                <div className="flex flex-wrap gap-2">
                  {ALL_SCOPES.map((s) => {
                    const selected = newKeyScopes.includes(s)
                    return (
                      <Button
                        key={s}
                        type="button"
                        variant={selected ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => toggleScope(s)}
                      >
                        {s}
                      </Button>
                    )
                  })}
                </div>
              </div>
              <Button
                type="button"
                disabled={busy || !newKeyName.trim() || newKeyScopes.length === 0}
                onClick={createKey}
              >
                Create key
              </Button>
            </div>
          )}

          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Scopes</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {apiKeys.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="text-muted-foreground py-8 text-center"
                    >
                      No API keys yet.
                    </TableCell>
                  </TableRow>
                )}
                {apiKeys.map((k) => (
                  <TableRow key={k.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <KeyIcon className="text-muted-foreground size-4" />
                        <div className="flex flex-col leading-tight">
                          <span className="font-medium">{k.name}</span>
                          <span className="text-muted-foreground font-mono text-xs">
                            {k.keyPrefix}
                          </span>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {k.scopes.map((s) => (
                          <Badge key={s} variant="secondary">
                            {s}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {fmtDate(k.lastUsedAt)}
                    </TableCell>
                    <TableCell>
                      {k.revokedAt ? (
                        <Badge className="border-transparent bg-red-500/15 text-red-600 dark:text-red-400">
                          revoked
                        </Badge>
                      ) : (
                        <Badge className="border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                          active
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {!k.revokedAt && (
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          disabled={busy}
                          onClick={() => setRevokeTarget(k)}
                        >
                          Revoke
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={deactivateTarget !== null}
        onOpenChange={(open) => !open && setDeactivateTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deactivate member?</DialogTitle>
            <DialogDescription>
              Deactivate {deactivateTarget?.email}? Their sessions will be revoked.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => deactivateTarget && deactivate(deactivateTarget)}
            >
              Deactivate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={revokeTarget !== null}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke API key?</DialogTitle>
            <DialogDescription>
              Revoke API key "{revokeTarget?.name}"? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => revokeTarget && revokeKey(revokeTarget)}
            >
              Revoke
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
