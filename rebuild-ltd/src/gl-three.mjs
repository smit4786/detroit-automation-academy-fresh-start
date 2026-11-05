/**
 * LTD rebuild — three.js adapter (Tranche T3).
 *
 * The ONLY module that imports the vendor build, and it imports it
 * by relative path from the vendor slot (see vendor/VENDOR.md for
 * the fetch record: three 0.160.0, pinned, from the official npm
 * distribution). In the browser the shell's importmap may remap
 * this specifier; in Node the relative path resolves directly,
 * which is what lets the tests exercise this adapter headlessly
 * (scene-graph construction needs no WebGL context; only the
 * renderer object does, and it is created lazily by makeRenderer).
 *
 * If the owner rules against carrying the vendor build, this file
 * and the vendor slot are the whole blast radius.
 */

import * as THREE from "../vendor/three.module.min.js";
import { assertAdapter } from "./gl-adapter.mjs";

export function createThreeAdapter({ routeVisibility = null } = {}) {
  function routeMaterial(opts) {
    const mat = new THREE.MeshBasicMaterial({
      color: opts.color,
      vertexColors: !!opts.vertexColors,
      transparent: !!opts.transparent || (opts.opacity ?? 1) < 1,
      opacity: opts.opacity ?? 1,
      side: THREE.DoubleSide,
      depthWrite: true,
    });
    if (opts.routeVisibility && routeVisibility) {
      // Per-route alpha via a uniform array indexed by the aRoute
      // attribute (P-04). Alpha 0 discards — visibility and dimming
      // share one mechanism, as placed.
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uRouteAlpha = { value: routeVisibility.alpha };
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", "#include <common>\nattribute float aRoute;\nvarying float vRoute;")
          .replace("#include <begin_vertex>", "#include <begin_vertex>\nvRoute = aRoute;");
        shader.fragmentShader = shader.fragmentShader
          .replace("#include <common>", "#include <common>\nuniform float uRouteAlpha[128];\nvarying float vRoute;")
          .replace("#include <dithering_fragment>",
            "float ra = uRouteAlpha[int(vRoute + 0.5)];\nif (ra <= 0.001) discard;\ngl_FragColor.a *= ra;\n#include <dithering_fragment>");
      };
      mat.transparent = true;
    }
    return mat;
  }

  const gl = {
    createScene() {
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x0c0c0c);
      return scene;
    },
    addToScene(scene, node) { scene.add(node); },
    makeLineSegments(flatQuads, opts) {
      const n = flatQuads.length / 4;
      const positions = new Float32Array(n * 6);
      for (let i = 0; i < n; i++) {
        positions[i * 6] = flatQuads[i * 4];
        positions[i * 6 + 1] = opts.y ?? 0;
        positions[i * 6 + 2] = flatQuads[i * 4 + 1];
        positions[i * 6 + 3] = flatQuads[i * 4 + 2];
        positions[i * 6 + 4] = opts.y ?? 0;
        positions[i * 6 + 5] = flatQuads[i * 4 + 3];
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.LineBasicMaterial({
        color: opts.color,
        transparent: !!opts.transparent,
        opacity: opts.opacity ?? 1,
      });
      return new THREE.LineSegments(geo, mat);
    },
    makeMesh(buffers, opts) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(buffers.positions, 3));
      if (buffers.routeAttr) {
        geo.setAttribute("aRoute", new THREE.BufferAttribute(buffers.routeAttr, 1));
      }
      if (buffers.colorAttr) {
        geo.setAttribute("color", new THREE.BufferAttribute(buffers.colorAttr, 3));
      }
      if (buffers.indices) geo.setIndex(new THREE.BufferAttribute(buffers.indices, 1));
      return new THREE.Mesh(geo, routeMaterial(opts));
    },
    makeFilledShapes(shapes, opts) {
      // Merged fill of many ring sets via the vendor triangulator
      // (ShapeUtils.triangulateShape — earcut-class, hole-aware).
      const positions = [];
      const indices = [];
      let base = 0;
      for (const { rings, y } of shapes) {
        const contour = rings[0].map(([x, z]) => new THREE.Vector2(x, z));
        const holes = rings.slice(1).map((ring) => ring.map(([x, z]) => new THREE.Vector2(x, z)));
        const faces = THREE.ShapeUtils.triangulateShape(contour, holes);
        const pts = [...rings[0], ...rings.slice(1).flat()];
        for (const [x, z] of pts) positions.push(x, y, z);
        for (const f of faces) indices.push(f[0] + base, f[1] + base, f[2] + base);
        base += pts.length;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
      geo.setIndex(indices);
      return new THREE.Mesh(geo, routeMaterial({ ...opts, routeVisibility: false }));
    },
    makePlane({ width, depth, cx, cz, y, color }) {
      const geo = new THREE.PlaneGeometry(width, depth);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(cx, y, cz);
      return mesh;
    },
    makeSprite() { return new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true })); },
    setSpriteTexture(sprite, token) {
      sprite.material.map = token;
      sprite.material.needsUpdate = true;
    },
    setNodeVisible(node, v) { node.visible = v; },
    setNodePosition(node, p) { node.position.set(p[0], p[1], p[2]); },
    setNodeOpacity(node, a) {
      if (node.material) {
        node.material.opacity = a;
        node.material.transparent = a < 1 || node.material.transparent;
      }
    },
    makeCamera({ fov = 50, near = 2, far = 240000 } = {}) {
      return new THREE.PerspectiveCamera(fov, 1, near, far);
    },
    setCameraPose(camera, position, target) {
      camera.position.set(position[0], position[1], position[2]);
      camera.lookAt(target[0], target[1], target[2]);
      camera.userData.target = [...target];
    },
    getCameraPose(camera) {
      return {
        position: [camera.position.x, camera.position.y, camera.position.z],
        target: camera.userData.target ?? [0, 0, 0],
      };
    },
    makeRenderer(canvas) {
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1)); // P-82: pixelRatio <= 2
      return renderer;
    },
    /**
     * Assembly texture factory (T10, additive): rasterize text lines
     * into an achromatic chip texture for sprite labels and vehicle
     * badges. Sprite materials consume the token as their map, so
     * the token must be a real THREE texture — this is the one place
     * that knowledge lives (the sole vendor importer). Browser-only:
     * headless callers inject their own factories.
     */
    makeTextTexture(lines, { fg = "#F2F2F2", bg = "rgba(10,10,10,0.88)", fontPx = 30 } = {}) {
      const list = (Array.isArray(lines) ? lines : [lines]).map((s) => String(s ?? "")).filter(Boolean);
      const text = list.length ? list : [""];
      const cv = document.createElement("canvas");
      const ctx = cv.getContext("2d");
      const font = `600 ${fontPx}px "Space Grotesk", "Inter", system-ui, sans-serif`;
      ctx.font = font;
      const wText = Math.max(...text.map((s) => ctx.measureText(s).width));
      const pad = Math.ceil(fontPx * 0.45);
      cv.width = Math.ceil(wText) + pad * 2;
      cv.height = Math.ceil(fontPx * 1.3 * text.length) + pad * 2;
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.roundRect(0, 0, cv.width, cv.height, Math.ceil(fontPx * 0.35));
      ctx.fill();
      ctx.font = font;
      ctx.fillStyle = fg;
      ctx.textBaseline = "top";
      text.forEach((s, i) => ctx.fillText(s, pad, pad + i * fontPx * 1.3));
      const tex = new THREE.CanvasTexture(cv);
      tex.anisotropy = 4;
      return tex;
    },
    render(renderer, scene, camera) { renderer.render(scene, camera); },
    setPixelRatio(renderer, ratio) { renderer.setPixelRatio(Math.min(2, ratio)); },
    resize(renderer, width, height) {
      renderer.setSize(width, height, false);
    },
    project(camera, viewport, point) {
      camera.updateMatrixWorld();
      const v = new THREE.Vector3(point[0], point[1], point[2]).project(camera);
      return {
        x: (v.x * 0.5 + 0.5) * viewport.width,
        y: (-v.y * 0.5 + 0.5) * viewport.height,
        behind: v.z > 1,
      };
    },
    unprojectRay(camera, viewport, px, py) {
      const ndc = new THREE.Vector2((px / viewport.width) * 2 - 1, -(py / viewport.height) * 2 + 1);
      const rc = new THREE.Raycaster();
      rc.setFromCamera(ndc, camera);
      return { origin: rc.ray.origin.toArray(), dir: rc.ray.direction.toArray() };
    },
  };
  return assertAdapter(gl);
}
