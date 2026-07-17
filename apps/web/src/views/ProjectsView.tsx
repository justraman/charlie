import { AlertCircleIcon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/auth/AuthContext'
import { PageHeader } from '@/components/page-header'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
}

export function ProjectsView() {
  const { can } = useAuth()
  const [projects, setProjects] = useState<Project[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [sourceRepo, setSourceRepo] = useState('')

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await api.get<{ projects: Project[] }>('/api/projects')
      setProjects(res.projects)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function create() {
    setBusy(true)
    setError(null)
    try {
      await api.post('/api/projects', {
        name: name.trim(),
        description: description.trim() || undefined,
        sourceRepo: sourceRepo.trim() || undefined,
      })
      setName('')
      setDescription('')
      setSourceRepo('')
      setShowForm(false)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Projects"
        description="Browse and author projects, environments, and flows."
        actions={
          can('flows.write') && (
            <Button
              type="button"
              variant={showForm ? 'outline' : 'default'}
              onClick={() => setShowForm((v) => !v)}
            >
              {showForm ? 'Cancel' : 'New project'}
            </Button>
          )
        }
      />

      {error && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {showForm && (
        <Card className="max-w-lg">
          <CardHeader>
            <CardTitle>New project</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="project-name">Name</Label>
              <Input
                id="project-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Storefront"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="project-description">Description</Label>
              <Input
                id="project-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="project-source-repo">Source repo (optional)</Label>
              <Input
                id="project-source-repo"
                value={sourceRepo}
                onChange={(e) => setSourceRepo(e.target.value)}
                placeholder="acme/storefront"
              />
            </div>
            <Button type="button" disabled={busy || !name.trim()} onClick={create}>
              Create
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Project</TableHead>
              <TableHead>Slug</TableHead>
              <TableHead>Source repo</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {projects.length === 0 && (
              <TableRow>
                <TableCell colSpan={3} className="text-muted-foreground text-center">
                  No projects yet.
                </TableCell>
              </TableRow>
            )}
            {projects.map((p) => (
              <TableRow key={p.id}>
                <TableCell>
                  <Link to={`/projects/${p.id}`} className="font-medium hover:underline">
                    {p.name}
                  </Link>
                  {p.description && (
                    <div className="text-muted-foreground text-sm">{p.description}</div>
                  )}
                </TableCell>
                <TableCell>
                  <code className="bg-muted rounded px-1.5 py-0.5 text-xs">{p.slug}</code>
                </TableCell>
                <TableCell className="text-muted-foreground">{p.sourceRepo || '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
