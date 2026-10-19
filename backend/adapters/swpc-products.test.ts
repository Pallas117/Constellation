import assert from "node:assert/strict";
import test from "node:test";
import { fetchSwpcJson } from "./swpc-fetch.js";
import { fetchSwpcProducts, parseNoaaAlerts, parseNoaaScales } from "./swpc-products.js";

const NOW = Date.parse("2026-10-19T09:00:00Z");

// The shape of products/noaa-scales.json on 2026-10-19 ("0" latest observed, "-1" previous day, "1"-"3"
// forecast), with S raised to 2 for the test.
const scales = {
  "0": { DateStamp: "2026-10-19", TimeStamp: "08:45:00", R: { Scale: "0", Text: "none" }, S: { Scale: "2", Text: "moderate" }, G: { Scale: "0", Text: "none" } },
  "1": { DateStamp: "2026-10-19", TimeStamp: "08:45:00", R: { Scale: null }, S: { Scale: null }, G: { Scale: "1" } },
  "-1": { DateStamp: "2026-10-18", TimeStamp: "08:45:00", R: { Scale: "0" }, S: { Scale: "0" }, G: { Scale: "0" } },
};

const alert = (id: string, issued: string, line: string) => ({
  product_id: id,
  issue_datetime: issued,
  message: `Space Weather Message Code: X\r\nSerial Number: 1\r\nIssue Time: …\r\n\r\n${line}\r\nMore text\r\n`,
});

test("NOAA scales: the latest observed entry, as levels with NOAA's own timestamp", () => {
  assert.deepEqual(parseNoaaScales(scales), { R: 0, S: 2, G: 0, observedAt: "2026-10-19T08:45:00.000Z" });
  assert.equal(parseNoaaScales([]), null);
  assert.deepEqual(parseNoaaScales({ "0": { R: { Scale: "x" }, S: {}, G: { Scale: "9" } } }), { R: null, S: null, G: null, observedAt: null });
});

test("NOAA alerts: headline line, newest issue per product, last 24 h only", () => {
  const data = [
    alert("A20F", "2026-10-18 17:24:58.920", "WATCH: Geomagnetic Storm Category G1 Predicted "),
    alert("A20F", "2026-10-17 20:14:23.100", "WATCH: Geomagnetic Storm Category G1 Predicted"),
    alert("K04A", "2026-10-19 07:39:45.267", "ALERT: Geomagnetic K-index of 4"),
    alert("OLD1", "2026-10-17 09:00:00.000", "ALERT: too old"),
    alert("NOHL", "2026-10-19 08:00:00.000", "no recognisable headline"),
  ];
  const parsed = parseNoaaAlerts(data, NOW);
  assert.deepEqual(parsed, [
    { productId: "K04A", issuedAt: "2026-10-19T07:39:45.267Z", headline: "ALERT: Geomagnetic K-index of 4" },
    { productId: "A20F", issuedAt: "2026-10-18T17:24:58.920Z", headline: "WATCH: Geomagnetic Storm Category G1 Predicted" },
  ]);
  assert.equal(parseNoaaAlerts(data, NOW, 24 * 3_600_000, 1).length, 1);
  assert.deepEqual(parseNoaaAlerts({ not: "a list" }, NOW), []);
});

test("SWPC feeds: only HTTPS JSON on services.swpc.noaa.gov is fetched", async () => {
  const real = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    asked.push(String(input instanceof Request ? input.url : input));
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  try {
    for (const url of [
      "http://services.swpc.noaa.gov/products/alerts.json",
      "https://services.swpc.noaa.gov.evil.example/products/alerts.json",
      "https://user:pw@services.swpc.noaa.gov/products/alerts.json",
      "https://services.swpc.noaa.gov/products/alerts.json?token=x",
    ]) {
      await assert.rejects(fetchSwpcJson(url), /Refused a feed outside https:\/\/services\.swpc\.noaa\.gov/);
    }
    assert.deepEqual(asked, [], "refused before any request");
    assert.deepEqual(await fetchSwpcJson("https://services.swpc.noaa.gov/products/alerts.json"), []);
  } finally {
    globalThis.fetch = real;
  }
});

test("SWPC products: unreadable alerts are unknown (null), not an empty list", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    return url.endsWith("noaa-scales.json") ? new Response(JSON.stringify(scales)) : new Response("x", { status: 503 });
  }) as typeof fetch;
  try {
    const products = await fetchSwpcProducts(NOW);
    assert.equal(products?.scales?.S, 2);
    assert.equal(products?.alerts, null);
    globalThis.fetch = (async () => new Response("x", { status: 503 })) as typeof fetch;
    assert.equal(await fetchSwpcProducts(NOW), null);
  } finally {
    globalThis.fetch = real;
  }
});
