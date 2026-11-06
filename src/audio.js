/** All sound is synthesised with WebAudio, so there are no audio files to load. */
export class Sfx {
  constructor() {
    this.ctx = null;
    this.muted = localStorage.getItem('lava.muted') === '1';
  }

  init() {
    if (this.ctx) { this.ctx.resume(); return; }
    const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.7;
    this.master.connect(ctx.destination);

    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      // brown-ish noise
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }
    this.whiteBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const w = this.whiteBuf.getChannelData(0);
    for (let i = 0; i < len; i++) w[i] = Math.random() * 2 - 1;

    // Lava ambience: low rumbling noise with a slow wobble
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf; src.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 260;
    const g = ctx.createGain(); g.gain.value = 0.22;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.15;
    const lfoG = ctx.createGain(); lfoG.gain.value = 120;
    lfo.connect(lfoG).connect(lp.frequency);
    src.connect(lp).connect(g).connect(this.master);
    src.start(); lfo.start();
    this.ambience = g;

    const bubble = () => {
      if (!this.muted) this.blub();
      setTimeout(bubble, 300 + Math.random() * 1400);
    };
    bubble();
  }

  setMuted(m) {
    this.muted = m;
    localStorage.setItem('lava.muted', m ? '1' : '0');
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.7, this.ctx.currentTime, 0.05);
  }

  tone(freq, dur, { type = 'sine', vol = 0.25, to = null, delay = 0, attack = 0.005 } = {}) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + dur + 0.05);
  }

  noise(dur, freq, { vol = 0.25, type = 'lowpass', delay = 0, white = true, q = 1, to = null } = {}) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const s = this.ctx.createBufferSource();
    s.buffer = white ? this.whiteBuf : this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (to) f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(this.master);
    s.start(t, Math.random()); s.stop(t + dur + 0.05);
  }

  blub() { const f = 70 + Math.random() * 90; this.tone(f, 0.18, { vol: 0.12, to: f * 2.2 }); }
  pickup(golden) {
    const notes = golden ? [784, 988, 1175, 1568] : [880, 1319];
    notes.forEach((n, i) => this.tone(n, 0.25, { type: 'triangle', vol: 0.22, delay: i * 0.06 }));
    this.tone(notes[notes.length - 1] * 2, 0.4, { vol: 0.05, delay: notes.length * 0.06 });
  }
  jump() { this.noise(0.18, 700, { vol: 0.18, type: 'bandpass', to: 2200, q: 2 }); }
  land(hard) { this.noise(hard ? 0.25 : 0.1, hard ? 260 : 500, { vol: hard ? 0.5 : 0.18 }); }
  step() { this.noise(0.05, 1800, { vol: 0.05, type: 'bandpass', q: 3 }); }
  roll() { this.noise(0.4, 400, { vol: 0.2, type: 'bandpass', to: 1400 }); }
  burn() {
    this.noise(1.1, 3000, { vol: 0.45, type: 'bandpass', to: 500, q: 0.7 });
    this.tone(220, 0.7, { type: 'sawtooth', vol: 0.12, to: 55 });
  }
  crumble() { this.noise(0.9, 180, { vol: 0.45, white: false, type: 'lowpass' }); }
  clear() { [523, 659, 784, 1047, 1319].forEach((n, i) => this.tone(n, 0.35, { type: 'triangle', vol: 0.2, delay: i * 0.1 })); }
  gameOver() { [392, 330, 262, 196].forEach((n, i) => this.tone(n, 0.5, { type: 'sawtooth', vol: 0.1, delay: i * 0.2 })); }
  click() { this.tone(660, 0.08, { type: 'square', vol: 0.06 }); }
}
