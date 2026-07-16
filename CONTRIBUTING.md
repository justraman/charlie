# Contributing to Charlie

Thanks for your interest in Charlie. This project is in active development following the phased [execution plan](EXECUTION_PLAN.md).

## Getting set up

See the **Local development** section of the [README](README.md#local-development).

## Ground rules (from the execution plan)

These are load-bearing and reviewed on every PR:

- **Control plane vs compute plane.** All durable state and coordination live on Cloudflare; tests execute on GitHub Actions. No test ever runs in a Worker.
- **D1 is the system of record.** The UI renders server-derived responses; no client-side aggregation.
- **Audit-first.** No mutating endpoint merges without its `audit()` call, committed in the same D1 batch as the mutation. Secrets are redacted; the fact of change is still recorded.
- **Migrations are forward-only.** Every schema change is a new `migrations/NNNN_*.sql`; never edit an applied migration.
- **Docs-as-you-go.** Update the relevant `docs/*` file in the same PR as the feature.
- **Secrets never round-trip.** Environment secrets and provider keys are write-only from the client's perspective — the API returns presence/masked hints, never plaintext.

## Before you open a PR

```bash
bun run lint
bun run typecheck
bun test
bun run build
```

CI runs the same checks plus a `wrangler deploy --dry-run` and a local D1 migration apply.

## Commit / PR style

- Keep PRs scoped to a single phase task where possible.
- Write tests for pure modules (token/OIDC verification, flow-core, crypto) as you add them.
