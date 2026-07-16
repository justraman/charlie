# AI-Assisted Flow Generation

Charlie can draft the first version of a flow by reading a web app's source code, so a QA engineer reviews and refines instead of starting from an empty editor. This is assistive, not autonomous: AI output is always a **draft flow** a human approves before it becomes the current version.

## Provider abstraction (bring your own key)

AI is pluggable. An `AiProvider` interface has adapters for:

- **Anthropic Claude** — strong at large-context code reading; needs an API key.
- **OpenAI** — GPT models; needs an API key.
- **Cloudflare Workers AI** — stays inside Cloudflare, no external key, weaker on large-context analysis.

```ts
interface AiProvider {
  name: "anthropic" | "openai" | "workers_ai";
  analyzeRepo(input: RepoAnalysisInput): Promise<FlowDraft[]>;
}
```

Provider + model + (encrypted) API key are stored per org in `ai_providers`; an admin configures them in Settings. The default provider is `organization.default_ai_provider_id`.

## Where analysis runs

Repo analysis is **not** done in the Worker — cloning a repo and running a large-context model exceeds Worker CPU/time limits. Instead it runs as a dedicated **GitHub Actions job** (an `ai-analyze` workflow, dispatched like a run):

1. The job checks out the target `source_repo` at a ref (installation token, `contents: read`).
2. A lightweight static pass extracts candidate surfaces: routes/pages, forms and their fields, links/buttons with test ids, API calls, and framework hints (Next.js/React Router/Vue Router/etc.). This keeps the prompt focused and cheap.
3. The extracted structure (not the whole repo) plus targeted file excerpts are sent to the configured provider with a **structured-output contract**: the model must return `FlowDraft[]` matching Charlie's flow JSON schema.
4. The job POSTs the drafts back to `POST /api/projects/:id/flow-drafts` (run-token auth). The Worker validates them against the flow schema and stores them as `origin = "ai"`, `status = "draft"`.

Doing the heavy work on GitHub keeps the Worker fast and reuses the same dispatch/callback plumbing as test runs.

## From draft to flow

1. QA opens **Flows → Suggested** and sees AI drafts (e.g. "login", "signup", "checkout", "search") with the reasoning and the source references the model used.
2. QA edits in the flow editor (fix selectors, add assertions, set secrets placeholders), then **Approve**, which creates `flow_version` v1 authored by that user (the AI is credited in `origin`/`diff_summary`, but a human owns the approved version — important for the audit trail).
3. Approved flows run like any other.

## Prompt & safety contract

- **Structured output only.** The provider is constrained to emit valid `FlowStep[]`; malformed output is rejected and retried, never executed blind.
- **No secrets to the model.** Environment secrets are never sent; the model emits `{{secrets.NAME}}` placeholders that a human wires up.
- **Read-only source.** The App has `contents: read`; the AI path can never write to the source repo.
- **Selector preference.** The model is instructed to prefer stable selectors (`data-test`, `aria`, roles) over brittle CSS/nth-child, and to flag where it guessed.
- **Human gate.** Drafts cannot be scheduled or run until approved by an `editor`+.

## Scope boundaries

The AI feature drafts **navigation + interaction skeletons and assertions** from source. It does not invent test data, does not decide load profiles (QA picks `smoke`/`load`/`stress`), and does not self-approve. It lowers the cost of the first draft; correctness stays with the engineer.

## Cost & configurability

Because provider and model are per-org config, teams control spend and data-handling (e.g. keep everything in Workers AI to avoid sending code to a third party, or use Claude/OpenAI for higher-quality drafts). Analysis is on-demand (triggered per project/ref), not continuous, so there is no background token burn.
