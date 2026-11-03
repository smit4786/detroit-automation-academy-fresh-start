/* Detroit Automation Academy — autonomous drone fleet controller (prototype track)
 *
 * Kinematic fleet: 1 bee drone + 2 scout drones (built by
 * window.DAADroneVariants from drone-variants.js) with three behaviors:
 *   'patrol' (default) — closed Catmull-Rom loops at safe altitude
 *   'follow'           — escort the training drone in formation
 *   'rtp'              — return to pad: fly home, descend, sit
 *
 * The training drone in world3d.js is a separate aircraft: this module never
 * writes its state, it only reads its position via opts.getTrainingPos().
 * Transitions are smooth — exponential damping toward the active goal, so
 * nothing teleports after the initial placement. Pass { reduced: true }
 * (prefers-reduced-motion) and the fleet sits parked on its pads.
 *
 * Units meters; x = east, z = south, y = up. Forward = -z.
 */
(function () {
  'use strict';

  var AMBER = 0xB4B4B4;  // Tier 1: Amber — pad ring
  var STEEL = 0x1b1b1b;  // Tier 2: steel-dark — pad body

  var MODES = ['patrol', 'follow', 'rtp'];
  var CRUISE_SPEED = 7;  // m/s along patrol loops
  var MIN_ALT = 6;       // m above ground — follow formation floor
  var PAD_TOP = 0.25;    // m — pad cylinder height
  var PAD_R = 0.9;       // m — pad radius
  var DAMP = 2.2;        // 1/s — position smoothing toward the active goal
  var YAW_DAMP = 4.0;    // 1/s — yaw smoothing
  var PROP_SPEED = 42;   // rad/s
  var FLAP_SPEED = 38;   // rad/s — bee wingbeat
  var PARK_DIST = 0.12;  // m — rtp leg considered complete inside this radius

  // [x, z] ground pads, one per drone in fleet order
  var PAD_XZ = [[3, 27], [-3, 27], [0, 30]];
  // closed patrol loops: bee = core, scout 1 = riverfront, scout 2 = far field
  var LOOPS = [
    [[80, 32, 80], [80, 32, -80], [-80, 32, -80], [-80, 32, 80]],
    [[-60, 26, 60], [60, 26, 60], [60, 26, 80], [-60, 26, 80]],
    [[400, 45, 400], [-400, 45, 400], [-400, 45, -400], [400, 45, -400]]
  ];
  var U0 = [0, 0.37, 0.71]; // staggered loop start parameters (deterministic)
  var FOLLOW_OFFSETS = [[-4, 2.5, -4], [4, 2.5, -4], [0, 3, 6]];
  var KINDS = ['bee', 'scout', 'scout'];

  function getVariants() {
    var W = (typeof window !== 'undefined') ? window : undefined;
    return (W && W.DAADroneVariants) ? W.DAADroneVariants : null;
  }

  // yaw that faces travel direction (dx, dz) with forward = -z
  function yawFor(dx, dz) { return Math.atan2(-dx, -dz); }

  function shortestArc(from, to) {
    var d = (to - from) % (Math.PI * 2);
    if (d > Math.PI) { d -= Math.PI * 2; }
    if (d < -Math.PI) { d += Math.PI * 2; }
    return d;
  }

  // small dark cylinder with an amber ring — the drone's home pad
  function buildPad(THREE, x, z) {
    var g = new THREE.Group();
    var dark = new THREE.MeshStandardMaterial({ color: STEEL, roughness: 0.7, metalness: 0.3 });
    var ring = new THREE.MeshStandardMaterial({
      color: AMBER, emissive: AMBER, emissiveIntensity: 1.4, roughness: 0.5
    });
    var base = new THREE.Mesh(new THREE.CylinderGeometry(PAD_R, PAD_R, PAD_TOP, 28), dark);
    base.position.set(x, PAD_TOP / 2, z);
    base.receiveShadow = true;
    g.add(base);
    var hoop = new THREE.Mesh(new THREE.TorusGeometry(PAD_R - 0.06, 0.045, 10, 40), ring);
    hoop.rotation.x = Math.PI / 2;
    hoop.position.set(x, PAD_TOP + 0.01, z);
    g.add(hoop);
    return g;
  }

  function init(THREE, scene, opts) {
    opts = opts || {};
    var DV = getVariants();
    if (!DV) {
      throw new Error('DAADroneAutonomy: window.DAADroneVariants is not loaded.');
    }
    var reduced = !!opts.reduced;
    var getTrainingPos = (typeof opts.getTrainingPos === 'function')
      ? opts.getTrainingPos
      : function () { return { x: 0, y: 0, z: 0 }; };

    var fleet = [];
    var _pa = new THREE.Vector3(), _pb = new THREE.Vector3(); // patrol curve temps — never allocate in update()
    for (var i = 0; i < 3; i++) {
      var group = (KINDS[i] === 'bee') ? DV.buildBeeDrone(THREE) : DV.buildScoutDrone(THREE);
      var pts = LOOPS[i].map(function (p) { return new THREE.Vector3(p[0], p[1], p[2]); });
      var curve = new THREE.CatmullRomCurve3(pts, true);
      var pad = {
        x: PAD_XZ[i][0],
        z: PAD_XZ[i][1],
        restY: PAD_TOP + (group.userData.restOffset || 0.5)
      };
      scene.add(buildPad(THREE, pad.x, pad.z));
      scene.add(group);
      var d = {
        group: group,
        curve: curve,
        curveLen: curve.getLength(),
        pos: new THREE.Vector3(),
        goal: new THREE.Vector3(),
        yaw: 0,
        u: U0[i],
        pad: pad,
        parked: false,
        flapPhase: i * 2.1,
        index: i
      };
      if (reduced) {
        d.pos.set(pad.x, pad.restY, pad.z);
        d.parked = true;
      } else {
        var p0 = curve.getPointAt(d.u);
        var p1 = curve.getPointAt((d.u + 0.005) % 1);
        d.pos.set(p0.x, p0.y, p0.z);
        d.yaw = yawFor(p1.x - p0.x, p1.z - p0.z);
      }
      group.position.copy(d.pos);
      group.rotation.y = d.yaw;
      fleet.push(d);
    }

    var mode = 'patrol';

    // nearest loop parameter to the drone's current position (for smooth
    // re-entry into patrol from another mode — no jump to a far loop point)
    function nearestU(d) {
      var best = 0, bd = Infinity, s, u, p, dx, dz, dd;
      for (s = 0; s < 64; s++) {
        u = s / 64;
        p = d.curve.getPointAt(u);
        dx = p.x - d.pos.x;
        dz = p.z - d.pos.z;
        dd = dx * dx + dz * dz;
        if (dd < bd) { bd = dd; best = u; }
      }
      return best;
    }

    function update(dt, now) {
      if (reduced) { return; }              // parked fleet never moves
      if (!(dt > 0)) { return; }
      if (dt > 0.1) { dt = 0.1; }           // clamp long frames
      if (typeof now !== 'number' || !(now >= 0)) { now = 0; }

      var kp = 1 - Math.exp(-DAMP * dt);
      var ky = 1 - Math.exp(-YAW_DAMP * dt);

      for (var i = 0; i < fleet.length; i++) {
        var d = fleet[i];
        if (d.parked) { continue; }
        var desiredYaw = d.yaw;

        if (mode === 'patrol') {
          d.u = (d.u + (CRUISE_SPEED * dt) / d.curveLen) % 1;
          var p = d.curve.getPointAt(d.u, _pa);
          var q = d.curve.getPointAt((d.u + 0.01) % 1, _pb);
          d.goal.set(p.x, p.y, p.z);
          desiredYaw = yawFor(q.x - p.x, q.z - p.z);
        } else if (mode === 'follow') {
          var tp = getTrainingPos() || {};
          var off = FOLLOW_OFFSETS[d.index];
          var gx = (tp.x || 0) + off[0];
          var gy = (tp.y || 0) + off[1];
          var gz = (tp.z || 0) + off[2];
          if (gy < MIN_ALT) { gy = MIN_ALT; }
          d.goal.set(gx, gy, gz);
          var fdx = gx - d.pos.x, fdz = gz - d.pos.z;
          if (fdx * fdx + fdz * fdz > 0.25) { desiredYaw = yawFor(fdx, fdz); }
        } else { // 'rtp' — fly home, descend onto the pad
          d.goal.set(d.pad.x, d.pad.restY, d.pad.z);
          var rdx = d.pad.x - d.pos.x, rdz = d.pad.z - d.pos.z;
          if (rdx * rdx + rdz * rdz > 0.25) { desiredYaw = yawFor(rdx, rdz); }
        }

        // smooth chase of the goal — the only motion model; no teleports
        d.pos.x += (d.goal.x - d.pos.x) * kp;
        d.pos.y += (d.goal.y - d.pos.y) * kp;
        d.pos.z += (d.goal.z - d.pos.z) * kp;
        d.yaw += shortestArc(d.yaw, desiredYaw) * ky;
        d.group.position.copy(d.pos);
        d.group.rotation.y = d.yaw;

        // rotors spin (alternating), bee wings flap
        var ud = d.group.userData || {};
        var props = ud.props || [];
        for (var pi = 0; pi < props.length; pi++) {
          props[pi].rotation.y += ((pi % 2 === 0) ? 1 : -1) * PROP_SPEED * dt;
        }
        var wings = ud.wings || [];
        if (wings.length === 2) {
          var flap = 0.12 + Math.sin(now * FLAP_SPEED + d.flapPhase) * 0.45;
          wings[0].rotation.z = flap;
          wings[1].rotation.z = -flap;
        }

        // rtp completes when the drone settles onto its pad
        if (mode === 'rtp') {
          var ex = d.pad.x - d.pos.x;
          var ey = d.pad.restY - d.pos.y;
          var ez = d.pad.z - d.pos.z;
          if (ex * ex + ey * ey + ez * ez < PARK_DIST * PARK_DIST) {
            d.parked = true;
            d.pos.set(d.pad.x, d.pad.restY, d.pad.z);
            d.group.position.copy(d.pos);
            for (var wi = 0; wi < wings.length; wi++) { wings[wi].rotation.z = 0; }
          }
        }
      }
    }

    function setMode(name) {
      if (MODES.indexOf(name) < 0 || name === mode) { return mode; }
      mode = name;
      for (var i = 0; i < fleet.length; i++) {
        fleet[i].parked = false;
        if (name === 'patrol') { fleet[i].u = nearestU(fleet[i]); }
      }
      return mode;
    }

    function getMode() { return mode; }

    return {
      update: update,
      setMode: setMode,
      getMode: getMode,
      droneCount: fleet.length
    };
  }

  var W = (typeof window !== 'undefined') ? window : undefined;
  if (W) {
    W.DAADroneAutonomy = { init: init };
  }
})();
