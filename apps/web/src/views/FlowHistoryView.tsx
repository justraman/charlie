import { AlertCircleIcon, ArrowLeftIcon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { PageHeader } from '@/components/page-header'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ApiError, api } from '@/lib/api'
import { cn } from '@/lib/utils'

interface Version {
  id: string
  version: number
  authorName: string | null
  authorEmail: string | null
  diffSummary: string | null
  createdAt: string
  isCurrent: boolean
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString()
}

export function FlowHistoryView() {
  const { id: flowId } = useParams<{ id: string }>()
  const [flowName, setFlowName] = useState('')
  const [backTo, setBackTo] = useState('/projects')
  const [versions, setVersions] = useState<Version[]>([])
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<{ version: number; steps: unknown } | null>(null)

  const load = useCallback(async () => {
    if (!flowId) return
    try {
      const flow = await api.get<{ flow: { name: string; projectId: string } }>(
        `/api/flows/${flowId}`,
      )
      setFlowName(flow.flow.name)
      setBackTo(`/projects/${flow.flow.projectId}`)
      const res = await api.get<{ versions: Version[] }>(`/api/flows/${flowId}/versions`)
      setVersions(res.versions)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }, [flowId])

  useEffect(() => {
    void load()
  }, [load])

  async function view(v: Version) {
    try {
      const res = await api.get<{ version: { version: number; steps: unknown } }>(
        `/api/flows/${flowId}/versions/${v.version}`,
      )
      setSelected(res.version)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={`History: ${flowName}`}
        description="Version and audit history for this flow."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to={backTo}>
              <ArrowLeftIcon /> Back
            </Link>
          </Button>
        }
      />

      {error && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <Card>
          <CardContent className="space-y-1 p-2">
            {versions.length === 0 ? (
              <p className="text-muted-foreground p-3 text-sm">No versions yet.</p>
            ) : (
              versions.map((v) => (
                <button
                  type="button"
                  key={v.id}
                  onClick={() => view(v)}
                  className={cn(
                    'block w-full rounded-lg border border-transparent px-3 py-2.5 text-left transition-colors',
                    'hover:bg-accent/50',
                    selected?.version === v.version && 'border-ring/60 bg-accent/50',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <strong className="text-sm">v{v.version}</strong>
                    {v.isCurrent && <Badge variant="secondary">current</Badge>}
                    <span className="text-muted-foreground ml-auto text-xs">{fmt(v.createdAt)}</span>
                  </div>
                  <div className="text-muted-foreground mt-0.5 text-sm">
                    {v.authorName || v.authorEmail || 'unknown'}
                  </div>
                  {v.diffSummary && (
                    <div className="text-muted-foreground mt-1 text-xs">{v.diffSummary}</div>
                  )}
                </button>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          {!selected ? (
            <CardContent>
              <p className="text-muted-foreground text-sm">Select a version to view its steps.</p>
            </CardContent>
          ) : (
            <>
              <CardHeader>
                <CardTitle>v{selected.version} steps</CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="bg-muted overflow-x-auto rounded-lg p-3 text-xs whitespace-pre-wrap">
                  {JSON.stringify(selected.steps, null, 2)}
                </pre>
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </div>
  )
}
