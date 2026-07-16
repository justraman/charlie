# CI Integration (GitHub Actions)

The compute plane is GitHub Actions. Charlie dispatches a reusable workflow, the matrix fans out shards, and each shard reports back to the Worker API. This document covers the GitHub App, the reusable workflow, the dispatch path, and the two automatic triggers (cron and on-merge).

## GitHub App

Charlie uses one **GitHub App** (not a personal token) for three jobs:

1. **Dispatch** the reusable workflow into Charlie's runner repo.
2. **Receive webhooks** (`push`, `pull_request`) from watched source repos for on-merge triggers.
3. **Read source** (contents, read-only) for AI flow generation.

The App's private key lives in Workers Secrets (`CHARLIE_GH_APP_KEY`). Per-installation tokens are minted on demand (JWT signed with the key → installation access token) and cached until just before expiry. The webhook secret verifies inbound `X-Hub-Signature-256`.

Required App permissions: `actions: write` (dispatch), `contents: read` (source + workflow), `metadata: read`. Webhook events: `push`, `pull_request`.

## The runner repo & reusable workflow

Charlie owns a repository containing `.github/workflows/charlie-run.yml`. It is invoked via the REST **workflow dispatch** API with a payload the Worker builds per run.

```yaml
name: charlie-run
on:
  workflow_dispatch:
    inputs:
      runId:        { required: true }
      projectId:    { required: true }
      environmentId:{ required: true }
      engine:       { required: true }   # playwright | k6
      profile:      { required: true }   # smoke | load | stress
      shards:       { required: true }   # matrix size
      apiUrl:       { required: true }   # Worker base URL for callbacks
      # runToken is passed as a secret, not a plaintext input

jobs:
  prepare:
    runs-on: ubuntu-latest
    outputs:
      matrix: ${{ steps.plan.outputs.matrix }}
    steps:
      - id: plan
        run: echo "matrix=$(seq 0 $(( ${{ inputs.shards }} - 1 )) | jq -cs .)" >> "$GITHUB_OUTPUT"

  execute:
    needs: prepare
    strategy:
      fail-fast: false
      matrix: { shard: ${{ fromJson(needs.prepare.outputs.matrix) }} }
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4          # charlie runner code
      - run: bun install
      - name: Fetch flow bundle
        run: bun run charlie fetch-flow --run "${{ inputs.runId }}" --api "${{ inputs.apiUrl }}"
        env: { CHARLIE_RUN_TOKEN: ${{ secrets.charlieRunToken }} }
      - name: Execute shard
        run: bun run charlie execute --engine "${{ inputs.engine }}" --shard "${{ matrix.shard }}"
        env: { CHARLIE_RUN_TOKEN: ${{ secrets.charlieRunToken }} }
      # execute posts shard-result and uploads artifacts to R2 via presigned URLs

  finalize:
    needs: execute
    if: always()
    runs-on: ubuntu-latest
    steps:
      - run: bun run charlie finalize --run "${{ inputs.runId }}" --api "${{ inputs.apiUrl }}"
        env: { CHARLIE_RUN_TOKEN: ${{ secrets.charlieRunToken }} }
```

Notes:
- **Engine shape.** For `playwright`, `shards` = number of parallel browser shards (splitting flows). For `k6`, `shards` is usually small (1–few) because each k6 job drives many VUs per the `loadProfile`; the Worker sizes this when it builds the dispatch.
- **Secrets, not inputs, for `runToken`.** The Worker passes the run token through the dispatch as a secret-shaped input so it doesn't land in workflow logs.
- **`fail-fast: false`** so one shard's failure doesn't kill the rest — partial results are valid.
- **`finalize` runs `always()`** so the Run Coordinator DO can close the run even after shard failures.

## Dispatch path (Worker → GitHub)

1. `POST /api/runs` writes a `queued` run and enqueues a Cloudflare Queue message.
2. The queue consumer mints a GitHub App installation token.
3. It calls `POST /repos/{owner}/{runner-repo}/actions/workflows/charlie-run.yml/dispatches` with `ref` and `inputs`.
4. GitHub does not return the run id from dispatch, so the consumer polls `GET /actions/workflows/.../runs?created>=T` briefly to resolve and store `runs.gha_run_id` (needed for cancel/reconcile).
5. Shards call back to `POST /api/runs/:id/shard-result` (authorized by the run token). The first flips the run to `running`.

## Reconciliation & cancellation

- **Cancel:** `POST /api/runs/:id/cancel` de-queues a not-yet-dispatched run, or calls the GitHub API to cancel the workflow run when `gha_run_id` is set, then broadcasts the state change.
- **Reconcile:** a periodic Cron sweep finds `running` runs with no recent shard activity, queries `GET /actions/runs/:id`, and closes runs whose workflow already reached a terminal state (guards against a lost `finalize`).

## Trigger: cron (scheduled)

- A schedule with `trigger_type = cron` stores a `cron_expr` and `next_due_at`.
- The Worker's Cloudflare **Cron Trigger** fires (e.g. every minute); the `scheduled` handler selects `schedules` where `enabled AND next_due_at <= now`, enqueues a run for each, and advances `next_due_at`.
- A Scheduler DO (or a D1 conditional update) guarantees a given tick dispatches each schedule once even across overlapping invocations.

## Trigger: on-merge (source repo)

This is how "run when a code merge happens on the source repo" works:

1. The GitHub App is installed on the project's `source_repo`.
2. A merge to a watched branch produces `push` (or `pull_request.closed` with `merged: true`) → GitHub POSTs `/webhooks/github`.
3. The Worker verifies the signature, matches the repo + branch to schedules with `trigger_type = on_merge` and `watch_branch`, and enqueues a run.
4. The run records `commit_sha` and `trigger = merge`, so reports are attributable to the merge that caused them.

## Calling Charlie from an external CI pipeline

Teams can also trigger runs from their own pipelines without the on-merge webhook, using an API key:

```yaml
# in the app team's repo
- name: Charlie E2E on QA
  run: |
    curl -fsS -X POST "$CHARLIE_API/api/runs" \
      -H "Authorization: Bearer $CHARLIE_API_KEY" \
      -H "Content-Type: application/json" \
      -d '{"project":"storefront","environment":"qa","engine":"playwright","flows":["checkout"]}'
  env:
    CHARLIE_API: ${{ vars.CHARLIE_API_URL }}
    CHARLIE_API_KEY: ${{ secrets.CHARLIE_API_KEY }}
```

The API key needs `runs:write` (and `runs:read` to poll status). This is the equivalent of the reference project's reusable-workflow caller, adapted to Charlie's REST surface.
