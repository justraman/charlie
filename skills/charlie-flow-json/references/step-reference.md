# Step reference

Every step is `{ "action": "<name>", ...fields }`. **Objects are strict**: an
unknown key fails the import with the exact path. There are nine actions and no
others.

## Fields every step may carry

| Field | Type | Meaning |
|---|---|---|
| `label` | string ≤ 200 | Human name shown in the editor and the run's step timeline. Use it on non-obvious steps. |
| `captureOnFail` | boolean | On failure, capture a screenshot (and trace) for this step. Worth setting on the assertion that defines the journey. E2E only. |
| `timeout` | integer ms, 1 – 600000 | Overrides the default timeout for this step. |

## Actions

### `goto` — navigate

```json
{ "action": "goto", "url": "/checkout" }
```

| Field | Required | Notes |
|---|---|---|
| `url` | yes | **Relative to the environment base URL.** An absolute URL is allowed but pins the flow to one environment — don't. |

Under Playwright: navigates and waits for `load`. Under k6: one `GET`.

### `click` — click an element

```json
{ "action": "click", "selector": "[data-test=\"add-to-cart\"]", "label": "add to cart" }
```

| Field | Required |
|---|---|
| `selector` | yes |

**Under k6 this step is skipped** and reported as "not applicable" — an HTTP
scenario has no DOM to click. A load flow must reach each URL with `goto`.

### `fill` — type into a field

```json
{ "action": "fill", "selector": "input[name=\"email\"]", "value": "{{secrets.TEST_EMAIL}}" }
```

| Field | Required | Notes |
|---|---|---|
| `selector` | yes | Prefer `input[name="..."]` — under k6 the field name for the form POST is derived from the selector. |
| `value` | yes | May be a literal, `{{secrets.NAME}}`, or `{{vars.NAME}}` from an earlier `extract`. |

Under k6: contributes one field to the body of the next `submit`.

### `submit` — submit a form

```json
{ "action": "submit", "selector": "form" }
```

| Field | Required | Notes |
|---|---|---|
| `selector` | yes | The **form** element, not the button. Charlie calls `requestSubmit()` on it. |

Under k6: `POST`s the fields collected by preceding `fill` steps to the current
URL. (The real form `action` is unknowable without a DOM — if the form posts
elsewhere, a load flow should `goto` that URL first.)

### `waitFor` — wait for an element or a fixed delay

```json
{ "action": "waitFor", "selector": "[data-test=\"results\"]" }
{ "action": "waitFor", "ms": 500 }
```

Exactly one of `selector` or `ms` is required (both may be given, but don't).

- `selector` — waits for the element to appear. Prefer this; it's the honest
  version of "wait for the page to settle". **Skipped under k6.**
- `ms` — a fixed sleep, 0 – 600000. Under k6 this becomes *think time* after the
  previous request, which is the one place a fixed wait is genuinely right.

Do not sprinkle `waitFor: {ms}` to paper over flakiness in an E2E flow — an
`assert` on the thing you're waiting for is both a wait and a check.

### `assert` — the check

```json
{ "action": "assert", "selector": "[data-test=\"order-total\"]", "state": "visible" }
{ "action": "assert", "text": "Order confirmed" }
```

| Form | Fields | Behaviour |
|---|---|---|
| DOM state | `selector` + `state` | `state` is one of `visible`, `hidden`, `attached`, `detached`. **Skipped under k6.** |
| Text | `text` | Passes if the response/page HTML contains the string. Works under **both** engines — under k6 it becomes a response-body `contains` check. |

Requires either `selector` **and** `state`, or `text`. A flow that never asserts
proves nothing; a load flow that asserts only DOM state checks nothing at all.

### `extract` — capture a value into a variable

```json
{ "action": "extract", "selector": "input[name=\"csrf\"]", "as": "csrf" }
{ "action": "extract", "regex": "name=\"csrf\" value=\"([^\"]+)\"", "as": "csrf" }
```

| Field | Required | Notes |
|---|---|---|
| `as` | yes | Variable name (`[A-Za-z_][A-Za-z0-9_]*`). Later steps read it as `{{vars.csrf}}`. |
| `selector` | one of | Reads the element's input value, else its text. **Skipped under k6.** |
| `regex` | one of | Applied to the page/response HTML; capture group 1 if present, else the whole match. **This is the k6-compatible form.** |

For a flow that must work under both engines, give `regex`.

### `setHeader` — set a request header for the rest of the flow

```json
{ "action": "setHeader", "name": "X-Feature-Flag", "value": "new-checkout" }
```

| Field | Required |
|---|---|
| `name` | yes |
| `value` | yes |

Applies to every subsequent request in the flow, on both engines. Use
`{{secrets.*}}` for anything credential-shaped (`"value": "Bearer {{secrets.API_TOKEN}}"`).

### `useFlow` — include another flow's steps here

```json
{ "action": "useFlow", "flow": "login", "label": "sign in" }
```

| Field | Required | Notes |
|---|---|---|
| `flow` | yes | The **name** of another steps flow — in this document, or already in the target project. |

Charlie inlines the referenced flow's *current* steps at this position when it
builds a run, so editing the shared flow updates every flow that includes it.

Rules: cannot reference itself, cannot reference a `code` flow, and cannot form
a cycle. `{"flowId": "..."}` is the storage form and is **rejected** in a
document.

## Placeholders

| Token | Resolved from | Available |
|---|---|---|
| `{{secrets.NAME}}` | The environment's encrypted secrets, decrypted on the runner. | Any step, in `url`, `value`, `text`, `name`. |
| `{{vars.NAME}}` | A value bound by an earlier `extract` in the same flow. | Steps *after* the `extract`. |

Only those four fields are placeholder-resolved — a placeholder inside a
`selector` stays literal.

If a `{{secrets.X}}` has no matching environment secret, the step fails at run
time with `Unresolved placeholder {{secrets.X}}`. Name secrets after what they
are (`TEST_EMAIL`, `TEST_PASSWORD`, `API_TOKEN`), and tell the user which ones
the document expects — Charlie also lists them in the import preview.
