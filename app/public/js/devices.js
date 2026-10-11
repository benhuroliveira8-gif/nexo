// Escolha de microfone, saída de som e câmera (Configurações → Voz e vídeo),
// com teste de cada um. Tudo fica salvo só neste aparelho.
import { h, toast } from './util.js';
import { voiceSettings, saveVoiceSettings, canPickSpeaker, applySpeaker, captureOptions } from './voice.js';

const KIND = { mic: 'audioinput', speaker: 'audiooutput', cam: 'videoinput' };
const KEY = { mic: 'micId', speaker: 'speakerId', cam: 'camId' };
const FALLBACK = { mic: 'Microfone', speaker: 'Saída de som', cam: 'Câmera' };

const supported = () => !!(navigator.mediaDevices && navigator.mediaDevices.enumerateDevices);

async function listDevices() {
  if (!supported()) return [];
  try { return await navigator.mediaDevices.enumerateDevices(); } catch { return []; }
}

// Os nomes só aparecem depois que a pessoa deixa o site usar o microfone/câmera.
const hasLabels = (list) => list.some((d) => d.label);

// "default" e "communications" são atalhos do Chrome; viram a opção "Padrão do sistema".
function optionsFor(list, which) {
  const kind = KIND[which];
  const all = list.filter((d) => d.kind === kind);
  const def = all.find((d) => d.deviceId === 'default');
  const real = all.filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
  const defLabel = def && def.label ? `Padrão do sistema (${def.label.replace(/^(Padrão|Default)\s*-\s*/i, '')})` : 'Padrão do sistema';
  return [
    { id: '', label: defLabel },
    ...real.map((d, i) => ({ id: d.deviceId, label: d.label || `${FALLBACK[which]} ${i + 1}` })),
  ];
}

export function devicesSection() {
  const root = h('div', { class: 'devices' });
  const state = { list: [], micTest: null, camTest: null };

  const stopMic = () => {
    if (!state.micTest) return;
    state.micTest.stream.getTracks().forEach((t) => t.stop());
    state.micTest.ctx.close().catch(() => {});
    state.micTest = null;
  };
  const stopCam = () => {
    if (!state.camTest) return;
    state.camTest.getTracks().forEach((t) => t.stop());
    state.camTest = null;
  };
  // Saiu da página de configurações: desliga os testes.
  const watchdog = setInterval(() => {
    if (!root.isConnected) { stopMic(); stopCam(); clearInterval(watchdog); navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange); }
  }, 500);

  // ---------- Microfone
  const meterFill = h('i');
  const meter = h('div', { class: 'mic-meter', title: 'Nível do microfone' }, meterFill);
  const micBtn = h('button', { type: 'button', class: 'btn small' }, '🎙️ Testar');
  const micNote = h('p', { class: 'muted small dev-note' });
  async function startMic() {
    stopMic();
    try {
      const opts = captureOptions();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { ...opts } });
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      state.micTest = { stream, ctx };
      const data = new Uint8Array(analyser.fftSize);
      const tick = () => {
        if (!state.micTest || state.micTest.stream !== stream) return;
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
        meterFill.style.width = `${Math.min(100, Math.round((peak / 128) * 140))}%`;
        requestAnimationFrame(tick);
      };
      tick();
      micBtn.textContent = '⏹️ Parar teste';
      micNote.textContent = 'Fale alguma coisa: a barra deve se mexer.';
      if (!hasLabels(state.list)) refresh();
    } catch (err) {
      micNote.textContent = err && err.name === 'NotAllowedError'
        ? '🚫 O navegador bloqueou o microfone. Libere no cadeado ao lado do endereço.'
        : 'Não foi possível abrir esse microfone.';
    }
  }
  micBtn.addEventListener('click', () => {
    if (state.micTest) { stopMic(); meterFill.style.width = '0'; micBtn.textContent = '🎙️ Testar'; micNote.textContent = ''; } else startMic();
  });

  // ---------- Saída de som
  const spkBtn = h('button', { type: 'button', class: 'btn small' }, '🔊 Testar som');
  spkBtn.addEventListener('click', async () => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const dest = ctx.createMediaStreamDestination();
      const audio = new Audio();
      audio.srcObject = dest.stream;
      await applySpeaker(audio);
      const t = ctx.currentTime;
      [[523.25, 0], [659.25, 0.18], [783.99, 0.36]].forEach(([freq, at]) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t + at);
        gain.gain.exponentialRampToValueAtTime(0.25, t + at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.3);
        osc.connect(gain).connect(dest);
        osc.start(t + at);
        osc.stop(t + at + 0.32);
      });
      await audio.play();
      setTimeout(() => { audio.pause(); audio.srcObject = null; ctx.close().catch(() => {}); }, 1000);
    } catch {
      toast('Não foi possível tocar o som de teste.');
    }
  });

  // ---------- Câmera
  const preview = h('video', { class: 'cam-preview', muted: true, playsinline: true, autoplay: true });
  preview.muted = true;
  const camBtn = h('button', { type: 'button', class: 'btn small' }, '📷 Testar câmera');
  const camNote = h('p', { class: 'muted small dev-note' });
  async function startCam() {
    stopCam();
    try {
      const id = voiceSettings().camId;
      const stream = await navigator.mediaDevices.getUserMedia({ video: id ? { deviceId: { ideal: id } } : true });
      state.camTest = stream;
      preview.srcObject = stream;
      preview.hidden = false;
      preview.play().catch(() => {});
      camBtn.textContent = '⏹️ Desligar câmera';
      camNote.textContent = '';
      if (!hasLabels(state.list)) refresh();
    } catch (err) {
      preview.hidden = true;
      camNote.textContent = err && err.name === 'NotAllowedError'
        ? '🚫 O navegador bloqueou a câmera. Libere no cadeado ao lado do endereço.'
        : 'Não foi possível abrir essa câmera (ela pode estar sendo usada por outro programa).';
    }
  }
  camBtn.addEventListener('click', () => {
    if (state.camTest) { stopCam(); preview.srcObject = null; preview.hidden = true; camBtn.textContent = '📷 Testar câmera'; } else startCam();
  });
  preview.hidden = true;

  // ---------- Listas
  const selects = {};
  const select = (which) => {
    const el = h('select', { class: 'dev-select', 'aria-label': FALLBACK[which] });
    el.addEventListener('change', () => {
      saveVoiceSettings({ [KEY[which]]: el.value });
      if (which === 'mic' && state.micTest) startMic();
      if (which === 'cam' && state.camTest) startCam();
      toast(which === 'speaker' ? 'Saída de som trocada.' : which === 'mic' ? 'Microfone trocado.' : 'Câmera trocada.');
    });
    selects[which] = el;
    return el;
  };

  const askBtn = h('button', { type: 'button', class: 'btn small primary' }, 'Mostrar os nomes dos aparelhos');
  askBtn.addEventListener('click', async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
    } catch {
      toast('O navegador não deixou usar o microfone. Libere no cadeado ao lado do endereço.');
    }
    try {
      if (state.list.some((d) => d.kind === 'videoinput')) {
        const s = await navigator.mediaDevices.getUserMedia({ video: true });
        s.getTracks().forEach((t) => t.stop());
      }
    } catch { /* sem câmera ou bloqueada: tudo bem */ }
    refresh();
  });
  const askBox = h('div', { class: 'dev-ask' },
    h('p', { class: 'muted small' }, 'Por segurança, o navegador só mostra os nomes dos microfones, fones e câmeras depois que você deixa o Nexo usá-los.'),
    askBtn);

  const speakerRow = h('div', { class: 'dev-row' }, select('speaker'), spkBtn);
  const row = (icon, title, ...children) => h('div', { class: 'dev-field' }, h('div', { class: 'dev-label' }, `${icon} ${title}`), ...children);

  root.append(
    askBox,
    row('🎙️', 'Microfone', h('div', { class: 'dev-row' }, select('mic'), micBtn), meter, micNote),
    row('🎧', 'Saída de som (alto-falante ou fone)',
      canPickSpeaker() ? speakerRow : h('p', { class: 'muted small' }, 'Este navegador não deixa escolher a saída de som; ele usa a do sistema. No Chrome ou no Edge dá para escolher.'),
      canPickSpeaker() ? h('p', { class: 'muted small dev-note' }, 'Vale para o som das chamadas.') : null),
    row('📷', 'Câmera', h('div', { class: 'dev-row' }, select('cam'), camBtn), preview, camNote),
  );

  function fill() {
    const st = voiceSettings();
    for (const which of Object.keys(selects)) {
      const el = selects[which];
      const opts = optionsFor(state.list, which);
      let chosen = st[KEY[which]] || '';
      // Aparelho salvo não está conectado agora: mostra como "desconectado".
      if (chosen && !opts.some((o) => o.id === chosen)) opts.push({ id: chosen, label: '(aparelho escolhido está desconectado — usando o padrão)' });
      el.replaceChildren(...opts.map((o) => h('option', { value: o.id, selected: o.id === chosen }, o.label)));
      el.value = chosen;
      const present = state.list.some((d) => d.kind === KIND[which]);
      el.disabled = !present && !chosen;
      if (which === 'cam') { camBtn.disabled = !present; if (!present) camNote.textContent = 'Nenhuma câmera conectada.'; }
      if (which === 'mic') { micBtn.disabled = !present; if (!present) micNote.textContent = 'Nenhum microfone conectado.'; }
    }
    askBox.hidden = hasLabels(state.list) || state.list.length === 0;
  }
  async function refresh() {
    state.list = await listDevices();
    if (root.isConnected || !state.loaded) fill();
    state.loaded = true;
  }
  function onDeviceChange() { refresh(); }
  navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange);

  if (!supported()) {
    root.replaceChildren(h('p', { class: 'muted' }, 'Este navegador não permite escolher aparelhos de áudio e vídeo.'));
    return root;
  }
  refresh();
  return root;
}
