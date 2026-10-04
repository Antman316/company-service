import type {
  ModelCapabilities,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ProviderHealth,
} from "../core/types";

// OpenAI-compatible endpoint provider — covers local model servers (Ollama,
// llama.cpp, vLLM, LM Studio) and any third party exposing the
// /chat/completions shape. The customer supplies baseUrl + optional key +
// model name via Connections.

export function createOpenAICompatibleProvider(cfg: {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}): ModelProvider {
  const base = (cfg.baseUrl ?? "http://localhost:11434/v1").replace(/\/$/, "");
  const model = cfg.model ?? "llama3.1";
  const key = cfg.apiKey;
  return {
    id: "openai_compatible",
    async capabilities(): Promise<ModelCapabilities> {
      return { roles: ["light", "reasoning"], structuredOutput: false, vision: false, liveVerified: false };
    },
    async healthCheck(): Promise<ProviderHealth> {
      try {
        const r = await fetch(`${base}/models`, {
          headers: key ? { Authorization: `Bearer ${key}` } : {},
        });
        return { ok: r.ok, detail: r.ok ? "reachable" : `HTTP ${r.status}`, checkedAt: new Date().toISOString() };
      } catch (e) {
        return { ok: false, detail: `unreachable: ${String(e)}`, checkedAt: new Date().toISOString() };
      }
    },
    async execute(req: ModelRequest): Promise<ModelResponse> {
      const userText = [
        "USER AUTHORITY + CASE OBJECTIVE:\n" + req.userContext,
        req.untrustedContent ? "\n\n" + req.untrustedContent : "",
      ].join("");
      const r = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: userText },
          ],
          max_tokens: req.maxTokens ?? 1200,
        }),
      });
      if (!r.ok) throw new Error(`compatible endpoint error ${r.status}: ${await r.text()}`);
      const data = (await r.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      return {
        providerId: "openai_compatible",
        model,
        text: data.choices?.[0]?.message?.content ?? "",
        tokensIn: data.usage?.prompt_tokens,
        tokensOut: data.usage?.completion_tokens,
      };
    },
  };
}
