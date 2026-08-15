/** Web Audio-synthesized game sounds — no audio assets to license or load. One shared
 * AudioContext, lazily created on the first user-gesture-triggered play (browsers block
 * AudioContext before a gesture; every call site here runs from a click handler or a
 * state change that follows one, and resume() covers the suspended case). */

export type SfxName =
  | 'click' | 'card' | 'energy' | 'evolve' | 'trainer'
  | 'attack' | 'damage' | 'ko' | 'coin' | 'heal'
  | 'victory' | 'defeat' | 'turn';

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;

function ensureCtx(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null;
  if (!ctx) {
    ctx = new AudioContext();
    masterGain = ctx.createGain();
    masterGain.gain.value = 0.35;
    masterGain.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** One enveloped oscillator note. Times are relative seconds from "now". */
function note(
  freq: number,
  { at = 0, dur = 0.12, type = 'sine' as OscillatorType, vol = 1, slideTo }: {
    at?: number; dur?: number; type?: OscillatorType; vol?: number; slideTo?: number;
  } = {},
) {
  const c = ensureCtx();
  if (!c || !masterGain) return;
  const t0 = c.currentTime + at;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t0 + dur);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(vol, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(g).connect(masterGain);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** Short filtered-noise burst (impacts). */
function noise({ at = 0, dur = 0.15, vol = 0.8, cutoff = 1200 }: { at?: number; dur?: number; vol?: number; cutoff?: number } = {}) {
  const c = ensureCtx();
  if (!c || !masterGain) return;
  const t0 = c.currentTime + at;
  const len = Math.ceil(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = cutoff;
  const g = c.createGain();
  g.gain.value = vol;
  src.connect(f).connect(g).connect(masterGain);
  src.start(t0);
}

const SOUNDS: Record<SfxName, () => void> = {
  click: () => note(880, { dur: 0.05, type: 'square', vol: 0.25 }),
  card: () => { noise({ dur: 0.08, vol: 0.5, cutoff: 3000 }); note(520, { at: 0.02, dur: 0.08, type: 'triangle', vol: 0.5 }); },
  energy: () => { note(660, { dur: 0.1, type: 'sine', vol: 0.5 }); note(990, { at: 0.07, dur: 0.12, type: 'sine', vol: 0.45 }); },
  evolve: () => { [523, 659, 784, 1047].forEach((f, i) => note(f, { at: i * 0.08, dur: 0.18, type: 'triangle', vol: 0.5 })); },
  trainer: () => { note(440, { dur: 0.09, type: 'triangle', vol: 0.5 }); note(554, { at: 0.08, dur: 0.12, type: 'triangle', vol: 0.5 }); },
  attack: () => { note(180, { dur: 0.18, type: 'sawtooth', vol: 0.6, slideTo: 60 }); noise({ at: 0.03, dur: 0.12, vol: 0.7, cutoff: 900 }); },
  damage: () => { noise({ dur: 0.18, vol: 0.9, cutoff: 700 }); note(120, { dur: 0.2, type: 'square', vol: 0.4, slideTo: 50 }); },
  ko: () => { note(392, { dur: 0.25, type: 'sawtooth', vol: 0.55, slideTo: 98 }); noise({ at: 0.05, dur: 0.3, vol: 0.8, cutoff: 500 }); },
  coin: () => { [1319, 1568, 1319, 1568, 1760].forEach((f, i) => note(f, { at: i * 0.05, dur: 0.06, type: 'square', vol: 0.3 })); },
  heal: () => { note(784, { dur: 0.15, type: 'sine', vol: 0.45 }); note(1047, { at: 0.1, dur: 0.2, type: 'sine', vol: 0.4 }); },
  victory: () => { [523, 523, 523, 659, 784, 1047].forEach((f, i) => note(f, { at: i * 0.13, dur: i === 5 ? 0.5 : 0.12, type: 'triangle', vol: 0.55 })); },
  defeat: () => { [392, 370, 349, 330].forEach((f, i) => note(f, { at: i * 0.22, dur: 0.28, type: 'triangle', vol: 0.5 })); },
  turn: () => { note(587, { dur: 0.09, type: 'triangle', vol: 0.4 }); note(880, { at: 0.08, dur: 0.12, type: 'triangle', vol: 0.4 }); },
};

let sfxEnabled = true;
export function setSfxEnabled(on: boolean) { sfxEnabled = on; }
export function playSfx(name: SfxName) {
  if (!sfxEnabled) return;
  try { SOUNDS[name](); } catch { /* audio unavailable — never break the game over a sound */ }
}

/* ---------------- BGM: a soft generative arpeggio loop ---------------- */

let bgmTimer: number | null = null;
let bgmGain: GainNode | null = null;

// Am–F–C–G progression, arpeggiated. Frequencies for A3-rooted chords.
const CHORDS = [
  [220, 261.6, 329.6],   // Am
  [174.6, 220, 261.6],   // F
  [261.6, 329.6, 392],   // C
  [196, 246.9, 293.7],   // G
];

export function startBgm() {
  const c = ensureCtx();
  if (!c || !masterGain || bgmTimer !== null) return;
  bgmGain = c.createGain();
  bgmGain.gain.value = 0.16;
  bgmGain.connect(masterGain);
  let step = 0;
  const STEP_MS = 280;
  const tick = () => {
    if (!c || !bgmGain) return;
    const chord = CHORDS[Math.floor(step / 8) % CHORDS.length];
    const noteFreq = chord[[0, 1, 2, 1, 0, 2, 1, 2][step % 8]] * (step % 16 >= 8 ? 2 : 1);
    const t0 = c.currentTime;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'triangle';
    osc.frequency.value = noteFreq;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(1, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + STEP_MS / 1000 * 0.9);
    osc.connect(g).connect(bgmGain);
    osc.start(t0);
    osc.stop(t0 + STEP_MS / 1000);
    step++;
  };
  tick();
  bgmTimer = window.setInterval(tick, STEP_MS);
}

export function stopBgm() {
  if (bgmTimer !== null) { clearInterval(bgmTimer); bgmTimer = null; }
  if (bgmGain) { bgmGain.disconnect(); bgmGain = null; }
}
