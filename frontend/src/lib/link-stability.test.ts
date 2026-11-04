import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytesLabel, humanSecs, stabilityScore, stabilityTone, windowLine, type LinkWindow } from './link-stability';

const day: LinkWindow = { observedSec: 86400, availability: 0.843, outages: 24, downSec: 13565, mttrP50Sec: 180, mttrP95Sec: 3780, mtbfSec: 3034 };
const notMeasured: LinkWindow = { observedSec: 0, availability: -1, outages: 0, downSec: 0, mttrP50Sec: -1, mttrP95Sec: -1, mtbfSec: -1 };

test('score is the 7-day availability; not measured stays null', () => {
  assert.equal(stabilityScore({ d1: day, d7: { ...day, availability: 0.827 } }), 83);
  assert.equal(stabilityScore({ d1: notMeasured, d7: notMeasured }), null);
  assert.equal(stabilityScore(undefined), null);
});

test('tone bands: 95 good, 80 fair, below poor', () => {
  assert.equal(stabilityTone(99), 'good');
  assert.equal(stabilityTone(95), 'good');
  assert.equal(stabilityTone(83), 'fair');
  assert.equal(stabilityTone(79), 'poor');
  assert.equal(stabilityTone(null), 'unknown');
});

test('lines match `argo link` wording', () => {
  assert.equal(windowLine(day), '84.3% up · 24 drops · typical outage 3 min (p95 63 min)');
  assert.equal(windowLine({ ...day, outages: 1, mttrP50Sec: -1 }), '84.3% up · 1 drop');
  assert.equal(windowLine(notMeasured), 'not measured yet');
  assert.equal(humanSecs(45), '45 s');
  assert.equal(humanSecs(18000), '5.0 h');
  assert.equal(humanSecs(3 * 86400), '3.0 days');
  assert.equal(bytesLabel(1536), '1.5 KB');
  assert.equal(bytesLabel(3 * (1 << 20)), '3.0 MB');
});
