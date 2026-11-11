/**
 * Client mistakes in a request body, as express.json() (body-parser) reports them (GAU-231).
 *
 * Without this they reach the generic error handler and come back as 500, so a pilot
 * integration cannot tell its own bad body from a server fault, and ops sees server errors
 * that are not ours. Only body-parser's own error types are mapped; anything else stays a 500.
 *
 * The parse error carries the raw body (`error.body`), so these are never logged whole:
 * a rejected body may hold a key or customer data.
 */
export type BodyErrorResponse = { status: 400 | 413 | 415; error: string };

const BODY_ERRORS: Record<string, BodyErrorResponse> = {
  "entity.parse.failed": { status: 400, error: "invalid JSON" },
  "request.aborted": { status: 400, error: "request body incomplete" },
  "request.size.invalid": { status: 400, error: "request body did not match its content-length" },
  "entity.too.large": { status: 413, error: "request body too large" },
  "encoding.unsupported": { status: 415, error: "unsupported content encoding" },
  "charset.unsupported": { status: 415, error: "unsupported charset" },
};

/** The response for a body-parser client error, or null when the error is something else. */
export function bodyErrorResponse(error: unknown): BodyErrorResponse | null {
  if (typeof error !== "object" || error === null) return null;
  const type = (error as { type?: unknown }).type;
  if (typeof type !== "string" || !Object.hasOwn(BODY_ERRORS, type)) return null;
  return BODY_ERRORS[type];
}
