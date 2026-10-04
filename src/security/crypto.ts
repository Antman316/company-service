// Secret-at-rest encryption for connection credentials.
// Key comes from env.SECRET_KEY (a Cloudflare secret in production, a test
// value in tests). AES-256-GCM with a random IV per blob. Ciphertext never
// enters model context — credentials are decrypted only inside adapters that
// need them.

async function deriveKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: new TextEncoder().encode("company-service:v1"), iterations: 100_000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function b64(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

export async function encryptJson(value: unknown, secret: string): Promise<string> {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return `${b64(iv)}.${b64(ct)}`;
}

export async function decryptJson<T>(blob: string, secret: string): Promise<T> {
  const key = await deriveKey(secret);
  const [ivPart, ctPart] = blob.split(".");
  if (!ivPart || !ctPart) throw new Error("malformed encrypted blob");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(ivPart) as BufferSource },
    key,
    unb64(ctPart) as BufferSource,
  );
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}
