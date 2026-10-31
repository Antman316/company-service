// Company Service Companion — side panel. TEXT-ONLY rendering: everything
// merchant-supplied goes through textContent, never innerHTML.

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

function showErr(t) {
  $("msg").textContent = t ?? "";
}

async function render() {
  const { pairingToken } = await chrome.storage.local.get("pairingToken");
  $("pair").hidden = !!pairingToken;
  $("active").hidden = !pairingToken;
  if (!pairingToken) {
    $("status").textContent = "Not paired";
    return;
  }
  const ctx = await send({ type: "get_context" });
  if (!ctx || !ctx.matched) {
    $("status").textContent = "No merchant support page detected on this tab.";
    $("active").hidden = true;
    return;
  }
  $("active").hidden = false;
  $("status").textContent = "";
  $("company").textContent = ctx.company?.name ?? "";
  if (ctx.case) {
    $("caseStatus").textContent = ctx.case.status;
    $("rung").textContent = ctx.case.rung ? `escalation rung ${ctx.case.rung}` : "";
  } else {
    $("caseStatus").textContent = "no open case";
    $("rung").textContent = "Start a case in the web app, then chat here.";
  }
  const hasDraft = !!ctx.draft?.body;
  $("draftCard").hidden = !hasDraft;
  if (hasDraft) $("draftBody").textContent = ctx.draft.body;
  const tail = (ctx.transcriptTail ?? [])
    .map((m) => `${m.direction === "in" ? "MERCHANT" : "YOU"}: ${m.body}`)
    .join("\n\n");
  $("transcript").textContent = tail || "(empty — pick the chat area to start watching)";
}

$("pairBtn").onclick = async () => {
  const code = $("code").value.trim().toUpperCase();
  const r = await send({ type: "pair", code });
  if (r?.ok) {
    $("pairErr").textContent = "";
    render();
  } else {
    $("pairErr").textContent = r?.error ?? "pairing failed";
  }
};

$("unpairBtn").onclick = async () => {
  await send({ type: "unpair" });
  render();
};

$("watchBtn").onclick = async () => {
  const r = await send({ type: "pick_region" });
  if (!r?.ok) showErr(r?.error);
};

$("insertBtn").onclick = async () => {
  const ctx = await send({ type: "get_context" });
  const r = await send({ type: "insert_draft", text: ctx?.draft?.body ?? "" });
  if (!r?.ok) showErr(r?.error ?? "insert failed");
  else showErr("");
};

$("regenBtn").onclick = async () => {
  await send({ type: "regenerate" });
  render();
};

$("sentBtn").onclick = async () => {
  const ctx = await send({ type: "get_context" });
  await send({ type: "mark_sent", text: ctx?.draft?.body ?? "" });
  render();
};

$("wrapBtn").onclick = async () => {
  // Pull the transcript from the watched region via the content script.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const t = await chrome.tabs.sendMessage(tab.id, { type: "get_transcript" }).catch(() => null);
  if (!t?.ok) return showErr("pick the chat area first");
  const r = await send({ type: "wrapup", transcript: t.transcript });
  showErr(r?.ok ? "" : "save failed");
  if (r?.ok) $("wrapBtn").textContent = "Saved ✓";
};

chrome.storage.onChanged.addListener((changes) => {
  if (Object.keys(changes).some((k) => k.startsWith("ctx_"))) render();
});

render();
send({ type: "refresh_now" });
