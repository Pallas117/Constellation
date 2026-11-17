import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Router } from "express";
import { TPM_SPECS } from "../lib/tpm.js";
import { computeCanonicalPoint } from "../physics/mhd-nowcast.js";
import { accessFor } from "../rbac.js";
import { EnvironmentHistory } from "../trust/environment.js";
import { buildTrustRecord, MAX_OUTPUT_BYTES, TRUST_RECORD_SCHEMA } from "../trust/record.js";
import { PLANS } from "./plans.js";
import { createDataApiRouter, createOrgRouter, MAX_TRUST_BATCH, type DataProvider } from "./routers.js";
import { CommerceStore } from "./store.js";

// GAU-194, GAU-68: docs/api/openapi.json must describe exactly the pilot routes: everything the
// /api/v1 data router and the /api/orgs router serve, plus the app-level routes listed below.
const specPath = fileURLToPath(new URL("../../docs/api/openapi.json", import.meta.url));
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const spec: Json = JSON.parse(readFileSync(specPath, "utf8"));
const METHODS = ["get", "post", "put", "patch", "delete"] as const;

/** Pilot routes registered on the app itself (backend/server.ts) rather than on a router. */
const APP_PILOT_ROUTES = ["get /health"];

/** "get /api/orgs/{orgId}/keys" for each route of a router mounted at `prefix` (Express :params as OpenAPI {params}). */
function routesOf(router: Router, prefix: string): string[] {
  const routes: string[] = [];
  for (const layer of router.stack as Array<{ route?: { path: string; methods: Record<string, boolean> } }>) {
    if (!layer.route) continue;
    const path = prefix + layer.route.path.replace(/:(\w+)/g, "{$1}");
    for (const [method, on] of Object.entries(layer.route.methods)) if (on) routes.push(`${method} ${path}`);
  }
  return routes;
}

function pilotRoutes(): string[] {
  const data: DataProvider = { latest: async () => null, history: async () => ({ source: "", points: [] }), sources: () => [] };
  return [
    ...routesOf(createDataApiRouter({} as CommerceStore, data), "/api/v1"),
    ...routesOf(createOrgRouter({} as CommerceStore), "/api/orgs"),
    ...APP_PILOT_ROUTES,
  ].sort();
}

function operations(): Array<{ method: string; path: string; op: Json }> {
  const ops: Array<{ method: string; path: string; op: Json }> = [];
  for (const [path, item] of Object.entries(spec.paths as Json)) {
    for (const method of METHODS) if (item[method]) ops.push({ method, path, op: item[method] });
  }
  return ops;
}

function specRoutes(): string[] {
  return operations()
    .map(({ method, path }) => `${method} ${path}`)
    .sort();
}

function resolve(ref: string): unknown {
  assert.ok(ref.startsWith("#/"), `only local refs are used: ${ref}`);
  return ref.slice(2).split("/").reduce<unknown>((node, key) => (node as Json | undefined)?.[key], spec);
}

function resolveResponse(response: Json | undefined): Json {
  assert.ok(response, "the response is documented");
  return (response.$ref ? resolve(response.$ref) : response) as Json;
}

const keys = (o: object) => Object.keys(o).sort();

test("openapi: every pilot route is documented, and nothing undocumented is", () => {
  assert.equal(spec.openapi, "3.1.0");
  assert.deepEqual(specRoutes(), pilotRoutes());
});

test("openapi: every $ref resolves", () => {
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref") assert.ok(resolve(value as string) !== undefined, `unresolved ${value}`);
      else walk(value);
    }
  };
  walk(spec);
});

test("openapi: each operation states the access the code enforces, and its errors", () => {
  assert.deepEqual(spec.security, [{ apiKey: [] }], "the API key is the default requirement");
  assert.equal(spec.components.securitySchemes.apiKey.scheme, "bearer");
  for (const { method, path, op } of operations()) {
    const name = `${method} ${path}`;
    const access = op["x-gauss-access"];
    assert.ok(Object.keys(op.responses).some((s) => /^2\d\d$/.test(s)), `${name} documents its success response`);
    if (path.startsWith("/api/v1/")) {
      // Organisation keys, mounted before session auth, so outside the RBAC table.
      assert.equal(access, "api-key", name);
      assert.equal(op.security, undefined, `${name} must not override the API-key requirement`);
      assert.equal(accessFor(method, path.slice("/api".length)), undefined, `${name} is not a session route in backend/rbac.ts`);
      for (const status of ["200", "400", "401", "403", "429"]) assert.ok(op.responses[status], `${name} documents ${status}`);
    } else if (access === "public") {
      assert.deepEqual(op.security, [], `${name} needs no credentials`);
      assert.ok(String(op["x-public-reason"] ?? "").length > 20, `${name} says why it is public`);
      if (path.startsWith("/api/")) assert.equal(accessFor(method, path.slice("/api".length)), "public", `${name} is public in backend/rbac.ts`);
    } else {
      // Session routes: the role is the one backend/rbac.ts enforces; CyberTiger and sign-in errors apply.
      assert.ok(path.startsWith("/api/"), `${name}: session routes live under /api`);
      assert.deepEqual(op.security, [{ session: [] }], name);
      assert.equal(access, accessFor(method, path.slice("/api".length)), `${name} states the role in backend/rbac.ts`);
      for (const status of ["400", "401", "429"]) assert.ok(op.responses[status], `${name} documents ${status}`);
    }
  }
});

test("openapi: routes that take a body document 400 and 413, and no route blames the server for a bad body (GAU-231)", () => {
  for (const { method, path, op } of operations()) {
    const name = `${method} ${path}`;
    if (op.requestBody) {
      assert.match(String(resolveResponse(op.responses["400"]).description), /not valid JSON/, `${name}: 400 covers invalid JSON`);
      assert.match(String(resolveResponse(op.responses["413"]).description), /over 2 MB/, `${name}: 413 covers an oversized body`);
    }
    const serverError = op.responses["500"] ? String(resolveResponse(op.responses["500"]).description) : "";
    assert.doesNotMatch(serverError, /valid JSON|2 MB/, `${name}: a bad body is not a 500`);
  }
  assert.match(spec.info.description, /not valid JSON is answered 400/);
});

test("openapi: trust-record limits and shape match the code", () => {
  const schemas = spec.components.schemas;
  assert.equal(schemas.TrustRecordBatchRequest.properties.inferences.maxItems, MAX_TRUST_BATCH);
  assert.equal(schemas.TrustRecord.properties.schema.const, TRUST_RECORD_SCHEMA);
  assert.match(schemas.TrustRecordRequest.properties.output.description, new RegExp(`\\b${MAX_OUTPUT_BYTES} bytes`));

  const record = buildTrustRecord(
    { time: "2026-01-01T00:00:00.000Z", spacecraftId: "sc-1", modelId: "m-1" },
    new EnvironmentHistory([], "empty"),
    { nowMs: Date.parse("2026-01-01T01:00:00.000Z") },
  );
  assert.deepEqual([...schemas.TrustRecord.required].sort(), keys(record));
  const props = schemas.TrustRecord.properties;
  assert.deepEqual([...props.inference.required].sort(), keys(record.inference));
  assert.deepEqual([...props.environment.required].sort(), keys(record.environment));
  assert.deepEqual([...props.orbit.required].sort(), keys(record.orbit));
  assert.deepEqual([...schemas.Field.required].sort(), keys(record.upsetRisk));
  assert.deepEqual([...props.verdict.properties.policy.required].sort(), keys(record.verdict.policy));
  assert.match(record.recordId, new RegExp(props.recordId.pattern));
  assert.match(record.hash, new RegExp(props.hash.pattern));
});

test("openapi: the space-weather point schema covers what the nowcast emits", () => {
  const { point } = computeCanonicalPoint(
    {
      timestamp: "2026-01-01T00:00:05.000Z",
      observedAt: "2026-01-01T00:00:00.000Z",
      source: "fusion",
      density: 5,
      velocityGse: { x: -400, y: 0, z: 0 },
      magneticFieldGse: { x: 1, y: 2, z: -3 },
      kp: 3,
    },
    [],
    null,
  );
  const schema = spec.components.schemas.SpaceWeatherPoint;
  const covers = (s: Json, value: object, at: string) => {
    for (const key of s.required ?? []) assert.ok(key in value, `${at}.${key} is required in the spec but not emitted`);
    for (const key of Object.keys(value)) assert.ok(key in s.properties, `${at}.${key} is emitted but not documented`);
  };
  covers(schema, point, "point");
  const nested = ["velocity", "magneticField", "electricField", "solarWind", "indices", "coupling", "propagation", "alerts", "quality", "uncertainty"] as const;
  for (const key of nested) covers(schema.properties[key], point[key], key);
});

test("openapi: organisation, key and usage schemas match the store and plans", () => {
  const schemas = spec.components.schemas;
  assert.deepEqual([...schemas.Plan.enum].sort(), keys(PLANS));
  assert.deepEqual([...schemas.PlanLimits.required].sort(), keys(PLANS.pilot));
  assert.deepEqual(schemas.PlanLimits.examples[0], PLANS.pilot, "the example is the pilot plan");

  const store = new CommerceStore(":memory:");
  const org = store.createOrg("Spec Org", "pilot");
  const { key, info } = store.createKey(org.id, "ci", "user-1");
  store.recordUse(info.id, "GET /api/v1/data/sources/status", new Date("2026-01-01T00:00:00.000Z"));
  const [row] = store.usage(org.id, "2026-01-01", "2026-01-01");
  assert.deepEqual([...schemas.Org.required].sort(), keys(org));
  assert.deepEqual([...schemas.ApiKeyInfo.required].sort(), keys(info));
  assert.deepEqual([...schemas.ApiKeyInfo.required].sort(), keys(store.listKeys(org.id)[0]));
  assert.deepEqual([...schemas.UsageRow.required].sort(), keys(row));
  assert.match(key, new RegExp(schemas.CreatedKey.properties.key.pattern));
  assert.ok(store.resolveKey(key), "a key in the documented format resolves");
  assert.match(info.prefix, new RegExp(schemas.ApiKeyInfo.properties.prefix.pattern));
});

test("openapi: the health summary lists the measures the backend reports", () => {
  const red = spec.components.schemas.Health.properties.tpm.properties.red.items.enum;
  assert.deepEqual([...red].sort(), TPM_SPECS.map((t) => t.id).sort());
});
