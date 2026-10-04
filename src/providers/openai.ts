import type {
  ModelCapabilities,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ProviderHealth,
} from "../core/types";

// OpenAI provider via the official Chat Completions API. IMPLEMENTED — live
// verification requires a customer-provided API key via Connections (BYO
// credentials). Consumer ChatGPT subscriptions do NOT confer API access and
// are never used here.

const ROLE_MODELS = {
  light: "gpt-4.1-mini",
  reasoning: "gpt-4.1",
  vision: "gpt-4.1-mini",
} as const;

export function createOpenAIProvider(cfg: { apiKey?: string; baseUrl?: string }): ModelProvider {
  const base = (cfg.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const key = cfg.apiKey;
  return {
    id: "openai",
    async capabilities(): Promise<ModelCapabilities> {
      return { roles: ["light", "reasoning", "vision"], structuredOutput: true, vision: true, liveVerified: false };
    },
    async healthCheck(): Promise<ProviderHealth> {
      if (!key) return { ok: false, detail: "no API key configured", checkedAt: new Date().toISOString() };
      try {
        const r = await fetch(`${base}/models`, {
          headers: { Authorization: `Bearer ${key}` },
        });
        return { ok: r.ok, detail: r.ok ? "reachable" : `HTTP ${r.status}`, checkedAt: new Date().toISOString() };
      } catch (e) {
        return { ok: false, detail: `unreachable: ${String(e)}`, checkedAt: new Date().toISOString() };
      }
    },
    async execute(req: ModelRequest): Promise<ModelResponse> {
      if (!key) throw new Error("OpenAI provider has no API key");
      const model = ROLE_MODELS[req.role] ?? ROLE_MODELS.light;
      const userText = [
        "USER AUTHORITY + CASE OBJECTIVE:\n" + req.userContext,
        req.untrustedContent ? "\n\n" + req.untrustedContent : "",
      ].join("");
      const body: Record<string, unknown> = {
        model,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: userText },
        ],
        max_tokens: req.maxTokens ?? 1200,
      };
      if (req.responseFormat === "json") body.response_format = { type: "json_object" };
      const r = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`OpenAI API error ${r.status}: ${await r.text()}`);
      const data = (await r.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      return {
        providerId: "openai",
        model,
        text: data.choices?.[0]?.message?.content ?? "",
        tokensIn: data.usage?.prompt_tokens,
        tokensOut: data.usage?.completion_tokens,
      };
    },
  };
}
