import {
  AlertCircleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  RefreshCwIcon,
  SearchIcon,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { PageHeader } from '@/components/page-header'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
import { cn } from '@/lib/utils'

interface Run {
  id: string
  projectId: string
  projectName: string
  engine: string
  profile: string
  status: string
  trigger: string
  flowSelection: { name: string }[]
  queuedAt: string
  expectedShards: number
}

interface Project {
  id: string
  name: string
}

const ALL = '__all__'
const PAGE_SIZE = 25

// Fixed enums from the runs schema — the filter options don't depend on which
// page is currently loaded.
const STATUSES = ['queued', 'running', 'passed', 'failed', 'cancelled']
const ENGINES = ['playwright', 'k6']

type SortKey = 'id' | 'engine' | 'status' | 'trigger' | 'queuedAt'
type SortDir = 'asc' | 'desc'

export function RunsView() {
  const [runs, setRuns] = useState<Run[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [projectFilter, setProjectFilter] = useState<string>(ALL)
  const [statusFilter, setStatusFilter] = useState<string>(ALL)
  const [engineFilter, setEngineFilter] = useState<string>(ALL)
  const [sortKey, setSortKey] = useState<SortKey>('queuedAt')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [page, setPage] = useState(0)

  // Project list for the filter dropdown — loaded once, independent of paging.
  useEffect(() => {
    api
      .get<{ projects: Project[] }>('/api/projects')
      .then((res) => setProjects(res.projects))
      .catch(() => {})
  }, [])

  // Debounce typing so we fire one request when the user pauses, not per key.
  // Reset to the first page whenever the query text settles.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search.trim())
      setPage(0)
    }, 300)
    return () => clearTimeout(t)
  }, [search])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        sort: sortKey,
        dir: sortDir,
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      })
      if (debouncedSearch) params.set('search', debouncedSearch)
      if (projectFilter !== ALL) params.set('project', projectFilter)
      if (statusFilter !== ALL) params.set('status', statusFilter)
      if (engineFilter !== ALL) params.set('engine', engineFilter)
      const res = await api.get<{ runs: Run[]; total: number }>(`/api/runs?${params}`)
      setRuns(res.runs)
      setTotal(res.total)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [debouncedSearch, projectFilter, statusFilter, engineFilter, sortKey, sortDir, page])

  useEffect(() => {
    void load()
  }, [load])

  const changeProject = (value: string) => {
    setProjectFilter(value)
    setPage(0)
  }
  const changeStatus = (value: string) => {
    setStatusFilter(value)
    setPage(0)
  }
  const changeEngine = (value: string) => {
    setEngineFilter(value)
    setPage(0)
  }

  const toggleSort = (key: SortKey) => {
    setPage(0)
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      // New column: dates default to newest-first, everything else A→Z.
      setSortDir(key === 'queuedAt' ? 'desc' : 'asc')
    }
  }

  const clearFilters = () => {
    setSearch('')
    setProjectFilter(ALL)
    setStatusFilter(ALL)
    setEngineFilter(ALL)
    setPage(0)
  }

  const filtersActive =
    search.trim() !== '' || projectFilter !== ALL || statusFilter !== ALL || engineFilter !== ALL
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1
  const to = Math.min(total, (page + 1) * PAGE_SIZE)
  const hasPrev = page > 0
  const hasNext = to < total

  return (
    <div className="space-y-6">
      <PageHeader
        title="Runs"
        description="Inspect run history, reports, and live progress."
        actions={
          <Button type="button" variant="outline" onClick={load} disabled={loading}>
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

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative sm:max-w-xs">
          <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search id, flow, or trigger"
            className="pl-9"
          />
        </div>
        <Select value={projectFilter} onValueChange={changeProject}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder="Project" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All projects</SelectItem>
            {projects.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={changeStatus}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={engineFilter} onValueChange={changeEngine}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Engine" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All engines</SelectItem>
            {ENGINES.map((e) => (
              <SelectItem key={e} value={e}>
                {e}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {filtersActive && (
          <Button type="button" variant="ghost" onClick={clearFilters}>
            Clear
          </Button>
        )}
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <SortHeader
                label="Run"
                sortKey="id"
                active={sortKey}
                dir={sortDir}
                onSort={toggleSort}
              />
              <TableHead>Project</TableHead>
              <SortHeader
                label="Engine"
                sortKey="engine"
                active={sortKey}
                dir={sortDir}
                onSort={toggleSort}
              />
              <TableHead>Flows</TableHead>
              <SortHeader
                label="Status"
                sortKey="status"
                active={sortKey}
                dir={sortDir}
                onSort={toggleSort}
              />
              <SortHeader
                label="Trigger"
                sortKey="trigger"
                active={sortKey}
                dir={sortDir}
                onSort={toggleSort}
              />
              <SortHeader
                label="Queued"
                sortKey="queuedAt"
                active={sortKey}
                dir={sortDir}
                onSort={toggleSort}
              />
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground text-center">
                  {filtersActive ? 'No runs match your filters.' : 'No runs yet.'}
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
                <TableCell className="font-medium">{r.projectName}</TableCell>
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

      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          {total === 0 ? 'No results' : `${from}–${to} of ${total}`}
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!hasPrev || loading}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            <ChevronLeftIcon />
            Previous
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!hasNext || loading}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
            <ChevronRightIcon />
          </Button>
        </div>
      </div>
    </div>
  )
}

/** A table header whose label toggles sorting on the given key. */
function SortHeader({
  label,
  sortKey,
  active,
  dir,
  onSort,
}: {
  label: string
  sortKey: SortKey
  active: SortKey
  dir: SortDir
  onSort: (key: SortKey) => void
}) {
  const isActive = active === sortKey
  const Icon = !isActive ? ChevronsUpDownIcon : dir === 'asc' ? ArrowUpIcon : ArrowDownIcon
  return (
    <TableHead>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          '-ml-2 inline-flex items-center gap-1 rounded-md px-2 py-1 hover:text-foreground',
          isActive ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        {label}
        <Icon className="size-3.5" />
      </button>
    </TableHead>
  )
}
