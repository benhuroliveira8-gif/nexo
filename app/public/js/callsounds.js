// Sons de chamada, gerados na hora pelo navegador (nenhum arquivo de áudio):
//  - entrar e sair da chamada (sobe / desce);
//  - toque de celular quando alguém te liga (marimba, melodia própria do Nexo);
//  - "chamando…" para quem ligou (tom de chamada brasileiro: 425 Hz, 1 s ligado, 4 s desligado);
//  - "ocupado" quando recusam a ligação.
let ctx = null;
let sinkWanted = ''; // '' = saída padrão (não chama setSinkId à toa)

function audioCtx(speakerId) {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  // Toca na saída de som escolhida em "Voz e vídeo" (quando o navegador deixa).
  const want = speakerId && speakerId !== 'default' ? speakerId : '';
  if (typeof ctx.setSinkId === 'function' && want !== sinkWanted) {
    sinkWanted = want;
    ctx.setSinkId(want).catch(() => {});
  }
  return ctx;
}

let speakerOf = () => '';
export const setSpeakerGetter = (fn) => { speakerOf = fn; };

// Uma "batida" de marimba: fundamental + harmônico ~4x que some rápido + o toque da baqueta.
function marimba(c, out, freq, t, vel = 1) {
  const partials = [[1, 0.55 * vel, 0.9], [3.93, 0.16 * vel, 0.18], [9.2, 0.04 * vel, 0.05]];
  for (const [mult, peak, decay] of partials) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq * mult, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + decay + 0.05);
  }
}

const N = { E5: 659.25, Fs5: 739.99, Gs5: 830.61, A5: 880, B5: 987.77, Cs6: 1108.73, Ds6: 1244.51, E6: 1318.51, Fs6: 1479.98, Gs6: 1661.22 };

// Melodia do toque (uns 2,6 s). Original do Nexo: arpejo de Mi maior que "pergunta" e "responde".
const RING_PHRASE = [
  [0.00, 'E5'], [0.14, 'B5'], [0.28, 'Gs5'], [0.42, 'E6'], [0.56, 'B5'], [0.70, 'Ds6', 0.8], [0.84, 'B5', 0.7],
  [1.12, 'Fs5'], [1.26, 'Cs6'], [1.40, 'A5'], [1.54, 'Fs6'], [1.68, 'Cs6'], [1.82, 'E6', 0.8],
  [2.10, 'Gs6', 0.6], [2.24, 'E6', 0.9], [2.38, 'B5', 1],
];
const RING_LOOP = 3.2; // segundos entre o começo de uma frase e da próxima

// ---------------------------------------------------------------- Laços (toque e "chamando")

function makeLoop(play, every, volume) {
  const c = audioCtx(speakerOf());
  const out = c.createGain();
  out.gain.value = volume;
  out.connect(c.destination);
  let next = c.currentTime + 0.05;
  const schedule = () => {
    // Agenda um pouco à frente para não "engasgar" quando a aba fica em segundo plano.
    while (next < c.currentTime + 1.5) { play(c, out, next); next += every; }
  };
  schedule();
  const timer = setInterval(schedule, 400);
  return {
    stop() {
      clearInterval(timer);
      try {
        out.gain.setTargetAtTime(0.0001, c.currentTime, 0.03);
        setTimeout(() => out.disconnect(), 200);
      } catch { out.disconnect(); }
    },
  };
}

let ringLoop = null;
export function startRingtone() {
  if (ringLoop) return;
  try {
    ringLoop = makeLoop((c, out, t) => RING_PHRASE.forEach(([dt, n, v]) => marimba(c, out, N[n], t + dt, v || 1)), RING_LOOP, 0.5);
  } catch { ringLoop = null; }
}
export function stopRingtone() {
  if (ringLoop) { ringLoop.stop(); ringLoop = null; }
}
export const isRinging = () => !!ringLoop;

function tone(c, out, freq, t, dur, peak = 0.25, type = 'sine') {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.02);
  g.gain.setValueAtTime(peak, t + Math.max(0.03, dur - 0.04));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + dur + 0.05);
}

let backLoop = null;
let backTimeout = null;
// "Tuuu… tuuu…" enquanto ninguém atende (para no máximo em 60 s).
export function startRingback(maxMs = 60000) {
  if (backLoop) return;
  try {
    backLoop = makeLoop((c, out, t) => tone(c, out, 425, t, 1.0, 0.22), 5, 0.6);
    backTimeout = setTimeout(stopRingback, maxMs);
  } catch { backLoop = null; }
}
export function stopRingback() {
  clearTimeout(backTimeout);
  if (backLoop) { backLoop.stop(); backLoop = null; }
}
export const isRingingBack = () => !!backLoop;

// ---------------------------------------------------------------- Sons curtos

function oneShot(play, volume = 0.5) {
  try {
    const c = audioCtx(speakerOf());
    const out = c.createGain();
    out.gain.value = volume;
    out.connect(c.destination);
    play(c, out, c.currentTime + 0.02);
    setTimeout(() => out.disconnect(), 2000);
  } catch { /* sem som */ }
}

// Alguém entrou (ou você entrou): duas notas subindo.
export const playJoin = () => oneShot((c, out, t) => {
  marimba(c, out, N.B5, t, 0.8);
  marimba(c, out, N.E6, t + 0.09, 1);
}, 0.45);

// Alguém saiu (ou você saiu): duas notas descendo, mais graves.
export const playLeave = () => oneShot((c, out, t) => {
  marimba(c, out, N.Gs5, t, 0.9);
  marimba(c, out, N.Cs6 / 2, t + 0.1, 0.8);
}, 0.45);

// Ligação recusada / ninguém atendeu: "tu-tu-tu".
export const playBusy = () => oneShot((c, out, t) => {
  for (let i = 0; i < 3; i++) tone(c, out, 425, t + i * 0.5, 0.25, 0.22);
}, 0.6);

// Para o botão "Testar" das configurações.
export function previewRingtone(ms = 3200) {
  startRingtone();
  setTimeout(stopRingtone, ms);
}
