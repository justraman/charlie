import { AlertCircleIcon, RefreshCwIcon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { PageHeader } from '@/components/page-header'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ApiError, api } from '@/lib/api'

interface Run {
  id: string
  engine: string
  profile: string
  status: string
  trigger: string
  flowSelection: { name: string }[]
  queuedAt: string
  expectedShards: number
}

/** Semantic color classes for a run/shard status badge. */
function statusBadge(status: string): string {
  switch (status) {
    case 'passed':
      return 'border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
    case 'failed':
    case 'errored':
      return 'border-transparent bg-red-500/15 text-red-600 dark:text-red-400'
    case 'running':
      return 'border-transparent bg-blue-500/15 text-blue-600 dark:text-blue-400'
    case 'queued':
    case 'pending':
      return 'border-transparent bg-secondary text-secondary-foreground'
    default:
      return 'border-border bg-transparent text-muted-foreground'
  }
}

export function RunsView() {
  const [runs, setRuns] = useState<Run[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ runs: Run[] }>('/api/runs')
      setRuns(res.runs)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-6">
      <PageHeader
        title="Runs"
        description="Inspect run history, reports, and live progress."
        actions={
          <Button type="button" variant="outline" onClick={load}>
            <RefreshCwIcon />
            Refresh
          </Button>
        }
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
              <TableHead>Run</TableHead>
              <TableHead>Engine</TableHead>
              <TableHead>Flows</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Trigger</TableHead>
              <TableHead>Queued</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground text-center">
                  No runs yet.
                </TableCell>
              </TableRow>
            )}
            {runs.map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  <Link to={`/runs/${r.id}`} className="font-mono text-xs hover:underline">
                    {r.id.slice(0, 8)}
                  </Link>
                </TableCell>
                <TableCell>
                  <Badge variant="secondary">{r.engine}</Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {r.flowSelection.map((f) => f.name).join(', ') || '—'}
                </TableCell>
                <TableCell>
                  <Badge className={statusBadge(r.status)}>{r.status}</Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">{r.trigger}</TableCell>
                <TableCell className="text-muted-foreground">
                  {new Date(r.queuedAt).toLocaleString()}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
