// Upload a flow document (docs/FLOW_IMPORT_EXPORT.md) into a project.
//
// The dialog always dry-runs the upload first: the Worker validates the file
// against the target project and returns the exact plan (what is created, what
// gets a new version, which environment secrets the flows expect) without
// writing anything. The user confirms that plan before it lands, so an import
// is never a surprise.

import { AlertCircleIcon, CheckCircle2Icon, UploadIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
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

type Mode = 'create' | 'upsert'

interface PlannedFlow {
  id: string
  name: string
  kind: 'steps' | 'code'
  action: 'create' | 'version'
  version: number
  engines: string[]
  steps: number | null
}
interface Plan {
  created: number
  updated: number
  secrets: string[]
  flows: PlannedFlow[]
}

export function FlowImportDialog({
  projectId,
  onImported,
}: {
  projectId: string
  onImported: () => void
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [fileName, setFileName] = useState<string | null>(null)
  const [document, setDocument] = useState<unknown>(null)
  const [mode, setMode] = useState<Mode>('create')
  const [plan, setPlan] = useState<Plan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [details, setDetails] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  function reset() {
    setFileName(null)
    setDocument(null)
    setPlan(null)
    setError(null)
    setDetails(null)
    if (fileInput.current) fileInput.current.value = ''
  }

  function fail(err: unknown) {
    setPlan(null)
    if (err instanceof ApiError) {
      setError(err.message)
      setDetails(err.details ?? null)
    } else {
      setError(String(err))
      setDetails(null)
    }
  }

  async function preview(doc: unknown, nextMode: Mode) {
    setBusy(true)
    setError(null)
    setDetails(null)
    try {
      setPlan(
        await api.post<Plan>(`/api/projects/${projectId}/flows/import`, {
          document: doc,
          mode: nextMode,
          dryRun: true,
        }),
      )
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return
    setFileName(file.name)
    setPlan(null)
    setError(null)
    setDetails(null)
    let parsed: unknown
    try {
      parsed = JSON.parse(await file.text())
    } catch (err) {
      setDocument(null)
      setError(`${file.name} is not valid JSON: ${(err as Error).message}`)
      return
    }
    setDocument(parsed)
    await preview(parsed, mode)
  }

  function changeMode(next: Mode) {
    setMode(next)
    if (document !== null) void preview(document, next)
  }

  async function confirm() {
    if (document === null) return
    setBusy(true)
    setError(null)
    setDetails(null)
    try {
      const r = await api.post<Plan>(`/api/projects/${projectId}/flows/import`, { document, mode })
      toast.success(
        `Imported ${r.created} new flow(s)${r.updated ? ` and versioned ${r.updated}` : ''}.`,
      )
      setOpen(false)
      reset()
      onImported()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <UploadIcon />
          Import JSON
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import flows from a JSON file</DialogTitle>
          <DialogDescription>
            Upload a Charlie flow document — one exported from another project, or one your own AI
            assistant generated. It is validated against this project before anything is saved.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="flow-doc">Flow document (.json)</Label>
            <input
              id="flow-doc"
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              onChange={(e) => void onFile(e.target.files?.[0])}
              className="border-input file:text-foreground w-full rounded-md border px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-transparent file:text-sm file:font-medium"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="import-mode">If a flow name already exists</Label>
            <Select value={mode} onValueChange={(v) => changeMode(v as Mode)}>
              <SelectTrigger id="import-mode" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="create">Stop and report the conflict</SelectItem>
                <SelectItem value="upsert">Save it as a new version of that flow</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {details != null && (
            <pre className="bg-muted text-muted-foreground max-h-60 w-full overflow-auto rounded-lg p-3 text-xs whitespace-pre-wrap">
              {JSON.stringify(details, null, 2)}
            </pre>
          )}

          {plan && (
            <div className="space-y-3">
              <Alert className="text-emerald-600 dark:text-emerald-400">
                <CheckCircle2Icon />
                <AlertDescription className="text-emerald-600 dark:text-emerald-400">
                  {fileName} is valid — {plan.created} new flow(s)
                  {plan.updated > 0 ? `, ${plan.updated} to be re-versioned` : ''}.
                </AlertDescription>
              </Alert>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Flow</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Steps</TableHead>
                    <TableHead>Engines</TableHead>
                    <TableHead>Result</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {plan.flows.map((f) => (
                    <TableRow key={f.name}>
                      <TableCell className="font-medium">{f.name}</TableCell>
                      <TableCell className="text-muted-foreground">{f.kind}</TableCell>
                      <TableCell className="text-muted-foreground">{f.steps ?? '—'}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {f.engines.map((e) => (
                            <Badge key={e} variant="secondary">
                              {e}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {f.action === 'create' ? 'new flow (v1)' : `new version (v${f.version})`}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {plan.secrets.length > 0 && (
                <p className="text-muted-foreground text-sm">
                  Environment secrets these flows expect:{' '}
                  {plan.secrets.map((s) => (
                    <Badge key={s} variant="outline" className="mr-1 font-mono text-xs font-normal">
                      {s}
                    </Badge>
                  ))}
                </p>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={busy || !plan} onClick={confirm}>
            {busy ? 'Working…' : 'Import'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
