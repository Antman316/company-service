# Provider Architecture

## Interface (`core/types.ts`)

```ts
interface ModelProvider {
  id: string;
  capabilities(): Promise<ModelCapabilities>;
  execute(request: ModelRequest): Promise<ModelResponse>;
  healthCheck(): Promise<ProviderHealth>;
}
```

`ModelRequest`: `task` (`classify|extract|plan|compose|interpret|vision`),
`system` (policy), `objective`/`context` (trusted case data), `untrusted`
(fenced external content), `json` (structured output requested).

Nothing outside the providers directory knows which model produced a result.

## Providers

| id | Status | Notes |
|---|---|---|
| `local_dev` | **VERIFIED** | Deterministic extractor/composer used for dev, tests, and the demo. No credentials. Clearly labeled in Connections. |
| `openai` | IMPLEMENTED — NOT LIVE-VERIFIED | BYO API key via `openai/chat-completions` style execute; no org key exists, so no live call has been made. |
| `anthropic` | IMPLEMENTED — NOT LIVE-VERIFIED | BYO API key, `/v1/messages`. Same caveat. |
| `openai_compatible` | IMPLEMENTED — NOT LIVE-VERIFIED | BYO base URL + key + model for OpenAI-compatible endpoints and local model servers. |

**Deliberately not built:** scraping ChatGPT.com/Claude.ai, treating a consumer
subscription as an inference API, or any non-provider-supported mechanism.

## Connections

Customers attach providers in `/connections` (`POST /api/connections`
`{type:"model", provider, config}`). Secrets are AES-GCM-encrypted into
`connections.config_enc` (`SECRET_KEY`), never logged, never sent to the
model. `POST /api/connections/:id/test` runs `healthCheck()` and reports
`{ok, detail}` honestly — an unreachable key is shown as failing, not green.

## Task routing (V1)

Provider resolution: the case's owner → their `model` connection → else
`local_dev`. Each `ModelRequest.task` tags the work (classify / extract /
plan / compose / interpret / vision) so a future tiered router can map light
tasks to cheap models; deterministic code still handles money math, dates,
auth checks, state transitions, dedup — no model involvement.

## Structured output

Providers return `{text, json?, usage?}`. `local_dev` always returns
schema-conformant JSON for `extract`/`plan`/`interpret`; real providers get
`json: true` + instruction to reply in JSON, and the agent falls back safely
when `json` is absent (plans are re-derived deterministically rather than
hallucinated into actions).

## Prompt-injection boundary

`security/injection.ts` separates SYSTEM POLICY / USER AUTHORITY / CASE
OBJECTIVE / UNTRUSTED EXTERNAL CONTENT into distinct request fields — no
single concatenated prompt — plus `detectInjection` pattern screening on every
external text before it reaches `untrusted` (hits → `audit_events`
`prompt_injection` + the content is neutralized, not executed).
