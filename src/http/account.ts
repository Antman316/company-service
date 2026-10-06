import { newId, q1, run, sha256Hex } from "../core/db";
import { auditEvent } from "../core/events";
import { consumeUserToken, countRecentTokens, issueUserToken, notify, sendSystemEmail, sendVerificationEmail, NOTIFICATION_KINDS, NotificationKind } from "../core/notify";
import { decryptJson, encryptJson } from "../security/crypto";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "../core/totp";

// ---------------------------------------------------------------------------
// M7 account security: email verification, password reset, TOTP 2FA,
// notification preferences, consent + Turnstile on signup.
// ---------------------------------------------------------------------------

const VERIFY_RESEND_LIMIT = 3;   // per hour
const RESET_LIMIT = 3;           // per hour
const TOTP_CHALLENGE_TTL_MS = 5 * 60 * 1000;

export async function resendVerification(env: Env, userId: string): Promise<{ ok: boolean; error?: string }> {
  const user = await q1<{ email: string; email_verified_at: string | null }>(
    env.DB, `SELECT email, email_verified_at FROM users WHERE id = ?`, userId,
  );
  if (!user) return { ok: false, error: "user not found" };
  if (user.email_verified_at) return { ok: false, error: "already verified" };
  if ((await countRecentTokens(env.DB, userId, "email_verify", 3600_000)) >= VERIFY_RESEND_LIMIT) {
    return { ok: false, error: "too many verification emails — try again later" };
  }
  await sendVerificationEmail(env, userId, user.email);
  return { ok: true };
}

// One-shot link target: GET /api/auth/verify-email?token=… → mark verified →
// redirect into the SPA with a visible confirmation flag.
export async function verifyEmailLink(env: Env, token: string): Promise<Response> {
  const origin = env.APP_ORIGIN ?? `https://${env.EMAIL_DOMAIN ?? "agentmasterkey.com"}`;
  const hit = await consumeUserToken(env.DB, token, "email_verify");
  if (!hit) {
    return Response.redirect(`${origin}/#/verify-failed`, 302);
  }
  await run(
    env.DB,
    `UPDATE users SET email_verified_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    hit.userId,
  );
  // Cases paused solely for email verification resume on their own.
  await run(
    env.DB,
    `UPDATE cases SET paused = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       meta = json_remove(meta, '$.paused_reason')
     WHERE user_id = ? AND paused = 1 AND json_extract(COALESCE(meta,'{}'),'$.paused_reason') = 'email_unverified'`,
    hit.userId,
  );
  await auditEvent(env.DB, { type: "email_verified", severity: "info", userId: hit.userId });
  return Response.redirect(`${origin}/#/verified`, 302);
}

export async function requestPasswordReset(env: Env, email: string): Promise<void> {
  // Never reveal whether the address is registered — same response either way.
  const normalized = email.trim().toLowerCase();
  const user = await q1<{ id: string; email: string }>(env.DB, `SELECT id, email FROM users WHERE email = ?`, normalized);
  await auditEvent(env.DB, { type: "password_reset_requested", severity: "info", data: { found: !!user } });
  if (!user) return;
  const recent = await q1<{ n: number }>(
    env.DB,
    `SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ? AND created_at >= ?`,
    user.id,
    new Date(Date.now() - 3600_000).toISOString(),
  );
  if ((recent?.n ?? 0) >= RESET_LIMIT) return;
  const token = `cs_rst_${newId("tok")}${newId("tok")}`;
  await run(
    env.DB,
    `INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES (?,?,?,?)`,
    newId("pr"),
    user.id,
    await sha256Hex(token),
    new Date(Date.now() + 3600_000).toISOString(),
  );
  const origin = env.APP_ORIGIN ?? `https://${env.EMAIL_DOMAIN ?? "agentmasterkey.com"}`;
  const link = `${origin}/#/reset?token=${encodeURIComponent(token)}`;
  const sent = await sendSystemEmail(
    env,
    user.email,
    "Reset your Company Service password",
    `Someone asked for a password reset for this account. If it was you, open:\n\n${link}\n\nThe link works once and expires in 1 hour. If it wasn't you, ignore this — your password stays the same.`,
  );
  await auditEvent(env.DB, {
    type: "password_reset_sent", severity: sent.ok ? "info" : "warning",
    userId: user.id,
    data: { transport: sent.transport, ok: sent.ok, ...(env.ENVIRONMENT !== "production" ? { devToken: token } : {}) },
  });
}

export async function confirmPasswordReset(env: Env, token: string, newPassword: string): Promise<{ ok: boolean; error?: string }> {
  if (newPassword.length < 8) return { ok: false, error: "password must be at least 8 characters" };
  const row = await q1<{ id: string; user_id: string; expires_at: string; used_at: string | null }>(
    env.DB,
    `SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?`,
    await sha256Hex(token),
  );
  if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, error: "reset link is invalid or expired" };
  }
  // Reuse the auth module's hashing via the same format (salt:hex@pbkdf2-100k).
  const salt = newId("slt");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(newPassword), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: new TextEncoder().encode(`cs:${salt}`), iterations: 100_000, hash: "SHA-256" },
    key,
    256,
  );
  const hash = Array.from(new Uint8Array(bits)).map((b) => b.toString(16).padStart(2, "0")).join("");
  await run(env.DB, `UPDATE users SET password_hash = ? WHERE id = ?`, `${salt}:${hash}`, row.user_id);
  await run(env.DB, `UPDATE password_resets SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, row.id);
  // Reset kills every session — a stolen cookie must not survive it.
  await run(env.DB, `DELETE FROM sessions WHERE user_id = ?`, row.user_id);
  await auditEvent(env.DB, { type: "password_reset_completed", severity: "info", userId: row.user_id });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// TOTP 2FA (optional). enroll -> pending:<enc> -> confirm -> enc:. Signin
// enforces only 'enc:' secrets.
// ---------------------------------------------------------------------------

async function totpSecretState(env: Env, userId: string): Promise<{ state: "off" | "pending" | "on"; secret?: string }> {
  const row = await q1<{ totp_secret_enc: string | null }>(env.DB, `SELECT totp_secret_enc FROM users WHERE id = ?`, userId);
  const v = row?.totp_secret_enc;
  if (!v || !env.SECRET_KEY) return { state: "off" };
  if (v.startsWith("pending:")) {
    try {
      const { s } = await decryptJson<{ s: string }>(v.slice(8), env.SECRET_KEY);
      return { state: "pending", secret: s };
    } catch { return { state: "off" }; }
  }
  if (v.startsWith("enc:")) {
    try {
      const { s } = await decryptJson<{ s: string }>(v.slice(4), env.SECRET_KEY);
      return { state: "on", secret: s };
    } catch { return { state: "off" }; }
  }
  return { state: "off" };
}

export async function totpEnroll(env: Env, userId: string): Promise<{ ok: boolean; secret?: string; otpauth?: string; error?: string }> {
  if (!env.SECRET_KEY) return { ok: false, error: "2FA unavailable — encryption key not configured" };
  const st = await totpSecretState(env, userId);
  if (st.state === "on") return { ok: false, error: "2FA already enabled" };
  const secret = generateTotpSecret();
  await run(
    env.DB,
    `UPDATE users SET totp_secret_enc = ? WHERE id = ?`,
    `pending:${await encryptJson({ s: secret }, env.SECRET_KEY)}`,
    userId,
  );
  const user = await q1<{ email: string }>(env.DB, `SELECT email FROM users WHERE id = ?`, userId);
  return { ok: true, secret, otpauth: otpauthUrl(secret, user?.email ?? "user") };
}

export async function totpConfirm(env: Env, userId: string, code: string): Promise<{ ok: boolean; error?: string }> {
  if (!env.SECRET_KEY) return { ok: false, error: "2FA unavailable — encryption key not configured" };
  const st = await totpSecretState(env, userId);
  if (st.state !== "pending" || !st.secret) return { ok: false, error: "no enrollment in progress" };
  if (!(await verifyTotp(st.secret, code))) return { ok: false, error: "code didn't match — check your authenticator clock" };
  await run(
    env.DB,
    `UPDATE users SET totp_secret_enc = ? WHERE id = ?`,
    `enc:${await encryptJson({ s: st.secret }, env.SECRET_KEY)}`,
    userId,
  );
  await auditEvent(env.DB, { type: "totp_enabled", severity: "info", userId });
  return { ok: true };
}

export async function totpDisable(env: Env, userId: string, code: string): Promise<{ ok: boolean; error?: string }> {
  const st = await totpSecretState(env, userId);
  if (st.state !== "on" || !st.secret) return { ok: false, error: "2FA is not enabled" };
  if (!(await verifyTotp(st.secret, code))) return { ok: false, error: "code didn't match" };
  await run(env.DB, `UPDATE users SET totp_secret_enc = NULL WHERE id = ?`, userId);
  await auditEvent(env.DB, { type: "totp_disabled", severity: "warning", userId });
  return { ok: true };
}

// Signin helper: returns {ticket} when a second factor is required, else null.
// Called by the signin route after the password verifies.
export async function totpChallengeFor(env: Env, userId: string): Promise<{ required: boolean; ticket?: string }> {
  const st = await totpSecretState(env, userId);
  if (st.state !== "on") return { required: false };
  const ticket = await issueUserToken(env.DB, userId, "totp_challenge", TOTP_CHALLENGE_TTL_MS);
  return { required: true, ticket };
}

export async function totpChallengeRedeem(env: Env, ticket: string, code: string): Promise<{ ok: boolean; userId?: string; error?: string }> {
  const hit = await consumeUserToken(env.DB, ticket, "totp_challenge");
  if (!hit) return { ok: false, error: "challenge expired — sign in again" };
  const st = await totpSecretState(env, hit.userId);
  if (st.state !== "on" || !st.secret) return { ok: false, error: "2FA state changed — sign in again" };
  if (!(await verifyTotp(st.secret, code))) return { ok: false, error: "code didn't match" };
  return { ok: true, userId: hit.userId };
}

// ---------------------------------------------------------------------------
// Notification preferences — all five kinds default ON; a row only exists
// once the customer flips one off.
// ---------------------------------------------------------------------------

export async function getNotificationPrefs(env: Env, userId: string): Promise<Record<NotificationKind, boolean>> {
  const rows = await env.DB
    .prepare(`SELECT kind, enabled FROM notification_prefs WHERE user_id = ?`)
    .bind(userId)
    .all<{ kind: string; enabled: number }>();
  const prefs = Object.fromEntries(NOTIFICATION_KINDS.map((k) => [k, true])) as Record<NotificationKind, boolean>;
  for (const r of rows.results) if (r.kind in prefs) prefs[r.kind as NotificationKind] = !!r.enabled;
  return prefs;
}

export async function setNotificationPref(env: Env, userId: string, kind: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  if (!NOTIFICATION_KINDS.includes(kind as NotificationKind)) return { ok: false, error: "unknown notification kind" };
  await run(
    env.DB,
    `INSERT INTO notification_prefs (id, user_id, kind, enabled, updated_at)
     VALUES (?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(user_id, kind) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
    newId("np"),
    userId,
    kind,
    enabled ? 1 : 0,
  );
  return { ok: true };
}
