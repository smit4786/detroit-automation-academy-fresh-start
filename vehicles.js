/* Detroit Automation Academy — 3D district vehicles (overnight expansion).
 *
 * Procedural vehicle builds for the Forge Line district. Dimensions follow
 * cad/transit.scad (OpenSCAD, z-up, meters) remapped to three.js (y-up):
 * scad x -> three x (length), scad y -> three z (width), scad z -> three y.
 * Length axes are built along local z and groups are placed unrotated,
 * except sedan C which is rotated -90 deg so its length runs along world x.
 *
 * Coordinate system: x = east, z = south, y = up, meters.
 * Heritage Car is intentionally NOT built here: forge-line.html reserves the
 * at-grade heritage loop as Phase 2, so no heritage vehicle is placed.
 */
(function () {
  'use strict';

  // Forge palette shared with arch-kit.
  var ORANGE = 0x7F7F7F;
  var AMBER = 0xB4B4B4;
  var DARK = 0x171717;
  var STEEL = 0x949494;
  var CREAM = 0xF2F2F2;

  function mats(THREE) {
    return {
      orange: new THREE.MeshStandardMaterial({ color: ORANGE, roughness: 0.55, metalness: 0.2 }),
      amber: new THREE.MeshStandardMaterial({ color: AMBER, emissive: AMBER, emissiveIntensity: 0.9, roughness: 0.4 }),
      amberDim: new THREE.MeshStandardMaterial({ color: AMBER, roughness: 0.5 }),
      dark: new THREE.MeshStandardMaterial({ color: DARK, roughness: 0.85 }),
      steel: new THREE.MeshStandardMaterial({ color: STEEL, roughness: 0.6, metalness: 0.4 }),
      cream: new THREE.MeshStandardMaterial({ color: CREAM, roughness: 0.6 }),
      glass: new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.15, metalness: 0.65 }),
      lampW: new THREE.MeshStandardMaterial({ color: 0xf5f5f5, emissive: 0xe3e3e3, emissiveIntensity: 0.8, roughness: 0.3 })
    };
  }

  function box(g, THREE, w, h, d, mat, x, y, z) {
    var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    g.add(m);
    return m;
  }

  // Wheel: cylinder with axis along x (for vehicles whose length runs along z).
  function wheelX(g, THREE, r, wdt, mat, x, y, z) {
    var m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, wdt, 18), mat);
    m.rotation.z = Math.PI / 2;
    m.position.set(x, y, z);
    m.castShadow = true;
    g.add(m);
    return m;
  }

  // ---- 1. Forge Pod: elevated passenger pod. Local frame: length along z,
  // base y=0 at rail top. Body 5.0 long x 2.0 wide x 2.2 tall per task spec. ----
  function buildPod(THREE) {
    var M = mats(THREE);
    var g = new THREE.Group();
    // guideway bogies straddling the rails (rails at local x = +/-0.8)
    [-1.6, 1.6].forEach(function (z) {
      box(g, THREE, 1.5, 0.35, 1.4, M.dark, 0, 0.22, z);
      [-0.45, 0.45].forEach(function (dz) { wheelX(g, THREE, 0.22, 1.4, M.dark, 0, 0.22, z + dz); });
    });
    box(g, THREE, 4.6, 0.3, 1.7, M.dark, 0, 0.5, 0);          // skirt
    box(g, THREE, 2.0, 0.7, 5.0, M.orange, 0, 0.95, 0);       // hull
    var roof = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 4.4, 20), M.orange);
    roof.rotation.x = Math.PI / 2;                    // rounded roof cap
    roof.position.set(0, 1.3, 0);
    roof.castShadow = true;
    g.add(roof);
    box(g, THREE, 2.06, 0.55, 4.2, M.glass, 0, 1.05, 0);      // window band
    box(g, THREE, 2.04, 0.18, 5.02, M.amberDim, 0, 0.72, 0);  // amber accent stripe
    box(g, THREE, 1.0, 0.25, 0.06, M.lampW, 0, 1.0, 2.53);    // headlight bar (south)
    box(g, THREE, 1.0, 0.25, 0.06, M.amber, 0, 1.0, -2.53);   // tail light bar (north)
    var mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.3, 10), M.dark);
    mast.position.set(0.5, 2.3, 0.8);                 // sensor mast
    mast.castShadow = true;
    g.add(mast);
    var dome = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 10), M.dark);
    dome.position.set(0.5, 2.5, 0.8);
    dome.castShadow = true;
    g.add(dome);
    var beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.14, 12), M.amber);
    beacon.position.set(0, 2.27, -1.2);               // roof beacon
    beacon.castShadow = true;
    g.add(beacon);
    return g;
  }

  // ---- 2. Forge Hauler: cargo pod. 6.0 long x 2.6 wide, 6 wheels, orange
  // livery stripe and dark cargo-door panels for the "cargo" read. ----
  function buildHauler(THREE) {
    var M = mats(THREE);
    var g = new THREE.Group();
    [-2.0, 0.0, 2.0].forEach(function (z) {           // 3 axles x 2 = 6 wheels
      [-1.05, 1.05].forEach(function (x) { wheelX(g, THREE, 0.45, 0.3, M.dark, x, 0.45, z); });
    });
    box(g, THREE, 2.2, 0.3, 5.6, M.dark, 0, 0.75, 0);        // chassis
    box(g, THREE, 2.6, 2.1, 6.0, M.steel, 0, 1.65, 0);       // cargo box
    box(g, THREE, 2.64, 0.35, 6.04, M.orange, 0, 1.675, 0);  // hazmat-orange stripe
    [-1, 1].forEach(function (s) {                    // cargo doors, both sides
      box(g, THREE, 0.06, 1.5, 3.2, M.dark, s * 1.31, 1.65, 0);
    });
    box(g, THREE, 1.8, 0.12, 5.2, M.steel, 0, 2.76, 0);      // roof panel
    var vent = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.14, 12), M.dark);
    vent.position.set(0, 2.89, 2.1);                  // roof vent
    vent.castShadow = true;
    g.add(vent);
    box(g, THREE, 1.2, 0.22, 0.06, M.amber, 0, 1.1, -3.03);  // rear marker bar
    return g;
  }

  // ---- 3. Line Tender: maintenance rig. Low flatbed 4.0 long, cab at one
  // end, crane arm stowed flat along the bed, amber beacon. ----
  function buildTender(THREE) {
    var M = mats(THREE);
    var g = new THREE.Group();
    [-1.2, 1.2].forEach(function (z) {
      [-0.95, 0.95].forEach(function (x) { wheelX(g, THREE, 0.4, 0.3, M.dark, x, 0.4, z); });
    });
    box(g, THREE, 2.4, 0.25, 4.0, M.dark, 0, 0.675, 0);      // flatbed
    box(g, THREE, 2.1, 0.95, 1.15, M.orange, 0, 1.275, 1.425); // cab (south end)
    box(g, THREE, 1.7, 0.4, 0.5, M.glass, 0, 1.5, 1.7);       // cab window
    var beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.12, 12), M.amber);
    beacon.position.set(0, 1.81, 1.425);              // amber beacon
    beacon.castShadow = true;
    g.add(beacon);
    // crane arm stowed: pedestal + boom lying flat along the bed, jib folded
    box(g, THREE, 0.4, 0.5, 0.4, M.dark, 0, 1.05, -1.2);      // pedestal
    box(g, THREE, 0.3, 0.28, 2.0, M.orange, 0, 1.3, -0.9);    // boom (stowed flat)
    box(g, THREE, 0.22, 0.2, 0.9, M.orange, 0, 1.56, -1.35);  // folded jib
    box(g, THREE, 0.18, 0.3, 0.18, M.dark, 0, 1.2, 0.05);     // hook block
    box(g, THREE, 1.0, 0.5, 0.7, M.dark, 0, 1.05, 0.7);       // toolbox
    // work-platform railing along the bed edges
    [-1.12, 1.12].forEach(function (x) {
      for (var z = -1.8; z <= 0.6; z += 0.6) {
        var post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.9, 8), M.orange);
        post.position.set(x, 1.25, z);
        post.castShadow = true;
        g.add(post);
      }
      box(g, THREE, 0.06, 0.06, 2.6, M.orange, x, 1.68, -0.6); // top rail
    });
    return g;
  }

  // ---- 4. Parked sedans: generic 4.4 m sedans, glasshouse, muted colors.
  // Local frame: length along z, front toward -z (north). ----
  function buildSedan(THREE, color) {
    var M = mats(THREE);
    var body = new THREE.MeshStandardMaterial({ color: color, roughness: 0.5, metalness: 0.3 });
    var g = new THREE.Group();
    [-1.45, 1.45].forEach(function (z) {
      [-0.85, 0.85].forEach(function (x) { wheelX(g, THREE, 0.33, 0.24, M.dark, x, 0.33, z); });
    });
    box(g, THREE, 1.9, 0.55, 4.4, body, 0, 0.625, 0);        // lower body
    box(g, THREE, 1.7, 0.5, 2.3, M.glass, 0, 1.15, 0.2);      // glasshouse
    box(g, THREE, 1.74, 0.12, 2.34, body, 0, 0.96, 0.2);      // beltline cap
    box(g, THREE, 1.2, 0.14, 0.08, M.lampW, 0, 0.68, -2.22);  // headlights (front)
    box(g, THREE, 1.2, 0.14, 0.08, M.amberDim, 0, 0.68, 2.22); // taillights (rear)
    return g;
  }

  function buildVehicles(THREE) {
    var g = new THREE.Group();

    // Forge Pod, static on the east guideway segment (deck top 7.5, rail top
    // 7.64). Center z=10 keeps 3 m clear of the Academy HQ platform canopy
    // (canopy z extent ends at 4.3; pod z extent starts at 7.5).
    var pod = buildPod(THREE);
    pod.position.set(22.5, 7.64, 10);
    g.add(pod);

    // Forge Hauler at street level, long axis along z, front toward +z.
    var hauler = buildHauler(THREE);
    hauler.position.set(8, 0, 20);
    g.add(hauler);

    // Line Tender near the guideway pylon, long axis along z (keeps 1.5 m
    // clear of the Corktown measured footprint at x=27.3).
    var tender = buildTender(THREE);
    tender.position.set(24.4, 0, 7);
    g.add(tender);

    // Parked sedans, muted colors. The two N-spoke sedans sit inside the
    // UMCI portal cut (open ground-floor drive-through, portal floor top
    // y=0.14), clear of the glass wings and maize columns.
    var sA = buildSedan(THREE, 0x686868);             // slate, facing north
    sA.position.set(2.9, 0.14, -30);
    g.add(sA);
    var sB = buildSedan(THREE, 0x3c3c3c);             // dark blue, facing south
    sB.rotation.y = Math.PI;
    sB.position.set(-2.9, 0.14, -44);
    g.add(sB);
    var sC = buildSedan(THREE, 0xa9a9a9);             // sand, facing east
    sC.rotation.y = -Math.PI / 2;
    sC.position.set(30, 0, 2.9);
    g.add(sC);

    // Heritage Car: deferred to Phase 2 per forge-line.html copy; not placed.
    return g;
  }

  window.DAAVehicles = { buildVehicles: buildVehicles };
})();
