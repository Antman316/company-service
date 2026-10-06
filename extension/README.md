# Company Service Companion (Chrome extension)

Generic-mode chat companion. It watches a chat region **you pick**, streams new
merchant text into your case, and shows the drafted reply. **You always press
send** — the extension can prefill the input but never submits.

## Load it (dev)

1. `chrome://extensions` → Developer mode → **Load unpacked** → select this
   `extension/` directory.
2. In the web app: **Connections → Chat companion → Generate pairing code**.
3. Open a merchant support chat page (registered domain allowlist only), click
   the toolbar button → side panel → paste the code → **Pair**.
4. **Watch this chat area** → click the chat region once. New merchant text
   streams to the case; drafted replies appear in the panel.
5. **Insert into chat** fills the input (never sends) → review → send yourself →
   **I sent it**. **Save transcript** stores the full chat as case evidence.

## What it does NOT do

- No auto-send, no form submission, no Enter key dispatch.
- No credential access, no cookie reading, no CAPTCHA interaction.
- No activity outside the allowlisted merchant domains — the URL never leaves
  the browser unless the hostname matches the coverage registry allowlist.
- All rendered content is text-only (`textContent`) — no HTML injection into
  the privileged extension surface.

## Permissions rationale (for store review)

| permission | why |
|---|---|
| `sidePanel` | the companion UI surface |
| `activeTab` + `scripting` | inject the region picker only when you click "Watch this chat area" |
| `tabs` | know which merchant page the active tab is on (context matching) |
| `storage` | keep the pairing token and per-tab state |
| host: company-service domains | API calls |
| host: chat-vendor iframe domains | chat widgets run in cross-origin iframes (LivePerson, Zendesk, etc.) — content script needs `all_frames` access to read the chat you selected |

## Honest status

Generic mode is implemented and server-tested; **per-merchant selectors are
intentionally deferred** — generic region-pick is the shipped mode. Real-chat
verification (3 merchants on video) is a launch acceptance gate, not yet met.
