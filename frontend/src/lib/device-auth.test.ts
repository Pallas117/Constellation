import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { apiBaseFor, resolveApiBase } from "./api/base-url.ts";
import { HttpFailure } from "./api/http-error.ts";
import { postDeviceRegistration } from "./device-auth.ts";

const FP = { hash: "ab12", signals: { cpu_cores: 8, tz: "UTC" } };

function stubFetch(status: number, body: unknown) {
  return mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  );
}

describe("postDeviceRegistration", () => {
  afterEach(() => mock.restoreAll());

  it("posts to the page's own origin when the API is same-origin", async () => {
    const fetchMock = stubFetch(201, { ok: true, device: { id: "d1" } });
    const result = await postDeviceRegistration(apiBaseFor(resolveApiBase("same-origin")), {}, FP);
    assert.equal(fetchMock.mock.calls[0].arguments[0], "/api/device/register");
    assert.deepEqual(result, { ok: true, device: { id: "d1" } });
  });

  it("posts to the API origin when it is elsewhere (npm run dev: UI on :8080, API on :3001)", async () => {
    const fetchMock = stubFetch(201, { ok: true, device: { id: "d1" } });
    await postDeviceRegistration(apiBaseFor(resolveApiBase(undefined)), { Authorization: "Bearer t" }, FP, "laptop");
    const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
    assert.equal(url, "http://127.0.0.1:3001/api/device/register");
    assert.equal(init.method, "POST");
    assert.deepEqual(init.headers, { "Content-Type": "application/json", Authorization: "Bearer t" });
    // The fingerprint travels in the body only, never the URL.
    assert.deepEqual(JSON.parse(String(init.body)), {
      name: "laptop",
      fingerprintHash: "ab12",
      fingerprintSignals: { cpu_cores: 8, tz: "UTC" },
    });
    assert.ok(!url.includes("?"));
  });

  it("throws a readable HttpFailure on a non-ok response instead of parsing it", async () => {
    stubFetch(401, { ok: false, error: "Authentication required" });
    await assert.rejects(postDeviceRegistration("", {}, FP), (err: unknown) => {
      assert.ok(err instanceof HttpFailure);
      assert.equal(err.status, 401);
      assert.equal(err.message, "Couldn't register this device: your session has ended. Sign in again.");
      return true;
    });
  });
});
