# Authentication, Authorization & Audit

Charlie has three trust surfaces: **humans** (Google SSO), **machines** (API keys and run tokens), and **integrations** (Slack signing secrets, GitHub App). All three converge on one protected-route middleware in the Worker.

## Human login: Google SSO (OIDC)

Charlie has no passwords. Login is Google OpenID Connect only.

### Flow
1. User hits a protected route unauthenticated → redirected to `GET /api/auth/google/start`.
2. Worker generates a `state` + PKCE verifier (stored short-term in KV), redirects to Google's consent screen.
3. Google redirects back to `GET /api/auth/google/callback?code&state`.
4. Worker exchanges the code for tokens, validates the ID token (issuer, audience, expiry, signature via Google's JWKS), and reads `email`, `email_verified`, `sub`, `name`, `picture`.
5. **Domain gate:** the email domain must be in `organization.allowed_email_domains`. Otherwise access is denied and the attempt is audited.
6. User row is upserted (`google_sub` is the stable key). First-ever user becomes `owner`; subsequent new users default to `viewer` and must be promoted.
7. A `session` row is created; an httpOnly, Secure, SameSite=Lax cookie carries a hash of the session id.

### Sessions
- Stored in D1 (`sessions`), keyed by opaque id; the cookie holds a hash so a D1 leak can't be replayed directly.
- Sliding expiry (default 7 days); `expires_at` refreshed on activity.
- `POST /api/auth/logout` deletes the session row.
- `ip` and `user_agent` are recorded for the audit trail.

## Roles (RBAC)

Four roles, checked in the protected-route middleware against a static capability matrix.

| Capability | viewer | editor | admin | owner |
|---|:--:|:--:|:--:|:--:|
| View projects, runs, reports | ✓ | ✓ | ✓ | ✓ |
| Trigger runs | | ✓ | ✓ | ✓ |
| Create/edit flows, environments | | ✓ | ✓ | ✓ |
| Manage schedules | | ✓ | ✓ | ✓ |
| Manage secrets | | | ✓ | ✓ |
| Manage integrations (Slack/GitHub/AI) | | | ✓ | ✓ |
| Manage members & roles | | | ✓ | ✓ |
| Manage API keys | | | ✓ | ✓ |
| Transfer ownership, delete org data | | | | ✓ |

Environment **secrets** are gated above editor deliberately: an editor can author flows and trigger runs but cannot read or change raw secret values.

## Machine auth

### API keys
For CI pipelines and external callers. Format `charlie_{env}_{keyId}_{secret}`; only the SHA-256 of `{secret}` is stored (`api_keys.secret_hash`). Keys carry:
- **scopes** — e.g. `runs:write`, `runs:read`, `reports:read`, `flows:read`.
- **project scope** — optional allow-list of project ids.
- **expiry** — optional.

Presented as `Authorization: Bearer charlie_...`. Verified by splitting out `keyId`, loading the row, hashing the presented secret, and constant-time comparing.

### Run tokens
Every dispatched GitHub run receives a **short-lived, run-scoped token** (`runToken`) as a workflow input. It authorizes exactly one run's callbacks (`shard-result`, artifact presign, finalize) and nothing else, and expires when the run reaches a terminal state or after a hard TTL. This means the compute plane never holds a broad API key.

### Presigned artifact uploads
Runners never receive R2 credentials. They ask the Worker (`POST /api/runs/:id/artifacts/presign`, authorized by the run token) for a presigned PUT URL scoped to a specific object key, then upload directly to R2.

## Integration auth

- **Slack:** every inbound Slack request is verified with the signing secret (`v0=` HMAC over the raw body + timestamp, with a replay window). See [SLACK.md](SLACK.md).
- **GitHub App:** webhooks are verified with the webhook secret (`X-Hub-Signature-256`). Outbound calls (dispatch, repo read) use per-installation tokens minted from the App private key held in Workers Secrets. See [CI_INTEGRATION.md](CI_INTEGRATION.md).

## Audit trail

Every **mutating** request writes an `audit_log` row inside the same D1 transaction as the change, so an audited action and its record commit together. Read-only requests are not audited (except denied-access and login events).

Recorded per action:
- **actor** — user id, or `api_key` id, or `system`.
- **action** — dotted verb, e.g. `flow.update`, `environment.secret_update`, `schedule.enable`, `run.trigger`, `run.cancel`, `member.role_change`, `apikey.create`, `integration.connect`.
- **entity** — type + id.
- **before / after** — JSON snapshots (secrets redacted to a `"[redacted]"` marker, but the fact of change is recorded).
- **context** — ip, user agent, timestamp.

The log is append-only (no update/delete paths in the API) and browsable per-entity ("history of this flow") and globally ("everything QA-user did last week"). This satisfies the "trace of who did what changes" requirement end to end.

## Threat-model notes

- **Least privilege on the compute plane:** run tokens, not org keys, cross into GitHub Actions.
- **Secrets never round-trip:** environment secrets and AI keys are write-only from the client's perspective; the API returns presence/masked hints, never plaintext.
- **Domain-gated SSO:** self-host single-org means the allow-list is the primary tenancy boundary.
- **Immutable audit:** compromise of an editor account is detectable and attributable.
