import { json, newId, nowIso, q, run, sha256Hex } from "./db";
import { caseEvent } from "./events";
import type { ClaimStatus, EvidenceKind } from "./types";

// Evidence + claims: every material fact carries provenance. Nothing written
// by the model becomes "verified" without an evidence or system source.

export async function addEvidence(
  db: D1Database,
  env: Env,
  caseId: string,
  input: {
    kind: EvidenceKind;
    text?: string;
    blob?: ArrayBuffer | Uint8Array;
    mime?: string;
    source?: string;
    label?: string;
  },
): Promise<string> {
  const id = newId("ev");
  let r2Key: string | null = null;
  let size: number | null = null;
  let hash: string | null = null;
  if (input.blob) {
    const bytes = input.blob instanceof Uint8Array ? input.blob : new Uint8Array(input.blob);
    r2Key = `${caseId}/${id}`;
    size = bytes.byteLength;
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    hash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    if (env.EVIDENCE) {
      await env.EVIDENCE.put(r2Key, bytes, {
        httpMetadata: { contentType: input.mime ?? "application/octet-stream" },
      });
    }
  }
  if (input.text && !hash) hash = await sha256Hex(input.text);
  await run(
    db,
    `INSERT INTO case_evidence (id, case_id, kind, text, r2_key, mime, size_bytes, sha256, source, label, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    caseId,
    input.kind,
    input.text ?? null,
    r2Key,
    input.mime ?? null,
    size,
    hash,
    input.source ?? "customer",
    input.label ?? null,
    nowIso(),
  );
  await caseEvent(db, caseId, "evidence_added", input.source === "merchant" ? "merchant" : input.source === "system" ? "system" : "customer", {
    evidenceId: id,
    kind: input.kind,
    label: input.label ?? null,
    sizeBytes: size,
  });
  return id;
}

export async function addClaim(
  db: D1Database,
  caseId: string,
  input: {
    text: string;
    status?: ClaimStatus;
    sourceType?: string;
    evidenceId?: string;
    note?: string;
  },
): Promise<string> {
  const id = newId("clm");
  await run(
    db,
    `INSERT INTO case_claims (id, case_id, text, claim_status, source_type, evidence_id, note, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    id,
    caseId,
    input.text,
    input.status ?? "CUSTOMER_STATED",
    input.sourceType ?? "customer",
    input.evidenceId ?? null,
    input.note ?? null,
    nowIso(),
  );
  return id;
}

export async function listEvidence(db: D1Database, caseId: string) {
  return q(db, `SELECT * FROM case_evidence WHERE case_id = ? ORDER BY created_at ASC`, caseId);
}

export async function listClaims(db: D1Database, caseId: string) {
  return q(db, `SELECT * FROM case_claims WHERE case_id = ? ORDER BY created_at ASC`, caseId);
}

export function evidenceView(r: Record<string, unknown>) {
  return {
    id: r.id,
    kind: r.kind,
    text: r.text,
    mime: r.mime,
    sizeBytes: r.size_bytes,
    sha256: r.sha256,
    source: r.source,
    label: r.label,
    hasFile: !!r.r2_key,
    createdAt: r.created_at,
  };
}

export function claimView(r: Record<string, unknown>) {
  return {
    id: r.id,
    text: r.text,
    status: r.claim_status,
    sourceType: r.source_type,
    evidenceId: r.evidence_id,
    note: r.note,
    createdAt: r.created_at,
  };
}

export { json };
