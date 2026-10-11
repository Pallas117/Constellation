import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import type { AuthenticatedRequest, AuthRole } from "../auth.js";
import { PLANS, type Plan, type PlanLimits } from "./plans.js";
import { createDataApiRouter, createOrgRouter, createPilotRequestHandler, type DataProvider } from "./routers.js";
import { CommerceStore } from "./store.js";

const data: DataProvider = {
  latest: async () => ({ timestamp: "2026-10-10T00:00:00Z", kp: 3 }),
  history: async (lookbackMs, limit) => ({ source: "memory", points: [{ lookbackMs, limit }] }),
  sources: () => [{ id: "noaa", ok: true }],
};

const tinyPlans: Record<Plan, PlanLimits> = {
  ...PLANS,
  pilot: { api: true, requestsPerMinute: 3, requestsPerDay: 5, maxLookbackMs: 60 * 60 * 1000 },
};

async function withApp(
  fn: (base: string, store: CommerceStore, clock: { t: number }) => Promise<void>,
  plans: Record<Plan, PlanLimits> = tinyPlans,
) {
  const store = new CommerceStore(":memory:");
  const clock = { t: Date.parse("2026-10-10T08:00:00Z") };
  const app = express();
  app.use(express.json());
  app.use("/api/v1", createDataApiRouter(store, data, () => new Date(clock.t), plans));
  app.use("/api/orgs", (req: AuthenticatedRequest, _res, next) => {
    const role = req.header("x-test-role") as AuthRole | undefined;
    if (role) req.auth = { userId: req.header("x-test-user") ?? "u", email: null, role, rawRoles: [role], token: "t" };
    next();
  });
  app.use("/api/orgs", createOrgRouter(store));
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api`, store, clock);
  } finally {
    server.close();
  }
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

test("keys are stored only as hashes, resolve to their org, and stop working when revoked", () => {
  const store = new CommerceStore(":memory:");
  const org = store.createOrg("xOrbita", "pilot");
  const { key, info } = store.createKey(org.id, "ops", "u1");
  assert.match(key, /^gk_[0-9a-f]{8}_/);
  assert.equal(JSON.stringify(store.listKeys(org.id)).includes(key), false);
  assert.equal(store.resolveKey(key)?.org.name, "xOrbita");
  assert.equal(store.resolveKey(key.slice(0, -1) + "A"), undefined);
  assert.equal(store.revokeKey(org.id, info.id), true);
  assert.equal(store.resolveKey(key), undefined);
});

test("data API: key required, plan enforced, refined data returned with meta", async () => {
  await withApp(async (base, store) => {
    const free = store.createKey(store.createOrg("Free Co", "free").id, "k", "u").key;
    const pilot = store.createKey(store.createOrg("xOrbita", "pilot").id, "k", "u").key;

    assert.equal((await fetch(`${base}/v1/data/space-weather/latest`)).status, 401);
    assert.equal((await fetch(`${base}/v1/data/space-weather/latest`, { headers: bearer("gk_nope") })).status, 401);
    assert.equal((await fetch(`${base}/v1/data/space-weather/latest`, { headers: bearer(free) })).status, 403);

    const res = await fetch(`${base}/v1/data/space-weather/latest`, { headers: bearer(pilot) });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: { kp: number }; meta: { org: string; plan: string } };
    assert.equal(body.data.kp, 3);
    assert.deepEqual([body.meta.org, body.meta.plan], ["xOrbita", "pilot"]);
    assert.equal(res.headers.get("x-quota-limit"), "5");
  });
});

test("data API: per-key minute limit, per-org daily quota, history capped by plan", async () => {
  await withApp(async (base, store, clock) => {
    const org = store.createOrg("JAOPS", "pilot");
    const k1 = store.createKey(org.id, "a", "u").key;
    const k2 = store.createKey(org.id, "b", "u").key;
    const get = (key: string, path = "/v1/data/sources/status") => fetch(`${base}${path}`, { headers: bearer(key) });

    for (let i = 0; i < 3; i++) assert.equal((await get(k1)).status, 200);
    assert.equal((await get(k1)).status, 429, "4th request in the same minute");
    clock.t += 61_000;
    assert.equal((await get(k1)).status, 200);
    assert.equal((await get(k2)).status, 200, "5th request today, from the org's other key");
    assert.equal((await get(k2)).status, 429, "quota of 5/day is shared by the organisation's keys");

    clock.t += 24 * 60 * 60 * 1000; // next UTC day
    const hist = (await (await get(k2, "/v1/data/space-weather/history?lookback=P1D")).json()) as { meta: { lookbackMs: number } };
    assert.equal(hist.meta.lookbackMs, 60 * 60 * 1000, "P1D capped to the plan's 1h");
  });
});

test("metering counts successful calls by route template, not failures or query strings", async () => {
  await withApp(async (base, store) => {
    const org = store.createOrg("Meter Co", "pilot");
    const key = store.createKey(org.id, "k", "u").key;
    await fetch(`${base}/v1/data/space-weather/history?lookback=PT5M&secret=x`, { headers: bearer(key) });
    await fetch(`${base}/v1/data/space-weather/latest`, { headers: bearer(key) });
    await fetch(`${base}/v1/data/nope`, { headers: bearer(key) });
    const rows = store.usage(org.id, "2026-10-10", "2026-10-10");
    assert.deepEqual(
      rows.map((r) => `${r.endpoint}=${r.count}`).sort(),
      ["GET /api/v1/data/space-weather/history=1", "GET /api/v1/data/space-weather/latest=1"],
    );
  }, PLANS);
});

test("org self-service: members create and revoke keys; outsiders get 404; operators read usage", async () => {
  await withApp(async (base, store) => {
    const org = store.createOrg("xOrbita", "pilot");
    const freeOrg = store.createOrg("Free Co", "free");
    store.addMember(org.id, "alice");
    store.addMember(freeOrg.id, "alice");
    const as = (user: string, role: AuthRole = "user") => ({ "x-test-user": user, "x-test-role": role, "content-type": "application/json" });

    const mine = (await (await fetch(`${base}/orgs/mine`, { headers: as("alice") })).json()) as { orgs: { name: string }[] };
    assert.deepEqual(mine.orgs.map((o: { name: string }) => o.name).sort(), ["Free Co", "xOrbita"]);

    const created = await fetch(`${base}/orgs/${org.id}/keys`, { method: "POST", headers: as("alice"), body: JSON.stringify({ name: "ci" }) });
    assert.equal(created.status, 201);
    const { key, info } = (await created.json()) as { key: string; info: { id: string } };
    assert.ok(store.resolveKey(key));

    assert.equal((await fetch(`${base}/orgs/${org.id}/keys`, { method: "POST", headers: as("mallory"), body: "{}" })).status, 404);
    assert.equal((await fetch(`${base}/orgs/${freeOrg.id}/keys`, { method: "POST", headers: as("alice"), body: "{}" })).status, 403);
    assert.equal((await fetch(`${base}/orgs/${org.id}/usage`, { headers: as("mallory") })).status, 404);
    assert.equal((await fetch(`${base}/orgs/${org.id}/usage`, { headers: as("olga", "operator") })).status, 200);

    assert.equal((await fetch(`${base}/orgs/${org.id}/keys/${info.id}`, { method: "DELETE", headers: as("mallory") })).status, 404);
    assert.equal((await fetch(`${base}/orgs/${org.id}/keys/${info.id}`, { method: "DELETE", headers: as("alice") })).status, 204);
    assert.equal(store.resolveKey(key), undefined);
  });
});

test("pilot requests: valid leads stored, bad input rejected, honeypot dropped, 3 per IP per hour", async () => {
  const store = new CommerceStore(":memory:");
  let t = Date.parse("2026-10-10T08:00:00Z");
  const app = express();
  app.use(express.json());
  app.post("/api/pilot-requests", createPilotRequestHandler(store, () => t));
  const server = app.listen(0);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/pilot-requests`;
  const post = (body: object) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const lead = { name: "Ada", email: "Ada@xOrbita.space", company: "xOrbita", interest: "data-api", useCase: "Replay our LEO logs" };
  try {
    assert.equal((await post({ ...lead, email: "not-an-email" })).status, 400);
    assert.equal((await post({ ...lead, website: "http://spam" })).status, 201, "honeypot looks like success");
    assert.equal(store.listPilotRequests().length, 0, "honeypot submissions are not stored");

    assert.equal((await post(lead)).status, 201);
    const [saved] = store.listPilotRequests();
    assert.equal(saved.email, "ada@xorbita.space");
    assert.equal(saved.interest, "data-api");
    assert.equal(JSON.stringify(saved).includes("127.0.0.1"), false, "IP is stored only as a hash");

    assert.equal((await post({ ...lead, interest: "free-money" })).status, 201);
    assert.equal(store.listPilotRequests()[0].interest, "both", "unknown interest normalised");
    assert.equal((await post(lead)).status, 201);
    assert.equal((await post(lead)).status, 429, "4th request from one IP within an hour");
    t += 61 * 60 * 1000;
    assert.equal((await post(lead)).status, 201);
  } finally {
    server.close();
  }
});
