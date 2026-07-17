import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/page-header'
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
import { Input } from '@/components/ui/input'
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

interface Status {
  slack: { connected: boolean; teamId: string | null; updatedAt: string | null }
  github: { connected: boolean }
}

interface AiProvider {
  id: string
  name: 'anthropic' | 'openai' | 'workers_ai'
  model: string
  hasKey: boolean
  isDefault: boolean
}

const connectedBadge = 'border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'

export function IntegrationsView() {
  const [status, setStatus] = useState<Status | null>(null)
  const [teamId, setTeamId] = useState('')
  const [botToken, setBotToken] = useState('')
  const [signingSecret, setSigningSecret] = useState('')
  const [busy, setBusy] = useState(false)
  // AI providers
  const [providers, setProviders] = useState<AiProvider[]>([])
  const [aiName, setAiName] = useState<AiProvider['name']>('anthropic')
  const [aiModel, setAiModel] = useState('claude-opus-4-8')
  const [aiKey, setAiKey] = useState('')
  const [aiAccount, setAiAccount] = useState('')

  const load = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([
        api.get<Status>('/api/integrations'),
        api.get<{ providers: AiProvider[] }>('/api/ai-providers'),
      ])
      setStatus(s)
      setProviders(p.providers)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err))
    }
  }, [])

  async function addProvider() {
    try {
      await api.post('/api/ai-providers', {
        name: aiName,
        model: aiModel,
        apiKey: aiKey || undefined,
        accountId: aiAccount || undefined,
      })
      setAiKey('')
      setAiAccount('')
      toast.success('Provider saved.')
      await load()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err))
    }
  }

  async function setDefaultProvider(id: string) {
    try {
      await api.patch(`/api/ai-providers/${id}`, { makeDefault: true })
      await load()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err))
    }
  }

  async function removeProvider(id: string) {
    if (!confirm('Delete this provider?')) return
    try {
      await api.delete(`/api/ai-providers/${id}`)
      await load()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err))
    }
  }

  useEffect(() => {
    void load()
  }, [load])

  async function connect() {
    setBusy(true)
    try {
      await api.put('/api/integrations/slack', {
        teamId: teamId || undefined,
        botToken,
        signingSecret,
      })
      setBotToken('')
      setSigningSecret('')
      toast.success('Slack connected. Credentials are encrypted at rest.')
      await load()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    if (!confirm('Disconnect Slack?')) return
    try {
      await api.delete('/api/integrations/slack')
      toast.success('Slack disconnected.')
      await load()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err))
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Integrations"
        description="Connect Charlie to Slack, GitHub, and your AI providers."
      />

      <Card>
        <CardHeader>
          <CardTitle>Slack</CardTitle>
          <CardAction>
            {status?.slack.connected ? (
              <Badge className={connectedBadge}>
                connected{status.slack.teamId ? ` · ${status.slack.teamId}` : ''}
              </Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">
                not connected
              </Badge>
            )}
          </CardAction>
          <CardDescription>
            Create a single-workspace Slack app with a <code>/charlie</code> slash command and
            interactivity, then paste its bot token and signing secret here. They are stored
            encrypted and never shown again.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="max-w-md space-y-4">
            <div className="space-y-2">
              <Label htmlFor="slack-team-id">Team ID (optional)</Label>
              <Input
                id="slack-team-id"
                value={teamId}
                onChange={(e) => setTeamId(e.target.value)}
                placeholder="T0123ABCD"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="slack-bot-token">Bot token</Label>
              <Input
                id="slack-bot-token"
                type="password"
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                placeholder="xoxb-…"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="slack-signing-secret">Signing secret</Label>
              <Input
                id="slack-signing-secret"
                type="password"
                value={signingSecret}
                onChange={(e) => setSigningSecret(e.target.value)}
                placeholder="Slack app signing secret"
              />
            </div>
          </div>
        </CardContent>
        <CardFooter className="gap-2">
          <Button
            type="button"
            disabled={busy || botToken.length < 10 || signingSecret.length < 10}
            onClick={connect}
          >
            {status?.slack.connected ? 'Update credentials' : 'Connect Slack'}
          </Button>
          {status?.slack.connected && (
            <Button type="button" variant="destructive" onClick={disconnect}>
              Disconnect
            </Button>
          )}
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>GitHub</CardTitle>
          <CardAction>
            {status?.github.connected ? (
              <Badge className={connectedBadge}>configured</Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">
                not configured
              </Badge>
            )}
          </CardAction>
          <CardDescription>
            The GitHub App (dispatch + on-merge webhooks) is configured via Worker secrets at deploy
            time — see the CI integration docs.
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>AI providers</CardTitle>
          <CardDescription>
            Bring your own key. Provider + model + key are stored per org (key encrypted at rest);
            the default provider is used to draft flows from a project's source repo.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {providers.length > 0 && (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Provider</TableHead>
                    <TableHead>Model</TableHead>
                    <TableHead>Key</TableHead>
                    <TableHead>Default</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {providers.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>{p.name}</TableCell>
                      <TableCell className="font-mono text-sm">{p.model}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {p.hasKey ? 'set' : '—'}
                      </TableCell>
                      <TableCell>
                        {p.isDefault ? (
                          <Badge className={connectedBadge}>default</Badge>
                        ) : (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setDefaultProvider(p.id)}
                          >
                            Make default
                          </Button>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          onClick={() => removeProvider(p.id)}
                        >
                          Delete
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <div className="max-w-md space-y-4">
            <div className="space-y-2">
              <Label htmlFor="ai-provider">Provider</Label>
              <Select
                value={aiName}
                onValueChange={(v) => setAiName(v as AiProvider['name'])}
              >
                <SelectTrigger id="ai-provider" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="anthropic">Anthropic (Claude)</SelectItem>
                  <SelectItem value="openai">OpenAI</SelectItem>
                  <SelectItem value="workers_ai">Cloudflare Workers AI</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ai-model">Model</Label>
              <Input
                id="ai-model"
                value={aiModel}
                onChange={(e) => setAiModel(e.target.value)}
                placeholder="claude-opus-4-8"
              />
            </div>
            {aiName !== 'workers_ai' && (
              <div className="space-y-2">
                <Label htmlFor="ai-key">API key</Label>
                <Input
                  id="ai-key"
                  type="password"
                  value={aiKey}
                  onChange={(e) => setAiKey(e.target.value)}
                  placeholder="sk-… / xai-…"
                />
              </div>
            )}
            {aiName === 'workers_ai' && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="ai-account">Cloudflare account ID</Label>
                  <Input
                    id="ai-account"
                    value={aiAccount}
                    onChange={(e) => setAiAccount(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ai-token">API token</Label>
                  <Input
                    id="ai-token"
                    type="password"
                    value={aiKey}
                    onChange={(e) => setAiKey(e.target.value)}
                  />
                </div>
              </>
            )}
          </div>
        </CardContent>
        <CardFooter>
          <Button type="button" disabled={busy || !aiModel} onClick={addProvider}>
            Add provider
          </Button>
        </CardFooter>
      </Card>
    </div>
  )
}
