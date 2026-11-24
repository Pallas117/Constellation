// Where to follow Lightbound, and the share links: ONE list for the whole site.
// To add a channel, paste its public URL into `url` below, then run:  npm run site:social
// (tools/sync_social.mjs writes the follow strip into every public page's footer; website/test/site.test.mjs
// fails if a page and this list drift apart). An empty `url` renders nothing at all.
// Plain links only: no scripts, SDKs, pixels or embeds. A URL must be https on the channel's own host, with no
// query, fragment, port or sign-in part, or it is dropped (a typo can't send visitors somewhere else).
import { esc } from "./render.js";

export const SITE = "https://lightbound.space";

export const SOCIAL = [
  { id: "linkedin", label: "LinkedIn", url: "" }, // empty until Josh gives the company page
  { id: "x", label: "X", url: "" }, // empty until Josh gives the handle
  { id: "youtube", label: "YouTube", url: "" }, // empty until Josh gives the channel
  { id: "instagram", label: "Instagram", url: "https://instagram.com/constellationcosmos" },
  { id: "substack", label: "Essays", url: "https://lightbounduk.substack.com" },
  { id: "luma", label: "Luma", url: "https://luma.com/constellation" },
];

const HOSTS = {
  linkedin: /^www\.linkedin\.com$/,
  x: /^x\.com$/,
  youtube: /^www\.youtube\.com$/,
  instagram: /^(www\.)?instagram\.com$/,
  substack: /^[a-z0-9-]+\.substack\.com$/,
  luma: /^luma\.com$/,
};

/** The entries that have a usable URL, in list order. */
export function socialLinks(list = SOCIAL) {
  return (Array.isArray(list) ? list : []).filter((e) => {
    if (!e || typeof e.url !== "string" || !e.url || !e.label || !Object.hasOwn(HOSTS, e.id)) return false;
    let u;
    try { u = new URL(e.url); } catch { return false; }
    return u.protocol === "https:" && HOSTS[e.id].test(u.hostname) && !u.port && !u.username && !u.password && !u.search && !u.hash && u.href.replace(/\/$/, "") === e.url.replace(/\/$/, "");
  });
}

const anchors = (list, cls = "") =>
  socialLinks(list).map((e) => `<a${cls ? ` class="${cls}"` : ""} href="${esc(e.url)}" rel="me noopener">${esc(e.label)}</a>`).join("");

/** Footer strip on every public page. Nothing to follow: an empty string, so no label and no empty box. */
export function renderFollow(list = SOCIAL) {
  const links = anchors(list);
  return links ? `<nav class="follow" aria-label="Follow"><span class="label">Follow</span>${links}</nav>` : "";
}

/** The storm page's second call to action: the same links, as buttons. */
export function renderFollowCta(list = SOCIAL) {
  const links = anchors(list, "btn ghost");
  return links ? `<div><h3 id="follow-h">Follow the next storm.</h3><p class="actions">${links}</p></div>` : "";
}

// Pages that offer sharing. The text is what the share window is pre-filled with.
export const SHARE_PAGES = {
  "/gauss/storms/": "The night the sky went red: the 10–11 May 2024 storm, hour by hour",
  "/gauss/evidence/": "A sample evidence report for AI running in orbit (synthetic data)",
};

export const shareUrl = (path, medium) => `${SITE}${path}?utm_source=share&utm_medium=${medium}`;

/** Share links: ordinary links to the networks' own share pages, and the address to copy. No script. */
export function renderShare(path) {
  if (!Object.hasOwn(SHARE_PAGES, path)) return "";
  const q = encodeURIComponent;
  const linkedin = `https://www.linkedin.com/sharing/share-offsite/?url=${q(shareUrl(path, "linkedin"))}`;
  const x = `https://x.com/intent/post?text=${q(SHARE_PAGES[path])}&url=${q(shareUrl(path, "x"))}`;
  return `<div class="share"><span class="label">Share</span><a href="${esc(linkedin)}" rel="noopener">LinkedIn</a><a href="${esc(x)}" rel="noopener">X</a>` +
    `<span class="copy"><span class="label">Copy link</span><span class="copy-url">${esc(shareUrl(path, "copy"))}</span></span></div>`;
}

/** Every public page with a footer gets the strip; signed-in, operator-only and Turnstone pages don't. */
export const followsOn = (route) => !route.startsWith("/app/") && route !== "/argo/" && route !== "/turnstone/";
