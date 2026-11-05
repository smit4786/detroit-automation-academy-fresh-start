/**
 * LTD rebuild — the GL adapter interface (Tranche T3).
 *
 * The renderer (M5) never touches a 3D library directly. It speaks
 * to an adapter: a small set of scene operations below. Two
 * implementations exist — `gl-three.mjs` (the pinned vendor build,
 * browser) and the recording adapter in this file (tests, tooling).
 * Swapping the library means writing one new adapter; no renderer,
 * camera, label, or picking code changes. That is the point of the
 * seam: the vendor exception's shipped form is the owner's ruling
 * to give, and the ruling must not be load-bearing for the code.
 *
 * Adapter contract (all coordinates are scene metres, x east,
 * z south, y up; colors are 0xRRGGBB integers):
 *
 *   createScene() -> scene
 *   addToScene(scene, node)
 *   makeLineSegments(flatQuads, { color, y, opacity, transparent }) -> node
 *       flatQuads: Float32Array [x1,z1,x2,z2, ...] independent segments
 *   makeMesh({ positions, indices, routeAttr }, { color, opacity,
 *       transparent, blending, routeVisibility }) -> node
 *       routeVisibility: true marks the mesh as route-attributed —
 *       the adapter binds the renderer's RouteVisibilityTable.
 *   makeFilledShapes([{ rings, y }], { color }) -> node
 *       One merged mesh of filled polygons; rings = [outer,
 *       ...holes] of [x, z] points. Triangulation is the adapter's
 *       job — the vendor build's triangulator is proven on real
 *       water polygons; a hand-rolled ear-clipper is not.
 *   makePlane({ width, depth, cx, cz, y, color }) -> node
 *   makeSprite() -> sprite (text label surface)
 *   setSpriteTexture(sprite, textureToken)
 *   setNodeVisible(node, bool)
 *   setNodeOpacity(node, alpha)
 *   setNodePosition(node, [x, y, z])
 *   makeCamera({ fov, near, far }) -> camera
 *   setCameraPose(camera, position[3], target[3])
 *   getCameraPose(camera) -> { position, target }
 *   makeRenderer(canvas) -> renderer   (browser adapters only)
 *   render(renderer, scene, camera)
 *   setPixelRatio(renderer, ratio)
 *   resize(renderer, width, height)
 *   project(camera, viewport, point[3]) -> { x, y, behind }
 *   unprojectRay(camera, viewport, px, py) -> { origin, dir }
 */

export const ADAPTER_METHODS = [
  "createScene", "addToScene", "makeLineSegments", "makeMesh", "makeFilledShapes", "makePlane",
  "makeSprite", "setSpriteTexture", "setNodeVisible", "setNodeOpacity", "setNodePosition",
  "makeCamera", "setCameraPose", "getCameraPose", "render",
  "setPixelRatio", "resize", "project", "unprojectRay",
];

export function assertAdapter(gl) {
  for (const m of ADAPTER_METHODS) {
    if (typeof gl[m] !== "function") throw new Error(`gl adapter: missing ${m}`);
  }
  return gl;
}

/**
 * Per-route visibility/alpha table bound into route-attributed
 * materials (P-04: uRouteVis over ROUTE_MAX slots). The renderer
 * owns the table; adapters read it when building materials and the
 * renderer mutates entries through it.
 */
export class RouteVisibilityTable {
  constructor(max = 128) {
    this.max = max;
    this.alpha = new Float32Array(max).fill(1);
    this.visible = new Uint8Array(max).fill(1);
  }
  set(ordinal, { visible, alpha } = {}) {
    if (visible !== undefined) this.visible[ordinal] = visible ? 1 : 0;
    if (alpha !== undefined) this.alpha[ordinal] = alpha;
  }
  effective(ordinal) {
    return this.visible[ordinal] ? this.alpha[ordinal] : 0;
  }
}

/** An adapter that records every call — the test double. */
export function createRecordingAdapter() {
  const calls = [];
  let nextId = 1;
  const node = (kind, props) => {
    const n = { id: nextId++, kind, props, visible: true, opacity: props?.opacity ?? 1 };
    calls.push({ op: kind, node: n });
    return n;
  };
  const gl = {
    calls,
    createScene() { calls.push({ op: "createScene" }); return { id: nextId++, kind: "scene", children: [] }; },
    addToScene(scene, n) { scene.children.push(n); calls.push({ op: "addToScene", node: n }); },
    makeLineSegments(flatQuads, opts) { return node("lineSegments", { flatQuads, ...opts }); },
    makeMesh(buffers, opts) { return node("mesh", { buffers, ...opts }); },
    makeFilledShapes(shapes, opts) { return node("filledShapes", { shapes, ...opts }); },
    makePlane(opts) { return node("plane", opts); },
    makeSprite() { return node("sprite", {}); },
    setSpriteTexture(sprite, token) { sprite.texture = token; calls.push({ op: "setSpriteTexture", node: sprite, token }); },
    setNodeVisible(n, v) { n.visible = v; calls.push({ op: "setNodeVisible", node: n, value: v }); },
    setNodeOpacity(n, a) { n.opacity = a; calls.push({ op: "setNodeOpacity", node: n, value: a }); },
    setNodePosition(n, p) { n.position = [...p]; calls.push({ op: "setNodePosition", node: n, value: p }); },
    makeCamera(opts) { return node("camera", opts); },
    setCameraPose(camera, position, target) {
      camera.position = [...position]; camera.target = [...target];
      calls.push({ op: "setCameraPose", position, target });
    },
    getCameraPose(camera) { return { position: camera.position, target: camera.target }; },
    render() { calls.push({ op: "render" }); },
    setPixelRatio(r, ratio) { calls.push({ op: "setPixelRatio", value: ratio }); },
    resize() { calls.push({ op: "resize" }); },
    project(camera, viewport, point) {
      // Orthographic-ish stub: tests assert plumbing, not projection math.
      return { x: point[0], y: point[2], behind: false };
    },
    unprojectRay(camera, viewport, px, py) {
      return { origin: camera.position ?? [0, 0, 0], dir: [0, -1, 0] };
    },
  };
  return assertAdapter(gl);
}
