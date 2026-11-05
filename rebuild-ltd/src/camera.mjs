/**
 * LTD rebuild — camera rig + TransitionEngine (Tranche T3, M5).
 *
 * Fresh orbit math behind the adapter seam (no vendor controls):
 * the rig owns a target + spherical offset and writes poses through
 * the adapter. All parameters are the register's: home framing
 * R-01 / P-02, constraints P-03, vantages + glides + memory P-12,
 * street view P-13, frame floor P-81, reduced motion P-80.
 */

export const HOME = {
  position: [3826, 8039, 9372],
  target: [3826, 0, -205],
  centerLatLon: [42.383, -83.102],
  elevationDeg: 40,
  distance: 12500,
};

export const LIMITS = {
  minDistance: 1200,
  maxDistance: 55000,
  maxPolar: 1.35,
  damping: 0.08,
  cameraFloorY: 30,
};

export const VANTAGES = {
  bus: { elevationDeg: 32 },
  stop: { elevationDeg: 40 },
  bounds: { elevationDeg: 40 },
  home: { elevationDeg: 40 },
};

export const STREET_VIEW = {
  enterBelow: 1500,
  exitAbove: 2600,
  horizontal: 620,
  up: 250,
  minDistance: 150,
  near: 10,
  guidewayFade: 0.07,
};

/** Minimum-jerk quintic: s(t) = 6t^5 - 15t^4 + 10t^3. */
export function minimumJerk(t) {
  const c = Math.min(1, Math.max(0, t));
  return c * c * c * (10 + c * (-15 + 6 * c));
}

function toSpherical(position, target) {
  const dx = position[0] - target[0];
  const dy = position[1] - target[1];
  const dz = position[2] - target[2];
  const distance = Math.hypot(dx, dy, dz);
  return {
    distance,
    polar: Math.acos(Math.min(1, Math.max(-1, dy / distance))),
    azimuth: Math.atan2(dx, dz),
  };
}

function fromSpherical(target, { distance, polar, azimuth }) {
  const sp = Math.sin(polar);
  return [
    target[0] + distance * sp * Math.sin(azimuth),
    target[1] + distance * Math.cos(polar),
    target[2] + distance * sp * Math.cos(azimuth),
  ];
}

export class CameraRig {
  constructor({ reducedMotion = false } = {}) {
    this.target = [...HOME.target];
    this.spherical = toSpherical(HOME.position, HOME.target);
    this.reducedMotion = reducedMotion;
    this.glide = null;
    this.memory = null;
    this.streetView = false;
    this.vel = { distance: 0, polar: 0, azimuth: 0, panX: 0, panZ: 0 };
  }

  pose() {
    return {
      position: fromSpherical(this.target, this.spherical),
      target: [...this.target],
    };
  }

  /** Apply the pose through the adapter; enforces the y=30 floor (P-81). */
  apply(gl, camera) {
    const { position, target } = this.pose();
    if (position[1] < LIMITS.cameraFloorY) position[1] = LIMITS.cameraFloorY;
    gl.setCameraPose(camera, position, target);
    return { position, target };
  }

  clamp() {
    const minD = this.streetView ? STREET_VIEW.minDistance : LIMITS.minDistance;
    this.spherical.distance = Math.min(LIMITS.maxDistance, Math.max(minD, this.spherical.distance));
    this.spherical.polar = Math.min(LIMITS.maxPolar, Math.max(0.05, this.spherical.polar));
  }

  /** Direct manipulation inputs (orbit / dolly / pan), damped in update(). */
  orbitBy(dAzimuth, dPolar) { this.vel.azimuth += dAzimuth; this.vel.polar += dPolar; }
  dollyBy(factor) { this.vel.distance += Math.log(factor); }
  panBy(dx, dz) { this.vel.panX += dx; this.vel.panZ += dz; }

  update() {
    const v = this.vel;
    this.spherical.azimuth += v.azimuth;
    this.spherical.polar += v.polar;
    this.spherical.distance *= Math.exp(v.distance);
    this.target[0] += v.panX;
    this.target[2] += v.panZ;
    const keep = 1 - LIMITS.damping;
    v.azimuth *= keep; v.polar *= keep; v.distance *= keep; v.panX *= keep; v.panZ *= keep;
    this.clamp();
    this.updateStreetView();
  }

  updateStreetView() {
    const d = this.spherical.distance;
    if (!this.streetView && d < STREET_VIEW.enterBelow) this.streetView = true;
    else if (this.streetView && d > STREET_VIEW.exitAbove) this.streetView = false;
    return this.streetView;
  }

  /** Guideway opacity target under street view (P-13 fade to 0.07). */
  guidewayOpacity() {
    return this.streetView ? STREET_VIEW.guidewayFade : 1;
  }

  /**
   * Glide to a pose (TransitionEngine, P-12): duration scales with
   * distance, 600-1600 ms; minimum-jerk easing; reduced motion
   * completes in place. `now` is injected for determinism.
   */
  glideTo({ target = null, distance = null, elevationDeg = null, azimuth = null }, now = 0) {
    const endTarget = target ? [...target] : [...this.target];
    const endSpherical = { ...this.spherical };
    if (distance !== null) endSpherical.distance = distance;
    if (elevationDeg !== null) endSpherical.polar = Math.min(LIMITS.maxPolar, Math.max(0.05, (90 - elevationDeg) * Math.PI / 180));
    if (azimuth !== null) endSpherical.azimuth = azimuth;
    const travel = Math.hypot(
      endTarget[0] - this.target[0], endTarget[2] - this.target[2],
      endSpherical.distance - this.spherical.distance);
    const duration = this.reducedMotion ? 0 : Math.min(1600, Math.max(600, 600 + travel / 12));
    this.glide = {
      start: now, duration,
      fromTarget: [...this.target], toTarget: endTarget,
      fromSpherical: { ...this.spherical }, toSpherical: endSpherical,
    };
    if (duration === 0) this.advanceGlide(now);
    return this.glide;
  }

  /** Vantage glides (P-12): bus 32°, bounds/home 40°. */
  glideToVantage(name, target, now = 0, distance = null) {
    const v = VANTAGES[name];
    if (!v) throw new Error(`camera: unknown vantage ${name}`);
    return this.glideTo({ target, elevationDeg: v.elevationDeg, distance }, now);
  }

  /** Advance the active glide; returns true while gliding. */
  advanceGlide(now) {
    if (!this.glide) return false;
    const g = this.glide;
    const t = g.duration === 0 ? 1 : (now - g.start) / g.duration;
    const s = minimumJerk(t);
    for (let i = 0; i < 3; i++) {
      this.target[i] = g.fromTarget[i] + (g.toTarget[i] - g.fromTarget[i]) * s;
    }
    for (const k of ["distance", "polar", "azimuth"]) {
      this.spherical[k] = g.fromSpherical[k] + (g.toSpherical[k] - g.fromSpherical[k]) * s;
    }
    this.clamp();
    this.updateStreetView();
    if (t >= 1) { this.glide = null; return false; }
    return true;
  }

  /** Pointer input cancels any glide (P-12). */
  cancelGlide() { this.glide = null; }

  /** Camera memory (P-12): snapshot on first open, restore on last close. */
  snapshot() {
    if (!this.memory) {
      this.memory = { target: [...this.target], spherical: { ...this.spherical } };
    }
  }
  restore(now = 0) {
    if (!this.memory) return false;
    const m = this.memory;
    this.memory = null;
    this.glideTo({ target: m.target, distance: m.spherical.distance }, now);
    this.glide.toSpherical.polar = m.spherical.polar;
    this.glide.toSpherical.azimuth = m.spherical.azimuth;
    return true;
  }
  hasMemory() { return this.memory !== null; }
}
