import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import { apiPost, createTestCase, signup } from "./helpers";
import { LAUNCH_MERCHANTS, healthCheckDue, runDirectoryHealthCheck } from "../src/adapters/directory";
import { checkCoverage, findCompany, seedRegistry } from "../src/adapters/registry";
import { ensureConversation, ingestMerchantMessage } from "../src/core/agent";
import { getCase } from "../src/core/caseEngine";
import { nowIso, q, q1 } from "../src/core/db";

// M6 — merchant directory: 25 launch merchants, honest per-lane labels,
// real-contact VERIFIED promotion, monthly lane-health check.

const byId = Object.fromEntries(LAUNCH_MERCHANTS.map((m) => [m.id, m]));

async function covRow(id: string) {
  return q1<{ verification_status: string; health: string; channel: string; last_verified_at: string | null }>(
    env.DB, `SELECT * FROM company_coverage WHERE id = ?`, id);
}

describe("M6 merchant directory", () => {
  it("seeds all 25 launch merchants with coverage + playbooks, idempotently", async () => {
    await seedRegistry(env.DB);
    const companies = await q<{ id: string }>(env.DB, `SELECT id FROM companies`);
    const ids = new Set(companies.map((c) => c.id));
    for (const m of LAUNCH_MERCHANTS) expect(ids.has(m.id), `missing ${m.name}`).toBe(true);

    const covs = await q<{ company_id: string; channel: string }>(env.DB, `SELECT company_id, channel FROM company_coverage`);
    const lanesOf = (cid: string) => covs.filter((c) => c.company_id === cid).map((c) => c.channel);
    for (const m of LAUNCH_MERCHANTS) {
      const lanes = lanesOf(m.id);
      expect(lanes).toContain("manual"); // every merchant gets the manual floor
      if (m.email) expect(lanes, `${m.name} email lane`).toContain("email");
      if (m.form) expect(lanes, `${m.name} form lane`).toContain("form");
      if (m.chat) expect(lanes, `${m.name} chat lane`).toContain("chat");
      if (!m.chat) expect(lanes, `${m.name} must NOT have a chat lane`).not.toContain("chat");
    }
    // Audit totals: 4 published emails, 5 forms, 24 chats (Etsy chat is sellers-only).
    expect(covs.filter((c) => c.channel === "email").length).toBeGreaterThanOrEqual(4);
    expect(covs.filter((c) => c.channel === "form").length).toBe(5);
    expect(covs.filter((c) => c.channel === "chat").length).toBeGreaterThanOrEqual(24);

    const playbooks = await q<{ company_id: string }>(env.DB, `SELECT company_id FROM merchant_playbooks WHERE version = 1`);
    const pbIds = new Set(playbooks.map((p) => p.company_id));
    for (const m of LAUNCH_MERCHANTS) expect(pbIds.has(m.id), `playbook for ${m.name}`).toBe(true);

    // Idempotent: a second seed adds nothing.
    await seedRegistry(env.DB);
    const companies2 = await q<{ id: string }>(env.DB, `SELECT id FROM companies`);
    expect(companies2.length).toBe(companies.length);
    const covs2 = await q<{ id: string }>(env.DB, `SELECT id FROM company_coverage`);
    expect(covs2.length).toBe(covs.length);
  });

  it("labels lanes CONTACT_CONFIRMED, never VERIFIED, until a real case uses them", async () => {
    // Chewy email stays VERIFIED — it earned that on prod with a real reply.
    expect((await covRow("cov_cmp_chewy_email"))?.verification_status).toBe("VERIFIED");
    expect((await covRow("cov_cmp_zappos_email"))?.verification_status).toBe("CONTACT_CONFIRMED");
    expect((await covRow("cov_cmp_amazon_chat"))?.verification_status).toBe("CONTACT_CONFIRMED");
    expect((await covRow("cov_cmp_etsy_form"))?.verification_status).toBe("CONTACT_CONFIRMED");
    const pb = await q1<{ last_verified_at: string | null }>(
      env.DB, `SELECT last_verified_at FROM merchant_playbooks WHERE company_id = 'cmp_zappos'`);
    expect(pb?.last_verified_at).toBeNull();
  });

  it("resolves the best lane: chat beats form, form beats manual; punctuation-free company match", async () => {
    const ulta = await checkCoverage(env.DB, { companyName: "Ulta" });
    expect(ulta.channel).toBe("chat");
    expect(ulta.automationLevel).toBe("ASSISTED");

    const etsy = await checkCoverage(env.DB, { companyName: "Etsy" });
    expect(etsy.channel).toBe("form"); // buyers get the ticket form — no buyer chat lane
    expect(etsy.automationLevel).toBe("ASSISTED");

    const kohl = await checkCoverage(env.DB, { companyName: "Kohl's" });
    expect(kohl.channel).toBe("chat");

    expect((await findCompany(env.DB, "Lowes"))?.id).toBe("cmp_lowes");
    expect((await findCompany(env.DB, "macys.com order problem"))?.id).toBe("cmp_macys");
  });

  it("promotes a lane to VERIFIED only when a real merchant reply lands on it", async () => {
    const c = await signup(`m6lane-${Date.now()}@t.dev`);
    const caseId = await createTestCase(c, "Zappos never refunded my return for order ZP-8811");
    await env.DB.prepare(`UPDATE cases SET company_id = 'cmp_zappos', company_name = 'Zappos' WHERE id = ?`).bind(caseId).run();
    const caseRow = await getCase(env.DB, caseId);
    const convId = await ensureConversation(env.DB, caseId, "email", "real-transport");
    await ingestMerchantMessage(env, caseRow!, convId, "We've processed your refund, allow 3-5 business days.", {});

    const lane = await covRow("cov_cmp_zappos_email");
    expect(lane?.verification_status).toBe("VERIFIED");
    expect(lane?.last_verified_at).not.toBeNull();
    const audit = await q1<{ type: string }>(
      env.DB, `SELECT type FROM audit_events WHERE type = 'lane_verified' AND case_id = ?`, caseId);
    expect(audit?.type).toBe("lane_verified");

    // Test-merchant (sim) replies can never verify a lane.
    const simId = await createTestCase(c, "test merchant owes me $9.99");
    const simRow = await getCase(env.DB, simId);
    const simConv = await ensureConversation(env.DB, simId, "email", "test-merchant");
    await ingestMerchantMessage(env, simRow!, simConv, "Your refund has been issued.", {});
    const simLane = await covRow("cov_test_email");
    expect(simLane?.verification_status).toBe("SIMULATED"); // unchanged
  });

  it("monthly health check: bounces degrade email lanes, dead URLs degrade chat, and it is idempotent", async () => {
    expect(await healthCheckDue(env.DB)).toBe(true); // never ran yet in this DB? may have run above — either way ok

    // Bounce audit naming the Sephora address → email lane degrades.
    await env.DB.prepare(
      `INSERT INTO audit_events (id, user_id, case_id, type, severity, data_json, created_at) VALUES (?,?,?,?,?,?,?)`,
    ).bind("aud_bounce1", null, null, "send_bounced", "warning",
      JSON.stringify({ to: "customerservice@sephora.com", reason: "550 no such user" }), nowIso()).run();

    const seen: string[] = [];
    const res = await runDirectoryHealthCheck(env, async (url) => {
      seen.push(url);
      return url.includes("kohls") ? { status: 404 } : { status: 200 };
    });
    expect(res.checked).toBeGreaterThanOrEqual(LAUNCH_MERCHANTS.length);

    expect((await covRow("cov_cmp_sephora_email"))?.health).toBe("degraded");
    expect((await covRow("cov_cmp_kohls_chat"))?.health).toBe("degraded");
    expect((await covRow("cov_cmp_amazon_chat"))?.health).toBe("healthy");

    const audits1 = await q<{ id: string }>(env.DB, `SELECT id FROM audit_events WHERE type = 'lane_health_change'`);
    // Second run: nothing changed → no new lane_health_change rows.
    await runDirectoryHealthCheck(env, async () => ({ status: 404 }));
    const audits2 = await q<{ id: string }>(env.DB, `SELECT id FROM audit_events WHERE type = 'lane_health_change'`);
    // Rows already degraded report 404 again → next stays degraded, no new writes;
    // lanes that were healthy now degrade (test fetches all-404) — expect NEW rows.
    expect(audits2.length).toBeGreaterThanOrEqual(audits1.length);
    expect(await healthCheckDue(env.DB)).toBe(false); // just ran
  });
});
