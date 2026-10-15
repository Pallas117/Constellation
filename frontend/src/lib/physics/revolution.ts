/**
 * Surfaces of revolution about the Sun-Earth (x) axis: the magnetopause and the
 * bow shock. Positions and normals are refilled in place as the shape morphs.
 */
import * as THREE from 'three';

/** Index/uv topology for a surface of revolution; positions are filled separately. */
export function revolutionTopology(thetaSteps: number, phiSteps: number) {
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= thetaSteps; i++) {
    for (let j = 0; j <= phiSteps; j++) {
      uvs.push(j / phiSteps, i / thetaSteps);
      if (i < thetaSteps && j < phiSteps) {
        const a = i * (phiSteps + 1) + j;
        const b = a + phiSteps + 1;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((thetaSteps + 1) * (phiSteps + 1) * 3), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array((thetaSteps + 1) * (phiSteps + 1) * 3), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  return g;
}

/** Surface of revolution about the Sun–Earth line from r(θ), cut at x = -tail, written in place. */
export function fillRevolution(g: THREE.BufferGeometry, radius: (theta: number) => number, tail: number, thetaSteps: number, phiSteps: number) {
  // Find the θ at which the surface reaches x = -tail.
  let thetaMax = Math.PI / 2;
  for (let th = Math.PI / 2; th < Math.PI * 0.98; th += 0.005) {
    thetaMax = th;
    if (radius(th) * Math.cos(th) <= -tail) break;
  }
  const attr = g.attributes.position as THREE.BufferAttribute;
  const nAttr = g.attributes.normal as THREE.BufferAttribute;
  const pos = attr.array as Float32Array;
  const nor = nAttr.array as Float32Array;
  let o = 0;
  for (let i = 0; i <= thetaSteps; i++) {
    const th = (i / thetaSteps) * thetaMax;
    const r = radius(th);
    const dr = (radius(th + 1e-3) - radius(th - 1e-3)) / 2e-3;
    const ct = Math.cos(th);
    const st = Math.sin(th);
    // Analytic normal of P(th, ph) = (r cos th, r sin th sin ph, r sin th cos ph):
    // dP/dth x dP/dph is parallel to (-a, b sin ph, b cos ph). computeVertexNormals
    // over every triangle cost ~2 ms a frame while the boundaries morph.
    const a = dr * st + r * ct;
    const b = dr * ct - r * st;
    const len = Math.hypot(a, b) || 1;
    for (let j = 0; j <= phiSteps; j++) {
      const ph = (j / phiSteps) * Math.PI * 2;
      const sp = Math.sin(ph);
      const cp = Math.cos(ph);
      nor[o] = -a / len;
      pos[o++] = r * ct;
      nor[o] = (b * sp) / len;
      pos[o++] = r * st * sp;
      nor[o] = (b * cp) / len;
      pos[o++] = r * st * cp;
    }
  }
  attr.needsUpdate = true;
  nAttr.needsUpdate = true;
  g.computeBoundingSphere();
}
