# The document format

## Envelope

```json
{
  "format": "charlie.flows/v1",
  "exportedAt": "2026-07-30T10:00:00.000Z",
  "project": "storefront",
  "notes": "Checkout journeys for the Q3 release",
  "flows": [ /* 1 – 200 flows */ ]
}
```

| Key | Required | Notes |
|---|---|---|
| `format` | yes | Exactly `"charlie.flows/v1"`. |
| `flows` | yes | 1 – 200 flows. |
| `exportedAt` | no | ISO-8601. Informational. |
| `project` | no | Where it came from. Informational — the import target is chosen in the UI, never from this field. |
| `notes` | no | Free text for whoever opens the file. |

No other top-level keys. The importer also accepts a bare array of flows, or a
single bare flow object, and wraps them — but **write the full envelope**: it
makes the file self-describing and version-tagged.

## A steps flow

```json
{
  "kind": "steps",
  "name": "guest-checkout",
  "description": "Buy one item without an account",
  "engines": ["playwright"],
  "steps": [ /* 1 – 1000 steps */ ],
  "loadProfile": null
}
```

| Key | Required | Notes |
|---|---|---|
| `name` | yes | ≤ 120 chars. **Unique within the document, and within the target project.** This is also the `useFlow` handle. |
| `steps` | yes | See `step-reference.md`. |
| `kind` | no | Defaults to `"steps"`. |
| `description` | no | ≤ 2000 chars. Write one — it's what a reviewer reads first. |
| `engines` | no | Defaults to `["playwright"]`. Any of `"playwright"`, `"k6"`. |
| `loadProfile` | no | k6 only; see below. |

## A code flow

For journeys too complex for steps, a flow can point at real Playwright specs in
a GitHub repo. (Authoring those tests is a different skill — `charlie-playwright`.)

```json
{
  "kind": "code",
  "name": "checkout-suite",
  "engines": ["playwright"],
  "code": {
    "repo": "acme/web-e2e-tests",
    "ref": "main",
    "workingDir": "packages/e2e",
    "testFilter": "tests/checkout.spec.ts",
    "grep": "@smoke"
  }
}
```

Only `code.repo` (as `owner/repo`) is required. Code flows are Playwright-only,
have no `steps`, and cannot be a `useFlow` target.

## Composing with `useFlow`

Write a shared prefix once:

```json
{
  "format": "charlie.flows/v1",
  "flows": [
    {
      "name": "login",
      "steps": [
        { "action": "goto", "url": "/login" },
        { "action": "fill", "selector": "input[name=\"email\"]", "value": "{{secrets.TEST_EMAIL}}" },
        { "action": "fill", "selector": "input[name=\"password\"]", "value": "{{secrets.TEST_PASSWORD}}" },
        { "action": "submit", "selector": "form" },
        { "action": "assert", "selector": "[data-test=\"dashboard\"]", "state": "visible" }
      ]
    },
    {
      "name": "checkout",
      "steps": [
        { "action": "useFlow", "flow": "login" },
        { "action": "goto", "url": "/cart" },
        { "action": "click", "selector": "[data-test=\"place-order\"]" },
        { "action": "assert", "text": "Order confirmed", "captureOnFail": true }
      ]
    }
  ]
}
```

Rules the importer enforces:

- The target must be a **steps** flow, resolvable by name in this document or
  already present in the project.
- No self-reference, and no cycle (`a → b → a`), including cycles closed against
  flows already in the project when re-importing over them.
- Order in the `flows` array doesn't matter — dependencies are created first.

Reference a flow that exists only in the project (not in the file) when you
deliberately want to reuse what's already there; the import fails clearly if it
isn't found.

## Load profiles (k6)

Only meaningful when `engines` includes `"k6"`.

```json
{
  "loadProfile": {
    "profile": "load",
    "stages": [
      { "duration": "30s", "target": 50 },
      { "duration": "2m", "target": 50 },
      { "duration": "30s", "target": 0 }
    ],
    "thresholds": { "http_req_duration": ["p(95)<800"], "http_req_failed": ["rate<0.01"] }
  }
}
```

| Key | Required | Notes |
|---|---|---|
| `profile` | yes | `smoke`, `load`, or `stress`. |
| `stages` | no | Overrides the preset ramp. `duration` matches `^\d+(ms\|s\|m\|h)$`. |
| `thresholds` | no | k6 metric → array of expressions. Overrides the preset. |

Presets, if you omit `stages`/`thresholds`:

| Profile | Ramp | Default thresholds |
|---|---|---|
| `smoke` | 30s @ 5 VUs | `http_req_failed: rate<0.01`, `http_req_duration: p(95)<800` |
| `load` | 30s→50, 2m @ 50, 30s→0 | same |
| `stress` | 1m→100, 2m→200, 2m→300, 1m→0 | same |

Default to `"profile": "smoke"` with no overrides unless the user gave real
numbers. Inventing a 300-VU stress ramp against someone's staging environment is
not a neutral choice.

### What k6 actually runs

k6 has no browser. Charlie compiles the steps to an HTTP scenario:

| Step | Compiles to |
|---|---|
| `goto` | `GET` the URL |
| `fill` | a field in the next `submit` body (name derived from the selector) |
| `submit` | `POST` the collected fields to the current URL |
| `setHeader` | header on all later requests |
| `waitFor` with `ms` | think-time sleep after the previous request |
| `assert` with `text` | response-body `contains` check |
| `extract` with `regex` | capture from the response body into `{{vars.*}}` |
| `click`, `assert` state, `waitFor` selector, `extract` selector | **skipped**, reported as "not applicable" |

So a k6-targeted flow should be built from `goto` / `fill` / `submit` /
`setHeader`, assert with `text`, and extract with `regex`. If a journey only
makes sense with clicks, mark it `engines: ["playwright"]` and say so.

## Filename

`<name>.charlie-flows.json` — what Charlie's own export produces, so exports and
hand-written files look alike in a repo.
