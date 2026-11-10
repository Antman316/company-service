import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import { signup, authed } from "./helpers";

// Bruce BUG-1: malformed JSON or a wrong Content-Type on a JSON endpoint used
// to escape as an unhandled exception → 500 "internal error". Every JSON body
// reader must instead answer a clean 400 { error } — before any handler logic,
// and without an error-report side channel.

async function postRaw(path: string, init: { contentType?: string | null; body: string; headers?: Record<string, string> }) {
  const headers = new Headers(init.headers ?? {});
  if (init.contentType != null) headers.set("Content-Type", init.contentType);
  const r = await SELF.fetch(`http://test${path}`, { method: "POST", headers, body: init.body });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}

function expect400(r: { status: number; body: any }) {
  expect(r.status).toBe(400);
  expect(typeof r.body?.error).toBe("string");
  expect(r.body.error.length).toBeGreaterThan(0);
}

describe("JSON body handling (BUG-1)", () => {
  it("signup: malformed JSON returns 400, not 500 (Bruce repro)", async () => {
    const r = await postRaw("/api/auth/signup", { contentType: "application/json", body: "{not json" });
    expect400(r);
  });

  it("signup: wrong content-type returns 400, not 500", async () => {
    const r = await postRaw("/api/auth/signup", { contentType: "text/plain", body: "{not json" });
    expect400(r);
  });

  it("signup: form-encoded content-type returns 400, not 500", async () => {
    const r = await postRaw("/api/auth/signup", {
      contentType: "application/x-www-form-urlencoded",
      body: "email=a@b.c&password=x",
    });
    expect400(r);
  });

  it("signup: empty JSON body returns 400, not 500", async () => {
    const r = await postRaw("/api/auth/signup", { contentType: "application/json", body: "" });
    expect400(r);
  });

  it("signup: valid JSON still reaches the handler", async () => {
    const r = await postRaw("/api/auth/signup", {
      contentType: "application/json",
      body: JSON.stringify({ email: `ok-${Date.now()}@test.dev`, password: "password-1234", consent: true }),
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it("signin: malformed JSON returns 400, not 500", async () => {
    const r = await postRaw("/api/auth/signin", { contentType: "application/json", body: "{not json" });
    expect400(r);
  });

  it("signin: wrong content-type returns 400, not 500", async () => {
    const r = await postRaw("/api/auth/signin", { contentType: "text/plain", body: "{not json" });
    expect400(r);
  });

  it("reset-request: malformed JSON returns 400, not 500", async () => {
    const r = await postRaw("/api/auth/reset-request", { contentType: "application/json", body: "{not json" });
    expect400(r);
  });

  it("abuse report: malformed JSON returns 400, not 500", async () => {
    const r = await postRaw("/api/abuse/report", { contentType: "application/json", body: "{not json" });
    expect400(r);
  });

  it("companion pair: malformed JSON returns 400, not 500", async () => {
    const r = await postRaw("/api/companion/pair", { contentType: "application/json", body: "{not json" });
    expect400(r);
  });

  it("authed endpoint (POST /api/cases): malformed JSON returns 400, not 500", async () => {
    const c = await signup(`jsonbody-${Date.now()}@test.dev`);
    const r = await postRaw("/api/cases", { contentType: "application/json", body: "{not json", headers: authed(c) });
    expect400(r);
  });
});
