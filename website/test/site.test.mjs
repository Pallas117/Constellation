// Static-site checks for lightbound.uk:  npm run test:website
// GAU-12 claim rules on /gauss/, brand and security rules everywhere, Turnstone stays secret, size budgets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SECURITY_HEADERS } from "../worker/headers.js";

const pub = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const read = (f) => readFileSync(join(pub, f), "utf8");
const size = (f) => statSync(join(pub, f)).size;
const text = (s) => s.replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ");
const PAGES = { "/": "index.html", "/gauss/": "gauss/index.html", "/constellation/": "constellation/index.html", "/turnstone/": "turnstone/index.html", "/404": "404.html" };
const html = Object.fromEntries(Object.entries(PAGES).map(([route, f]) => [route, read(f)]));
const API_ROUTES = new Set(["/api/launches", "/api/launches.ics", "/api/space-weather", "/api/health"]);

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

// ---- GAU-12: the Gauss page ----
const gauss = html["/gauss/"];
const claimsBox = gauss.match(/<h3>We don't claim<\/h3>[\s\S]*?<\/ul>/)?.[0] ?? "";
const gaussBody = text(gauss.replace(claimsBox, ""));

test("GAU-12: Gauss wedge, buyer and call to action are in the first screen", () => {
  const hero = gauss.match(/<section class="hero-gauss[^"]*"[\s\S]*?<\/section>/)[0];
  assert.match(text(hero), /trust/i);
  assert.match(text(hero), /Built for .*(onboard-AI|orbital-compute|satellite operations)/);
  assert.match(hero, /href="#contact"/, "call to action in the hero");
});

test("GAU-12: no unsupported flight, qualification, dose, damage, customer or A*STAR/QPIN claims", () => {
  const banned = [
    /flight[- ]?(ready|readiness|proven|heritage|qualified)/i, /space[- ]qualifi/i, /\bqualified\b/i,
    /\bdose\b/i, /\bdamage\b/i, /\bcustomers?\b/i, /A\*?STAR/i, /\bQPIN\b/i,
    /\bpartnership\b|\bpartnered\b|\bpartners with\b/i, /\bcertified\b/i, /\bcompliant\b/i, /\b(can|will|to) command\b/i,
  ];
  for (const rx of banned) assert.doesNotMatch(gaussBody, rx, `found ${rx} outside the "we don't claim" box`);
  assert.match(text(claimsBox), /Flight readiness/);
  assert.match(text(claimsBox), /dose/);
});

test("GAU-12: partner boundaries, advisory status and contact route are explicit", () => {
  assert.match(gaussBody, /Design-partner paths: we are working towards validation pilots with JAOPS and xOrbita/);
  assert.match(gaussBody, /advisory/i);
  assert.match(gauss, /href="mailto:[^"]+@lightbound\.uk/);
  assert.match(gaussBody, /company no\. 14573199/);
});

// ---- Honesty and brand, every page ----
test("no page claims certification, compliance, qualification or customers", () => {
  for (const [route, page] of Object.entries(html)) {
    if (route === "/gauss/") continue; // covered above, with its claims box
    for (const rx of [/\bcertified\b/i, /\bcompliant\b/i, /space[- ]qualifi/i, /flight[- ]?(ready|proven)/i, /\bcustomers?\b/i, /\bpartnership\b/i])
      assert.doesNotMatch(text(page), rx, `${route}: ${rx}`);
  }
});

test("landing: the tagline is the headline, over the kit's black-hole film", () => {
  const home = html["/"];
  assert.equal(text(home.match(/<h1 id="hero-h">[\s\S]*?<\/h1>/)[0]).trim(), "Carry hope, go beyond.");
  const video = home.match(/<video[\s\S]*?<\/video>/)[0];
  for (const attr of ["autoplay", "muted", "loop", "playsinline", 'poster="/assets/media/blackhole-poster.jpg"', 'aria-hidden="true"'])
    assert.ok(video.includes(attr), `video lacks ${attr}`);
  assert.match(video, /media="\(prefers-reduced-motion: no-preference\)"/, "no film for people who asked for reduced motion");
  assert.match(read("assets/site.css"), /prefers-reduced-motion:reduce\)\{\.hero \.film\{display:none\}/);
  assert.match(home, /<img class="poster" src="\/assets\/media\/blackhole-poster\.jpg"/, "still frame without JS or video");
});

test("every page has one h1, the same main navigation and the same footer links", () => {
  const nav = (p) => [...(p.match(/<nav aria-label="Main">([\s\S]*?)<\/nav>/)?.[1] ?? "").matchAll(/href="([^"]+)"/g)].map((m) => m[1]).slice(0, 3);
  for (const [route, page] of Object.entries(html)) {
    assert.equal((page.match(/<h1[\s>]/g) || []).length, 1, `${route}: exactly one h1`);
    assert.deepEqual(nav(page), ["/gauss/", "/constellation/", "/turnstone/"], `${route}: main nav`);
    assert.match(page, /<html lang="en-GB">/);
    assert.match(page, /<a class="skip" href="#main">/);
  }
});

test("colours come only from the Lightbound palette", () => {
  const allowed = new Set(["#050505", "#0d1010", "#252a2a", "#f3f0e8", "#87938e", "#ccff00", "#e7b14a", "#c2552a", "#fff"]);
  for (const hex of read("assets/site.css").match(/#[0-9a-f]{3,8}\b/gi)) assert.ok(allowed.has(hex.toLowerCase()), `off-palette colour ${hex}`);
});

test("marks are served without embedded C2PA metadata", () => {
  for (const f of walk(join(pub, "assets", "marks"))) assert.doesNotMatch(readFileSync(f, "utf8"), /<metadata|c2pa/i, f);
});

// ---- Turnstone is a secret project ----
test("Turnstone: mark and name only; nothing says what it does", () => {
  const door = html["/"].match(/<li><a class="door" href="\/turnstone\/">[\s\S]*?<\/li>/)[0];
  const tells = /consult|hardware|security|services|clients|defen[cs]e|engagement|advis/i;
  assert.doesNotMatch(text(door), tells);
  const page = html["/turnstone/"];
  assert.doesNotMatch(text(page), tells);
  assert.match(page, /<meta name="robots" content="noindex">/);
  for (const [route, p] of Object.entries(html))
    assert.doesNotMatch(text(p), /Turnstone[^.]{0,120}(consult|hardware|security)|(consult|hardware|security)[^.]{0,120}Turnstone/i, route);
});

// ---- Security ----
test("security: strict CSP, no scripts, no inline styles or handlers, nothing loaded from elsewhere", () => {
  const metaCsp = SECURITY_HEADERS["Content-Security-Policy"].replace("; frame-ancestors 'none'", "");
  for (const [route, page] of Object.entries(html)) {
    assert.ok(page.includes(`http-equiv="Content-Security-Policy" content="${metaCsp}"`), `${route}: meta CSP`);
    assert.doesNotMatch(page, /<script|\son\w+="|\sstyle=/i, `${route}: script or inline style`);
    for (const [, url] of page.matchAll(/(?:\ssrc|srcset|<link[^>]*\shref)="(https?:[^"]+)"/g))
      assert.match(url, /^https:\/\/lightbound\.uk\//, `${route}: third-party resource ${url}`);
  }
});

test("security: _headers and the Worker send the same headers", () => {
  const block = read("_headers").split(/\n(?=\/)/).find((b) => b.startsWith("/*\n"));
  const parsed = Object.fromEntries(block.split("\n").slice(1).filter((l) => l.trim() && !l.trim().startsWith("#")).map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]));
  assert.deepEqual(parsed, { ...SECURITY_HEADERS });
  assert.match(SECURITY_HEADERS["Strict-Transport-Security"], /max-age=31536000; includeSubDomains/);
});

test("every link and resource resolves", () => {
  for (const [route, page] of Object.entries(html)) {
    const ids = new Set([...page.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    for (const [, target] of page.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(target), `${route}: #${target} has no target`);
    for (const [, url] of page.matchAll(/(?:href|src|srcset)="(\/[^"#]*)(?:#[^"]*)?"/g)) {
      if (API_ROUTES.has(url)) continue;
      const file = url.endsWith("/") ? `${url}index.html` : url;
      assert.ok(existsSync(join(pub, file)) && size(file) > 0, `${route}: ${url} missing`);
    }
  }
  for (const [, anchor] of html["/"].matchAll(/href="\/#([^"]+)"/g)) assert.match(html["/"], new RegExp(`id="${anchor}"`));
});

test("live sections have their markers, with a working static fallback", () => {
  const has = (route, m) => assert.match(html[route], new RegExp(`<!--live:${m}-->[\\s\\S]*?<!--/live:${m}-->`), `${route} ${m}`);
  for (const m of ["gauss-door", "constellation-door"]) has("/", m);
  for (const m of ["launches", "weather", "gauss-door"]) has("/constellation/", m);
  has("/gauss/", "constellation-door");
});

// ---- Flow ----
test("flow: no dead ends; each product page ends with the other doors, Turnstone leads home", () => {
  const doors = (p) => [...p.matchAll(/<a class="door" href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(doors(html["/"]), ["/gauss/", "/constellation/", "/turnstone/"]);
  assert.deepEqual(doors(html["/gauss/"]), ["/constellation/", "/turnstone/"]);
  assert.deepEqual(doors(html["/constellation/"]), ["/gauss/", "/turnstone/"]);
  assert.match(html["/turnstone/"], /<a class="btn ghost" href="\/">Back to Lightbound<\/a>/);
});

test("flow: each door's mark carries into its page (view transitions), names unique per page", () => {
  for (const [route, page] of Object.entries(html)) {
    const names = [...page.matchAll(/class="[^"]*\bvt-([a-z]+)\b/g)].map((m) => m[1]);
    assert.equal(new Set(names).size, names.length, `${route}: duplicate view-transition name ${names}`);
  }
  assert.match(html["/gauss/"], /class="lockup vt-gauss"/);
  assert.match(html["/constellation/"], /class="lockup vt-constellation"/);
  assert.match(html["/turnstone/"], /class="mark vt-turnstone"/);
  const css = read("assets/site.css");
  assert.match(css, /@media \(prefers-reduced-motion:no-preference\)\{\s*@view-transition\{navigation:auto\}/, "transitions only without reduced motion");
  for (const n of ["gauss", "constellation", "turnstone"]) assert.match(css, new RegExp(`\\.vt-${n}\\{view-transition-name:mark-${n}\\}`));
});

test("flow: the header sticks on every page; anchors land below it", () => {
  for (const [route, page] of Object.entries(html)) assert.match(page, /<header class="top( over)?">\n  <div class="wrap bar">/, route);
  const css = read("assets/site.css");
  assert.match(css, /\.top\{position:sticky;top:0/);
  assert.match(css, /scroll-padding-top:76px/);
});

// ---- Budgets: beat a heavy reference site on weight, on an 8 GB laptop or a phone on a hotspot ----
test("budgets: first view under 200 KB before the film; film under 300 KB; whole site under 1 MB", () => {
  const firstView = ["index.html", "assets/site.css", "assets/fonts/plex-sans-400.woff2", "assets/fonts/plex-sans-600.woff2",
    "assets/fonts/jetbrains-mono-700.woff2", "assets/marks/lightbound-horizontal-colour-dark.svg", "assets/media/blackhole-poster.jpg"];
  const first = firstView.reduce((n, f) => n + size(f), 0);
  assert.ok(first < 200 * 1024, `first view is ${first} bytes`);
  assert.ok(size("assets/media/blackhole-720p.mp4") < 300 * 1024, "film too big");
  const total = walk(pub).reduce((n, f) => n + statSync(f).size, 0);
  assert.ok(total < 1024 * 1024, `site is ${total} bytes`);
});
