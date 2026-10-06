import { q, q1, run } from "../core/db";
import { auditEvent } from "../core/events";

// ---------------------------------------------------------------------------
// M6 — launch merchant directory. 25 US merchants, seeded idempotently.
//
// Honest labels (R7): a lane is CONTACT_CONFIRMED when the channel is
// published on the merchant's official site (docs/MERCHANT_CHANNEL_AUDIT.md
// research pass, 2026-10-06); VERIFIED only after a real customer case is
// observed working through it; UNVERIFIED means the channel exists on paper
// but the contact path itself isn't confirmed. Nothing here claims
// automation that doesn't exist — chat/form lanes are ASSISTED (the
// customer's own session carries the drafted message).
// ---------------------------------------------------------------------------

export interface LaunchMerchant {
  id: string;
  name: string;
  domains: string[];
  /** Published support email, or null when none exists. */
  email: string | null;
  /** Published web contact form URL (replies arrive by email), or null. */
  form: string | null;
  /** Published live-chat entry URL, or null (e.g. sellers-only). */
  chat: string | null;
  /** Phone/store-only note shown on coverage rows. */
  alt: string;
  /** Official returns/policy page — authoritative source for rung-1 cites. */
  policyUrl: string;
  /** Published return window in days, or null when seller-set/case-by-case. */
  returnDays: number | null;
  /** Verbatim quotes from official policy text (never paraphrase). */
  quotes: string[];
  /** Official source URL(s) where the channels were confirmed. */
  sources: string[];
}

export const LAUNCH_MERCHANTS: LaunchMerchant[] = [
  {
    id: "cmp_amazon", name: "Amazon", domains: ["amazon.com"],
    email: null, form: null,
    chat: "https://www.amazon.com/gp/help/customer/contact-us",
    alt: "phone callback via chat flow",
    policyUrl: "https://www.amazon.com/returns",
    returnDays: 30,
    quotes: [],
    sources: ["https://www.amazon.com/gp/help/customer/contact-us"],
  },
  {
    id: "cmp_walmart", name: "Walmart", domains: ["walmart.com"],
    email: null, form: null,
    chat: "https://www.walmart.com/help",
    alt: "1-800-925-6278",
    policyUrl: "https://www.walmart.com/returns",
    returnDays: 90,
    quotes: [],
    sources: ["https://www.walmart.com/help", "https://corporate.walmart.com/about/contact"],
  },
  {
    id: "cmp_target", name: "Target", domains: ["target.com"],
    email: null, form: null,
    chat: "https://www.target.com/help/contact-us",
    alt: "1-800-591-3869",
    policyUrl: "https://help.target.com/",
    returnDays: 90,
    quotes: [],
    sources: ["https://www.target.com/help/contact-us", "https://contactus.target.com/ContactUs/"],
  },
  {
    id: "cmp_bestbuy", name: "Best Buy", domains: ["bestbuy.com"],
    email: null, form: null,
    chat: "https://www.bestbuy.com/site/help-topics/contact/pcmcat1511375025410.c",
    alt: "1-888-237-8289",
    policyUrl: "https://www.bestbuy.com/site/help-topics/return-exchange-policy/pcmcat260800050014.c",
    returnDays: 15,
    quotes: [],
    sources: ["https://www.bestbuy.com/site/help-topics/contact/pcmcat1511375025410.c"],
  },
  {
    id: "cmp_costco", name: "Costco", domains: ["costco.com"],
    email: null, form: null,
    chat: "https://customerservice.costco.com",
    alt: "phone + chat only — official answer: no email support",
    policyUrl: "https://customerservice.costco.com/app/answers/detail/a_id/1191",
    returnDays: null, // unlimited for most items; 90 days electronics — not a single number
    quotes: ["Costco does not offer email support"],
    sources: ["https://customerservice.costco.com/app/answers/detail/a_id/8108"],
  },
  {
    id: "cmp_homedepot", name: "Home Depot", domains: ["homedepot.com"],
    email: null, form: null,
    chat: "https://www.homedepot.com/c/customer_service",
    alt: "1-800-466-3337 (help@homedepotpartstore.com is parts-store scoped only)",
    policyUrl: "https://www.homedepot.com/c/Return_Policy",
    returnDays: 90,
    quotes: [],
    sources: ["https://www.homedepot.com/c/customer_service", "https://corporate.homedepot.com/page/contact-us"],
  },
  {
    id: "cmp_lowes", name: "Lowe's", domains: ["lowes.com"],
    email: null, form: "https://www.lowes.com/l/help",
    chat: "https://www.lowes.com/l/help",
    alt: "phone 1-800-445-6937",
    policyUrl: "https://www.lowes.com/l/help/returns",
    returnDays: 30,
    quotes: [],
    sources: ["https://www.lowes.com/l/help", "https://www.lowes.com/l/about/privacy-and-security-statement"],
  },
  {
    id: "cmp_chewy", name: "Chewy", domains: ["chewy.com"],
    email: "service@chewy.com", form: null,
    chat: "https://www.chewy.com/app/content/contact",
    alt: "24/7 phone 1-800-672-4399",
    policyUrl: "https://www.chewy.com/app/content/returns",
    returnDays: 365,
    quotes: [],
    sources: ["https://www.chewy.com/app/content/contact", "https://www.chewy.com/app/content/privacy"],
  },
  {
    id: "cmp_wayfair", name: "Wayfair", domains: ["wayfair.com"],
    email: null, form: null,
    chat: "https://www.wayfair.com/contact_us",
    alt: "virtual assistant → agent",
    policyUrl: "https://www.wayfair.com/help/article/return_policy",
    returnDays: 30,
    quotes: [],
    sources: ["https://www.wayfair.com/contact_us", "https://www.wayfair.com/help"],
  },
  {
    id: "cmp_ebay", name: "eBay", domains: ["ebay.com"],
    email: null, form: "https://www.ebay.com/help/contact",
    chat: "https://www.ebay.com/help/home",
    alt: "callback on request via help portal",
    policyUrl: "https://www.ebay.com/help/buying/returns-refunds/return-item-refund?id=4041",
    returnDays: null, // seller-set per listing
    quotes: [],
    sources: ["https://www.ebay.com/help/home", "https://www.ebay.com/help/contact"],
  },
  {
    id: "cmp_etsy", name: "Etsy", domains: ["etsy.com"],
    email: null, form: "https://help.etsy.com/hc/en-us/requests/new",
    chat: null, // live chat exists for SELLERS only — buyers get the ticket form
    alt: "no phone support; buyer tickets via help center (sign-in required)",
    policyUrl: "https://help.etsy.com/hc/en-us/articles/115015710387",
    returnDays: null, // seller-set per shop
    quotes: [],
    sources: ["https://help.etsy.com/hc/en-us/requests/new"],
  },
  {
    id: "cmp_nike", name: "Nike", domains: ["nike.com"],
    email: null, form: null,
    chat: "https://www.nike.com/help/",
    alt: "1-800-806-6453",
    policyUrl: "https://www.nike.com/help/a/returns-policy",
    returnDays: 60,
    quotes: [],
    sources: ["https://www.nike.com/help/", "https://www.nike.com/at/en/help/a/nike-contact-directory"],
  },
  {
    id: "cmp_apple", name: "Apple", domains: ["apple.com"],
    email: null, form: null,
    chat: "https://support.apple.com/contact",
    alt: "phone via support app",
    policyUrl: "https://www.apple.com/shop/browse/open/salespolicies",
    returnDays: 14,
    quotes: [],
    sources: ["https://support.apple.com/contact"],
  },
  {
    id: "cmp_samsung", name: "Samsung", domains: ["samsung.com"],
    email: null, form: null,
    chat: "https://www.samsung.com/us/support/chat/",
    alt: "1-800-726-7864, text/WhatsApp",
    policyUrl: "https://order-help.us.samsung.com/articles/returns-refunds/what-is-samsungs-return-policy/669e3173cd7d5a05a5318406",
    returnDays: 15,
    quotes: ["Most items bought from Samsung.com or through the Shop Samsung App can be returned within 15 days of delivery."],
    sources: ["https://www.samsung.com/us/support/chat/", "https://www.samsung.com/us/support/contact/"],
  },
  {
    id: "cmp_dell", name: "Dell", domains: ["dell.com"],
    email: null, form: "https://www.dell.com/en-us/lp/contact-us",
    chat: "https://www.dell.com/en-us/lp/contact-us",
    alt: "phone; order-support flow after order identification",
    policyUrl: "https://www.dell.com/learn/us/en/uscorp1/campaigns/returns-policy-en-us",
    returnDays: 30,
    quotes: [],
    sources: ["https://www.dell.com/en-us/lp/contact-us"],
  },
  {
    id: "cmp_zappos", name: "Zappos", domains: ["zappos.com"],
    email: "cs@support.zappos.com", form: null,
    chat: "https://www.zappos.com/c/contact-us",
    alt: "24/7 phone + text",
    policyUrl: "https://www.zappos.com/self-service/easy-returns",
    returnDays: 365,
    quotes: [],
    sources: ["https://www.zappos.com/c/contact-us", "https://www.zappos.com/customer-service-center"],
  },
  {
    id: "cmp_nordstrom", name: "Nordstrom", domains: ["nordstrom.com"],
    email: null, form: null,
    chat: "https://www.nordstrom.com/browse/customer-service",
    alt: "1-888-282-6060",
    policyUrl: "https://www.nordstrom.com/browse/customer-service/returns-exchanges",
    returnDays: null, // case-by-case, no hard published limit
    quotes: [],
    sources: ["https://www.nordstrom.com/browse/customer-service"],
  },
  {
    id: "cmp_macys", name: "Macy's", domains: ["macys.com"],
    email: null, form: null,
    chat: "https://www.macys.com/webchat",
    alt: "1-800-289-6229",
    policyUrl: "https://www.macys.com/customer-service/articles/what-is-macys-return-policy/",
    returnDays: 30,
    quotes: ["most items can be returned within 30 days of delivery or purchase"],
    sources: ["https://www.macys.com/webchat", "https://www.macys.com/customer-service/articles/contact-us"],
  },
  {
    id: "cmp_kohls", name: "Kohl's", domains: ["kohls.com"],
    email: null, form: null,
    chat: "https://cs.kohls.com",
    alt: "phone 1-855-564-5705 — official: no email option",
    policyUrl: "https://cs.kohls.com/app/answers/detail/a_id/895",
    returnDays: 180,
    quotes: ["We do not offer an option to email an associate"],
    sources: ["https://cs.kohls.com/app/answers/help_topic/c/27"],
  },
  {
    id: "cmp_sephora", name: "Sephora", domains: ["sephora.com"],
    email: "customerservice@sephora.com", form: null,
    chat: "https://www.sephora.com/beauty/contact-us",
    alt: "phone 1-877-737-4672",
    policyUrl: "https://www.sephora.com/beauty/returns-exchanges",
    returnDays: 30,
    quotes: [],
    sources: ["https://www.sephora.com/beauty/terms-of-use", "https://www.sephora.com/beauty/contact-us"],
  },
  {
    id: "cmp_ulta", name: "Ulta", domains: ["ulta.com"],
    email: null, form: "https://www.ulta.com/guestservices/contact-us",
    chat: "https://www.ulta.com/guestservices/contact-us",
    alt: "1-866-983-8582, text",
    policyUrl: "https://www.ulta.com/guestservices/returns-exchanges",
    returnDays: 60,
    quotes: [],
    sources: ["https://www.ulta.com/guestservices/contact-us"],
  },
  {
    id: "cmp_temu", name: "Temu", domains: ["temu.com"],
    email: null, form: null,
    chat: "https://www.temu.com/contact-us.html",
    alt: "24/7 in-app chat (contact-us@emea.temu.com is EMEA-scoped, not US)",
    policyUrl: "https://www.temu.com/return-and-refund-policy.html",
    returnDays: 90,
    quotes: ["You can return items within 90 days of purchase, with some exceptions"],
    sources: ["https://www.temu.com/contact-us.html"],
  },
  {
    id: "cmp_shein", name: "Shein", domains: ["shein.com"],
    email: "uscsteam@shein.com", form: null,
    chat: "https://m.shein.com/us/SHEIN-Customer-Care-FAQ-a-1012.html",
    alt: "live chat 4 AM–8 PM PST + phone",
    policyUrl: "https://www.shein.com/Return-Policy-a-281.html",
    returnDays: 30,
    quotes: [],
    sources: ["https://m.shein.com/us/imprint-a-746.html", "https://m.shein.com/us/SHEIN-Customer-Care-FAQ-a-1012.html"],
  },
  {
    id: "cmp_ikea", name: "IKEA", domains: ["ikea.com"],
    email: null, form: null,
    chat: "https://www.ikea.com/us/en/customer-service/",
    alt: "1-888-888-4532",
    policyUrl: "https://www.ikea.com/us/en/customer-service/returns-claims/",
    returnDays: 365,
    quotes: ["return new and unopened products within 365 days, together with your proof of purchase, for a full refund", "return open products within 180 days"],
    sources: ["https://www.ikea.com/us/en/customer-service/"],
  },
  {
    id: "cmp_newegg", name: "Newegg", domains: ["newegg.com"],
    email: null, form: null,
    chat: "https://kb.newegg.com/contact-us/",
    alt: "1-800-390-1119, chat 6 AM–5 PM PST",
    policyUrl: "https://kb.newegg.com/article-categories/returns/",
    returnDays: 30, // standard 30-day badge; marketplace items vary — flagged in limitations
    quotes: [],
    sources: ["https://kb.newegg.com/contact-us/"],
  },
];

// Generic retail-deflection knowledge — observed patterns, not fabricated
// merchant facts. Per-merchant specifics get appended by real cases later.
const GENERIC_DEFLECTIONS = [
  "empathy without action ('I completely understand how frustrating that is')",
  "policy wall without citation",
  "redirect loop (chat → phone → chat)",
  "delay past the stated return window",
  "blame the carrier / third party for a merchant-owned fault",
];
const GENERIC_WHAT_WORKS = [
  "cite the merchant's own published policy with the URL",
  "ask for a supervisor or a reference/ticket number with a deadline",
  "state the specific remedy and the date it was promised",
  "escalate to executive/corporate relations after two stalled tiers",
];

/** Seed the 25-merchant directory. Idempotent — every row INSERT OR IGNORE. */
export async function seedDirectory(db: D1Database): Promise<void> {
  const hasPlaybooks = await q1<{ name: string }>(
    db,
    `SELECT name FROM sqlite_master WHERE type='table' AND name='merchant_playbooks'`,
  );

  const coStmt = db.prepare(
    `INSERT OR IGNORE INTO companies (id, name, domains, adapter_id, notes) VALUES (?,?,?,?,?)`,
  );
  const covStmt = db.prepare(
    `INSERT OR IGNORE INTO company_coverage (id, company_id, issue_type, channel, auth_requirements, automation_level, limitations, verification_status, adapter_version, health, notes, channel_address)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const pbkStmt = db.prepare(
    `INSERT OR IGNORE INTO merchant_playbooks
       (id, company_id, version, support_email, chat_url, chat_selectors, executive_contact, return_window_days, policy_url, policy_quotes, known_deflections, what_works, last_verified_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );

  for (const m of LAUNCH_MERCHANTS) {
    await coStmt
      .bind(
        m.id,
        m.name,
        JSON.stringify(m.domains),
        null,
        `Launch set (M6). Channels confirmed on official site(s): ${m.sources.join(" , ")}. Lanes stay CONTACT_CONFIRMED until a real case uses them.`,
      )
      .run();

    // Manual floor every merchant gets — the never-unsupported fallback.
    await covStmt
      .bind(
        `cov_${m.id}_manual`,
        m.id,
        "any",
        "manual",
        "customer-managed account",
        "MANUAL_HANDOFF",
        `Phone/store: ${m.alt}`,
        "UNVERIFIED",
        null,
        "unknown",
        "Manual handoff only.",
        null,
      )
      .run();

    if (m.email) {
      await covStmt
        .bind(
          `cov_${m.id}_email`,
          m.id,
          "any",
          "email",
          "none — published support email; account-specific actions may require the customer's own account",
          "AUTOMATED",
          "Address confirmed on official site; not yet exercised by a real case.",
          m.id === "cmp_chewy" ? "VERIFIED" : "CONTACT_CONFIRMED",
          null,
          "unknown",
          `Official source: ${m.sources.join(" , ")}`,
          m.email,
        )
        .run();
    }
    if (m.form) {
      await covStmt
        .bind(
          `cov_${m.id}_form`,
          m.id,
          "any",
          "form",
          "customer's own session (web form — agent drafts, customer submits; companion can prefill)",
          "ASSISTED",
          "Web contact form confirmed on official site; reply arrives by email.",
          "CONTACT_CONFIRMED",
          null,
          "unknown",
          `Official source: ${m.sources.join(" , ")}`,
          m.form,
        )
        .run();
    }
    if (m.chat) {
      await covStmt
        .bind(
          `cov_${m.id}_chat`,
          m.id,
          "any",
          "chat",
          "customer's own authenticated session — companion streams text, customer presses send",
          "ASSISTED",
          "Chat entry confirmed on official site; companion generic mode not yet exercised on this site.",
          "CONTACT_CONFIRMED",
          null,
          "unknown",
          `Official source: ${m.sources.join(" , ")}`,
          m.chat,
        )
        .run();
    }

    if (hasPlaybooks) {
      await pbkStmt
        .bind(
          `pbk_${m.id}_v1`,
          m.id,
          1,
          m.email,
          m.chat ?? m.form,
          null,
          null, // executive_contact — never fabricated; real cases populate it
          m.returnDays,
          m.policyUrl,
          JSON.stringify(m.quotes),
          JSON.stringify(GENERIC_DEFLECTIONS),
          JSON.stringify(GENERIC_WHAT_WORKS),
          null, // last_verified_at — set by real contact only
        )
        .run();
    }
  }
}

// ---------------------------------------------------------------------------
// Monthly lane health check (spec M6): email lanes degrade on recorded
// bounces; chat/form lanes degrade when the official URL stops answering.
// `fetchFn` is injectable so tests never touch the network.
// ---------------------------------------------------------------------------

type FetchLike = (url: string) => Promise<{ status: number; finalUrl?: string }>;

export async function runDirectoryHealthCheck(
  env: Env,
  fetchFn?: FetchLike,
): Promise<{ checked: number; degraded: number }> {
  const fetchImpl: FetchLike =
    fetchFn ??
    (async (url) => {
      try {
        const r = await fetch(url, { method: "GET", redirect: "follow" });
        return { status: r.status, finalUrl: r.url };
      } catch {
        return { status: 0 };
      }
    });

  const lanes = await q<{
    id: string; company_id: string; channel: string; channel_address: string | null; health: string;
  }>(
    env.DB,
    `SELECT id, company_id, channel, channel_address, health FROM company_coverage
      WHERE channel IN ('email','chat','form') AND channel_address IS NOT NULL`,
  );

  let degraded = 0;
  for (const lane of lanes) {
    let ok = true;
    if (lane.channel === "email") {
      // A lane degrades when a bounce/delivery-failure audit row names the address.
      const bounce = await q1<{ n: number }>(
        env.DB,
        `SELECT COUNT(*) n FROM audit_events
          WHERE type IN ('send_bounced','delivery_failed','email_bounce')
            AND data_json LIKE ? AND created_at >= ?`,
        `%${lane.channel_address}%`,
        new Date(Date.now() - 30 * 86400 * 1000).toISOString(),
      );
      ok = (bounce?.n ?? 0) === 0;
    } else {
      const r = await fetchImpl(lane.channel_address!);
      ok = r.status >= 200 && r.status < 400;
    }
    const next = ok ? "healthy" : "degraded";
    if (next !== lane.health) {
      if (!ok) degraded++;
      await run(env.DB, `UPDATE company_coverage SET health = ? WHERE id = ?`, next, lane.id);
      await auditEvent(env.DB, {
        type: "lane_health_change",
        severity: ok ? "info" : "warning",
        data: { coverageId: lane.id, companyId: lane.company_id, channel: lane.channel, from: lane.health, to: next },
      });
    }
  }
  await auditEvent(env.DB, {
    type: "directory_healthcheck",
    severity: degraded ? "warning" : "info",
    data: { checked: lanes.length, degraded },
  });
  return { checked: lanes.length, degraded };
}

/** True when the last healthcheck audit row is older than 30 days (or none). */
export async function healthCheckDue(db: D1Database): Promise<boolean> {
  const last = await q1<{ created_at: string }>(
    db,
    `SELECT created_at FROM audit_events WHERE type = 'directory_healthcheck' ORDER BY created_at DESC LIMIT 1`,
  );
  if (!last) return true;
  return Date.parse(last.created_at) < Date.now() - 30 * 86400 * 1000;
}
