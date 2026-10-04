import { q, q1 } from "../core/db";
import type {
  CompanyAdapter,
  CoverageQuery,
  CoverageResult,
} from "../core/types";
import { testMerchantAdapter } from "./testMerchant";

// ---------------------------------------------------------------------------
// Coverage registry + adapter directory.
// Coverage is per company + issue type + channel, with an explicit
// verification status. "Amazon" is never globally "supported".
// ---------------------------------------------------------------------------

const ADAPTERS: Record<string, CompanyAdapter> = {
  "test-merchant": testMerchantAdapter(),
};

export function getAdapter(adapterId: string): CompanyAdapter | null {
  return ADAPTERS[adapterId] ?? null;
}

export function listAdapterIds(): string[] {
  return Object.keys(ADAPTERS);
}

interface CoverageRow {
  id: string;
  company_id: string;
  country: string;
  issue_type: string;
  channel: string;
  auth_requirements: string | null;
  automation_level: string;
  limitations: string | null;
  verification_status: string;
  last_verified_at: string | null;
  adapter_version: string | null;
  health: string;
  notes: string | null;
}

interface CompanyRow {
  id: string;
  name: string;
  domains: string | null;
  adapter_id: string | null;
}

export async function findCompany(db: D1Database, name: string): Promise<CompanyRow | null> {
  const norm = name.trim().toLowerCase();
  const rows = await q<CompanyRow>(db, `SELECT * FROM companies`);
  return (
    rows.find(
      (c) =>
        c.name.toLowerCase() === norm ||
        // Loose substring matching only for non-trivial names — otherwise "a"
        // or "on" would match every company and fabricate coverage.
        (norm.length >= 3 && c.name.toLowerCase().includes(norm)) ||
        norm.includes(c.name.toLowerCase()),
    ) ?? null
  );
}

// Resolve the best supported route for a case. Route priority per spec:
// official API > authorized MCP > protocol > email > browser > computer use >
// manual handoff.
const ROUTE_PRIORITY = ["api", "mcp", "protocol", "email", "chat", "computer", "manual"];

export async function checkCoverage(
  db: D1Database,
  query: CoverageQuery,
): Promise<CoverageResult> {
  const company = query.companyId
    ? await q1<CompanyRow>(db, `SELECT * FROM companies WHERE id = ?`, query.companyId)
    : query.companyName
      ? await findCompany(db, query.companyName)
      : null;

  if (!company) {
    return {
      coverage: "uncovered",
      automationLevel: "UNSUPPORTED",
      verificationStatus: "UNVERIFIED",
      reason: "no registered company matches; only assisted/manual handling is possible",
    };
  }

  const covs = await q<CoverageRow>(
    db,
    `SELECT * FROM company_coverage WHERE company_id = ? AND (issue_type = ? OR issue_type = 'any')`,
    company.id,
    query.issueType ?? "any",
  );

  const usable = covs.filter(
    (c) => c.automation_level === "AUTOMATED" || c.automation_level === "ASSISTED",
  );
  usable.sort(
    (a, b) => ROUTE_PRIORITY.indexOf(a.channel) - ROUTE_PRIORITY.indexOf(b.channel),
  );

  const best = usable[0];
  if (!best) {
    return {
      coverage: "uncovered",
      automationLevel: "UNSUPPORTED",
      verificationStatus: "UNVERIFIED",
      adapterId: company.adapter_id ?? undefined,
      reason: `no automated or assisted channel for ${company.name} on this issue type`,
    };
  }

  return {
    coverage: best.automation_level === "AUTOMATED" ? "covered" : "assisted",
    automationLevel: best.automation_level as CoverageResult["automationLevel"],
    verificationStatus: best.verification_status as CoverageResult["verificationStatus"],
    adapterId: company.adapter_id ?? undefined,
    channel: best.channel,
    limitations: best.limitations ?? undefined,
    reason: `${company.name} via ${best.channel} (${best.automation_level}, ${best.verification_status})`,
  };
}

// Seed data for V1: the deterministic test merchant (SIMULATED) and honest
// UNVERIFIED/ASSISTED entries for real retailers — we do not claim real
// retailer automation.
export async function seedRegistry(db: D1Database): Promise<void> {
  const existing = await q<{ id: string }>(db, `SELECT id FROM companies LIMIT 1`);
  if (existing.length > 0) return;

  const testCo = "cmp_testmerchant";
  await db
    .prepare(`INSERT INTO companies (id, name, domains, adapter_id, notes) VALUES (?,?,?,?,?)`)
    .bind(
      testCo,
      "Test Merchant",
      JSON.stringify(["test-merchant.demo"]),
      "test-merchant",
      "Deterministic simulated merchant for V1 verification. DEMO fixture.",
    )
    .run();

  const cov = db.prepare(
    `INSERT INTO company_coverage (id, company_id, issue_type, channel, auth_requirements, automation_level, limitations, verification_status, adapter_version, health, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const channel of ["email", "chat"]) {
    await cov
      .bind(
        `cov_test_${channel}`,
        testCo,
        "any",
        channel,
        "none (simulation)",
        "AUTOMATED",
        "Simulation only — not a real merchant.",
        "SIMULATED",
        "test-merchant@1.0.0",
        "healthy",
        "DEMO fixture used for end-to-end verification.",
      )
      .run();
  }

  // Honest entries for real companies: nothing is claimed automated.
  const real: { id: string; name: string; domains: string[] }[] = [
    { id: "cmp_amazon", name: "Amazon", domains: ["amazon.com"] },
    { id: "cmp_walmart", name: "Walmart", domains: ["walmart.com"] },
    { id: "cmp_target", name: "Target", domains: ["target.com"] },
  ];
  for (const c of real) {
    await db
      .prepare(`INSERT INTO companies (id, name, domains, adapter_id, notes) VALUES (?,?,?,?,?)`)
      .bind(c.id, c.name, JSON.stringify(c.domains), null, "Real company — no verified integration in V1.")
      .run();
    await cov
      .bind(
        `cov_${c.id}_manual`,
        c.id,
        "any",
        "manual",
        "customer-managed account",
        "MANUAL_HANDOFF",
        "No verified automated channel. Company Service can draft communications and guide the customer.",
        "UNVERIFIED",
        null,
        "unknown",
        "Manual handoff only.",
      )
      .run();
  }
}
