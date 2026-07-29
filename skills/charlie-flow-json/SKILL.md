---
name: charlie-flow-json
description: >-
  Write Charlie flow documents — the JSON file a QA engineer uploads to create
  test flows in Charlie. Use when asked to generate, edit, review, or debug a
  Charlie flow JSON: turning a written test case, a user journey, a bug repro, or
  an app's UI into `goto`/`click`/`fill`/`assert` steps, wiring `{{secrets.*}}`
  placeholders, composing flows with `useFlow`, adding a k6 `loadProfile`, or
  fixing an upload the importer rejected. Triggers on: "Charlie flow JSON",
  "charlie.flows/v1", "flow document", "generate a Charlie flow", "import flows
  into Charlie", "flow steps JSON", "useFlow".
---

# Charlie flow documents

Charlie runs a **flow**: an ordered list of browser steps, authored once and
executed either as an end-to-end test (Playwright, real browser) or as a load
test (k6, HTTP only). Flows are created in Charlie's editor — or written as a
JSON file and uploaded, which is what this skill is for.

Your job: produce a **flow document** that the importer accepts on the first
try and that describes a test a QA engineer would actually recognize.

## The shape

```json
{
  "format": "charlie.flows/v1",
  "flows": [
    {
      "name": "login",
      "description": "Sign in with a valid account",
      "engines": ["playwright"],
      "steps": [
        { "action": "goto", "url": "/login" },
        { "action": "fill", "selector": "input[name=\"email\"]", "value": "{{secrets.TEST_EMAIL}}" },
        { "action": "fill", "selector": "input[name=\"password\"]", "value": "{{secrets.TEST_PASSWORD}}" },
        { "action": "submit", "selector": "form" },
        { "action": "assert", "selector": "[data-test=\"dashboard\"]", "state": "visible" }
      ]
    }
  ]
}
```

`format` and `flows` are the only required top-level keys. Every flow needs a
`name` and either `steps` (a steps flow) or `code` (a repo of Playwright specs).

## Non-negotiables

These are what the importer rejects, and what makes a generated flow useless
even when it validates:

1. **Strict objects.** Every unknown key is a hard error, with a path. There is
   no `"comment"`, no `"id"`, no `"timeout_ms"`. Use only the fields in
   `references/step-reference.md`.
2. **Never hardcode a host.** `url` is relative to the environment's base URL
   (`/login`, not `https://staging.acme.com/login`). One flow must run against
   dev, staging, and prod unchanged.
3. **Never write a credential.** Real values go in Charlie environment secrets;
   the document references them as `{{secrets.NAME}}`. A password in the file is
   a leaked password.
4. **`useFlow` references by name.** Inside a document, a flow includes another
   by `{"action": "useFlow", "flow": "login"}` — the *name*, never an id. The
   importer resolves it against the document and the target project.
5. **Every flow ends in an assertion.** A flow with no `assert` step passes as
   long as the page doesn't crash, which tests nothing.

## Workflow

1. **Establish the journey first.** Ask for (or read) the actual test case: what
   the user does, and what proves it worked. If you're working from an app's
   source or a live page, note the real selectors — do not invent them.
2. **Pick selectors that will survive.** `[data-test=...]` > `[name=...]` >
   `#id` > a text/role selector > a CSS path. Never an nth-child chain.
   → `references/authoring-guide.md`
3. **Write the steps.** One action per field in the reference; nothing else.
   → `references/step-reference.md`
4. **Factor shared prefixes into their own flow.** If three journeys start by
   logging in, write a `login` flow once and `useFlow` it.
   → `references/document-format.md`
5. **Add `loadProfile` only for flows you also list under `engines: ["k6"]`,**
   and only after checking the step-by-step HTTP mapping — clicks and DOM
   assertions silently do nothing under k6.
   → `references/document-format.md`
6. **Self-check against the checklist** at the end of
   `references/authoring-guide.md`, then save the file as
   `<something>.charlie-flows.json`.

A complete, validated document showing all three patterns — a shared flow, an
E2E journey composing it, and a k6-safe load flow — is in
`examples/storefront.charlie-flows.json`. Copy its shape.

## Uploading

In Charlie: open the project → **Flows → Import JSON** → pick the file. Charlie
dry-runs it first and shows exactly what will be created, which flows get a new
version, and which environment secrets the steps expect. Nothing is written
until that plan is confirmed.

If the upload is rejected, the error `details` array gives a JSON path per
problem (`flows[1].steps[3].selector`). Fix the named field — do not restructure
the document.

## Common mistakes this skill prevents

- Inventing fields (`"wait": 500`, `"description"` on a step) — strict objects
  reject the whole file.
- Absolute URLs, so the flow only ever works against one environment.
- Literal test credentials instead of `{{secrets.*}}`.
- `{"action": "useFlow", "flowId": "..."}` — the id form is the *storage* shape,
  not the document shape.
- A "test" that navigates and never asserts.
- `engines: ["k6"]` on a flow made of clicks and DOM assertions, which compiles
  to an HTTP scenario that checks nothing.
- Duplicate flow names in one document, or a `useFlow` cycle.
