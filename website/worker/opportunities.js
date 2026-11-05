// Opportunities for Constellation members: the programmes in the Gauss Funding Tracker (accelerators such as CDL,
// ESA BIC, hackathons, grants), UKRI and UK Space Agency calls, and space news, ranked for each member.
// Matching is plain keyword rules, run here in the Worker; nothing is sent anywhere. A member's interests are
// suggested from their own Constellation application while we still hold it (180 days) and are saved only
// when they choose them, so they can always see and change what drives their matches.
import { esc } from "./render.js";

export const TAGS = Object.freeze([
  { id: "student", label: "Students", re: /\b(students?|undergrad\w*|phd|msc|master'?s|graduates?|universit\w*)\b/i },
  { id: "research", label: "Research", re: /\b(research\w*|academic\w*|postdoc\w*|phd|scientists?|laborator\w*)\b/i },
  { id: "founder", label: "Founders and startups", re: /\b(founders?|co-?founders?|start-?ups?|ceo|spin-?outs?|ventures?|smes?|entrepreneur\w*|businesses|start (?:a|my own|our own) (?:company|business))\b/i },
  { id: "eo", label: "Earth observation", re: /\b(earth observation|remote sensing|eo|imagery|climate|geospatial)\b/i },
  { id: "comms", label: "Communications", re: /\b(communications?|telecom\w*|satcom|radio|5g|6g|connectivity)\b/i },
  { id: "ai", label: "AI and data", re: /\b(ai|artificial intelligence|machine learning|data science|autonom\w*)\b/i },
  { id: "hardware", label: "Satellites and hardware", re: /\b(hardware|cubesats?|satellites?|payloads?|avionics|propulsion|spacecraft|launch\w*)\b/i },
  { id: "software", label: "Software", re: /\b(software|developers?|coding|cloud|cyber ?security)\b/i },
  { id: "policy", label: "Policy, law and ethics", re: /\b(polic(?:y|ies)|law|legal|regulat\w*|ethic\w*|governance|sustainab\w*)\b/i },
  { id: "education", label: "Teaching and outreach", re: /\b(teach\w*|education\w*|outreach|schools?|stem)\b/i },
]);
const IDS = new Set(TAGS.map((t) => t.id));
const labelOf = (id) => TAGS.find((t) => t.id === id)?.label ?? id;

/** The tags whose words appear in this text. */
export const tagsOf = (text) => TAGS.filter((t) => t.re.test(String(text ?? ""))).map((t) => t.id);
/** Only known tag ids, once each. */
export const cleanTags = (list) => [...new Set((Array.isArray(list) ? list : []).filter((id) => IDS.has(id)))];

/** What drives a member's matches: interests they saved, else ones suggested from their Constellation application. */
export function interestsFor(account, application) {
  if (Array.isArray(account?.interests)) return { tags: cleanTags(account.interests), from: "saved" };
  if (application?.kind === "constellation") return { tags: tagsOf(`${application.role ?? ""} ${application.message ?? ""}`), from: "application" };
  return { tags: [], from: "none" };
}

// Kinds of programme and who they usually suit (on top of the words in each listing).
const SUITS = [
  [/hackathon|challenge|competition|prize/i, ["student", "software", "ai"]],
  [/accelerat|incubat|bic|startup|venture|investor/i, ["founder"]],
  [/grant|fund|call|tender/i, ["research", "founder"]],
  [/fellowship|scholarship|internship|studentship/i, ["student", "research"]],
  [/credits|perks/i, ["founder", "software"]],
];

const DAY = 86_400_000;
const today = (now) => new Date(now).toISOString().slice(0, 10);

/** Every open item in one shape, with the tags it carries: [{ kind, title, url, by, when, detail, tags, source }]. */
export function collect({ programmes, ukri, uksa }, now = Date.now()) {
  const out = [];
  for (const p of programmes ?? []) {
    if (p.deadline && p.deadline !== "rolling" && p.deadline < today(now)) continue; // closed
    const tags = new Set([...tagsOf(`${p.name} ${p.eligibility} ${p.offer} ${p.tags}`), ...cleanTags(String(p.tags ?? "").split(/[,;]\s*/))]);
    for (const [re, ids] of SUITS) if (re.test(`${p.type} ${p.name}`)) ids.forEach((id) => tags.add(id));
    out.push({ kind: p.type || "Programme", title: p.name, url: p.url, by: p.funder, when: p.deadline, detail: [p.amount, p.eligibility].filter(Boolean).join(" · "), region: p.region, tags: [...tags], source: "tracker" });
  }
  for (const c of [...(ukri ?? []).map((i) => ({ ...i, kind: "Funding call" })), ...(uksa ?? []).map((i) => ({ ...i, by: "UK Space Agency" }))]) {
    if (Date.parse(c.at) < now - 60 * DAY) continue;
    const tags = new Set(tagsOf(`${c.title} ${c.summary ?? ""}`));
    for (const [re, ids] of SUITS) if (re.test(`${c.kind} ${c.title}`)) ids.forEach((id) => tags.add(id));
    out.push({ kind: c.kind || "Notice", title: c.title, url: c.url, by: c.funder ?? c.by, when: null, posted: c.at, detail: c.summary ?? "", tags: [...tags], source: c.funder ? "ukri" : "uksa" });
  }
  return out;
}

/** Items sharing at least one of the member's tags, best first (more shared tags, then the nearest deadline). */
export function rank(items, tags) {
  const mine = new Set(tags);
  const due = (i) => (i.when && i.when !== "rolling" ? i.when : "9999");
  return items
    .map((i) => ({ ...i, why: i.tags.filter((t) => mine.has(t)) }))
    .filter((i) => i.why.length)
    .sort((a, b) => b.why.length - a.why.length || (due(a) < due(b) ? -1 : due(a) > due(b) ? 1 : 0));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayText = (iso) => {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
function whenText(i, now) {
  if (i.when === "rolling") return "Rolling";
  if (i.when) {
    const days = Math.round((Date.parse(i.when) - Date.parse(today(now))) / DAY);
    return `Closes ${dayText(i.when)}${days <= 14 ? (days === 0 ? " (today)" : ` (${days} day${days === 1 ? "" : "s"})`) : ""}`;
  }
  return i.posted ? `Posted ${dayText(i.posted)}` : "See the official page";
}
const item = (i, now) =>
  `<li class="opp"><div class="opp-head"><span class="tag">${esc(i.kind)}</span><span class="opp-when">${esc(whenText(i, now))}</span></div>` +
  `<h3><a href="${esc(i.url)}" rel="noopener noreferrer">${esc(i.title)}</a></h3>` +
  (i.by || i.region ? `<p class="m">${esc([i.by, i.region].filter(Boolean).join(" · "))}</p>` : "") +
  (i.detail ? `<p class="m">${esc(i.detail)}</p>` : "") +
  (i.why?.length ? `<p class="m why">Matches: ${esc(i.why.map(labelOf).join(", "))}</p>` : "") + `</li>`;

function interestsForm(tags, from) {
  const boxes = TAGS.map((t) => `<label class="check"><input type="checkbox" name="interest" value="${t.id}"${tags.includes(t.id) ? " checked" : ""}> <span>${esc(t.label)}</span></label>`).join("");
  const said = from === "application" ? "Suggested from your application. Save them to keep them, or change them." : from === "saved" ? "Your saved interests." : "Choose what you work on to see matches.";
  return `<details class="interests"${from === "saved" ? "" : " open"}><summary>Your interests</summary><p class="m">${said}</p>` +
    `<form method="post" action="/app/prefs" class="interest-form"><input type="hidden" name="what" value="interests"><div class="interest-grid">${boxes}</div>` +
    `<p class="actions"><button class="btn ghost">Save interests</button></p></form></details>`;
}

/** The members' "Opportunities" section of the workspace. */
export function renderOpportunities({ feeds, account, application, now = Date.now() }) {
  const { tags, from } = interestsFor(account, application);
  const all = collect({ programmes: feeds.programmes?.data, ukri: feeds.ukri?.data, uksa: feeds.uksa?.data }, now);
  const matched = rank(all, tags).slice(0, 6);
  const shown = new Set(matched.map((i) => i.url));
  const programmes = all.filter((i) => i.source === "tracker" && !shown.has(i.url))
    .sort((a, b) => ((a.when && a.when !== "rolling" ? a.when : "9999") < (b.when && b.when !== "rolling" ? b.when : "9999") ? -1 : 1)).slice(0, 12);
  const calls = all.filter((i) => i.source !== "tracker" && !shown.has(i.url)).sort((a, b) => (a.posted < b.posted ? 1 : -1)).slice(0, 6);
  const news = (feeds.news?.data ?? []).slice(0, 6);
  const list = (items) => `<ol class="opp-list">${items.map((i) => item(i, now)).join("")}</ol>`;
  const nothing = !all.length && !news.length;
  return `<section class="opps" aria-labelledby="opps-h"><div class="section-head"><div><p class="label">OPPORTUNITIES</p><h2 id="opps-h">Opportunities for you</h2></div></div>` +
    `<p class="lead">Accelerators, hackathons, grants and calls, ranked against your interests. Always check eligibility and dates on the official page.</p>` +
    interestsForm(tags, from) +
    (matched.length ? `<h3 class="label">Matched for you</h3>${list(matched)}` : tags.length && all.length ? `<p class="m">Nothing open matches your interests right now; everything open is below.</p>` : "") +
    (programmes.length ? `<h3 class="label">Programmes we track</h3>${list(programmes)}` : "") +
    (calls.length ? `<h3 class="label">New calls: UKRI and UK Space Agency</h3>${list(calls)}` : "") +
    (news.length ? `<h3 class="label">Space news</h3><ul class="news">${news.map((n) => `<li><a href="${esc(n.url)}" rel="noopener noreferrer">${esc(n.title)}</a> <span class="m">${esc(n.site)} · ${esc(dayText(n.at))}</span></li>`).join("")}</ul>` +
      `<p class="m">Headlines via the Spaceflight News API; each links to the original article.</p>` : "") +
    (nothing ? `<p class="m">Opportunities are being gathered; check back soon.</p>` : "") + `</section>`;
}
