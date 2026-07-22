import {
  AlertCircleIcon,
  ArrowRightIcon,
  FolderKanbanIcon,
  PlayCircleIcon,
  UsersIcon,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/auth/AuthContext'
import { PageHeader } from '@/components/page-header'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ApiError, api } from '@/lib/api'
import { statusBadge } from '@/lib/run-status'

interface Run {
  id: string
  projectName: string
  engine: string
  status: string
  trigger: string
  flowSelection: { name: string }[]
  queuedAt: string
}

const RECENT_LIMIT = 5

export function DashboardView() {
  const { user, can } = useAuth()
  const [runs, setRuns] = useState<Run[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const cards = [
    {
      to: '/projects',
      icon: FolderKanbanIcon,
      title: 'Projects',
      description: 'Browse and author projects, environments, and flows.',
      show: can('projects.view'),
    },
    {
      to: '/runs',
      icon: PlayCircleIcon,
      title: 'Runs',
      description: 'Inspect run history, reports, and live progress.',
      show: can('projects.view'),
    },
    {
      to: '/members',
      icon: UsersIcon,
      title: 'Members',
      description: 'Manage who can access this instance and their roles.',
      show: can('members.manage'),
    },
  ].filter((c) => c.show)

  const loadRuns = useCallback(async () => {
    setError(null)
    try {
      // `triggeredBy=me` scopes the list to runs this user kicked off.
      const res = await api.get<{ runs: Run[] }>(
        `/api/runs?triggeredBy=me&sort=queuedAt&dir=desc&limit=${RECENT_LIMIT}`,
      )
      setRuns(res.runs)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
      setRuns([])
    }
  }, [])

  useEffect(() => {
    void loadRuns()
  }, [loadRuns])

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Welcome${user?.name ? `, ${user.name}` : ''}`}
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            Signed in as <strong className="text-foreground">{user?.email}</strong>
            <Badge variant={user?.role === 'owner' ? 'default' : 'secondary'}>{user?.role}</Badge>
          </span>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c) => (
          <Card key={c.to} className="transition-colors hover:border-ring/60">
            <CardHeader>
              <c.icon className="text-muted-foreground size-5" />
              <CardTitle className="mt-2">{c.title}</CardTitle>
              <CardDescription>{c.description}</CardDescription>
            </CardHeader>
            <CardFooter>
              <Button asChild variant="ghost" size="sm" className="px-0 hover:bg-transparent">
                <Link to={c.to}>
                  Open <ArrowRightIcon />
                </Link>
              </Button>
            </CardFooter>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Your recent runs</CardTitle>
          <CardDescription>The latest runs you triggered.</CardDescription>
          <CardAction>
            <Button asChild variant="outline" size="sm">
              <Link to="/runs">
                All runs <ArrowRightIcon />
              </Link>
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {error && (
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {runs === null && !error ? (
            <div className="space-y-2">
              {['a', 'b', 'c'].map((k) => (
                <Skeleton key={k} className="h-10 w-full" />
              ))}
            </div>
          ) : runs && runs.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Run</TableHead>
                  <TableHead>Project</TableHead>
                  <TableHead>Flows</TableHead>
                  <TableHead>Engine</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Queued</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Link to={`/runs/${r.id}`} className="font-mono text-xs hover:underline">
                        {r.id.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell className="font-medium">{r.projectName}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {r.flowSelection.map((f) => f.name).join(', ') || '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{r.engine}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge className={statusBadge(r.status)}>{r.status}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(r.queuedAt).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            !error && (
              <p className="text-muted-foreground text-sm">
                {can('runs.trigger')
                  ? "You haven't triggered any runs yet. Open a project to start one."
                  : "You haven't triggered any runs yet."}
              </p>
            )
          )}
        </CardContent>
      </Card>
    </div>
  )
}
