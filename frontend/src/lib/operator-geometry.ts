/**
 * Each operator's "polymorphic geometry" (GAU-235): a tesseract whose marked
 * vertices, accent edges, colour and spin come from a hash of their passkey's
 * public key. The same passkey always gives the same figure; it opens in a new
 * orientation every time.
 *
 * A recognition cue, NOT an authentication factor. It is derived from public
 * data (the public key), so anyone who can read the key can draw the figure.
 * What signs an operator in is the passkey touch (Touch ID, Face ID or a
 * fingerprint), checked by the device and proved to the server by a signature.
 */
import { EDGES, VERTEX_LABELS, VERTICES } from "./tesseract";

export const GEOMETRY_VERSION = "gauss-operator-geometry-v1";
export const MARKED_VERTICES = 4;
export const ACCENT_EDGES = 3;

/** Identity hues, kept apart from the console's status colours (signal lime, amber caution, sun risk). */
export const GEOMETRY_PALETTE = [
  { name: "cyan", hex: "#78C8E6" },
  { name: "violet", hex: "#A99BE8" },
  { name: "teal", hex: "#5CC9B0" },
  { name: "rose", hex: "#E58FA8" },
  { name: "sky", hex: "#6FA8F0" },
  { name: "sand", hex: "#D9C7A0" },
] as const;

export type Spin = 1 | -1;

export interface OperatorGeometry {
  /** Vertex indices, drawn as a path in this order. */
  marked: number[];
  /** Indices into EDGES drawn in the accent colour. */
  accents: number[];
  colour: string;
  colourName: string;
  /** Direction of rotation in each plane. */
  spin: { xy: Spin; zw: Spin; xz: Spin };
  /** The marked vertices' letters, e.g. "C·H·M·P": something to say out loud. */
  code: string;
}

/** Picks `count` distinct indices below `from`, one digest byte each. */
function pick(digest: Uint8Array, offset: number, count: number, from: number): number[] {
  const pool = Array.from({ length: from }, (_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(pool.splice(digest[offset + i] % pool.length, 1)[0]);
  return out;
}

export function geometryFromDigest(digest: Uint8Array): OperatorGeometry {
  if (digest.length < 9) throw new Error("geometry digest too short");
  const marked = pick(digest, 0, MARKED_VERTICES, VERTICES.length);
  const accents = pick(digest, MARKED_VERTICES, ACCENT_EDGES, EDGES.length);
  const colour = GEOMETRY_PALETTE[digest[7] % GEOMETRY_PALETTE.length];
  const bits = digest[8];
  return {
    marked,
    accents,
    colour: colour.hex,
    colourName: colour.name,
    spin: { xy: bits & 1 ? 1 : -1, zw: bits & 2 ? 1 : -1, xz: bits & 4 ? 1 : -1 },
    code: marked.map((v) => VERTEX_LABELS[v]).join("·"),
  };
}

/** Standard or URL-safe base64, padded or not (better-auth stores passkey public keys as base64). */
export function decodeBase64(text: string): Uint8Array {
  const normal = text.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = normal + "=".repeat((4 - (normal.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** SHA-256 over a version tag and the passkey's public key (COSE bytes). */
export async function geometryDigest(publicKey: string): Promise<Uint8Array> {
  const tag = new TextEncoder().encode(`${GEOMETRY_VERSION}\0`);
  const key = decodeBase64(publicKey);
  const input = new Uint8Array(tag.length + key.length);
  input.set(tag);
  input.set(key, tag.length);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input));
}

export async function geometryForPublicKey(publicKey: string): Promise<OperatorGeometry> {
  return geometryFromDigest(await geometryDigest(publicKey));
}

/** Words for screen readers and tooltips. */
export function describeGeometry(geometry: OperatorGeometry | null): string {
  if (!geometry) return "Rotating tesseract";
  return `Your operator geometry: ${geometry.colourName} tesseract marked ${geometry.code.replace(/·/g, " ")}`;
}
