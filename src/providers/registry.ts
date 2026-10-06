import { q1 } from "../core/db";
import { costEvent } from "../core/events";
import { spendGate } from "../core/spend";
import { decryptJson } from "../security/crypto";
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelRole,
} from "../core/types";
import { createAnthropicProvider } from "./anthropic";
import { createOpenAIProvider } from "./openai";
import { createOpenAICompatibleProvider } from "./compatible";
import { localDevProvider } from "./local";

export interface ProviderContext {
  userId: string;
  caseId?: string;
}

interface ConnectionRow {
  id: string;
  type: string;
  provider: string;
  label: string;
  status: string;
  config_enc: string | null;
  meta: string | null;
}

async function loadConnection(db: D1Database, userId: string): Promise<ConnectionRow | null> {
  return q1<ConnectionRow>(
    db,
    `SELECT * FROM connections WHERE user_id = ? AND type = 'model_provider' AND status = 'active'
     ORDER BY created_at DESC LIMIT 1`,
    userId,
  );
}

// Build a provider instance from a stored connection (decrypting its config),
// or fall back to the local deterministic provider for development/tests.
export async function resolveProvider(
  env: Env,
  ctx: ProviderContext,
): Promise<{ provider: ModelProvider; connectionId: string | null; isLocal: boolean }> {
  const conn = await loadConnection(env.DB, ctx.userId);
  if (!conn || !conn.config_enc || !env.SECRET_KEY) {
    return { provider: localDevProvider(), connectionId: null, isLocal: true };
  }
  const cfg = await decryptJson<Record<string, string>>(conn.config_enc, env.SECRET_KEY);
  switch (conn.provider) {
    case "openai":
      return { provider: createOpenAIProvider(cfg), connectionId: conn.id, isLocal: false };
    case "anthropic":
      return { provider: createAnthropicProvider(cfg), connectionId: conn.id, isLocal: false };
    case "openai_compatible":
      return { provider: createOpenAICompatibleProvider(cfg), connectionId: conn.id, isLocal: false };
    case "local_dev":
    default:
      return { provider: localDevProvider(), connectionId: conn.id, isLocal: true };
  }
}

// Routed model call: chooses provider, executes, records cost. The caller gets
// a response — never the credentials.
export async function runModel(
  env: Env,
  ctx: ProviderContext,
  request: ModelRequest,
): Promise<ModelResponse> {
  const { provider, isLocal } = await resolveProvider(env, ctx);
  // §11 abuse/cost gate — every non-local call must pass it before executing.
  await spendGate(env, { userId: ctx.userId, caseId: ctx.caseId }, isLocal);
  const resp = await provider.execute(request);
  await costEvent(env.DB, {
    caseId: ctx.caseId,
    kind: "model",
    provider: resp.providerId,
    model: resp.model,
    tokensIn: resp.tokensIn,
    tokensOut: resp.tokensOut,
    units: (resp.tokensIn ?? 0) + (resp.tokensOut ?? 0),
    unitKind: "tokens",
    costMicroUsd: resp.costMicroUsd,
    meta: { role: request.role, local: isLocal },
  });
  return resp;
}
