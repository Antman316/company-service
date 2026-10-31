import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { apiGet, apiPost, createTestCase, dbOne, signup } from "./helpers";
import { backupRetentionDays, pruneExpiredBackups } from "../src/core/ops";
import opsMd from "../docs/OPS.md?raw";
import legalSrc from "../web/src/pages/Legal.tsx?raw";

// G-3 r2 — the backups/ keyspace is date+table partitioned, so post-delete
// retention is a whole-prefix purge bound to 30 days, not a per-account
// delete. These tests prove the purge exists, runs, is paginated and
// idempotent; that deleteAccount's audit record binds the disclosure to the
// code path; and that the disclosure sentence is present where served.

const DAY_MS = 24 * 3600 * 1000;
const dayAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);
const DISCLOSURE =
  "Deleted account data may persist in encrypted operational backups for up to 30 days, after which it is purged.";

async function seedBackupDay(day: string, objects: string[] = ["users.jsonl", "manifest.json"]) {
  for (const name of objects) {
    await env.EVIDENCE.put(`backups/${day}/${name}`, JSON.stringify({ seeded: day }) + "\n");
  }
}

async function backupKeys(): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.EVIDENCE.list({ prefix: "backups/", limit: 1000, cursor });
    for (const o of page.objects ?? []) keys.push(o.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

const staleCount = async () =>
  (await backupKeys()).filter((k) => k.slice("backups/".length, "backups/".length + 10) < dayAgo(30)).length;

describe("backup retention is bounded (G-3 r2)", () => {
  it("prunes days older than 30 (objects + manifest), keeps day-29/day-0, audits once, idempotent", async () => {
    const [d45, d31, d29, d0] = [dayAgo(45), dayAgo(31), dayAgo(29), dayAgo(0)];
    for (const d of [d45, d31, d29, d0]) await seedBackupDay(d);
    const expectedStale = await staleCount();
    expect(expectedStale).toBeGreaterThanOrEqual(4); // our seeded d45+d31 objects
    const auditsBefore = await dbOne<{ n: number }>(`SELECT COUNT(*) n FROM audit_events WHERE type = 'backup_pruned'`);

    const r1 = await pruneExpiredBackups(env);
    expect(r1.pruned).toBe(expectedStale);
    expect(r1.retentionDays).toBe(30);
    expect(r1.days).toEqual(expect.arrayContaining([d45, d31]));

    const remaining = await backupKeys();
    expect(remaining.filter((k) => k.startsWith(`backups/${d45}/`) || k.startsWith(`backups/${d31}/`))).toEqual([]);
    expect(remaining).toEqual(
      expect.arrayContaining([`backups/${d29}/manifest.json`, `backups/${d29}/users.jsonl`, `backups/${d0}/manifest.json`, `backups/${d0}/users.jsonl`]),
    );
    // nothing below the cutoff survives anywhere in the prefix
    expect(await staleCount()).toBe(0);

    // one audit event with counts per purge run
    const auditsAfter = await dbOne<{ n: number }>(`SELECT COUNT(*) n FROM audit_events WHERE type = 'backup_pruned'`);
    expect((auditsAfter?.n ?? 0) - (auditsBefore?.n ?? 0)).toBe(1);
    const audit = await dbOne<{ data_json: string }>(
      `SELECT data_json FROM audit_events WHERE type = 'backup_pruned' ORDER BY created_at DESC LIMIT 1`,
    );
    const data = JSON.parse(audit!.data_json) as { pruned: number; retentionDays: number };
    expect(data.pruned).toBe(expectedStale);
    expect(data.retentionDays).toBe(30);

    // second run deletes zero
    const r2 = await pruneExpiredBackups(env);
    expect(r2.pruned).toBe(0);
    expect(await backupKeys()).toEqual(remaining);
  });

  it("paginates the prefix and chunked deletes across >1000 stale objects", async () => {
    const d40 = dayAgo(40);
    const preStale = await staleCount();
    const N = 1050; // forces ≥2 list pages and ≥2 delete calls at the 1000 cap
    for (let i = 0; i < N; i += 150) {
      await Promise.all(
        Array.from({ length: Math.min(150, N - i) }, (_, j) =>
          env.EVIDENCE.put(`backups/${d40}/bulk/t${String(i + j).padStart(4, "0")}.jsonl`, "x"),
        ),
      );
    }
    const keep = `backups/${dayAgo(0)}/keep.jsonl`;
    await env.EVIDENCE.put(keep, "x");

    const r = await pruneExpiredBackups(env);
    expect(r.pruned).toBe(preStale + N);

    const remaining = await backupKeys();
    expect(remaining.filter((k) => k.startsWith(`backups/${d40}/`))).toEqual([]);
    expect(remaining).toContain(keep);
    expect(await staleCount()).toBe(0);
  });
});

describe("deleteAccount binds the disclosure (G-3 r2)", () => {
  it("records one account_deleted audit event carrying backup_retention_days", async () => {
    const c = await signup("retention-audit@test.dev");
    const uid = (await apiGet(c, "/api/auth/me")).body.user.id as string;
    await createTestCase(c, "test merchant owes me $5.00");
    const r = await apiPost(c, "/api/account/delete", { confirm: "DELETE" });
    expect(r.status).toBe(200);

    const row = await dbOne<{ user_id: string | null; data_json: string }>(
      `SELECT user_id, data_json FROM audit_events WHERE type = 'account_deleted' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(row).toBeTruthy();
    // user_id NULL — written after the batch whose audit_events wipe would
    // otherwise destroy it
    expect(row!.user_id).toBeNull();
    const data = JSON.parse(row!.data_json) as { user_id: string; backup_retention_days: number };
    expect(data.user_id).toBe(uid);
    expect(data.backup_retention_days).toBe(backupRetentionDays(env));
    expect(data.backup_retention_days).toBe(30);

    // the wipe itself is unchanged: no surviving audit rows keyed to the user
    const orphans = await dbOne<{ n: number }>(`SELECT COUNT(*) n FROM audit_events WHERE user_id = ?`, uid);
    expect(orphans?.n ?? 0).toBe(0);
    expect((await apiGet(c, "/api/auth/me")).status).toBe(401);
  });
});

describe("backup persistence is disclosed (G-3 r2)", () => {
  it("the sentence is present in docs/OPS.md and the customer-facing Privacy page", () => {
    expect(opsMd).toContain(DISCLOSURE);
    expect(legalSrc).toContain(DISCLOSURE);
  });
});
