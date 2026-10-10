// Mensagem de voz: grava pelo microfone, mede o volume para desenhar a "ondinha"
// e devolve o áudio pronto para enviar como anexo.
import { h } from './util.js';

export const MAX_VOICE_MS = 5 * 60 * 1000; // 5 minutos

const TYPES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/aac'];

export const canRecord = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);

export async function startRecording({ onTick, onAutoStop } = {}) {
  if (!canRecord()) throw new Error('Este navegador não grava áudio.');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (err) {
    throw new Error(err && err.name === 'NotAllowedError'
      ? 'O microfone está bloqueado. Libere nas configurações do site (ícone ao lado do endereço).'
      : 'Não encontrei um microfone.');
  }
  const mime = TYPES.find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

  // Volume ao longo do tempo (para a ondinha).
  const levels = [];
  let ctx = null;
  let analyser = null;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    // O navegador pode criar o áudio "pausado"; sem isto a ondinha fica zerada.
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  } catch { /* sem ondinha, tudo bem */ }
  const buf = analyser ? new Float32Array(analyser.fftSize) : null;

  const started = performance.now();
  recorder.start(250);
  const timer = setInterval(() => {
    const elapsed = performance.now() - started;
    if (analyser) {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      levels.push(Math.sqrt(sum / buf.length));
    }
    if (onTick) onTick(elapsed, levels);
    if (elapsed >= MAX_VOICE_MS && onAutoStop) onAutoStop();
  }, 100);

  const cleanup = () => {
    clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop());
    if (ctx) ctx.close().catch(() => {});
  };

  return {
    levels,
    cancel() {
      try { recorder.stop(); } catch { /* já parou */ }
      cleanup();
    },
    stop() {
      return new Promise((resolve) => {
        const durationMs = Math.round(performance.now() - started);
        recorder.onstop = () => {
          cleanup();
          const type = (recorder.mimeType || mime || 'audio/webm').split(';')[0];
          resolve({ blob: new Blob(chunks, { type }), durationMs, waveform: encodeWaveform(levels) });
        };
        try { recorder.stop(); } catch { cleanup(); resolve(null); }
      });
    },
  };
}

// 64 barrinhas de 0 a 255, em base64url (vai num cabeçalho do upload).
export function encodeWaveform(levels, bars = 64) {
  if (!levels.length) return '';
  // Normaliza pelo "quase máximo" (percentil 95): um estalo isolado não achata o resto.
  const sorted = levels.filter(Number.isFinite).sort((x, y) => x - y);
  const peak = Math.max(sorted[Math.floor(sorted.length * 0.95)] || 0, 0.0001);
  const scaled = Array.from({ length: bars }, (_, i) => {
    const from = Math.floor((i * levels.length) / bars);
    const to = Math.max(from + 1, Math.floor(((i + 1) * levels.length) / bars));
    let max = 0;
    for (let j = from; j < to && j < levels.length; j++) if (Number.isFinite(levels[j])) max = Math.max(max, levels[j]);
    return Math.round(Math.sqrt(Math.min(1, max / peak)) * 255); // raiz: vozes baixas também aparecem
  });
  return btoa(String.fromCharCode(...scaled)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeWaveform(b64, bars = 64) {
  try {
    const raw = atob(String(b64).replace(/-/g, '+').replace(/_/g, '/'));
    const vals = Array.from(raw, (c) => c.charCodeAt(0) / 255);
    if (vals.length) return vals;
  } catch { /* usa padrão */ }
  return Array.from({ length: bars }, (_, i) => 0.3 + 0.25 * Math.abs(Math.sin(i * 0.7)));
}

export const formatDuration = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// Player da mensagem de voz: botão play, ondinha clicável e tempo.
let playing = null;
export function voicePlayer(att) {
  const values = decodeWaveform(att.voice.waveform);
  const total = att.voice.durationMs;
  const audio = h('audio', { src: att.url, preload: 'none' });
  const bars = values.map((v) => h('i', { style: `height:${Math.max(12, Math.round(v * 100))}%` }));
  const wave = h('div', { class: 'vm-wave', role: 'slider', 'aria-label': 'Posição do áudio', tabindex: '0' }, bars);
  const time = h('span', { class: 'vm-time' }, formatDuration(total));
  const btn = h('button', { class: 'vm-play', type: 'button', title: 'Ouvir', 'aria-label': 'Ouvir' }, '▶');
  const el = h('div', { class: 'voice-msg' }, btn, wave, time, audio);

  const progress = () => {
    const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration * 1000 : total;
    const frac = Math.min(1, (audio.currentTime * 1000) / dur);
    const n = Math.round(frac * bars.length);
    bars.forEach((b, i) => b.classList.toggle('on', i < n));
    time.textContent = audio.paused && audio.currentTime === 0 ? formatDuration(total) : formatDuration(audio.currentTime * 1000);
  };
  const setPlaying = (on) => { btn.textContent = on ? '❚❚' : '▶'; btn.title = on ? 'Pausar' : 'Ouvir'; el.classList.toggle('playing', on); };
  btn.addEventListener('click', () => {
    if (audio.paused) {
      if (playing && playing !== audio) playing.pause();
      playing = audio;
      audio.play().catch(() => {});
    } else audio.pause();
  });
  audio.addEventListener('play', () => setPlaying(true));
  audio.addEventListener('pause', () => setPlaying(false));
  audio.addEventListener('ended', () => { setPlaying(false); audio.currentTime = 0; progress(); });
  audio.addEventListener('timeupdate', progress);
  wave.addEventListener('click', (e) => {
    const r = wave.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const seek = () => {
      const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : total / 1000;
      audio.currentTime = frac * dur;
      progress();
    };
    if (audio.readyState >= 1) seek(); else { audio.addEventListener('loadedmetadata', seek, { once: true }); audio.load(); }
  });
  return el;
}
