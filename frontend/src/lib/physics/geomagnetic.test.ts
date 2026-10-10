import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  auroralOvalBounds,
  bowShockStandoff,
  computeMagnetosphere,
  createFieldModel,
  dipoleTiltRad,
  driversFromVisualParams,
  gsmToScene,
  magneticFootpoint,
  shueMagnetopause,
  traceFieldLine,
} from './geomagnetic.ts';

const DEG = 180 / Math.PI;
const JUNE_SOLSTICE = Date.UTC(2026, 5, 21, 17, 0); // pole near local noon -> max tilt
const DEC_SOLSTICE = Date.UTC(2026, 11, 21, 5, 0);
const quiet = { bz: 2, by: 0, pdyn: 2, kp: 1 };
const storm = { bz: -20, by: 0, pdyn: 15, kp: 8 };

describe('dipole tilt', () => {
  it('is positive in northern summer and negative in winter', () => {
    const jun = dipoleTiltRad(JUNE_SOLSTICE) * DEG;
    const dec = dipoleTiltRad(DEC_SOLSTICE) * DEG;
    assert.ok(jun > 25 && jun < 36, `June tilt ${jun}`);
    assert.ok(dec < -25 && dec > -36, `December tilt ${dec}`);
  });

  it('stays within ±(23.4 + 9.2)° over a day', () => {
    for (let h = 0; h < 24; h++) {
      const t = Math.abs(dipoleTiltRad(Date.UTC(2026, 2, 20, h)) * DEG);
      assert.ok(t < 33, `hour ${h}: ${t}`);
    }
  });
});

describe('Shue 1998 magnetopause', () => {
  it('gives ~10 Re for nominal solar wind', () => {
    const { r0, alpha } = shueMagnetopause(0, 2);
    assert.ok(Math.abs(r0 - 10.25) < 0.1, `r0 ${r0}`);
    assert.ok(Math.abs(alpha - 0.59) < 0.02, `alpha ${alpha}`);
  });

  it('compresses under high pressure and southward Bz', () => {
    const { r0 } = shueMagnetopause(-20, 15);
    assert.ok(r0 < 7.5 && r0 > 5, `storm r0 ${r0}`);
  });

  it('places the bow shock ~30% beyond the magnetopause', () => {
    const ratio = bowShockStandoff(10) / 10;
    assert.ok(ratio > 1.25 && ratio < 1.35, `ratio ${ratio}`);
  });
});

describe('field model', () => {
  it('matches the dipole on the surface (equator ~B0, pole ~2·B0)', () => {
    const m = createFieldModel({ bz: 0, by: 0, pdyn: 2, kp: 0 }, Date.UTC(2026, 2, 20, 12));
    const eq = magneticFootpoint(m.tilt, 0, 0, 1);
    const pole = magneticFootpoint(m.tilt, 90, 0, 1);
    const mag = (v: number[]) => Math.hypot(v[0], v[1], v[2]);
    assert.ok(Math.abs(mag(m.field(eq)) - 29800) < 50);
    assert.ok(Math.abs(mag(m.field(pole)) - 59600) < 100);
  });

  it('closes low-latitude lines and lands them in the opposite hemisphere', () => {
    const m = createFieldModel(quiet, JUNE_SOLSTICE);
    const t = traceFieldLine(m, magneticFootpoint(m.tilt, 55, 0), -1);
    assert.equal(t.topology, 'closed');
    const end = t.points[t.points.length - 1];
    assert.ok(Math.abs(Math.hypot(...end) - 1) < 1e-9);
    // Dipole L = 1/cos²(55°) ≈ 3.04; the apex should be close to that.
    const apex = Math.max(...t.points.map((p) => Math.hypot(...p)));
    assert.ok(apex > 2.7 && apex < 3.4, `apex ${apex}`);
  });

  it('opens polar-cap lines', () => {
    const m = createFieldModel(storm, JUNE_SOLSTICE);
    const t = traceFieldLine(m, magneticFootpoint(m.tilt, 82, Math.PI), -1);
    assert.equal(t.topology, 'open');
  });
});

describe('computeMagnetosphere', () => {
  it('opens more flux during a storm than in quiet conditions', () => {
    const q = computeMagnetosphere(quiet, JUNE_SOLSTICE);
    const s = computeMagnetosphere(storm, JUNE_SOLSTICE);
    assert.ok(s.openFraction > q.openFraction, `${s.openFraction} vs ${q.openFraction}`);
    assert.ok(s.r0 < q.r0);
    assert.ok(s.lines.every((l) => l.points.length <= 160 && l.points.length === l.strength.length));
    assert.ok(s.lines.some((l) => l.topology === 'closed'));
    assert.ok(s.lines.some((l) => l.topology === 'open'));
  });

  it('keeps every traced point finite', () => {
    const s = computeMagnetosphere({ bz: -8, by: 6, pdyn: 4, kp: 5 }, DEC_SOLSTICE);
    for (const l of s.lines) for (const p of l.points) assert.ok(p.every(Number.isFinite));
  });

  it('expands the auroral oval equatorward with Kp', () => {
    assert.ok(auroralOvalBounds(8).equatorward < auroralOvalBounds(1).equatorward);
    assert.ok(auroralOvalBounds(9).equatorward >= 45);
  });
});

describe('helpers', () => {
  it('maps GSM to a right-handed scene frame', () => {
    assert.deepEqual(gsmToScene([1, 2, 3]), [1, 3, -2]);
  });

  it('inverts the legacy visual params', () => {
    const d = driversFromVisualParams(0.8, 0.5);
    assert.equal(d.bz, -7.5);
    assert.ok(Math.abs(d.pdyn - 5) < 1e-9);
  });
});
