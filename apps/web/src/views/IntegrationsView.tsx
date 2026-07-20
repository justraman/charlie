import { RefreshCwIcon } from 'lucide-react'
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
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { ApiError, api } from '@/lib/api'

interface IntegrationStatus {
  configured: boolean
  connected: boolean
  detail: string | null
}
interface AiStatus extends IntegrationStatus {
  provider: string | null
  model: string | null
}
interface Status {
  slack: IntegrationStatus
  github: IntegrationStatus
  ai: AiStatus
  checkedAt: string
}

const connectedBadge = 'border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
const warnBadge = 'border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400'

function StatusBadge({ s }: { s: IntegrationStatus }) {
  if (s.connected) return <Badge className={connectedBadge}>connected</Badge>
  if (s.configured) return <Badge className={warnBadge}>configured · not reachable</Badge>
  return (
    <Badge variant="outline" className="text-muted-foreground">
      not configured
    </Badge>
  )
}

function StatusCard({
  title,
  description,
  s,
  extra,
}: {
  title: string
  description: string
  s: IntegrationStatus
  extra?: string | null
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardAction>
          <StatusBadge s={s} />
        </CardAction>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      {(extra || s.detail) && (
        <CardContent className="space-y-1 text-sm">
          {extra && <p className="text-foreground">{extra}</p>}
          {s.detail && (
            <p
              className={
                s.connected ? 'text-muted-foreground' : 'text-amber-600 dark:text-amber-400'
              }
            >
              {s.detail}
            </p>
          )}
        </CardContent>
      )}
    </Card>
  )
}

export function IntegrationsView() {
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (refresh = false) => {
    setBusy(true)
    try {
      const s = await api.get<Status>(`/api/integrations${refresh ? '?refresh=1' : ''}`)
      setStatus(s)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-6">
      <PageHeader
        title="Integrations"
        description="Slack, GitHub, and the AI provider are configured via Worker secrets (environment variables). This page shows their live connection status — it does not store credentials."
      />

      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => load(true)}
        >
          <RefreshCwIcon className={busy ? 'animate-spin' : ''} />
          Re-check
        </Button>
        {status && (
          <span className="text-muted-foreground text-xs">
            Last checked {new Date(status.checkedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      {status && (
        <>
          <StatusCard
            title="Slack"
            description="Set SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET (Cloudflare secrets). Verified live via Slack's auth.test."
            s={status.slack}
          />
          <StatusCard
            title="GitHub"
            description="The GitHub App (dispatch + on-merge webhooks) is configured via Worker secrets. Verified by minting an installation token."
            s={status.github}
          />
          <StatusCard
            title="AI provider"
            description="A single provider is set via AI_PROVIDER / AI_MODEL / AI_API_KEY (Cloudflare secrets). Verified with a models-list call."
            s={status.ai}
            extra={
              status.ai.provider
                ? `${status.ai.provider}${status.ai.model ? ` · ${status.ai.model}` : ''}`
                : null
            }
          />
        </>
      )}
    </div>
  )
}
