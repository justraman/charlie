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

## Monorepo & tasks (Nx)

Charlie is an [Nx](https://nx.dev)-managed monorepo: one root `package.json` with all dependencies, each project defined by a `project.json`, Bun as installer/runtime (no workspaces). `typecheck`, `test`, and `build` are cached per project. The one cross-package import, `@charlie/flow-core`, resolves from source via TS path mappings (`tsconfig`) and a wrangler/esbuild alias for the Worker — so adding a new local dependency means wiring those aliases, not a `workspace:*` entry.

```bash
bun run typecheck            # nx run-many -t typecheck (all projects, cached)
bun run test                 # nx run-many -t test
bunx nx run @charlie/web:build
bunx nx run @charlie/flow-core:test   # one project's target
bun run affected             # only projects affected vs main
bun run graph                # project graph
```

Lint/format is Biome, run repo-wide (not through Nx): `bun run lint`, `bun run format`.

## Before you open a PR

```bash
bun run lint
bun run typecheck
bun run test
bun run build
```

CI runs the same checks (via `nx run-many`) plus a `wrangler deploy --dry-run` and a local D1 migration apply.

## Commit / PR style

- Keep PRs scoped to a single phase task where possible.
- Write tests for pure modules (token/OIDC verification, flow-core, crypto) as you add them.
