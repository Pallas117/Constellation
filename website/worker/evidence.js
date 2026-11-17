// Signed evidence packs, delivered through the workspace after an offline pilot. An admin attaches the files (the PDF, the
// pack JSON with its signature, and the public keyring) to one account; that account's owner lists and downloads them.
//   evid:<encoded email>:<id>   the file's bytes in DATA; list metadata carries its name, type, size and date
// The key is built from the signed-in address, never from the request, so one account can't name another's file.
// The command to check a pack is the one documented in docs/EVIDENCE_SIGNING.md ("Verify a pack").
import { esc } from "./render.js";
import { getAccount, putAccount } from "./data.js";

export const EVIDENCE_MAX_BYTES = 8 * 1024 * 1024; // per file (KV allows 25 MiB; the Worker holds the body in memory)
export const EVIDENCE_MAX_FILES = 10; // per account
export const EVIDENCE_TYPES = { pdf: "application/pdf", json: "application/json" };
export const VERIFY_COMMAND = "npm run trust:verify -- pack.json --pdf pack.pdf --keyring signing-keys.json";

const prefixOf = (email) => `evid:${encodeURIComponent(String(email).toLowerCase())}:`;
const ID = /^[a-z0-9]{6,30}$/;

/** A safe download name: no path, no odd characters, at most 80 characters, and an extension we serve. */
export function safeName(raw, ext) {
  const base = String(raw ?? "").split(/[\\/]/).pop().normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/\.{2,}/g, ".").replace(/^[-.]+|[-.]+$/g, "");
  const stem = base.replace(/\.(pdf|json)$/i, "").slice(0, 70).replace(/[-.]+$/g, "") || "evidence";
  return `${stem}.${ext}`;
}

const extOf = (name) => /\.(pdf|json)$/i.exec(String(name ?? ""))?.[1].toLowerCase() ?? null;

/** Check an uploaded file: a .pdf that starts like a PDF, or a .json that parses; within the size limit. Returns { ok, name, type, bytes } or { ok:false, error }. */
export async function checkUpload(file) {
  if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function") return { ok: false, error: "evidence-none" };
  const ext = extOf(file.name);
  if (!ext) return { ok: false, error: "evidence-type" };
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length) return { ok: false, error: "evidence-none" };
  if (bytes.length > EVIDENCE_MAX_BYTES) return { ok: false, error: "evidence-size" };
  if (ext === "pdf") {
    if (new TextDecoder("latin1").decode(bytes.subarray(0, 5)) !== "%PDF-") return { ok: false, error: "evidence-type" };
  } else {
    try { JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return { ok: false, error: "evidence-type" }; }
  }
  return { ok: true, name: safeName(file.name, ext), type: EVIDENCE_TYPES[ext], bytes };
}

async function listKeys(env, email) {
  const page = await env.DATA.list({ prefix: prefixOf(email) });
  return page.keys.map((k) => ({ id: k.name.slice(prefixOf(email).length), ...k.metadata })).filter((f) => f.name).sort((a, b) => (a.at < b.at ? 1 : -1));
}

/** The account's files. KV list() has a small daily budget, so it runs only when the account's evidenceCount is above 0,
 *  and a failed list renders the page without the files instead of failing it. */
export async function listEvidence(env, email, count) {
  if (!(count > 0)) return [];
  return listKeys(env, email).catch(() => []);
}

/** Keep the account's evidenceCount (and its list metadata) equal to what is stored. */
async function syncCount(env, email, by) {
  const account = await getAccount(env, email);
  if (!account) return;
  const n = (await listKeys(env, email)).length;
  if (account.evidenceCount !== n) await putAccount(env, { ...account, evidenceCount: n }, by);
}

/** Attach one uploaded file to an account. Returns an error code or null. */
export async function addEvidence(env, email, file, by, now = Date.now()) {
  const checked = await checkUpload(file);
  if (!checked.ok) return checked.error;
  if ((await listKeys(env, email)).length >= EVIDENCE_MAX_FILES) return "evidence-full";
  const id = `${now.toString(36)}${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`.slice(0, 30);
  await env.DATA.put(`${prefixOf(email)}${id}`, checked.bytes, { metadata: { name: checked.name, type: checked.type, size: checked.bytes.length, at: new Date(now).toISOString(), by } });
  await syncCount(env, email, by);
  return null;
}

export async function deleteEvidence(env, email, id, by) {
  if (!ID.test(id ?? "")) return;
  await env.DATA.delete(`${prefixOf(email)}${id}`);
  await syncCount(env, email, by);
}

/** Used when the account itself is being deleted, so the count is not kept. */
export async function deleteAllEvidence(env, email) {
  for (const f of await listKeys(env, email)) await env.DATA.delete(`${prefixOf(email)}${f.id}`);
}

/** The file, only from the signed-in account's own prefix; anything else is null (the caller answers 404). */
export async function getEvidence(env, email, id) {
  if (!ID.test(id ?? "")) return null;
  const { value, metadata } = await env.DATA.getWithMetadata(`${prefixOf(email)}${id}`, { type: "arrayBuffer" });
  return value && metadata?.name && Object.values(EVIDENCE_TYPES).includes(metadata.type) ? { bytes: value, name: metadata.name, type: metadata.type } : null;
}

export function downloadResponse(file, headers) {
  return new Response(file.bytes, { status: 200, headers: { ...headers, "content-type": file.type, "content-disposition": `attachment; filename="${file.name}"`, "x-content-type-options": "nosniff", "content-length": String(file.bytes.byteLength) } });
}

const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const day = (iso) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "");

/** The customer's card: their files, and the one documented offline check. Empty when there are none. */
export function evidenceCard(files) {
  if (!files?.length) return "";
  return `<article class="tile"><h2 class="label">Evidence pack</h2><p class="big">${files.length} file${files.length === 1 ? "" : "s"}</p><p class="t">Signed by Lightbound</p>` +
    `<ul class="ticks">${files.map((f) => `<li><a href="/app/evidence/${esc(f.id)}" rel="noopener">${esc(f.name)}</a> <span class="muted">${esc(kb(f.size))} · ${esc(day(f.at))}</span></li>`).join("")}</ul>` +
    `<p class="m">Check the pack offline, with no network, from a checkout of the Gauss repository at the release tag (Node 22, after <code>npm ci</code>). Use your downloaded file names:</p>` +
    `<p class="m"><code>${esc(VERIFY_COMMAND)}</code></p>` +
    `<p class="m">A changed record, signature, key id or signing time fails the check.</p></article>`;
}

/** Admin: what is attached to an account, a delete button each, and the upload form. */
export function evidenceAdmin(email, files, i) {
  return `<details class="evid"><summary>Evidence (${files.length})</summary>` +
    (files.length ? `<ul>${files.map((f) => `<li>${esc(f.name)} <span class="muted">${esc(kb(f.size))}</span> <form method="post" action="/app/admin/evidence/delete" class="inline"><input type="hidden" name="email" value="${esc(email)}"><input type="hidden" name="id" value="${esc(f.id)}"><button class="btn ghost">Remove</button></form></li>`).join("")}</ul>` : "") +
    `<form method="post" action="/app/admin/evidence" enctype="multipart/form-data" class="inline"><input type="hidden" name="email" value="${esc(email)}"><label class="sr" for="ev-${i}">Evidence file (PDF or JSON, up to ${EVIDENCE_MAX_BYTES / 1048576} MB)</label>` +
    `<input id="ev-${i}" name="file" type="file" accept=".pdf,.json,application/pdf,application/json" required> <button class="btn ghost">Attach</button></form></details>`;
}

export const EVIDENCE_ERRORS = {
  "evidence-type": "Not attached: only a PDF or a JSON file is accepted, and it must be what its name says.",
  "evidence-size": `Not attached: the file is over ${EVIDENCE_MAX_BYTES / 1048576} MB.`,
  "evidence-none": "Not attached: choose a file, and an account that exists.",
  "evidence-full": `Not attached: an account holds at most ${EVIDENCE_MAX_FILES} evidence files. Remove one first.`,
};
