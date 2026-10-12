// Voz, vídeo e compartilhamento de tela (LiveKit).
//
// O áudio/vídeo vai direto do navegador para o servidor LiveKit (pelo Caddy, em HTTPS).
// O Nexo só autoriza a entrada (token) e mostra para todos quem está em cada canal.
import { h, api, avatar, toast, openDialog, confirmDialog, hueFor, storage, openPopover, closePopover } from './util.js';
import {
  initRemote, onData, remoteState, requestControl, stopViewing, endHosting, attachControl,
  onParticipantGone, onScreenStopped, onRemoteScreenStopped, resetRemote,
} from './remote.js';
import { quickDevices } from './devices.js';
import { isEconomy } from './economy.js';
import { BUILTIN, builtinById, playSound } from './sounds.js';
import { syncClipBuffers, clipButton, stopAllClips } from './clips.js';
import { setSpeakerGetter, playJoin, playLeave, startRingback, stopRingback, isRingingBack } from './callsounds.js';

const vs = {
  room: null,
  channelId: null,
  serverId: null,
  channelName: '',
  serverName: '',
  connecting: false,
  reconnecting: false,
  canSpeak: false,
  canVideo: false,
  muted: false,
  deafened: false,
  mutedBeforeDeafen: false,
  video: false,
  screen: false,
  needsAudioClick: false,
  recording: false,
  stage: false,      // canal em modo palco?
  moderator: false,  // pode moderar o palco?
};

// ---------------------------------------------------------------- Preferências de voz (deste aparelho)
const DEFAULT_SETTINGS = {
  mode: 'voice', pttKey: 'ControlLeft', noiseSuppression: true, echoCancellation: true, autoGainControl: true,
  screenQuality: '1080p30', screenContent: 'motion', screenAudio: true,
  micId: '', speakerId: '', camId: '', // '' = padrão do sistema
  soundboardVolume: 0.6, // 0 = não tocar os sons dos outros
  callSounds: true, // sons de entrar/sair da chamada
};
export function voiceSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(storage('nexo.voice') || '{}') }; } catch { return { ...DEFAULT_SETTINGS }; }
}
export function saveVoiceSettings(changes) {
  const next = { ...voiceSettings(), ...changes };
  storage('nexo.voice', JSON.stringify(next));
  applySettingsLive(changes);
  return next;
}
// "ideal": se o aparelho escolhido foi desconectado, usa o padrão em vez de dar erro.
const pickDevice = (id) => (id ? { deviceId: { ideal: id } } : {});
export const captureOptions = () => {
  const st = voiceSettings();
  return {
    noiseSuppression: st.noiseSuppression, echoCancellation: st.echoCancellation, autoGainControl: st.autoGainControl,
    ...pickDevice(st.micId),
  };
};
// Modo economia: a sua câmera envia em 360p / 15 fps.
const cameraOptions = () => ({ ...pickDevice(voiceSettings().camId), ...(isEconomy() ? { resolution: { width: 640, height: 360, frameRate: 15 } } : {}) });

// Saída de som escolhida (alto-falante/fone). Só Chrome/Edge/Firefox permitem escolher.
export const canPickSpeaker = () => typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
export function applySpeaker(el, id = voiceSettings().speakerId) {
  if (!canPickSpeaker() || !el) return Promise.resolve();
  return el.setSinkId(id || '').catch(() => el.setSinkId('').catch(() => {}));
}

// Volume de cada pessoa (0 a 1), guardado neste aparelho.
function volumes() {
  try { return JSON.parse(storage('nexo.volumes') || '{}'); } catch { return {}; }
}
export const volumeOf = (userId) => {
  const v = Number(volumes()[userId]);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
};
export function setVolume(userId, value) {
  const all = volumes();
  if (value >= 0.999) delete all[userId]; else all[userId] = Math.round(value * 100) / 100;
  storage('nexo.volumes', JSON.stringify(all));
  for (const el of trackEls.values()) {
    if (el.tagName === 'AUDIO' && !el.dataset.screen && Number(el.dataset.userId) === Number(userId)) el.volume = volumeOf(userId);
  }
  onChange();
}

// Volume do som da TELA compartilhada (separado da voz da pessoa).
export const screenVolumeOf = (userId) => {
  const v = Number(volumes()[`tela:${userId}`]);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
};
export function setScreenVolume(userId, value) {
  const all = volumes();
  if (value >= 0.999) delete all[`tela:${userId}`]; else all[`tela:${userId}`] = Math.round(value * 100) / 100;
  storage('nexo.volumes', JSON.stringify(all));
  for (const el of trackEls.values()) {
    if (el.tagName === 'AUDIO' && el.dataset.screen && Number(el.dataset.userId) === Number(userId)) el.volume = screenVolumeOf(userId);
  }
}

let getSocket = () => null;
let onChange = () => {};
const trackEls = new Map(); // track.sid -> elemento <video>/<audio>

let getSounds = () => [];
let myId = () => null;
export function initVoice(opts) {
  getSocket = opts.getSocket;
  onChange = opts.onChange;
  if (opts.getSounds) getSounds = opts.getSounds;
  if (opts.myId) myId = opts.myId;
  setSpeakerGetter(() => voiceSettings().speakerId);
  initRemote({
    room: () => vs.room,
    Track: () => LK().Track,
    onChange: () => onChange(),
    nameOf: (p) => p.name || p.identity,
    isSharing: () => vs.screen,
  });
  // Saiu da tela cheia: redesenha a tela da chamada.
  const fsChanged = () => { if (!fullscreenEl()) onChange(); };
  document.addEventListener('fullscreenchange', fsChanged);
  document.addEventListener('webkitfullscreenchange', fsChanged);
}

export const voiceState = () => vs;
export const inVoice = () => !!vs.room;
const LK = () => window.LivekitClient;

// ---------------------------------------------------------------- Carregar a biblioteca

let loading = null;
function loadLivekit() {
  if (LK()) return Promise.resolve();
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/livekit-client.js';
      s.onload = () => (LK() ? resolve() : reject(new Error('A biblioteca de voz não carregou.')));
      s.onerror = () => reject(new Error('Não foi possível carregar a biblioteca de voz.'));
      document.head.append(s);
    }).catch((err) => { loading = null; throw err; });
  }
  return loading;
}

// ---------------------------------------------------------------- Entrar / sair

function explainHttps() {
  const url = `https://${location.hostname}${location.pathname}`;
  openDialog({
    title: 'A voz precisa de HTTPS',
    text: 'O navegador só libera microfone e câmera em endereços seguros (https). Abra o Nexo pelo endereço abaixo. '
      + 'Na primeira vez pode aparecer um aviso de segurança: clique em "Avançado" e depois em "Continuar".',
    body: h('input', { value: url, readonly: true }),
    actions: [
      { label: 'Fechar' },
      { label: 'Abrir em HTTPS', kind: 'primary', submit: true, onClick: () => { location.href = url; } },
    ],
  });
}

function emitState() {
  const socket = getSocket();
  if (socket && vs.room) {
    socket.emit('voice:state', { muted: vs.muted, deafened: vs.deafened, video: vs.video, screen: vs.screen, recording: vs.recording });
  }
}

function announceJoin() {
  const socket = getSocket();
  if (!socket || !vs.room) return;
  socket.emit('voice:join', {
    channelId: vs.channelId, muted: vs.muted, deafened: vs.deafened, video: vs.video, screen: vs.screen, recording: vs.recording,
  }, (res) => {
    if (res && !res.ok) toast(res.error);
  });
}

// ---------------------------------------------------------------- Sons de entrar/sair

let quietUntil = 0;
// Durante reconexões (atualização do Nexo, internet piscou) não toca "entrou/saiu" à toa.
export const quietVoiceSounds = (ms = 6000) => { quietUntil = Math.max(quietUntil, Date.now() + ms); };
const callSoundsOn = () => voiceSettings().callSounds !== false && !vs.deafened && Date.now() > quietUntil;
let peopleHere = null; // Set de quem estava na chamada (para saber quem entrou/saiu)

// O Nexo avisa quem está em cada canal de voz; aqui comparamos com a última lista.
export function noticeVoiceStates(channelId, states) {
  if (!vs.room || vs.connecting || channelId !== vs.channelId) return;
  const me = myId();
  const now = new Set(states.map((x) => x.userId).filter((id) => id !== me));
  if (!peopleHere) { peopleHere = now; if (now.size) stopRingback(); return; }
  const joined = [...now].some((id) => !peopleHere.has(id));
  const left = [...peopleHere].some((id) => !now.has(id));
  peopleHere = now;
  if (now.size && isRingingBack()) stopRingback(); // atenderam!
  if (!callSoundsOn()) return;
  if (joined) playJoin();
  else if (left) playLeave();
}

export function joinVoice(opts) {
  peopleHere = null;
  if (waitingFor && waitingFor.channelId !== opts.channelId) cancelWaiting({ silent: true });
  return joinVoiceInner(opts);
}

let rejoinTries = 0;
let rejoinTimer = null;
async function joinVoiceInner({ channelId, channelName, serverId, serverName, isDm = false, video = false, ringback = false }) {
  clearTimeout(rejoinTimer);
  if (!window.isSecureContext) return explainHttps();
  if (vs.connecting) return;
  if (vs.room && vs.channelId === channelId) return;

  vs.connecting = true;
  onChange();
  try {
    const [grant] = await Promise.all([
      api(`/voice/${channelId}/token`, { method: 'POST' }),
      loadLivekit(),
    ]);
    // Sala de espera: fica aguardando a moderação liberar.
    if (grant.waiting) {
      startWaiting({ channelId, channelName, serverId, serverName, isDm, video });
      return;
    }
    const { token, canSpeak, canVideo, stage, moderator } = grant;
    if (waitingFor) cancelWaiting({ silent: true });
    if (vs.room) await leaveVoice({ silent: true });

    const { Room } = LK();
    const room = new Room({ adaptiveStream: true, dynacast: true, audioCaptureDefaults: captureOptions(), videoCaptureDefaults: cameraOptions() });
    wireRoom(room);
    Object.assign(vs, {
      room, channelId, serverId, channelName, serverName, canSpeak, canVideo, isDm,
      muted: !canSpeak, deafened: false, video: false, screen: false, pttDown: false,
      stage: !!stage, moderator: !!moderator, recording: false,
    });
    // No palco, quem é chamado para falar entra mutado (liga quando quiser).
    const startMuted = !!stage && !moderator;

    await room.connect(`wss://${location.host}`, token);
    try { await room.startAudio(); } catch { /* navegador pode exigir um clique */ }
    vs.needsAudioClick = room.canPlaybackAudio === false;

    if (canSpeak) {
      try {
        // No modo "aperte para falar" o microfone começa desligado.
        const ptt = voiceSettings().mode === 'ptt' || startMuted;
        await room.localParticipant.setMicrophoneEnabled(true, captureOptions());
        if (ptt) await room.localParticipant.setMicrophoneEnabled(false);
        vs.muted = ptt;
      } catch (err) {
        vs.muted = true;
        toast(micErrorMessage(err));
      }
    }
    if (video && canVideo) {
      try { await room.localParticipant.setCameraEnabled(true, cameraOptions()); vs.video = true; } catch { /* sem câmera */ }
    }
    announceJoin();
    setTimeout(() => { if (vs.room) rejoinTries = 0; }, 30000);
    if (callSoundsOn()) playJoin();
    // Ligação em mensagem direta sem ninguém ainda: "tuuu… tuuu…" até atenderem.
    if (ringback && isDm) startRingback();
  } catch (err) {
    toast(err.message || 'Não foi possível entrar na voz.');
    await leaveVoice({ silent: true });
  } finally {
    vs.connecting = false;
    onChange();
  }
}

function micErrorMessage(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError') return 'O navegador bloqueou o microfone. Libere no cadeado ao lado do endereço.';
  if (name === 'NotFoundError') return 'Nenhum microfone encontrado. Você entrou mutado.';
  return 'Não foi possível ligar o microfone. Você entrou mutado.';
}

export async function leaveVoice({ silent = false } = {}) {
  const room = vs.room;
  if (!silent) { clearTimeout(rejoinTimer); rejoinTries = 0; }
  stopRingback();
  if (room && !silent && callSoundsOn()) playLeave();
  peopleHere = null;
  resetRemote();
  unwatched.clear();
  if (rec) stopRecording();
  stopAllClips();
  vs.room = null;
  if (room) {
    try { await room.disconnect(); } catch { /* já caiu */ }
  }
  for (const el of trackEls.values()) el.remove();
  trackEls.clear();
  const socket = getSocket();
  if (socket && vs.channelId && !silent) socket.emit('voice:leave');
  Object.assign(vs, { channelId: null, serverId: null, isDm: false, video: false, screen: false, deafened: false, needsAudioClick: false, pttDown: false, recording: false, stage: false, moderator: false });
  onChange();
}

// Depois de uma queda do Nexo (ex.: deploy), avisa de novo que estamos na voz.
export function resyncAfterReconnect() {
  if (vs.room) announceJoin();
  else if (waitingFor) emitWait();
}

// ---------------------------------------------------------------- Sala de espera
let waitingFor = null; // { channelId, channelName, serverId, serverName, ... }
export const waitingState = () => waitingFor;

function emitWait() {
  const socket = getSocket();
  if (!socket || !waitingFor) return;
  const target = waitingFor;
  socket.emit('voice:wait', { channelId: target.channelId }, (res) => {
    if (!res || !res.ok) { if (waitingFor === target) { waitingFor = null; onChange(); } return toast((res && res.error) || 'Não deu para entrar na fila.'); }
    if (res.admitted && waitingFor === target) { waitingFor = null; joinVoice(target); }
  });
}

function startWaiting(target) {
  waitingFor = target;
  emitWait();
  toast('⏳ Este canal tem sala de espera. A moderação foi avisada: espere liberarem.');
  onChange();
}

export function cancelWaiting({ silent = false } = {}) {
  if (!waitingFor) return;
  const socket = getSocket();
  if (socket) socket.emit('voice:unwait', { channelId: waitingFor.channelId });
  waitingFor = null;
  if (!silent) onChange();
}

// A moderação liberou (ou não).
export function onAdmitted({ channelId }) {
  if (!waitingFor || waitingFor.channelId !== channelId) return;
  const target = waitingFor;
  waitingFor = null;
  toast('✅ Liberaram a sua entrada!');
  joinVoice(target);
}
export function onDenied({ channelId }) {
  if (!waitingFor || waitingFor.channelId !== channelId) return;
  waitingFor = null;
  toast('A moderação não liberou a entrada agora.');
  onChange();
}

window.addEventListener('pagehide', () => { if (vs.room) vs.room.disconnect(); });

// ---------------------------------------------------------------- Eventos do LiveKit

function wireRoom(room) {
  const { RoomEvent, Track } = LK();
  const changed = () => { if (vs.room === room) onChange(); };

  room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
    // Modo economia: câmeras dos outros chegam em qualidade baixa.
    if (isEconomy() && publication && publication.source === Track.Source.Camera && publication.setVideoQuality && LK().VideoQuality) {
      try { publication.setVideoQuality(LK().VideoQuality.LOW); } catch { /* */ }
    }
    if (track.kind === Track.Kind.Audio) {
      const el = track.attach();
      el.muted = vs.deafened;
      const uid = participant ? participantUserId(participant) : null;
      const isScreen = !!(publication && Track.Source.ScreenShareAudio && publication.source === Track.Source.ScreenShareAudio);
      if (isScreen) el.dataset.screen = '1';
      if (uid) { el.dataset.userId = String(uid); el.volume = isScreen ? screenVolumeOf(uid) : volumeOf(uid); }
      applySpeaker(el);
      document.getElementById('voice-audio').append(el);
      trackEls.set(track.sid, el);
    }
    changed();
  });
  room.on(RoomEvent.TrackUnsubscribed, (track) => {
    const el = trackEls.get(track.sid);
    if (el) { track.detach(el); el.remove(); trackEls.delete(track.sid); }
    changed();
  });
  room.on(RoomEvent.LocalTrackUnpublished, (pub) => {
    // O navegador pode parar a tela sozinho (botão "Parar de compartilhar").
    if (pub.source === Track.Source.ScreenShare) { vs.screen = false; onScreenStopped(); emitState(); }
    if (pub.source === Track.Source.Camera) { vs.video = false; emitState(); }
    const el = pub.track && trackEls.get(pub.track.sid);
    if (el) { el.remove(); trackEls.delete(pub.track.sid); }
    changed();
  });
  // Controle remoto: mensagens e quem saiu.
  if (RoomEvent.DataReceived) room.on(RoomEvent.DataReceived, (payload, participant, kind, topic) => onData(payload, participant, topic));
  room.on(RoomEvent.ParticipantDisconnected, (p) => { if (p) onParticipantGone(p.identity); });
  room.on(RoomEvent.TrackUnpublished, (pub, p) => {
    if (pub && p && pub.source === Track.Source.ScreenShare) { onRemoteScreenStopped(p.identity); unwatched.delete(p.identity); }
  });
  // Som da tela chegou depois de você parar de assistir: também não baixa.
  room.on(RoomEvent.TrackPublished, (pub, p) => {
    if (pub && p && unwatched.has(p.identity) && (pub.source === Track.Source.ScreenShare || pub.source === Track.Source.ScreenShareAudio) && pub.setSubscribed) {
      try { pub.setSubscribed(false); } catch { /* */ }
    }
  });
  [RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected, RoomEvent.TrackMuted,
    RoomEvent.TrackUnmuted, RoomEvent.ActiveSpeakersChanged, RoomEvent.LocalTrackPublished,
    RoomEvent.TrackPublished, RoomEvent.TrackUnpublished, RoomEvent.ParticipantMetadataChanged,
  ].filter(Boolean).forEach((ev) => room.on(ev, changed));

  room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
    vs.needsAudioClick = room.canPlaybackAudio === false;
    changed();
  });
  room.on(RoomEvent.Reconnecting, () => { vs.reconnecting = true; changed(); });
  room.on(RoomEvent.Reconnected, () => { vs.reconnecting = false; changed(); });
  room.on(RoomEvent.Disconnected, (reason) => {
    if (vs.room !== room) return;
    // Caiu sem você pedir (internet piscou, servidor de voz reiniciou): tenta voltar sozinho.
    // 1 = você saiu, 2 = entrou em outro aparelho, 4 = foi removido, 5 = sala apagada.
    if (![1, 2, 4, 5].includes(Number(reason)) && rejoinTries < 3) {
      rejoinTries++;
      const target = { channelId: vs.channelId, channelName: vs.channelName, serverId: vs.serverId, serverName: vs.serverName, isDm: vs.isDm, video: vs.video };
      toast('A chamada caiu. Reconectando…');
      quietVoiceSounds(15000);
      leaveVoice({ silent: true });
      rejoinTimer = setTimeout(() => { if (!vs.room && !vs.connecting) joinVoice(target); }, 1500 * rejoinTries);
      return;
    }
    toast('Você foi desconectado da voz.');
    leaveVoice();
  });
}

// ---------------------------------------------------------------- Botões

export async function toggleMute() {
  if (!vs.room || !vs.canSpeak) return;
  if (voiceSettings().mode === 'ptt' && !vs.deafened) {
    return toast(`Modo "aperte para falar": segure ${keyLabel(voiceSettings().pttKey)} (ou o botão) para falar.`);
  }
  if (vs.deafened) return toggleDeafen(); // desensurdecer também desmuta
  const next = !vs.muted;
  try {
    await vs.room.localParticipant.setMicrophoneEnabled(!next, captureOptions());
    vs.muted = next;
  } catch (err) {
    toast(micErrorMessage(err));
  }
  emitState();
  onChange();
}

export async function toggleDeafen() {
  if (!vs.room) return;
  vs.deafened = !vs.deafened;
  for (const el of trackEls.values()) if (el.tagName === 'AUDIO') el.muted = vs.deafened;
  if (vs.canSpeak) {
    if (vs.deafened) {
      vs.mutedBeforeDeafen = vs.muted;
      vs.muted = true;
    } else {
      vs.muted = voiceSettings().mode === 'ptt' ? true : vs.mutedBeforeDeafen;
      vs.pttDown = false;
    }
    try { await vs.room.localParticipant.setMicrophoneEnabled(!vs.muted); } catch { vs.muted = true; }
  }
  emitState();
  onChange();
}

export async function toggleCamera() {
  if (!vs.room || !vs.canVideo) return;
  try {
    await vs.room.localParticipant.setCameraEnabled(!vs.video, vs.video ? undefined : cameraOptions());
    vs.video = !vs.video;
  } catch (err) {
    toast(err && err.name === 'NotAllowedError' ? 'O navegador bloqueou a câmera.' : 'Não foi possível ligar a câmera.');
  }
  emitState();
  onChange();
}

// ---------------------------------------------------------------- Compartilhar a tela

// Qualidades oferecidas. "kbps" = taxa máxima de envio (quanto maior, mais nítido e mais internet usa).
export const SCREEN_QUALITIES = [
  { id: '720p30', res: '720p', fps: 30, w: 1280, h: 720, kbps: 2500 },
  { id: '1080p30', res: '1080p', fps: 30, w: 1920, h: 1080, kbps: 4500 },
  { id: '1080p60', res: '1080p', fps: 60, w: 1920, h: 1080, kbps: 7000 },
  { id: '1440p30', res: '1440p', fps: 30, w: 2560, h: 1440, kbps: 7000 },
  { id: '1440p60', res: '1440p', fps: 60, w: 2560, h: 1440, kbps: 12000 },
];
const qualityById = (id) => SCREEN_QUALITIES.find((q) => q.id === id) || SCREEN_QUALITIES[1];
const mbps = (kbps) => `${(kbps / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} Mbps`;

// Botão 🖥️: sem compartilhar abre as opções; compartilhando mostra "mudar qualidade / parar".
export function screenButton(e) {
  if (!vs.room || !vs.canVideo) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    return toast('Este navegador não consegue compartilhar a tela (no celular não dá; use o computador).');
  }
  if (!vs.screen) return openScreenDialog();
  const anchor = e && e.currentTarget;
  const q = qualityById(voiceSettings().screenQuality);
  openPopover(anchor || document.body, h('div', { class: 'menu', role: 'menu' },
    h('div', { class: 'menu-note muted small' }, `Transmitindo em até ${q.res} ${q.fps} fps`),
    h('button', { class: 'menu-item', onclick: async () => { closePopover(); await stopScreen(); openScreenDialog(); } }, '⚙️  Mudar qualidade ou tela'),
    h('button', { class: 'menu-item danger', onclick: () => { closePopover(); stopScreen(); } }, '⏹️  Parar de compartilhar')),
  { className: 'popover-menu', align: 'end' });
}
// Compatibilidade com quem chamava toggleScreen().
export const toggleScreen = () => (vs.screen ? stopScreen() : screenButton());

function openScreenDialog() {
  const st = voiceSettings();
  let quality = qualityById(st.screenQuality).id;
  let content = st.screenContent === 'detail' ? 'detail' : 'motion';
  const hint = h('p', { class: 'muted small screen-hint' });
  const chips = h('div', { class: 'quality-grid', role: 'radiogroup', 'aria-label': 'Qualidade' });
  const drawChips = () => {
    const q = qualityById(quality);
    chips.replaceChildren(...SCREEN_QUALITIES.map((x) => h('button', {
      type: 'button', class: `quality-chip${x.id === quality ? ' active' : ''}`, role: 'radio', 'aria-checked': String(x.id === quality),
      dataset: { q: x.id },
      onclick: () => { quality = x.id; drawChips(); },
    }, h('strong', {}, x.res), h('span', {}, `${x.fps} fps`))));
    hint.textContent = `Usa até ${mbps(q.kbps)} da sua internet de envio (upload). Se a sua internet ou o computador não aguentarem, a imagem se ajusta sozinha. `
      + `Só sai em ${q.res} se a sua tela for desse tamanho ou maior.`;
  };
  drawChips();
  const contentOption = (value, label, desc) => h('label', { class: 'kind-option' },
    h('input', { type: 'radio', name: 'screen-content', value, checked: content === value, onchange: () => { content = value; } }),
    h('span', { class: 'kind-text' }, h('strong', {}, label), h('span', { class: 'muted small' }, desc)));
  const audio = h('input', { type: 'checkbox', class: 'switch', checked: st.screenAudio !== false });
  openDialog({
    title: '🖥️ Compartilhar a tela',
    body: h('div', { class: 'screen-dialog' },
      h('div', { class: 'field-label' }, 'Qualidade'),
      chips,
      hint,
      h('div', { class: 'field-label' }, 'O que você vai mostrar?'),
      contentOption('motion', '🎮 Jogo ou vídeo', 'Prioriza a fluidez (mantém os quadros por segundo).'),
      contentOption('detail', '📄 Texto, código ou slides', 'Prioriza a nitidez (letras sempre legíveis).'),
      h('label', { class: 'switch-row' },
        h('span', { class: 'kind-text' }, h('strong', {}, '🔊 Transmitir o som'),
          h('span', { class: 'muted small' }, 'Som da aba ou do computador inteiro (no Windows, marque "Compartilhar áudio" na próxima janela).')),
        audio)),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Escolher a tela', kind: 'primary', submit: true,
        // Tem que abrir a escolha da tela direto do clique (exigência do navegador).
        onClick: () => {
          saveVoiceSettings({ screenQuality: quality, screenContent: content, screenAudio: audio.checked });
          startScreen();
        },
      },
    ],
  });
}

function canEncodeH264() {
  try {
    const caps = window.RTCRtpSender && RTCRtpSender.getCapabilities && RTCRtpSender.getCapabilities('video');
    return !caps || caps.codecs.some((c) => /h264/i.test(c.mimeType));
  } catch { return true; }
}

function screenOptions() {
  const st = voiceSettings();
  const q = qualityById(st.screenQuality);
  const detail = st.screenContent === 'detail';
  const { VideoPreset } = LK();
  const low = q.h > 720 ? [1280, 720, 1500, 15] : [640, 360, 600, 15];
  const capture = {
    audio: st.screenAudio !== false ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
    // Só limita o tamanho máximo (não aumenta telas menores).
    video: { width: { max: q.w }, height: { max: q.h }, frameRate: { ideal: q.fps, max: q.fps } },
    contentHint: detail ? 'detail' : 'motion',
    systemAudio: 'include',
    surfaceSwitching: 'include',
    selfBrowserSurface: 'exclude',
    suppressLocalAudioPlayback: false,
  };
  const publish = {
    // H.264 costuma ter codificação por hardware (placa de vídeo): aguenta 1440p a 60 fps sem travar o PC.
    videoCodec: canEncodeH264() ? 'h264' : 'vp8',
    screenShareEncoding: { maxBitrate: q.kbps * 1000, maxFramerate: q.fps, priority: 'high' },
    // Camada leve extra para quem estiver com a internet ruim.
    screenShareSimulcastLayers: VideoPreset ? [new VideoPreset(low[0], low[1], low[2] * 1000, low[3])] : undefined,
    degradationPreference: detail ? 'maintain-resolution' : 'maintain-framerate',
    audioPreset: { maxBitrate: 128000 },
    dtx: false,
    red: false,
  };
  return { capture, publish };
}

async function startScreen() {
  if (!vs.room || vs.screen) return;
  const { capture, publish } = screenOptions();
  try {
    await vs.room.localParticipant.setScreenShareEnabled(true, capture, publish);
    vs.screen = true;
  } catch (err) {
    // Fechar a janela de escolha da tela também cai aqui; não é erro de verdade.
    if (err && err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
      console.error('Erro ao compartilhar a tela:', err);
      toast('Não foi possível compartilhar a tela.');
    }
  }
  emitState();
  onChange();
}

async function stopScreen() {
  if (!vs.room || !vs.screen) return;
  onScreenStopped();
  try { await vs.room.localParticipant.setScreenShareEnabled(false); } catch { /* já parou */ }
  vs.screen = false;
  emitState();
  onChange();
}

// ---------------------------------------------------------------- Aperte para falar

async function setPtt(down) {
  if (!vs.room || !vs.canSpeak || vs.deafened || voiceSettings().mode !== 'ptt' || vs.pttDown === down) return;
  vs.pttDown = down;
  try {
    await vs.room.localParticipant.setMicrophoneEnabled(down, captureOptions());
    vs.muted = !down;
  } catch (err) {
    toast(micErrorMessage(err));
  }
  emitState();
  onChange();
}
export const pttPress = () => setPtt(true);
export const pttRelease = () => setPtt(false);

const typingTarget = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
const MODIFIERS = new Set(['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight', 'CapsLock']);
window.addEventListener('keydown', (e) => {
  const st = voiceSettings();
  if (!vs.room || st.mode !== 'ptt' || e.code !== st.pttKey || e.repeat) return;
  if (!MODIFIERS.has(e.code) && typingTarget(e.target)) return; // está digitando
  if (!MODIFIERS.has(e.code)) e.preventDefault();
  setPtt(true);
});
window.addEventListener('keyup', (e) => {
  const st = voiceSettings();
  if (vs.room && st.mode === 'ptt' && e.code === st.pttKey) setPtt(false);
});
window.addEventListener('blur', () => setPtt(false)); // trocou de janela: solta o microfone

// Nomes amigáveis das teclas.
export function keyLabel(code) {
  const names = {
    ControlLeft: 'Ctrl esquerdo', ControlRight: 'Ctrl direito', AltLeft: 'Alt', AltRight: 'Alt Gr', ShiftLeft: 'Shift esquerdo',
    ShiftRight: 'Shift direito', Space: 'Espaço', Backquote: "' (aspas)", CapsLock: 'Caps Lock', MetaLeft: 'Windows', Tab: 'Tab',
  };
  if (names[code]) return names[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F\d+$/.test(code)) return code;
  return code;
}

// Mudou a configuração no meio da chamada: aplica na hora.
async function applySettingsLive(changes) {
  if (!vs.room) return;
  if ('speakerId' in changes) {
    for (const el of trackEls.values()) if (el.tagName === 'AUDIO') applySpeaker(el, changes.speakerId);
  }
  const { Track } = LK();
  updateRoomDefaults();
  if ('camId' in changes) {
    // Troca de câmera no meio da chamada.
    try { await refreshTrack(Track.Source.Camera, cameraOptions()); } catch { toast('Não foi possível usar essa câmera.'); }
    onChange();
  }
  if (!vs.canSpeak) return;
  if ('mode' in changes) {
    const ptt = changes.mode === 'ptt';
    try { await vs.room.localParticipant.setMicrophoneEnabled(!ptt, captureOptions()); vs.muted = ptt; } catch { vs.muted = true; }
    vs.pttDown = false;
    emitState();
    onChange();
  } else if (['noiseSuppression', 'echoCancellation', 'autoGainControl', 'micId'].some((k) => k in changes)) {
    // Reinicia o microfone com o aparelho/opções novos.
    try { await refreshTrack(Track.Source.Microphone, captureOptions()); } catch { toast('Não foi possível usar esse microfone.'); }
  }
}

// O LiveKit guarda as opções da primeira captura; atualiza para as próximas.
function updateRoomDefaults() {
  try {
    const o = vs.room.options;
    if (!o) return;
    o.audioCaptureDefaults = { ...(o.audioCaptureDefaults || {}), deviceId: undefined, ...captureOptions() };
    o.videoCaptureDefaults = { ...(o.videoCaptureDefaults || {}), deviceId: undefined, ...cameraOptions() };
  } catch { /* versão diferente da biblioteca */ }
}

// Ligado: reinicia a captura com as opções novas. Mutado/desligado: descarta,
// para a próxima vez já começar com o aparelho certo.
async function refreshTrack(source, options) {
  const lp = vs.room.localParticipant;
  const pub = lp.getTrackPublication(source);
  if (!pub || !pub.track) return;
  if (pub.isMuted || !pub.track.restartTrack) {
    if (lp.unpublishTrack) await lp.unpublishTrack(pub.track, true);
    return;
  }
  await pub.track.restartTrack(options);
}

// ---------------------------------------------------------------- Volume por pessoa

export function openVolumePopover(anchor, user) {
  const value = Math.round(volumeOf(user.id) * 100);
  const label = h('span', { class: 'vol-value' }, `${value}%`);
  const slider = h('input', {
    type: 'range', min: '0', max: '100', step: '5', value: String(value), class: 'vol-range',
    'aria-label': `Volume de ${user.displayName}`,
    oninput: (e) => { label.textContent = `${e.target.value}%`; setVolume(user.id, Number(e.target.value) / 100); },
  });
  openPopover(anchor, h('div', { class: 'vol-pop' },
    h('div', { class: 'vol-title' }, avatar(user, { size: 'xs' }), h('strong', { class: 'truncate' }, user.displayName)),
    h('div', { class: 'vol-row' }, '🔈', slider, label),
    h('div', { class: 'vol-actions' },
      h('button', { class: 'btn small', onclick: () => { slider.value = '0'; slider.dispatchEvent(new Event('input')); } }, '🔇 Silenciar'),
      h('button', { class: 'btn small', onclick: () => { slider.value = '100'; slider.dispatchEvent(new Event('input')); } }, 'Normal')),
    h('p', { class: 'muted small' }, 'Só muda o volume para você.')), { className: 'popover-volume' });
}

export async function enableAudio() {
  if (!vs.room) return;
  try { await vs.room.startAudio(); } catch { /* tenta de novo no próximo clique */ }
  vs.needsAudioClick = vs.room.canPlaybackAudio === false;
  onChange();
}

// ---------------------------------------------------------------- Soundboard

export function openSoundboard(anchor) {
  if (!vs.room) return;
  const custom = (getSounds(vs.serverId) || []);
  const st = voiceSettings();
  const vol = h('input', { type: 'range', min: '0', max: '100', step: '5', value: String(Math.round((st.soundboardVolume ?? 0.6) * 100)), class: 'vol-range' });
  const volLabel = h('span', { class: 'vol-value' }, `${vol.value}%`);
  vol.addEventListener('input', () => { volLabel.textContent = `${vol.value}%`; saveVoiceSettings({ soundboardVolume: Number(vol.value) / 100 }); });
  const blocked = !vs.canSpeak;
  const btn = (snd) => h('button', {
    type: 'button', class: 'sb-btn', disabled: blocked, title: blocked ? 'Só quem pode falar toca sons' : `Tocar "${snd.name}" para todos`,
    onclick: () => { const sock = getSocket(); if (sock) sock.emit('voice:sound', { sound: String(snd.id) }); },
  }, h('span', { class: 'sb-emoji' }, snd.emoji || '🔊'), h('span', { class: 'sb-name truncate' }, snd.name));
  openPopover(anchor, h('div', { class: 'soundboard' },
    h('div', { class: 'emoji-cat' }, 'Sons do Nexo'),
    h('div', { class: 'sb-grid' }, BUILTIN.map(btn)),
    custom.length ? h('div', { class: 'emoji-cat' }, 'Deste servidor') : null,
    custom.length ? h('div', { class: 'sb-grid' }, custom.map(btn)) : null,
    h('div', { class: 'vol-row sb-vol' }, h('span', { title: 'Volume dos sons (para você)' }, '🔈'), vol, volLabel),
    h('p', { class: 'muted small' }, blocked ? 'No palco, só quem está falando toca sons.' : 'Toca para todo mundo da chamada. O volume acima é só para você (0% = não ouvir os sons).')),
  { align: 'end', className: 'popover-soundboard' });
}

// Alguém tocou um som (chega pelo servidor).
export function playSoundEvent({ channelId, sound }, user) {
  if (!vs.room || channelId !== vs.channelId || vs.deafened) return;
  const vol = voiceSettings().soundboardVolume ?? 0.6;
  if (vol <= 0) return;
  playSound(sound, vol).catch(() => {});
  const b = builtinById(sound.id);
  const label = b ? `${b.emoji} ${b.name}` : `${sound.emoji || '🔊'} ${sound.name || 'som'}`;
  soundChip(`${user && user.displayName ? user.displayName : 'Alguém'}: ${label}`);
}

let chipTimer = null;
function soundChip(text) {
  let el = document.getElementById('sound-chip');
  if (!el) { el = h('div', { id: 'sound-chip', class: 'sound-chip', role: 'status' }); document.body.append(el); }
  el.textContent = `🔊 ${text}`;
  el.classList.add('show');
  clearTimeout(chipTimer);
  chipTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ---------------------------------------------------------------- Gravar a chamada (só áudio)

let rec = null; // { ctx, dest, recorder, chunks, sources: Map, scan, limit, startedAt }
const REC_MAX_MIN = 30;

export function toggleRecording() {
  if (rec) return stopRecording();
  confirmDialog({
    title: '⏺️ Gravar a chamada?',
    text: `Grava só o áudio (até ${REC_MAX_MIN} minutos) e salva o arquivo no seu aparelho. Todo mundo na chamada vai ver um aviso 🔴 de que você está gravando.`,
    okLabel: 'Começar a gravar', danger: false,
    onConfirm: () => startRecording(),
  });
}

function startRecording() {
  if (!vs.room || rec) return;
  if (!window.MediaRecorder) return toast('Este navegador não consegue gravar.');
  const { Track } = LK();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  const dest = ctx.createMediaStreamDestination();
  // Um "silêncio" constante garante que o arquivo tenha áudio mesmo sem ninguém falando.
  const silence = ctx.createConstantSource ? ctx.createConstantSource() : null;
  if (silence) { const g = ctx.createGain(); g.gain.value = 0; silence.connect(g).connect(dest); silence.start(); }
  const sources = new Map();
  const add = (mst) => {
    if (!mst || sources.has(mst.id) || mst.readyState === 'ended') return;
    try {
      const node = ctx.createMediaStreamSource(new MediaStream([mst]));
      node.connect(dest);
      sources.set(mst.id, node);
    } catch { /* faixa sem áudio */ }
  };
  const scan = () => {
    if (!vs.room) return;
    const people = [vs.room.localParticipant, ...vs.room.remoteParticipants.values()];
    for (const p of people) {
      for (const src of [Track.Source.Microphone, Track.Source.ScreenShareAudio]) {
        const pub = src && p.getTrackPublication(src);
        if (pub && pub.track && pub.track.mediaStreamTrack) add(pub.track.mediaStreamTrack);
      }
    }
  };
  scan();
  const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
  const recorder = new MediaRecorder(dest.stream, type ? { mimeType: type } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
    if (!blob.size) toast('Nada foi gravado.');
    else {
      const d = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      const ext = /mp4/.test(blob.type) ? 'm4a' : /ogg/.test(blob.type) ? 'ogg' : 'webm';
      const a = h('a', { href: URL.createObjectURL(blob), download: `nexo-chamada-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.${ext}` });
      document.body.append(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      toast('⏺️ Gravação salva.');
    }
    ctx.close().catch(() => {});
  };
  recorder.start(1000);
  rec = { ctx, recorder, scan: setInterval(scan, 2000), limit: setTimeout(() => { toast(`Gravação parou sozinha (${REC_MAX_MIN} min).`); stopRecording(); }, REC_MAX_MIN * 60000), startedAt: Date.now() };
  vs.recording = true;
  emitState();
  onChange();
  toast('🔴 Gravando a chamada.');
}

export function stopRecording() {
  if (!rec) return;
  const r = rec;
  rec = null;
  clearInterval(r.scan);
  clearTimeout(r.limit);
  try { if (r.recorder.state !== 'inactive') r.recorder.stop(); } catch { /* */ }
  vs.recording = false;
  emitState();
  onChange();
}

// Avisa (com um "bip") quando alguém começa a gravar.
const knownRecorders = new Map(); // channelId -> Set(userId)
function noticeRecorders(channelId, states, members) {
  const now = new Set(states.filter((x) => x.recording).map((x) => x.userId));
  const before = knownRecorders.get(channelId) || new Set();
  for (const id of now) {
    if (!before.has(id) && id !== myUserId()) {
      const m = members.find((x) => x.id === id);
      toast(`🔴 ${m ? m.displayName : 'Alguém'} começou a gravar a chamada.`);
      playSound({ id: 'b:sino' }, 0.25).catch(() => {});
    }
  }
  knownRecorders.set(channelId, now);
  return [...now];
}
const myUserId = () => (vs.room ? participantUserId(vs.room.localParticipant) : null);

// ---------------------------------------------------------------- Palco

// O servidor mudou meu papel no palco.
export async function onStageRole({ channelId, speaker, applied }) {
  if (!vs.room || channelId !== vs.channelId) return;
  if (!applied) {
    // O LiveKit não respondeu: entra de novo para pegar as permissões novas.
    const again = { channelId: vs.channelId, channelName: vs.channelName, serverId: vs.serverId, serverName: vs.serverName };
    await leaveVoice({ silent: true });
    await joinVoice(again);
  } else if (speaker) {
    vs.canSpeak = true;
    vs.muted = true;
  } else {
    try { await vs.room.localParticipant.setMicrophoneEnabled(false); } catch { /* */ }
    if (vs.video) { try { await vs.room.localParticipant.setCameraEnabled(false); } catch { /* */ } }
    if (vs.screen) { try { await vs.room.localParticipant.setScreenShareEnabled(false); } catch { /* */ } }
    Object.assign(vs, { canSpeak: false, canVideo: false, muted: true, video: false, screen: false });
    emitState();
  }
  toast(speaker ? '🎙️ Você foi chamado para o palco! Ligue o microfone quando quiser falar.' : 'Você voltou para a plateia.');
  if (vs.room && applied && speaker) {
    // Câmera/tela também passam a valer no palco.
    vs.canVideo = true;
  }
  onChange();
}

const stageEmit = (ev, payload) => { const sock = getSocket(); if (sock) sock.emit(ev, payload); };

// ---------------------------------------------------------------- Telas

const icon = (on, offIcon, onIcon) => (on ? onIcon : offIcon);

// Aviso para quem está sendo controlado.
function controlBanner() {
  const { hosting } = remoteState();
  if (!hosting) return null;
  return h('div', { class: 'rc-banner', role: 'status' },
    h('span', {}, `🖱️ ${hosting.name} está controlando o seu PC`),
    h('span', { class: 'muted small' }, 'Seu mouse tem prioridade · Ctrl+Alt+End encerra'),
    h('button', { type: 'button', class: 'btn small danger', onclick: () => endHosting() }, 'Parar controle'));
}

// Painel "Voz conectada" acima do seu nome.
export function renderVoicePanel(el) {
  if (!vs.room && !vs.connecting && waitingFor) {
    el.hidden = false;
    el.replaceChildren(h('div', { class: 'vp-top' },
      h('div', { class: 'vp-info' },
        h('strong', { class: 'vp-status warn' }, '⏳ Na sala de espera'),
        h('span', { class: 'muted truncate' }, `🔊 ${waitingFor.channelName} / ${waitingFor.serverName}`)),
      h('button', { class: 'btn small', onclick: () => cancelWaiting() }, 'Cancelar')));
    return;
  }
  if (!vs.room && !vs.connecting) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const status = vs.connecting ? 'Conectando…' : vs.reconnecting ? 'Reconectando…' : vs.isDm ? 'Em chamada' : 'Voz conectada';
  const ptt = voiceSettings().mode === 'ptt' && vs.canSpeak;
  el.replaceChildren(...[
    h('div', { class: 'vp-top' },
      h('div', { class: 'vp-info' },
        h('strong', { class: `vp-status${vs.connecting || vs.reconnecting ? ' warn' : ''}` }, status),
        h('span', { class: 'muted truncate' }, vs.isDm ? `📞 ${vs.channelName}` : `🔊 ${vs.channelName} / ${vs.serverName}`)),
      h('button', { class: 'vp-btn danger', title: 'Sair da voz', onclick: () => leaveVoice() }, '📞')),
    vs.needsAudioClick ? h('button', { class: 'btn small primary vp-audio', onclick: enableAudio }, '🔈 Clique para ouvir') : null,
    controlBanner(),
    ptt ? pttButton(`Segure para falar (${keyLabel(voiceSettings().pttKey)})`) : null,
    h('div', { class: 'vp-actions' },
      h('button', {
        class: `vp-btn${vs.muted ? ' off' : ''}`, disabled: !vs.canSpeak || vs.connecting,
        title: !vs.canSpeak ? 'Você não tem permissão para falar aqui' : vs.muted ? 'Ligar microfone' : 'Mutar microfone',
        onclick: toggleMute,
      }, icon(vs.muted, '🎤', '🔇')),
      h('button', {
        class: `vp-btn${vs.deafened ? ' off' : ''}`, disabled: vs.connecting,
        title: vs.deafened ? 'Voltar a ouvir' : 'Ensurdecer (parar de ouvir)', onclick: toggleDeafen,
      }, icon(vs.deafened, '🎧', '🙉')),
      vs.canVideo ? h('button', {
        class: `vp-btn${vs.video ? ' on' : ''}`, disabled: vs.connecting,
        title: vs.video ? 'Desligar câmera' : 'Ligar câmera', onclick: toggleCamera,
      }, '📹') : null,
      vs.canVideo ? h('button', {
        class: `vp-btn${vs.screen ? ' on' : ''}`, disabled: vs.connecting,
        title: vs.screen ? 'Compartilhando a tela' : 'Compartilhar a tela', onclick: screenButton,
      }, '🖥️') : null,
      h('button', {
        class: 'vp-btn', disabled: vs.connecting, title: 'Soundboard (sons para a chamada)',
        onclick: (e) => openSoundboard(e.currentTarget),
      }, '🎵'),
      h('button', {
        class: 'vp-btn', disabled: vs.connecting, title: 'Microfone, saída de som e câmera',
        onclick: (e) => openPopover(e.currentTarget, quickDevices({ canVideo: vs.canVideo }), { className: 'popover-devices' }),
      }, '⚙️')),
  ].filter(Boolean));
}

// Botão "segure para falar" (para celular e para quem prefere clicar).
function pttButton(label) {
  const btn = h('button', { class: `btn small ptt-btn${vs.pttDown ? ' on' : ''}`, title: 'Segure para falar' }, vs.pttDown ? '🎙️ Falando…' : `🎙️ ${label}`);
  btn.addEventListener('pointerdown', (e) => { e.preventDefault(); btn.setPointerCapture(e.pointerId); setPtt(true); });
  const up = () => setPtt(false);
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  return btn;
}

function participantUserId(p) {
  try { return JSON.parse(p.metadata || '{}').userId || null; } catch { return null; }
}

function videoEl(track) {
  let el = trackEls.get(track.sid);
  if (!el) {
    el = track.attach();
    el.muted = true; // o som vem pelos elementos de áudio
    el.playsInline = true;
    trackEls.set(track.sid, el);
  }
  return el;
}

// ---------------------------------------------------------------- Tela compartilhada (quem assiste)

const screenTiles = new Map(); // sid do vídeo da tela -> quadro (fica o mesmo para não sair da tela cheia)

// Telas que você escolheu NÃO assistir (não baixa o vídeo nem o som delas).
const unwatched = new Set(); // identity de quem compartilha
function setWatching(p, watch) {
  const { Track } = LK();
  if (!watch) {
    const fs = fullscreenEl();
    if (fs && fs.classList.contains('screen')) exitFullscreen();
    const { viewing } = remoteState();
    if (viewing && viewing.identity === p.identity) stopViewing();
    unwatched.add(p.identity);
  } else {
    unwatched.delete(p.identity);
  }
  for (const src of [Track.Source.ScreenShare, Track.Source.ScreenShareAudio]) {
    const pub = src && p.getTrackPublication(src);
    if (pub && pub.setSubscribed) { try { pub.setSubscribed(watch); } catch { /* */ } }
  }
  onChange();
}

function pausedScreenTile(p, user) {
  return h('div', { class: 'tile screen paused' },
    h('div', { class: 'paused-box' },
      h('div', { class: 'paused-icon' }, '🖥️'),
      h('strong', {}, `${user.displayName} está compartilhando a tela`),
      h('span', { class: 'muted small' }, 'Você não está assistindo (não gasta internet).'),
      h('button', { type: 'button', class: 'btn primary small', onclick: () => setWatching(p, true) }, '▶️ Assistir')),
    h('div', { class: 'tile-name' }, `🖥️ Tela de ${user.displayName}`));
}

export function fullscreenEl() { return document.fullscreenElement || document.webkitFullscreenElement || null; }

function exitFullscreen() {
  const fn = document.exitFullscreen || document.webkitExitFullscreen;
  if (fn && fullscreenEl()) Promise.resolve(fn.call(document)).catch(() => {});
}

function toggleFullscreen(tile, video) {
  if (fullscreenEl()) return exitFullscreen();
  const req = tile.requestFullscreen || tile.webkitRequestFullscreen;
  if (req) {
    Promise.resolve(req.call(tile, { navigationUI: 'hide' }))
      .then(() => { try { screen.orientation.lock('landscape').catch(() => {}); } catch { /* celular sem suporte */ } })
      .catch(() => toast('O navegador não deixou abrir em tela cheia.'));
  } else if (video.webkitEnterFullscreen) {
    video.webkitEnterFullscreen(); // iPhone
  } else {
    toast('Este navegador não tem tela cheia.');
  }
}

// Mostra a resolução e os quadros por segundo que estão chegando.
function watchStats(tile, video, badge) {
  if (tile._stats) return;
  tile._stats = true;
  const show = (fps) => {
    if (!video.videoHeight) { badge.textContent = ''; return; }
    badge.textContent = `${video.videoHeight}p${fps ? ` · ${fps} fps` : ''}`;
  };
  if (video.requestVideoFrameCallback) {
    let frames = 0;
    let last = performance.now();
    const tick = (now) => {
      if (!screenTiles.has(tile.dataset.sid)) { tile._stats = false; return; }
      frames++;
      if (now - last >= 1000) { show(Math.round((frames * 1000) / (now - last))); frames = 0; last = now; }
      video.requestVideoFrameCallback(tick);
    };
    video.requestVideoFrameCallback(tick);
  } else {
    const timer = setInterval(() => {
      if (!screenTiles.has(tile.dataset.sid)) { clearInterval(timer); tile._stats = false; return; }
      show(0);
    }, 1000);
  }
  video.addEventListener('resize', () => show(0));
}

function screenTile(track, user, { isLocal, hasAudio, identity, participant }) {
  let tile = screenTiles.get(track.sid);
  if (!tile) {
    const video = videoEl(track);
    const name = h('div', { class: 'tile-name' });
    const badge = h('span', { class: 'screen-badge' });
    const volIcon = h('button', { type: 'button', class: 'sc-btn sc-mute' });
    const slider = h('input', { type: 'range', min: '0', max: '100', step: '5', class: 'sc-range', 'aria-label': 'Volume da transmissão' });
    const volBox = h('div', { class: 'sc-vol' }, volIcon, slider);
    const fsBtn = h('button', { type: 'button', class: 'sc-btn sc-fs', title: 'Tela cheia (ou duplo clique na tela)', 'aria-label': 'Tela cheia' }, '⛶');
    const ctlBtn = h('button', { type: 'button', class: 'sc-btn sc-ctl' });
    const hideBtn = h('button', { type: 'button', class: 'sc-btn sc-hide', title: 'Parar de assistir (economiza internet)', 'aria-label': 'Parar de assistir' }, '🙈');
    const hint = h('div', { class: 'rc-hint', hidden: true });
    const clipSlot = h('span', { class: 'clip-slot' });
    tile = h('div', { class: 'tile screen', dataset: { sid: track.sid }, tabindex: '0' },
      video, name, hint, h('div', { class: 'screen-controls' }, volBox, badge, clipSlot, ctlBtn, hideBtn, fsBtn));
    Object.assign(tile, { _clipSlot: clipSlot, _name: name, _volBox: volBox, _slider: slider, _volIcon: volIcon, _ctlBtn: ctlBtn, _video: video, _hideBtn: hideBtn });
    hideBtn.addEventListener('click', () => { if (tile._participant) setWatching(tile._participant, false); });
    ctlBtn.addEventListener('click', () => {
      const { viewing } = remoteState();
      if (viewing && viewing.identity === tile._identity) stopViewing();
      else if (!viewing) requestControl(tile._identity, tile._userName);
    });

    const paintVol = (v) => {
      slider.value = String(Math.round(v * 100));
      volIcon.textContent = v === 0 ? '🔇' : v < 0.5 ? '🔉' : '🔊';
      volIcon.title = v === 0 ? 'Ligar o som da transmissão' : 'Silenciar a transmissão';
      slider.title = `Volume da transmissão: ${Math.round(v * 100)}%`;
    };
    tile._paintVol = paintVol;
    slider.addEventListener('input', () => { const v = Number(slider.value) / 100; setScreenVolume(tile._uid, v); paintVol(v); });
    volIcon.addEventListener('click', () => {
      const cur = screenVolumeOf(tile._uid);
      const next = cur > 0 ? 0 : (tile._lastVol || 1);
      if (cur > 0) tile._lastVol = cur;
      setScreenVolume(tile._uid, next);
      paintVol(next);
    });
    fsBtn.addEventListener('click', () => toggleFullscreen(tile, video));
    tile.addEventListener('dblclick', (e) => { if (!e.target.closest('.screen-controls')) toggleFullscreen(tile, video); });
    tile.addEventListener('keydown', (e) => { if ((e.key === 'f' || e.key === 'F') && e.target === tile && !tile.classList.contains('controlling')) toggleFullscreen(tile, video); });
    // Em tela cheia, os controles e o mouse somem depois de um tempo parado.
    let idle = null;
    const wake = () => { tile.classList.remove('idle'); clearTimeout(idle); idle = setTimeout(() => tile.classList.add('idle'), 2500); };
    tile.addEventListener('mousemove', wake);
    tile.addEventListener('touchstart', wake, { passive: true });
    watchStats(tile, video, badge);
    screenTiles.set(track.sid, tile);
  }
  tile._uid = user.id;
  tile._identity = identity;
  tile._participant = participant;
  tile._hideBtn.hidden = isLocal;
  tile._userName = user.displayName;
  tile._name.textContent = `🖥️ Tela de ${user.displayName}${isLocal ? ' (você)' : ''}`;
  tile._clipSlot.replaceChildren(...[clipButton(track.sid)].filter(Boolean));
  // Controle remoto (só na tela dos outros).
  const { viewing } = remoteState();
  const mine = viewing && viewing.identity === identity ? viewing.state : null;
  tile._ctlBtn.hidden = isLocal || !identity || (!!viewing && !mine);
  tile._ctlBtn.textContent = mine === 'active' ? '✋' : mine === 'pending' ? '⏳' : '🖱️';
  tile._ctlBtn.title = mine === 'active' ? 'Soltar o controle' : mine === 'pending' ? 'Aguardando resposta… (clique para cancelar)' : `Pedir para controlar o PC de ${user.displayName}`;
  tile._ctlBtn.classList.toggle('on', mine === 'active');
  tile.classList.toggle('controlling', mine === 'active');
  if (!isLocal && identity) attachControl(tile, tile._video, identity);
  // Você não ouve o som da sua própria tela; e só mostra volume se a tela tiver som.
  tile._volBox.hidden = isLocal || !hasAudio || !user.id;
  if (!tile._volBox.hidden) tile._paintVol(screenVolumeOf(user.id));
  return tile;
}

// Tela do canal de voz: grade com câmeras, telas compartilhadas e avatares.
// "others" = quem está no canal segundo o servidor (para quando você não entrou).
export function renderStage(el, { channel, serverId, serverName, others, members, isDm = false, compact = false }) {
  const here = vs.room && vs.channelId === channel.id;
  el.classList.toggle('compact', compact);
  if (!here && !vs.room) syncClipBuffers([]);
  if (!here && isDm) {
    el.replaceChildren(h('div', { class: 'stage-lobby small' },
      h('div', { class: 'lobby-people' }, others.map((s) => {
        const m = members.find((x) => x.id === s.userId);
        return m ? avatar(m, { size: 'lg' }) : null;
      })),
      h('p', { class: 'muted' }, 'Chamada em andamento'),
      h('div', { class: 'lobby-actions' },
        h('button', { class: 'btn primary', disabled: vs.connecting, onclick: () => joinVoice({ channelId: channel.id, channelName: channel.name, serverId: null, serverName: '', isDm: true }) }, '📞 Entrar'),
        h('button', { class: 'btn', disabled: vs.connecting, onclick: () => joinVoice({ channelId: channel.id, channelName: channel.name, serverId: null, serverName: '', isDm: true, video: true }) }, '📹 Com vídeo'))));
    return;
  }
  if (!here) {
    el.replaceChildren(h('div', { class: 'stage-lobby' },
      h('div', { class: 'stage-icon' }, '🔊'),
      h('h2', {}, channel.name),
      h('p', { class: 'muted' }, others.length
        ? `${others.length} ${others.length === 1 ? 'pessoa conectada' : 'pessoas conectadas'}`
        : 'Ninguém aqui ainda. Que tal começar a conversa?'),
      others.length ? h('div', { class: 'lobby-people' }, others.map((s) => {
        const m = members.find((x) => x.id === s.userId);
        return m ? avatar(m, { size: 'sm' }) : null;
      })) : null,
      h('button', {
        class: 'btn primary big', disabled: vs.connecting,
        onclick: () => joinVoice({ channelId: channel.id, channelName: channel.name, serverId, serverName }),
      }, vs.connecting ? 'Conectando…' : 'Entrar na voz'),
      !window.isSecureContext ? h('p', { class: 'muted small' }, 'A voz precisa do endereço com https://') : null));
    return;
  }

  const { Track } = LK();
  const room = vs.room;
  const people = [room.localParticipant, ...room.remoteParticipants.values()];
  const speakerIds = new Set(others.filter((x) => x.speaker).map((x) => x.userId));
  const handIds = new Set(others.filter((x) => x.hand).map((x) => x.userId));
  const meId = myUserId();
  // A plateia vem da lista do servidor (quem está no canal e não está no palco).
  const audience = channel.stage ? others.filter((x) => !x.speaker).map((x) => {
    const m = members.find((mm) => mm.id === x.userId) || { id: x.userId, displayName: 'Alguém' };
    return { user: m, isLocal: x.userId === meId, hand: !!x.hand };
  }) : [];
  const recorders = noticeRecorders(channel.id, others, members);
  const liveScreens = new Set();
  for (const p of people) {
    const pub = p.getTrackPublication(Track.Source.ScreenShare);
    if (pub && pub.track && !pub.isMuted) liveScreens.add(pub.track.sid);
  }
  // Alguém está vendo uma tela em tela cheia: não redesenha (senão sai da tela cheia),
  // a não ser que essa transmissão tenha acabado.
  const fs = fullscreenEl();
  const iosFs = [...screenTiles.values()].some((t) => { const v = t.querySelector('video'); return v && v.webkitDisplayingFullscreen; });
  if ((fs && el.contains(fs)) || iosFs) {
    if (iosFs || (fs.dataset.sid && liveScreens.has(fs.dataset.sid))) return;
    exitFullscreen();
  }
  for (const sid of [...screenTiles.keys()]) if (!liveScreens.has(sid)) screenTiles.delete(sid);
  // Clipes: guarda os últimos segundos das telas que estão sendo vistas.
  const clipScreens = [];
  for (const p of people) {
    const pub = p.getTrackPublication(Track.Source.ScreenShare);
    if (!pub || !pub.track || pub.isMuted || (p !== room.localParticipant && unwatched.has(p.identity))) continue;
    const apub = Track.Source.ScreenShareAudio ? p.getTrackPublication(Track.Source.ScreenShareAudio) : null;
    const uid = participantUserId(p);
    const m = members.find((x) => x.id === uid);
    clipScreens.push({
      sid: pub.track.sid, videoTrack: pub.track.mediaStreamTrack,
      audioTrack: apub && apub.track && !apub.isMuted ? apub.track.mediaStreamTrack : null,
      name: m ? m.displayName : (p.name || p.identity),
    });
  }
  syncClipBuffers(clipScreens);
  const tiles = [];
  for (const p of people) {
    const isLocal = p === room.localParticipant;
    const userId = participantUserId(p);
    const member = members.find((x) => x.id === userId);
    const user = member || { id: userId || 0, displayName: p.name || p.identity };
    const screenPub = p.getTrackPublication(Track.Source.ScreenShare);
    if (!isLocal && screenPub && !screenPub.isMuted && unwatched.has(p.identity)) {
      tiles.push(pausedScreenTile(p, user));
    } else if (screenPub && screenPub.track && !screenPub.isMuted) {
      const audioPub = Track.Source.ScreenShareAudio ? p.getTrackPublication(Track.Source.ScreenShareAudio) : null;
      tiles.push(screenTile(screenPub.track, user, { isLocal, hasAudio: !!(audioPub && !audioPub.isMuted), identity: p.identity, participant: p }));
    }
    // Palco: quem está na plateia aparece embaixo, não num quadrado.
    if (channel.stage && userId && !speakerIds.has(userId)) continue; // plateia: lista embaixo
    const camPub = p.getTrackPublication(Track.Source.Camera);
    const micPub = p.getTrackPublication(Track.Source.Microphone);
    const micOff = isLocal ? vs.muted : (!micPub || micPub.isMuted);
    const hasCam = camPub && camPub.track && !camPub.isMuted;
    const vol = !isLocal && userId ? volumeOf(userId) : 1;
    const tile = h('div', {
      class: `tile${p.isSpeaking && !micOff ? ' speaking' : ''}${hasCam ? '' : ' no-video'}${!isLocal ? ' clickable' : ''}`,
      style: `--hue:${hueFor(user.id)}`,
      title: !isLocal ? 'Clique para ajustar o volume' : null,
    },
    hasCam ? videoEl(camPub.track) : avatar(user, { size: compact ? 'lg' : 'xl' }),
    h('div', { class: 'tile-name' }, micOff ? '🔇 ' : '', vol === 0 ? '🔕 ' : '', user.displayName, isLocal ? ' (você)' : ''));
    if (!isLocal && userId) tile.addEventListener('click', (e) => { if (!e.target.closest('video, .stage-down')) openVolumePopover(tile, user); });
    if (channel.stage && vs.moderator && !isLocal && userId) {
      tile.append(h('button', { class: 'btn small stage-down', title: 'Mandar para a plateia', onclick: () => stageEmit('stage:remove', { userId }) }, '⬇️ Plateia'));
    }
    tiles.push(tile);
  }
  const ptt = voiceSettings().mode === 'ptt' && vs.canSpeak;
  const me = myUserId();
  const amAudience = channel.stage && !vs.canSpeak;
  const myHand = handIds.has(me);
  const recNames = recorders.map((id) => (id === me ? 'Você' : ((members.find((x) => x.id === id) || {}).displayName || 'Alguém')));
  const audienceBox = channel.stage ? h('div', { class: 'stage-audience' },
    h('div', { class: 'aud-title' }, `🎧 Plateia (${audience.length})`, handIds.size ? h('span', { class: 'aud-hands' }, ` · ✋ ${[...handIds].filter((id) => !speakerIds.has(id)).length}`) : null),
    h('div', { class: 'aud-list' }, audience
      .sort((a, b) => Number(b.hand) - Number(a.hand))
      .map((a) => h('div', { class: `aud-person${a.hand ? ' hand' : ''}` },
        avatar(a.user, { size: 'sm' }),
        h('span', { class: 'truncate' }, a.user.displayName, a.isLocal ? ' (você)' : ''),
        a.hand ? h('span', { title: 'Levantou a mão' }, '✋') : null,
        vs.moderator && !a.isLocal ? h('button', { class: 'btn small primary', onclick: () => stageEmit('stage:invite', { userId: a.user.id }) }, '🎙️ Chamar') : null)),
    audience.length ? null : h('span', { class: 'muted small' }, 'Ninguém na plateia.'))) : null;
  el.replaceChildren(...[
    controlBanner(),
    recNames.length ? h('div', { class: 'rec-banner', role: 'status' }, `🔴 ${recNames.join(', ')} ${recNames.length === 1 && recNames[0] !== 'Você' ? 'está' : recNames[0] === 'Você' && recNames.length === 1 ? 'está' : 'estão'} gravando esta chamada`) : null,
    channel.stage ? h('div', { class: 'stage-label' }, '🎙️ Palco', h('span', { class: 'muted small' }, vs.moderator ? ' · você modera: chame quem levantou a mão' : amAudience ? ' · você está na plateia' : ' · você está falando no palco')) : null,
    h('div', { class: `stage-grid n${Math.min(tiles.length, 9)}${tiles.some((t) => t.classList.contains('screen')) ? ' has-screen' : ''}` },
      // Telas compartilhadas primeiro (em destaque), depois as pessoas.
      [...tiles.filter((t) => t.classList.contains('screen')), ...tiles.filter((t) => !t.classList.contains('screen'))]),
    audienceBox,
    h('div', { class: 'stage-bar' },
      amAudience
        ? h('button', { class: `round-btn big${myHand ? ' on' : ''}`, title: myHand ? 'Baixar a mão' : 'Levantar a mão (pedir para falar)', onclick: () => stageEmit('stage:hand', { up: !myHand }) }, '✋')
        : ptt ? pttButton('Segure para falar') : h('button', { class: `round-btn big${vs.muted ? ' off' : ''}`, title: vs.muted ? 'Ligar microfone' : 'Mutar', disabled: !vs.canSpeak, onclick: toggleMute }, vs.muted ? '🔇' : '🎤'),
      channel.stage && !amAudience && !vs.moderator ? h('button', { class: 'round-btn big', title: 'Sair do palco (voltar para a plateia)', onclick: () => stageEmit('stage:remove', { userId: me }) }, '⬇️') : null,
      h('button', { class: 'round-btn big', title: 'Soundboard', onclick: (e) => openSoundboard(e.currentTarget) }, '🎵'),
      h('button', { class: `round-btn big${vs.recording ? ' rec-on' : ''}`, title: vs.recording ? 'Parar e salvar a gravação' : 'Gravar a chamada (só áudio)', onclick: toggleRecording }, vs.recording ? '⏹️' : '⏺️'),
      vs.canVideo ? h('button', { class: `round-btn big${vs.video ? ' on' : ''}`, title: 'Câmera', onclick: toggleCamera }, '📹') : null,
      vs.canVideo ? h('button', { class: `round-btn big${vs.screen ? ' on' : ''}`, title: vs.screen ? 'Compartilhando a tela' : 'Compartilhar tela', onclick: screenButton }, '🖥️') : null,
      h('button', { class: 'round-btn big danger', title: 'Sair da voz', onclick: () => leaveVoice() }, '📞')),
  ].filter(Boolean));
}
