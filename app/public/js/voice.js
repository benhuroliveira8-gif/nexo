// Voz, vídeo e compartilhamento de tela (LiveKit).
//
// O áudio/vídeo vai direto do navegador para o servidor LiveKit (pelo Caddy, em HTTPS).
// O Nexo só autoriza a entrada (token) e mostra para todos quem está em cada canal.
import { h, api, avatar, toast, openDialog, hueFor, storage, openPopover, closePopover } from './util.js';
import {
  initRemote, onData, remoteState, requestControl, stopViewing, endHosting, attachControl,
  onParticipantGone, onScreenStopped, onRemoteScreenStopped, resetRemote,
} from './remote.js';

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
};

// ---------------------------------------------------------------- Preferências de voz (deste aparelho)
const DEFAULT_SETTINGS = {
  mode: 'voice', pttKey: 'ControlLeft', noiseSuppression: true, echoCancellation: true, autoGainControl: true,
  screenQuality: '1080p30', screenContent: 'motion', screenAudio: true,
  micId: '', speakerId: '', camId: '', // '' = padrão do sistema
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
const cameraOptions = () => ({ ...pickDevice(voiceSettings().camId) });

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

export function initVoice(opts) {
  getSocket = opts.getSocket;
  onChange = opts.onChange;
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
    socket.emit('voice:state', { muted: vs.muted, deafened: vs.deafened, video: vs.video, screen: vs.screen });
  }
}

function announceJoin() {
  const socket = getSocket();
  if (!socket || !vs.room) return;
  socket.emit('voice:join', {
    channelId: vs.channelId, muted: vs.muted, deafened: vs.deafened, video: vs.video, screen: vs.screen,
  }, (res) => {
    if (res && !res.ok) toast(res.error);
  });
}

export async function joinVoice({ channelId, channelName, serverId, serverName, isDm = false, video = false }) {
  if (!window.isSecureContext) return explainHttps();
  if (vs.connecting) return;
  if (vs.room && vs.channelId === channelId) return;

  vs.connecting = true;
  onChange();
  try {
    const [{ token, canSpeak, canVideo }] = await Promise.all([
      api(`/voice/${channelId}/token`, { method: 'POST' }),
      loadLivekit(),
    ]);
    if (vs.room) await leaveVoice({ silent: true });

    const { Room } = LK();
    const room = new Room({ adaptiveStream: true, dynacast: true, audioCaptureDefaults: captureOptions(), videoCaptureDefaults: cameraOptions() });
    wireRoom(room);
    Object.assign(vs, {
      room, channelId, serverId, channelName, serverName, canSpeak, canVideo, isDm,
      muted: !canSpeak, deafened: false, video: false, screen: false, pttDown: false,
    });

    await room.connect(`wss://${location.host}`, token);
    try { await room.startAudio(); } catch { /* navegador pode exigir um clique */ }
    vs.needsAudioClick = room.canPlaybackAudio === false;

    if (canSpeak) {
      try {
        // No modo "aperte para falar" o microfone começa desligado.
        const ptt = voiceSettings().mode === 'ptt';
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
  resetRemote();
  vs.room = null;
  if (room) {
    try { await room.disconnect(); } catch { /* já caiu */ }
  }
  for (const el of trackEls.values()) el.remove();
  trackEls.clear();
  const socket = getSocket();
  if (socket && vs.channelId && !silent) socket.emit('voice:leave');
  Object.assign(vs, { channelId: null, serverId: null, isDm: false, video: false, screen: false, deafened: false, needsAudioClick: false, pttDown: false });
  onChange();
}

// Depois de uma queda do Nexo (ex.: deploy), avisa de novo que estamos na voz.
export function resyncAfterReconnect() {
  if (vs.room) announceJoin();
}

window.addEventListener('pagehide', () => { if (vs.room) vs.room.disconnect(); });

// ---------------------------------------------------------------- Eventos do LiveKit

function wireRoom(room) {
  const { RoomEvent, Track } = LK();
  const changed = () => { if (vs.room === room) onChange(); };

  room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
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
  room.on(RoomEvent.TrackUnpublished, (pub, p) => { if (pub && p && pub.source === Track.Source.ScreenShare) onRemoteScreenStopped(p.identity); });
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
  room.on(RoomEvent.Disconnected, () => {
    if (vs.room !== room) return;
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
      }, '🖥️') : null),
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

function screenTile(track, user, { isLocal, hasAudio, identity }) {
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
    const hint = h('div', { class: 'rc-hint', hidden: true });
    tile = h('div', { class: 'tile screen', dataset: { sid: track.sid }, tabindex: '0' },
      video, name, hint, h('div', { class: 'screen-controls' }, volBox, badge, ctlBtn, fsBtn));
    Object.assign(tile, { _name: name, _volBox: volBox, _slider: slider, _volIcon: volIcon, _ctlBtn: ctlBtn, _video: video });
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
  tile._userName = user.displayName;
  tile._name.textContent = `🖥️ Tela de ${user.displayName}${isLocal ? ' (você)' : ''}`;
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
  const tiles = [];
  for (const p of people) {
    const isLocal = p === room.localParticipant;
    const userId = participantUserId(p);
    const member = members.find((x) => x.id === userId);
    const user = member || { id: userId || 0, displayName: p.name || p.identity };
    const screenPub = p.getTrackPublication(Track.Source.ScreenShare);
    if (screenPub && screenPub.track && !screenPub.isMuted) {
      const audioPub = Track.Source.ScreenShareAudio ? p.getTrackPublication(Track.Source.ScreenShareAudio) : null;
      tiles.push(screenTile(screenPub.track, user, { isLocal, hasAudio: !!(audioPub && !audioPub.isMuted), identity: p.identity }));
    }
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
    if (!isLocal && userId) tile.addEventListener('click', (e) => { if (!e.target.closest('video')) openVolumePopover(tile, user); });
    tiles.push(tile);
  }
  const ptt = voiceSettings().mode === 'ptt' && vs.canSpeak;
  el.replaceChildren(...[
    controlBanner(),
    h('div', { class: `stage-grid n${Math.min(tiles.length, 9)}${tiles.some((t) => t.classList.contains('screen')) ? ' has-screen' : ''}` },
      // Telas compartilhadas primeiro (em destaque), depois as pessoas.
      [...tiles.filter((t) => t.classList.contains('screen')), ...tiles.filter((t) => !t.classList.contains('screen'))]),
    h('div', { class: 'stage-bar' },
      ptt ? pttButton('Segure para falar') : h('button', { class: `round-btn big${vs.muted ? ' off' : ''}`, title: vs.muted ? 'Ligar microfone' : 'Mutar', disabled: !vs.canSpeak, onclick: toggleMute }, vs.muted ? '🔇' : '🎤'),
      vs.canVideo ? h('button', { class: `round-btn big${vs.video ? ' on' : ''}`, title: 'Câmera', onclick: toggleCamera }, '📹') : null,
      vs.canVideo ? h('button', { class: `round-btn big${vs.screen ? ' on' : ''}`, title: vs.screen ? 'Compartilhando a tela' : 'Compartilhar tela', onclick: screenButton }, '🖥️') : null,
      h('button', { class: 'round-btn big danger', title: 'Sair da voz', onclick: () => leaveVoice() }, '📞')),
  ].filter(Boolean));
}
