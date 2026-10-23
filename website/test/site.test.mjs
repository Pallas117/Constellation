// Static-site checks for lightbound.uk:  npm run test:website
// GAU-12 claim rules on /gauss/, brand and security rules everywhere, Turnstone stays secret, size budgets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { APP_CSP, SECURITY_HEADERS } from "../worker/headers.js";
import { renderApplyForm } from "../worker/forms.js";
import { renderPlans } from "../worker/render.js";
import { FEATURES, SHOW_PRICES, TIERS, priceLabel } from "../worker/tiers.js";

const pub = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const read = (f) => readFileSync(join(pub, f), "utf8");
const size = (f) => statSync(join(pub, f)).size;
const text = (s) => s.replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ");
const PAGES = { "/": "index.html", "/gauss/": "gauss/index.html", "/constellation/": "constellation/index.html", "/turnstone/": "turnstone/index.html", "/404": "404.html",
  "/gauss/apply/": "gauss/apply/index.html", "/constellation/apply/": "constellation/apply/index.html", "/privacy/": "privacy/index.html",
  "/app/": "app/index.html", "/app/admin/": "app/admin/index.html", "/gauss/evidence/": "gauss/evidence/index.html",
  "/constellation/time/": "constellation/time/index.html", "/argo/": "argo/index.html",
  "/education/": "education/index.html", "/education/apply/": "education/apply/index.html", "/constellation/workshops/": "constellation/workshops/index.html", "/terms/": "terms/index.html" };
const html = Object.fromEntries(Object.entries(PAGES).map(([route, f]) => [route, read(f)]));
const API_ROUTES = new Set(["/api/launches", "/api/launches.ics", "/api/space-weather", "/api/health", "/cdn-cgi/access/logout"]);

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
  assert.match(hero, /href="\/gauss\/apply\/\?plan=pilot"/, "call to action in the hero");
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

test("terms: ethical use after ESA and NASA principles, month-to-month plans, cancel any time, refund if not satisfied; marked as a draft", () => {
  const t = text(html["/terms/"]);
  for (const want of [/Outer Space Treaty and the Artemis Accords/, /ESA.{1,7}s and NASA.{1,7}s data policies/, /NASA.{1,7}s principles for ethical AI/, /peaceful purposes/,
    /never commands a spacecraft/, /no minimum term and no cancellation fee/, /Cancel any time in one click/, /within 30 days of any payment/, /England and Wales/])
    assert.match(t, want);
  assert.match(html["/terms/"], /<strong>Draft for legal review\.<\/strong>/, "not in force until a lawyer has read it");
  assert.match(html["/terms/"], /id="ethics"[\s\S]*id="cancel"/);
  assert.match(text(html["/education/"]), /full refund if you(&rsquo;|')re not satisfied/, "/education/: says how to leave");
});

test("every page with a footer menu has the same one, Privacy included", () => {
  const foot = (p) => [...(p.match(/<nav aria-label="Footer">([\s\S]*?)<\/nav>/)?.[1] ?? "").matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  const want = ["/gauss/", "/constellation/", "/turnstone/", "mailto:jzwnathan@lightbound.uk", "/privacy/", "/terms/"]; // three projects only (Josh, 2026-10-22)
  for (const [route, page] of Object.entries(html)) if (page.includes('aria-label="Footer"')) assert.deepEqual(foot(page), want, route);
});

test("every page has one h1, the same main navigation and the same footer links", () => {
  const nav = (p) => [...(p.match(/<nav aria-label="Main">([\s\S]*?)<\/nav>/)?.[1] ?? "").matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  for (const [route, page] of Object.entries(html)) {
    assert.equal((page.match(/<h1[\s>]/g) || []).length, 1, `${route}: exactly one h1`);
    const auth = route.startsWith("/app/") ? "/cdn-cgi/access/logout" : "/app/";
    assert.deepEqual(nav(page), ["/gauss/", "/constellation/", "/turnstone/", auth], `${route}: main nav ends with sign in/out`);
    assert.match(page, /<html lang="en-GB">/);
    assert.match(page, /<a class="skip" href="#main">/);
  }
});

test("colours come only from the Lightbound palette", () => {
  // Lightbound Design System tokens (v3, 18 Oct 2026), incl. Constellation navy/gold, Turnstone signal/earth blue, status colours.
  const allowed = new Set(["#050505", "#0d1010", "#252a2a", "#f3f0e8", "#87938e", "#ccff00", "#e7b14a", "#fff",
    "#081c4d", "#1c3470", "#b0906f", "#318ada", "#f0782a", "#a9aba6", "#4e972f", "#d4673b"]);
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
  // The one way in: Josh's booking page, worded neutrally (Josh, 2026-10-22).
  assert.match(page, /<a class="btn" href="https:\/\/cal\.com\/joshua-nathan-xrnrqh\/30min" rel="noopener">Request a briefing<\/a>/);
  for (const [route, p] of Object.entries(html))
    assert.doesNotMatch(text(p), /Turnstone[^.]{0,120}(consult|hardware|security)|(consult|hardware|security)[^.]{0,120}Turnstone/i, route);
});

// ---- Security ----
test("security: strict CSP, no scripts, no inline styles or handlers, nothing loaded from elsewhere", () => {
  const meta = (csp) => csp.replace("; frame-ancestors 'none'", "");
  for (const [route, page] of Object.entries(html)) {
    const csp = meta(route.startsWith("/app/") ? APP_CSP : SECURITY_HEADERS["Content-Security-Policy"]);
    assert.ok(page.includes(`http-equiv="Content-Security-Policy" content="${csp}"`), `${route}: meta CSP`);
    // The only script element allowed is a JSON-LD data block (never executed); it must parse and can't close itself early.
    const code = page.replace(/<script type="application\/ld\+json">([^<]*)<\/script>/g, (m, json) => (JSON.parse(json), ""));
    assert.doesNotMatch(code, /<script|\son\w+="|\sstyle=/i, `${route}: script or inline style`);
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
    for (const [, url] of page.matchAll(/(?:href|src|srcset)="(\/[^"#?]*)(?:[?#][^"]*)?"/g)) {
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
  assert.deepEqual(doors(html["/"]), ["/gauss/", "/constellation/", "/turnstone/"], "three projects");
  assert.match(html["/"], /<a href="\/education\/">Gauss for Education<\/a>, part of <a href="\/constellation\/#outreach">Constellation&rsquo;s outreach<\/a>/);
  assert.match(html["/"], /Email Josh, the founder/);
  assert.deepEqual(doors(html["/argo/"]), ["/gauss/", "/constellation/"]);
  assert.deepEqual(doors(html["/gauss/"]), ["/constellation/", "/turnstone/"]);
  assert.deepEqual(doors(html["/constellation/"]), ["/gauss/", "/turnstone/"]);
  assert.match(html["/turnstone/"], /<a class="btn ghost" href="\/">Back to Lightbound<\/a>/);
});

test("descent: black hole to aurora and Van Allen belts, scroll-driven CSS only, a still frame for reduced motion", () => {
  const home = html["/"];
  const block = home.match(/<!--descent-->([\s\S]*?)<!--\/descent-->/)?.[1] ?? "";
  assert.match(block, /^<svg class="descent-art" viewBox="-320 -200 640 400" role="img" aria-labelledby="descent-t descent-d">/, "generated by tools/make_descent.py");
  assert.match(block, /<title id="descent-t">[^<]+<\/title><desc id="descent-d">[^<]+<\/desc>/);
  assert.match(block, /href="\/assets\/media\/blackhole-poster\.jpg"/, "reuses the hero poster: no new download");
  assert.doesNotMatch(home.replace(/<script type="application\/ld\+json">[^<]*<\/script>/, ""), /<script|\son[a-z]+="/i, "no script or inline handlers");
  assert.equal((home.match(/<li><p class="label">0[1-5] \/ 05<\/p>/g) ?? []).length, 5);
  assert.match(home, /<a href="\/gauss\/">Gauss<\/a> tells their teams which data to trust\./);
  assert.match(home, /A sketch of a dipole field, not a model\./, "labelled a sketch");
  const css = read("assets/site.css");
  const animated = css.slice(css.indexOf("@supports (animation-timeline:view()){"), css.indexOf("/* The ring ends exactly"));
  assert.match(animated, /^@supports \(animation-timeline:view\(\)\)\{\s*@media \(prefers-reduced-motion:no-preference\)\{/, "animation only where supported and wanted");
  assert.match(animated, /\.descent\{height:320svh;padding:0;view-timeline:--descent block\}/);
  assert.match(animated, /li:focus-within\{opacity:1!important/, "a focused caption is always visible");
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{\.d-particles\{display:none\}\}/, "the particles stop for reduced motion");
});

test("flow: each door's mark carries into its page (view transitions), names unique per page", () => {
  for (const [route, page] of Object.entries(html)) {
    const names = [...page.matchAll(/class="[^"]*\bvt-([a-z]+)\b/g)].map((m) => m[1]);
    assert.equal(new Set(names).size, names.length, `${route}: duplicate view-transition name ${names}`);
  }
  assert.match(html["/gauss/"], /class="lockup vt-gauss"/);
  assert.match(html["/constellation/"], /class="lockup[^"]*\bvt-constellation"/);
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

// ---- Applications, plans and sign-in ----
test("apply pages: the static form is exactly what the Worker renders, and posts to our own origin", () => {
  for (const kind of ["gauss", "constellation"]) {
    const page = html[`/${kind}/apply/`];
    const fallback = page.match(/<!--live:apply-->([\s\S]*?)<!--\/live:apply-->/)[1];
    assert.equal(fallback, renderApplyForm(kind), `${kind}: static form drifted from forms.js`);
    assert.match(fallback, /<form class="form" method="post" action="\/api\/apply">/);
    assert.match(fallback, /name="consent" value="yes" required/);
    assert.match(fallback, /<div class="hp" aria-hidden="true">/, "honeypot present");
    assert.match(fallback, /<a href="\/privacy\/">Privacy<\/a>/);
  }
  assert.match(SECURITY_HEADERS["Content-Security-Policy"], /form-action 'self'/);
  assert.match(read("assets/site.css"), /\.hp\{position:absolute;left:-9999px/);
});

test("plans: packages and prices follow the sales plan; honest features only", () => {
  // Gauss Aurora repo, docs/SALES_FEATURE_LIST_AND_ONBOARDING.md (21 Aug 2026), "Commercial packages".
  const expected = { pilot: "£20k–£40k per pilot", fleet_integration: "£60k–£125k a year", mission_integration: "£120k–£300k one-off", flight_candidate_adapter: "£750k–£2.5m one-off" };
  assert.equal(SHOW_PRICES, true);
  assert.deepEqual(Object.fromEntries(TIERS.map((t) => [t.id, priceLabel(t)])), expected);
  assert.deepEqual(TIERS.map((t) => t.billing), ["payment", "subscription", "invoice", "invoice"]);
  const words = JSON.stringify({ TIERS, FEATURES });
  for (const rx of [/mitigation/i, /qrnn|qubit|quantum/i, /automat/i, /\bcommand/i, /certif|complian|qualif/i, /air-gapped/i, /early warning/i, /\bdispatch/i, /\$\d/])
    assert.doesNotMatch(words, rx, `tiers.js claims ${rx}`);
  const plans = renderPlans();
  for (const label of Object.values(expected)) assert.ok(plans.includes(label), label);
  assert.match(plans, /never commands a spacecraft/);
  assert.match(plans, /Federated Bridge Node[^<]*hosted-payload or in-orbit demonstration[^<]*Future work, not on sale/, "future IOD work labelled");
  assert.match(html["/gauss/"], /<!--live:plans-->[\s\S]*Flight Candidate Adapter[\s\S]*<!--\/live:plans-->/, "static fallback keeps the gated roadmap");
});

test("GAU-12: leads with Fleet Integration; the replay demo and evidence link are there and labelled synthetic", () => {
  const hero = gauss.match(/<section class="hero-gauss[^"]*"[\s\S]*?<\/section>/)[0];
  assert.match(hero, /01_GAUSS · FLEET INTEGRATION/);
  assert.match(text(hero), /mission-data, ground-segment and mission-operations teams/, "buyer named as in the sales plan");
  assert.match(text(hero), /ground-first mission-data assurance and protection layer/, "product statement from the sales plan");
  assert.match(hero, /href="#replay"/);
  const replay = gauss.match(/<section id="replay"[\s\S]*?<\/section>/)[0];
  assert.match(text(replay), /Synthetic · screening evidence/);
  assert.match(text(replay), /Illustrative data, not a mission record/);
  for (const state of ["nominal", "degraded", "abstain", "unknown", "blocked"]) assert.match(replay, new RegExp(`class="st ${state}"`), state);
  assert.match(replay, /Deterministic fallback/);
  assert.match(replay, /href="\/gauss\/evidence\/"/, "evidence link");
  const evidence = read("gauss/evidence/index.html");
  assert.match(text(evidence), /Synthetic · screening evidence/);
  assert.match(text(evidence), /not a mission record/);
  for (const rx of [/\bdose\b/i, /\bdamage\b/i, /failure[- ]probabilit/i]) assert.doesNotMatch(text(evidence), rx);
  assert.match(text(html["/"].match(/<section class="hero"[\s\S]*?<\/section>/)[0]), /Gauss tells satellite, ground-segment and onboard(?:-|&#8209;)AI teams which mission data they can trust/, "wedge and buyer on the first screen");
});

test("sales-plan entry points: /pilot and /sales redirect into the Gauss flow", () => {
  const rules = Object.fromEntries(read("_redirects").split("\n").filter((l) => l.trim() && !l.startsWith("#")).map((l) => l.trim().split(/\s+/)).map(([f, t, c]) => [f, [t, c]]));
  assert.deepEqual(rules, { "/pilot": ["/gauss/apply/?plan=pilot", "301"], "/sales": ["/gauss/#plans", "301"], "/argo/apply/": ["/argo/", "301"], "/argo/apply": ["/argo/", "301"] });
});

test("no page claims what the requirements rule out", () => {
  // Gauss Aurora docs: business memo, partner boundaries, validation pack (claims the site must not make).
  const pages = [...Object.values(html), read("gauss/evidence/index.html"), JSON.stringify({ TIERS, FEATURES })].map(text).join(" ");
  for (const rx of [/data[- ]cent(re|er) constellation/i, /online (model )?weight/i, /failure[- ]probabilit/i, /rad(iation)?[- ](hard|toleran)/i,
    /\bPQC\b|post-quantum|quantum-ready/i, /\bendorse/i, /eight-state/i, /\bLunaNet\b/i, /mission control as a service|ops-as-a-service/i])
    assert.doesNotMatch(pages, rx, `found ${rx}`);
});

test("customer copy never says how payment is taken (the privacy notice still names the processor)", () => {
  const pages = Object.entries(html).filter(([route]) => route !== "/privacy/").map(([, h]) => h);
  for (const page of [...pages, renderPlans(), renderApplyForm("gauss")].map(text))
    assert.doesNotMatch(page, /stripe|securely|card details|bank transfer/i);
  assert.match(read("privacy/index.html"), /Stripe/, "processors stay disclosed");
});

test("Gauss Argo: included for operators and staff, no price, not promoted, no grade claims", () => {
  const argo = text(html["/argo/"]);
  assert.match(argo, /Built like a spacecraft/i);
  assert.match(html["/argo/"], /It isn&rsquo;t available yet\./, "the private relay is not built");
  assert.match(argo, /TLS verification is never disabled\./);
  assert.match(argo, /Windows/, "says what it doesn't run on yet");
  // Store and forward (GAU-193): what it is built on, what the hub can see, and that the claim is a simulation.
  const deliver = text(html["/argo/"].match(/<section id="deliver"[\s\S]*?<\/section>/)[0]);
  for (const want of [/Bundle Protocol \(RFC&nbsp;9171\)/, /encrypted end to end to the receiving one \(HPKE, RFC&nbsp;9180\)/, /only ciphertext it can&rsquo;t read/, /signed receipt/, /five-day simulation/, /carry it there/])
    assert.match(deliver, want);
  assert.deepEqual([...html["/argo/"].matchAll(/<p class="label">(\d\d)_/g)].map((m) => Number(m[1])), [1, 2, 3, 4, 5, 6, 7, 8], "section numbers run in order");
  assert.match(argo, /included for operators, meaning teams with a paid Gauss plan, and for the Lightbound team/);
  assert.match(html["/argo/"], /<a class="btn" href="\/app\/">Operators: sign in to set it up<\/a>/);
  assert.match(html["/argo/"], /<meta name="robots" content="noindex">/, "reachable, not promoted");
  for (const rx of [/space[- ]grade/i, /space[- ]qualified/i, /military[- ]grade/i, /mission[- ]grade/i, /untraceable/i, /unhackable/i, /certified/i, /compliant/i, /\bVPN\b/, /£/, /\$\d/, /a month/i, /waitlist|early access|join the list/i, /\bAI\b/])
    assert.doesNotMatch(argo, rx, `found ${rx}`);
  assert.ok(!existsSync(join(pub, "argo/apply/index.html")), "no list to join");
  assert.match(read("_redirects"), /^\/argo\/apply\/  \/argo\/  301$/m, "old links still land somewhere");
  const gaussMain = html["/gauss/"].match(/<main[\s\S]*<\/main>/)[0];
  assert.doesNotMatch(text(gaussMain), /\$\d|a month/, "no price on the Gauss page (sales plan: no low-price Gauss SaaS)");
  assert.doesNotMatch(gaussMain, /href="\/argo\//, "the Gauss page offers Argo only as a scoped Assured Connectivity pilot");
  assert.match(read("assets/marks/argo-glyph-provisional.svg"), /provisional glyph, not yet in the Brand Book/, "until the Brand Book adds Argo");
  for (const [route, page] of Object.entries(html)) if (route !== "/argo/") assert.doesNotMatch(page, /href="\/argo\//, `${route}: Argo is only linked from the workspace`);
});

test("Gauss for Education: free for students, staff price TBC until set, an academic licence kept off the Gauss page", () => {
  const edu = text(html["/education/"]);
  assert.match(edu, /Free for students/);
  assert.match(html["/education/"], /<p class="price">Price TBC<\/p>/, "no invented staff price");
  assert.doesNotMatch(edu, /\$\d|£\d/, "no prices until Josh sets them");
  assert.match(edu, /For teaching and non-commercial research/);
  assert.match(edu, /prototype lab pack/i);
  for (const rx of [/certified/i, /accredited/i, /space[- ]qualified/i, /\bAI\b/]) assert.doesNotMatch(edu, rx, `found ${rx}`);
  assert.match(html["/education/apply/"], /<input type="hidden" name="kind" value="edu">/);
  assert.match(html["/education/apply/"], /<label for="f-email">University email<\/label>/);
  assert.doesNotMatch(text(html["/gauss/"].match(/<main[\s\S]*<\/main>/)[0]), /Education/, "not in the Gauss page itself (sales plan)");
  assert.match(html["/"], /<a href="\/education\/">Gauss for Education<\/a>, part of <a href="\/constellation\/#outreach">Constellation&rsquo;s outreach<\/a>, is free for students\./);
  const outreach = html["/constellation/"].match(/<section id="outreach"[\s\S]*?<\/section>/)[0];
  for (const href of ["/education/", "/education/apply/", "/constellation/workshops/", "/api/launches.ics", "/constellation/time/"]) assert.ok(outreach.includes(`href="${href}"`), `outreach links ${href}`);
  assert.match(html["/education/"], /<a href="\/constellation\/" aria-current="page">Constellation<\/a>/, "Education sits under Constellation");
  assert.match(html["/constellation/workshops/"], /href="\/education\/">Gauss for Education<\/a>/);
  assert.match(html["/privacy/"], /Gauss for Education/);
});

test("Constellation: events from its Luma calendar, then workshops on ethics, resilience and tech leadership, sections in order", () => {
  const page = html["/constellation/"];
  assert.match(page, /<!--live:events-->[\s\S]*href="https:\/\/luma\.com\/constellation"[\s\S]*<!--\/live:events-->/);
  const workshops = page.match(/<section id="workshops"[\s\S]*?<\/section>/)[0];
  for (const want of [/Ethics/, /Resilience/, /Tech leadership/, /Members join free/, /led by facilitators from the Constellation community/]) assert.match(text(workshops), want);
  // Every on-page menu link lands on a section of the same page.
  for (const route of ["/gauss/", "/constellation/", "/argo/", "/education/"]) {
    const menu = html[route].match(/<nav class="subnav" aria-label="On this page">([\s\S]*?)<\/nav>/)?.[1] ?? "";
    const ids = [...menu.matchAll(/href="#([a-z-]+)"/g)].map((m) => m[1]);
    assert.ok(ids.length >= 3, `${route}: on-page menu`);
    for (const id of ids) assert.match(html[route], new RegExp(`<section id="${id}"`), `${route}: #${id}`);
  }
  assert.match(workshops, /href="\/constellation\/workshops\/">Bring a workshop to your team/);
  const labels = [...page.matchAll(/<p class="label">(\d\d)_/g)].map((m) => Number(m[1]));
  assert.deepEqual(labels, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], "section numbers run in order");
  assert.match(html["/constellation/workshops/"], /<input type="hidden" name="kind" value="workshop">/);
  assert.match(html["/constellation/workshops/"], /<body class="page brand-constellation">/);
  assert.match(html["/privacy/"], /a workshop for your team/);
});

test("Constellation is free and invite-only: no prices, no payment, invitation wording", () => {
  for (const route of ["/constellation/", "/constellation/apply/", "/constellation/workshops/"]) {
    assert.doesNotMatch(text(html[route]), /£|\$\d|stripe|price|pay /i, `${route}: no pricing`);
    if (route === "/constellation/workshops/") continue;
    assert.match(text(html[route]), /free/i);
    assert.match(text(html[route]), /invit/i);
  }
  assert.match(html["/constellation/apply/"], /<button class="btn" type="submit">Request an invitation<\/button>/);
  assert.match(text(html["/"]), /The space community\. Free, by invitation\./);
});

test("signed-in pages are private shells; the Worker fills them only after sign-in", () => {
  for (const route of ["/app/", "/app/admin/"]) {
    assert.match(html[route], /<meta name="robots" content="noindex">/);
    assert.doesNotMatch(html[route], /@example|@lightbound\.uk(?!")/i, "no personal data in a static shell");
  }
  assert.match(html["/privacy/"], /180 days/);
  assert.match(text(html["/privacy/"]), /card or bank details never reach Lightbound/);
  assert.match(APP_CSP, /form-action 'self' https:\/\/checkout\.stripe\.com https:\/\/billing\.stripe\.com/);
  assert.doesNotMatch(SECURITY_HEADERS["Content-Security-Policy"], /stripe/, "public pages never post off-site");
});
test("production config: no Stripe secrets, no local stand-in, no test keys anywhere in the site", () => {
  const config = readFileSync(join(pub, "..", "wrangler.jsonc"), "utf8");
  assert.doesNotMatch(config, /"STRIPE_/, "Stripe values belong in Worker secrets, not wrangler.jsonc");
  assert.doesNotMatch(config, /"ACCESS_JWKS"/, "the dev signing key must never be configured in production");
  for (const f of walk(join(pub, ".."))) {
    if (f.includes(`${join("website", "public", "assets")}`) && !f.endsWith(".css")) continue; // binary assets
    assert.doesNotMatch(readFileSync(f, "utf8"), /\b(sk|rk)_(live|test)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}/, `${f}: looks like a Stripe key`);
  }
});

// ---- Brand Book (15-18 Oct 2026): Turnstone v6, Constellation navy and gold, shared status colours ----
const symbol = (f) => readFileSync(join(pub, "..", "tools", "symbols", f), "utf8");
test("brand: all four marks are the refined Design System symbols, unchanged, with no blur filters", () => {
  assert.equal(read("assets/marks/lightbound-mark-colour-dark.svg"), symbol("lightbound-symbol-colour-dark.svg"));
  assert.equal(read("assets/marks/gauss-aurora-mark-colour-dark.svg"), symbol("gauss-aurora-symbol-colour-dark.svg"));
  for (const f of readdirSync(join(pub, "assets", "marks"))) assert.doesNotMatch(read(`assets/marks/${f}`), /<filter|feGaussianBlur/, `${f}: flat marks only`);
  assert.match(read("assets/marks/gauss-aurora-horizontal-colour-dark.svg"), /aria-label="Gauss Aurora"/);
  assert.match(read("assets/marks/lightbound-horizontal-colour-dark.svg"), /aria-label="Lightbound"/);
  assert.equal(read("assets/marks/turnstone-mark-colour-dark.svg"), symbol("turnstone-symbol-colour-dark.svg"));
  assert.equal(read("assets/marks/turnstone-badge-colour-dark.svg"), symbol("turnstone-badge-symbol-colour-dark.svg"));
  assert.equal(read("assets/marks/constellation-mark-colour-dark.svg"), symbol("constellation-symbol-colour-dark.svg"));
  assert.equal(read("assets/marks/constellation-icon-colour-dark.svg"), symbol("constellation-icon-symbol-colour-dark.svg"));
  const ts = read("assets/marks/turnstone-mark-colour-dark.svg");
  assert.ok(ts.includes("#318ada") && ts.includes("#f0782a"), "earth-blue feathers and tide, signal-orange legs");
  const cn = read("assets/marks/constellation-mark-colour-dark.svg");
  assert.ok(cn.includes("#081c4d") && cn.includes("#b0906f"), "navy disc, gold ring and nodes");
  for (const f of readdirSync(join(pub, "assets", "marks")).filter((n) => /^(turnstone|constellation)-/.test(n)))
    assert.doesNotMatch(read(`assets/marks/${f}`), /<filter|<script/, f);
  assert.match(read("assets/marks/constellation-horizontal-colour-dark.svg"), /aria-label="Constellation, space community group"/);
});

test("brand: Constellation pages are navy and gold, carry the motto and values, and no Lightbound endorsement", () => {
  for (const route of ["/constellation/", "/constellation/apply/"]) {
    assert.match(html[route], /<body class="page brand-constellation">/, route);
    assert.match(html[route], /<link rel="icon" href="\/assets\/marks\/constellation-icon-colour-dark\.svg"/, route);
    // The legal line ("operated by Lightbound Limited") stays; no endorsement badge or "from Lightbound" framing.
    assert.doesNotMatch(text(html[route]), /a Lightbound company|from Lightbound(?!\.uk)|by Lightbound(?! Limited)/i, `${route}: no company badge`);
  }
  assert.match(text(html["/constellation/"]), /Per aspera ad astra: through adversity we go beyond\./);
  for (const v of ["Intentionality", "Radical integrity", "Accountability", "The Golden Rule"]) assert.ok(text(html["/constellation/"]).includes(v), v);
  const css = read("assets/site.css");
  assert.match(css, /\.brand-constellation\{--accent:#B0906F;--accent2:#B0906F;--panel:#081C4D;--char:#1C3470;/);
});

test("brand: Turnstone page shows the v6 mark, wordmark and tagline, and still nothing about what it does", () => {
  const page = html["/turnstone/"];
  assert.match(page, /<body class="page brand-turnstone">/);
  assert.match(page, /<link rel="icon" href="\/assets\/marks\/turnstone-badge-colour-dark\.svg"/);
  assert.match(text(page), /TURNSTONE A Lightbound company/);
  assert.match(text(page), /TURNING TIDES/);
  assert.match(read("assets/site.css"), /\.brand-turnstone\{--accent:#F0782A;--accent2:#318ADA;/);
});

test("brand: shared status colours and no shadows outside marks and photos", () => {
  const css = read("assets/site.css");
  assert.match(css, /--live:#4E972F;--sim:#318ADA;--danger:#D4673B;/);
  assert.match(css, /\.chip\.live\{color:var\(--live\)\}/, "LIVE is the status green, always with its word");
  assert.match(gauss, /<span class="chip sim">Synthetic · screening evidence<\/span>/, "synthetic = SIMULATED blue");
  assert.doesNotMatch(css, /text-shadow|drop-shadow|box-shadow:(?!inset 0 -1px)/, "no drop shadows or glows");
  assert.match(css, /\.btn\{[^}]*border-radius:4px/, "4 px controls");
});
// ---- GAU-137 accuracy (review of addfbe1 against Constellation main and the 17 Oct radiation study) ----
test("GAU-137: bit errors follow the proton (S) level, link gaps the geomagnetic (G) level; built vs planned is explicit", () => {
  const replay = gauss.match(/<section id="replay"[\s\S]*?<\/section>/)[0];
  for (const li of replay.match(/<li>[\s\S]*?<\/li>/g)) {
    if (/bit errors/i.test(li)) assert.match(li, /S[1-5]/, "a bit-error step names the S level");
    if (/link gap/i.test(li)) assert.match(li, /Geomagnetic/i);
  }
  const evidence = read("gauss/evidence/index.html");
  assert.doesNotMatch(text(evidence), /bit-error[^.]*\bG[1-5]\b/i, "bit errors never pinned on a G level");
  assert.match(text(evidence), /public NOAA space-weather data/);
  assert.doesNotMatch(text(evidence), /space-weather scales/);
  assert.match(text(gauss), /elevated space-weather conditions \(proton, electron and geomagnetic levels\)/);
  assert.match(text(gauss), /Being built for the first pilots: ingest of your own logs, output flagging and the evidence export/);
  assert.match(text(gauss), /Yamcs \(pilot integration\)/);
  assert.match(text(gauss), /ONNX \(pilot integration\)/);
});

test("Constellation: friends' logos are local files shown as supplied, named, and link out safely; group calls are offered", () => {
  const page = html["/constellation/"];
  const friends = page.match(/<ul class="friends">[\s\S]*?<\/ul>/)[0];
  const items = [...friends.matchAll(/<a class="friend" href="(https:\/\/[^"]+)" rel="noopener noreferrer"><img src="(\/assets\/partners\/[a-z]+\.png)" alt="([^"]+)"/g)];
  assert.deepEqual(items.map((m) => m[3]), ["xOrbita", "Pan Galactic Corporation", "Aphelion Industries"]);
  for (const [, , src] of items) assert.ok(statSync(join(pub, src)).size > 0, src);
  assert.match(text(page), /Friends of Constellation\./);
  assert.doesNotMatch(read("assets/site.css").match(/\.friend[^{]*\{[^}]*\}/g).join(""), /filter|grayscale/, "logos are not recoloured");
  assert.match(page, /href="\/constellation\/time\/">Plan across time zones/);
  assert.match(html["/constellation/time/"], /<body class="page brand-constellation">/);
  assert.match(html["/constellation/time/"], /<!--live:planner-->/);
});

test("Assured Connectivity: on the Gauss page, what Argo does today, a pilot route, no price or payment", () => {
  const sec = gauss.match(/<section id="connectivity"[\s\S]*?<\/section>/)?.[0];
  assert.ok(sec, "connectivity section on /gauss/");
  const t = text(sec);
  for (const want of [/Assured Connectivity/, /Argo/, /Self-healing/, /Wi-Fi security/, /Advice only/, /Mac and Linux/, /Running today on Lightbound's own laptops/])
    assert.match(t, want);
  assert.match(sec, /href="mailto:jzwnathan@lightbound\.uk\?subject=Assured%20Connectivity%20pilot"/);
  assert.doesNotMatch(t, /£|\$|per month|a year|Stripe|card|invoice/i, "no price or payment wording");
  // The numbered sections (id'd <section>s); the hero and the doors to other pages carry their own labels.
  const order = [...gauss.matchAll(/<section id="[^"]+"[^>]*>\s*<div class="wrap">\s*(?:<div class="section-head"><div>)?<p class="k">(\d\d)_/g)].map((m) => Number(m[1]));
  assert.ok(order.includes(6) && order.length >= 7, `found ${order}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "section numbers stay in order");
});


test("traffic: every indexable page has share cards and is in the sitemap; robots points to it", () => {
  const sitemap = read("sitemap.xml");
  const listed = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  for (const [route, page] of Object.entries(html)) {
    if (route.startsWith("/app/")) continue;
    const noindex = /<meta name="robots" content="noindex">/.test(page);
    const canon = page.match(/<link rel="canonical" href="([^"]+)">/)?.[1];
    if (noindex) { assert.ok(!listed.includes(canon), `${route}: noindex pages stay out of the sitemap`); continue; }
    assert.ok(canon && listed.includes(canon), `${route}: in the sitemap`);
    for (const p of ["og:title", "og:description", "og:image", "og:type", "og:site_name"]) assert.match(page, new RegExp(`<meta property="${p}" content="[^"]+">`), `${route}: ${p}`);
    assert.match(page, new RegExp(`<meta property="og:url" content="${canon.replace(/[/.]/g, "\\$&")}">`), `${route}: og:url is the canonical`);
    assert.match(page, /<meta name="twitter:card" content="summary_large_image">/, route);
  }
  assert.ok(!listed.some((u) => /\/(turnstone|argo|app)\//.test(u)), "secret, unpromoted and signed-in pages never listed");
  assert.match(read("robots.txt"), /^Disallow: \/app\/$[\s\S]*^Sitemap: https:\/\/lightbound\.uk\/sitemap\.xml$/m);
  const ld = JSON.parse(html["/"].match(/<script type="application\/ld\+json">([^<]*)<\/script>/)[1]);
  assert.equal(ld["@graph"][0].name, "Lightbound Limited");
  assert.deepEqual(ld["@graph"][0].sameAs, ["https://luma.com/constellation"]);
  for (const [route, page] of Object.entries(html)) if (route !== "/") assert.doesNotMatch(page, /<script/, `${route}: no data blocks elsewhere`);
});
