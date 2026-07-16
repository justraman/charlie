import { useCallback, useEffect, useState } from 'react'
import { ApiError, api } from '@/lib/api'
import styles from './IntegrationsView.module.css'

interface Status {
  slack: { connected: boolean; teamId: string | null; updatedAt: string | null }
  github: { connected: boolean }
}

export function IntegrationsView() {
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [teamId, setTeamId] = useState('')
  const [botToken, setBotToken] = useState('')
  const [signingSecret, setSigningSecret] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setStatus(await api.get<Status>('/api/integrations'))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function connect() {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await api.put('/api/integrations/slack', {
        teamId: teamId || undefined,
        botToken,
        signingSecret,
      })
      setBotToken('')
      setSigningSecret('')
      setNotice('Slack connected. Credentials are encrypted at rest.')
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    if (!confirm('Disconnect Slack?')) return
    try {
      await api.delete('/api/integrations/slack')
      setNotice('Slack disconnected.')
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  return (
    <div className="container">
      <h1>Integrations</h1>
      {error && <p className="error">{error}</p>}
      {notice && <p className={styles.notice}>{notice}</p>}

      <section>
        <div className={styles.head}>
          <h2>Slack</h2>
          {status?.slack.connected ? (
            <span className={styles.connected}>
              connected{status.slack.teamId ? ` · ${status.slack.teamId}` : ''}
            </span>
          ) : (
            <span className="muted">not connected</span>
          )}
        </div>
        <p className="muted">
          Create a single-workspace Slack app with a <code>/charlie</code> slash command and
          interactivity, then paste its bot token and signing secret here. They are stored encrypted
          and never shown again.
        </p>
        <div className={`card ${styles.form}`}>
          <label className={styles.field}>
            <span>Team ID (optional)</span>
            <input
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
              placeholder="T0123ABCD"
            />
          </label>
          <label className={styles.field}>
            <span>Bot token</span>
            <input
              type="password"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder="xoxb-…"
            />
          </label>
          <label className={styles.field}>
            <span>Signing secret</span>
            <input
              type="password"
              value={signingSecret}
              onChange={(e) => setSigningSecret(e.target.value)}
              placeholder="Slack app signing secret"
            />
          </label>
          <div className={styles.actions}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || botToken.length < 10 || signingSecret.length < 10}
              onClick={connect}
            >
              {status?.slack.connected ? 'Update credentials' : 'Connect Slack'}
            </button>
            {status?.slack.connected && (
              <button type="button" className="btn btn-danger" onClick={disconnect}>
                Disconnect
              </button>
            )}
          </div>
        </div>
      </section>

      <section style={{ marginTop: '1.5rem' }}>
        <div className={styles.head}>
          <h2>GitHub</h2>
          <span className={status?.github.connected ? styles.connected : 'muted'}>
            {status?.github.connected ? 'configured' : 'not configured'}
          </span>
        </div>
        <p className="muted">
          The GitHub App (dispatch + on-merge webhooks) is configured via Worker secrets at deploy
          time — see the CI integration docs.
        </p>
      </section>
    </div>
  )
}
