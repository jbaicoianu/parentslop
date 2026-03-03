// SlopSFX — Web Audio API sound effects for ParentSlop
// No asset files needed. Lazy AudioContext creation on first user interaction.

class SlopSFX {
  constructor() {
    this._ctx = null;
  }

  _ensureCtx() {
    if (!this._ctx) {
      this._ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this._ctx.state === "suspended") {
      this._ctx.resume();
    }
    return this._ctx;
  }

  _tone(freq, type, startTime, duration, gain = 0.18) {
    const ctx = this._ensureCtx();
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(gain, startTime);
    g.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
    osc.connect(g).connect(ctx.destination);
    osc.start(startTime);
    osc.stop(startTime + duration);
  }

  _sweep(startFreq, endFreq, type, startTime, duration, gain = 0.15) {
    const ctx = this._ensureCtx();
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(startFreq, startTime);
    osc.frequency.linearRampToValueAtTime(endFreq, startTime + duration);
    g.gain.setValueAtTime(gain, startTime);
    g.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
    osc.connect(g).connect(ctx.destination);
    osc.start(startTime);
    osc.stop(startTime + duration);
  }

  // Two ascending sine tones (C5 -> E5), 80ms each
  coin() {
    const ctx = this._ensureCtx();
    const t = ctx.currentTime;
    this._tone(523.25, "sine", t, 0.08, 0.2);        // C5
    this._tone(659.25, "sine", t + 0.08, 0.12, 0.18); // E5
  }

  // 3-note arpeggio (C5, E5, G5)
  levelUp() {
    const ctx = this._ensureCtx();
    const t = ctx.currentTime;
    this._tone(523.25, "sine", t, 0.1, 0.18);        // C5
    this._tone(659.25, "sine", t + 0.1, 0.1, 0.18);  // E5
    this._tone(783.99, "sine", t + 0.2, 0.18, 0.2);  // G5
  }

  // Low sawtooth buzz ~150Hz, 200ms
  penalty() {
    const ctx = this._ensureCtx();
    const t = ctx.currentTime;
    this._tone(150, "sawtooth", t, 0.2, 0.12);
  }

  // Sine sweep 400 -> 800Hz, 60ms pop
  grab() {
    const ctx = this._ensureCtx();
    const t = ctx.currentTime;
    this._sweep(400, 800, "sine", t, 0.06, 0.18);
  }

  // 4-note ascending fanfare
  allDone() {
    const ctx = this._ensureCtx();
    const t = ctx.currentTime;
    this._tone(523.25, "sine", t, 0.12, 0.18);         // C5
    this._tone(659.25, "sine", t + 0.12, 0.12, 0.18);  // E5
    this._tone(783.99, "sine", t + 0.24, 0.12, 0.18);  // G5
    this._tone(1046.50, "sine", t + 0.36, 0.25, 0.22); // C6
  }

  // --- Timer tick sounds (short, subtle) ---

  // Sharp high click (woodblock-style), 1200Hz triangle, 25ms
  tickClick(pitchMult = 1) {
    const ctx = this._ensureCtx();
    const t = ctx.currentTime;
    this._tone(1200 * pitchMult, "triangle", t, 0.025, 0.14);
  }

  // Gentle sine blip, 800Hz, 30ms, low gain
  tickSoft(pitchMult = 1) {
    const ctx = this._ensureCtx();
    const t = ctx.currentTime;
    this._tone(800 * pitchMult, "sine", t, 0.03, 0.08);
  }

  // Square wave beep, 1000Hz, 20ms
  tickDigital(pitchMult = 1) {
    const ctx = this._ensureCtx();
    const t = ctx.currentTime;
    this._tone(1000 * pitchMult, "square", t, 0.02, 0.1);
  }

  // Low thump pair (80Hz + 100Hz sine), 60ms
  tickHeartbeat(pitchMult = 1) {
    const ctx = this._ensureCtx();
    const t = ctx.currentTime;
    this._tone(80 * pitchMult, "sine", t, 0.035, 0.16);
    this._tone(100 * pitchMult, "sine", t + 0.025, 0.035, 0.12);
  }

  // --- Timer target-hit sounds ---

  // Ascending major chord sweep (C5→E5→G5 fast arpeggio), bright/short
  timerSuccess() {
    const ctx = this._ensureCtx();
    const t = ctx.currentTime;
    this._tone(523.25, "triangle", t, 0.07, 0.2);         // C5
    this._tone(659.25, "triangle", t + 0.06, 0.07, 0.2);  // E5
    this._tone(783.99, "triangle", t + 0.12, 0.12, 0.22); // G5
    this._tone(1046.50, "sine", t + 0.18, 0.2, 0.18);     // C6 tail
  }

  // Descending two-tone alert (E5→C5), ~200ms
  timerWarning() {
    const ctx = this._ensureCtx();
    const t = ctx.currentTime;
    this._tone(659.25, "triangle", t, 0.1, 0.2);        // E5
    this._tone(523.25, "triangle", t + 0.1, 0.12, 0.18); // C5
  }

  // --- Reward / penalty sounds ---

  // Cash register jingle: bright chirpy triple ding with shimmer tail
  cashJingle() {
    const ctx = this._ensureCtx();
    const t = ctx.currentTime;
    this._tone(1318.51, "sine", t, 0.06, 0.16);          // E6 ding
    this._tone(1567.98, "sine", t + 0.06, 0.06, 0.16);   // G6 ding
    this._tone(2093.00, "sine", t + 0.12, 0.1, 0.18);    // C7 ding
    this._tone(2637.02, "triangle", t + 0.18, 0.2, 0.06); // shimmer tail E7
  }

  // Sad trombone: classic descending "wah wah wah waaah"
  sadTrombone() {
    const ctx = this._ensureCtx();
    const t = ctx.currentTime;
    this._tone(311.13, "sawtooth", t, 0.22, 0.1);         // Eb4
    this._tone(293.66, "sawtooth", t + 0.25, 0.22, 0.1);  // D4
    this._tone(277.18, "sawtooth", t + 0.5, 0.22, 0.1);   // Db4
    this._sweep(261.63, 246.94, "sawtooth", t + 0.75, 0.4, 0.1); // C4 → B3 slow bend
  }
}

window.slopSFX = new SlopSFX();
