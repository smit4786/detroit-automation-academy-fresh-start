/**
 * LTD rebuild — marker geometry helpers (Tranche T6).
 *
 * Buffer builders for the surface layers (People Mover, MoGo,
 * Places): cylinders and flat rings as plain { positions, indices,
 * routeAttr } buffers in the gl-adapter's makeMesh shape, merged
 * with geometry.mjs's mergeBuffers. The adapter has no instancing
 * primitive (DV-T4-1's split), so layers merge each marker class
 * into one mesh and rebuild on discrete changes — the vehicle
 * layer's established pattern.
 */

/** One open-ended cylinder (side + top cap) centred on (x, z). */
export function cylinderBuffers({ x, z, yBase, height, rTop, rBase, segments = 12 }) {
  const positions = [];
  const indices = [];
  // Side: bottom ring then top ring.
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    positions.push(x + rBase * ca, yBase, z + rBase * sa);
    positions.push(x + rTop * ca, yBase + height, z + rTop * sa);
  }
  for (let i = 0; i < segments; i++) {
    const k = i * 2;
    indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
  }
  // Top cap: centre + fan.
  const centre = positions.length / 3;
  positions.push(x, yBase + height, z);
  const ringStart = positions.length / 3;
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    positions.push(x + rTop * Math.cos(a), yBase + height, z + rTop * Math.sin(a));
  }
  for (let i = 0; i < segments; i++) {
    indices.push(centre, ringStart + i + 1, ringStart + i);
  }
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    routeAttr: new Float32Array(positions.length / 3),
  };
}

/** One flat ring (annulus) in the XZ plane at height y. */
export function ringBuffers({ x, z, y, rInner, rOuter, segments = 28 }) {
  const positions = [];
  const indices = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    positions.push(x + rInner * ca, y, z + rInner * sa);
    positions.push(x + rOuter * ca, y, z + rOuter * sa);
  }
  for (let i = 0; i < segments; i++) {
    const k = i * 2;
    indices.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
  }
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    routeAttr: new Float32Array(positions.length / 3),
  };
}
