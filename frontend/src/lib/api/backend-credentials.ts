// The Gauss backend authenticates with the better-auth session cookie, but it
// runs on a different origin (port 3001) than the UI, so browsers only send the
// cookie when a request opts in with `credentials: "include"`. Without it every
// data hook got 401s, and CyberTiger auto-blocked the operator's IP after 8.
//
// This opts in once, for requests to the Gauss backend origin only; requests to
// third-party APIs are left untouched.
const BACKEND_ORIGIN = new URL(import.meta.env.VITE_HELIO_PROXY_URL ?? "http://127.0.0.1:3001").origin;

function targetsBackend(input: RequestInfo | URL): boolean {
  const raw = input instanceof Request ? input.url : String(input);
  try {
    return new URL(raw, window.location.href).origin === BACKEND_ORIGIN;
  } catch {
    return false;
  }
}

const originalFetch = window.fetch.bind(window);

window.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
  targetsBackend(input) && init?.credentials === undefined
    ? originalFetch(input, { ...init, credentials: "include" })
    : originalFetch(input, init);
