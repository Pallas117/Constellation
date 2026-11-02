// Cosmic Garden graph layout (GAU-222): a small deterministic force layout, so the same garden
// always draws the same way and no graph library is needed. Positions are in a unit box
// (0..1 on both axes); the page scales them to its SVG.

export interface LayoutNode {
  id: string;
  group: string;
}
export interface LayoutLink {
  source: string;
  target: string;
}
export interface Placed {
  id: string;
  x: number;
  y: number;
  degree: number;
}

/** Stable pseudo-random start positions from the note id (FNV-1a), so layouts don't jump. */
function seed(id: string): [number, number] {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
  return [((h & 0xffff) / 0xffff) * 0.8 + 0.1, ((h >>> 16) / 0xffff) * 0.8 + 0.1];
}

export function layoutGarden(nodes: LayoutNode[], links: LayoutLink[], iterations = 300): Placed[] {
  const n = nodes.length;
  if (n === 0) return [];
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const pos = nodes.map((node) => seed(node.id));
  const degree = new Array<number>(n).fill(0);
  const edges = links
    .map((l) => [index.get(l.source), index.get(l.target)] as const)
    .filter((e): e is readonly [number, number] => e[0] !== undefined && e[1] !== undefined && e[0] !== e[1]);
  for (const [a, b] of edges) {
    degree[a]++;
    degree[b]++;
  }
  const k = Math.sqrt(1 / n) * 0.9; // ideal edge length for the unit box
  for (let it = 0; it < iterations; it++) {
    const temp = 0.1 * (1 - it / iterations) + 0.002;
    const disp = pos.map(() => [0, 0]);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = pos[i][0] - pos[j][0] || 1e-6;
        const dy = pos[i][1] - pos[j][1] || 1e-6;
        const d2 = dx * dx + dy * dy;
        const f = (k * k) / d2;
        disp[i][0] += dx * f;
        disp[i][1] += dy * f;
        disp[j][0] -= dx * f;
        disp[j][1] -= dy * f;
      }
    }
    for (const [a, b] of edges) {
      const dx = pos[a][0] - pos[b][0];
      const dy = pos[a][1] - pos[b][1];
      const d = Math.sqrt(dx * dx + dy * dy) || 1e-6;
      const f = d / k;
      disp[a][0] -= dx * f;
      disp[a][1] -= dy * f;
      disp[b][0] += dx * f;
      disp[b][1] += dy * f;
    }
    for (let i = 0; i < n; i++) {
      // A weak pull to the centre keeps unlinked notes on screen.
      disp[i][0] += (0.5 - pos[i][0]) * 0.05;
      disp[i][1] += (0.5 - pos[i][1]) * 0.05;
      const len = Math.hypot(disp[i][0], disp[i][1]) || 1e-6;
      const step = Math.min(len, temp);
      pos[i][0] = Math.min(0.97, Math.max(0.03, pos[i][0] + (disp[i][0] / len) * step));
      pos[i][1] = Math.min(0.97, Math.max(0.03, pos[i][1] + (disp[i][1] / len) * step));
    }
  }
  return nodes.map((node, i) => ({ id: node.id, x: pos[i][0], y: pos[i][1], degree: degree[i] }));
}

/** Splits note markdown into text and [[wikilink]] parts, so links render as buttons, never HTML. */
export type NotePart = { text: string } | { link: string; label: string };
export function noteParts(markdown: string): NotePart[] {
  const parts: NotePart[] = [];
  const re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g;
  let last = 0;
  for (const m of markdown.matchAll(re)) {
    if (m.index > last) parts.push({ text: markdown.slice(last, m.index) });
    const link = m[1].trim();
    parts.push({ link, label: (m[2] ?? link.split("/").pop() ?? link).trim() });
    last = m.index + m[0].length;
  }
  if (last < markdown.length) parts.push({ text: markdown.slice(last) });
  return parts;
}

/** Resolves a wikilink to a visible note id the way Obsidian does: by path, then by unique name. */
export function resolveLink(link: string, ids: string[]): string | null {
  if (ids.includes(link)) return link;
  const name = link.split("/").pop();
  const matches = ids.filter((id) => id.split("/").pop() === name);
  return matches.length === 1 ? matches[0] : null;
}
