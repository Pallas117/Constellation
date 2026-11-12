/**
 * Operator pattern (GAU-235): a path drawn through the 16 vertices of the operator's rotating
 * tesseract, checked by the server after the passkey (backend/pattern/). The rules mirror the
 * signing-key pattern lock (backend/trust/key-lock.ts); pattern.test.ts keeps them equal.
 * The vertices are identities, not screen positions: the figure turns, so a pattern is the
 * letters it passes through, not a shape.
 */
import { apiBase } from "@/lib/api/base-url";

export const PATTERN_RULES = { minLength: 8, maxLength: 24, minDistinct: 6 } as const;
export const VERTEX_COUNT = 16;

/** Why `pattern` can't be used, or null when it can (same wording as the server). */
export function patternProblem(pattern: readonly number[]): string | null {
  if (!pattern.every((v) => Number.isInteger(v) && v >= 0 && v < VERTEX_COUNT)) return "use vertices A to P only";
  const { minLength, maxLength, minDistinct } = PATTERN_RULES;
  if (pattern.length < minLength || pattern.length > maxLength) return `draw ${minLength} to ${maxLength} vertices (this one has ${pattern.length})`;
  if (pattern.some((v, i) => i > 0 && pattern[i - 1] === v)) return "don't pick the same vertex twice in a row";
  if (new Set(pattern).size < minDistinct) return `use at least ${minDistinct} different vertices`;
  return null;
}

/** The vertex nearest (x, y) within `radius`, or -1. */
export function vertexAt(points: ReadonlyArray<{ x: number; y: number }>, x: number, y: number, radius: number): number {
  let best = -1;
  let dist = radius;
  points.forEach((p, i) => {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < dist) {
      dist = d;
      best = i;
    }
  });
  return best;
}

/** The pattern with `vertex` added, unless it repeats the last one or the pattern is full. */
export function extendPattern(pattern: readonly number[], vertex: number): number[] {
  if (vertex < 0 || vertex >= VERTEX_COUNT || pattern[pattern.length - 1] === vertex || pattern.length >= PATTERN_RULES.maxLength) {
    return [...pattern];
  }
  return [...pattern, vertex];
}

export const samePattern = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

// --- API (backend/pattern/router.ts) ------------------------------------------------------

export interface PatternStatus {
  /** This account must draw a pattern for the operator console. */
  required: boolean;
  set: boolean;
  /** This session has drawn it. */
  verified: boolean;
  lockedUntil: number | null;
  /** Where phones open the pad, or null when drawing on a phone is off. */
  padOrigin: string | null;
  request: { state: PadState; expiresAt: number } | null;
  /** A duress pattern is set (backend/pattern/sensor.ts). */
  duressSet: boolean;
  /** What the sensor saw since the last good drawing: wrong drawings, probed phone codes, unusual access. */
  notice: { misses: number; probes: number; unusual: number; lastIp: string | null; lastAt: number | null };
}

export type PadState = "waiting" | "approved" | "failed" | "expired";

export interface DrawResult {
  ok: boolean;
  message?: string;
  reason?: "miss" | "locked" | "not-set";
  triesLeft?: number;
  lockedUntil?: number | null;
  state?: PadState;
}

const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function read<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok && res.status !== 410) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export async function fetchPatternStatus(): Promise<PatternStatus> {
  return read<PatternStatus>(await fetch(`${apiBase()}/api/operator-pattern/status`));
}

export async function verifyPattern(pattern: readonly number[]): Promise<DrawResult> {
  return read<DrawResult>(await fetch(`${apiBase()}/api/operator-pattern/verify`, json({ pattern })));
}

/** The request for setting the pattern; send it through fetchWithStepUp (it needs a fresh passkey touch). */
export const setPatternRequest = (pattern: readonly number[]): [string, RequestInit] => [`${apiBase()}/api/operator-pattern`, json({ pattern })];

/** Setting or removing the duress pattern: through fetchWithStepUp too. */
export const setDuressRequest = (pattern: readonly number[]): [string, RequestInit] => [`${apiBase()}/api/operator-pattern/duress`, json({ pattern })];
export const clearDuressRequest = (): [string, RequestInit] => [`${apiBase()}/api/operator-pattern/duress`, { method: "DELETE" }];

/** The line the pattern page shows when the sensor saw something since the last good drawing, or null. */
export function noticeText(notice: PatternStatus["notice"] | undefined, timeOf: (ms: number) => string): string | null {
  if (!notice) return null;
  const parts: string[] = [];
  if (notice.unusual) parts.push("this session read data unlike the console, so it needs your pattern again");
  if (notice.misses) parts.push(`${notice.misses} wrong ${notice.misses === 1 ? "drawing" : "drawings"}`);
  if (notice.probes) parts.push(`${notice.probes} unknown phone ${notice.probes === 1 ? "code" : "codes"} tried`);
  if (!parts.length) return null;
  const when = notice.lastAt ? `, last at ${timeOf(notice.lastAt)}${notice.lastIp ? ` from ${notice.lastIp}` : ""}` : "";
  return `Since your last sign-in: ${parts.join("; ")}${when}. Not you? Tell an admin.`;
}

export async function openPadRequest(): Promise<{ id: string; expiresAt: number; padUrl: string }> {
  return read(await fetch(`${apiBase()}/api/operator-pattern/requests`, { method: "POST" }));
}

export async function padInfo(request: string): Promise<{ state: PadState; expiresAt?: number; geometryKey?: string | null; error?: string }> {
  return read(await fetch(`${apiBase()}/api/operator-pattern/pad/info`, json({ request })));
}

export async function padDraw(request: string, pattern: readonly number[]): Promise<DrawResult & { error?: string }> {
  return read(await fetch(`${apiBase()}/api/operator-pattern/pad`, json({ request, pattern })));
}
