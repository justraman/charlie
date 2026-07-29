# Authoring good flows

A document that validates is the low bar. This is how to write one that a QA
engineer keeps.

## Selectors, in order of preference

| Prefer | Why |
|---|---|
| `[data-test="add-to-cart"]` / `[data-testid=...]` | Exists to be selected. Survives restyling and copy changes. |
| `input[name="email"]` | Stable, semantic, and the only form Charlie can map to a form field under k6. |
| `#checkout-form` | Stable if the id is real (not framework-generated like `#r1a_9`). |
| `text=Place order`, `role=button[name="Place order"]` | Reads like the user's intent. Breaks on copy changes and i18n. |
| `.btn.primary`, `div > div:nth-child(3) > span` | Last resort. Assume it breaks next sprint. |

If you are generating from an app's source or a live page, **use the selectors
that are actually there**. If you're working from a written test case with no
markup available, say which selectors you guessed and flag them with a `label`
so the engineer knows where to look:

```json
{ "action": "click", "selector": "[data-test=\"place-order\"]", "label": "GUESSED selector — verify" }
```

Never invent a `data-test` attribute and present it as fact.

## Secrets

Any credential, token, or account identifier is an environment secret:

```json
{ "action": "fill", "selector": "input[name=\"email\"]", "value": "{{secrets.TEST_EMAIL}}" }
```

- Name them for what they are: `TEST_EMAIL`, `TEST_PASSWORD`, `API_TOKEN`.
- Reuse the same name across flows — one secret, many references.
- List the names you used when you hand the file over, so the environment can be
  set up before the first run. (Charlie's import preview lists them too.)
- Non-secret test data (a search term, a quantity, a product slug) is a plain
  literal. Don't turn everything into a placeholder.

## Assertions

The assertion is the test. Everything before it is setup.

- End every flow with at least one `assert`.
- Assert the thing that proves the journey succeeded — an order number, a
  confirmation, the item in the cart — not that the page loaded.
- Prefer asserting a `data-test` element's `visible` state over matching prose;
  prose changes.
- Assert the *absence* of the failure path where it's cheap:
  `{"action": "assert", "selector": "[data-test=\"error\"]", "state": "hidden"}`.
- Put `"captureOnFail": true` on the decisive assertion so a failed run comes
  with a screenshot.

## Waiting

Charlie's Playwright steps already wait for elements. So:

- To wait for something, `assert` it — that's a wait *and* a check.
- Use `waitFor` with `selector` when you need to wait but not check.
- Use `waitFor` with `ms` only as k6 think-time, or for a genuinely timed
  behaviour (a debounce, a polling interval you're testing).
- A fixed `ms` wait added to fix flakiness is a flaky test with a longer runtime.

## Flow size and factoring

- One flow = one journey a person could describe in a sentence. "Log in and
  check out" is two flows composed with `useFlow`.
- If two flows share more than about three leading steps, factor them out.
- 5–20 steps is typical. Fifty steps means the journey should be split.
- Name flows after the journey (`guest-checkout`, `password-reset`), not the
  page (`page-1`).

## Both engines

If the user wants the same journey load-tested, check the compilation table in
`document-format.md` first. In practice a dual-engine flow means:

- Navigate with `goto` for every page — not by clicking links.
- Assert with `text`, not DOM state.
- Extract with `regex`, not selectors.
- Target form fields as `input[name="..."]` so the POST body is right.

If the journey can't be expressed that way, keep it Playwright-only and write a
*separate* k6 flow for the HTTP path that matters. A flow marked `k6` whose
steps all compile away runs, passes, and measures nothing — worse than no load
test at all.

## Before you hand it over — checklist

- [ ] Valid JSON, `"format": "charlie.flows/v1"`, at least one flow.
- [ ] No key outside the documented set (strict objects reject the whole file).
- [ ] Every `url` relative — no `https://…` host anywhere.
- [ ] No literal credentials; every one is `{{secrets.NAME}}`.
- [ ] Every `{{vars.X}}` is bound by an `extract` **earlier in the same flow**.
- [ ] Flow names unique in the document; every `useFlow.flow` resolves; no cycles.
- [ ] Every flow ends in a meaningful `assert`.
- [ ] `loadProfile` only on flows listing `k6`, and their steps survive
      compilation.
- [ ] Guessed selectors are labelled as guesses.
- [ ] You told the user which environment secrets the document needs.
