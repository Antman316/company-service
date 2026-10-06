// Company Service Companion — service worker.
// Owns: pairing token, the allowlist prefilter (no calls leave for unrelated
// tabs), context fetch per matched tab, relay between content script and panel.

const API_BASE = "https://company-service.agentmasterkey.com";

const store = {
  async get(...keys) {
    return chrome.storage.local.get(keys);
  },
  async set(obj) {
    return chrome.storage.local.set(obj);
  },
};

async function api(path, opts = {}) {
  const { pairingToken } = await store.get("pairingToken");
  const r = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      ...(opts.body ? { "content-type": "application/json" } : {}),
      ...(pairingToken ? { authorization: `Bearer ${pairingToken}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// Domain allowlist, refreshed hourly — the extension never phones home about
// URLs outside this list.
let allowlist = { domains: [], at: 0 };
async function getAllowlist() {
  if (Date.now() - allowlist.at > 3600_000) {
    const r = await api("/api/companion/domains");
    if (r.status === 200) allowlist = { domains: r.body.domains ?? [], at: Date.now() };
  }
  return allowlist.domains;
}

function hostMatches(host, domains) {
  if (!host) return false;
  host = host.toLowerCase().replace(/^www\./, "");
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

async function refreshContext(tabId, url) {
  const { pairingToken } = await store.get("pairingToken");
  if (!pairingToken) return;
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return;
  }
  const domains = await getAllowlist();
  if (!hostMatches(host, domains)) {
    await store.set({ [`ctx_${tabId}`]: { matched: false } });
    return;
  }
  const r = await api(`/api/companion/context?url=${encodeURIComponent(url)}`);
  if (r.status === 401) {
    await store.set({ pairingToken: null });
    return;
  }
  if (r.status !== 200) return;
  await store.set({ [`ctx_${tabId}`]: { ...r.body, fetchedAt: Date.now() } });
  // If a live case exists, surface it; auto-open needs Chrome ≥127.
  if (r.body?.matched && r.body?.case) {
    try {
      await chrome.sidePanel.open({ tabId });
    } catch {
      await chrome.action.setBadgeText({ tabId, text: "CS" });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: "#b45309" });
    }
  } else {
    try {
      await chrome.action.setBadgeText({ tabId, text: "" });
    } catch {}
  }
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "complete" && tab.url?.startsWith("http")) refreshContext(tabId, tab.url);
});
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId);
  if (tab?.url?.startsWith("http")) refreshContext(tabId, tab.url);
});

// Open the side panel when the toolbar button is clicked.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// Message bus.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "pair": {
        const r = await fetch(`${API_BASE}/api/companion/pair`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: msg.code, label: "chrome" }),
        });
        const body = await r.json().catch(() => null);
        if (r.status === 200 && body?.token) {
          await store.set({ pairingToken: body.token, pairingId: body.pairingId });
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: body?.error ?? `HTTP ${r.status}` });
        }
        return;
      }
      case "unpair": {
        await api("/api/companion/revoke", { method: "POST", body: "{}" });
        await store.set({ pairingToken: null, pairingId: null });
        sendResponse({ ok: true });
        return;
      }
      case "get_context": {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) return sendResponse({ matched: false });
        const stored = await store.get(`ctx_${tab.id}`);
        sendResponse(stored[`ctx_${tab.id}`] ?? { matched: false });
        return;
      }
      case "refresh_now": {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.url) await refreshContext(tab.id, tab.url);
        sendResponse({ ok: true });
        return;
      }
      case "pick_region": {
        // Inject the content script into all frames (chat widgets often live in
        // cross-origin vendor iframes), then arm pick mode.
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) return sendResponse({ ok: false, error: "no tab" });
        await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["content.js"] });
        chrome.tabs.sendMessage(tab.id, { type: "arm_picker" });
        sendResponse({ ok: true });
        return;
      }
      case "region_selected": {
        await store.set({ [`region_${sender.tab?.id}`]: msg.selector });
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        await store.set({ [`region_${tab?.id}`]: msg.selector });
        sendResponse({ ok: true });
        return;
      }
      case "observed_text": {
        // New text inside the watched region → stream to the case.
        const stored = await store.get([`ctx_${sender.tab?.id}`, `sent_${sender.tab?.id}`]);
        const ctx = stored[`ctx_${sender.tab?.id}`];
        if (!ctx?.case?.id) return sendResponse({ ok: false });
        const lastSent = stored[`sent_${sender.tab?.id}`];
        const text = (msg.text ?? "").trim();
        if (!text) return sendResponse({ ok: false });
        // Echo suppression: the customer's own sent draft appearing in the
        // region is not a merchant reply.
        if (lastSent && text === lastSent.trim()) {
          await store.set({ [`sent_${sender.tab?.id}`]: null });
          return sendResponse({ ok: true, suppressed: true });
        }
        const r = await api("/api/companion/reply", {
          method: "POST",
          body: JSON.stringify({ caseId: ctx.case.id, body: text }),
        });
        if (r.status === 200) {
          await store.set({
            [`ctx_${sender.tab?.id}`]: { ...ctx, draft: r.body?.draft ?? ctx.draft, case: r.body?.case ? { ...ctx.case, ...r.body.case } : ctx.case },
          });
        }
        sendResponse({ ok: r.status === 200 });
        return;
      }
      case "insert_draft": {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) return sendResponse({ ok: false });
        const results = await chrome.tabs.sendMessage(tab.id, { type: "insert_text", text: msg.text }).catch(() => null);
        sendResponse(results ?? { ok: false, error: "no content script — pick the chat area first" });
        return;
      }
      case "mark_sent": {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const ctx = (await store.get(`ctx_${tab?.id}`))[`ctx_${tab?.id}`];
        if (msg.text) await store.set({ [`sent_${tab?.id}`]: msg.text });
        if (ctx?.case?.id) {
          await api("/api/companion/sent", { method: "POST", body: JSON.stringify({ caseId: ctx.case.id }) });
        }
        sendResponse({ ok: true });
        return;
      }
      case "regenerate": {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const ctx = (await store.get(`ctx_${tab?.id}`))[`ctx_${tab?.id}`];
        if (!ctx?.case?.id) return sendResponse({ ok: false, error: "no case" });
        const r = await api("/api/companion/run", { method: "POST", body: JSON.stringify({ caseId: ctx.case.id }) });
        if (r.status === 200) {
          await store.set({ [`ctx_${tab?.id}`]: { ...ctx, draft: r.body?.draft ?? ctx.draft } });
        }
        sendResponse({ ok: r.status === 200 });
        return;
      }
      case "wrapup": {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const ctx = (await store.get(`ctx_${tab?.id}`))[`ctx_${tab?.id}`];
        if (!ctx?.case?.id) return sendResponse({ ok: false, error: "no case" });
        const r = await api("/api/companion/wrapup", {
          method: "POST",
          body: JSON.stringify({ caseId: ctx.case.id, transcript: msg.transcript, reference: msg.reference }),
        });
        sendResponse({ ok: r.status === 200, evidenceId: r.body?.evidenceId });
        return;
      }
    }
  })();
  return true; // async sendResponse
});
