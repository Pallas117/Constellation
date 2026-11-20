import assert from "node:assert/strict";
import test from "node:test";
import { ageLabel, batteryStatus, deviceRole, postureStatus, seenStatus } from "./mesh-device-status";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const ago = (mins: number) => new Date(NOW - mins * 60_000).toISOString();

test("ages read in minutes, hours and days, and a missing or bad time is a dash", () => {
  assert.equal(ageLabel(ago(0.5), NOW), "just now");
  assert.equal(ageLabel(ago(4), NOW), "4 min ago");
  assert.equal(ageLabel(ago(59.9), NOW), "59 min ago");
  assert.equal(ageLabel(ago(60), NOW), "1 h ago");
  assert.equal(ageLabel(ago(47 * 60), NOW), "47 h ago");
  assert.equal(ageLabel(ago(72 * 60), NOW), "3 d ago");
  assert.equal(ageLabel(ago(-5), NOW), "just now", "a device clock ahead of ours is not a negative age");
  assert.equal(ageLabel(undefined, NOW), "—");
  assert.equal(ageLabel("not a date", NOW), "—");
});

test("a device is reporting, stale, waiting, silent or refused, each with a word", () => {
  const enrolledAt = ago(600);
  assert.deepEqual(seenStatus({ enrolledAt, last: { receivedAt: ago(2) } }, NOW), {
    stage: "reporting",
    status: { tone: "nominal", word: "Reporting" },
    age: "2 min ago",
  });
  const stale = seenStatus({ enrolledAt, last: { receivedAt: ago(200) } }, NOW);
  assert.deepEqual([stale.stage, stale.status.tone, stale.status.word, stale.age], ["stale", "caution", "Stale", "3 h ago"]);
  const waiting = seenStatus({ enrolledAt: ago(1) }, NOW);
  assert.deepEqual([waiting.status.tone, waiting.status.word, waiting.age], ["caution", "Waiting", "—"]);
  assert.equal(seenStatus({ enrolledAt }, NOW).status.word, "No report");
  const refused = seenStatus({ enrolledAt, rejectedAt: ago(1), last: { receivedAt: ago(30) } }, NOW);
  assert.deepEqual([refused.status.tone, refused.status.word], ["risk", "Refused"]);
});

test("the role line names the platform and what the device offers; phones only report status", () => {
  assert.equal(deviceRole({ hosting: "agents", last: { platform: "macos" } }), "macOS · Agents + memory");
  assert.equal(deviceRole({ hosting: "light", last: { platform: "linux" } }), "Linux · Light work");
  assert.equal(deviceRole({ hosting: "no", last: { platform: "ios" } }), "iPhone · Status only");
  assert.equal(deviceRole({ last: { platform: "linux" } }), "Linux · Unknown");
  assert.equal(deviceRole({ last: {} }), "Platform not reported");
  assert.equal(deviceRole({}), "No report yet");
});

test("a battery the report does not carry is a dash, never a level", () => {
  assert.deepEqual(batteryStatus(undefined), { value: "—", status: { tone: "nominal", word: "Not reported" }, detail: [], fraction: null });
  assert.equal(batteryStatus({ level: Number.NaN, charging: false, lowPower: false }).value, "—");
});

test("on battery: critical at 10%, low at 20%, otherwise just on battery", () => {
  const at = (level: number) => batteryStatus({ level, charging: false, lowPower: false, external: false }).status;
  assert.deepEqual(at(10), { tone: "risk", word: "Critical · on battery" });
  assert.deepEqual(at(11), { tone: "caution", word: "Low · on battery" });
  assert.deepEqual(at(20), { tone: "caution", word: "Low · on battery" });
  assert.deepEqual(at(21), { tone: "nominal", word: "On battery" });
  // A phone only says whether it charges: not charging is on battery.
  assert.deepEqual(batteryStatus({ level: 15, charging: false, lowPower: true }), {
    value: "15",
    unit: "%",
    status: { tone: "caution", word: "Low · on battery" },
    detail: ["Low power mode on"],
    fraction: 0.15,
  });
});

test("on mains: charging and plugged in are nominal, even at a low level", () => {
  assert.deepEqual(batteryStatus({ level: 8, charging: true, lowPower: false, external: true }).status, { tone: "nominal", word: "Charging" });
  assert.deepEqual(batteryStatus({ level: 100, charging: false, lowPower: false, external: true }).status, { tone: "nominal", word: "Plugged in" });
  assert.deepEqual(batteryStatus({ level: 60, charging: true, lowPower: false }).status, { tone: "nominal", word: "Charging" });
  const spare = batteryStatus({ level: 72, charging: false, lowPower: false, external: true, power: { mode: "positive", sourceW: 60, loadW: 50.5, marginW: 9.5 } });
  assert.deepEqual(spare.detail, ["9.5 W spare"]);
});

test("a weak charger is a caution with the reason Argo measured", () => {
  const noPd = batteryStatus({ level: 44, charging: true, lowPower: false, external: true, charger: { state: "no-pd", volts: 5, watts: 7.5 } });
  assert.deepEqual(noPd.status, { tone: "caution", word: "Weak charger" });
  assert.deepEqual(noPd.detail, ["Charging slowly", "5 V USB, no fast charging (7.5 W)"]);

  const short = batteryStatus({
    level: 44,
    charging: false,
    lowPower: false,
    external: true,
    power: { mode: "negative", sourceW: 30, loadW: 42, marginW: -12 },
    charger: { state: "pd-low", volts: 15, watts: 30 },
  });
  assert.deepEqual(short.status, { tone: "caution", word: "Weak charger" });
  assert.deepEqual(short.detail, ["Plugged in, not charging", "Charger only 30 W", "Charger 12 W short of the load"]);

  const ok = batteryStatus({ level: 44, charging: true, lowPower: false, external: true, charger: { state: "ok", volts: 20, watts: 65 } });
  assert.deepEqual(ok.status, { tone: "nominal", word: "Charging" });
  // Unplugged since the charger was read: the battery state wins, the old charger line is dropped.
  const unplugged = batteryStatus({ level: 44, charging: false, lowPower: false, external: false, charger: { state: "no-pd", volts: 5, watts: 7.5 } });
  assert.deepEqual([unplugged.status.word, unplugged.detail], ["On battery", []]);
});

test("posture counts passing checks; failing is risk, warnings and unread checks are caution", () => {
  const at = ago(40);
  assert.deepEqual(postureStatus(undefined), { value: "—", status: { tone: "nominal", word: "Not reported" }, detail: [] });
  assert.equal(postureStatus({ at, items: {} }).value, "—");
  assert.deepEqual(postureStatus({ at, items: { disk: "ok", firewall: "ok" } }), {
    value: "2/2",
    unit: "checks ok",
    status: { tone: "nominal", word: "All ok" },
    detail: [],
  });
  assert.deepEqual(postureStatus({ at, items: { disk: "ok", firewall: "warn", updates: "unknown", sharing: "fail" } }), {
    value: "1/4",
    unit: "checks ok",
    status: { tone: "risk", word: "Failing" },
    detail: ["Failing: sharing services", "Warning: firewall", "Not read: automatic updates"],
  });
  assert.equal(postureStatus({ at, items: { disk: "ok", firewall: "warn" } }).status.word, "Warning");
  const unread = postureStatus({ at, items: { disk: "ok", updates: "unknown" } });
  assert.deepEqual([unread.value, unread.status.tone, unread.status.word], ["1/2", "caution", "Not all read"]);
});
