import { AlertCircleIcon, ArrowLeftIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { PageHeader } from '@/components/page-header'
import { StepEditor } from '@/components/StepEditor'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { ApiError, api } from '@/lib/api'
import { deserializeStep, type EditableStep, makeStep, serializeStep } from '@/lib/steps'

type Profile = '' | 'smoke' | 'load' | 'stress'

// Radix Select cannot use an empty-string item value, so "none" is stored as a
// sentinel in the trigger and mapped back to '' for the actual state.
const PROFILE_NONE = '__none__'

export function FlowEditorView() {
  const params = useParams<{ projectId?: string; id?: string }>()
  const navigate = useNavigate()
  const projectId = params.projectId
  const flowId = params.id
  const isEdit = !!flowId

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [engines, setEngines] = useState<string[]>(['playwright'])
  const [profile, setProfile] = useState<Profile>('')
  const [steps, setSteps] = useState<EditableStep[]>([makeStep('goto')])
  const [backTo, setBackTo] = useState('/projects')
  const [error, setError] = useState<string | null>(null)
  const [details, setDetails] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!isEdit) {
      setBackTo(`/projects/${projectId}`)
      return
    }
    ;(async () => {
      try {
        const res = await api.get<{
          flow: { name: string; description: string | null; engines: string[]; projectId: string }
          currentVersion: {
            steps: Record<string, unknown>[]
            loadProfile: { profile?: string } | null
          } | null
        }>(`/api/flows/${flowId}`)
        setName(res.flow.name)
        setDescription(res.flow.description ?? '')
        setEngines(res.flow.engines)
        setBackTo(`/projects/${res.flow.projectId}`)
        if (res.currentVersion) {
          setSteps(res.currentVersion.steps.map(deserializeStep))
          setProfile((res.currentVersion.loadProfile?.profile as Profile) ?? '')
        }
      } catch (err) {
        setError(err instanceof ApiError ? err.message : String(err))
      }
    })()
  }, [isEdit, flowId, projectId])

  function toggleEngine(e: string) {
    setEngines((prev) => (prev.includes(e) ? prev.filter((x) => x !== e) : [...prev, e]))
  }

  async function save() {
    setBusy(true)
    setError(null)
    setDetails(null)
    const payloadSteps = steps.map(serializeStep)
    const loadProfile = profile ? { profile } : null
    try {
      if (isEdit) {
        await api.put(`/api/flows/${flowId}`, {
          steps: payloadSteps,
          description: description.trim() || null,
          engines,
          loadProfile,
        })
        navigate(backTo)
      } else {
        await api.post(`/api/projects/${projectId}/flows`, {
          name: name.trim(),
          description: description.trim() || undefined,
          engines,
          steps: payloadSteps,
          loadProfile,
        })
        navigate(`/projects/${projectId}`)
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message)
        setDetails(err.details)
      } else {
        setError(String(err))
      }
    } finally {
      setBusy(false)
    }
  }

  const canSave =
    !busy && engines.length > 0 && steps.length > 0 && (isEdit || name.trim().length > 0)

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
        <Link to={backTo}>
          <ArrowLeftIcon /> Back
        </Link>
      </Button>

      <PageHeader
        title={isEdit ? `Edit flow: ${name}` : 'New flow'}
        description={
          isEdit
            ? 'Saving creates a new version with a diff against the current one.'
            : undefined
        }
      />

      {error && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {details != null && (
        <pre className="bg-muted text-muted-foreground w-full overflow-x-auto rounded-lg p-3 text-xs whitespace-pre-wrap">
          {JSON.stringify(details, null, 2)}
        </pre>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Flow details</CardTitle>
        </CardHeader>
        <CardContent className="max-w-lg space-y-4">
          {!isEdit && (
            <div className="space-y-2">
              <Label htmlFor="flow-name">Name</Label>
              <Input
                id="flow-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="checkout"
              />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="flow-description">Description</Label>
            <Input
              id="flow-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Engines</Label>
            <div className="flex flex-wrap gap-6 pt-1">
              <div className="flex items-center gap-2">
                <Switch
                  id="engine-playwright"
                  checked={engines.includes('playwright')}
                  onCheckedChange={() => toggleEngine('playwright')}
                />
                <Label htmlFor="engine-playwright" className="font-normal">
                  playwright
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="engine-k6"
                  checked={engines.includes('k6')}
                  onCheckedChange={() => toggleEngine('k6')}
                />
                <Label htmlFor="engine-k6" className="font-normal">
                  k6
                </Label>
              </div>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="flow-profile">Load profile (k6)</Label>
            <Select
              value={profile || PROFILE_NONE}
              onValueChange={(v) => setProfile((v === PROFILE_NONE ? '' : v) as Profile)}
            >
              <SelectTrigger id="flow-profile" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={PROFILE_NONE}>none</SelectItem>
                <SelectItem value="smoke">smoke</SelectItem>
                <SelectItem value="load">load</SelectItem>
                <SelectItem value="stress">stress</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Steps</CardTitle>
        </CardHeader>
        <CardContent>
          <StepEditor value={steps} onChange={setSteps} />
        </CardContent>
      </Card>

      <div>
        <Button type="button" disabled={!canSave} onClick={save}>
          {isEdit ? 'Save new version' : 'Create flow'}
        </Button>
      </div>
    </div>
  )
}
