import * as THREE from 'three';
import { mulberry32, clamp, glowTexture } from './util.js';

export const LAVA_Y = 0;
const PLATFORM_BOTTOM = -5;

/* ------------------------------------------------------------------ lava */
const lavaVert = /* glsl */ `
uniform float uTime;
varying vec3 vWorld;
#include <fog_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  wp.y += sin(wp.x * 0.35 + uTime * 0.9) * 0.05 + cos(wp.z * 0.3 + uTime * 0.7) * 0.05;
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const lavaFrag = /* glsl */ `
uniform float uTime;
varying vec3 vWorld;
#include <fog_pars_fragment>
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = m * p; a *= 0.5; }
  return v;
}
void main() {
  float t = uTime;
  vec2 p = vWorld.xz * 0.13;
  vec2 q = vec2(fbm(p + vec2(0.0, t * 0.06)), fbm(p + vec2(5.2, 1.3) - vec2(t * 0.05, 0.0)));
  float n = fbm(p * 1.6 + q * 2.2 + vec2(t * 0.03, -t * 0.025));
  float ridge = pow(1.0 - abs(fbm(p * 3.1 - q + t * 0.02) * 2.0 - 1.0), 8.0);
  vec3 crust = vec3(0.09, 0.02, 0.012);
  vec3 hot = vec3(1.0, 0.24, 0.02) * 0.95;
  vec3 core = vec3(1.0, 0.62, 0.2) * 1.9;
  float heat = smoothstep(0.42, 0.7, n);
  vec3 col = mix(crust, hot, max(heat, ridge * 0.85));
  col = mix(col, core, smoothstep(0.66, 0.86, n));
  col *= 0.85 + 0.15 * sin(t * 1.6 + n * 14.0);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

/** Adds a glow to any standard material where it is close to the lava surface. */
export function addLavaGlow(mat, strength = 1.6) {
  mat.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vWY;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWY = (modelMatrix * vec4(transformed, 1.0)).y;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vWY;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float lg = smoothstep(0.8, -0.05, vWY);
        totalEmissiveRadiance += vec3(1.0, 0.25, 0.03) * lg * lg * lg * ${strength.toFixed(2)};`);
  };
  mat.customProgramCacheKey = () => 'lavaglow' + strength;
  return mat;
}

/* ------------------------------------------------------------------ environment (built once) */
export function createEnvironment(scene, assets) {
  const env = { uniforms: { uTime: { value: 0 } } };

  const lavaMat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 } }]),
    vertexShader: lavaVert,
    fragmentShader: lavaFrag,
    fog: true,
  });
  env.lavaMat = lavaMat;
  const lava = new THREE.Mesh(new THREE.PlaneGeometry(500, 500, 220, 220).rotateX(-Math.PI / 2), lavaMat);
  lava.position.y = LAVA_Y;
  scene.add(lava);

  // Lights
  const hemi = new THREE.HemisphereLight(0xffd2a8, 0xff4a12, 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffc48a, 2.6);
  sun.position.set(-30, 40, -20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -22; sc.right = 22; sc.top = 22; sc.bottom = -22; sc.near = 1; sc.far = 120;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  env.sun = sun;
  env.sunOffset = sun.position.clone();

  // Distant volcanoes
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x2a201c, roughness: 1, map: assets.rock.map, normalMap: assets.rock.normal });
  addLavaGlow(rockMat, 2.2);
  const rng = mulberry32(7);
  const smokeTex = glowTexture(THREE, 'rgba(60,50,48,0.9)', 'rgba(40,35,35,0)');
  const smokeMat = new THREE.SpriteMaterial({ map: smokeTex, transparent: true, depthWrite: false, opacity: 0.5, fog: true });
  env.smoke = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + rng() * 0.6;
    const d = 115 + rng() * 45;
    const h = 30 + rng() * 30, r = 35 + rng() * 25;
    const g = new THREE.ConeGeometry(r, h, 48, 12, true);
    const pos = g.attributes.position;
    for (let v = 0; v < pos.count; v++) {
      const y = pos.getY(v);
      const t = (y + h / 2) / h; // 0 bottom .. 1 top
      const ang = Math.atan2(pos.getZ(v), pos.getX(v));
      const k = 1 + 0.18 * Math.sin(ang * 5 + i) * (1 - t) + 0.08 * Math.sin(ang * 13 + y);
      pos.setX(v, pos.getX(v) * k); pos.setZ(v, pos.getZ(v) * k);
      if (t > 0.92) pos.setY(v, y - h * 0.06); // crater lip
    }
    g.computeVertexNormals();
    const cone = new THREE.Mesh(g, rockMat);
    cone.position.set(Math.cos(a) * d, h / 2 - 3, Math.sin(a) * d);
    scene.add(cone);
    // crater glow
    const crater = new THREE.Mesh(new THREE.CircleGeometry(r * 0.12, 24).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.8, 0.15), fog: false }));
    crater.position.set(cone.position.x, h - 3 - h * 0.08, cone.position.z);
    scene.add(crater);
    for (let s = 0; s < 6; s++) {
      const sp = new THREE.Sprite(smokeMat);
      sp.userData = { base: crater.position.clone(), phase: rng() * 10, speed: 0.08 + rng() * 0.05 };
      scene.add(sp); env.smoke.push(sp);
    }
  }

  // Embers drifting up from the lava around the player
  const EMBERS = 500;
  const eg = new THREE.BufferGeometry();
  const ep = new Float32Array(EMBERS * 3);
  env.emberVel = new Float32Array(EMBERS);
  for (let i = 0; i < EMBERS; i++) {
    ep[i * 3] = (Math.random() - 0.5) * 60; ep[i * 3 + 1] = Math.random() * 12; ep[i * 3 + 2] = (Math.random() - 0.5) * 60;
    env.emberVel[i] = 0.6 + Math.random() * 1.8;
  }
  eg.setAttribute('position', new THREE.BufferAttribute(ep, 3));
  const embers = new THREE.Points(eg, new THREE.PointsMaterial({
    map: glowTexture(THREE, 'rgba(255,170,60,1)', 'rgba(255,60,0,0)'), size: 0.18, color: new THREE.Color(2.5, 1.2, 0.4),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  embers.frustumCulled = false;
  scene.add(embers);
  env.embers = embers;

  // Lava bubbles that pop near the player
  env.bubbles = [];
  const bubbleMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 0.55, 0.08) });
  const bubbleGeo = new THREE.SphereGeometry(1, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  for (let i = 0; i < 18; i++) {
    const b = new THREE.Mesh(bubbleGeo, bubbleMat);
    b.visible = false;
    b.userData = { t: Math.random() * 3, life: 1, size: 0.3 };
    scene.add(b); env.bubbles.push(b);
  }

  env.update = (time, dt, focus, level) => {
    lavaMat.uniforms.uTime.value = time;
    sun.position.copy(focus).add(env.sunOffset);
    sun.target.position.copy(focus);

    const arr = eg.attributes.position.array;
    for (let i = 0; i < EMBERS; i++) {
      const ix = i * 3;
      arr[ix + 1] += env.emberVel[i] * dt;
      arr[ix] += Math.sin(time * 0.7 + i) * 0.3 * dt;
      if (arr[ix + 1] > 14 || Math.abs(arr[ix] - focus.x) > 32 || Math.abs(arr[ix + 2] - focus.z) > 32) {
        arr[ix] = focus.x + (Math.random() - 0.5) * 60;
        arr[ix + 2] = focus.z + (Math.random() - 0.5) * 60;
        arr[ix + 1] = 0;
      }
    }
    eg.attributes.position.needsUpdate = true;

    for (const b of env.bubbles) {
      const u = b.userData;
      u.t += dt;
      if (u.t > u.life) {
        // respawn somewhere on open lava
        for (let k = 0; k < 6; k++) {
          const x = focus.x + (Math.random() - 0.5) * 40, z = focus.z + (Math.random() - 0.5) * 40;
          if (!level || !level.platforms.some((p) => p.contains(x, z, 0.6))) { b.position.set(x, LAVA_Y - 0.05, z); break; }
        }
        u.t = 0; u.life = 0.6 + Math.random() * 1.4; u.size = 0.15 + Math.random() * 0.45;
        b.visible = true;
      }
      const k = u.t / u.life;
      const s = u.size * Math.sin(Math.min(k, 1) * Math.PI) ;
      b.scale.set(s, s * 0.8, s);
    }

    for (const sp of env.smoke) {
      const u = sp.userData;
      const k = ((time * u.speed + u.phase) % 1);
      sp.position.set(u.base.x + Math.sin(u.phase + k * 3) * 6 * k, u.base.y + k * 45, u.base.z + k * 10);
      const s = 8 + k * 30;
      sp.scale.set(s, s, 1);
      sp.material.opacity = 0.45;
    }
  };
  return env;
}

/* ------------------------------------------------------------------ platforms */
export class Platform {
  constructor(o) {
    Object.assign(this, {
      shape: 'cyl', x: 0, z: 0, r: 1.5, w: 2, d: 2, rotY: 0, top: 1, kind: 'static',
      axis: null, amp: 0, speed: 0, phase: 0,
    }, o);
    this.baseX = this.x; this.baseZ = this.z; this.baseTop = this.top;
    this.dx = 0; this.dz = 0; this.dtop = 0;
    this.active = true;
    this.state = 'idle'; this.timer = 0; this.fallV = 0;
    this.cos = Math.cos(this.rotY); this.sin = Math.sin(this.rotY);
    this.edgeR = this.shape === 'cyl' ? this.r : Math.min(this.w, this.d) / 2;
    this.boundR = this.shape === 'cyl' ? this.r : Math.hypot(this.w, this.d) / 2;
    this.spaceR = this.boundR + this.amp;
  }

  local(px, pz) {
    const dx = px - this.x, dz = pz - this.z;
    return [dx * this.cos - dz * this.sin, dx * this.sin + dz * this.cos];
  }

  contains(px, pz, margin = 0) {
    if (!this.active) return false;
    if (this.shape === 'cyl') return Math.hypot(px - this.x, pz - this.z) <= this.r + margin;
    const [lx, lz] = this.local(px, pz);
    return Math.abs(lx) <= this.w / 2 + margin && Math.abs(lz) <= this.d / 2 + margin;
  }

  /** Pushes a circle (pos.x, pos.z, radius) out of this platform's footprint. */
  pushOut(pos, radius) {
    if (!this.active) return false;
    if (this.shape === 'cyl') {
      const dx = pos.x - this.x, dz = pos.z - this.z;
      const d = Math.hypot(dx, dz), min = this.r + radius;
      if (d >= min) return false;
      const nx = d > 1e-5 ? dx / d : 1, nz = d > 1e-5 ? dz / d : 0;
      pos.x = this.x + nx * min; pos.z = this.z + nz * min;
      return true;
    }
    const [lx, lz] = this.local(pos.x, pos.z);
    const hw = this.w / 2, hd = this.d / 2;
    const cx = clamp(lx, -hw, hw), cz = clamp(lz, -hd, hd);
    let ox = lx - cx, oz = lz - cz;
    const d = Math.hypot(ox, oz);
    let nlx, nlz;
    if (d > 1e-5) {
      if (d >= radius) return false;
      nlx = cx + (ox / d) * radius; nlz = cz + (oz / d) * radius;
    } else {
      // centre is inside the box: exit along the shallowest axis
      const ex = hw - Math.abs(lx), ez = hd - Math.abs(lz);
      if (ex < ez) { nlx = Math.sign(lx || 1) * (hw + radius); nlz = lz; } else { nlx = lx; nlz = Math.sign(lz || 1) * (hd + radius); }
    }
    // back to world
    pos.x = this.x + nlx * this.cos + nlz * this.sin;
    pos.z = this.z - nlx * this.sin + nlz * this.cos;
    return true;
  }

  stand(sfx) {
    if (this.kind === 'crumble' && this.state === 'idle') {
      this.state = 'shaking'; this.timer = 0;
      sfx?.crumble();
    }
  }

  update(time, dt) {
    const px = this.x, pz = this.z, pt = this.top;
    if (this.kind === 'moving') {
      const s = Math.sin(time * this.speed + this.phase) * this.amp;
      this.x = this.baseX + this.axis.x * s;
      this.z = this.baseZ + this.axis.y * s;
    }
    if (this.kind === 'crumble') {
      this.timer += dt;
      const m = this.mesh.material;
      if (this.state === 'idle') {
        m.emissiveIntensity = 0.25 + 0.1 * Math.sin(time * 2 + this.phase);
      } else if (this.state === 'shaking') {
        m.emissiveIntensity = 0.6 + 0.6 * Math.abs(Math.sin(this.timer * 18));
        this.mesh.position.x = this.x + (Math.random() - 0.5) * 0.08;
        this.mesh.position.z = this.z + (Math.random() - 0.5) * 0.08;
        if (this.timer > 0.85) { this.state = 'falling'; this.timer = 0; this.fallV = 0; }
      } else if (this.state === 'falling') {
        this.fallV = Math.min(this.fallV + 7 * dt, 5);
        this.top -= this.fallV * dt;
        m.emissiveIntensity = 1.2;
        if (this.top < LAVA_Y - 4) { this.state = 'gone'; this.timer = 0; this.active = false; this.mesh.visible = false; }
      } else if (this.state === 'gone') {
        if (this.timer > 4) { this.state = 'rising'; this.timer = 0; this.mesh.visible = true; }
      } else if (this.state === 'rising') {
        this.top = Math.min(this.baseTop, this.top + 4 * dt);
        if (this.top >= this.baseTop - 0.6) this.active = true;
        if (this.top >= this.baseTop) { this.top = this.baseTop; this.state = 'idle'; }
      }
    }
    this.dx = this.x - px; this.dz = this.z - pz; this.dtop = this.top - pt;
    if (this.mesh && this.state !== 'shaking') {
      this.mesh.position.x = this.x; this.mesh.position.z = this.z;
    }
    if (this.mesh) this.mesh.position.y = this.top - this.height / 2;
  }
}

function buildPlatformMesh(p, mats, rng) {
  const height = p.top - PLATFORM_BOTTOM;
  p.height = height;
  let g;
  if (p.shape === 'cyl') {
    g = new THREE.CylinderGeometry(p.r, p.r * 1.22, height, 28, 6);
  } else {
    g = new THREE.BoxGeometry(p.w, height, p.d, 4, 6, 4);
  }
  const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv;
  const half = height / 2;
  for (let i = 0; i < pos.count; i++) {
    const ny = nor.getY(i);
    const y = pos.getY(i);
    if (Math.abs(ny) > 0.9) {
      // caps: world-ish UVs
      uv.setXY(i, pos.getX(i) / 2.5, pos.getZ(i) / 2.5);
    } else {
      const circ = p.shape === 'cyl' ? (Math.PI * 2 * p.r) / 3 : Math.max(p.w, p.d) / 2.5;
      uv.setXY(i, uv.getX(i) * circ, (y + half) / 2.5);
      // roughen the sides below the lip so pillars look like rock
      if (y < half - 0.15) {
        const j = 1 + (rng() - 0.5) * 0.12;
        pos.setX(i, pos.getX(i) * j); pos.setZ(i, pos.getZ(i) * j);
      }
    }
  }
  g.computeVertexNormals();
  const mat = p.kind === 'crumble' ? mats.crumble.clone() : p.kind === 'moving' ? mats.moving : p.kind === 'start' ? mats.start : mats.rock;
  if (p.kind === 'crumble') addLavaGlow(mat, 1.6);
  const mesh = new THREE.Mesh(g, mat);
  mesh.rotation.y = p.rotY;
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.position.set(p.x, p.top - half, p.z);
  p.mesh = mesh;
  // a darker rim ring on the moving platforms so they read differently
  if (p.kind === 'moving') {
    const rim = new THREE.Mesh(
      p.shape === 'cyl' ? new THREE.TorusGeometry(p.r - 0.05, 0.07, 6, 32).rotateX(Math.PI / 2) : new THREE.BoxGeometry(p.w + 0.1, 0.12, p.d + 0.1),
      new THREE.MeshStandardMaterial({ color: 0x6fd6ff, emissive: 0x2aa8ff, emissiveIntensity: 1.6 }),
    );
    rim.position.y = half - 0.04;
    mesh.add(rim);
  }
  return mesh;
}

/* ------------------------------------------------------------------ apples */
function makeApple(assets, golden) {
  const a = assets.apple.clone(true);
  if (golden) {
    a.traverse((o) => {
      if (o.isMesh) o.material = assets.goldMat;
    });
  }
  const g = new THREE.Group();
  g.add(a);
  const glow = new THREE.Sprite(golden ? assets.goldGlow : assets.appleGlow);
  glow.scale.setScalar(golden ? 1.4 : 1.0);
  glow.position.y = 0.05;
  g.add(glow);
  g.userData.golden = golden;
  return g;
}

/* ------------------------------------------------------------------ level */
export function buildLevel(round, assets, seed) {
  const rng = mulberry32(seed);
  const R = (a, b) => a + (b - a) * rng();
  const group = new THREE.Group();

  const N = 46 + round * 6;
  const worldR = 44 + round * 4;
  const gapMax = Math.min(2.4 + round * 0.15, 3.1);
  const crumbleP = Math.min(0.1 + round * 0.05, 0.35);
  const movingP = Math.min(0.07 + round * 0.03, 0.2);

  const start = new Platform({ shape: 'cyl', x: 0, z: 0, r: 5, top: 0.9, kind: 'start' });
  const plats = [start];
  const links = [];
  let tries = 0;
  while (plats.length < N && tries < 8000) {
    tries++;
    const bases = plats.filter((p) => p.kind !== 'moving');
    const base = rng() < 0.55 ? bases[Math.max(0, bases.length - 1 - Math.floor(rng() * 5))] : bases[Math.floor(rng() * bases.length)];
    const isBox = rng() < 0.3;
    const o = { shape: isBox ? 'box' : 'cyl' };
    if (isBox) { o.w = R(1.6, 3.8); o.d = R(1.6, 3.8); o.rotY = R(0, Math.PI); } else { o.r = R(0.9, 2.3); }
    const roll = rng();
    o.kind = roll < movingP ? 'moving' : roll < movingP + crumbleP ? 'crumble' : 'static';
    const edgeR = isBox ? Math.min(o.w, o.d) / 2 : o.r;
    const ang = R(0, Math.PI * 2);
    let dist;
    if (o.kind === 'moving') {
      o.amp = R(1.5, 3.0);
      o.axis = new THREE.Vector2(Math.cos(ang), Math.sin(ang));
      o.speed = R(0.5, 0.9); o.phase = R(0, 6.28);
      dist = base.edgeR + edgeR + o.amp + R(0.7, 1.4);
    } else {
      dist = base.edgeR + edgeR + R(1.0, gapMax);
    }
    o.x = base.x + Math.cos(ang) * dist;
    o.z = base.z + Math.sin(ang) * dist;
    if (Math.hypot(o.x, o.z) > worldR) continue;
    o.top = clamp(base.top + R(-0.7, 0.95), 0.45, 3.6);
    const p = new Platform(o);
    let ok = true;
    for (const q of plats) {
      if (Math.hypot(p.x - q.x, p.z - q.z) < p.spaceR + q.spaceR + 0.9) { ok = false; break; }
    }
    if (!ok) continue;
    plats.push(p);
    links.push([base, p]);
  }

  const mats = assets.platformMats;
  for (const p of plats) {
    p.phase = p.phase || R(0, 6.28);
    group.add(buildPlatformMesh(p, mats, rng));
  }

  // Apples
  const apples = [];
  const addApple = (x, y, z, golden, plat = null) => {
    const a = makeApple(assets, golden);
    a.position.set(x, y, z);
    a.userData.baseY = y;
    a.userData.plat = plat;
    a.userData.off = plat ? new THREE.Vector2(x - plat.x, z - plat.z) : null;
    a.userData.spin = R(0, 6.28);
    group.add(a);
    apples.push(a);
  };
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 2; // ring in front of the spawn point
    addApple(Math.cos(a) * 2.6, start.top + 0.8, Math.sin(a) * 2.6 + 1.2, false);
  }
  const tallest = [...plats].sort((a, b) => b.top - a.top).slice(0, 2);
  for (const p of plats) {
    if (p === start) continue;
    if (p.kind === 'moving') { addApple(p.x, p.top + 0.8, p.z, true, p); continue; }
    if (tallest.includes(p)) { addApple(p.x, p.top + 0.8, p.z, true); continue; }
    if (rng() < 0.62) addApple(p.x, p.top + 0.8, p.z, false);
  }
  for (const [a, b] of links) {
    if (b.kind === 'moving' || rng() > 0.16) continue;
    const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
    const mid = (a.edgeR + (d - a.edgeR - b.edgeR) / 2) / d;
    addApple(a.x + dx * mid, Math.max(a.top, b.top) + 1.25, a.z + dz * mid, false);
  }

  return { group, platforms: plats, apples, start };
}
