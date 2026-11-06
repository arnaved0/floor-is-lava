const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ControlLeft', 'ControlRight', 'KeyC',
  'ShiftLeft', 'ShiftRight', 'KeyQ', 'KeyE', 'KeyM', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

export class Input {
  constructor(lockTarget) {
    this.lockTarget = lockTarget;
    this.keys = new Set();
    this.pressed = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.enabled = false;

    addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      // Stop the browser acting on Ctrl+<key> combos (select-all, bookmark, ...) while playing.
      if (GAME_KEYS.has(e.code) || e.ctrlKey) e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });
    addEventListener('blur', () => this.keys.clear());
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === this.lockTarget) {
        this.mouseDX += e.movementX;
        this.mouseDY += e.movementY;
      }
    });
    addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      this.wheel += Math.sign(e.deltaY);
    }, { passive: true });
  }

  down(...codes) { return codes.some((c) => this.keys.has(c)); }
  hit(...codes) { return codes.some((c) => this.pressed.has(c)); }

  endFrame() {
    this.pressed.clear();
    this.mouseDX = this.mouseDY = this.wheel = 0;
  }

  reset() { this.keys.clear(); this.endFrame(); }
}
