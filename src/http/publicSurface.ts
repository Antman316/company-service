// Public, non-SPA responses and HTML framing headers.
// These paths must not fall through to the SPA (which would return HTTP 200 HTML).

export const HTML_FRAME_CSP = "frame-ancestors 'none'";

/**
 * Add clickjacking headers to HTML responses only.
 * Non-HTML responses (JSON, downloads, plain text) are returned unchanged.
 */
export function applyHtmlFrameHeaders(response: Response): Response {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/html")) return response;
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", HTML_FRAME_CSP);
  headers.set("x-frame-options", "DENY");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function robotsTxtResponse(): Response {
  return new Response("User-agent: *\nDisallow: /\n", {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=86400",
    },
  });
}

// PLACEHOLDER contact. This repository does not document a confirmed
// security mailbox. Do not treat this file as an authoritative disclosure
// channel until the owner confirms the address.
export const SECURITY_TXT_BODY = `# PLACEHOLDER: contact mailbox is not confirmed in this repository.
# Replace Contact before relying on this file for vulnerability reports.
Contact: mailto:security@agentmasterkey.com
Expires: 2027-10-30T23:59:59.000Z
Preferred-Languages: en
`;

export function securityTxtResponse(): Response {
  return new Response(SECURITY_TXT_BODY, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=86400",
    },
  });
}

/** Exact paths that must not be served as the SPA. */
export function publicSurfaceResponse(pathname: string): Response | null {
  if (pathname === "/robots.txt") return robotsTxtResponse();
  if (pathname === "/.well-known/security.txt") return securityTxtResponse();
  return null;
}
