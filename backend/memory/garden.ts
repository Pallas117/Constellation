import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { roleSatisfies, type AuthRole } from "../auth.js";

/**
 * The Cosmic Garden (GAU-222): a read-only view of the markdown vault that gauss-brain's
 * export-garden.sh rebuilds every hour (notes, [[wikilinks]] and maps of content). Only the
 * exporter's own folder ("Cosmic Brain/") is ever read, and every note is filtered by audience,
 * mirroring the brain's separate catalogs:
 *
 * - Corpus/member/   staff and up (Josh approves documents into corpus/member)
 * - Corpus/operator/ operator and up
 * - Memory/, the memory maps and Home: admin only (agent memories, not team documents)
 *
 * Anything else is never served. Links to a note the caller may not see are dropped, so not even
 * its title leaks. Notes are addressed by their path inside the export, looked up in the index;
 * no request path ever reaches the filesystem.
 */

export const EXPORT_DIR = "Cosmic Brain";
const MAX_NOTES = 2000;
const MAX_NOTE_BYTES = 256 * 1024;
const INDEX_TTL_MS = 60_000;
const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g;

export interface GardenNode {
  id: string; // path inside the export without ".md", e.g. "Corpus/member/onboarding"
  title: string;
  group: string; // top folder plus audience, for colouring: "member", "operator", "memory", "map"
}
export interface GardenGraph {
  nodes: GardenNode[];
  links: Array<{ source: string; target: string }>;
  builtAt: string;
}
interface IndexedNote extends GardenNode {
  minRole: AuthRole;
  body: string;
  targets: string[];
}

/** Who may see the note at this export-relative path (posix, with ".md"), or null for nobody. */
export function audienceOf(rel: string): AuthRole | null {
  if (!rel.endsWith(".md")) return null;
  const [top, second] = rel.split("/");
  if (top === "Corpus" && second === "member") return "staff";
  if (top === "Corpus" && second === "operator") return "operator";
  if (top === "Memory" || rel === "Home.md") return "admin";
  if (top === "MOCs") {
    if (second === "Corpus - member.md") return "staff";
    if (second === "Corpus - operator.md") return "operator";
    if (second?.startsWith("Memory - ")) return "admin";
  }
  return null;
}

function groupOf(rel: string): string {
  const [top, second] = rel.split("/");
  if (top === "Corpus") return second ?? "corpus";
  if (top === "Memory") return "memory";
  return "map";
}

/** Drops YAML frontmatter; the export's metadata (session ids, checksums) isn't for readers. */
export function stripFrontmatter(text: string): string {
  if (!text.startsWith("---\n")) return text;
  const end = text.indexOf("\n---", 4);
  return end < 0 ? text : text.slice(end + 4).replace(/^\r?\n/, "");
}

function titleOf(body: string, rel: string): string {
  const heading = /^#\s+(.+)$/m.exec(body);
  return (heading?.[1] ?? path.posix.basename(rel, ".md")).trim().slice(0, 200);
}

/** Walks the export without following symlinks, so nothing outside it can be indexed. */
function listNotes(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".") || out.length >= MAX_NOTES) continue;
      const full = path.join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(full, relPath);
      else if (st.isFile() && name.endsWith(".md") && st.size <= MAX_NOTE_BYTES) out.push(relPath);
    }
  };
  walk(root, "");
  return out;
}

export function buildIndex(gardenDir: string): Map<string, IndexedNote> {
  const root = path.join(gardenDir, EXPORT_DIR);
  const notes = new Map<string, IndexedNote>();
  const byName = new Map<string, string>();
  for (const rel of listNotes(root)) {
    const minRole = audienceOf(rel);
    if (!minRole) continue;
    const id = rel.slice(0, -3);
    const body = stripFrontmatter(readFileSync(path.join(root, rel), "utf8"));
    const targets = [...body.matchAll(WIKILINK)].map((m) => m[1].trim());
    notes.set(id, { id, title: titleOf(body, rel), group: groupOf(rel), minRole, body, targets });
    byName.set(path.posix.basename(id), byName.has(path.posix.basename(id)) ? "" : id); // "" = ambiguous
  }
  // Obsidian resolves [[a/b]] by path and [[b]] by unique note name.
  for (const note of notes.values()) {
    note.targets = [...new Set(note.targets.map((t) => (notes.has(t) ? t : byName.get(path.posix.basename(t)) || "")).filter(Boolean))];
  }
  return notes;
}

export function graphFor(notes: Map<string, IndexedNote>, role: AuthRole, builtAt: Date): GardenGraph {
  const visible = [...notes.values()].filter((n) => roleSatisfies(role, n.minRole));
  const ids = new Set(visible.map((n) => n.id));
  return {
    nodes: visible.map(({ id, title, group }) => ({ id, title, group })),
    links: visible.flatMap((n) => n.targets.filter((t) => ids.has(t) && t !== n.id).map((target) => ({ source: n.id, target }))),
    builtAt: builtAt.toISOString(),
  };
}

/** The note's markdown with links to notes the caller can't see turned into plain text. */
export function noteFor(notes: Map<string, IndexedNote>, role: AuthRole, id: string): { id: string; title: string; markdown: string } | null {
  const note = notes.get(id);
  if (!note || !roleSatisfies(role, note.minRole)) return null;
  const markdown = note.body.replace(WIKILINK, (whole, target: string, label?: string) => {
    const t = target.trim();
    const resolved = notes.has(t) ? t : [...notes.keys()].find((k) => path.posix.basename(k) === path.posix.basename(t));
    const seen = resolved ? notes.get(resolved) : undefined;
    // The hidden note's name stays hidden too: only the visible note's own label text is kept.
    return seen && roleSatisfies(role, seen.minRole) ? whole : (label ?? "(note not shown)");
  });
  return { id: note.id, title: note.title, markdown };
}

/** GAUSS_GARDEN_DIR must be an absolute path (the vault root, e.g. ~/gauss/garden expanded). */
export function gardenDir(raw: string | undefined = process.env.GAUSS_GARDEN_DIR): string | null {
  return raw && path.isAbsolute(raw) ? path.resolve(raw) : null;
}

let cache: { dir: string; at: number; notes: Map<string, IndexedNote> } | null = null;

/** The index, rebuilt at most once a minute (the garden itself changes hourly). */
export function gardenIndex(now = Date.now()): { notes: Map<string, IndexedNote>; builtAt: Date } | { error: string } {
  const dir = gardenDir();
  if (!dir) return { error: "Cosmic Garden not configured (GAUSS_GARDEN_DIR must be an absolute path)." };
  if (!cache || cache.dir !== dir || now - cache.at > INDEX_TTL_MS) {
    try {
      cache = { dir, at: now, notes: buildIndex(dir) };
    } catch {
      return { error: "Cosmic Garden not readable; the hourly export may not have run yet." };
    }
  }
  return { notes: cache.notes, builtAt: new Date(cache.at) };
}
