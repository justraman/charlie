import { useCallback, useEffect, useState } from 'react'
import { ApiError, api } from '@/lib/api'
import styles from './IntegrationsView.module.css'

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

export function IntegrationsView() {
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
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
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }, [])

  async function addProvider() {
    setError(null)
    setNotice(null)
    try {
      await api.post('/api/ai-providers', {
        name: aiName,
        model: aiModel,
        apiKey: aiKey || undefined,
        accountId: aiAccount || undefined,
      })
      setAiKey('')
      setAiAccount('')
      setNotice('Provider saved.')
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  async function setDefaultProvider(id: string) {
    try {
      await api.patch(`/api/ai-providers/${id}`, { makeDefault: true })
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  async function removeProvider(id: string) {
    if (!confirm('Delete this provider?')) return
    try {
      await api.delete(`/api/ai-providers/${id}`)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

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

      <section style={{ marginTop: '1.5rem' }}>
        <div className={styles.head}>
          <h2>AI providers</h2>
        </div>
        <p className="muted">
          Bring your own key. Provider + model + key are stored per org (key encrypted at rest); the
          default provider is used to draft flows from a project's source repo.
        </p>
        {providers.length > 0 && (
          <div className="card" style={{ marginBottom: '0.75rem' }}>
            <table>
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Model</th>
                  <th>Key</th>
                  <th>Default</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {providers.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td className="mono">{p.model}</td>
                    <td className="muted">{p.hasKey ? 'set' : '—'}</td>
                    <td>
                      {p.isDefault ? (
                        <span className={styles.connected}>default</span>
                      ) : (
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setDefaultProvider(p.id)}
                        >
                          Make default
                        </button>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        type="button"
                        className="btn btn-danger"
                        onClick={() => removeProvider(p.id)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className={`card ${styles.form}`}>
          <label className={styles.field}>
            <span>Provider</span>
            <select
              value={aiName}
              onChange={(e) => setAiName(e.target.value as AiProvider['name'])}
            >
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="openai">OpenAI</option>
              <option value="workers_ai">Cloudflare Workers AI</option>
            </select>
          </label>
          <label className={styles.field}>
            <span>Model</span>
            <input
              value={aiModel}
              onChange={(e) => setAiModel(e.target.value)}
              placeholder="claude-opus-4-8"
            />
          </label>
          {aiName !== 'workers_ai' && (
            <label className={styles.field}>
              <span>API key</span>
              <input
                type="password"
                value={aiKey}
                onChange={(e) => setAiKey(e.target.value)}
                placeholder="sk-… / xai-…"
              />
            </label>
          )}
          {aiName === 'workers_ai' && (
            <>
              <label className={styles.field}>
                <span>Cloudflare account ID</span>
                <input value={aiAccount} onChange={(e) => setAiAccount(e.target.value)} />
              </label>
              <label className={styles.field}>
                <span>API token</span>
                <input type="password" value={aiKey} onChange={(e) => setAiKey(e.target.value)} />
              </label>
            </>
          )}
          <div className={styles.actions}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !aiModel}
              onClick={addProvider}
            >
              Add provider
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
