// Voz, vídeo e compartilhamento de tela (LiveKit).
//
// O áudio/vídeo vai direto do navegador para o servidor LiveKit (pelo Caddy, em HTTPS).
// O Nexo só autoriza a entrada (token) e mostra para todos quem está em cada canal.
import { h, api, avatar, toast, openDialog, hueFor } from './util.js';

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

let getSocket = () => null;
let onChange = () => {};
const trackEls = new Map(); // track.sid -> elemento <video>/<audio>

export function initVoice(opts) {
  getSocket = opts.getSocket;
  onChange = opts.onChange;
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

export async function joinVoice({ channelId, channelName, serverId, serverName }) {
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
    const room = new Room({ adaptiveStream: true, dynacast: true });
    wireRoom(room);
    Object.assign(vs, {
      room, channelId, serverId, channelName, serverName, canSpeak, canVideo,
      muted: !canSpeak, deafened: false, video: false, screen: false,
    });

    await room.connect(`wss://${location.host}`, token);
    try { await room.startAudio(); } catch { /* navegador pode exigir um clique */ }
    vs.needsAudioClick = room.canPlaybackAudio === false;

    if (canSpeak) {
      try {
        await room.localParticipant.setMicrophoneEnabled(true);
        vs.muted = false;
      } catch (err) {
        vs.muted = true;
        toast(micErrorMessage(err));
      }
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
  vs.room = null;
  if (room) {
    try { await room.disconnect(); } catch { /* já caiu */ }
  }
  for (const el of trackEls.values()) el.remove();
  trackEls.clear();
  const socket = getSocket();
  if (socket && vs.channelId && !silent) socket.emit('voice:leave');
  Object.assign(vs, { channelId: null, serverId: null, video: false, screen: false, deafened: false, needsAudioClick: false });
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

  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind === Track.Kind.Audio) {
      const el = track.attach();
      el.muted = vs.deafened;
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
    if (pub.source === Track.Source.ScreenShare) { vs.screen = false; emitState(); }
    if (pub.source === Track.Source.Camera) { vs.video = false; emitState(); }
    const el = pub.track && trackEls.get(pub.track.sid);
    if (el) { el.remove(); trackEls.delete(pub.track.sid); }
    changed();
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
  room.on(RoomEvent.Disconnected, () => {
    if (vs.room !== room) return;
    toast('Você foi desconectado da voz.');
    leaveVoice();
  });
}

// ---------------------------------------------------------------- Botões

export async function toggleMute() {
  if (!vs.room || !vs.canSpeak) return;
  if (vs.deafened) return toggleDeafen(); // desensurdecer também desmuta
  const next = !vs.muted;
  try {
    await vs.room.localParticipant.setMicrophoneEnabled(!next);
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
      vs.muted = vs.mutedBeforeDeafen;
    }
    try { await vs.room.localParticipant.setMicrophoneEnabled(!vs.muted); } catch { vs.muted = true; }
  }
  emitState();
  onChange();
}

export async function toggleCamera() {
  if (!vs.room || !vs.canVideo) return;
  try {
    await vs.room.localParticipant.setCameraEnabled(!vs.video);
    vs.video = !vs.video;
  } catch (err) {
    toast(err && err.name === 'NotAllowedError' ? 'O navegador bloqueou a câmera.' : 'Não foi possível ligar a câmera.');
  }
  emitState();
  onChange();
}

export async function toggleScreen() {
  if (!vs.room || !vs.canVideo) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    return toast('Este navegador não consegue compartilhar a tela.');
  }
  try {
    await vs.room.localParticipant.setScreenShareEnabled(!vs.screen, { audio: true });
    vs.screen = !vs.screen;
  } catch (err) {
    // Fechar a janela de escolha da tela também cai aqui; não é erro de verdade.
    if (err && err.name !== 'NotAllowedError') toast('Não foi possível compartilhar a tela.');
  }
  emitState();
  onChange();
}

export async function enableAudio() {
  if (!vs.room) return;
  try { await vs.room.startAudio(); } catch { /* tenta de novo no próximo clique */ }
  vs.needsAudioClick = vs.room.canPlaybackAudio === false;
  onChange();
}

// ---------------------------------------------------------------- Telas

const icon = (on, offIcon, onIcon) => (on ? onIcon : offIcon);

// Painel "Voz conectada" acima do seu nome.
export function renderVoicePanel(el) {
  if (!vs.room && !vs.connecting) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const status = vs.connecting ? 'Conectando…' : vs.reconnecting ? 'Reconectando…' : 'Voz conectada';
  el.replaceChildren(...[
    h('div', { class: 'vp-top' },
      h('div', { class: 'vp-info' },
        h('strong', { class: `vp-status${vs.connecting || vs.reconnecting ? ' warn' : ''}` }, status),
        h('span', { class: 'muted truncate' }, `🔊 ${vs.channelName} / ${vs.serverName}`)),
      h('button', { class: 'vp-btn danger', title: 'Sair da voz', onclick: () => leaveVoice() }, '📞')),
    vs.needsAudioClick ? h('button', { class: 'btn small primary vp-audio', onclick: enableAudio }, '🔈 Clique para ouvir') : null,
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
        title: vs.screen ? 'Parar de compartilhar a tela' : 'Compartilhar a tela', onclick: toggleScreen,
      }, '🖥️') : null),
  ].filter(Boolean));
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

// Tela do canal de voz: grade com câmeras, telas compartilhadas e avatares.
// "others" = quem está no canal segundo o servidor (para quando você não entrou).
export function renderStage(el, { channel, serverId, serverName, others, members }) {
  const here = vs.room && vs.channelId === channel.id;
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
  const tiles = [];
  for (const p of people) {
    const isLocal = p === room.localParticipant;
    const userId = participantUserId(p);
    const member = members.find((x) => x.id === userId);
    const user = member || { id: userId || 0, displayName: p.name || p.identity };
    const screenPub = p.getTrackPublication(Track.Source.ScreenShare);
    if (screenPub && screenPub.track && !screenPub.isMuted) {
      tiles.push(h('div', { class: 'tile screen' }, videoEl(screenPub.track),
        h('div', { class: 'tile-name' }, `🖥️ Tela de ${user.displayName}${isLocal ? ' (você)' : ''}`)));
    }
    const camPub = p.getTrackPublication(Track.Source.Camera);
    const micPub = p.getTrackPublication(Track.Source.Microphone);
    const micOff = isLocal ? vs.muted : (!micPub || micPub.isMuted);
    const hasCam = camPub && camPub.track && !camPub.isMuted;
    tiles.push(h('div', { class: `tile${p.isSpeaking && !micOff ? ' speaking' : ''}${hasCam ? '' : ' no-video'}`, style: `--hue:${hueFor(user.id)}` },
      hasCam ? videoEl(camPub.track) : avatar(user, { size: 'xl' }),
      h('div', { class: 'tile-name' }, micOff ? '🔇 ' : '', user.displayName, isLocal ? ' (você)' : '')));
  }
  el.replaceChildren(
    h('div', { class: `stage-grid n${Math.min(tiles.length, 9)}` }, tiles),
    h('div', { class: 'stage-bar' },
      h('button', { class: `round-btn big${vs.muted ? ' off' : ''}`, title: vs.muted ? 'Ligar microfone' : 'Mutar', disabled: !vs.canSpeak, onclick: toggleMute }, vs.muted ? '🔇' : '🎤'),
      vs.canVideo ? h('button', { class: `round-btn big${vs.video ? ' on' : ''}`, title: 'Câmera', onclick: toggleCamera }, '📹') : null,
      vs.canVideo ? h('button', { class: `round-btn big${vs.screen ? ' on' : ''}`, title: 'Compartilhar tela', onclick: toggleScreen }, '🖥️') : null,
      h('button', { class: 'round-btn big danger', title: 'Sair da voz', onclick: () => leaveVoice() }, '📞')),
  );
}
