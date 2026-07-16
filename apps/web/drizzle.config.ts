// drizzle-kit config. `bun run db:generate` diffs worker/db/schema.ts against
// the last snapshot and emits a forward-only SQL migration into /migrations
// (the same dir wrangler's `migrations_dir` points at). The generated .sql is
// then applied with `wrangler d1 migrations apply charlie-db --local|--remote`
// (the db:migrate:* scripts) — wrangler reads the .sql files and ignores
// drizzle's meta/ bookkeeping folder.
//
// No `driver`/`dbCredentials` here: we only ever *generate* with drizzle-kit
// and *apply* with wrangler, so no Cloudflare API token is needed for schema
// changes. (Add the `d1-http` driver + credentials later only if you want
// `drizzle-kit studio`/`push`.)

import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './worker/db/schema.ts',
  out: '../../migrations',
})
