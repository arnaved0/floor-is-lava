import * as THREE from 'three';
import { clamp, damp } from './util.js';

/** Mouse-orbit third person camera. yaw = PI puts the camera behind a player facing +Z. */
export class ThirdPersonCamera {
  constructor(camera) {
    this.camera = camera;
    this.yaw = Math.PI;
    this.pitch = 0.32;
    this.dist = 5.5;
    this.targetDist = 5.5;
    this.target = new THREE.Vector3();
    this.sensitivity = 0.0024;
    this.shake = 0;
  }

  /** Horizontal forward/right vectors for camera-relative movement. */
  basis() {
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    return { fx, fz, rx: -fz, rz: fx };
  }

  snap(focus) {
    this.target.copy(focus);
    this.update(1, focus, null, true);
  }

  update(dt, focus, input, instant = false) {
    if (input) {
      this.yaw -= input.mouseDX * this.sensitivity;
      this.pitch = clamp(this.pitch + input.mouseDY * this.sensitivity, -0.35, 1.25);
      if (input.down('ArrowLeft')) this.yaw += 2.2 * dt;
      if (input.down('ArrowRight')) this.yaw -= 2.2 * dt;
      if (input.down('ArrowUp')) this.pitch = clamp(this.pitch + 1.2 * dt, -0.35, 1.25);
      if (input.down('ArrowDown')) this.pitch = clamp(this.pitch - 1.2 * dt, -0.35, 1.25);
      this.targetDist = clamp(this.targetDist + input.wheel * 0.6, 2.5, 11);
    }
    const k = instant ? 1 : damp(12, dt);
    this.target.lerp(focus, k);
    this.dist += (this.targetDist - this.dist) * (instant ? 1 : damp(8, dt));

    const cp = Math.cos(this.pitch);
    const off = new THREE.Vector3(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp).multiplyScalar(this.dist);
    const pos = this.target.clone().add(off);
    pos.y = Math.max(pos.y, 0.7); // never dip into the lava
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt);
      const s = this.shake * 0.25;
      pos.x += (Math.random() - 0.5) * s; pos.y += (Math.random() - 0.5) * s; pos.z += (Math.random() - 0.5) * s;
    }
    this.camera.position.copy(pos);
    this.camera.lookAt(this.target);
  }
}
