// Switch the site between releases in one step, so the config and the page headers never disagree (GAU-178).
//   full:   RELEASE "full", the DATA namespace, the sign-in and workspace vars, and "Sign in" in every page header.
//   public: RELEASE "public", only the LIVE namespace, and "Contact" in every page header (what lightbound.space runs).
// It edits website/wrangler.jsonc and website/public/**/*.html only; it never deploys. Then run `npm run test:website`
// (the site tests check config and headers agree) and follow the flip-day runbook.
//
// usage:
//   node website/tools/release.mjs full --data <DATA namespace id> --team <team>.cloudflareaccess.com --aud <AUD tag> \
//        [--app https://<gauss app>/] [--ops https://<ops site>/] [--support https://buy.stripe.com/...] [--cap 50]
//   node website/tools/release.mjs public
//   node website/tools/release.mjs check          (exit 1 if wrangler.jsonc and the page headers disagree)
// None of these values is a secret (ids, a team domain, an AUD tag, links). Secrets stay Worker secrets.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTACT, CONTACT_PILL, SIGN_IN_PILL } from "../worker/release.js";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const CONFIG = join(SITE, "wrangler.jsonc");
const PUB = join(SITE, "public");
export { CONTACT_PILL, SIGN_IN_PILL };
const ADMIN = CONTACT; // ADMIN_EMAILS: the founder, as in the README
// Vars that exist only when accounts are open; `public` removes them again.
const FULL_VARS = ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "ADMIN_EMAILS", "GAUSS_APP_URL", "OPS_URL", "SUPPORT_URL", "USER_CAP"];

/** The pages whose header pill follows the release. /app/ has Sign out and /argo/ (full only) always says Sign in. */
export function headerPages(dir = PUB) {
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  return walk(dir).filter((f) => f.endsWith(".html")).filter((f) => {
    const rel = relative(dir, f).split(sep).join("/");
    return !rel.startsWith("app/") && !rel.startsWith("argo/");
  });
}

const read = () => readFileSync(CONFIG, "utf8");
export const configRelease = (raw = read()) => raw.match(/"RELEASE":\s*"(\w+)"/)?.[1];

/** Checks each value before it reaches the config. Returns a list of problems (empty = fine). */
export function validate(o) {
  const bad = [];
  if (!/^[0-9a-f]{32}$/.test(o.data ?? "")) bad.push("--data: the DATA namespace id (32 hex characters, from `npx wrangler@4 kv namespace create DATA`)");
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(o.team ?? "")) bad.push("--team: the Zero Trust team domain, like <team>.cloudflareaccess.com");
  if (!/^[0-9a-f]{32,128}$/.test(o.aud ?? "")) bad.push("--aud: the Access application's AUD tag (hex)");
  if (o.app && !/^https:\/\/[a-z0-9.-]+(:\d+)?\/[^\s"<>]*$/i.test(o.app)) bad.push("--app: an https address ending in a path, like https://gauss.example/");
  if (o.ops && !/^https:\/\/[^\s"<>]+$/.test(o.ops)) bad.push("--ops: an https address");
  if (o.support && !/^https:\/\/buy\.stripe\.com\/[A-Za-z0-9_]+$/.test(o.support)) bad.push("--support: a Stripe Payment Link (https://buy.stripe.com/...)");
  if (o.cap && !/^[1-9]\d{0,4}$/.test(o.cap)) bad.push("--cap: a whole number of accounts");
  return bad;
}

/** wrangler.jsonc text for a release. Pure, so the tests can run it without touching files. */
export function configFor(raw, release, o = {}) {
  let out = raw.replace(/"RELEASE":\s*"\w+"/, `"RELEASE": "${release}"`);
  // Drop anything an earlier switch added, then add it back for "full".
  out = out.replace(/\n\s*\{ "binding": "DATA", "id": "[0-9a-f]*" \},?(?=\n)/, "");
  out = out.replace(/(\{ "binding": "LIVE", "id": "[0-9a-f]{32}" \}),(\n\s*\])/, "$1$2");
  for (const k of FULL_VARS) out = out.replace(new RegExp(`\\n\\s*"${k}": "[^"\\n]*",?(?=\\n)`), "");
  if (release !== "full") return out;
  out = out.replace(/(\{ "binding": "LIVE", "id": "[0-9a-f]{32}" \})/, `$1,\n    { "binding": "DATA", "id": "${o.data}" }`);
  const vars = {
    ACCESS_TEAM_DOMAIN: o.team, ACCESS_AUD: o.aud, ADMIN_EMAILS: ADMIN,
    GAUSS_APP_URL: o.app ?? "", OPS_URL: o.ops ?? "", SUPPORT_URL: o.support ?? "", USER_CAP: o.cap ?? "50",
  };
  const lines = Object.entries(vars).map(([k, v]) => `\n    "${k}": "${v}",`).join("");
  return out.replace(/("RELEASE": "full",)/, `$1${lines}`);
}

export const pillFor = (release) => (release === "full" ? SIGN_IN_PILL : CONTACT_PILL);
export const headerFor = (html, release) => html.replace(release === "full" ? CONTACT_PILL : SIGN_IN_PILL, pillFor(release));

function main(argv) {
  const [cmd, ...rest] = argv;
  const o = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i]?.replace(/^--/, "");
    if (!["data", "team", "aud", "app", "ops", "support", "cap"].includes(k)) { console.error(`unknown option ${rest[i]}`); return 2; }
    o[k] = rest[i + 1];
  }
  if (cmd === "check") {
    const release = configRelease();
    const off = headerPages().filter((f) => !readFileSync(f, "utf8").includes(pillFor(release)));
    for (const f of off) console.log(`header disagrees with RELEASE "${release}": ${relative(SITE, f)}`);
    console.log(off.length ? "FAIL" : `ok: RELEASE "${release}", ${headerPages().length} page headers agree`);
    return off.length ? 1 : 0;
  }
  if (cmd !== "full" && cmd !== "public") { console.error("usage: node website/tools/release.mjs full --data <id> --team <domain> --aud <tag> [--app <url>] [--ops <url>] [--support <url>] [--cap <n>] | public | check"); return 2; }
  if (cmd === "full") {
    const bad = validate(o);
    if (bad.length) { for (const b of bad) console.error(`refused: ${b}`); return 2; }
  }
  writeFileSync(CONFIG, configFor(read(), cmd, o));
  let changed = 0;
  for (const f of headerPages()) {
    const html = readFileSync(f, "utf8");
    const next = headerFor(html, cmd);
    if (next !== html) { writeFileSync(f, next); changed++; }
  }
  console.log(`RELEASE "${cmd}": wrangler.jsonc updated, ${changed} page header(s) changed. Next: npm run test:website`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
