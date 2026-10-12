// Leitura em voz alta: o navegador lê as mensagens novas dos canais escolhidos
// (bom para quem está jogando e não pode olhar a tela). Tudo fica neste aparelho.
import { h, storage, toast, openMenu } from './util.js';
import { stripMarkdown } from './markdown.js';

const KEY = 'nexo.tts';
const DEFAULTS = { channels: [], rate: 1.1, volume: 1, voice: '', readOwn: false, readNames: true };

export const ttsSupported = () => 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function';

export function ttsSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(storage(KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}
function saveTts(changes) {
  const next = { ...ttsSettings(), ...changes };
  storage(KEY, JSON.stringify(next));
  listeners.forEach((fn) => { try { fn(); } catch { /* */ } });
  return next;
}
const listeners = new Set();
export const onTtsChange = (fn) => listeners.add(fn);

export const isReading = (channelId) => ttsSettings().channels.includes(channelId);

export function setReading(channelId, on) {
  const list = ttsSettings().channels.filter((id) => id !== channelId);
  if (on) list.push(channelId);
  saveTts({ channels: list.slice(-30) });
  if (!on) stopSpeaking();
}

function voices() {
  if (!ttsSupported()) return [];
  const all = speechSynthesis.getVoices();
  // Português primeiro (Brasil antes de Portugal).
  const score = (v) => (/^pt-BR/i.test(v.lang) ? 0 : /^pt/i.test(v.lang) ? 1 : 2);
  return [...all].sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
}

function pickVoice() {
  const want = ttsSettings().voice;
  const list = voices();
  return list.find((v) => v.voiceURI === want) || list.find((v) => /^pt-BR/i.test(v.lang)) || list.find((v) => /^pt/i.test(v.lang)) || null;
}

// Texto falado: sem formatação, links viram "link", emojis personalizados viram o nome.
export function spokenText(msg, { authorName, mentionName } = {}) {
  let text = String(msg.content || '')
    .replace(/<a?:([a-z0-9_]{2,32}):\d{1,10}>/gi, ' $1 ')
    .replace(/https?:\/\/\S+/gi, ' link ')
    .replace(/\|\|[\s\S]*?\|\|/g, ' spoiler ')
    .replace(/```[\s\S]*?```/g, ' bloco de código ');
  text = stripMarkdown(text)
    .replace(/(^|\s)@([a-z0-9_.]{3,32})/gi, (m, pre, u) => `${pre}${mentionName ? mentionName(u) : u}`)
    .replace(/\s+/g, ' ').trim();
  if (!text) {
    if (msg.gif) text = 'mandou um GIF';
    else if (msg.sticker) text = `mandou a figurinha ${msg.sticker.name}`;
    else if (msg.poll) text = `criou a enquete: ${msg.poll.question}`;
    else if ((msg.attachments || []).some((a) => a.isVoice)) text = 'mandou um áudio';
    else if ((msg.attachments || []).some((a) => a.kind === 'image')) text = 'mandou uma imagem';
    else if ((msg.attachments || []).length) text = 'mandou um arquivo';
  }
  if (text.length > 300) text = `${text.slice(0, 300)}… e mais`;
  if (!text) return '';
  if (msg.kind === 'system') return text;
  return ttsSettings().readNames && authorName ? `${authorName}: ${text}` : text;
}

export function speak(text) {
  if (!ttsSupported() || !text) return false;
  const st = ttsSettings();
  const u = new SpeechSynthesisUtterance(text);
  const v = pickVoice();
  if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'pt-BR';
  u.rate = Math.min(2, Math.max(0.5, Number(st.rate) || 1));
  u.volume = Math.min(1, Math.max(0, Number(st.volume) ?? 1));
  // Fila muito grande (canal agitado): pula as antigas.
  if (speechSynthesis.pending && queued > 6) { speechSynthesis.cancel(); queued = 0; }
  queued++;
  u.onend = () => { queued = Math.max(0, queued - 1); };
  u.onerror = u.onend;
  speechSynthesis.speak(u);
  return true;
}
let queued = 0;

export function stopSpeaking() {
  if (ttsSupported()) speechSynthesis.cancel();
  queued = 0;
}

// Chamado para cada mensagem nova que chega.
export function maybeSpeak(msg, { meId, authorName, mentionName }) {
  if (!ttsSupported() || !isReading(msg.channelId)) return false;
  if (msg.author && msg.author.id === meId && !ttsSettings().readOwn) return false;
  if (msg.kind && !['default', 'system'].includes(msg.kind)) return false;
  return speak(spokenText(msg, { authorName, mentionName }));
}

// Botão do cabeçalho do canal.
export function ttsHeaderButton(channelId, label) {
  if (!ttsSupported()) return null;
  const on = isReading(channelId);
  return h('button', {
    class: `icon-btn tts-btn${on ? ' on' : ''}`,
    title: on ? 'Lendo as mensagens em voz alta (clique para opções)' : 'Ler as mensagens novas em voz alta',
    'aria-pressed': on ? 'true' : 'false',
    onclick: (e) => {
      const anchor = e.currentTarget;
      if (!on) {
        setReading(channelId, true);
        speak(`Vou ler as mensagens novas de ${label}.`);
        toast(`🗣️ Lendo em voz alta as mensagens novas de ${label}.`);
        return;
      }
      openMenu(anchor, [
        { label: '⏹️  Parar a leitura agora', onClick: stopSpeaking },
        { label: '🔇  Não ler mais este canal', onClick: () => { setReading(channelId, false); toast('Leitura em voz alta desligada.'); } },
        { label: '⚙️  Voz e velocidade…', onClick: () => window.dispatchEvent(new CustomEvent('nexo:open-settings', { detail: 'voice' })) },
      ], { align: 'end', className: 'popover-menu' });
    },
  }, on ? '🗣️' : '🔈');
}

// Configurações (aba "Voz e vídeo").
export function ttsSettingsSection() {
  if (!ttsSupported()) return h('p', { class: 'muted' }, 'Este navegador não tem leitura em voz alta.');
  const st = ttsSettings();
  const select = h('select', {});
  const fill = () => {
    const list = voices();
    select.replaceChildren(h('option', { value: '' }, 'Automática (português)'),
      ...list.map((v) => h('option', { value: v.voiceURI, selected: v.voiceURI === st.voice }, `${v.name} (${v.lang})`)));
  };
  fill();
  // As vozes carregam depois em alguns navegadores.
  if (speechSynthesis.onvoiceschanged !== undefined) speechSynthesis.addEventListener('voiceschanged', fill, { once: true });
  select.addEventListener('change', () => saveTts({ voice: select.value }));
  const rate = h('input', { type: 'range', min: '0.6', max: '2', step: '0.1', value: String(st.rate) });
  const rateLabel = h('span', { class: 'muted small' }, `${Number(st.rate).toFixed(1)}x`);
  rate.addEventListener('input', () => { rateLabel.textContent = `${Number(rate.value).toFixed(1)}x`; });
  rate.addEventListener('change', () => saveTts({ rate: Number(rate.value) }));
  const sw = (key, label, desc) => h('label', { class: 'perm' },
    h('div', { class: 'perm-text' }, h('strong', {}, label), h('span', { class: 'muted small' }, desc)),
    h('input', { type: 'checkbox', class: 'switch', checked: !!st[key], onchange: (e) => saveTts({ [key]: e.target.checked }) }));
  const n = st.channels.length;
  return h('div', {},
    h('p', { class: 'muted' }, 'Clique no 🔈 no topo de um canal para o Nexo ler as mensagens novas dele (ótimo jogando, sem olhar a tela). Funciona com o Nexo aberto, mesmo minimizado.'),
    h('label', { class: 'field' }, 'Voz', select),
    h('div', { class: 'field' }, h('span', {}, 'Velocidade'), h('div', { class: 'row-actions' }, rate, rateLabel)),
    h('div', { class: 'perm-list' },
      sw('readNames', 'Falar o nome de quem mandou', '"Ana: bora jogar?"'),
      sw('readOwn', 'Ler as minhas mensagens também', 'Normalmente só as dos outros.')),
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn small', onclick: () => speak('Oi! Assim vão soar as mensagens no Nexo.') }, '▶️ Testar voz'),
      n ? h('button', { class: 'btn small', onclick: (e) => { saveTts({ channels: [] }); stopSpeaking(); e.currentTarget.remove(); toast('Leitura desligada em todos os canais.'); } }, `Desligar em todos (${n})`) : null));
}
