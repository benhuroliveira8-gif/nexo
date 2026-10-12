// Clipes: enquanto você assiste uma tela compartilhada (num servidor que tem um canal
// de clipes), o navegador guarda sempre os últimos ~30 segundos. Um clique em 🎬
// manda esse trecho como vídeo para o canal de clipes.
//
// Como funciona: dois gravadores revezando (cada um recomeça a cada 30 s, defasados
// 15 s). Na hora do clique, o mais antigo tem entre 15 e 30 s da tela, e é ele que vira o clipe.
import { h, toast, uploadFile } from './util.js';

const PERIOD = 30000;
const BITRATE = 1400000; // ~5 MB a cada 30 s (cabe no limite de anexos padrão de 8 MB)

let hooks = { clipsChannel: () => null, send: async () => {} };
export function initClips(h0) { hooks = { ...hooks, ...h0 }; }

const buffers = new Map(); // track sid -> { stream, recs: [rec, rec], timers, name }

export const clipsSupported = () => typeof MediaRecorder !== 'undefined';

function pickMime() {
  const list = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  return list.find((t) => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) || '';
}

function makeRecorder(stream) {
  const mime = pickMime();
  const r = { chunks: [], startedAt: 0, rec: null, mime };
  const start = () => {
    try {
      r.chunks = [];
      r.rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: BITRATE, audioBitsPerSecond: 96000 });
      r.rec.ondataavailable = (e) => { if (e.data && e.data.size) r.chunks.push(e.data); };
      r.rec.start(1000);
      r.startedAt = Date.now();
    } catch { r.rec = null; }
  };
  r.restart = () => {
    const old = r.rec;
    if (old && old.state !== 'inactive') { old.ondataavailable = null; try { old.stop(); } catch { /* */ } }
    start();
  };
  r.stop = () => { if (r.rec && r.rec.state !== 'inactive') { r.rec.ondataavailable = null; try { r.rec.stop(); } catch { /* */ } } r.rec = null; };
  // Pega o que já foi gravado (finaliza este gravador e recomeça logo em seguida).
  r.take = () => new Promise((resolve) => {
    const rec = r.rec;
    if (!rec || rec.state === 'inactive') return resolve(null);
    const seconds = (Date.now() - r.startedAt) / 1000;
    const chunks = r.chunks;
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => resolve({ blob: new Blob(chunks, { type: (rec.mimeType || mime || 'video/webm').split(';')[0] }), seconds });
    try { rec.stop(); } catch { resolve(null); }
    r.rec = null;
    start();
  });
  start();
  return r;
}

// Chamado a cada desenho da tela da chamada: liga a gravação nas telas que você está
// vendo e desliga nas que acabaram. screens: [{ sid, videoTrack, audioTrack, name }]
export function syncClipBuffers(screens) {
  const enabled = clipsSupported() && !!hooks.clipsChannel();
  const want = new Map(enabled ? screens.filter((s) => s.videoTrack).map((s) => [s.sid, s]) : []);
  for (const [sid, b] of buffers) {
    if (!want.has(sid)) { b.timers.forEach(clearTimeout); b.timers.forEach(clearInterval); b.recs.forEach((r) => r.stop()); buffers.delete(sid); }
  }
  for (const [sid, s] of want) {
    const existing = buffers.get(sid);
    if (existing) { existing.name = s.name; continue; }
    const stream = new MediaStream([s.videoTrack, ...(s.audioTrack ? [s.audioTrack] : [])]);
    const b = { stream, recs: [], timers: [], name: s.name };
    b.recs.push(makeRecorder(stream));
    b.timers.push(setInterval(() => b.recs[0] && b.recs[0].restart(), PERIOD));
    // O segundo começa 15 s depois (assim sempre tem um com pelo menos 15 s).
    b.timers.push(setTimeout(() => {
      if (!buffers.has(sid)) return;
      b.recs.push(makeRecorder(stream));
      b.timers.push(setInterval(() => b.recs[1] && b.recs[1].restart(), PERIOD));
    }, PERIOD / 2));
    buffers.set(sid, b);
  }
}

export const isBuffering = (sid) => buffers.has(sid);

export async function saveClip(sid) {
  const b = buffers.get(sid);
  const channel = hooks.clipsChannel();
  if (!b || !channel) return toast('Os clipes só funcionam em servidores com um canal de clipes.');
  const oldest = b.recs.filter((r) => r.rec).sort((x, y) => x.startedAt - y.startedAt)[0];
  if (!oldest || Date.now() - oldest.startedAt < 3000) return toast('Espere alguns segundos de transmissão para gravar um clipe.');
  toast('🎬 Salvando o clipe…');
  const got = await oldest.take();
  if (!got || !got.blob.size) return toast('Não deu para gravar o clipe.');
  const ext = got.blob.type.includes('mp4') ? 'mp4' : 'webm';
  const stamp = new Date().toLocaleString('pt-BR').replace(/[/:]/g, '-').replace(/,?\s+/g, '_');
  const file = new File([got.blob], `clipe_${stamp}.${ext}`, { type: got.blob.type });
  try {
    const att = await uploadFile(file, () => {});
    await hooks.send(channel.id, `🎬 Clipe da tela de ${b.name} (${Math.round(got.seconds)} s)`, [att.id]);
    toast(`🎬 Clipe enviado para #${channel.name}!`);
  } catch (err) {
    toast(err.message === 'Arquivo grande demais.' ? 'O clipe ficou grande demais para enviar (aumente o limite de anexos).' : err.message);
  }
}

// Botão que vai nos controles da tela compartilhada.
export function clipButton(sid) {
  if (!buffers.has(sid)) return null;
  return h('button', {
    type: 'button', class: 'sc-btn sc-clip', title: 'Clipe: manda os últimos ~30 segundos para o canal de clipes', 'aria-label': 'Gravar clipe',
    onclick: (e) => { e.stopPropagation(); saveClip(sid); },
  }, '🎬');
}

export function stopAllClips() { syncClipBuffers([]); }
