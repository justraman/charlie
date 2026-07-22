# Test Engines & Flow Format

Charlie authors a flow **once** and runs it two ways: as a Playwright **E2E** test (correctness) or as a k6 **HTTP load** scenario (behaviour under concurrency). This document defines the flow format, the shared engine abstraction, and how each engine consumes a flow.

> **Two kinds of flow.** Everything below describes a **`steps`** flow — the
> engine-agnostic JSON that compiles to Playwright *or* k6. A flow can instead be
> a **`code`** flow: a pointer to real Playwright test files in a GitHub repo, for
> journeys too complex to express as steps. Code flows are Playwright-only and are
> covered in [CUSTOM_TESTS.md](CUSTOM_TESTS.md); the rest of this document is about
> steps flows.

## The flow format

A flow is engine-agnostic JSON: metadata plus an ordered list of steps. It is stored immutably per version in `flow_versions.steps`.

```jsonc
{
  "name": "checkout",
  "description": "Guest adds item to cart and completes checkout",
  "engines": ["playwright", "k6"],
  "steps": [
    { "action": "goto", "url": "/products/42" },
    { "action": "waitFor", "selector": "[data-test=add-to-cart]" },
    { "action": "click", "selector": "[data-test=add-to-cart]" },
    { "action": "goto", "url": "/cart" },
    { "action": "assert", "selector": "[data-test=line-item]", "state": "visible" },
    { "action": "click", "selector": "[data-test=checkout]" },
    { "action": "fill", "selector": "#email", "value": "{{secrets.TEST_EMAIL}}" },
    { "action": "click", "selector": "[data-test=place-order]" },
    { "action": "assert", "selector": "[data-test=order-confirmation]", "state": "visible",
      "captureOnFail": true }
  ],
  "loadProfile": {
    "profile": "load",
    "stages": [
      { "duration": "30s", "target": 50 },
      { "duration": "2m", "target": 50 },
      { "duration": "30s", "target": 0 }
    ],
    "thresholds": {
      "http_req_failed": ["rate<0.01"],
      "http_req_duration": ["p(95)<800"]
    }
  }
}
```

### Step actions (initial set)

| action | fields | E2E | k6 |
|---|---|:--:|:--:|
| `goto` | `url` (relative to env `base_url`) | navigate | HTTP GET, follow redirects |
| `click` | `selector` | click element | (no-op; navigation edges inferred) |
| `fill` | `selector`, `value` | type into field | contributes to form POST body |
| `waitFor` | `selector` \| `ms` | wait for element/time | think-time sleep |
| `assert` | `selector`, `state` \| `text` | expect condition | status/response-body check |
| `extract` | `selector` \| `regex`, `as` | read value into vars | capture token/CSRF for later requests |
| `submit` | `selector` (form) | submit form | HTTP POST with collected fields |
| `setHeader` | `name`, `value` | set on context | set on request |

Placeholders `{{secrets.NAME}}` and `{{vars.NAME}}` are resolved at runtime from the environment's decrypted secrets and from `extract`ed values. Secrets are injected on the compute plane only.

`captureOnFail: true` triggers screenshot + trace capture (E2E) on that step's failure.

## Engine abstraction

Both engines implement a small adapter so the **step executor** is shared and engine-agnostic — the pattern the reference project used to avoid divergence:

```ts
interface EngineAdapter {
  goto(url: string): Promise<void>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  waitFor(target: WaitTarget): Promise<void>;
  assert(check: AssertSpec): Promise<AssertResult>;
  extract(spec: ExtractSpec): Promise<string>;
  captureArtifacts(reason: string): Promise<ArtifactRefs>;
}
```

The executor iterates `steps`, dispatches each to a handler in an `actionRegistry`, and emits structured events (`step-start`, `step-end`, `error`). Adding a new action means adding one handler, not editing both engines.

Shared code lives in a `@charlie/flow-core` package; the k6 build bundles it (k6 cannot import arbitrary Node modules at runtime, so entrypoints are pre-bundled with esbuild into plain JS, exactly as the reference project does).

## Playwright (E2E)

- One browser context per shard (matrix job). E2E runs are typically 1–few shards; sharding splits *flows*, not virtual users.
- Executes the flow directly against `base_url`.
- Captures, on failure (or when `captureOnFail`): screenshot, video (optional), and a Playwright trace. Uploaded to R2 via presigned URL.
- Extracts web-vitals-style timings (LCP/TTFB/CLS where available) and per-step durations.
- Collects **runtime issues**: console errors/warnings, failed `fetch`/XHR/WebSocket, and unhandled rejections — captured before/around app load — so a passing journey can still surface what the browser had to survive. (Reused conceptually from the reference project's runtime-issue collector.)
- Result: per-flow pass/fail, failing step, duration, artifacts, runtime issues.

## k6 (HTTP load)

- Protocol-level. k6 drives many VUs per runner, so a load run uses **few matrix jobs × many VUs**, sized by `loadProfile`. (Contrast with E2E, where 1 shard ≈ 1 browser.)
- The flow's `goto`/`submit`/`extract` steps compile into an HTTP scenario: navigations become requests, `fill` fields become form bodies, `extract` pulls CSRF tokens/session cookies out of responses for subsequent requests, `waitFor(ms)` becomes think-time.
- `loadProfile.stages` drive the ramp; `loadProfile.thresholds` decide pass/fail (e.g. `p(95)<800`, `http_req_failed rate<0.01`).
- Emits the standard k6 end-of-test summary (RPS, p50/p95/p99, error rate, data transferred) as JSON, plus per-check results. Uploaded to R2; headline metrics denormalized into `reports.load_summary`.
- Clicks and DOM assertions that have no HTTP analogue are skipped in k6 mode and reported as "not applicable in load mode," so the flow's *intent* still maps cleanly.

## Profiles

`profile` is a named load shape so QA can say "run checkout as a stress test":

| profile | intent | typical shape |
|---|---|---|
| `smoke` | does it work at all | 1–5 VUs, short |
| `load` | expected peak | ramp to target, hold, ramp down |
| `stress` | find the breaking point | ramp beyond target until thresholds break |

Profiles are defaults; a flow's `loadProfile` can override stages/thresholds.

## Recorder (later phase)

A browser-extension recorder (mirroring the reference project) captures clicks/inputs/navigations into `CapturedStep`s and posts them to Charlie to seed a flow. This is complementary to AI flow-gen: the recorder captures *what a human did*, the AI drafts *what should be tested* from source. Both produce the same flow JSON.

## Pass/fail semantics

- **E2E:** a flow passes if every step's assertions pass and no step errors.
- **k6:** a run passes if all `thresholds` hold. Runtime issues and non-threshold checks are reported but do not, on their own, fail a load run — matching the reference project's stance that pass/fail answers "did the scripted journey complete," while diagnostics explain what happened along the way.
