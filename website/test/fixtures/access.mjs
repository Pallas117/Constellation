// A stand-in for Cloudflare Access: a local RSA key pair that signs the same JWT Access sends in
// Cf-Access-Jwt-Assertion, plus the env values that make the Worker trust that key (dev/tests only).
const b64url = (data) => Buffer.from(typeof data === "string" ? data : new Uint8Array(data)).toString("base64url");

export async function makeAccess({ team = "dev.cloudflareaccess.local", aud = "lightbound-dev", kid = "dev" } = {}) {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, alg: "RS256", use: "sig" };
  async function sign(email, claims = {}, header = {}) {
    const now = Math.floor(Date.now() / 1000);
    const h = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT", ...header }));
    const p = b64url(JSON.stringify({ aud: [aud], email, iss: `https://${team}`, iat: now, exp: now + 3600, sub: email, ...claims }));
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${b64url(sig)}`;
  }
  return { sign, env: { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud, ACCESS_JWKS: JSON.stringify({ keys: [jwk] }) } };
}
