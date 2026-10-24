import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { EnvironmentHistory } from "../trust/environment.js";
import { PROFILE_LIBRARY_VERSION, PROFILES } from "../trust/profiles.js";
import { buildTrustRecord, MAX_OUTPUT_BYTES, TRUST_RECORD_SCHEMA } from "../trust/record.js";
import { upsetRiskField } from "../trust/upset.js";
import { createDataApiRouter, MAX_TRUST_BATCH, type DataProvider } from "./routers.js";
import type { CommerceStore } from "./store.js";

// GAU-194: docs/api/openapi.json must describe exactly the routes the /api/v1 router serves.
const specPath = fileURLToPath(new URL("../../docs/api/openapi.json", import.meta.url));
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const spec: Json = JSON.parse(readFileSync(specPath, "utf8"));
const METHODS = ["get", "post", "put", "patch", "delete"] as const;

function routerRoutes(): string[] {
  const data: DataProvider = { latest: async () => null, history: async () => ({ source: "", points: [] }), sources: () => [] };
  const router = createDataApiRouter({} as CommerceStore, data);
  const routes: string[] = [];
  for (const layer of router.stack as Array<{ route?: { path: string; methods: Record<string, boolean> } }>) {
    if (!layer.route) continue;
    for (const [method, on] of Object.entries(layer.route.methods)) if (on) routes.push(`${method} ${layer.route.path}`);
  }
  return routes.sort();
}

function specRoutes(): string[] {
  const routes: string[] = [];
  for (const [path, item] of Object.entries(spec.paths as Json)) {
    for (const method of METHODS) if (item[method]) routes.push(`${method} ${path}`);
  }
  return routes.sort();
}

function resolve(ref: string): unknown {
  assert.ok(ref.startsWith("#/"), `only local refs are used: ${ref}`);
  return ref.slice(2).split("/").reduce<unknown>((node, key) => (node as Json | undefined)?.[key], spec);
}

test("openapi: every /api/v1 route is documented, and nothing undocumented is", () => {
  assert.equal(spec.openapi, "3.1.0");
  assert.deepEqual(specRoutes(), routerRoutes());
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

test("openapi: every operation needs the API key and documents its auth, plan and limit errors", () => {
  assert.deepEqual(spec.security, [{ apiKey: [] }]);
  assert.equal(spec.components.securitySchemes.apiKey.scheme, "bearer");
  for (const [path, item] of Object.entries(spec.paths as Json)) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      assert.equal(op.security, undefined, `${method} ${path} must not override the API-key requirement`);
      for (const status of ["200", "401", "403", "429"]) assert.ok(op.responses[status], `${method} ${path} documents ${status}`);
    }
  }
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
  const keys = (o: object) => Object.keys(o).sort();
  assert.deepEqual([...schemas.TrustRecord.required].sort(), keys(record));
  const props = schemas.TrustRecord.properties;
  assert.deepEqual([...props.inference.required].sort(), keys(record.inference));
  assert.deepEqual([...props.environment.required].sort(), keys(record.environment));
  assert.deepEqual([...props.orbit.required].sort(), keys(record.orbit));
  assert.deepEqual([...schemas.Field.required].sort(), keys(record.upsetRisk));
  const quiet = { level: 0, why: "", observedAt: record.inference.time, ageSeconds: 0 };
  const band = upsetRiskField(PROFILES[0].id, { saaTier: "outside", saaWhy: "", s: quiet, g: quiet, lShell: 1.2 }, null);
  assert.deepEqual([...schemas.UpsetRisk.required].sort(), keys(band.value!));
  const profileIds: string = schemas.TrustRecordRequest.properties.processorProfileId.description;
  assert.ok(profileIds.includes(PROFILE_LIBRARY_VERSION), "the spec names the profile library version");
  for (const p of PROFILES) assert.ok(profileIds.includes(p.id), `the spec lists profile ${p.id}`);
  assert.deepEqual([...props.verdict.properties.policy.required].sort(), keys(record.verdict.policy));
  assert.match(record.recordId, new RegExp(props.recordId.pattern));
  assert.match(record.hash, new RegExp(props.hash.pattern));
});
