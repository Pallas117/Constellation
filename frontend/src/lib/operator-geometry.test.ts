import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import {
  ACCENT_EDGES,
  GEOMETRY_PALETTE,
  GEOMETRY_VERSION,
  MARKED_VERTICES,
  decodeBase64,
  describeGeometry,
  geometryDigest,
  geometryForPublicKey,
  geometryFromDigest,
} from "./operator-geometry";
import { EDGES, FIT, VERTEX_LABELS, VERTICES, project, randomRotation } from "./tesseract";

test("the tesseract has 16 vertices and 32 edges, each edge one coordinate apart", () => {
  assert.equal(VERTICES.length, 16);
  assert.equal(EDGES.length, 32);
  assert.equal(VERTEX_LABELS.length, VERTICES.length);
  for (const [i, j] of EDGES) assert.equal(VERTICES[i].filter((c, k) => c !== VERTICES[j][k]).length, 1);
  for (let v = 0; v < 16; v++) assert.equal(EDGES.filter(([i, j]) => i === v || j === v).length, 4, "every vertex has degree 4");
});

test("the projection keeps every orientation inside its box (the pattern lock's 270/400 scale)", () => {
  assert.equal(FIT, 270 / 400);
  for (let n = 0; n < 2000; n++) {
    const rot = randomRotation();
    for (const v of VERTICES) {
      const p = project(v, rot, 400);
      assert.ok(p.x > 0 && p.x < 400 && p.y > 0 && p.y < 400, `${JSON.stringify(rot)} → ${JSON.stringify(p)}`);
    }
  }
});

test("a passkey always draws the same geometry, from the SHA-256 of a version tag and its public key", async () => {
  const publicKey = randomBytes(77);
  const b64 = publicKey.toString("base64");
  const expected = createHash("sha256").update(`${GEOMETRY_VERSION}\0`).update(publicKey).digest();
  assert.deepEqual(Buffer.from(await geometryDigest(b64)), expected);
  // better-auth stores standard base64; URL-safe and unpadded forms read the same.
  assert.deepEqual(await geometryForPublicKey(b64), await geometryForPublicKey(publicKey.toString("base64url")));
  assert.deepEqual(decodeBase64("AQID"), new Uint8Array([1, 2, 3]));
});

test("geometry marks distinct vertices and edges with a palette colour and a sayable code", () => {
  const g = geometryFromDigest(new Uint8Array(32).fill(0));
  assert.deepEqual(g.marked, [0, 1, 2, 3]);
  assert.equal(g.code, "A·B·C·D");
  assert.equal(g.colour, GEOMETRY_PALETTE[0].hex);
  assert.deepEqual(g.spin, { xy: -1, zw: -1, xz: -1 });
  assert.match(describeGeometry(g), /cyan tesseract marked A B C D/);
  assert.equal(describeGeometry(null), "Rotating tesseract");
  assert.throws(() => geometryFromDigest(new Uint8Array(4)));

  for (let n = 0; n < 500; n++) {
    const r = geometryFromDigest(new Uint8Array(randomBytes(32)));
    assert.equal(new Set(r.marked).size, MARKED_VERTICES);
    assert.equal(new Set(r.accents).size, ACCENT_EDGES);
    assert.ok(r.marked.every((v) => v >= 0 && v < VERTICES.length));
    assert.ok(r.accents.every((e) => e >= 0 && e < EDGES.length));
    assert.ok(GEOMETRY_PALETTE.some((c) => c.hex === r.colour));
  }
});

test("different passkeys almost always look different", async () => {
  const seen = new Set<string>();
  for (let n = 0; n < 200; n++) {
    const g = await geometryForPublicKey(randomBytes(77).toString("base64"));
    seen.add(`${g.code}|${g.accents.join(",")}|${g.colour}`);
  }
  assert.ok(seen.size >= 199, `${seen.size} distinct of 200`);
});
