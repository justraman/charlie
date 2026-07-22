import { AlertCircleIcon, ArrowLeftIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '@/auth/AuthContext'
import { EnvironmentPanel } from '@/components/EnvironmentPanel'
import { PageHeader } from '@/components/page-header'
import { RunTriggerPanel } from '@/components/RunTriggerPanel'
import { SchedulesPanel } from '@/components/SchedulesPanel'
import { SuggestedFlowsPanel } from '@/components/SuggestedFlowsPanel'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ApiError, api } from '@/lib/api'

interface Project {
  id: string
  name: string
  slug: string
  description: string | null
  sourceRepo: string | null
  slackChannel: string | null
  createdBy: string
}
interface Flow {
  id: string
  name: string
  kind?: 'steps' | 'code'
  engines: string[]
  origin: string
  currentVersion: number | null
}

export function ProjectDetailView() {
  const { id: projectId } = useParams<{ id: string }>()
  const { can, user } = useAuth()
  const navigate = useNavigate()
  const [project, setProject] = useState<Project | null>(null)
  const [flows, setFlows] = useState<Flow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [channel, setChannel] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // A project may be deleted by an admin/owner (projects.delete capability) or
  // by the user who created it. Mirrors the check the Worker enforces.
  const canDelete =
    !!project && (can('projects.delete') || (!!user && user.id === project.createdBy))

  const load = useCallback(async () => {
    if (!projectId) return
    setError(null)
    try {
      const [p, f] = await Promise.all([
        api.get<{ project: Project }>(`/api/projects/${projectId}`),
        api.get<{ flows: Flow[] }>(`/api/projects/${projectId}/flows`),
      ])
      setProject(p.project)
      setChannel(p.project.slackChannel ?? '')
      setFlows(f.flows)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }, [projectId])

  async function saveChannel() {
    if (!projectId) return
    try {
      await api.patch(`/api/projects/${projectId}`, { slackChannel: channel || null })
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  async function deleteProject() {
    if (!projectId) return
    setDeleting(true)
    setError(null)
    try {
      await api.delete(`/api/projects/${projectId}`)
      navigate('/projects')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
      setConfirmDelete(false)
    } finally {
      setDeleting(false)
    }
  }

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {project && (
        <div className="space-y-6">
          <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
            <Link to="/projects">
              <ArrowLeftIcon />
              Projects
            </Link>
          </Button>

          <PageHeader
            title={project.name}
            description={
              <span className="flex flex-wrap items-center gap-x-2">
                <code className="bg-muted rounded px-1.5 py-0.5 text-xs">{project.slug}</code>
                {project.description && <span>— {project.description}</span>}
                {project.sourceRepo && <span>· source: {project.sourceRepo}</span>}
              </span>
            }
          />

          {projectId && <EnvironmentPanel projectId={projectId} />}

          <Card>
            <CardHeader>
              <CardTitle>Flows</CardTitle>
              {can('flows.write') && (
                <CardAction>
                  <Button asChild size="sm">
                    <Link to={`/projects/${projectId}/flows/new`}>
                      <PlusIcon />
                      New flow
                    </Link>
                  </Button>
                </CardAction>
              )}
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Flow</TableHead>
                    <TableHead>Engines</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead>Origin</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {flows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-muted-foreground text-center">
                        No flows yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {flows.map((fl) => (
                    <TableRow key={fl.id}>
                      <TableCell className="font-medium">
                        <span className="flex items-center gap-2">
                          {fl.name}
                          {fl.kind === 'code' && <Badge variant="outline">code</Badge>}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {fl.engines.map((e) => (
                            <Badge key={e} variant="secondary">
                              {e}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">v{fl.currentVersion}</TableCell>
                      <TableCell className="text-muted-foreground">{fl.origin}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button asChild variant="outline" size="sm">
                            <Link to={`/flows/${fl.id}/edit`}>Edit</Link>
                          </Button>
                          <Button asChild variant="outline" size="sm">
                            <Link to={`/flows/${fl.id}/history`}>History</Link>
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <section className="space-y-4">
            <h2 className="text-lg font-semibold">Suggested flows (AI)</h2>
            {projectId && <SuggestedFlowsPanel projectId={projectId} />}
          </section>

          <section className="space-y-4">
            <h2 className="text-lg font-semibold">Schedules</h2>
            {can('flows.write') && (
              <div className="flex flex-wrap items-center gap-2">
                <Label htmlFor="slack-channel" className="text-muted-foreground font-normal">
                  Default Slack channel for scheduled/merge reports:
                </Label>
                <Input
                  id="slack-channel"
                  value={channel}
                  onChange={(e) => setChannel(e.target.value)}
                  placeholder="#qa-runs or channel ID"
                  className="w-auto"
                />
                <Button type="button" variant="outline" onClick={saveChannel}>
                  Save
                </Button>
              </div>
            )}
            {projectId && <SchedulesPanel projectId={projectId} />}
          </section>

          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Runs</h2>
              <Button asChild variant="outline" size="sm">
                <Link to="/runs">All runs</Link>
              </Button>
            </div>
            {can('runs.trigger') ? (
              projectId && <RunTriggerPanel projectId={projectId} />
            ) : (
              <p className="text-muted-foreground text-sm">
                You need editor access to trigger runs.
              </p>
            )}
          </section>

          {canDelete && (
            <Card className="border-destructive/50">
              <CardHeader>
                <CardTitle className="text-destructive">Danger zone</CardTitle>
                <CardAction>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2Icon />
                    Delete project
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground text-sm">
                  Deleting removes this project along with its environments, flows, and schedules
                  from Charlie. This cannot be undone from the dashboard.
                </p>
              </CardContent>
            </Card>
          )}

          <Dialog open={confirmDelete} onOpenChange={(open) => !open && setConfirmDelete(false)}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete project?</DialogTitle>
                <DialogDescription>
                  Delete "{project.name}"? Its environments, flows, and schedules will no longer be
                  accessible. This cannot be undone from the dashboard.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" variant="outline" disabled={deleting}>
                    Cancel
                  </Button>
                </DialogClose>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={deleting}
                  onClick={deleteProject}
                >
                  {deleting ? 'Deleting…' : 'Delete project'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      )}
    </div>
  )
}
