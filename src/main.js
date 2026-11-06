import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import './style.css';
import { Input } from './input.js';
import { Sfx } from './audio.js';
import { ThirdPersonCamera } from './camera.js';
import { createEnvironment, buildLevel, addLavaGlow } from './world.js';
import { Player } from './player.js';
import { glowTexture } from './util.js';

const $ = (id) => document.getElementById(id);
const BASE = import.meta.env.BASE_URL;

/* ------------------------------------------------------------------ renderer */
const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x6a2a18, 0.011);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 600);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), 0.4, 0.35, 1.0);
composer.addPass(bloom);
composer.addPass(new OutputPass());

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

/* ------------------------------------------------------------------ loading */
const manager = new THREE.LoadingManager();
manager.onProgress = (_url, done, total) => { $('load-bar').style.width = `${(done / total) * 100}%`; };
const gltfLoader = new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder);
const texLoader = new THREE.TextureLoader(manager);
const loadGLTF = (u) => new Promise((res, rej) => gltfLoader.load(BASE + u, res, undefined, rej));
const loadTex = (u, srgb) => new Promise((res, rej) => texLoader.load(BASE + u, (t) => {
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  res(t);
}, undefined, rej));
const loadHDR = (u) => new Promise((res, rej) => new HDRLoader(manager).load(BASE + u, res, undefined, rej));

const [playerGltf, appleGltf, rockMap, rockNormal, rockRough, sky] = await Promise.all([
  loadGLTF('models/player.glb'),
  loadGLTF('models/apple.glb'),
  loadTex('textures/rock_diff.jpg', true),
  loadTex('textures/rock_nor.jpg'),
  loadTex('textures/rock_rough.jpg'),
  loadHDR('textures/sky.hdr'),
]).catch((e) => {
  $('load-text').textContent = 'Failed to load assets: ' + e.message;
  throw e;
});

sky.mapping = THREE.EquirectangularReflectionMapping;
scene.background = sky;
scene.backgroundIntensity = 0.32;
scene.backgroundBlurriness = 0.05;
scene.environment = sky;
scene.environmentIntensity = 0.45;

/* ------------------------------------------------------------------ shared assets */
const apple = appleGltf.scene;
{
  const box = new THREE.Box3().setFromObject(apple);
  const size = box.getSize(new THREE.Vector3());
  const s = 0.42 / size.y;
  apple.scale.setScalar(s);
  const c = box.getCenter(new THREE.Vector3()).multiplyScalar(s);
  apple.position.sub(c);
  apple.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.material.emissive = new THREE.Color(0x330000); } });
}
const wrap = new THREE.Group(); wrap.add(apple);

const rockMat = new THREE.MeshStandardMaterial({ map: rockMap, normalMap: rockNormal, roughnessMap: rockRough, color: 0x8a7a70, roughness: 1 });
addLavaGlow(rockMat, 1.4);
const startMat = rockMat.clone(); startMat.color.set(0xa89a88); addLavaGlow(startMat, 1.4);
const movingMat = rockMat.clone(); movingMat.color.set(0x7a8ea0); addLavaGlow(movingMat, 1.4);
const crumbleMat = new THREE.MeshStandardMaterial({ map: rockMap, normalMap: rockNormal, color: 0xc07050, roughness: 1, emissive: 0xff3a00, emissiveMap: rockRough, emissiveIntensity: 0.3 });

const assets = {
  apple: wrap,
  goldMat: new THREE.MeshStandardMaterial({ color: 0xffc23a, metalness: 1, roughness: 0.22, emissive: 0x6a3a00, emissiveIntensity: 0.6 }),
  appleGlow: new THREE.SpriteMaterial({ map: glowTexture(THREE, 'rgba(255,90,70,0.55)', 'rgba(255,60,40,0)'), depthWrite: false, transparent: true, blending: THREE.AdditiveBlending }),
  goldGlow: new THREE.SpriteMaterial({ map: glowTexture(THREE, 'rgba(255,210,80,0.85)', 'rgba(255,180,40,0)'), depthWrite: false, transparent: true, blending: THREE.AdditiveBlending }),
  rock: { map: rockMap, normal: rockNormal },
  platformMats: { rock: rockMat, start: startMat, moving: movingMat, crumble: crumbleMat },
};

/* ------------------------------------------------------------------ game objects */
const env = createEnvironment(scene, assets);
const player = new Player(playerGltf, scene);
const input = new Input(canvas);
const sfx = new Sfx();
const cam = new ThirdPersonCamera(camera);

// pickup burst particles
const burstTex = glowTexture(THREE, 'rgba(255,240,180,1)', 'rgba(255,200,80,0)');
const bursts = [];
function burst(pos, golden) {
  const n = 18;
  const g = new THREE.BufferGeometry();
  const p = new Float32Array(n * 3), v = [];
  for (let i = 0; i < n; i++) {
    p.set([pos.x, pos.y, pos.z], i * 3);
    v.push(new THREE.Vector3((Math.random() - 0.5) * 5, Math.random() * 5, (Math.random() - 0.5) * 5));
  }
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  const m = new THREE.PointsMaterial({ map: burstTex, size: golden ? 0.35 : 0.25, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    color: golden ? new THREE.Color(3, 2.2, 0.6) : new THREE.Color(3, 0.6, 0.4) });
  const pts = new THREE.Points(g, m);
  scene.add(pts);
  bursts.push({ pts, v, life: 0.8 });
}

/* ------------------------------------------------------------------ game state */
const game = {
  state: 'loading', round: 1, score: 0, lives: 3, time: 0, level: null,
  collected: 0, best: Number(localStorage.getItem('lava.best') || 0),
};

function startRound(round) {
  if (game.level) {
    scene.remove(game.level.group);
    game.level.group.traverse((o) => { if (o.isMesh && o.geometry) o.geometry.dispose(); });
  }
  game.round = round;
  game.level = buildLevel(round, assets, (Date.now() ^ (round * 7919)) >>> 0);
  scene.add(game.level.group);
  game.collected = 0;
  game.time = 0;
  const s = game.level.start;
  player.reset(new THREE.Vector3(0, s.top, -2.2), s);
  cam.yaw = Math.PI; cam.pitch = 0.32;
  cam.snap(player.focus);
  updateHud();
  toast(`Round ${round}`, 'Collect every apple. Don’t touch the lava!');
}

function newGame() {
  game.score = 0; game.lives = 3;
  startRound(1);
}

/* ------------------------------------------------------------------ HUD */
function updateHud() {
  $('score').textContent = game.score;
  $('apples').textContent = `${game.collected} / ${game.level ? game.level.apples.length + game.collected : 0}`;
  $('round').textContent = `Round ${game.round}`;
  const heart = '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-10-9.3C.3 8.4 2.2 4 6.3 4c2.3 0 3.8 1.3 5.7 3.4C13.9 5.3 15.4 4 17.7 4 21.8 4 23.7 8.4 22 11.7 19.5 16.4 12 21 12 21z"/></svg>';
  $('hearts').innerHTML = Array.from({ length: 3 }, (_, i) => `<span class="${i < game.lives ? 'on' : ''}">${heart}</span>`).join('');
  $('best').textContent = game.best;
}

let toastTimer;
function toast(title, sub = '') {
  const t = $('toast');
  t.innerHTML = `<b>${title}</b>${sub ? `<small>${sub}</small>` : ''}`;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

const projV = new THREE.Vector3();
function popup(text, worldPos, cls = '') {
  projV.copy(worldPos).project(camera);
  if (projV.z > 1) return;
  const el = document.createElement('div');
  el.className = `popup ${cls}`;
  el.textContent = text;
  el.style.left = `${(projV.x * 0.5 + 0.5) * innerWidth}px`;
  el.style.top = `${(-projV.y * 0.5 + 0.5) * innerHeight}px`;
  $('hud').appendChild(el);
  setTimeout(() => el.remove(), 1000);
}

function showScreen(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('show', s.id === id);
  $('hud').classList.toggle('show', id === null || id === 'pause');
}

/* ------------------------------------------------------------------ pointer lock / flow */
async function lockAndPlay() {
  sfx.init();
  sfx.click();
  if ($('opt-fullscreen').checked && !document.fullscreenElement) {
    try {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      // Keyboard Lock (Chromium, fullscreen only) lets Ctrl+W etc. reach the game instead of closing the tab.
      await navigator.keyboard?.lock?.();
    } catch { /* not supported – fine */ }
  }
  try { await canvas.requestPointerLock({ unadjustedMovement: true }); }
  catch { try { await canvas.requestPointerLock(); } catch { /* ignore, mouse orbit disabled */ } }
}

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  if (locked) {
    if (game.state === 'menu' || game.state === 'over') newGame();
    if (game.state === 'clear') startRound(game.round + 1);
    game.state = 'playing';
    input.enabled = true;
    showScreen(null);
  } else if (game.state === 'playing') {
    pause();
  }
});

function pause() {
  game.state = 'paused';
  input.enabled = false; input.reset();
  showScreen('pause');
}

for (const id of ['btn-play', 'btn-resume', 'btn-again', 'btn-next']) {
  $(id).addEventListener('click', lockAndPlay);
}
canvas.addEventListener('click', () => { if (game.state === 'paused') lockAndPlay(); });

$('btn-mute').addEventListener('click', () => { sfx.setMuted(!sfx.muted); syncMute(); });
function syncMute() { $('btn-mute').textContent = sfx.muted ? '🔇' : '🔊'; }
syncMute();

addEventListener('beforeunload', (e) => {
  if (game.state === 'playing' || game.state === 'paused') { e.preventDefault(); e.returnValue = ''; }
});

function roundClear() {
  const bonus = Math.max(0, Math.round(240 - game.time)) * 2 + game.lives * 50;
  game.score += bonus;
  game.state = 'clear';
  sfx.clear();
  saveBest();
  $('clear-stats').innerHTML = `Time <b>${fmtTime(game.time)}</b> · Time + lives bonus <b>+${bonus}</b><br>Score <b>${game.score}</b>`;
  document.exitPointerLock();
  showScreen('clear');
}

function gameOver() {
  game.state = 'over';
  sfx.gameOver();
  const isBest = saveBest();
  $('over-stats').innerHTML = `You reached round <b>${game.round}</b><br>Score <b>${game.score}</b>${isBest ? '<br><span class="newbest">New best!</span>' : `<br>Best ${game.best}`}`;
  document.exitPointerLock();
  showScreen('over');
}

function saveBest() {
  if (game.score > game.best) {
    game.best = game.score;
    localStorage.setItem('lava.best', String(game.best));
    updateHud();
    return true;
  }
  return false;
}

const fmtTime = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

/* ------------------------------------------------------------------ loop */
const timer = new THREE.Timer();
timer.connect(document);
let elapsed = 0;
const tmp = new THREE.Vector3();

function frame(ts) {
  timer.update(ts);
  const dt = Math.min(timer.getDelta(), 1 / 30);
  elapsed += dt;
  const level = game.level;
  const playing = game.state === 'playing';

  if (playing) {
    game.time += dt;
    if (input.hit('KeyM')) { sfx.setMuted(!sfx.muted); syncMute(); }
  }

  if (level) {
    for (const p of level.platforms) p.update(elapsed, dt);
    // apples bob & spin
    for (const a of level.apples) {
      const u = a.userData;
      if (u.plat) { a.position.x = u.plat.x + u.off.x; a.position.z = u.plat.z + u.off.y; }
      a.position.y = u.baseY + Math.sin(elapsed * 2.2 + u.spin) * 0.12;
      a.children[0].rotation.y = elapsed * 1.6 + u.spin;
    }
  }

  if (level && (playing || game.state === 'menu')) {
    const ev = player.update(dt, playing ? input : null, cam, level, sfx);
    if (ev === 'burned') {
      game.lives -= 1;
      updateHud();
      if (game.lives <= 0) gameOver();
      else {
        const p = player.lastSafe && player.lastSafe.active ? player.lastSafe : level.start;
        player.reset(new THREE.Vector3(p.x, p.top, p.z), p);
        player.invuln = 1.6;
        toast('Ouch! That’s hot.', `${game.lives} ${game.lives === 1 ? 'life' : 'lives'} left`);
      }
    }
    if (playing) {
      // apple pickup
      tmp.copy(player.pos); tmp.y += 0.9;
      for (let i = level.apples.length - 1; i >= 0; i--) {
        const a = level.apples[i];
        if (a.position.distanceTo(tmp) < 1.05 && player.burning <= 0) {
          const golden = a.userData.golden;
          const pts = golden ? 50 : 10;
          game.score += pts; game.collected += 1;
          sfx.pickup(golden);
          burst(a.position, golden);
          popup(`+${pts}`, a.position, golden ? 'gold' : '');
          level.group.remove(a);
          level.apples.splice(i, 1);
          updateHud();
          if (level.apples.length === 0) roundClear();
        }
      }
    }
  }

  // camera
  if (game.state === 'menu') {
    cam.yaw += dt * 0.12;
    cam.update(dt, player.focus, null);
  } else {
    cam.update(dt, player.focus, playing ? input : null);
  }

  env.update(elapsed, dt, player.pos, level);

  for (let i = bursts.length - 1; i >= 0; i--) {
    const b = bursts[i];
    b.life -= dt;
    const arr = b.pts.geometry.attributes.position.array;
    b.v.forEach((v, j) => { v.y -= 9 * dt; arr[j * 3] += v.x * dt; arr[j * 3 + 1] += v.y * dt; arr[j * 3 + 2] += v.z * dt; });
    b.pts.geometry.attributes.position.needsUpdate = true;
    b.pts.material.opacity = Math.max(0, b.life / 0.8);
    if (b.life <= 0) { scene.remove(b.pts); b.pts.geometry.dispose(); b.pts.material.dispose(); bursts.splice(i, 1); }
  }

  // HUD: timer + nearest apple compass
  if (level && playing) {
    $('timer').textContent = fmtTime(game.time);
    let best = null, bd = Infinity;
    for (const a of level.apples) {
      const d = Math.hypot(a.position.x - player.pos.x, a.position.z - player.pos.z);
      if (d < bd) { bd = d; best = a; }
    }
    if (best) {
      const ang = Math.atan2(best.position.x - player.pos.x, best.position.z - player.pos.z);
      const camAng = Math.atan2(-Math.sin(cam.yaw), -Math.cos(cam.yaw));
      $('compass-arrow').style.transform = `rotate(${(camAng - ang) * (180 / Math.PI)}deg)`;
      $('compass-dist').textContent = `${bd.toFixed(0)} m`;
    }
    $('crouch-ind').classList.toggle('on', player.crouch);
  }

  input.endFrame();
  composer.render();
  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------ boot */
startRound(1);
$('toast').classList.remove('show');
game.state = 'menu';
$('loading').classList.add('hidden');
showScreen('menu');
updateHud();
// Small hook for automated testing (no pointer lock in headless browsers).
window.__game = {
  game, player, cam, input, startRound,
  play() { sfx.init(); newGame(); game.state = 'playing'; input.enabled = true; showScreen(null); },
};
requestAnimationFrame(frame);
