// Company Service Companion — content script (generic mode).
// Injected on demand via activeTab/scripting when the user picks "watch this
// chat area". All_frames covers chat widgets living in vendor iframes.
// Reads TEXT ONLY from the picked region; never submits forms, never presses
// send, never touches credentials or cookies.

(function () {
  if (window.__csCompanionLoaded) return;
  window.__csCompanionLoaded = true;

  let observer = null;
  let watched = null;
  let lastSeenText = "";
  let flushTimer = null;
  let pendingText = "";

  function textOf(el) {
    // innerText only — structure/tags are intentionally discarded.
    return (el.innerText ?? el.textContent ?? "").trim();
  }

  function cssSelectorFor(el) {
    // Best-effort unique-ish path for re-attaching after navigation.
    const parts = [];
    let cur = el;
    while (cur && cur !== document.documentElement && parts.length < 6) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) {
        part += `#${CSS.escape(cur.id)}`;
        parts.unshift(part);
        break;
      }
      const sibs = cur.parentElement ? [...cur.parentElement.children].filter((c) => c.tagName === cur.tagName) : [];
      if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  }

  function flushObserved() {
    if (!pendingText.trim() || !watched) {
      pendingText = "";
      return;
    }
    // Send only the newly-appeared tail — full text each time would flood the
    // ingest with duplicates.
    const current = textOf(watched);
    const fresh = current.startsWith(lastSeenText) ? current.slice(lastSeenText.length) : pendingText;
    pendingText = "";
    lastSeenText = current;
    const out = fresh.trim();
    if (out) chrome.runtime.sendMessage({ type: "observed_text", text: out });
  }

  function onMutated() {
    pendingText += " ";
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flushObserved, 1200); // debounce bursts of DOM churn
  }

  function watch(el) {
    observer?.disconnect();
    watched = el;
    lastSeenText = textOf(el);
    observer = new MutationObserver(onMutated);
    observer.observe(el, { subtree: true, childList: true, characterData: true });
    highlight(el, "#22c55e");
  }

  function highlight(el, color) {
    const prev = el.style.outline;
    el.style.outline = `3px solid ${color}`;
    setTimeout(() => (el.style.outline = prev), 1500);
  }

  // Region picker: translucent overlay, click = select, Esc = cancel.
  function armPicker() {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,0.08)";
    const hint = document.createElement("div");
    hint.textContent = "Company Service: click the chat area (Esc to cancel)";
    hint.style.cssText =
      "position:fixed;top:8px;left:50%;transform:translateX(-50%);background:#111827;color:#fff;padding:8px 14px;border-radius:8px;font:13px system-ui;z-index:2147483647";
    document.documentElement.append(overlay, hint);

    let hovered = null;
    overlay.addEventListener("mousemove", (e) => {
      if (hovered) hovered.style.outline = "";
      hovered = document.elementFromPoint(e.clientX, e.clientY);
      if (hovered && hovered !== overlay && hovered !== hint) hovered.style.outline = "2px solid #f59e0b";
    });
    const done = (sel) => {
      overlay.remove();
      hint.remove();
      if (hovered) hovered.style.outline = "";
      if (sel) {
        watch(sel);
        chrome.runtime.sendMessage({ type: "region_selected", selector: cssSelectorFor(sel) });
      }
    };
    overlay.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      done(document.elementFromPoint(e.clientX, e.clientY));
    }, true);
    const esc = (e) => {
      if (e.key === "Escape") {
        done(null);
        document.removeEventListener("keydown", esc, true);
      }
    };
    document.addEventListener("keydown", esc, true);
  }

  // Insert draft into the most plausible chat input inside/near the region.
  // NEVER dispatches submit/Enter — the customer presses send.
  function insertText(text) {
    if (!watched || !watched.isConnected) return { ok: false, error: "chat area not picked (or page navigated)" };
    const scope = watched.closest("div,section,main,form") ?? watched.parentElement ?? document;
    const input =
      scope.querySelector("textarea, [contenteditable=true], input[type=text], input:not([type])") ??
      document.querySelector("textarea:focus, [contenteditable=true]:focus");
    if (!input) return { ok: false, error: "no chat input found near the watched area" };
    input.focus();
    if (input.isContentEditable) {
      input.innerText = text;
    } else {
      // Native setter so React-controlled inputs see the change.
      const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      setter ? setter.call(input, text) : (input.value = text);
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    highlight(input, "#3b82f6");
    return { ok: true };
  }

  function transcriptText() {
    return watched ? textOf(watched) : "";
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "arm_picker") {
      armPicker();
      sendResponse({ ok: true });
    } else if (msg.type === "insert_text") {
      sendResponse(insertText(msg.text ?? ""));
    } else if (msg.type === "get_transcript") {
      sendResponse({ ok: !!watched, transcript: transcriptText() });
    }
    return false;
  });
})();
