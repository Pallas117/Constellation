import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import express from "express";
import { EnvironmentHistory } from "../trust/environment.js";
import type { CanonicalSpaceWeatherPoint } from "../types.js";
import { PLANS } from "./plans.js";
import { createDataApiRouter, type DataProvider } from "./routers.js";
import { CommerceStore } from "./store.js";
import { csvField, summarise, trustUsageCsv } from "./usage-export.js";

const NOW = Date.parse("2026-10-24T03:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
/** A quiet, current point issued 30 s before NOW: enough for a trust record. */
const quiet = {
  timestamp: iso(NOW - 30_000),
  observedAt: iso(NOW - 90_000),
  alerts: {
    stormTier: "quiet",
    reason: "",
    radiation: { level: 0, label: "S0", basis: "GOES >=10 MeV protons 0.3 pfu", observedAt: iso(NOW - 5 * 60_000) },
    geomagnetic: { level: 0, label: "G0", basis: "Kp 1.67", observedAt: iso(NOW - 3_600_000) },
    radioBlackout: { level: 0, label: "R0", basis: "GOES 0.1-0.8nm X-rays B5", observedAt: iso(NOW - 60_000) },
  },
  particles: { protons: { value: 0.3, energy: ">=10 MeV", satellite: "GOES-18", timestamp: iso(NOW - 5 * 60_000) }, electrons: null },
  indices: { kp: 1.67, dst: -12, dstMethod: "measured", dstDerivedFrom: [], kpKind: "planetary-3h", kpObservedAt: iso(NOW - 3_600_000), dstObservedAt: iso(NOW - 40 * 60_000) },
  quality: { outlier: false, stale: false, interpolated: false, extrapolated: false, lowConfidence: false, tier: 0 },
  senseChecks: [],
} as unknown as CanonicalSpaceWeatherPoint;

const data: DataProvider = {
  latest: async () => null,
  history: async () => ({ source: "memory", points: [] }),
  sources: () => [],
  environment: () => new EnvironmentHistory([quiet], "live feed"),
};
const inference = (spacecraftId: string, over: Record<string, unknown> = {}) => ({ time: iso(NOW - 10_000), spacecraftId, modelId: "atlas-v2", ...over });

async function withApi(store: CommerceStore, fn: (post: (body: unknown) => Promise<Response>, orgId: string) => Promise<void>) {
  const org = store.createOrg("xOrbita", "pilot");
  const key = store.createKey(org.id, "ops", "u").key;
  const app = express();
  app.use(express.json());
  app.use("/api/v1", createDataApiRouter(store, data, () => new Date(NOW), PLANS));
  const server = app.listen(0);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/data/trust/records`;
  try {
    await fn((body) => fetch(url, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) }), org.id);
  } finally {
    server.close();
  }
}

test("trust metering: every record returned is logged once, by spacecraft and month; rejected items are not (GAU-70)", async () => {
  const store = new CommerceStore(":memory:");
  await withApi(store, async (post, orgId) => {
    assert.equal((await post(inference("AVERA-1"))).status, 200);
    const res = await post({ inferences: [inference("AVERA-1"), inference("AVERA-2"), inference(""), inference("AVERA-2")] });
    const body = (await res.json()) as { data: unknown[]; rejected: unknown[] };
    assert.equal(body.data.length, 3);
    assert.equal(body.rejected.length, 1);
    assert.equal((await post(inference(""))).status, 400, "a rejected single inference issues nothing");
    assert.deepEqual(store.trustUsage(orgId, "2026-10", "2026-10"), [
      { month: "2026-10", spacecraftId: "AVERA-1", records: 2 },
      { month: "2026-10", spacecraftId: "AVERA-2", records: 2 },
    ]);
    assert.deepEqual(summarise(store.trustUsage(orgId, "2026-10", "2026-10")), { records: 4, spacecraftMonths: 2 });
    assert.deepEqual(store.trustUsage(orgId, "2026-09", "2026-09"), [], "nothing outside the window");
    assert.equal(store.usage(orgId, "2026-10-24", "2026-10-24")[0].count, 2, "per-call metering is unchanged: 2 successful calls");
  });
});

test("trust metering: the log is append-only; the database refuses updates and deletes (GAU-70)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gauss-metering-"));
  try {
    const file = path.join(dir, "commerce.db");
    const store = new CommerceStore(file);
    await withApi(store, async (post) => {
      assert.equal((await post(inference("AVERA-1"))).status, 200);
    });
    const raw = new Database(file);
    try {
      assert.throws(() => raw.prepare("UPDATE trust_issued SET spacecraft_id = 'X'").run(), /append-only/);
      assert.throws(() => raw.prepare("DELETE FROM trust_issued").run(), /append-only/);
      assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM trust_issued").get() as { n: number }).n, 1);
    } finally {
      raw.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("trust metering: if the usage log can't be written, no records are returned (GAU-70)", async () => {
  const store = new CommerceStore(":memory:");
  store.recordTrustIssued = () => {
    throw new Error("disk full");
  };
  await withApi(store, async (post, orgId) => {
    const res = await post(inference("AVERA-1"));
    assert.equal(res.status, 500);
    const body = (await res.json()) as { data?: unknown; error: string };
    assert.equal(body.data, undefined);
    assert.match(body.error, /no records were issued/);
    assert.deepEqual(store.usage(orgId, "2026-10-24", "2026-10-24"), [], "a failed call is not metered either");
  });
});

test("trust metering: the CSV export reconciles with the records issued and is safe to open in a spreadsheet (GAU-70)", async () => {
  const store = new CommerceStore(":memory:");
  await withApi(store, async (post, orgId) => {
    const ids = ["AVERA-1", 'say "hi", ok', "=HYPERLINK(\"http://x\")", "-1+2", "@sum"];
    for (const id of ids) assert.equal((await post(inference(id))).status, 200);
    const rows = store.trustUsage(orgId, "2026-10", "2026-10");
    const csv = trustUsageCsv("xOrbita", rows);
    const lines = csv.split("\r\n").filter(Boolean);
    assert.equal(lines[0], '"month","organisation","spacecraft_id","trust_records"');
    assert.equal(lines.length, ids.length + 1);
    assert.ok(csv.includes('"say ""hi"", ok"'), "quotes doubled, comma kept inside the field");
    for (const formula of ["=HYPERLINK", "-1+2", "@sum"]) assert.ok(csv.includes(`"'${formula}`), `${formula} is prefixed so it can't run`);
    const total = lines.slice(1).reduce((n, line) => n + Number(line.slice(line.lastIndexOf(",") + 1).replace(/"/g, "")), 0);
    assert.equal(total, ids.length, "the export adds up to the records returned");
  });
  assert.equal(csvField(12), '"12"');
  assert.equal(csvField("\tcmd"), `"'\tcmd"`);
});
