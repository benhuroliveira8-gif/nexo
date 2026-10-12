// Perfil mais rico (capa, cor, "jogando agora", insígnias, nível) e o
// "não perturbe" agendado (ex.: silenciar das 23h às 7h).
import { h, api, toast, getToken } from './util.js';
import { state } from './state.js';

// ---------------------------------------------------------------- "Não perturbe" agendado

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toMin = (t) => { const [a, b] = t.split(':').map(Number); return a * 60 + b; };

export function quietNow(schedule, now = new Date()) {
  if (!schedule || !schedule.enabled || !TIME_RE.test(schedule.start || '') || !TIME_RE.test(schedule.end || '')) return false;
  let hh; let mm;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: schedule.tz || undefined, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    hh = Number(parts.find((p) => p.type === 'hour').value) % 24;
    mm = Number(parts.find((p) => p.type === 'minute').value);
  } catch { hh = now.getHours(); mm = now.getMinutes(); }
  const cur = hh * 60 + mm;
  const a = toMin(schedule.start);
  const b = toMin(schedule.end);
  return a < b ? cur >= a && cur < b : cur >= a || cur < b;
}

const myTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo'; } catch { return 'America/Sao_Paulo'; } };

// Bloco das configurações (Notificações e app).
export function dndScheduleSection(me, save) {
  const cur = me.dndSchedule || { enabled: false, start: '23:00', end: '07:00' };
  const on = h('input', { type: 'checkbox', class: 'switch', checked: !!cur.enabled });
  const start = h('input', { type: 'time', value: cur.start, step: '60', class: 'time-input' });
  const end = h('input', { type: 'time', value: cur.end, step: '60', class: 'time-input' });
  const status = h('p', { class: 'muted small dnd-now' });
  const showStatus = () => {
    const sch = { enabled: on.checked, start: start.value, end: end.value, tz: myTz() };
    status.textContent = !on.checked ? 'Desligado: notificações e sons seguem o seu status normal.'
      : quietNow(sch) ? '🌙 Agora está no horário de silêncio.' : `Vai silenciar todo dia das ${start.value} às ${end.value}.`;
  };
  showStatus();
  [on, start, end].forEach((x) => x.addEventListener('input', showStatus));
  const btn = h('button', {
    class: 'btn primary small',
    onclick: async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try {
        await save({ dndSchedule: { enabled: on.checked, start: start.value, end: end.value, tz: myTz() } });
        toast(on.checked ? `Silêncio agendado das ${start.value} às ${end.value}. 🌙` : 'Silêncio agendado desligado.');
      } catch (err) { toast(err.message); }
      b.disabled = false;
    },
  }, 'Salvar horário');
  return h('div', { class: 'dnd-schedule' },
    h('label', { class: 'perm' },
      h('div', { class: 'perm-text' }, h('strong', {}, 'Silenciar automaticamente'),
        h('span', { class: 'muted small' }, 'No horário escolhido você não recebe notificações no celular/computador, nem sons de mensagem ou de ligação. As mensagens continuam chegando normalmente.')),
      on),
    h('div', { class: 'row-actions dnd-times' }, h('span', {}, 'Das'), start, h('span', {}, 'às'), end, btn),
    status);
}

// ---------------------------------------------------------------- "Jogando agora"

export const ACTIVITY_TYPES = [
  ['playing', '🎮', 'Jogando'],
  ['listening', '🎧', 'Ouvindo'],
  ['watching', '📺', 'Assistindo'],
  ['streaming', '🔴', 'Transmitindo'],
];
const typeInfo = (t) => ACTIVITY_TYPES.find((x) => x[0] === t) || ACTIVITY_TYPES[0];

export function activityText(a) {
  if (!a || !a.name) return '';
  const [, icon, label] = typeInfo(a.type);
  return `${icon} ${label} ${a.name}`;
}

function elapsed(since) {
  const min = Math.max(0, Math.floor((Date.now() - new Date(since)) / 60000));
  if (min < 1) return 'agora mesmo';
  if (min < 60) return `há ${min} min`;
  const hrs = Math.floor(min / 60);
  return hrs < 24 ? `há ${hrs} h${min % 60 ? ` ${min % 60} min` : ''}` : `há ${Math.floor(hrs / 24)} dia(s)`;
}

export function activityBlock(a) {
  if (!a || !a.name) return null;
  const [, icon, label] = typeInfo(a.type);
  return h('div', { class: 'profile-section activity-card' },
    h('div', { class: 'profile-label' }, `${label} agora`),
    h('div', { class: 'activity-row' },
      h('span', { class: 'activity-icon' }, icon),
      h('span', { class: 'activity-text' }, h('strong', {}, a.name), a.since ? h('span', { class: 'muted small' }, elapsed(a.since)) : null)));
}

// ---------------------------------------------------------------- Cartão de perfil

// Capa: imagem, ou a cor do perfil, ou o degradê padrão.
export function paintBanner(el, { bannerUrl, profileColor }) {
  if (bannerUrl) {
    el.style.backgroundImage = `url("${bannerUrl}")`;
    el.classList.add('has-image');
  } else if (profileColor) {
    el.style.background = `linear-gradient(135deg, ${profileColor}, color-mix(in srgb, ${profileColor} 55%, #000))`;
  }
}

export function badgesRow(badges) {
  if (!badges || !badges.length) return null;
  return h('div', { class: 'badges-row' }, badges.map((b) => h('span', { class: `pbadge b-${b.id}`, title: b.label, 'aria-label': b.label }, b.emoji)));
}

export function levelBlock(level) {
  if (!level) return null;
  const pct = Math.round((level.current / level.needed) * 100);
  return h('div', { class: 'profile-section level-card' },
    h('div', { class: 'profile-label' }, 'Nível no servidor'),
    h('div', { class: 'level-row' },
      h('span', { class: 'level-num' }, `⭐ ${level.level}`),
      h('div', { class: 'level-bar', title: `${level.current}/${level.needed} XP` }, h('i', { style: `width:${pct}%` })),
      level.rank ? h('span', { class: 'muted small' }, `#${level.rank}`) : null),
    h('div', { class: 'muted small' }, `${level.xp} XP no total • faltam ${level.needed - level.current} para o nível ${level.level + 1}`));
}

// ---------------------------------------------------------------- Editar (Minha conta)

async function uploadBanner(file) {
  const blob = await bannerBlob(file);
  const res = await fetch('/api/me/banner', { method: 'POST', headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/octet-stream' }, body: blob });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data.user;
}

// Capa (do perfil ou do servidor): recorta em 5:2 e reduz. GIF animado vai como está.
export async function bannerBlob(file) {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw new Error('Escolha uma imagem PNG, JPG, GIF ou WEBP.');
  if (file.type === 'image/gif') {
    if (file.size > 8 * 1024 * 1024) throw new Error('GIF animado pode ter no máximo 8 MB.');
    return file;
  }
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error('Não deu para abrir essa imagem.'); });
  const W = 960; const H = 384; // proporção 5:2
  const scale = Math.max(W / bitmap.width, H / bitmap.height);
  const sw = W / scale; const sh = H / scale;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, (bitmap.width - sw) / 2, (bitmap.height - sh) / 2, sw, sh, 0, 0, W, H);
  if (bitmap.close) bitmap.close();
  const toBlob = (type, q) => new Promise((r) => canvas.toBlob(r, type, q));
  let blob = await toBlob('image/webp', 0.85);
  if (!blob || blob.type !== 'image/webp') blob = await toBlob('image/jpeg', 0.85);
  return blob;
}

const COLORS = ['#5865f2', '#3ba55d', '#faa61a', '#ed4245', '#eb459e', '#9b59b6', '#1abc9c', '#e67e22', '#34495e', '#c0a062'];

// Capa, cor e "jogando agora" (vai na página "Minha conta").
export function profileLookSection(me, { applyMe, rerender }) {
  const save = async (changes) => {
    const { user } = await api('/me', { method: 'PATCH', body: changes });
    applyMe(user);
    rerender();
  };
  const pickBanner = () => {
    const picker = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp' });
    picker.addEventListener('change', async () => {
      const file = picker.files[0];
      if (!file) return;
      try { toast('Enviando capa…'); applyMe(await uploadBanner(file)); toast('Capa atualizada!'); rerender(); } catch (err) { toast(err.message); }
    });
    picker.click();
  };
  const colorInput = h('input', { type: 'color', class: 'swatch-custom', title: 'Outra cor', value: me.profileColor || '#5865f2' });
  colorInput.addEventListener('change', () => save({ profileColor: colorInput.value }).catch((err) => toast(err.message)));

  const a = me.activity || {};
  const type = h('select', { class: 'activity-type' }, ACTIVITY_TYPES.map(([v, icon, label]) => h('option', { value: v, selected: (a.type || 'playing') === v }, `${icon} ${label}`)));
  const name = h('input', { value: a.name || '', maxlength: '64', placeholder: 'Ex.: Minecraft, Valorant, Spotify…', list: 'activity-suggestions' });
  const suggestions = h('datalist', { id: 'activity-suggestions' },
    ['Minecraft', 'Valorant', 'League of Legends', 'Counter-Strike 2', 'Fortnite', 'EA FC', 'Roblox', 'GTA V', 'Free Fire', 'Spotify', 'YouTube', 'Netflix']
      .map((x) => h('option', { value: x })));
  return h('div', { class: 'settings-block' },
    h('h3', {}, 'Visual do perfil'),
    h('div', { class: 'field' }, h('span', {}, 'Capa (aparece no topo do seu perfil)'),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn small', onclick: pickBanner }, me.bannerUrl ? 'Trocar capa' : 'Escolher capa'),
        me.bannerUrl ? h('button', {
          class: 'btn small danger-ghost',
          onclick: async () => { try { applyMe((await api('/me/banner', { method: 'DELETE' })).user); rerender(); } catch (err) { toast(err.message); } },
        }, 'Remover capa') : null,
        h('span', { class: 'muted small' }, 'Dica: imagem deitada (5:2). GIF animado vale (até 8 MB).'))),
    h('div', { class: 'field' }, h('span', {}, 'Cor do perfil (usada quando não tem capa)'),
      h('div', { class: 'swatches' },
        COLORS.map((c) => h('button', {
          class: `swatch${(me.profileColor || '') === c ? ' active' : ''}`, style: `background:${c}`, title: c,
          onclick: () => save({ profileColor: c }).catch((err) => toast(err.message)),
        })),
        colorInput,
        me.profileColor ? h('button', { class: 'btn small', onclick: () => save({ profileColor: null }).catch((err) => toast(err.message)) }, 'Padrão') : null)),
    h('div', { class: 'field' }, h('span', {}, '"Jogando agora" (aparece para quem está nos seus servidores)'),
      h('div', { class: 'row-actions activity-edit' }, type, name, suggestions,
        h('button', {
          class: 'btn primary small',
          onclick: () => save({ activity: name.value.trim() ? { type: type.value, name: name.value.trim() } : null })
            .then(() => toast(name.value.trim() ? 'Atividade salva!' : 'Atividade removida.')).catch((err) => toast(err.message)),
        }, 'Salvar'),
        me.activity ? h('button', { class: 'btn small', onclick: () => save({ activity: null }).catch((err) => toast(err.message)) }, 'Limpar') : null)),
    state.config && state.config.lastfm ? lastfmField(me, save) : null);
}

// "Ouvindo" automático pelo Last.fm (Spotify, YouTube Music, Deezer… conectados ao Last.fm).
function lastfmField(me, save) {
  const input = h('input', { value: me.lastfmUser || '', maxlength: '15', placeholder: 'seu usuário no Last.fm' });
  return h('div', { class: 'field' },
    h('span', {}, '🎧 "Ouvindo" automático'),
    h('p', { class: 'muted small' }, 'Crie uma conta grátis em last.fm e conecte o seu Spotify (ou outro app de música) nela. Aí o Nexo mostra "Ouvindo Artista — Música" sozinho enquanto toca. Se você escrever um "Jogando agora" à mão, ele tem prioridade.'),
    h('div', { class: 'row-actions activity-edit' }, input,
      h('button', {
        class: 'btn primary small',
        onclick: () => save({ lastfmUser: input.value.trim() })
          .then(() => toast(input.value.trim() ? 'Pronto! Toque uma música para aparecer em até 1 minuto. 🎧' : 'Last.fm desligado.'))
          .catch((err) => toast(err.message)),
      }, input.value ? 'Salvar' : 'Ligar')));
}
