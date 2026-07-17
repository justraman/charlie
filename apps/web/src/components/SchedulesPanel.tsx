import { AlertCircleIcon } from 'lucide-react'
import { Fragment, useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/auth/AuthContext'
import { Alert, AlertDescription } from '@/components/ui/alert'
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
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ApiError, api } from '@/lib/api'

interface Env {
  id: string
  name: string
}
interface Flow {
  id: string
  name: string
  engines: string[]
}
interface Schedule {
  id: string
  environmentId: string
  flowSelection: string[]
  engine: 'playwright' | 'k6'
  profile: 'smoke' | 'load' | 'stress'
  triggerType: 'cron' | 'on_merge'
  cronExpr: string | null
  watchBranch: string | null
  enabled: boolean
  lastFiredAt: string | null
  nextDueAt: string | null
}
interface ScheduleRun {
  id: string
  status: string
  trigger: string
  engine: string
  commitSha: string | null
  queuedAt: string
}

// Named cron presets; "custom" reveals a free-text field.
const CRON_PRESETS: { label: string; expr: string }[] = [
  { label: 'Every 15 minutes', expr: '*/15 * * * *' },
  { label: 'Hourly', expr: '@hourly' },
  { label: 'Every 6 hours', expr: '0 */6 * * *' },
  { label: 'Daily (00:00 UTC)', expr: '@daily' },
  { label: 'Weekly (Mon 00:00 UTC)', expr: '0 0 * * 1' },
]

function fmt(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}

export function SchedulesPanel({ projectId }: { projectId: string }) {
  const { can } = useAuth()
  const editable = can('schedules.manage')
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [envs, setEnvs] = useState<Env[]>([])
  const [flows, setFlows] = useState<Flow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [history, setHistory] = useState<Record<string, ScheduleRun[]>>({})

  const load = useCallback(async () => {
    try {
      const [s, e, f] = await Promise.all([
        api.get<{ schedules: Schedule[] }>(`/api/schedules?project=${projectId}`),
        api.get<{ environments: Env[] }>(`/api/projects/${projectId}/environments`),
        api.get<{ flows: Flow[] }>(`/api/projects/${projectId}/flows`),
      ])
      setSchedules(s.schedules)
      setEnvs(e.environments)
      setFlows(f.flows)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  const envName = (id: string) => envs.find((e) => e.id === id)?.name ?? id.slice(0, 8)

  async function toggle(s: Schedule) {
    try {
      await api.patch(`/api/schedules/${s.id}`, { enabled: !s.enabled })
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  async function remove(s: Schedule) {
    if (!confirm('Delete this schedule?')) return
    try {
      await api.delete(`/api/schedules/${s.id}`)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  async function loadHistory(id: string) {
    if (history[id]) {
      setHistory((h) => {
        const { [id]: _drop, ...rest } = h
        return rest
      })
      return
    }
    try {
      const r = await api.get<{ runs: ScheduleRun[] }>(`/api/schedules/${id}/runs`)
      setHistory((h) => ({ ...h, [id]: r.runs }))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Schedules</CardTitle>
        <CardDescription>Cron and on-merge test triggers for this project.</CardDescription>
        {editable && (
          <CardAction>
            <Dialog open={showForm} onOpenChange={setShowForm}>
              <DialogTrigger asChild>
                <Button size="sm">New schedule</Button>
              </DialogTrigger>
              <DialogContent className="max-h-[85vh] overflow-y-auto">
                <ScheduleForm
                  projectId={projectId}
                  envs={envs}
                  flows={flows}
                  onDone={async () => {
                    setShowForm(false)
                    await load()
                  }}
                  onCancel={() => setShowForm(false)}
                />
              </DialogContent>
            </Dialog>
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

        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Trigger</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Next / watch</TableHead>
                <TableHead>Last fired</TableHead>
                <TableHead>Enabled</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {schedules.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground text-center">
                    No schedules yet.
                  </TableCell>
                </TableRow>
              )}
              {schedules.map((s) => (
                <Fragment key={s.id}>
                  <TableRow>
                    <TableCell>
                      <strong>{s.triggerType === 'cron' ? 'cron' : 'on merge'}</strong>
                      {s.triggerType === 'cron' && (
                        <div className="mt-0.5">
                          <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">
                            {s.cronExpr}
                          </code>
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {envName(s.environmentId)} · {s.engine}
                      {s.engine === 'k6' ? ` (${s.profile})` : ''}
                      <div className="mt-0.5 text-xs">{s.flowSelection.join(', ')}</div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {s.triggerType === 'cron' ? fmt(s.nextDueAt) : `branch: ${s.watchBranch}`}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{fmt(s.lastFiredAt)}</TableCell>
                    <TableCell>
                      {editable ? (
                        <Switch
                          checked={s.enabled}
                          onCheckedChange={() => toggle(s)}
                          aria-label={s.enabled ? 'Disable schedule' : 'Enable schedule'}
                        />
                      ) : (
                        <Badge
                          variant={s.enabled ? 'default' : 'outline'}
                          className={
                            s.enabled
                              ? 'border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                              : 'text-muted-foreground'
                          }
                        >
                          {s.enabled ? 'on' : 'off'}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => loadHistory(s.id)}
                        >
                          History
                        </Button>
                        {editable && (
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            onClick={() => remove(s)}
                          >
                            Delete
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                  {history[s.id] && (
                    <TableRow>
                      <TableCell colSpan={6}>
                        {history[s.id]!.length === 0 ? (
                          <span className="text-muted-foreground">No runs yet.</span>
                        ) : (
                          <ul className="flex flex-col gap-1 py-1 pl-4 text-xs">
                            {history[s.id]!.map((r) => (
                              <li key={r.id}>
                                <Link to={`/runs/${r.id}`} className="font-mono">
                                  {r.id.slice(0, 8)}
                                </Link>{' '}
                                <span className="text-muted-foreground">
                                  {r.status} · {r.trigger}
                                  {r.commitSha ? ` · ${r.commitSha.slice(0, 7)}` : ''} ·{' '}
                                  {fmt(r.queuedAt)}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}

function ScheduleForm({
  projectId,
  envs,
  flows,
  onDone,
  onCancel,
}: {
  projectId: string
  envs: Env[]
  flows: Flow[]
  onDone: () => void
  onCancel: () => void
}) {
  const [triggerType, setTriggerType] = useState<'cron' | 'on_merge'>('cron')
  const [environmentId, setEnvironmentId] = useState(envs[0]?.id ?? '')
  const [engine, setEngine] = useState<'playwright' | 'k6'>('playwright')
  const [selectedFlows, setSelectedFlows] = useState<string[]>([])
  const [profile, setProfile] = useState<'smoke' | 'load' | 'stress'>('smoke')
  const [preset, setPreset] = useState(CRON_PRESETS[0]!.expr)
  const [customCron, setCustomCron] = useState('')
  const [watchBranch, setWatchBranch] = useState('main')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const eligibleFlows = flows.filter((f) => f.engines.includes(engine))
  const cronExpr = preset === 'custom' ? customCron : preset

  function toggleFlow(name: string) {
    setSelectedFlows((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    )
  }

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      await api.post('/api/schedules', {
        projectId,
        environmentId,
        engine,
        profile,
        // Empty selection means "all eligible flows".
        flowSelection: selectedFlows.length > 0 ? selectedFlows : ['all'],
        triggerType,
        cronExpr: triggerType === 'cron' ? cronExpr : undefined,
        watchBranch: triggerType === 'on_merge' ? watchBranch : undefined,
        enabled: true,
      })
      onDone()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>New schedule</DialogTitle>
        <DialogDescription>
          Configure a cron interval or on-merge trigger for this project.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="space-y-2">
          <Label htmlFor="sched-trigger">Trigger</Label>
          <Select
            value={triggerType}
            onValueChange={(v) => setTriggerType(v as 'cron' | 'on_merge')}
          >
            <SelectTrigger id="sched-trigger" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="cron">Cron interval</SelectItem>
              <SelectItem value="on_merge">On merge to branch</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {triggerType === 'cron' ? (
          <div className="space-y-2">
            <Label htmlFor="sched-schedule">Schedule</Label>
            <Select value={preset} onValueChange={setPreset}>
              <SelectTrigger id="sched-schedule" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CRON_PRESETS.map((p) => (
                  <SelectItem key={p.expr} value={p.expr}>
                    {p.label}
                  </SelectItem>
                ))}
                <SelectItem value="custom">Custom…</SelectItem>
              </SelectContent>
            </Select>
            {preset === 'custom' && (
              <Input
                type="text"
                placeholder="minute hour day-of-month month day-of-week"
                value={customCron}
                onChange={(e) => setCustomCron(e.target.value)}
              />
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="sched-branch">Watch branch (on the project's source repo)</Label>
            <Input
              id="sched-branch"
              type="text"
              value={watchBranch}
              onChange={(e) => setWatchBranch(e.target.value)}
            />
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="sched-env">Environment</Label>
          <Select value={environmentId} onValueChange={setEnvironmentId}>
            <SelectTrigger id="sched-env" className="w-full">
              <SelectValue placeholder="No environments" />
            </SelectTrigger>
            <SelectContent>
              {envs.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="sched-engine">Engine</Label>
          <Select
            value={engine}
            onValueChange={(v) => setEngine(v as 'playwright' | 'k6')}
          >
            <SelectTrigger id="sched-engine" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="playwright">playwright (E2E)</SelectItem>
              <SelectItem value="k6">k6 (load)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>Flows (none selected = all eligible)</Label>
          <div className="flex flex-wrap gap-2">
            {eligibleFlows.length === 0 && (
              <span className="text-muted-foreground text-sm">No flows support {engine}.</span>
            )}
            {eligibleFlows.map((f) => (
              <Button
                key={f.id}
                type="button"
                size="sm"
                variant={selectedFlows.includes(f.name) ? 'default' : 'outline'}
                onClick={() => toggleFlow(f.name)}
              >
                {f.name}
              </Button>
            ))}
          </div>
        </div>

        {engine === 'k6' && (
          <div className="space-y-2">
            <Label htmlFor="sched-profile">Profile</Label>
            <Select value={profile} onValueChange={(v) => setProfile(v as typeof profile)}>
              <SelectTrigger id="sched-profile" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="smoke">smoke</SelectItem>
                <SelectItem value="load">load</SelectItem>
                <SelectItem value="stress">stress</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={busy || !environmentId || eligibleFlows.length === 0}
          onClick={submit}
        >
          Create schedule
        </Button>
      </DialogFooter>
    </>
  )
}
