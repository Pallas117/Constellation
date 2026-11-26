import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSnapshot, parseConfig, readArgo, readGates, loopbackUrl, ZONES, METRICS, MAX_NODES, DEFAULT_CONFIG, type Snapshot } from "./state-snapshot.ts";

const NOW = Date.parse("2026-11-26T12:00:00Z");
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

/** Recorded-shape fixtures (tools/argo store.go, gates results.log); no real hosts or addresses. */
function fixtures(stateAgeS: number) {
  const dir = mkdtempSync(join(tmpdir(), "state-snapshot-"));
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({
      class: "OK",
      checked_at: ago(stateAgeS),
      net: { privacy: 70, rtt_ms: 40, speed: "fast", signal: "good", link: { gw_loss_pct: -1, gw_jitter_ms: 2, net_loss_pct: 0, net_jitter_ms: 9, net_rtt_ms: 18, path: "ok" } },
      switch: { tailnet: { at: ago(stateAgeS), peer: "hub", ms: 52, via: "direct" } },
    }),
  );
  writeFileSync(
    join(dir, "incidents.jsonl"),
    [
      { time: ago(3 * 86400), event: "open", class: "NO_ROUTE" },
      { time: ago(3600), event: "open", class: "NO_ROUTE" },
      { time: ago(3500), event: "resolved", class: "NO_ROUTE" },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n{torn",
  );
  const gates = join(dir, "results.log");
  writeFileSync(
    gates,
    [
      `${ago(7200)} aaa bbb FAILED on gatebox (npm ci, test): gates rc=1 in 93 s on aaa`,
      `${ago(3000)} ccc ddd MOVED merged main into PR #1`,
      `${ago(600)} eee fff PASSED merge only: gatebox passed eee`,
    ].join("\n") + "\n",
  );
  utimesSync(gates, new Date(NOW - 600_000), new Date(NOW - 600_000));
  return { dir, gates };
}

function shapeOf(s: Snapshot) {
  return Object.fromEntries(Object.entries(s.cells).map(([n, zones]) => [n, Object.fromEntries(Object.entries(zones).map(([z, m]) => [z, Object.keys(m)]))]));
}

test("state snapshot: shape is constant whatever the sources hold", () => {
  const cfg = parseConfig({ nodes: ["node-0", "node-1"], local: "node-0", gatebox: "node-1" });
  const { dir, gates } = fixtures(30);
  const full = buildSnapshot({ ...readArgo(dir, NOW), ...readGates(gates, NOW) }, cfg, NOW);
  const empty = buildSnapshot({}, cfg, NOW);
  assert.deepEqual(shapeOf(full), shapeOf(empty));
  assert.deepEqual(Object.keys(full.cells["node-0"]), [...ZONES]);
  const per = Object.values(full.dims.metrics).reduce((a, m) => a + m.length, 0);
  assert.equal(per, Object.keys(METRICS).length);
  for (const zones of Object.values(full.cells))
    for (const m of Object.values(zones))
      for (const c of Object.values(m)) {
        assert.deepEqual(Object.keys(c), ["value", "mask", "age_s", "source"]);
        if (c.mask === 0) assert.equal(c.value, null, "a masked cell carries no value");
      }
  // Each source lands on the node that owns it; the other node's cells are masked.
  assert.equal(full.cells["node-0"].F.net_rtt_ms.value, 18);
  assert.equal(full.cells["node-1"].F.net_rtt_ms.mask, 0);
  assert.equal(full.cells["node-1"].H.gate_last_ok.value, 1);
  assert.equal(full.cells["node-1"].H.gate_last_s.value, 93);
  assert.equal(full.cells["node-1"].H.gate_runs_24h.value, 2);
  assert.equal(full.cells["node-0"].F.outages_24h.value, 1);
  assert.equal(full.cells["node-0"].F.tailnet_ms.value, 52);
});

test("state snapshot: stale or unmeasured sources give mask 0 and a null value, never 0.0", () => {
  const { dir } = fixtures(3600); // Argo last checked an hour ago, past its 900 s max age
  const s = buildSnapshot(readArgo(dir, NOW), DEFAULT_CONFIG, NOW);
  for (const [name, c] of Object.entries(s.cells["node-0"].F)) {
    assert.equal(c.mask, 0, name);
    assert.equal(c.value, null, name);
    assert.equal(c.age_s, 3600, name);
  }
  const fresh = buildSnapshot(readArgo(fixtures(10).dir, NOW), DEFAULT_CONFIG, NOW);
  assert.equal(fresh.cells["node-0"].F.net_loss_pct.mask, 1);
  assert.equal(fresh.cells["node-0"].F.net_loss_pct.value, 0, "a measured 0 stays a valid 0");
  // Argo's -1 = not measured, and missing files, are mask 0.
  const unmeasured = buildSnapshot({ net_rtt_ms: { value: null, at: NOW } }, DEFAULT_CONFIG, NOW);
  assert.equal(unmeasured.cells["node-0"].F.net_rtt_ms.mask, 0);
  assert.deepEqual(readArgo(join(dir, "missing"), NOW), {});
  assert.deepEqual(readGates(join(dir, "missing.log"), NOW), {});
  assert.equal(s.cells["node-0"].A.mem_up.mask, 0, "memory not asked: masked, not reported down");
});

test("state snapshot: output stays under 8 KB at the node cap, ids stay generic, memory is loopback only", () => {
  const nodes = Array.from({ length: MAX_NODES + 4 }, (_, i) => `node-${i}`);
  const cfg = parseConfig({ nodes: [...nodes, "judith", "10.0.0.5"], local: "node-0", gatebox: "node-1" });
  assert.equal(cfg.nodes.length, MAX_NODES);
  assert.ok(cfg.nodes.every((n) => /^node-\d+$/.test(n)));
  const { dir, gates } = fixtures(30);
  const readings = { ...readArgo(dir, NOW), ...readGates(gates, NOW), mem_up: { value: 1, at: NOW }, mem_documents: { value: 123456, at: NOW }, mem_index_age_s: { value: 86399, at: NOW } };
  const bytes = Buffer.byteLength(JSON.stringify(buildSnapshot(readings, cfg, NOW)) + "\n");
  assert.ok(bytes < 8192, `${bytes} bytes`);
  assert.deepEqual(parseConfig({ nodes: ["my-mac"] }), DEFAULT_CONFIG);
  assert.equal(loopbackUrl(undefined), "http://127.0.0.1:3002");
  for (const bad of ["http://example.com:3002", "https://127.0.0.1:3002", "http://u:p@127.0.0.1:3002", "http://127.0.0.1.evil.com", "nope"]) assert.equal(loopbackUrl(bad), null, bad);
});
