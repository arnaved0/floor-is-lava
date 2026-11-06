import * as THREE from 'three';

/**
 * Glute jiggle: damped springs driven by how the body actually moves.
 *
 * Each frame we measure the acceleration of a point on each thigh (just below the hip
 * joint) after the animation has been applied. Soft tissue lags behind acceleration,
 * so each spring is pushed the opposite way:  x'' = -k·x - c·x' - a.
 * Spring displacement (metres) is converted to morph influence for the jiggle blend
 * shapes baked in tools/rig.py (1.0 = JIGGLE_AMP metres at the centre of a cheek).
 *
 * Model-local axes (glTF): +Y up, the character faces +Z, so its back is -Z.
 */
const JIGGLE_AMP = 0.03;          // must match tools/rig.py
const FREQ = 4.2;                 // Hz: how fast it wobbles
const ZETA = 0.13;                // damping ratio: lower = wobbles longer
const K = (2 * Math.PI * FREQ) ** 2;
const C = 2 * ZETA * 2 * Math.PI * FREQ;
const MAX_ACCEL = 70;             // ignore teleports / respawns
const MAX_INFLUENCE = 1.6;
const ACCEL_GAIN = 0.26;          // overall strength
const THIGH_T = 0.15;             // sample point: fraction of the way from hip joint to knee
const WARMUP = 0.5;               // seconds after a reset before physics kicks in

class Spring {
  constructor() { this.x = 0; this.v = 0; }
  step(dt, accel) {
    // semi-implicit Euler, sub-stepped for stability at low frame rates
    const n = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.v += (-K * this.x - C * this.v - accel) * h;
      this.x += this.v * h;
    }
  }
  kick(dv) { this.v += dv; }
  reset() { this.x = this.v = 0; }
}

export class GluteJiggle {
  constructor(model, root) {
    this.root = root;
    this.morphs = [];
    model.traverse((o) => {
      const d = o.morphTargetDictionary;
      if (d && d.jiggleL !== undefined) this.morphs.push({ o, L: d.jiggleL, R: d.jiggleR, X: d.jiggleX, Y: d.jiggleY });
    });
    const bone = (n) => model.getObjectByName(n);
    this.points = [
      { up: bone('mixamorigLeftUpLeg'), knee: bone('mixamorigLeftLeg') },
      { up: bone('mixamorigRightUpLeg'), knee: bone('mixamorigRightLeg') },
    ].map((p) => ({ ...p, prev: new THREE.Vector3(), vel: new THREE.Vector3(), acc: new THREE.Vector3(), primed: 0 }));
    this.springL = new Spring(); this.springR = new Spring();
    this.springX = new Spring(); this.springY = new Spring();
    this._a = new THREE.Vector3(); this._b = new THREE.Vector3(); this._inv = new THREE.Quaternion();
    this.enabled = this.morphs.length > 0;
    this.warm = 0;
  }

  reset() {
    for (const s of [this.springL, this.springR, this.springX, this.springY]) s.reset();
    for (const p of this.points) p.primed = 0;
    this.warm = 0;
    this.apply(0);
  }

  /** Extra impulse in metres/second (e.g. on landing). Positive = downwards. */
  thump(speed) {
    if (this.warm < 1) return;
    this.springL.kick(-speed); this.springR.kick(-speed);
    this.springY.kick(speed * 0.4);
  }

  /** Call after the mixer has posed the skeleton. size = current glute growth influence. */
  update(dt, size) {
    if (!this.enabled || dt <= 0) return;
    this.root.updateMatrixWorld(true);
    this._inv.copy(this.root.quaternion).invert();
    const accs = [];
    for (const p of this.points) {
      // a point 30% of the way from the hip joint to the knee
      p.up.getWorldPosition(this._a);
      p.knee.getWorldPosition(this._b);
      this._a.lerp(this._b, THIGH_T);
      if (p.primed < 2) {
        if (p.primed === 1) p.vel.subVectors(this._a, p.prev).divideScalar(dt);
        p.prev.copy(this._a); p.primed++; p.acc.set(0, 0, 0);
        accs.push(p.acc); continue;
      }
      const vel = this._b.subVectors(this._a, p.prev).divideScalar(dt);
      const acc = vel.clone().sub(p.vel).divideScalar(dt);
      if (acc.length() > MAX_ACCEL) acc.setLength(0); // teleport: ignore
      acc.applyQuaternion(this._inv);                   // world -> character frame
      p.acc.lerp(acc, 0.6);                             // light smoothing of the finite difference
      p.vel.copy(vel); p.prev.copy(this._a);
      accs.push(p.acc);
    }
    const [aL, aR] = accs;
    // ease in after a reset so spawn/animation-crossfade motion doesn't kick the springs
    this.warm = Math.min(1, this.warm + dt / WARMUP);
    const ramp = this.warm * this.warm;
    // bigger glutes = more mass = more jiggle
    const gain = ACCEL_GAIN * ramp * (0.55 + size * 0.75);
    this.springL.step(dt, aL.y * gain);
    this.springR.step(dt, aR.y * gain);
    this.springX.step(dt, ((aL.x + aR.x) / 2) * gain);
    this.springY.step(dt, (-(aL.z + aR.z) / 2) * gain);  // morph +Y(Blender) = -Z here
    this.apply(1);
  }

  apply(on) {
    const f = (s) => on * THREE.MathUtils.clamp(s.x / JIGGLE_AMP, -MAX_INFLUENCE, MAX_INFLUENCE);
    const l = f(this.springL), r = f(this.springR), x = f(this.springX), y = f(this.springY);
    for (const m of this.morphs) {
      const inf = m.o.morphTargetInfluences;
      inf[m.L] = l; inf[m.R] = r; inf[m.X] = x; inf[m.Y] = y;
    }
  }
}
