// Post-login redirects must stay on this origin. Resolving against a fixed
// base with the WHATWG URL parser (the browser's own rules) catches every
// spelling of an off-site target: "//host", "/\host", tab/newline tricks and
// absolute or javascript: URLs all resolve to a different origin.
const BASE = "http://same-origin.invalid";

export function safeRedirectPath(target: unknown, fallback: string): string {
  if (typeof target !== "string" || !target.startsWith("/")) return fallback;

  let url: URL;
  try {
    url = new URL(target, BASE);
  } catch {
    return fallback;
  }
  if (url.origin !== BASE) return fallback;

  return `${url.pathname}${url.search}${url.hash}`;
}
