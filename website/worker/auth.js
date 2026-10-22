// Sign-in for /app/*: Cloudflare Access sits in front, signs people in with a one-time code sent to
// their email, and passes a signed JWT in the Cf-Access-Jwt-Assertion header. We verify that JWT
// here (RS256 against the team's published keys, audience, issuer, expiry) and never trust a bare
// email header. Access proves who someone is; the account record in KV decides what they can see.

const decoder = new TextDecoder();
const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const json = (part) => JSON.parse(decoder.decode(b64url(part)));

let cache = { at: 0, domain: "", keys: null };

async function signingKeys(env, fetchImpl, now, refresh = false) {
  // Local dev and tests only: honoured just for a *.local team domain, so production can never accept a locally minted token.
  if (env.ACCESS_JWKS && /\.local$/.test(env.ACCESS_TEAM_DOMAIN ?? "")) return JSON.parse(env.ACCESS_JWKS).keys;
  const cached = cache.keys && cache.domain === env.ACCESS_TEAM_DOMAIN;
  // A refresh (unknown kid: Access rotated its keys) is allowed at most once a minute, so bad tokens can't hammer Access.
  if (cached && (refresh ? now - cache.at < 60_000 : now - cache.at < 3_600_000)) return cache.keys;
  const res = await fetchImpl(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`Access certs HTTP ${res.status}`);
  cache = { at: now, domain: env.ACCESS_TEAM_DOMAIN, keys: (await res.json()).keys };
  return cache.keys;
}

/** The signed-in email, or null if the request has no valid Access token. */
export async function accessIdentity(request, env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || !env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = json(parts[0]);
    const claims = json(parts[1]);
    if (header.alg !== "RS256") return null;
    const jwk = (await signingKeys(env, fetchImpl, now)).find((k) => k.kid === header.kid) ??
      (await signingKeys(env, fetchImpl, now, true)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(parts[2]), signed))) return null;
    const t = Math.floor(now / 1000);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(env.ACCESS_AUD) || claims.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
    if (!(claims.exp > t) || (claims.nbf && claims.nbf > t + 60)) return null;
    if (typeof claims.email !== "string" || !/^[^@\s]+@[^@\s]+$/.test(claims.email)) return null;
    return { email: claims.email.toLowerCase() };
  } catch {
    return null;
  }
}

export const isAdmin = (env, email) =>
  !!email && String(env.ADMIN_EMAILS ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean).includes(email);
