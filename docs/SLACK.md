# Slack Integration

Charlie is Slack-native: QA can start runs with a slash command and results post back to the channel. This document covers the app model, commands, verification, and reporting.

## App model

One Slack app for the workspace, connected once by an admin (`integration.connect`). The install stores the team id and the bot/signing credentials (encrypted) in `integrations`. Because Charlie is self-host single-org, the Slack app is a single-workspace app (not a distributed marketplace app) — simpler and sufficient.

Configured features:
- **Slash command** `/charlie`.
- **Interactivity** (buttons on result messages: re-run, open report).
- **Bot token scopes:** `commands`, `chat:write`, `chat:write.public`, `files:write` (to attach the k6 PDF report), `users:read.email` (to map Slack users to Charlie accounts).

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

## Reporting back — one thread per run

Each run gets a **Slack thread**, so a run's whole lifecycle is one collapsible
conversation instead of a scatter of standalone messages.

1. **On start**, when the run's Coordinator DO initializes, Charlie posts the
   parent message and captures its `ts` (persisted on `runs.slack_thread_ts`):

   ```
   ⏳ Started flow "checkout" on checkout@qa   [ Track progress ]
   ```

2. **On completion**, the same parent message is **edited in place** — the
   hourglass becomes a green check (pass) or red circle (fail) and the verb flips
   from *Started* to *Completed* / *Failed*:

   ```
   ✅ Completed flow "checkout" on checkout@qa   [ View report ]  [ Re-run ]
   🔴 Failed flow "checkout" on checkout@qa      [ View report ]  [ Re-run ]
   ```

3. **All results post as replies in that thread** — E2E summaries and k6 load
   results alike — keeping the channel tidy.

- The **View report** / **Track progress** button links to `/runs/{runId}` in the dashboard.
- The **Re-run** button dispatches an identical run (subject to the clicker's role) and is itself audited.
- Scheduled and on-merge runs report into the project's **default channel** the
  same way (a thread opens there when the run starts). If a run never opened a
  thread (e.g. Slack was connected mid-run), the terminal message is posted
  standalone and the results reply threads off it.

### k6 load results — table, comparison, and PDF

A k6 run's threaded reply carries three things:

1. The **headline lines** (p95, error rate, breached thresholds) — unchanged from before.
2. A **fixed-width metrics table** (Slack has no native tables, so it's a code
   block) comparing this run to the **last run with the same settings**
   (same project + environment + profile + flow set):

   ```
   METRIC          CURRENT   BASELINE  CHANGE
   p50 latency     120 ms    150 ms    -20.0% better
   p95 latency     190 ms    170 ms    +11.8% worse
   error rate      0.40%     0.20%     +100.0% worse
   ...
   ```

   Lower latency/error-rate and higher throughput count as *better*. When there
   is no prior same-settings run, the reply says so.
3. The **full report as a PDF**, uploaded into the thread (Slack `files:write`).
   The same PDF is downloadable from the run's dashboard page (**Download PDF**),
   and the raw k6 summary + charts remain on the dashboard in their existing form.

## Failure surfacing

For E2E failures, the reply includes the first failing flow/step. For load
failures, it names the breached threshold(s). Enough to triage from Slack; the
full trace/HAR/report is one click away in the dashboard.

## Rate limiting & abuse

Slack commands pass through the same per-user rate limiter as the API. A misfired `/charlie load ... --profile stress` is bounded by the project's configured max VUs and by GitHub Actions concurrency, and every trigger is attributable via the audit log.
