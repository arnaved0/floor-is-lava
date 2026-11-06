import * as THREE from 'three';
import { clamp, damp, angleLerp } from './util.js';
import { LAVA_Y } from './world.js';

const RADIUS = 0.32;
const HEIGHT = 1.75;
const STAND_MARGIN = 0.18;   // feet can overhang an edge this much
const CROUCH_MARGIN = 0.05;  // crouching never walks further than this past an edge
const GRAVITY = 26;
const JUMP_V = 9.4;
const SPEEDS = { crouch: 1.9, run: 5.4, sprint: 8.2, roll: 7.5 };
const CLIP_SPEED = { walk: 1.5, run: 4.6, sprint: 7.0, crouchWalk: 1.3 };

export class Player {
  constructor(gltf, scene) {
    this.root = new THREE.Group();
    this.model = gltf.scene;
    this.root.add(this.model);
    scene.add(this.root);

    this.materials = [];
    this.model.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.frustumCulled = false;
        o.material = o.material.clone();
        o.material.roughness = 0.85;
        o.material.metalness = 0;
        o.material.emissive = new THREE.Color(0, 0, 0);
        this.materials.push(o.material);
      }
    });

    // --- animation setup
    this.mixer = new THREE.AnimationMixer(this.model);
    const hips = this.model.getObjectByName('mixamorigHips');
    const rest = hips.position.clone();
    this.actions = {};
    for (const clip of gltf.animations) {
      const t = clip.tracks.find((tr) => tr.name === 'mixamorigHips.position');
      if (t) {
        const v = t.values;
        let minY = Infinity, minI = 0;
        for (let i = 0; i < v.length; i += 3) {
          v[i] = rest.x; v[i + 2] = rest.z;   // lock root in place horizontally; physics moves us
          if (clip.name === 'jump' || clip.name === 'fall') {
            if (v[i + 1] < minY) { minY = v[i + 1]; minI = i / 3; }
            v[i + 1] = Math.min(v[i + 1], rest.y); // physics provides the lift
          }
        }
        if (clip.name === 'jump') this.jumpStart = t.times[minI] ?? 0;
      }
      const a = this.mixer.clipAction(clip);
      this.actions[clip.name] = a;
    }
    this.current = null;
    this.play('idle', 0);

    // --- physics state
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.facing = 0;
    this.reset(new THREE.Vector3(0, 1, 0));
  }

  reset(p, plat = null) {
    this.pos.copy(p);
    this.vel.set(0, 0, 0);
    this.onGround = true;
    this.ground = plat;
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.crouchToggle = false;
    this.crouch = false;
    this.rolling = 0;
    this.rollCooldown = 0;
    this.airTime = 0;
    this.landTimer = 0;
    this.jumpTimer = 0;
    this.waving = 0;
    this.burning = 0;
    this.invuln = 0;
    this.stepTimer = 0;
    this.facing = 0;
    this.lastSafe = plat;
    this.setFlash(0);
    this.root.visible = true;
  }

  play(name, fade = 0.18, { once = false, timeScale = 1, at = 0 } = {}) {
    if (this.current === name) return this.actions[name];
    const next = this.actions[name];
    if (!next) return null;
    next.reset();
    next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = once;
    next.time = at;
    next.setEffectiveTimeScale(timeScale);
    next.setEffectiveWeight(1);
    next.fadeIn(fade).play();
    if (this.current) this.actions[this.current].fadeOut(fade);
    this.current = name;
    return next;
  }

  setFlash(k) {
    for (const m of this.materials) m.emissive.setRGB(k * 1.4, k * 0.25, 0);
  }

  get focus() { return new THREE.Vector3(this.pos.x, this.pos.y + (this.crouch ? 1.1 : 1.45), this.pos.z); }

  burn(sfx, cam) {
    this.burning = 1.5;
    this.vel.set(0, 11, 0);
    this.onGround = false;
    this.ground = null;
    this.rolling = 0;
    sfx.burn();
    cam.shake = 0.5;
  }

  /**
   * @returns {string|null} event: 'burned' when the burn sequence finishes.
   */
  update(dt, input, cam, level, sfx) {
    let event = null;
    const plats = level.platforms;
    this.invuln = Math.max(0, this.invuln - dt);
    this.rollCooldown = Math.max(0, this.rollCooldown - dt);

    // ---------------- intent
    let ix = 0, iz = 0;
    const controllable = this.burning <= 0 && input;
    if (controllable) {
      if (input.down('KeyW')) iz += 1;
      if (input.down('KeyS')) iz -= 1;
      if (input.down('KeyD')) ix += 1;
      if (input.down('KeyA')) ix -= 1;
      if (input.hit('KeyC')) this.crouchToggle = !this.crouchToggle;
      if (input.hit('Space')) this.jumpBuffer = 0.14;
      if (input.hit('KeyQ') && this.onGround && this.rolling <= 0 && this.rollCooldown <= 0) {
        this.rolling = 0.78; this.rollCooldown = 0.25; this.crouchToggle = false; sfx.roll();
        this.rollDir = new THREE.Vector2(Math.sin(this.facing), Math.cos(this.facing));
      }
      if (input.hit('KeyE') && this.onGround) this.waving = 1.1;
    }
    const wantCrouch = controllable && (input.down('ControlLeft', 'ControlRight') || this.crouchToggle);
    this.crouch = wantCrouch && this.onGround && this.rolling <= 0;
    const sprint = controllable && input.down('ShiftLeft', 'ShiftRight') && !this.crouch;

    const { fx, fz, rx, rz } = cam.basis();
    let dx = fx * iz + rx * ix, dz = fz * iz + rz * ix;
    const len = Math.hypot(dx, dz);
    if (len > 0) { dx /= len; dz /= len; this.waving = 0; }

    let target = this.crouch ? SPEEDS.crouch : sprint ? SPEEDS.sprint : SPEEDS.run;
    let tvx = dx * target, tvz = dz * target;
    if (this.rolling > 0) {
      this.rolling -= dt;
      tvx = this.rollDir.x * SPEEDS.roll; tvz = this.rollDir.y * SPEEDS.roll;
    }
    const accel = this.onGround ? (len > 0 || this.rolling > 0 ? 14 : 18) : 3.2;
    const k = damp(accel, dt);
    if (this.burning > 0) { this.vel.x *= 1 - damp(4, dt); this.vel.z *= 1 - damp(4, dt); }
    else { this.vel.x += (tvx - this.vel.x) * k; this.vel.z += (tvz - this.vel.z) * k; }

    // ---------------- jump
    this.jumpBuffer -= dt;
    this.coyote = this.onGround ? 0.12 : this.coyote - dt;
    if (this.jumpBuffer > 0 && this.coyote > 0 && this.burning <= 0) {
      this.vel.y = JUMP_V;
      this.onGround = false; this.ground = null; this.coyote = 0; this.jumpBuffer = 0;
      this.rolling = 0; this.crouchToggle = false; this.crouch = false;
      this.jumpTimer = 0.45;
      sfx.jump();
    }

    // ---------------- carry with moving / sinking platform
    if (this.onGround && this.ground) {
      this.pos.x += this.ground.dx; this.pos.z += this.ground.dz;
    }

    // ---------------- horizontal move (+ crouch edge guard)
    const oldX = this.pos.x, oldZ = this.pos.z;
    let nx = this.pos.x + this.vel.x * dt, nz = this.pos.z + this.vel.z * dt;
    if (this.crouch && this.onGround && this.ground) {
      const supported = (x, z) => plats.some((p) => p.active && Math.abs(p.top - this.pos.y) < 0.05 && p.contains(x, z, CROUCH_MARGIN));
      if (!supported(nx, nz)) {
        if (supported(nx, oldZ)) { nz = oldZ; this.vel.z = 0; }
        else if (supported(oldX, nz)) { nx = oldX; this.vel.x = 0; }
        else { nx = oldX; nz = oldZ; this.vel.x = this.vel.z = 0; }
      }
    }
    this.pos.x = nx; this.pos.z = nz;

    // side collisions with pillars we are below the top of
    for (const p of plats) {
      if (!p.active) continue;
      if (this.pos.y < p.top - 0.3) {
        if (p.pushOut(this.pos, RADIUS)) {
          const ddx = this.pos.x - nx, ddz = this.pos.z - nz, dl = Math.hypot(ddx, ddz) || 1;
          const vn = this.vel.x * (ddx / dl) + this.vel.z * (ddz / dl);
          if (vn < 0) { this.vel.x -= vn * (ddx / dl); this.vel.z -= vn * (ddz / dl); }
        }
      }
    }

    // ---------------- vertical
    const prevY = this.pos.y;
    const wasGround = this.onGround;
    this.vel.y -= (this.vel.y < 0 ? GRAVITY * 1.25 : GRAVITY) * dt;
    if (this.onGround) this.vel.y = Math.min(this.vel.y, 0);
    this.vel.y = Math.max(this.vel.y, -30);
    let ny = this.pos.y + this.vel.y * dt;

    let support = null;
    if (this.vel.y <= 0 && this.burning <= 0) {
      const snap = wasGround ? 0.35 : 0;
      for (const p of plats) {
        if (!p.contains(this.pos.x, this.pos.z, STAND_MARGIN)) continue;
        if (prevY >= p.top - 0.06 - snap - Math.max(0, -p.dtop) && ny <= p.top + snap) {
          if (!support || p.top > support.top) support = p;
        }
      }
    }
    if (support) {
      ny = support.top;
      this.vel.y = 0;
      if (!wasGround) {
        const hard = this.airTime > 0.85;
        sfx.land(hard);
        if (hard && Math.hypot(this.vel.x, this.vel.z) < 1) this.landTimer = 0.42;
        if (hard) cam.shake = 0.15;
      }
      this.onGround = true;
      this.ground = support;
      this.airTime = 0;
      support.stand(sfx);
      if (support.kind === 'static' || support.kind === 'start') this.lastSafe = support;
    } else {
      this.onGround = false;
      this.ground = null;
      this.airTime += dt;
    }
    this.pos.y = ny;

    // ---------------- lava
    if (this.pos.y <= LAVA_Y + 0.05) {
      this.pos.y = LAVA_Y + 0.05;
      if (this.burning <= 0) this.burn(sfx, cam);
      else this.vel.y = Math.max(this.vel.y, 4);
    }
    if (this.burning > 0) {
      this.burning -= dt;
      this.setFlash(0.6 + 0.4 * Math.sin(this.burning * 30));
      if (this.burning <= 0) { this.setFlash(0); event = 'burned'; }
    } else if (this.invuln > 0) {
      this.root.visible = Math.sin(this.invuln * 30) > -0.3;
    } else {
      this.root.visible = true;
    }

    // ---------------- facing
    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (this.rolling > 0) this.facing = Math.atan2(this.rollDir.x, this.rollDir.y);
    else if (len > 0 && this.burning <= 0) this.facing = angleLerp(this.facing, Math.atan2(dx, dz), damp(this.onGround ? 14 : 6, dt));
    this.root.position.copy(this.pos);
    this.root.rotation.y = this.facing;

    // footsteps
    if (this.onGround && hs > 1 && this.rolling <= 0) {
      this.stepTimer -= dt * hs;
      if (this.stepTimer <= 0) { sfx.step(); this.stepTimer = 1.6; }
    }

    this.animate(dt, hs);
    this.mixer.update(dt);
    return event;
  }

  animate(dt, hs) {
    this.jumpTimer -= dt;
    this.landTimer -= dt;
    this.waving -= dt;
    let name, ts = 1;
    if (this.burning > 0) {
      name = 'fall';
    } else if (this.rolling > 0) {
      name = 'roll'; ts = 1.45;
    } else if (!this.onGround) {
      name = this.jumpTimer > 0 ? 'jump' : 'fall';
    } else if (this.landTimer > 0 && hs < 1) {
      name = 'land'; ts = 1.7;
    } else if (this.crouch) {
      name = hs > 0.3 ? 'crouchWalk' : 'crouchIdle';
      if (name === 'crouchWalk') ts = clamp(hs / CLIP_SPEED.crouchWalk, 0.6, 1.6);
    } else if (hs < 0.4) {
      name = this.waving > 0 ? 'wave' : 'idle';
    } else if (hs < 3.0) {
      name = 'walk'; ts = clamp(hs / CLIP_SPEED.walk, 0.7, 1.8);
    } else if (hs < 6.6) {
      name = 'run'; ts = clamp(hs / CLIP_SPEED.run, 0.7, 1.5);
    } else {
      name = 'sprint'; ts = clamp(hs / CLIP_SPEED.sprint, 0.8, 1.4);
    }
    const opts = { timeScale: ts };
    if (name === 'jump') Object.assign(opts, { once: true, at: this.jumpStart || 0, timeScale: 1.3 });
    if (name === 'land' || name === 'roll') opts.once = true;
    if (name === 'wave') opts.once = false;
    const fade = name === 'jump' ? 0.08 : name === 'fall' && this.current === 'jump' ? 0.35 : 0.18;
    this.play(name, fade, opts);
    if (this.current === name && !opts.once) this.actions[name].setEffectiveTimeScale(ts);
  }
}
