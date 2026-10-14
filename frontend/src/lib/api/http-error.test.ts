import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeHttpFailure, HttpFailure } from "./http-error.ts";

describe("describeHttpFailure", () => {
  it("explains the statuses people actually hit", () => {
    assert.equal(describeHttpFailure("Couldn't load the SWAP plan", 401), "Couldn't load the SWAP plan: your session has ended. Sign in again.");
    assert.match(describeHttpFailure("x", 403), /role/);
    assert.match(describeHttpFailure("x", 404), /not available/);
    assert.match(describeHttpFailure("x", 429), /too many/);
    assert.match(describeHttpFailure("x", 503), /server had a problem/);
    assert.equal(describeHttpFailure("x", 418), "x: request failed (HTTP 418).");
  });

  it("keeps the status on the error for callers that branch on it", () => {
    const e = new HttpFailure("Couldn't load your devices", 404);
    assert.equal(e.status, 404);
    assert.ok(e instanceof Error);
    assert.match(e.message, /^Couldn't load your devices: /);
  });
});
