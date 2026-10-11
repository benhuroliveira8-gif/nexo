// Partes das mensagens que não são texto: enquetes, mensagens de voz e prévias de link.
import { h, openDialog, toast, fullTime } from './util.js';

// ================================================================ Enquetes

const DURATIONS = [[1, '1 hora'], [4, '4 horas'], [8, '8 horas'], [24, '1 dia'], [72, '3 dias'], [168, '1 semana'], [0, 'Sem prazo']];

export function createPollDialog(onSubmit) {
  const question = h('input', { maxlength: '300', placeholder: 'Qual é a pergunta?' });
  const list = h('div', { class: 'poll-edit-options' });
  const addBtn = h('button', { type: 'button', class: 'btn small', onclick: () => addOption('') }, '+ Adicionar opção');
  const multiple = h('input', { type: 'checkbox', class: 'switch' });
  const duration = h('select', { class: 'select' }, DURATIONS.map(([v, l]) => h('option', { value: String(v), selected: v === 24 }, l)));

  function addOption(value) {
    if (list.children.length >= 10) return toast('No máximo 10 opções.');
    const input = h('input', { maxlength: '80', placeholder: `Opção ${list.children.length + 1}`, value });
    const row = h('div', { class: 'poll-edit-row' }, input,
      h('button', {
        type: 'button', class: 'icon-btn small', title: 'Remover opção',
        onclick: () => { if (list.children.length > 2) { row.remove(); renumber(); } },
      }, '✕'));
    list.append(row);
    addBtn.disabled = list.children.length >= 10;
    if (value === '' && list.children.length > 2) input.focus();
  }
  function renumber() {
    [...list.querySelectorAll('input')].forEach((inp, i) => { inp.placeholder = `Opção ${i + 1}`; });
    addBtn.disabled = list.children.length >= 10;
  }
  addOption(''); addOption('');

  openDialog({
    title: '📊 Criar enquete',
    body: h('div', { class: 'poll-edit' },
      h('label', { class: 'field' }, 'Pergunta', question),
      h('div', { class: 'field' }, h('span', {}, 'Opções'), list, addBtn),
      h('div', { class: 'poll-edit-foot' },
        h('label', { class: 'field inline' }, 'Duração', duration),
        h('label', { class: 'switch-line' }, multiple, 'Permitir várias respostas'))),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Publicar enquete', kind: 'primary', submit: true,
        onClick: async () => {
          const options = [...list.querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean);
          if (!question.value.trim()) throw new Error('Escreva a pergunta.');
          if (options.length < 2) throw new Error('Escreva pelo menos 2 opções.');
          await onSubmit({ question: question.value.trim(), options, multiple: multiple.checked, hours: Number(duration.value) });
        },
      },
    ],
  });
}

function timeLeft(endsAt) {
  const ms = new Date(endsAt) - Date.now();
  if (ms <= 0) return 'encerrada';
  const min = Math.round(ms / 60000);
  if (min < 60) return `termina em ${Math.max(1, min)} min`;
  const hrs = Math.round(min / 60);
  if (hrs < 48) return `termina em ${hrs} h`;
  return `termina em ${Math.round(hrs / 24)} dias`;
}

// m = mensagem; ctx = { meId, nameOf(id), canVote, canEnd, onVote(indices), onEnd() }
export function buildPoll(m, ctx) {
  const p = m.poll;
  const closed = p.closed || (p.endsAt && new Date(p.endsAt) <= new Date());
  const mine = new Set(p.options.flatMap((o, i) => (o.voters.includes(ctx.meId) ? [i] : [])));
  const showResults = closed || mine.size > 0;
  const max = Math.max(1, ...p.options.map((o) => o.votes));
  const winner = closed ? Math.max(...p.options.map((o) => o.votes)) : -1;
  const vote = (i) => {
    if (closed || !ctx.canVote) return;
    let next;
    if (p.multiple) {
      next = new Set(mine);
      if (next.has(i)) next.delete(i); else next.add(i);
    } else next = mine.has(i) ? new Set() : new Set([i]);
    ctx.onVote([...next]);
  };
  return h('div', { class: `poll${closed ? ' closed' : ''}` },
    h('div', { class: 'poll-q' }, p.question),
    h('div', { class: 'poll-sub muted' }, closed ? 'Enquete encerrada' : p.multiple ? 'Escolha uma ou mais opções' : 'Escolha uma opção'),
    h('div', { class: 'poll-options' }, p.options.map((o, i) => {
      const pct = p.totalVoters ? Math.round((o.votes / p.totalVoters) * 100) : 0;
      const names = o.voters.map(ctx.nameOf).filter(Boolean);
      return h('button', {
        type: 'button',
        class: `poll-opt${mine.has(i) ? ' mine' : ''}${closed && o.votes === winner && winner > 0 ? ' winner' : ''}`,
        disabled: closed || !ctx.canVote,
        title: names.length ? `Votaram: ${names.join(', ')}` : null,
        onclick: () => vote(i),
      },
      showResults ? h('span', { class: 'poll-bar', style: `width:${(o.votes / max) * 100}%` }) : null,
      h('span', { class: `poll-check${p.multiple ? ' square' : ''}` }, mine.has(i) ? '✓' : ''),
      h('span', { class: 'poll-text' }, o.text),
      showResults ? h('span', { class: 'poll-pct' }, `${pct}%`) : null);
    })),
    h('div', { class: 'poll-foot muted' },
      `${p.totalVoters} ${p.totalVoters === 1 ? 'voto' : 'votos'}`,
      p.endsAt ? ` · ${closed ? `encerrada ${fullTime(new Date(p.endsAt)).replace(/^Hoje às /, 'hoje às ')}` : timeLeft(p.endsAt)}` : (closed ? ' · encerrada' : ''),
      !closed && mine.size ? h('button', { type: 'button', class: 'link', onclick: () => ctx.onVote([]) }, ' · tirar voto') : null,
      !closed && ctx.canEnd ? h('button', { type: 'button', class: 'link', onclick: ctx.onEnd }, ' · encerrar agora') : null));
}

// ================================================================ Mensagens de voz

const BARS = 48;
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch { return new Uint8Array(0); }
};
export const fmtDuration = (sec) => {
  const s = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function pickMime() {
  if (!window.MediaRecorder) return null;
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return types.find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
}

export const canRecord = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder && window.isSecureContext);

// Começa a gravar. Devolve { stop() -> Promise<{ file, duration, waveform }>, cancel(), levels(), elapsed() }
export async function startRecording({ maxSeconds = 300, onTick, audio = {} } = {}) {
  if (!canRecord()) throw new Error(window.isSecureContext ? 'Este navegador não consegue gravar áudio.' : 'Gravar áudio precisa do endereço com https://');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...audio } });
  } catch (err) {
    throw new Error(err && err.name === 'NotAllowedError' ? 'O navegador bloqueou o microfone. Libere no cadeado ao lado do endereço.' : 'Não foi possível usar o microfone.');
  }
  const mime = pickMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  src.connect(analyser);
  const data = new Uint8Array(analyser.fftSize);
  const levels = [];
  const started = performance.now();
  let pausedAt = null;  // quando pausou (null = gravando)
  let pausedTotal = 0;  // tempo total pausado (ms)
  let stopped = false;
  const elapsed = () => ((pausedAt ?? performance.now()) - started - pausedTotal) / 1000;
  const sample = setInterval(() => {
    if (pausedAt !== null) return;
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += ((v - 128) / 128) ** 2;
    levels.push(Math.min(1, Math.sqrt(sum / data.length) * 3.2));
    const secs = elapsed();
    if (onTick) onTick(secs, levels);
    if (secs >= maxSeconds && !stopped) api.stopAuto();
  }, 100);
  rec.start(250);

  const finish = () => {
    stopped = true;
    clearInterval(sample);
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
  };
  const api = {
    levels: () => levels,
    elapsed,
    isPaused: () => pausedAt !== null,
    pause() {
      if (stopped || pausedAt !== null || rec.state !== 'recording') return;
      try { rec.pause(); } catch { return; }
      pausedAt = performance.now();
    },
    resume() {
      if (stopped || pausedAt === null) return;
      try { rec.resume(); } catch { return; }
      pausedTotal += performance.now() - pausedAt;
      pausedAt = null;
    },
    cancel() {
      if (stopped) return;
      finish();
      try { rec.stop(); } catch { /* já parou */ }
    },
    stop() {
      return new Promise((resolve, reject) => {
        if (stopped && rec.state === 'inactive') return reject(new Error('Gravação já terminou.'));
        const duration = elapsed();
        rec.onstop = () => {
          const type = (rec.mimeType || mime || 'audio/webm').split(';')[0];
          const blob = new Blob(chunks, { type });
          const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
          const file = new File([blob], `mensagem-de-voz.${ext}`, { type });
          resolve({ file, duration, waveform: makeWaveform(levels) });
        };
        finish();
        try { rec.requestData(); } catch { /* ignora */ }
        rec.stop();
      });
    },
    stopAuto: () => { if (api.onAutoStop) api.onAutoStop(); },
  };
  return api;
}

// Resume os níveis em 48 barrinhas (0–255) e codifica em base64url.
function makeWaveform(levels) {
  const out = new Uint8Array(BARS);
  if (!levels.length) return b64url(out);
  const peak = Math.max(0.05, ...levels);
  for (let i = 0; i < BARS; i++) {
    const a = Math.floor((i / BARS) * levels.length);
    const b = Math.max(a + 1, Math.floor(((i + 1) / BARS) * levels.length));
    let v = 0;
    for (let j = a; j < b && j < levels.length; j++) v = Math.max(v, levels[j]);
    out[i] = Math.round(Math.min(1, v / peak) * 255);
  }
  return b64url(out);
}

// Barrinhas ao vivo durante a gravação.
export function liveBars(levels, count = 32) {
  const last = levels.slice(-count);
  while (last.length < count) last.unshift(0);
  return h('span', { class: 'rec-bars' }, last.map((v) => h('i', { style: `height:${Math.max(8, v * 100)}%` })));
}

let playing = null; // só um áudio tocando por vez

export function buildVoicePlayer(att) {
  const wave = fromB64url(att.waveform || '');
  const bars = wave.length ? [...wave] : new Array(BARS).fill(60);
  const audio = new Audio();
  audio.preload = 'none';
  audio.src = att.url;
  let duration = att.duration || 0;
  const barEls = bars.map((v) => h('i', { style: `height:${Math.max(12, (v / 255) * 100)}%` }));
  const time = h('span', { class: 'vp-time' }, fmtDuration(duration));
  const playBtn = h('button', { type: 'button', class: 'vm-play', title: 'Tocar' }, '▶');
  const speeds = [1, 1.5, 2];
  let speedIdx = 0;
  const speed = h('button', { type: 'button', class: 'vm-speed', title: 'Velocidade' }, '1×');
  const waveEl = h('div', { class: 'vm-wave', role: 'slider', 'aria-label': 'Posição do áudio', tabindex: '0' }, barEls);
  const el = h('div', { class: 'voice-msg' }, playBtn, waveEl, time, speed);

  const paint = () => {
    const d = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : duration;
    const frac = d ? Math.min(1, audio.currentTime / d) : 0;
    const lit = Math.round(frac * barEls.length);
    barEls.forEach((b, i) => b.classList.toggle('on', i < lit));
    time.textContent = audio.paused && audio.currentTime === 0 ? fmtDuration(d) : fmtDuration(audio.currentTime);
  };
  playBtn.addEventListener('click', () => {
    if (audio.paused) {
      if (playing && playing !== audio) playing.pause();
      playing = audio;
      audio.play().catch(() => toast('Não deu para tocar esse áudio neste navegador.'));
    } else audio.pause();
  });
  speed.addEventListener('click', () => {
    speedIdx = (speedIdx + 1) % speeds.length;
    audio.playbackRate = speeds[speedIdx];
    speed.textContent = `${speeds[speedIdx]}×`.replace('.', ',');
  });
  waveEl.addEventListener('click', (e) => {
    const r = waveEl.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const seek = () => {
      const d = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : duration;
      audio.currentTime = frac * d;
      paint();
    };
    if (audio.readyState >= 1) seek(); else { audio.preload = 'metadata'; audio.addEventListener('loadedmetadata', seek, { once: true }); audio.load(); }
  });
  audio.addEventListener('play', () => { playBtn.textContent = '❚❚'; playBtn.title = 'Pausar'; el.classList.add('playing'); });
  audio.addEventListener('pause', () => { playBtn.textContent = '▶'; playBtn.title = 'Tocar'; el.classList.remove('playing'); });
  audio.addEventListener('ended', () => { audio.currentTime = 0; paint(); });
  audio.addEventListener('timeupdate', paint);
  audio.addEventListener('loadedmetadata', () => { if (Number.isFinite(audio.duration)) duration = audio.duration; paint(); });
  return el;
}

// ================================================================ Prévias de link

export function buildEmbeds(embeds, { onImageLoad } = {}) {
  return h('div', { class: 'embeds' }, embeds.map((e) => {
    if (e.type === 'image') {
      const img = h('img', { src: e.image, alt: '', loading: 'lazy', class: 'att-img' });
      if (onImageLoad) img.addEventListener('load', onImageLoad);
      return h('a', { href: e.url, target: '_blank', rel: 'noopener noreferrer nofollow', class: 'att-img-link embed-image' }, img);
    }
    const parts = [];
    if (e.siteName) parts.push(h('div', { class: 'embed-site' }, e.siteName));
    if (e.title) parts.push(h('a', { class: 'embed-title', href: e.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, e.title));
    if (e.description) parts.push(h('div', { class: 'embed-desc' }, e.description));
    if (e.type === 'youtube') {
      const thumb = h('button', { type: 'button', class: 'embed-video', title: 'Assistir aqui' },
        h('img', { src: e.image, alt: '', loading: 'lazy' }),
        h('span', { class: 'embed-play' }, '▶'));
      if (onImageLoad) thumb.firstChild.addEventListener('load', onImageLoad);
      thumb.addEventListener('click', () => {
        const frame = h('iframe', {
          src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(e.youtubeId)}?autoplay=1&rel=0`,
          allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen',
          allowfullscreen: true, referrerpolicy: 'strict-origin-when-cross-origin', title: e.title || 'Vídeo',
        });
        thumb.replaceWith(h('div', { class: 'embed-video playing' }, frame));
      });
      parts.push(thumb);
    } else if (e.image) {
      const img = h('img', { src: e.image, alt: '', loading: 'lazy', class: 'embed-img' });
      img.addEventListener('error', () => { const a = img.parentElement; if (a) a.remove(); });
      if (onImageLoad) img.addEventListener('load', onImageLoad);
      parts.push(h('a', { href: e.url, target: '_blank', rel: 'noopener noreferrer nofollow', class: 'embed-img-link' }, img));
    }
    return h('div', { class: `embed${e.type === 'youtube' ? ' yt' : ''}`, style: e.color ? `--embed-color:${e.color}` : null }, parts);
  }));
}
