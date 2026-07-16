# Slack Integration

Charlie is Slack-native: QA can start runs with a slash command and results post back to the channel. This document covers the app model, commands, verification, and reporting.

## App model

One Slack app for the workspace, connected once by an admin (`integration.connect`). The install stores the team id and the bot/signing credentials (encrypted) in `integrations`. Because Charlie is self-host single-org, the Slack app is a single-workspace app (not a distributed marketplace app) — simpler and sufficient.

Configured features:
- **Slash command** `/charlie`.
- **Interactivity** (buttons on result messages: re-run, open report).
- **Bot token scopes:** `commands`, `chat:write`, `chat:write.public`.

## Request verification

Every inbound Slack request is verified before anything else:
1. Reject if the `X-Slack-Request-Timestamp` is older than 5 minutes (replay guard).
2. Compute `v0=HMAC_SHA256(signing_secret, "v0:" + ts + ":" + rawBody)` and constant-time compare against `X-Slack-Signature`.
3. Only then parse the command.

Slack expects a response within 3 seconds. Charlie **acknowledges immediately** (ephemeral "Starting run…"), does the real work asynchronously (enqueue), and posts the outcome later via `response_url` / `chat.postMessage`.

## Commands

```
/charlie run   <project> <flow|all> --env <env> [--engine k6|playwright] [--profile smoke|load|stress]
/charlie e2e   <project> <flow|all> --env <env>          # shorthand for --engine playwright
/charlie load  <project> <flow|all> --env <env> --profile load   # shorthand for --engine k6
/charlie status <runId>
/charlie last  <project> [--env <env>]                   # last run summary
/charlie help
```

Examples:
```
/charlie run checkout --env qa
/charlie load checkout --env staging --profile stress
/charlie e2e all --env dev
```

### Identity & authorization

The Slack user is mapped to a Charlie user by verified email (Slack `users.info` → email → `users.email`). If unmapped, Charlie replies ephemerally with a link to log in once via Google SSO so the mapping can be established. The mapped user's **role** gates the command: triggering a run requires `editor`+ , exactly as in the web app, and the trigger is written to `audit_log` with `trigger = slack` and the resolved `actor_id`.

## Reporting back

When a run reaches a terminal state, the Run Coordinator DO's post-run step posts a Block Kit message to the originating channel:

```
✅ checkout · qa · playwright — passed in 42s
   3/3 flows passed · 0 runtime errors
   [ View report ]  [ Re-run ]

❌ checkout · staging · k6(load) — failed
   p95 1.9s (threshold <800ms) · error rate 4.2% (threshold <1%)
   Failing threshold: http_req_duration
   [ View report ]  [ Re-run ]
```

- The **View report** button links to `/{project}/runs/{runId}` in the dashboard.
- The **Re-run** button dispatches an identical run (subject to the clicker's role) and is itself audited.
- Scheduled and on-merge runs can be configured to report to a default channel per project, so cron/merge results show up without anyone typing a command.

## Failure surfacing

For E2E failures, the message includes the first failing step and a thumbnail link to the failure screenshot (R2, via a signed URL). For load failures, it names the breached threshold(s). Enough to triage from Slack; the full trace/HAR/report is one click away in the dashboard.

## Rate limiting & abuse

Slack commands pass through the same per-user rate limiter as the API. A misfired `/charlie load ... --profile stress` is bounded by the project's configured max VUs and by GitHub Actions concurrency, and every trigger is attributable via the audit log.
