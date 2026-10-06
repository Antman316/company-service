// RFC 6238 TOTP — HMAC-SHA1, 30s step, 6 digits, ±1 window. WebCrypto only.
// Secrets are stored encrypted (users.totp_secret_enc); the column value is
// prefixed 'pending:' while enrollment awaits first-code confirmation and
// 'enc:' once active — signin only enforces 'enc:' secrets.

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/=+$/, "").replace(/[^A-Z2-7]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 5) / 8));
  let bits = 0;
  let value = 0;
  let idx = 0;
  for (const ch of clean) {
    value = (value << 5) | B32_ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out[idx++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return out.subarray(0, idx);
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

async function hotp(secretBytes: Uint8Array, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setUint32(4, counter >>> 0);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
  const offset = sig[sig.length - 1]! & 0x0f;
  const code =
    ((sig[offset]! & 0x7f) << 24) |
    (sig[offset + 1]! << 16) |
    (sig[offset + 2]! << 8) |
    sig[offset + 3]!;
  return String(code % 1_000_000).padStart(6, "0");
}

export async function totpNow(secretBase32: string, stepOffset = 0): Promise<string> {
  const counter = Math.floor(Date.now() / 30_000) + stepOffset;
  return hotp(base32Decode(secretBase32), counter);
}

export async function verifyTotp(secretBase32: string, code: string): Promise<boolean> {
  const clean = code.trim().replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  for (const off of [0, -1, 1]) {
    if ((await totpNow(secretBase32, off)) === clean) return true;
  }
  return false;
}

export function otpauthUrl(secret: string, email: string, issuer = "Company Service"): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6`;
}
