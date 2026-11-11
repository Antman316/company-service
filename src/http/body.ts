// Shared request-body handling for the JSON API.
//
// Malformed JSON and non-JSON content types are client errors (400), never
// worker faults: readJson throws HttpError and the top-level fetch catch
// translates it into a clean 4xx instead of an "internal error" 500.

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

// Read a JSON request body. A Content-Type that is present but not JSON is a
// 400 outright; an absent one is tolerated and the parse decides. Empty or
// malformed bodies are 400s as well.
export async function readJson(req: Request): Promise<unknown> {
  const ct = (req.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
  if (ct && ct !== "application/json" && !ct.endsWith("+json")) {
    throw new HttpError(400, "request body must be JSON (Content-Type: application/json)");
  }
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
}
