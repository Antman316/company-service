import type {
  ModelCapabilities,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ProviderHealth,
} from "../core/types";

// Anthropic provider via the official Messages API. IMPLEMENTED — live
// verification requires a customer-provided API key via Connections.
// Consumer Claude subscriptions do NOT confer API access and are never used.

const ROLE_MODELS = {
  light: "claude-haiku-4-5",
  reasoning: "claude-sonnet-4-5",
  vision: "claude-haiku-4-5",
} as const;

export function createAnthropicProvider(cfg: { apiKey?: string; baseUrl?: string }): ModelProvider {
  const base = (cfg.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
  const key = cfg.apiKey;
  return {
    id: "anthropic",
    async capabilities(): Promise<ModelCapabilities> {
      return { roles: ["light", "reasoning", "vision"], structuredOutput: true, vision: true, liveVerified: false };
    },
    async healthCheck(): Promise<ProviderHealth> {
      return {
        ok: !!key,
        detail: key ? "key configured (not pinged)" : "no API key configured",
        checkedAt: new Date().toISOString(),
      };
    },
    async execute(req: ModelRequest): Promise<ModelResponse> {
      if (!key) throw new Error("Anthropic provider has no API key");
      const model = ROLE_MODELS[req.role] ?? ROLE_MODELS.light;
      const userText = [
        "USER AUTHORITY + CASE OBJECTIVE:\n" + req.userContext,
        req.untrustedContent ? "\n\n" + req.untrustedContent : "",
      ].join("");
      const userContent: unknown[] = [{ type: "text", text: userText }];
      for (const img of req.images ?? []) {
        userContent.push({
          type: "image",
          source: { type: "base64", media_type: img.mime, data: img.dataBase64 },
        });
      }
      const r = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          system: req.system,
          messages: [{ role: "user", content: userContent }],
          max_tokens: req.maxTokens ?? 1200,
        }),
      });
      if (!r.ok) throw new Error(`Anthropic API error ${r.status}: ${await r.text()}`);
      const data = (await r.json()) as {
        content?: { type: string; text?: string }[];
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const text = (data.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
      return {
        providerId: "anthropic",
        model,
        text,
        tokensIn: data.usage?.input_tokens,
        tokensOut: data.usage?.output_tokens,
      };
    },
  };
}
