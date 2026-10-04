// D1 helpers — tolerate both array and {results:[]} shapes, never fail open.

export function rows<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  if (res && typeof res === "object" && Array.isArray((res as { results?: unknown[] }).results)) {
    return (res as { results: T[] }).results;
  }
  return [];
}

export function first<T>(res: unknown): T | null {
  const r = rows<T>(res);
  return r.length > 0 ? (r[0] as T) : null;
}

export async function q<T = Record<string, unknown>>(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<T[]> {
  const res = await db.prepare(sql).bind(...params).all<T>();
  return rows<T>(res);
}

export async function q1<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  const res = await db.prepare(sql).bind(...params).first<T>();
  return (res as T) ?? null;
}

export async function run(db: D1Database, sql: string, ...params: unknown[]): Promise<D1Result> {
  return db.prepare(sql).bind(...params).run();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function addMs(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

// Compact prefixed ids — sortable-ish (timestamp prefix) + random suffix.
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
export function newId(prefix: string): string {
  const t = Date.now().toString(36);
  let rand = "";
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  for (const b of bytes) rand += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${t}${rand}`;
}

export function json<T>(s: string | null | undefined, fallback: T): T {
  if (s == null) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
