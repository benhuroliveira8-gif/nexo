// Soundboard: sons prontos (gerados na hora pelo navegador, sem arquivo) e sons do servidor.
let ctx = null;
const audioCtx = () => {
  ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
};

export const BUILTIN = [
  { id: 'b:buzina', emoji: '📯', name: 'Buzina' },
  { id: 'b:aplausos', emoji: '👏', name: 'Aplausos' },
  { id: 'b:risada', emoji: '😂', name: 'Risada' },
  { id: 'b:badumtss', emoji: '🥁', name: 'Ba-dum-tss' },
  { id: 'b:trombeta', emoji: '🎺', name: 'Trombeta triste' },
  { id: 'b:sino', emoji: '🔔', name: 'Sino' },
  { id: 'b:tambor', emoji: '🪘', name: 'Rufar' },
  { id: 'b:grilos', emoji: '🦗', name: 'Grilos' },
];
export const builtinById = (id) => BUILTIN.find((b) => b.id === id);

function noiseBuffer(c, seconds) {
  const buf = c.createBuffer(1, Math.floor(c.sampleRate * seconds), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function env(g, t, a, peak, d) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
}

function tone(c, out, { type = 'sine', freq, t, a = 0.01, d = 0.3, peak = 0.3, slideTo = null }) {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + a + d);
  env(g, t, a, peak, d);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + a + d + 0.05);
}

function noiseHit(c, out, { t, d = 0.15, peak = 0.4, filter = 'highpass', freq = 1000, q = 1 }) {
  const s = c.createBufferSource();
  s.buffer = noiseBuffer(c, d + 0.05);
  const f = c.createBiquadFilter();
  f.type = filter; f.frequency.value = freq; f.Q.value = q;
  const g = c.createGain();
  env(g, t, 0.005, peak, d);
  s.connect(f).connect(g).connect(out);
  s.start(t);
}

const SYNTH = {
  buzina(c, out, t) {
    for (let k = 0; k < 2; k++) {
      [370, 466].forEach((f) => tone(c, out, { type: 'square', freq: f, t: t + k * 0.45, a: 0.02, d: 0.35, peak: 0.12 }));
    }
  },
  aplausos(c, out, t) {
    for (let i = 0; i < 70; i++) noiseHit(c, out, { t: t + Math.random() * 2.2, d: 0.05 + Math.random() * 0.05, peak: 0.15 + Math.random() * 0.2, filter: 'bandpass', freq: 1200 + Math.random() * 2000, q: 0.8 });
  },
  risada(c, out, t) {
    // "Ha-ha-ha-ha": vogal "a" com formantes, cada sílaba um pouco mais grave.
    for (let i = 0; i < 6; i++) {
      const st = t + i * 0.17;
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(300 - i * 14, st);
      o.frequency.exponentialRampToValueAtTime(240 - i * 14, st + 0.12);
      const g = c.createGain();
      env(g, st, 0.02, 0.5, 0.11);
      const mix = c.createGain();
      mix.gain.value = 0.35;
      [[800, 6], [1150, 8], [2900, 10]].forEach(([f, q]) => {
        const bp = c.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
        o.connect(bp).connect(mix);
      });
      mix.connect(g).connect(out);
      noiseHit(c, out, { t: st, d: 0.04, peak: 0.08, filter: 'highpass', freq: 3000 }); // o "h"
      o.start(st); o.stop(st + 0.16);
    }
  },
  badumtss(c, out, t) {
    tone(c, out, { freq: 140, slideTo: 50, t, a: 0.005, d: 0.25, peak: 0.6 });
    noiseHit(c, out, { t: t + 0.18, d: 0.12, peak: 0.35, filter: 'bandpass', freq: 1800, q: 0.7 });
    tone(c, out, { freq: 140, slideTo: 50, t: t + 0.36, a: 0.005, d: 0.25, peak: 0.6 });
    noiseHit(c, out, { t: t + 0.56, d: 0.9, peak: 0.25, filter: 'highpass', freq: 6000 });
  },
  trombeta(c, out, t) {
    [[311, 0.3], [294, 0.3], [277, 0.3], [262, 1.0]].reduce((st, [f, d]) => {
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f, st);
      if (d > 0.5) { // vibrato no final
        const lfo = c.createOscillator(); const lg = c.createGain();
        lfo.frequency.value = 6; lg.gain.value = 6; lfo.connect(lg).connect(o.frequency); lfo.start(st); lfo.stop(st + d);
      }
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1500;
      const g = c.createGain(); env(g, st, 0.04, 0.18, d);
      o.connect(lp).connect(g).connect(out);
      o.start(st); o.stop(st + d + 0.1);
      return st + d + 0.05;
    }, t);
  },
  sino(c, out, t) {
    [[880, 0.3], [1760, 0.12], [2640, 0.08], [1320, 0.1]].forEach(([f, p]) => tone(c, out, { freq: f, t, a: 0.003, d: 2.2, peak: p }));
  },
  tambor(c, out, t) {
    for (let i = 0; i < 28; i++) noiseHit(c, out, { t: t + i * 0.055, d: 0.05, peak: 0.12 + (i / 28) * 0.3, filter: 'bandpass', freq: 1500, q: 0.6 });
    tone(c, out, { freq: 120, slideTo: 45, t: t + 1.6, a: 0.005, d: 0.4, peak: 0.6 });
    noiseHit(c, out, { t: t + 1.6, d: 1.2, peak: 0.3, filter: 'highpass', freq: 5000 });
  },
  grilos(c, out, t) {
    for (let k = 0; k < 4; k++) {
      for (let i = 0; i < 4; i++) tone(c, out, { freq: 4400, t: t + k * 0.6 + i * 0.045, a: 0.004, d: 0.03, peak: 0.08 });
    }
  },
};

const buffers = new Map(); // id -> AudioBuffer (sons do servidor)
let playing = 0;

// Toca um som (do soundboard). volume 0 a 1.
export async function playSound(sound, volume = 0.6) {
  if (volume <= 0) return;
  if (playing >= 3) return; // no máximo 3 ao mesmo tempo
  const c = audioCtx();
  const out = c.createGain();
  out.gain.value = volume;
  out.connect(c.destination);
  playing++;
  setTimeout(() => { playing--; out.disconnect(); }, 8000);
  const id = String(sound.id || '');
  if (id.startsWith('b:')) {
    const fn = SYNTH[id.slice(2)];
    if (fn) fn(c, out, c.currentTime + 0.02);
    return;
  }
  if (!/^\d+$/.test(id)) return;
  let buf = buffers.get(id);
  if (!buf) {
    const res = await fetch(`/sound/${id}`);
    if (!res.ok) return;
    buf = await c.decodeAudioData(await res.arrayBuffer());
    buffers.set(id, buf);
  }
  const src = c.createBufferSource();
  src.buffer = buf;
  src.connect(out);
  src.start();
  src.stop(c.currentTime + 7); // sons longos são cortados
}

// Duração de um arquivo de áudio (para conferir antes de enviar).
export async function audioDuration(file) {
  const c = audioCtx();
  const buf = await c.decodeAudioData(await file.arrayBuffer());
  return buf.duration;
}
