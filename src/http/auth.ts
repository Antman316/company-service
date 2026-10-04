import { newId, q1, run, sha256Hex } from "../core/db";

// Auth: email + password, PBKDF2 hash (WebCrypto), HttpOnly session cookie,
// per-session CSRF token required on every mutation. V1 scope — magic links /
// SSO are roadmap items.

const SESSION_COOKIE = "cs_session";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

async function hashPassword(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: new TextEncoder().encode(`cs:${salt}`), iterations: 120_000, hash: "SHA-256" },
    key,
    256,
  );
  return Array.from(new Uint8Array(bits)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cookieHeader(token: string, maxAgeSec: number, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSec}`,
  ];
  // Secure is required in production (HTTPS) but breaks http://localhost dev.
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export async function signup(db: D1Database, email: string, password: string) {
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) return { ok: false as const, error: "invalid email" };
  if (password.length < 8) return { ok: false as const, error: "password must be at least 8 characters" };
  const existing = await q1(db, `SELECT id FROM users WHERE email = ?`, normalized);
  if (existing) return { ok: false as const, error: "account already exists" };
  const userId = newId("usr");
  const salt = newId("slt");
  await run(
    db,
    `INSERT INTO users (id, email, password_hash) VALUES (?,?,?)`,
    userId,
    normalized,
    `${salt}:${await hashPassword(password, salt)}`,
  );
  return { ok: true as const, userId };
}

export async function signin(db: D1Database, email: string, password: string, secure = true) {
  const normalized = email.trim().toLowerCase();
  const user = await q1<{ id: string; password_hash: string }>(
    db, `SELECT id, password_hash FROM users WHERE email = ?`, normalized,
  );
  if (!user) return { ok: false as const, error: "invalid credentials" };
  const [salt, expected] = user.password_hash.split(":");
  const actual = await hashPassword(password, salt ?? "");
  if (actual !== expected) return { ok: false as const, error: "invalid credentials" };
  const token = newId("ses") + newId("tok").slice(4);
  const csrf = newId("csrf");
  const sessionId = newId("s");
  await run(
    db,
    `INSERT INTO sessions (id, user_id, token_hash, csrf_token, expires_at) VALUES (?,?,?,?,?)`,
    sessionId, user.id, await sha256Hex(token), csrf,
    new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  );
  return {
    ok: true as const,
    userId: user.id,
    token,
    csrf,
    cookie: cookieHeader(token, SESSION_TTL_MS / 1000, secure),
  };
}

export async function signout(db: D1Database, token: string, secure = true): Promise<string> {
  await run(db, `DELETE FROM sessions WHERE token_hash = ?`, await sha256Hex(token));
  return cookieHeader("", 0, secure);
}

export interface Session {
  userId: string;
  csrf: string;
  token: string;
}

export async function getSession(req: Request, db: D1Database): Promise<Session | null> {
  const cookie = req.headers.get("Cookie") ?? "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!m) return null;
  const token = m[1]!;
  const row = await q1<{ user_id: string; csrf_token: string; expires_at: string }>(
    db, `SELECT user_id, csrf_token, expires_at FROM sessions WHERE token_hash = ?`,
    await sha256Hex(token),
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await run(db, `DELETE FROM sessions WHERE token_hash = ?`, await sha256Hex(token));
    return null;
  }
  return { userId: row.user_id, csrf: row.csrf_token, token };
}

export function requireCsrf(req: Request, session: Session): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
  return req.headers.get("x-csrf") === session.csrf;
}


