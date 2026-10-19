/**
 * What to tell a person when a request fails. Never the response body: it can
 * echo server internals, and a status code alone means nothing to most readers.
 */
export function describeHttpFailure(what: string, status: number): string {
  if (status === 401) return `${what}: your session has ended. Sign in again.`;
  if (status === 403) return `${what}: your role doesn't include this.`;
  if (status === 404) return `${what}: not available on this server yet.`;
  if (status === 429) return `${what}: too many requests. Wait a minute and try again.`;
  if (status >= 500) return `${what}: the server had a problem. Try again in a minute.`;
  return `${what}: request failed (HTTP ${status}).`;
}

/** An Error carrying a readable message and the status, for callers that branch on it. */
export class HttpFailure extends Error {
  readonly status: number;
  constructor(what: string, status: number) {
    super(describeHttpFailure(what, status));
    this.name = "HttpFailure";
    this.status = status;
  }
}
