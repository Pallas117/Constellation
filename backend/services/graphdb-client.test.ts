import assert from "node:assert/strict";
import test from "node:test";
import {
  GraphDBClient,
  MAX_TRACE_DEPTH,
  assertCypherIdentifier,
  assertTraceDepth,
} from "./graphdb-client.js";

test("accepts plain Cypher identifiers", () => {
  assert.equal(assertCypherIdentifier("Anomaly", "node label"), "Anomaly");
  assert.equal(assertCypherIdentifier("CAUSED_BY", "relationship type"), "CAUSED_BY");
});

test("rejects identifiers that could change the query", () => {
  for (const bad of ["", "1Label", "A B", "A`) DETACH DELETE (n", "A:B", "A-[r]->", "x".repeat(65)]) {
    assert.throws(() => assertCypherIdentifier(bad, "node label"), /Invalid node label/, bad);
  }
});

test("trace depth must be a small positive integer", () => {
  assert.equal(assertTraceDepth(1), 1);
  assert.equal(assertTraceDepth(MAX_TRACE_DEPTH), MAX_TRACE_DEPTH);
  for (const bad of [0, -1, 2.5, MAX_TRACE_DEPTH + 1, Number.NaN]) {
    assert.throws(() => assertTraceDepth(bad), /Invalid trace depth/, String(bad));
  }
});

test("client refuses unsafe input before opening a session", async () => {
  // neo4j.driver connects lazily, so nothing here touches the network.
  const client = new GraphDBClient("bolt://127.0.0.1:1", "neo4j", "unused");
  try {
    await assert.rejects(
      client.injectFact(
        { id: "a", label: "Test", properties: {} },
        { sourceId: "a", targetId: "b", type: "CAUSES]->(x) DETACH DELETE x //", properties: {} },
        { id: "b", label: "Test", properties: {} },
      ),
      /Invalid relationship type/,
    );
    await assert.rejects(client.traceAnomalyPath("a", 1000), /Invalid trace depth/);
  } finally {
    await client.close();
  }
});
