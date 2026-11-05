import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  beltParticles,
  beltShells,
  ELECTRON_BELT,
  ELECTRON_PARTICLES,
  footLatitude,
  PARTICLE_PERIOD_S,
  particlePosition,
  PROTON_BELT,
  PROTON_PARTICLES,
} from './belts.ts';

const LON = 48;
const LAT = 24;

function vertices(mesh: ReturnType<typeof beltShells>) {
  const out: { x: number; y: number; z: number; w: number }[] = [];
  for (let i = 0; i < mesh.weights.length; i++) {
    out.push({ x: mesh.positions[i * 3], y: mesh.positions[i * 3 + 1], z: mesh.positions[i * 3 + 2], w: mesh.weights[i] });
  }
  return out;
}

describe('belt shells', () => {
  it('puts the field-line foot of L = 4 at 60° magnetic latitude', () => {
    assert.ok(Math.abs((footLatitude(4) * 180) / Math.PI - 60) < 1e-9);
  });

  for (const [name, spec] of [['proton', PROTON_BELT], ['electron', ELECTRON_BELT]] as const) {
    it(`keeps every ${name} vertex on a dipole shell inside its L range and above the atmosphere`, () => {
      for (const p of vertices(beltShells(spec, LON, LAT))) {
        const r = Math.hypot(p.x, p.y, p.z);
        const cosL = Math.hypot(p.x, p.z) / r;
        const L = r / (cosL * cosL);
        assert.ok(L >= spec.lMin - 1e-6 && L <= spec.lMax + 1e-6, `L ${L}`);
        assert.ok(r >= 1.02 - 1e-6, `r ${r}`);
        assert.ok(p.w >= 0 && p.w <= 1 && Number.isFinite(p.w));
      }
    });

    it(`peaks the ${name} density at the equator of the shell nearest L ${spec.lPeak}`, () => {
      const pts = vertices(beltShells(spec, LON, LAT));
      const top = pts.reduce((a, b) => (b.w > a.w ? b : a));
      const r = Math.hypot(top.x, top.y, top.z);
      assert.ok(Math.abs(top.y) < 0.05 * r, 'on the magnetic equator');
      const step = (spec.lMax - spec.lMin) / spec.shells;
      assert.ok(Math.abs(r - spec.lPeak) <= step / 2 + 1e-6, `peak at r ${r}`);
    });
  }

  it('fades to nothing where the shells reach the atmosphere', () => {
    const mesh = beltShells(ELECTRON_BELT, LON, LAT);
    // First latitude row of the first shell is its southern foot.
    for (let j = 0; j <= LON; j++) assert.equal(mesh.weights[j], 0);
  });

  it('squeezes the dayside and stretches the nightside under compression', () => {
    const extent = (c: number) => {
      const pts = vertices(beltShells(ELECTRON_BELT, LON, LAT, c));
      return { day: Math.max(...pts.map((p) => p.x)), night: -Math.min(...pts.map((p) => p.x)) };
    };
    const nominal = extent(1);
    const squeezed = extent(0.6);
    assert.ok(Math.abs(nominal.day - nominal.night) < 1e-6, 'symmetric at nominal pressure');
    assert.ok(squeezed.day < nominal.day, 'dayside moves in');
    assert.ok(squeezed.night > nominal.night, 'nightside moves out');
  });

  describe('trapped particles', () => {
    const cases = [
      ['proton', PROTON_BELT, PROTON_PARTICLES],
      ['electron', ELECTRON_BELT, ELECTRON_PARTICLES],
    ] as const;
    for (const [name, spec, motion] of cases) {
      it(`keeps ${name}s in their belt and out of the atmosphere for a whole drift orbit`, () => {
        const p = beltParticles(spec, motion, 400, 7);
        for (let i = 0; i < p.count; i++) {
          assert.ok(p.l[i] >= spec.lMin && p.l[i] <= spec.lMax);
          assert.ok(p.mirror[i] > 0 && p.mirror[i] < footLatitude(p.l[i], 1.02));
          for (let t = 0; t < motion.driftSeconds; t += 1.7) {
            const [x, y, z] = particlePosition(p, i, t, 0.6);
            assert.ok(Math.hypot(x, y, z) >= 1.02, `${name} ${i} at t ${t}`);
          }
        }
      });
    }

    it('drifts protons west and electrons east', () => {
      const lonAt = (p: ReturnType<typeof beltParticles>, t: number) => {
        const [x, , z] = particlePosition(p, 0, t);
        return Math.atan2(-z, x);
      };
      const protons = beltParticles(PROTON_BELT, PROTON_PARTICLES, 1, 1);
      const electrons = beltParticles(ELECTRON_BELT, ELECTRON_PARTICLES, 1, 1);
      assert.ok(Math.sin(lonAt(protons, 5) - lonAt(protons, 0)) < 0, 'protons westward');
      assert.ok(Math.sin(lonAt(electrons, 5) - lonAt(electrons, 0)) > 0, 'electrons eastward');
    });

    it('repeats exactly after PARTICLE_PERIOD_S, so the shader clock can wrap', () => {
      const p = beltParticles(ELECTRON_BELT, ELECTRON_PARTICLES, 50, 5);
      for (let i = 0; i < p.count; i++) {
        const a = particlePosition(p, i, 12.3);
        const b = particlePosition(p, i, 12.3 + PARTICLE_PERIOD_S);
        // Rates are stored as float32 (as on the GPU): the jump is well under a pixel.
        for (let k = 0; k < 3; k++) assert.ok(Math.abs(a[k] - b[k]) < 1e-3);
      }
    });

    it('is the same on every load', () => {
      const a = beltParticles(ELECTRON_BELT, ELECTRON_PARTICLES, 50, 3);
      const b = beltParticles(ELECTRON_BELT, ELECTRON_PARTICLES, 50, 3);
      assert.deepEqual([...a.l], [...b.l]);
      assert.deepEqual([...a.mirror], [...b.mirror]);
    });
  });
});
