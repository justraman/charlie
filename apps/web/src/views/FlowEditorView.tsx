import { AlertCircleIcon, ArrowLeftIcon, CheckIcon, CopyIcon, SparklesIcon } from 'lucide-react'
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
type FlowKind = 'steps' | 'code'

interface CodeFields {
  repo: string
  ref: string
  workingDir: string
  testFilter: string
  grep: string
}

const EMPTY_CODE: CodeFields = { repo: '', ref: '', workingDir: '', testFilter: '', grep: '' }

// Radix Select cannot use an empty-string item value, so "none" is stored as a
// sentinel in the trigger and mapped back to '' for the actual state.
const PROFILE_NONE = '__none__'
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

// Installs the `charlie-playwright` Claude skill into the user's own test repo
// (see skills/charlie-playwright). It teaches Claude Code to write Playwright
// tests wired to Charlie's env contract, then import them here as a code flow.
const SKILL_INSTALL_CMD = 'npx skills add justraman/charlie --skill charlie-playwright'

export function FlowEditorView() {
  const params = useParams<{ projectId?: string; id?: string }>()
  const navigate = useNavigate()
  const projectId = params.projectId
  const flowId = params.id
  const isEdit = !!flowId

  const [kind, setKind] = useState<FlowKind>('steps')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [engines, setEngines] = useState<string[]>(['playwright'])
  const [profile, setProfile] = useState<Profile>('')
  const [steps, setSteps] = useState<EditableStep[]>([makeStep('goto')])
  const [code, setCode] = useState<CodeFields>(EMPTY_CODE)
  const [projectRef, setProjectRef] = useState<string | undefined>(projectId)
  const [flowOptions, setFlowOptions] = useState<{ id: string; name: string }[]>([])
  const [backTo, setBackTo] = useState('/projects')
  const [error, setError] = useState<string | null>(null)
  const [details, setDetails] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  async function copyInstallCmd() {
    try {
      await navigator.clipboard.writeText(SKILL_INSTALL_CMD)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard blocked (e.g. non-secure context) — the command stays
      // visible for a manual copy.
    }
  }

  useEffect(() => {
    if (!isEdit) {
      setBackTo(`/projects/${projectId}`)
      setProjectRef(projectId)
      return
    }
    ;(async () => {
      try {
        const res = await api.get<{
          flow: {
            name: string
            description: string | null
            kind?: FlowKind
            engines: string[]
            projectId: string
          }
          currentVersion: {
            steps: Record<string, unknown>[]
            loadProfile: { profile?: string } | null
            code: CodeFields | null
          } | null
        }>(`/api/flows/${flowId}`)
        setName(res.flow.name)
        setDescription(res.flow.description ?? '')
        setKind(res.flow.kind ?? 'steps')
        setEngines(res.flow.engines)
        setBackTo(`/projects/${res.flow.projectId}`)
        setProjectRef(res.flow.projectId)
        if (res.currentVersion) {
          if (res.flow.kind === 'code' && res.currentVersion.code) {
            const c = res.currentVersion.code
            setCode({
              repo: c.repo ?? '',
              ref: c.ref ?? '',
              workingDir: c.workingDir ?? '',
              testFilter: c.testFilter ?? '',
              grep: c.grep ?? '',
            })
          } else {
            setSteps(res.currentVersion.steps.map(deserializeStep))
            setProfile((res.currentVersion.loadProfile?.profile as Profile) ?? '')
          }
        }
      } catch (err) {
        setError(err instanceof ApiError ? err.message : String(err))
      }
    })()
  }, [isEdit, flowId, projectId])

  // Load the project's other steps flows so a `useFlow` step can pick one.
  useEffect(() => {
    if (!projectRef) return
    ;(async () => {
      try {
        const res = await api.get<{
          flows: { id: string; name: string; kind?: FlowKind }[]
        }>(`/api/projects/${projectRef}/flows`)
        setFlowOptions(
          res.flows
            .filter((f) => (f.kind ?? 'steps') === 'steps' && f.id !== flowId)
            .map((f) => ({ id: f.id, name: f.name })),
        )
      } catch {
        // Non-fatal: the useFlow picker just shows no options.
      }
    })()
  }, [projectRef, flowId])

  function toggleEngine(e: string) {
    setEngines((prev) => (prev.includes(e) ? prev.filter((x) => x !== e) : [...prev, e]))
  }

  // Strip empties so optional fields are omitted rather than sent as "".
  function codePayload() {
    const c: Record<string, string> = { repo: code.repo.trim() }
    if (code.ref.trim()) c.ref = code.ref.trim()
    if (code.workingDir.trim()) c.workingDir = code.workingDir.trim()
    if (code.testFilter.trim()) c.testFilter = code.testFilter.trim()
    if (code.grep.trim()) c.grep = code.grep.trim()
    return c
  }

  async function save() {
    setBusy(true)
    setError(null)
    setDetails(null)
    try {
      if (kind === 'code') {
        if (isEdit) {
          await api.put(`/api/flows/${flowId}`, {
            code: codePayload(),
            description: description.trim() || null,
          })
          navigate(backTo)
        } else {
          await api.post(`/api/projects/${projectId}/flows`, {
            kind: 'code',
            name: name.trim(),
            description: description.trim() || undefined,
            code: codePayload(),
          })
          navigate(`/projects/${projectId}`)
        }
      } else {
        const payloadSteps = steps.map(serializeStep)
        const loadProfile = profile ? { profile } : null
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

  const codeValid = REPO_RE.test(code.repo.trim())
  const canSave =
    !busy &&
    (isEdit || name.trim().length > 0) &&
    (kind === 'code' ? codeValid : engines.length > 0 && steps.length > 0)

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
          isEdit ? 'Saving creates a new version with a diff against the current one.' : undefined
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
          <div className="space-y-2">
            <Label htmlFor="flow-kind">Flow type</Label>
            {isEdit ? (
              <p className="text-muted-foreground text-sm">
                {kind === 'code' ? 'Custom Playwright code' : 'Steps'} (fixed for this flow)
              </p>
            ) : (
              <Select value={kind} onValueChange={(v) => setKind(v as FlowKind)}>
                <SelectTrigger id="flow-kind" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="steps">Steps — build a flow from actions</SelectItem>
                  <SelectItem value="code">
                    Custom Playwright code — run tests from a repo
                  </SelectItem>
                </SelectContent>
              </Select>
            )}
          </div>
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
          {kind === 'steps' && (
            <>
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
            </>
          )}
        </CardContent>
      </Card>

      {kind === 'code' ? (
        <Card>
          <CardHeader>
            <CardTitle>Custom Playwright test</CardTitle>
          </CardHeader>
          <CardContent className="max-w-lg space-y-4">
            <p className="text-muted-foreground text-sm">
              Charlie checks out this repo and runs <code>playwright test</code> against the
              selected environment. Your <code>playwright.config</code> should read{' '}
              <code>process.env.CHARLIE_BASE_URL</code>; secrets arrive as{' '}
              <code>CHARLIE_SECRET_&lt;NAME&gt;</code>. See the example repo in the docs.
            </p>

            <div className="bg-muted/40 space-y-2 rounded-lg border p-3">
              <p className="flex items-center gap-2 text-sm font-medium">
                <SparklesIcon className="size-4" />
                Write these tests with AI
              </p>
              <p className="text-muted-foreground text-sm">
                Add the <code>charlie-playwright</code> skill to Claude Code in your test repo. It
                teaches Claude the env contract, secret handling, and grep tagging so the tests it
                writes run here unchanged.
              </p>
              <div className="flex items-center gap-2">
                <code className="bg-background min-w-0 flex-1 overflow-x-auto rounded-md border px-3 py-2 font-mono text-xs whitespace-nowrap">
                  {SKILL_INSTALL_CMD}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={copyInstallCmd}
                  aria-label="Copy install command"
                >
                  {copied ? <CheckIcon /> : <CopyIcon />}
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="code-repo">Repository (owner/repo)</Label>
              <Input
                id="code-repo"
                value={code.repo}
                onChange={(e) => setCode({ ...code, repo: e.target.value })}
                placeholder="acme/web-e2e-tests"
              />
              {code.repo.trim() && !codeValid && (
                <p className="text-destructive text-xs">Must be in the form "owner/repo".</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="code-ref">Git ref (optional)</Label>
              <Input
                id="code-ref"
                value={code.ref}
                onChange={(e) => setCode({ ...code, ref: e.target.value })}
                placeholder="main (defaults to the repo's default branch)"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="code-dir">Working directory (optional)</Label>
              <Input
                id="code-dir"
                value={code.workingDir}
                onChange={(e) => setCode({ ...code, workingDir: e.target.value })}
                placeholder="packages/e2e (where package.json lives)"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="code-filter">Test filter (optional)</Label>
              <Input
                id="code-filter"
                value={code.testFilter}
                onChange={(e) => setCode({ ...code, testFilter: e.target.value })}
                placeholder="tests/checkout.spec.ts"
              />
              <p className="text-muted-foreground text-xs">
                Passed to <code>playwright test</code> — a spec file, directory, or pattern.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="code-grep">Grep title filter (optional)</Label>
              <Input
                id="code-grep"
                value={code.grep}
                onChange={(e) => setCode({ ...code, grep: e.target.value })}
                placeholder="@smoke"
              />
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Steps</CardTitle>
          </CardHeader>
          <CardContent>
            <StepEditor value={steps} onChange={setSteps} flowOptions={flowOptions} />
          </CardContent>
        </Card>
      )}

      <div>
        <Button type="button" disabled={!canSave} onClick={save}>
          {isEdit ? 'Save new version' : 'Create flow'}
        </Button>
      </div>
    </div>
  )
}
