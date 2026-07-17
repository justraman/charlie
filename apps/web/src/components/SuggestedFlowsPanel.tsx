import { AlertCircleIcon, CheckCircle2Icon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '@/auth/AuthContext'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { ApiError, api } from '@/lib/api'

interface SourceRef {
  file: string
  route?: string
}
interface Draft {
  id: string
  name: string
  description: string | null
  engines: string[]
  steps: { action: string }[]
  reasoning: string | null
  sourceRefs: SourceRef[]
  status: string
}

export function SuggestedFlowsPanel({ projectId }: { projectId: string }) {
  const { can } = useAuth()
  const editable = can('flows.write')
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ drafts: Draft[] }>(`/api/projects/${projectId}/flow-drafts`)
      setDrafts(r.drafts)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  async function analyze() {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const r = await api.post<{ dispatch: string }>(`/api/projects/${projectId}/analyze`)
      setNotice(
        r.dispatch === 'queued'
          ? 'Analysis dispatched — drafts will appear here when it finishes.'
          : 'Analysis queued (GitHub App not configured — no dispatch in this environment).',
      )
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function approve(id: string) {
    try {
      await api.post(`/api/flow-drafts/${id}/approve`)
      setNotice('Draft approved — a new flow was created.')
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  async function reject(id: string) {
    try {
      await api.post(`/api/flow-drafts/${id}/reject`)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Suggested flows</CardTitle>
        {editable && (
          <CardAction>
            <Button type="button" size="sm" disabled={busy} onClick={analyze}>
              Analyze source repo
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
        {notice && (
          <Alert className="text-emerald-600 dark:text-emerald-400">
            <CheckCircle2Icon />
            <AlertDescription className="text-emerald-600 dark:text-emerald-400">
              {notice}
            </AlertDescription>
          </Alert>
        )}

        {drafts.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No suggested flows. Point the project at a source repo and run an analysis.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {drafts.map((d) => (
              <Card key={d.id}>
                <CardContent className="space-y-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <strong className="font-semibold">{d.name}</strong>
                    <span className="text-muted-foreground text-sm">
                      {d.engines.join(', ')} · {d.steps.length} steps
                    </span>
                  </div>
                  {d.description && (
                    <p className="text-muted-foreground text-sm">{d.description}</p>
                  )}
                  {d.reasoning && (
                    <p className="border-border text-foreground border-l-2 pl-2.5 text-[13px]">
                      {d.reasoning}
                    </p>
                  )}
                  {d.sourceRefs.length > 0 && (
                    <p className="text-muted-foreground text-sm">
                      Source:{' '}
                      {d.sourceRefs.map((s) => (
                        <Badge
                          key={`${s.file}:${s.route ?? ''}`}
                          variant="outline"
                          className="mr-2 font-mono text-xs font-normal"
                        >
                          {s.file}
                          {s.route ? ` (${s.route})` : ''}
                        </Badge>
                      ))}
                    </p>
                  )}
                  <details>
                    <summary className="text-muted-foreground cursor-pointer text-sm">
                      Steps
                    </summary>
                    <ol className="text-muted-foreground my-1.5 list-decimal pl-5 text-xs">
                      {d.steps.map((s, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: steps are an ordered fixed list
                        <li key={i}>{s.action}</li>
                      ))}
                    </ol>
                  </details>
                  {editable && (
                    <div className="flex gap-2 pt-0.5">
                      <Button type="button" size="sm" onClick={() => approve(d.id)}>
                        Approve → flow
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        onClick={() => reject(d.id)}
                      >
                        Reject
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
