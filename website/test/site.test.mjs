// Static-site checks for lightbound.space:  npm run test:website
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
import { CONTACT, forRelease } from "../worker/release.js";
import { consoleLink, staffCard } from "../worker/app.js";
import { supportLink } from "../worker/render.js";
import { CONTACT_PILL, SIGN_IN_PILL, configFor, configRelease, headerFor, headerPages, validate } from "../tools/release.mjs";

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
// wrangler.jsonc, read as JSON once its whole-line comments are gone.
const WRANGLER_RAW = readFileSync(join(pub, "..", "wrangler.jsonc"), "utf8");
const WRANGLER = JSON.parse(WRANGLER_RAW.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));
const WORKER_ROUTES = WRANGLER.assets.run_worker_first;
const RELEASE = WRANGLER.vars.RELEASE; // "public" on lightbound.space today; tools/release.mjs switches config and headers together
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

test("landing film on phones: soft-edged hole, slogan on screen, no play button, hidden once covered", () => {
  const css = read("assets/site.css");
  const portrait = css.match(/@media \(max-aspect-ratio:1\/1\)\{\n[\s\S]*?\n\}/)[0];
  // The whole 16:9 frame, centred on the hole: the mask's soft edge shows while the hole is small (no hard rectangle).
  assert.match(portrait, /\.hero \.poster,\.hero \.film\{[^}]*max-width:none;aspect-ratio:16\/9;[^}]*translate:-50% 0\}/);
  assert.doesNotMatch(portrait, /--hole-w/, "portrait keeps the mask's side fade");
  assert.match(css, /\.hero\{[^}]*padding-block:0\}/, "the stage starts at the top, so the slogan's foot is on screen at load");
  assert.match(css, /\.hero \.film\{pointer-events:none\}/);
  assert.match(css, /\.hero \.film::-webkit-media-controls-start-playback-button\{display:none!important/, "no iOS play button when autoplay is blocked");
  assert.match(css, /@keyframes film-off\{to\{opacity:0;visibility:hidden\}\}/, "faded film is hidden, so phones can pause it");
  // One continuous fall (Josh, 19 Nov 2026): approach while rolling level, plunge into the shadow, out into the sky, the
  // ring contracts into the aurora. No fade to a second black hole.
  assert.match(css, /--dive:50% 39\.4%/, "the camera falls toward the shadow's darkest point");
  assert.match(css, /transform-origin:var\(--dive,var\(--hole\)\)/);
  assert.match(css, /@keyframes pull\{from\{transform:scale\(\.18\) rotate\(-9deg\);/, "the approach rolls level: orbiting in");
  assert.match(css, /\.hero \.poster,\.hero \.film\{animation:pull linear both,plunge linear both,film-off linear both;animation-timeline:--hero,--descent,--descent;\s*animation-range:contain 0% contain 100%,entry 20% entry 76%,entry 76% entry 92%;/);
  assert.match(css, /@keyframes plunge\{0%\{scale:1;rotate:0deg\}[^\n]*100%\{scale:10;rotate:12deg\}\}/, "deep enough that the shadow covers the screen (10x about --dive)");
  assert.match(css, /\.d-bh image\{display:none\}/, "no second black-hole picture");
  assert.match(css, /\.d-bh\{animation-name:d-emerge;animation-range:entry 82% contain 30%\}/);
  assert.match(css, /@keyframes d-emerge\{0%\{transform:scale\(3\.2\);opacity:0\}[^\n]*100%\{transform:translate\(0px,-37px\) scale\(\.1014,\.0304\);opacity:0\}\}/, "ends on the aurora halo, like d-shrink");
  // Fade layers, never the stage: an opacity on the stage cost 300-900 ms frames.
  assert.doesNotMatch(css, /\.hero-stage\{animation/, "the stage itself is never faded");
  assert.match(css, /\.hero-stage::after\{animation:film-off linear both;animation-timeline:--descent;animation-range:entry 76% entry 92%\}/);
  assert.match(css, /\.descent-art\{animation:d-in linear both;animation-timeline:--descent;animation-range:entry 60% entry 100%\}/, "without timeline-scope the art waits until entry 60%");
  assert.match(css, /\.descent-art\{animation-range:entry 80% entry 94%\}/, "with it, the art arrives as the dark opens");
  assert.doesNotMatch(css, /\.hero \.film\{animation-range:/, "one hand-off timing for all sizes");
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
  const want = ["/gauss/", "/constellation/", "/turnstone/", "mailto:hello@lightbound.uk", "/privacy/", "/terms/"]; // three projects only (Josh, 2026-10-22)
  for (const [route, page] of Object.entries(html)) if (page.includes('aria-label="Footer"')) assert.deepEqual(foot(page), want, route);
});

test("every page has one h1, the same main navigation and the same footer links", () => {
  const nav = (p) => [...(p.match(/<nav aria-label="Main">([\s\S]*?)<\/nav>/)?.[1] ?? "").matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  for (const [route, page] of Object.entries(html)) {
    assert.equal((page.match(/<h1[\s>]/g) || []).length, 1, `${route}: exactly one h1`);
    // Public pages end with Contact in the public release (no sign-in) and Sign in once accounts open; /argo/ opens only
    // with accounts, so it keeps Sign in.
    const last = route.startsWith("/app/") ? "/cdn-cgi/access/logout" : route === "/argo/" || RELEASE === "full" ? "/app/" : "mailto:hello@lightbound.uk";
    assert.deepEqual(nav(page), ["/gauss/", "/constellation/", "/turnstone/", last], `${route}: main nav ends with Contact, or sign in/out`);
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
  const door = html["/"].match(/<li><a href="\/turnstone\/">[\s\S]*?<\/li>/)[0];
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
      assert.match(url, /^https:\/\/lightbound\.space\//, `${route}: third-party resource ${url}`);
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

test("live-view gate: a labelled pre-rendered frame behind the Argo door, no script, nothing live", () => {
  const home = html["/"];
  const gate = home.match(/<section id="enter" class="live-gate"[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.ok(gate, "the gate follows the descent");
  assert.ok(home.indexOf('id="enter"') > home.indexOf("<!--/descent-->") && home.indexOf('id="enter"') < home.indexOf('id="contact"'));
  for (const f of ["gauss-live-wide.webp", "gauss-live-tall.webp"]) assert.ok(size(`/assets/media/${f}`) < 250_000, `${f} stays small`);
  assert.match(gate, /loading="lazy"/, "never competes with the hero for first paint");
  assert.match(gate, /a frame from the Gauss live view, not live data/, "a still is never passed off as live");
  // One door: the Argo sail on the button. This release ships the public landing alone (ported from #231, which adds
  // the sign-in route): the button plays the replay and the line under it says so. No <!--full--> block to strip.
  const sail = '<img class="sail" src="/assets/marks/argo-mark-colour-dark.svg" alt="" width="24" height="24" decoding="async">';
  assert.match(gate, new RegExp(`<a class="btn argo radiate" href="/gauss/#replay">${sail}Sign in with Argo</a>`));
  assert.match(gate, /<p class="src">Accounts aren&rsquo;t open yet: until they are, this button plays a replay of the live view\. /);
  assert.doesNotMatch(gate, /href="\/live"|<!--full-->|<!--public-->/, "nothing points at a sign-in route that is not deployed");
  assert.match(html["/gauss/"], /<section id="replay"/, "the replay the door opens on");
  const argoMark = read("assets/marks/argo-mark-colour-dark.svg");  // one sail like a sweeping wind, a wing (Josh, 6 Nov)
  assert.equal(argoMark.match(/<path d="M[^"]*C[^"]*Z" fill=/g).length, 1, "the Argo sail mark: one crescent sail");
  assert.equal(argoMark.match(/<polygon/g).length, 1, "the Argo sail mark: and the star");
  assert.match(read("assets/site.css"), /\.btn\.argo\{/, "the door has its own style");
  assert.match(gate, /<svg class="rad-field"[^>]*aria-hidden="true"/, "the radiation field is decoration, hidden from screen readers");
  assert.doesNotMatch(gate, /<script|<iframe|<canvas/);
  // Three movements (Josh, 5 Nov 2026): the landing is the slogan alone, the descent carries its own 01/05 captions,
  // then one door. One short, true line about Argo; no encryption claims, nothing Argo's own page says differently.
  assert.deepEqual([...home.matchAll(/class="k">(\d\d_[A-Z_]+)</g)].map((m) => m[1]), ["01_ENTER"], "one numbered kicker: the door");
  assert.match(home, />03_CONTACT</, "02 is Argo's Space tech, on Earth (Josh, 18 Nov 2026)");
  assert.match(text(gate), /Argo is Gauss&rsquo;s network agent, and the way in\. Included for operators and staff; never sold\./);
  assert.doesNotMatch(text(gate), /encrypt|quantum|HPKE|Ed25519|RFC ?9173|Nadia|Turnstone/i);
});

test("landing: you scroll into Gauss: the open view named, the rest veiled, one door; honest, script-free, still without motion", () => {
  // Josh, 18 Nov 2026: "as you scroll you could render the gauss actual to be able to see parts of before you login".
  const home = html["/"];
  const gate = home.match(/<section id="enter" class="live-gate"[\s\S]*?<\/section>/)?.[0] ?? "";
  const part = (cls) => gate.match(new RegExp(`<div class="${cls}">[\\s\\S]*?\\n  </div>`))?.[0] ?? "";
  const [open, held, card] = ["gate-open", "gate-held", "live-card"].map(part);
  assert.ok(open && held && card, "three parts");
  assert.ok(gate.indexOf("gate-open") < gate.indexOf("gate-held") && gate.indexOf("gate-held") < gate.indexOf("live-card"), "reading order: what is open, what is held back, the door");
  // The frame is a real capture of the live view, shown as an image with its size set; nothing is embedded or run.
  assert.match(gate, /<img src="\/assets\/media\/gauss-live-wide\.webp" alt="A frame from the Gauss live view: [^"]+" width="2000" height="1250" loading="lazy"/);
  assert.match(gate, /<source media="\(max-aspect-ratio: 1\/1\)" srcset="\/assets\/media\/gauss-live-tall\.webp" width="750" height="1300">/);
  assert.doesNotMatch(gate, /<script|<iframe|<canvas|<video|<object|<embed/);
  // Before sign-in: the live view's own readings, by name. A still has no numbers, and the page says so.
  assert.deepEqual([...open.matchAll(/<li>([^<]+)<\/li>/g)].map((m) => m[1]), ["Magnetopause", "Solar wind", "IMF Bz", "Kp"]);
  assert.match(open, /<p>The Gauss live view, traced from the solar wind\.<\/p>/);
  assert.match(open, /<p class="src">A still frame, so the numbers are left out\.<\/p>/);
  assert.doesNotMatch(text(open), /\d/, "no readings are shown from a still");
  // Past the sign-in: names only. No invented data behind the veils, no pictures, no links into closed areas.
  assert.deepEqual([...held.matchAll(/<li><span class="label">([^<]+)<\/span><span class="held">Members only<\/span><\/li>/g)].map((m) => m[1]), ["Field model", "Operator console", "Argo Mesh"]);
  assert.equal(held.match(/<li>/g).length, 3);
  assert.doesNotMatch(held, /\d|<img|<a /, "veiled panels carry a name and nothing else");
  // One door, and one or two quiet lines by it: what is withheld is withheld on purpose. No claims about how sign-in works.
  assert.equal(gate.match(/<a /g).length, 1, "one call to action");
  assert.match(card, /<p class="hush">The detail is withheld on purpose\. What lies past the sign-in is shown to members\.<\/p>/);
  for (const rx of [/polymorphic/i, /encrypt/i, /crypto/i, /quantum/i, /\bPQC?\b/, /unbreakable/i, /military/i, /compliant/i, /certified/i, /space[- ]qualified/i,
    /passkey|ratchet|ML-DSA|zero[- ]knowledge/i, /secure(ly)?\b/i, /stripe|card details/i, /Turnstone/i, /\bLIVE\b ·/])
    assert.doesNotMatch(text(gate), rx, `found ${rx}`);
  // Motion: scroll-driven CSS only, where supported and wanted, on screens tall enough to hold the door.
  const css = read("assets/site.css");
  const block = css.slice(css.indexOf("/* Live-view gate (landing)"), css.indexOf("/* Starfield (landing)"));
  assert.match(block, /\n\.gate-veils\{display:none\}/, "no veils unless the scroll can part them");
  const pinned = block.slice(block.indexOf("@supports (animation-timeline:view()){"), block.indexOf("@keyframes live-settle"));
  assert.match(pinned, /^@supports \(animation-timeline:view\(\)\)\{\n  @media \(prefers-reduced-motion:no-preference\) and \(min-height:660px\)\{\n    \.live-gate\{height:360svh;view-timeline:--gate block\}/);
  assert.equal(block.slice(0, block.indexOf("@supports")).match(/animation(-[a-z]+)?:/g), null, "nothing moves outside that block");
  assert.match(pinned, /\.gate-stage\{position:sticky;top:0;height:100svh/);
  assert.match(pinned, /\.live-card:focus-within\{opacity:1!important;transform:none!important;pointer-events:auto!important\}/, "a focused door is always visible");
  assert.match(pinned, /@media \(max-height:759px\)\{\.live-card \.rad-field\{display:none\}\}/, "small phones: the door fits the pinned screen");
  for (const k of ["gv-l", "gv-r", "g-in", "g-out", "g-step", "g-door", "live-settle"]) {
    const kf = block.match(new RegExp(`@keyframes ${k}\\{[^\\n]*\\}`))[0];
    assert.doesNotMatch(kf.replace(/transform|opacity|pointer-events/g, ""), /[a-z-]+:/, `${k} animates transform and opacity only`);
    assert.doesNotMatch(kf, /visibility/, `${k}: never hidden from the keyboard or a screen reader`);
  }
  // Veils and plates: surfaces and hairlines, no glow, no blur over what is withheld, no lime.
  const plates = block.replace(/\n\.live-card\{[^\n]*/, "");
  assert.doesNotMatch(plates, /box-shadow|text-shadow|blur\(|filter:|--lime|CCFF00/i);
  assert.match(html["/"].match(/<div class="gate-veils"[^>]*>/)[0], /aria-hidden="true"/, "the planes are decoration");
});

test("landing: Space tech, on Earth: what Argo does today, honest, no door into the closed /argo/", () => {
  // Josh, 18 Nov 2026: a short Argo teaser on the public landing; /argo/ stays closed; framing "Space tech, on Earth".
  const home = html["/"];
  const sec = home.match(/<section id="argo" class="on-earth starfield"[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.ok(sec, "the section is there");
  assert.ok(home.indexOf('id="enter"') < home.indexOf('id="argo"') && home.indexOf('id="argo"') < home.indexOf('id="projects"'), "after the door, before the marks");
  assert.match(sec, /<p class="label">02_ON_EARTH<\/p>/);
  assert.match(sec, /<h2 id="argo-h">Space tech, on Earth\.<\/h2>/);
  assert.equal(sec.match(/<li>/g).length, 3, "three habits, no more");
  // Show, don't tell: each habit draws itself (decorative SVG, scroll-driven CSS, no script, no lime).
  const figs = sec.match(/<svg class="habit-fig" viewBox="0 0 240 72" aria-hidden="true" focusable="false">[\s\S]*?<\/svg>/g) ?? [];
  assert.equal(figs.length, 3, "one drawing per habit");
  for (const f of figs) assert.doesNotMatch(f, /<script|<animate|<text|href=|lime/i, "shapes only, animated from site.css");
  assert.match(read("assets/site.css"), /@media \(prefers-reduced-motion:no-preference\)\{\n    \.habit-fig \*\{animation:linear both;animation-timeline:--habit;/, "reduced motion: the last frame, still");
  // Each line is something /argo/ already states as working today.
  for (const want of [/one broken network from another/, /smallest fix/, /signed receipt/, /Bundle Protocol \(RFC&nbsp;9171\)/, /Certificate checks are never turned off/,
    /Mac today, Linux in a container\. Included with Gauss for operators and staff; never sold\./])
    assert.match(sec, want);
  for (const rx of [/space[- ]grade/i, /space[- ]qualified/i, /mission[- ]grade/i, /military/i, /certified/i, /compliant/i, /quantum/i, /\bVPN\b/, /\bAI\b/, /encrypt/i, /relay/i, /£|\$\d|a month/i, /everyone|anyone/i])
    assert.doesNotMatch(text(sec), rx, `found ${rx}`);
  assert.doesNotMatch(sec, /href="\/argo\//, "no link into /argo/, which the public release closes");
  assert.doesNotMatch(sec, /class="k"|var\(--lime\)/, "the door keeps the one lime kicker");
  const css = read("assets/site.css");
  assert.match(css, /\.earth-list li\{animation:rise linear both;animation-timeline:view\(\)/);
  assert.match(css, /@media \(prefers-reduced-motion:no-preference\)\{\n    \.earth-list li\{animation:rise/, "reduced motion: it is simply there");
});

test("scroll effects stay smooth on weak devices: the scroll drives opacity and transforms only, never a repaint or a live blur", () => {
  const css = read("assets/site.css");
  // Every keyframes block that a scroll timeline drives on the landing animates compositor-friendly properties only.
  for (const k of ["solidify", "far-drift", "pull", "rush", "recede", "plunge", "stream", "c-far", "c-nebula", "c-fields", "d-in", "d-out", "live-settle", "hf-a", "hf-fault", "hf-p1", "hf-p2", "hf-carry", "hf-gap", "hf-hold", "hf-ok", "hf-pass", "hf-stop", "hf-block"]) {
    const kf = css.match(new RegExp(`@keyframes ${k}\\{[^\\n]*\\}`))?.[0];
    assert.ok(kf, `@keyframes ${k} exists`);
    assert.doesNotMatch(kf.replace(/\b(transform|opacity|scale|rotate|translate|visibility)\b/g, ""), /[a-z-]+:/, `${k} animates compositor properties only`);
  }
  // The header fades a ground layer in; it never animates its own background or blur.
  assert.match(css, /\.top\.over::before\{[^}]*opacity:0;animation:solidify linear both;animation-timeline:scroll\(root\)/);
  assert.match(css, /@keyframes solidify\{to\{opacity:1\}\}/);
  assert.match(css, /\.top\.over\{position:fixed;animation:frost step-end both;/, "the blur switches on once, it is never interpolated");
  // Section stars drift by transform, inside a clip, so they never spill into the section above.
  assert.match(css, /\.starfield\{position:relative;isolation:isolate;overflow:clip\}/);
  assert.match(css, /@keyframes far-drift\{to\{transform:translateY\(520px\)\}\}/);
  // Touch screens: no live blur over the moving frame behind the sign-in card, even after a tap (sticky hover).
  const touch = css.match(/@media \(pointer:coarse\)\{\.live-card,\.live-card:hover,\.live-card:focus-within\{[^}]*\}\}/)?.[0] ?? "";
  assert.match(touch, /backdrop-filter:none/);
  assert.ok(css.indexOf(touch) > css.indexOf(".live-card:hover,.live-card:focus-within{--smoke"), "comes after the hover blur, so it wins");
});

test("landing backdrop: stars, then nebula, then fields, one fixed sky; decorative, compositor-only, calm with reduced motion", () => {
  const home = html["/"];
  assert.equal(home.match(/class="cosmos"/g).length, 1);
  assert.match(home, /<div class="cosmos" aria-hidden="true"><i class="c-far"><\/i><i class="c-nebula"><\/i><i class="c-fields"><\/i><\/div>/);
  const css = read("assets/site.css");
  const block = css.slice(css.indexOf(".cosmos{"), css.indexOf("@keyframes c-fields"));
  assert.match(block, /^\.cosmos\{position:fixed;inset:0;z-index:-1;pointer-events:none/, "behind everything, never takes a tap");
  assert.doesNotMatch(block, /--lime|CCFF00|blur\(|box-shadow|filter:/i, "no lime, no glow, no blur filters");
  // Order on the scroll: nebula gathers past the black hole, fields rise in at the foot.
  assert.match(block, /\.c-nebula\{animation:c-nebula linear both;animation-timeline:scroll\(root\);animation-range:4% 36%\}/);
  assert.match(block, /\.c-fields\{animation:c-fields linear both;animation-timeline:scroll\(root\);animation-range:62% 92%\}/);
  assert.match(block, /@media \(prefers-reduced-motion:no-preference\)\{\n    \.cosmos i\{will-change:transform,opacity\}/, "motion only when asked for");
  assert.match(block, /\.c-fields\{opacity:0;/, "reduced motion or no scroll timelines: no fields, stars and a faint nebula only");
  for (const k of ["c-far", "c-nebula", "c-fields"]) {
    const kf = css.match(new RegExp(`@keyframes ${k}\\{[^\\n]*\\}`))[0];
    assert.doesNotMatch(kf.replace(/transform|opacity/g, ""), /[a-z-]+:/, `${k} animates transform and opacity only`);
  }
  // One sky across the site: every other page draws the same far stars, fixed and decorative.
  assert.match(css, /\.c-far,body\.page::before\{background-size:233px 233px,233px 233px,233px 233px,377px 377px,377px 377px,377px 377px;background-image:var\(--far-stars\)\}/);
  assert.match(css, /body\.page::before\{content:"";position:fixed;inset:-12%;z-index:-1;pointer-events:none;opacity:\.45\}/);
  for (const route of ["/gauss/", "/constellation/", "/turnstone/", "/education/", "/privacy/"]) assert.match(html[route], /<body class="page[ "]/, `${route} gets the sky`);
  const fields = read("assets/media/fields.svg");
  assert.ok(fields.length < 4096, "fields art stays tiny");
  assert.match(fields, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 1000 1000"/);
  assert.doesNotMatch(fields, /<script|<image|href=/, "lines only");
});

test("touch: no endless hover animation after a tap, 44 px header targets, readable descent tags, safe areas", () => {
  const css = read("assets/site.css");
  for (const sel of ["\n  .door:hover,.door:focus-visible,.tile:hover,.tile:focus-within,.friend:hover,.btn.ghost:hover", ".btn.radiate:hover::before", ".btn.argo.radiate:hover{"]) {
    const at = css.indexOf(sel);
    assert.ok(at > 0, sel);
    assert.match(css.slice(css.lastIndexOf("@media", at), at), /^@media \(prefers-reduced-motion:no-preference\) and \(hover:hover\)\{/, `${sel} runs only where a pointer can hover`);
  }
  assert.match(css, /@media \(pointer:coarse\)\{\n  \.top nav a\{padding-block:11px\}/);
  assert.match(css, /@media \(max-width:560px\)\{\.d-tags text\{font-size:12px;[^}]*paint-order:stroke;stroke:var\(--black\)/);
  assert.match(html["/"], /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/);
  assert.match(css, /\.wrap\{padding-left:max\(clamp\(16px,4vw,40px\),env\(safe-area-inset-left,0px\)\)/);
});

test("live sections have their markers, with a working static fallback", () => {
  const has = (route, m) => assert.match(html[route], new RegExp(`<!--live:${m}-->[\\s\\S]*?<!--/live:${m}-->`), `${route} ${m}`);
  assert.doesNotMatch(html["/"], /<!--live:/, "the landing page has no live sections: its readouts moved to the product pages");
  for (const m of ["launches", "weather", "gauss-door"]) has("/constellation/", m);
  has("/gauss/", "constellation-door");
});

// ---- Flow ----
test("flow: no dead ends; each product page ends with the other doors, Turnstone leads home", () => {
  const doors = (p) => [...p.matchAll(/<a class="door" href="([^"]+)"/g)].map((m) => m[1]);
  // The landing page's doors became one quiet row of marks (Josh, 5 Nov 2026: nothing repeating; the header carries the names).
  assert.equal(html["/"].match(/<ul class="marks">/g).length, 1);
  assert.deepEqual([...html["/"].match(/<ul class="marks">[\s\S]*?<\/ul>/)[0].matchAll(/<a href="([^"]+)">/g)].map((m) => m[1]), ["/gauss/", "/constellation/", "/turnstone/"], "three projects");
  assert.doesNotMatch(html["/"], /class="door"|Enter Gauss|Visit Constellation|Restricted/, "no door cards on the landing page");
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

test("tap targets: every <details> summary, in pages or Worker markup, is at least 24 px high (WCAG 2.5.8)", () => {
  const worker = join(pub, "..", "worker");
  const sources = [...walk(pub).filter((f) => f.endsWith(".html")), ...readdirSync(worker).filter((f) => f.endsWith(".js")).map((f) => join(worker, f))]
    .map((f) => readFileSync(f, "utf8")).join("\n");
  assert.doesNotMatch(sources, /<details(?![^>]*\bclass=")/, "every <details> has a class its summary rule can target");
  const classes = new Set([...sources.matchAll(/<details class="([a-z-]+)"/g)].map((m) => m[1]));
  assert.ok(classes.has("evid") && classes.has("interests"), `found ${[...classes]}`);
  const css = read("assets/site.css");
  for (const c of classes) {
    const rule = css.match(new RegExp(`\\.${c} summary\\{([^}]*)\\}`));
    assert.ok(rule, `.${c} summary has a rule`);
    const h = rule[1].match(/min-height:(\d+)px/);
    assert.ok(h && Number(h[1]) >= 24, `.${c} summary min-height ≥ 24px`);
  }
});

test("phones: wide tables scroll inside their box; hidden labels can't widen the page", () => {
  // .sr is position:absolute; unless the scroll box is its containing block it escapes the clip (planner was 874 px at 375).
  const css = read("assets/site.css");
  assert.match(css, /\.sr\{position:absolute/);
  assert.match(css, /\.tw\{overflow-x:auto;position:relative\}/);
  // Unsocial hours in the planner grid differ by more than colour (WCAG 1.4.1): a dotted underline, named in the legend.
  assert.match(css, /\.planner td\.quiet\{[^}]*text-decoration:underline dotted/);
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
  const expected = { pilot: "$25k–$50k per pilot", fleet_integration: "$80k–$160k a year", mission_integration: "$150k–$400k one-off", flight_candidate_adapter: "$1m–$3.3m one-off" };
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
  // The landing's first screen is the slogan alone (Josh, 5 Nov 2026); the wedge is the descent's last caption and the Gauss page's hero.
  assert.equal(text(html["/"].match(/<section class="hero"[\s\S]*?<\/section>/)[0]).trim(), "Carry hope, go beyond.", "the first screen is the slogan alone");
  assert.match(text(html["/"]), /Satellites fly through all of it\. Gauss tells their teams which data to trust\./, "the wedge, once, where the descent ends");
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
  assert.match(html["/argo/"], /src="\/assets\/marks\/argo-mark-colour-dark\.svg"/, "the Argo sail mark, not the provisional glyph");
  assert.match(read("assets/marks/argo-icon-colour-dark.svg"), /<rect width="64" height="64" rx="14" fill="#050505"\/>/, "favicon: the sail on a black tile");
  assert.match(read("assets/marks/argo-glyph-provisional.svg"), /provisional glyph, not yet in the Brand Book/, "kept while the Access login page (PR #231) still names it");
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
  assert.match(text(html["/constellation/"]), /Free, by invitation\./);
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

// ---- The public release (GAU-178) ----
test("public release: the config holds only what the public pages need, and keeps the closed routes on the Worker", { skip: RELEASE !== "public" && "config is full" }, () => {
  const [raw, config] = [WRANGLER_RAW, WRANGLER];
  assert.equal(config.vars.RELEASE, "public");
  assert.deepEqual(config.kv_namespaces.map((k) => k.binding), ["LIVE"], "no DATA namespace until accounts open");
  assert.doesNotMatch(raw.replace(/^\s*\/\/.*$/gm, ""), /ACCESS_|ADMIN_EMAILS|STAFF_EMAILS|SUPPORT_URL|"DATA"/, "no placeholder sign-in or payment settings");
  assert.equal(raw.match(/REPLACE_[A-Z_]+/g), null, "no placeholders left to deploy");
  assert.match(config.kv_namespaces[0].id, /^[0-9a-f]{32}$/, "the LIVE namespace id");
  for (const route of ["/app", "/app/*", "/argo/", "/api/*"]) assert.ok(config.assets.run_worker_first.includes(route), `${route} must reach the Worker, or its static file would be served`);
  // Josh, 2026-11-05: the main site is lightbound.space. The route stays commented until the apex and www A records
  // (DNS-only, tailnet address) are deleted: with them in place Cloudflare refuses the custom domain (code 100117) and
  // a partial trigger update switches the workers.dev preview off (error 1042) until a redeploy without the route.
  assert.deepEqual(config.routes, [{ pattern: "lightbound.space", custom_domain: true }], "lightbound.space is the main site (Josh deleted the apex record, 2026-11-05)");
});

test("public release: public pages link to sign-in only inside <!--full--> blocks, which the Worker removes", () => {
  for (const [route, page] of Object.entries(html)) {
    if (route.startsWith("/app/") || route === "/argo/") continue;
    const open = page.replace(/<!--full-->[\s\S]*?<!--\/full-->/g, "");
    if (RELEASE === "public") assert.doesNotMatch(open, /href="\/app\/|href="\/argo\//, `${route}: links into a closed area`);
    if (open !== page) assert.ok(WORKER_ROUTES.includes(route), `${route}: <!--full--> needs the Worker to remove it`);
  }
});

// ---- Brand Book (15-18 Oct 2026): Turnstone v6, Constellation navy and gold, shared status colours ----
const symbol = (f) => readFileSync(join(pub, "..", "tools", "symbols", f), "utf8");
test("brand: all four marks are the refined Design System symbols, unchanged, with no blur filters", () => {
  assert.equal(read("assets/marks/lightbound-mark-colour-dark.svg"), symbol("lightbound-symbol-colour-dark.svg"));
  assert.equal(read("assets/marks/gauss-aurora-mark-colour-dark.svg"), symbol("gauss-aurora-symbol-colour-dark.svg"));
  for (const f of readdirSync(join(pub, "assets", "marks"))) assert.doesNotMatch(read(`assets/marks/${f}`), /<filter|feGaussianBlur/, `${f}: flat marks only`);
  assert.match(read("assets/marks/gauss-aurora-horizontal-colour-dark-v2.svg"), /aria-label="Gauss Aurora"/);
  assert.match(read("assets/marks/lightbound-horizontal-colour-dark.svg"), /aria-label="Lightbound"/);
  assert.equal(read("assets/marks/turnstone-mark-colour-dark-v3.svg"), symbol("turnstone-symbol-colour-dark.svg"));
  assert.equal(read("assets/marks/turnstone-badge-colour-dark-v3.svg"), symbol("turnstone-badge-symbol-colour-dark.svg"));
  assert.equal(read("assets/marks/constellation-mark-colour-dark-v2.svg"), symbol("constellation-symbol-colour-dark.svg"));
  assert.equal(read("assets/marks/constellation-icon-colour-dark-v2.svg"), symbol("constellation-icon-symbol-colour-dark.svg"));
  const ts = read("assets/marks/turnstone-mark-colour-dark-v3.svg");
  assert.ok(ts.includes("#318ada") && ts.includes("#f0782a"), "earth-blue feathers and tide, signal-orange legs");
  const cn = read("assets/marks/constellation-mark-colour-dark-v2.svg");
  assert.ok(cn.includes("#081c4d") && cn.includes("#b0906f"), "navy disc, gold ring and nodes");
  for (const f of readdirSync(join(pub, "assets", "marks")).filter((n) => /^(turnstone|constellation)-/.test(n)))
    assert.doesNotMatch(read(`assets/marks/${f}`), /<filter|<script/, f);
  assert.match(read("assets/marks/constellation-horizontal-colour-dark-v3.svg"), /aria-label="Constellation, space community group"/);
});

test("brand: Constellation pages are navy and gold, carry the motto and values, and no Lightbound endorsement", () => {
  for (const route of ["/constellation/", "/constellation/apply/"]) {
    assert.match(html[route], /<body class="page brand-constellation">/, route);
    assert.match(html[route], /<link rel="icon" href="\/assets\/marks\/constellation-icon-colour-dark-v2\.svg"/, route);
    // The legal line ("operated by Lightbound Limited") stays; no endorsement badge or "from Lightbound" framing.
    assert.doesNotMatch(text(html[route]), /a Lightbound company|from Lightbound(?!\.(?:uk|space))|by Lightbound(?! Limited)/i, `${route}: no company badge`);
  }
  assert.match(text(html["/constellation/"]), /Per aspera ad astra: through adversity we go beyond\./);
  for (const v of ["Intentionality", "Radical integrity", "Accountability", "The Golden Rule"]) assert.ok(text(html["/constellation/"]).includes(v), v);
  const css = read("assets/site.css");
  assert.match(css, /\.brand-constellation\{--accent:#B0906F;--accent2:#B0906F;--panel:#081C4D;--char:#1C3470;/);
});

test("brand: Turnstone page shows the v6 mark, wordmark and tagline, and still nothing about what it does", () => {
  const page = html["/turnstone/"];
  assert.match(page, /<body class="page brand-turnstone">/);
  assert.match(page, /<link rel="icon" href="\/assets\/marks\/turnstone-badge-colour-dark-v3\.svg"/);
  assert.match(text(page), /TURNSTONE A Lightbound company/);
  assert.match(text(page), /TURNING TIDES/);
  assert.match(read("assets/site.css"), /\.brand-turnstone\{--accent:#F0782A;--accent2:#318ADA;/);
});

test("brand: shared status colours and no shadows outside marks and photos", () => {
  const css = read("assets/site.css");
  assert.match(css, /--live:#4E972F;--sim:#318ADA;--danger:#D4673B;/);
  assert.match(css, /\.chip\.live\{color:var\(--live\)\}/, "LIVE is the status green, always with its word");
  assert.match(gauss, /<span class="chip sim">Synthetic · screening evidence<\/span>/, "synthetic = SIMULATED blue");
  // Brand Book amendment (Josh, 4 Nov 2026): "accretion light". Glows only in the black hole's own disk colours, only on
  // hover and focus (the live-view card is the one glow at rest); never text shadows or drop shadows.
  assert.doesNotMatch(css, /text-shadow|drop-shadow/, "no text or drop shadows");
  assert.match(css, /--hot:255 222 170;--ember:240 120 42;--mauve:203 182 214;--violet:142 108 196;/, "the disk tokens");
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*box-shadow:[^{}]*)\}/g)) {
    const value = body.match(/box-shadow:([^;}]*)/)[1];
    if (/^inset 0 -1px/.test(value)) continue;
    assert.match(value, /var\(--disk-glow\)|rgb\(var\(--(hot|ember|mauve|violet)\)/, `${selector.trim()}: glows use the disk colours`);
    assert.match(selector, /:hover|:focus|^\s*\.live-card\s*$/, `${selector.trim()}: glows on hover or focus only`);
  }
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
  assert.match(text(gauss), /elevated space-weather conditions \(proton and geomagnetic levels\)/); // no electron level in the trust record on main
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
  assert.match(sec, /href="mailto:hello@lightbound\.uk\?subject=Assured%20Connectivity%20pilot"/);
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
  assert.match(read("robots.txt"), /^Disallow: \/app\/$[\s\S]*^Sitemap: https:\/\/lightbound\.space\/sitemap\.xml$/m);
  const ld = JSON.parse(html["/"].match(/<script type="application\/ld\+json">([^<]*)<\/script>/)[1]);
  assert.equal(ld["@graph"][0].name, "Lightbound Limited");
  assert.deepEqual(ld["@graph"][0].sameAs, ["https://luma.com/constellation"]);
  for (const [route, page] of Object.entries(html)) if (route !== "/") assert.doesNotMatch(page, /<script/, `${route}: no data blocks elsewhere`);
});

test("wiring: /gauss/ says what a log needs, links a made-up sample that has the columns it names, and the form asks what runs the model", () => {
  const page = html["/gauss/"];
  assert.match(page, /<summary>What a log needs<\/summary>/);
  assert.match(page, /href="\/gauss\/sample-inference-log\.csv" download/);
  assert.match(text(page), /never guess a time zone/i, "the zone rule is stated");
  assert.match(text(page), /nothing is dropped silently/i);
  const csv = read("gauss/sample-inference-log.csv");
  const [header, ...rows] = csv.trim().split("\n");
  assert.equal(header, "inference_time,sat,model,label,score,lat,lon,alt_km");
  assert.equal(rows.length, 7);
  assert.ok(rows.every((r) => r.split(",").length === header.split(",").length), "every row has every column");
  assert.ok(rows.every((r) => /DEMO-SAT-\d/.test(r)), "made-up spacecraft only, no real mission names");
  assert.doesNotMatch(csv, /@/, "no contact details in a download");
  assert.match(renderApplyForm("gauss"), /name="logSource"/);
  assert.match(renderApplyForm("gauss"), /name="logFormat"/);
  assert.doesNotMatch(text(page), /\b(compliant|certified|space-qualified|post-quantum)\b/i);
});

test("client links: /gauss/, /gauss/evidence/ and /argo/ each link to the pilot brief with a plan", () => {
  for (const path of ["/gauss/", "/gauss/evidence/", "/argo/"]) assert.match(html[path], /href="\/gauss\/apply\/\?plan=pilot"/, path);
});

// ---- Switching releases (tools/release.mjs; the flip-day runbook) ----
test("release switch: every page header agrees with RELEASE in wrangler.jsonc", () => {
  assert.equal(configRelease(WRANGLER_RAW), RELEASE);
  const pill = RELEASE === "full" ? SIGN_IN_PILL : CONTACT_PILL;
  const pages = headerPages(pub);
  assert.ok(pages.length >= 14, "every public page, the 404 included");
  for (const f of pages) assert.ok(readFileSync(f, "utf8").includes(pill), `${f}: header says ${RELEASE === "full" ? "Sign in" : "Contact"}`);
});

test("release switch: full adds DATA, sign-in and workspace vars and Sign in; public takes them all away again", () => {
  const o = { data: "0123456789abcdef0123456789abcdef", team: "example.cloudflareaccess.com", aud: "ab".repeat(32), app: "https://gauss.example.test/" };
  assert.deepEqual(validate(o), []);
  const base = configFor(WRANGLER_RAW, "public"); // whatever the repo holds, from public
  const fullRaw = configFor(base, "full", o);
  const full = JSON.parse(fullRaw.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));
  assert.equal(full.vars.RELEASE, "full");
  assert.deepEqual(full.kv_namespaces.map((k) => [k.binding, k.id]), [["LIVE", WRANGLER.kv_namespaces[0].id], ["DATA", o.data]]);
  assert.deepEqual([full.vars.ACCESS_TEAM_DOMAIN, full.vars.ACCESS_AUD, full.vars.ADMIN_EMAILS, full.vars.GAUSS_APP_URL, full.vars.USER_CAP],
    [o.team, o.aud, CONTACT, o.app, "50"]);
  assert.doesNotMatch(fullRaw, /"STRIPE_|"ACCESS_JWKS"|"STAFF_EMAILS"/, "secrets stay Worker secrets");
  assert.deepEqual(full.assets, WRANGLER.assets, "the Worker still sees /app, /argo/ and /api first");
  assert.equal(configFor(fullRaw, "full", o), fullRaw, "running it twice changes nothing");
  assert.equal(configFor(fullRaw, "public"), base, "public restores the public config exactly");
  for (const f of headerPages(pub)) {
    const page = readFileSync(f, "utf8");
    const on = headerFor(page, "full");
    assert.ok(on.includes(SIGN_IN_PILL) && !on.includes(CONTACT_PILL), `${f}: Sign in when full`);
    assert.equal(headerFor(on, "public"), headerFor(page, "public"), `${f}: and back`);
  }
  // Refuses what would break sign-in or leak: wrong shapes, non-https links, anything but a Stripe Payment Link.
  assert.equal(validate({}).length, 3, "DATA, team domain and AUD are required");
  assert.ok(validate({ ...o, team: "evil.example" }).length);
  assert.ok(validate({ ...o, app: "http://gauss.example.test/" }).length);
  assert.ok(validate({ ...o, app: "javascript:alert(1)" }).length);
  assert.ok(validate({ ...o, support: "https://evil.example/pay" }).length);
  assert.ok(validate({ ...o, cap: "0" }).length);
});

test("release switch: a link the switch accepts is one the Worker shows, with no credentials, query or fragment in the config", () => {
  const o = { data: "0123456789abcdef0123456789abcdef", team: "example.cloudflareaccess.com", aud: "ab".repeat(32) };
  const base = configFor(WRANGLER_RAW, "public");
  for (const url of ["https://gauss.example.test/", "https://console.example.test:8443/app/"]) {
    assert.deepEqual(validate({ ...o, app: url, ops: url }), [], url);
    assert.equal(consoleLink(url), url, "the workspace shows the console button for it");
    assert.ok(staffCard(url).includes(`href="${url}"`), "and the staff card");
  }
  // Refused: what the workspace would hide (a paid account would see "coming by email"), and what must not be committed.
  for (const url of ["https://gauss.example.test/?token=abc", "https://gauss.example.test/#x", "https://user:pw@gauss.example.test/",
    "https://gauss.example.test", "https://gauss.example.test/$&", "https://gauss.example.test/a\\b", "https://gauss.example.test/%22", "https://-x.example.test/", ""]) {
    assert.equal(validate({ ...o, app: url }).length, 1, `--app ${url}`);
    assert.equal(validate({ ...o, ops: url }).length, 1, `--ops ${url}`);
  }
  for (const url of ["https://buy.stripe.com/test_a-b123", "https://donate.stripe.com/abcdef12"]) {
    assert.deepEqual(validate({ ...o, support: url }), [], url);
    assert.equal(supportLink(url), url, "the Worker shows the support link");
  }
  for (const url of ["https://buy.stripe.com/abc", "https://buy.stripe.com/abcdef12?x=1", "https://buy.stripe.com.evil.example/abcdef12", ""]) {
    assert.equal(validate({ ...o, support: url }).length, 1, `--support ${url}`);
    assert.equal(supportLink(url), "", "and the Worker would hide it");
  }
  // No value is read as a replacement pattern, so the config stays valid and public still undoes it exactly.
  const odd = configFor(base, "full", { ...o, app: "https://gauss.example.test/$&$1" });
  assert.match(odd, /"GAUSS_APP_URL": "https:\/\/gauss\.example\.test\/\$&\$1",\n/);
  assert.equal(configFor(odd, "public"), base);
});

test("release switch: if accounts aren't really open (RELEASE full without DATA), Worker pages say Contact, not a dead Sign in", () => {
  const page = `<nav aria-label="Main"><a href="/gauss/">Gauss</a>${SIGN_IN_PILL}</nav>`;
  assert.equal(forRelease(page, { RELEASE: "full" }), page.replace(SIGN_IN_PILL, CONTACT_PILL), "no DATA: Contact");
  assert.equal(forRelease(page, { RELEASE: "public", DATA: {} }), page.replace(SIGN_IN_PILL, CONTACT_PILL));
  assert.equal(forRelease(page, { RELEASE: "full", DATA: {} }), page, "really open: Sign in stays");
});
