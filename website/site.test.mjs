// GAU-12 acceptance checks for the static website:  node --test website/site.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(dir, f), "utf8");
const html = read("index.html");
const text = (s) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
// The "what we don't claim" box is the one place these words may appear, as negations.
const claimsBox = html.match(/<h3>We don't claim<\/h3>[\s\S]*?<\/ul>/)?.[0] ?? "";
const body = text(html.replace(claimsBox, ""));

test("product wedge and buyer are in the first screen (hero)", () => {
  const hero = html.match(/<section class="hero">[\s\S]*?<\/section>/)[0];
  assert.equal((html.match(/<h1>/g) || []).length, 1, "exactly one h1");
  assert.match(text(hero), /trust/i);
  assert.match(text(hero), /Built for .*(onboard-AI|orbital-compute|satellite operations)/);
  assert.match(hero, /href="#contact"/, "call to action in the hero");
});

test("no unsupported flight, qualification, dose, damage, customer or A*STAR/QPIN claims", () => {
  const banned = [
    /flight[- ]?(ready|readiness|proven|heritage|qualified)/i, /space[- ]qualifi/i, /\bqualified\b/i,
    /\bdose\b/i, /\bdamage\b/i, /\bcustomers?\b/i, /A\*?STAR/i, /\bQPIN\b/i,
    /\bpartnership\b|\bpartnered\b|\bpartners with\b/i, /\bcertified\b/i, /\b(can|will|to) command\b/i,
  ];
  for (const rx of banned) assert.doesNotMatch(body, rx, `found ${rx} outside the "we don't claim" box`);
  assert.match(text(claimsBox), /Flight readiness/);
  assert.match(text(claimsBox), /dose/);
});

test("partner boundaries, advisory status and contact route are explicit", () => {
  assert.match(body, /Design-partner paths: we are working towards validation pilots with JAOPS and xOrbita/);
  assert.match(body, /advisory/i);
  assert.match(html, /href="mailto:[^"]+@lightbound\.uk/);
  assert.match(body, /company no\. 14573199/);
});

test("every in-page link resolves", () => {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(target), `#${target} has no target`);
  for (const [, file] of html.matchAll(/(?:href|src)="(?!#|mailto:|https?:)([^"]+)"/g)) assert.ok(statSync(join(dir, file)).size > 0, `${file} missing`);
});

test("security: strict CSP, no scripts, no inline styles, nothing loaded from elsewhere", () => {
  assert.match(html, /http-equiv="Content-Security-Policy" content="default-src 'none'/);
  assert.doesNotMatch(html, /<script|\son\w+="|\sstyle="/i);
  assert.doesNotMatch(html, /(?:src|href)="https?:/i, "no third-party resources");
  const headers = read("_headers");
  for (const h of ["default-src 'none'", "frame-ancestors 'none'", "Strict-Transport-Security", "X-Content-Type-Options: nosniff"])
    assert.ok(headers.includes(h), `_headers missing ${h}`);
});

test("low memory: the whole site stays under 40 KB", () => {
  const total = ["index.html", "styles.css", "favicon.svg"].reduce((n, f) => n + statSync(join(dir, f)).size, 0);
  assert.ok(total < 40 * 1024, `site is ${total} bytes`);
});
