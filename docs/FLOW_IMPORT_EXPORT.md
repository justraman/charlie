# Flow Import & Export

Flows can be downloaded as a JSON document and uploaded into any project — the
same file format both ways. It is how flows move between projects and
instances, how they get reviewed in a pull request, and how flows authored
*outside* Charlie get in.

That last one is the point. Charlie does not read your source code or generate
flows for you. A QA engineer who wants a flow drafted by an AI assistant runs
that assistant in their own harness — Claude Code, Codex, whatever they already
use, with their own key and their own repo access — and uploads the JSON it
produces. Charlie's job is to validate it ruthlessly and run it. The
[`charlie-flow-json` skill](../skills/charlie-flow-json) teaches an agent the
format:

```bash
npx skills add justraman/charlie --skill charlie-flow-json
```

## The format

`charlie.flows/v1`. One envelope, a list of flows:

```json
{
  "format": "charlie.flows/v1",
  "exportedAt": "2026-07-30T10:00:00.000Z",
  "project": "storefront",
  "flows": [
    {
      "kind": "steps",
      "name": "login",
      "description": "Sign in with a valid account",
      "engines": ["playwright"],
      "steps": [
        { "action": "goto", "url": "/login" },
        { "action": "fill", "selector": "input[name=\"email\"]", "value": "{{secrets.TEST_EMAIL}}" },
        { "action": "submit", "selector": "form" },
        { "action": "assert", "selector": "[data-test=\"dashboard\"]", "state": "visible" }
      ]
    }
  ]
}
```

The step vocabulary is exactly the flow schema in
[TEST_ENGINES.md](TEST_ENGINES.md); code flows carry a `code` pointer instead of
`steps` (see [CUSTOM_TESTS.md](CUSTOM_TESTS.md)). The schema lives in
`packages/flow-core/src/portable.ts` and is the single source of truth for both
ends.

The document format is deliberately **not** the storage shape. One difference
matters:

> **`useFlow` references a flow by name, not by id.**
> `{ "action": "useFlow", "flow": "login" }` in a document;
> `{ "action": "useFlow", "flowId": "0191c3…" }` in the database.

Ids are meaningless in a file written on someone's laptop or exported from a
different project. Export rewrites ids to names; import resolves names back to
ids, against the document *and* the target project.

Bounds: 200 flows per document, 1000 steps per flow, 2 MB per upload.

## Export

| Where | What you get |
|---|---|
| **Flows → Export all** on a project | Every live flow in the project. |
| The ⬇ button on a flow row | That flow, plus every flow it reaches through `useFlow`, so the file imports standalone. |

Both are plain authenticated `GET`s that return the document with a
`content-disposition` attachment header, pretty-printed for reading and diffing:

```
GET /api/projects/:projectId/flows/export[?flowIds=a,b][&deps=0]
GET /api/flows/:id/export[?deps=0]
```

`deps=0` exports the selection literally, leaving `useFlow` references to be
resolved against whatever is already in the target project.

Exports contain no secrets — only the `{{secrets.NAME}}` references. A document
is safe to commit.

## Import

**Flows → Import JSON**, pick a file. Charlie always dry-runs first and shows
the plan: which flows are new, which get a new version, how many steps each has,
and which environment secrets the steps expect. Nothing is written until that
plan is confirmed.

```
POST /api/projects/:projectId/flows/import
```

Body is either the bare document or `{ "document": …, "mode": …, "dryRun": … }`
(`mode` and `dryRun` also work as query params, so a raw file can be posted with
`curl --data-binary @flows.json`).

| Mode | On a name that already exists in the project |
|---|---|
| `create` (default) | 409, listing every clashing name. Nothing is written. |
| `upsert` | Saves the flow as a **new version** of the existing one, with a diff summary like any editor save. |

### What gets checked before anything is written

1. **Structure** — Zod, strict objects. An unknown key, a misspelled action, a
   `waitFor` with neither `selector` nor `ms`: 400 with the exact JSON path per
   problem. A silently-dropped field would mean a flow that runs differently
   from the file, so nothing is coerced.
2. **Document semantics** — duplicate names, a flow including itself, a
   `useFlow` pointing at a code flow, a reference cycle among the document's own
   flows.
3. **Against the project** — name clashes (per `mode`), a `kind` that
   contradicts the existing flow (a flow's type is fixed at creation), every
   `useFlow` name resolvable, and no cycle in the project's reference graph *as
   it will be after the import*.

Only then does it write — all flows and their audit rows in a **single atomic
D1 batch**. A document lands whole or not at all.

### Provenance

Imported flows are stored with `origin = "import"` (versus `manual` for editor
authoring). Each one writes a `flow.import_create` or `flow.import_version`
audit row naming the uploading user, the version, and the diff — so "where did
this flow come from" is answerable from the audit trail, whoever's agent wrote
the JSON.

### Round-tripping

Export → import is lossless for everything that defines a flow: name,
description, engines, steps, load profile, code pointer, and `useFlow`
composition. Not carried across (they are per-instance, not per-flow): version
history, run history, schedules, and environments. Import a document into a
project whose environment supplies the secrets the steps reference — the import
preview tells you which ones those are.
