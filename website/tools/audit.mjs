// UI audit harness for lightbound.uk: starts the offline preview (synthetic data, emulated sign-in and Stripe) unless
// BASE is given, opens every page at 375 and 1280 px, and fails on any finding:
//   WCAG AA text contrast, tap targets of at least 24 px, no sideways overflow, one h1 and no skipped heading levels,
//   labelled form controls, alt on images, unique ids, and no console errors.
// usage: npm run audit:website [-- name,name...]       (BASE=https://... to audit a deployed site; OUT=dir for screenshots)
//        RELEASE=public npm run audit:website         (the public release: /argo/ and /app/ must answer 404, no sign-in)
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../../package.json", import.meta.url)); // Playwright comes with the app's dev dependencies
const { chromium } = require("@playwright/test");
const OUT = process.env.OUT || join(tmpdir(), "lightbound-audit");
mkdirSync(OUT, { recursive: true });

// [name, path, signed in as, expected status] — the dev seeds in dev.mjs give each workspace state an account.
const PAGES = [
  ["home", "/"], ["gauss", "/gauss/"], ["evidence", "/gauss/evidence/"], ["gauss-apply", "/gauss/apply/"],
  ["constellation", "/constellation/"], ["const-apply", "/constellation/apply/"], ["workshops", "/constellation/workshops/"],
  ["planner", "/constellation/time/?z=Europe/London&z=Asia/Kuala_Lumpur&z=America/New_York&date=2026-10-23&at=9"],
  ["turnstone", "/turnstone/"], ["argo", "/argo/"], ["education", "/education/"], ["education-apply", "/education/apply/"],
  ["privacy", "/privacy/"], ["terms", "/terms/"], ["404", "/nope", null, 404],
  ["app-due", "/app/", "pilot@example.test"], ["app-operator", "/app/", "fleet@example.test"], ["app-member", "/app/", "member@example.test"],
  ["app-staff", "/app/", "staff@example.test"], ["app-none", "/app/", "visitor@example.test"], ["app-edu", "/app/?edu=start", "audit@example.ac.uk"],
  ["admin", "/app/admin/", "jzwnathan@lightbound.uk"],
];
// The public release (worker/release.js) has no sign-in to emulate, and its closed pages are checked as 404s.
const PUBLIC = process.env.RELEASE === "public";
const pages = PUBLIC
  ? [...PAGES.filter(([, , who]) => !who).map(([n, p, w, s]) => (n === "argo" ? [n, p, w, 404] : [n, p, w, s])), ["app-closed", "/app/", null, 404]]
  : PAGES;
const only = process.argv[2] ? process.argv[2].split(",") : null;

async function startPreview() {
  const port = 8790 + Math.floor(Math.random() * 100);
  const dev = spawn(process.execPath, [fileURLToPath(new URL("../dev.mjs", import.meta.url)), "--port", String(port), "--offline"], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("preview did not start in 20 s")), 20_000);
    dev.stdout.on("data", (d) => String(d).includes("preview on") && (clearTimeout(timer), resolve()));
    dev.on("exit", (code) => reject(new Error(`preview exited (${code})`)));
  });
  return { base: `http://127.0.0.1:${port}`, stop: () => dev.kill() };
}

function audit() {
  const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const parse = (s) => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { c: p.slice(0, 3), a: p[3] ?? 1 }; };
  const bgOf = (el) => { let c = [5, 5, 5]; const chain = []; for (let e = el; e; e = e.parentElement) chain.push(e); for (const e of chain.reverse()) { const p = parse(getComputedStyle(e).backgroundColor); if (p && p.a > 0) c = c.map((v, i) => v * (1 - p.a) + p.c[i] * p.a); } return c; };
  const issues = { contrast: [], targets: [], overflow: [], headings: [], labels: [], alt: [], ids: [] };
  for (const el of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || +cs.opacity === 0) continue;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own || el.closest(".hero, .sr, [aria-hidden=true], svg")) continue;
    const fg = parse(cs.color); if (!fg) continue;
    const bg = bgOf(el); const f = fg.c.map((v, i) => v * fg.a + bg[i] * (1 - fg.a));
    const L1 = lum(f), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const size = parseFloat(cs.fontSize), bold = +cs.fontWeight >= 700;
    if (ratio < (size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5) && !el.closest('[aria-disabled="true"]'))
      issues.contrast.push(`${el.tagName.toLowerCase()}.${el.className}: ${ratio.toFixed(2)} "${el.textContent.trim().slice(0, 30)}"`);
  }
  for (const a of document.querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea, summary")) {
    const b = a.getBoundingClientRect(); const cs = getComputedStyle(a);
    if (!b.width || cs.visibility === "hidden" || a.closest(".hp, .sr")) continue;
    const inline = cs.display === "inline" && a.closest("p, li, dd, td, span.why");
    if (!inline && (b.height < 24 || b.width < 24)) issues.targets.push(`${a.tagName.toLowerCase()} "${(a.textContent || a.name || "").trim().slice(0, 24)}" ${Math.round(b.width)}x${Math.round(b.height)}`);
  }
  if (document.documentElement.scrollWidth > innerWidth + 1) issues.overflow.push(`${document.documentElement.scrollWidth} > ${innerWidth}`);
  const hs = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter((e) => getComputedStyle(e).display !== "none").map((e) => +e.tagName[1]);
  if (hs.filter((x) => x === 1).length !== 1) issues.headings.push(`h1 x${hs.filter((x) => x === 1).length}`);
  hs.forEach((x, i) => { if (i && x > hs[i - 1] + 1) issues.headings.push(`h${hs[i - 1]} -> h${x}`); });
  for (const c of document.querySelectorAll("input:not([type=hidden]), select, textarea")) {
    if (c.closest(".hp")) continue;
    if (!((c.id && document.querySelector(`label[for="${c.id}"]`)) || c.closest("label") || c.getAttribute("aria-label"))) issues.labels.push(c.name || c.id);
  }
  for (const img of document.querySelectorAll("img")) if (!img.hasAttribute("alt")) issues.alt.push(img.getAttribute("src"));
  const seen = new Set();
  for (const e of document.querySelectorAll("[id]")) { if (seen.has(e.id)) issues.ids.push(e.id); seen.add(e.id); }
  return issues;
}

const preview = process.env.BASE ? { base: process.env.BASE, stop() {} } : await startPreview();
const browser = await chromium.launch({ channel: "chromium" });
let bad = 0;
try {
  for (const [w, h] of [[375, 812], [1280, 800]]) {
    for (const [name, path, who, status = 200] of pages) {
      if (only && !only.includes(name)) continue;
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, reducedMotion: "reduce" });
      if (who && !process.env.BASE) await ctx.addCookies([{ name: "dev_access", value: encodeURIComponent(who), url: preview.base }]);
      else if (who) { await ctx.close(); continue; } // signed-in pages need the local stand-in
      const page = await ctx.newPage();
      const errors = [];
      page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 160)));
      page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
      const res = await page.goto(preview.base + path, { waitUntil: "networkidle" });
      if (res.status() !== status) errors.push(`HTTP ${res.status()}, expected ${status}`);
      else if (status !== 200) errors.splice(0, errors.length, ...errors.filter((e) => !e.includes(`status of ${status}`))); // the page's own expected status
      await page.evaluate(() => document.fonts.ready);
      const found = Object.entries(await page.evaluate(audit)).filter(([, v]) => v.length);
      if (errors.length) found.push(["console", errors]);
      await page.screenshot({ path: join(OUT, `${name}-${w}.png`), fullPage: true });
      if (found.length) bad++;
      console.log(`${name}@${w} ${found.length ? JSON.stringify(Object.fromEntries(found)) : "ok"}`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  preview.stop();
}
console.log(bad ? `${bad} page views with issues (screenshots in ${OUT})` : `all clean (screenshots in ${OUT})`);
process.exit(bad ? 1 : 0);
