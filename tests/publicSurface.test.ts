import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { getAdapter, listAdapterIds } from "../src/adapters/registry";
import { applyHtmlFrameHeaders, HTML_FRAME_CSP, SECURITY_TXT_BODY } from "../src/http/publicSurface";

describe("public surface", () => {
  it("serves robots.txt as plain text, not the SPA", async () => {
    const r = await SELF.fetch("http://test/robots.txt");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/plain");
    const body = await r.text();
    expect(body).toContain("User-agent: *");
    expect(body).toContain("Disallow: /");
    expect(body).not.toContain("<html");
    expect(body).not.toContain("Company Service");
  });

  it("serves security.txt as plain text with a placeholder contact", async () => {
    const r = await SELF.fetch("http://test/.well-known/security.txt");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/plain");
    const body = await r.text();
    expect(body).toBe(SECURITY_TXT_BODY);
    expect(body).toContain("PLACEHOLDER");
    expect(body).toContain("Contact: mailto:security@agentmasterkey.com");
    expect(body).not.toContain("<html");
  });

  it("adds frame-ancestors and DENY only on HTML responses", () => {
    const html = applyHtmlFrameHeaders(
      new Response("<!doctype html><title>Company Service</title>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    expect(html.headers.get("content-security-policy")).toBe(HTML_FRAME_CSP);
    expect(html.headers.get("x-frame-options")).toBe("DENY");

    const json = applyHtmlFrameHeaders(
      new Response("{}", { headers: { "content-type": "application/json" } }),
    );
    expect(json.headers.get("content-security-policy")).toBeNull();
    expect(json.headers.get("x-frame-options")).toBeNull();
  });
});

describe("test-merchant registration", () => {
  it("does not register the test-merchant adapter in production", () => {
    expect(getAdapter("test-merchant", "production")).toBeNull();
    expect(listAdapterIds("production")).not.toContain("test-merchant");
  });

  it("still registers the test-merchant adapter outside production", () => {
    expect(getAdapter("test-merchant", "test")).not.toBeNull();
    expect(getAdapter("test-merchant", "staging")).not.toBeNull();
    expect(listAdapterIds("test")).toContain("test-merchant");
    expect(getAdapter("test-merchant", undefined)).not.toBeNull();
  });
});
