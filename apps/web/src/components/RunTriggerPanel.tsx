import { AlertCircleIcon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
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

export function RunTriggerPanel({ projectId }: { projectId: string }) {
  const navigate = useNavigate()
  const [envs, setEnvs] = useState<Env[]>([])
  const [flows, setFlows] = useState<Flow[]>([])
  const [environmentId, setEnvironmentId] = useState('')
  const [engine, setEngine] = useState<'playwright' | 'k6'>('playwright')
  const [selectedFlows, setSelectedFlows] = useState<string[]>([])
  const [profile, setProfile] = useState<'smoke' | 'load' | 'stress'>('smoke')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [e, f] = await Promise.all([
        api.get<{ environments: Env[] }>(`/api/projects/${projectId}/environments`),
        api.get<{ flows: Flow[] }>(`/api/projects/${projectId}/flows`),
      ])
      setEnvs(e.environments)
      setFlows(f.flows)
      if (e.environments[0]) setEnvironmentId(e.environments[0].id)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  const eligibleFlows = flows.filter((f) => f.engines.includes(engine))

  function toggleFlow(name: string) {
    setSelectedFlows((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    )
  }

  async function trigger() {
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<{ runId: string }>('/api/runs', {
        project: projectId,
        environment: environmentId,
        engine,
        // Omit `flows` to mean "all" eligible flows.
        flows: selectedFlows.length > 0 ? selectedFlows : undefined,
        profile,
      })
      navigate(`/runs/${res.runId}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="max-w-md">
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="space-y-2">
          <Label htmlFor="run-environment">Environment</Label>
          <Select value={environmentId} onValueChange={setEnvironmentId}>
            <SelectTrigger id="run-environment" className="w-full">
              <SelectValue placeholder="no environments" />
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
          <Label htmlFor="run-engine">Engine</Label>
          <Select
            value={engine}
            onValueChange={(v) => setEngine(v as 'playwright' | 'k6')}
          >
            <SelectTrigger id="run-engine" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="playwright">playwright (E2E)</SelectItem>
              <SelectItem value="k6">k6 (load)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <span className="text-sm font-medium leading-none">
            Flows (none selected = all eligible)
          </span>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {eligibleFlows.length === 0 && (
              <span className="text-muted-foreground text-sm">No flows support {engine}.</span>
            )}
            {eligibleFlows.map((f) => (
              <div key={f.id} className="flex items-center gap-2">
                <Switch
                  id={`run-flow-${f.id}`}
                  checked={selectedFlows.includes(f.name)}
                  onCheckedChange={() => toggleFlow(f.name)}
                />
                <Label htmlFor={`run-flow-${f.id}`} className="font-normal">
                  {f.name}
                </Label>
              </div>
            ))}
          </div>
        </div>

        {engine === 'k6' && (
          <div className="space-y-2">
            <Label htmlFor="run-profile">Profile</Label>
            <Select
              value={profile}
              onValueChange={(v) => setProfile(v as typeof profile)}
            >
              <SelectTrigger id="run-profile" className="w-full">
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

        <Button
          type="button"
          disabled={busy || !environmentId || eligibleFlows.length === 0}
          onClick={trigger}
        >
          Trigger run
        </Button>
      </CardContent>
    </Card>
  )
}
