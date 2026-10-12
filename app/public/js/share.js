// Compartilhar da galeria do celular direto para o Nexo (app instalado).
// O service worker guarda as fotos; aqui a pessoa escolhe a conversa e envia.
import { h, api, toast, openDialog, uploadFile, formatSize } from './util.js';

const SHARE_CACHE = 'nexo-share';

export async function readPendingShare() {
  if (!('caches' in window)) return null;
  try {
    const cache = await caches.open(SHARE_CACHE);
    const res = await cache.match('/compartilhado/meta');
    if (!res) return null;
    const meta = await res.json();
    // Muito antigo (mais de 1 hora): descarta.
    if (Date.now() - meta.at > 3600000) { await clearShare(); return null; }
    const files = [];
    for (const f of meta.files || []) {
      const r = await cache.match(f.key);
      if (r) files.push(new File([await r.blob()], f.name, { type: f.type }));
    }
    return { ...meta, files };
  } catch { return null; }
}

export async function clearShare() {
  try { await caches.delete(SHARE_CACHE); } catch { /* */ }
}

// hooks: { dms: [{ channelId, label }], servers: [{ id, name }], send(channelId, content, attachmentIds), open(channelId, serverId) }
export function openShareDialog(share, hooks) {
  const text = [share.title, share.text, share.url].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join('\n');
  const message = h('textarea', { class: 'textarea', rows: '3', maxlength: '4000', placeholder: 'Escreva algo (opcional)' });
  message.value = text;
  const thumbs = h('div', { class: 'share-thumbs' }, share.files.map((f) => (f.type.startsWith('image/')
    ? h('img', { class: 'share-thumb', src: URL.createObjectURL(f), alt: f.name })
    : h('div', { class: 'share-file' }, `📎 ${f.name}`, h('span', { class: 'muted small' }, formatSize(f.size))))));
  const where = h('select', { class: 'share-where' },
    hooks.dms.length ? h('optgroup', { label: 'Conversas' }, hooks.dms.map((d) => h('option', { value: `dm:${d.channelId}` }, d.label))) : null,
    hooks.servers.length ? h('optgroup', { label: 'Servidores' }, hooks.servers.map((s) => h('option', { value: `sv:${s.id}` }, s.name))) : null);
  const channel = h('select', { class: 'share-channel', hidden: true });
  const channelField = h('label', { class: 'field', hidden: true }, 'Canal', channel);
  const loadChannels = async () => {
    const v = where.value;
    if (!v.startsWith('sv:')) { channelField.hidden = true; return; }
    channel.replaceChildren(h('option', {}, 'Carregando…'));
    channelField.hidden = false;
    channel.hidden = false;
    try {
      const d = await api(`/servers/${v.slice(3)}`);
      const list = d.channels.filter((c) => c.kind === 'text').sort((a, b) => a.position - b.position);
      channel.replaceChildren(...list.map((c) => h('option', { value: String(c.id) }, `# ${c.name}`)));
    } catch (err) { channel.replaceChildren(); toast(err.message); }
  };
  where.addEventListener('change', loadChannels);
  loadChannels();
  const progress = h('div', { class: 'muted small share-progress' });
  openDialog({
    title: '📤 Compartilhar no Nexo',
    body: h('div', { class: 'share-dialog' },
      thumbs,
      h('label', { class: 'field' }, 'Mandar para', where),
      channelField,
      h('label', { class: 'field' }, 'Mensagem', message),
      progress),
    actions: [
      { label: 'Cancelar', onClick: () => clearShare() },
      {
        label: 'Enviar', kind: 'primary', submit: true,
        onClick: async () => {
          const v = where.value;
          if (!v) throw new Error('Escolha para onde mandar.');
          const serverId = v.startsWith('sv:') ? Number(v.slice(3)) : null;
          const channelId = serverId ? Number(channel.value) : Number(v.slice(3));
          if (!channelId) throw new Error('Escolha o canal.');
          const ids = [];
          for (let i = 0; i < Math.min(share.files.length, 5); i++) {
            progress.textContent = `Enviando ${i + 1} de ${Math.min(share.files.length, 5)}…`;
            const a = await uploadFile(share.files[i], (p) => { progress.textContent = `Enviando ${i + 1} de ${Math.min(share.files.length, 5)}… ${Math.round(p * 100)}%`; });
            ids.push(a.id);
          }
          progress.textContent = '';
          await hooks.send(channelId, message.value.trim(), ids);
          await clearShare();
          if (share.files.length > 5) toast('Foram enviados só os 5 primeiros arquivos.');
          else toast('Enviado! ✅');
          hooks.open(channelId, serverId);
        },
      },
    ],
  });
}
