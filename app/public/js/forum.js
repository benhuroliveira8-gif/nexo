// Fóruns: um tipo de canal em que cada post vira um tópico com respostas
// (bom para dúvidas, sugestões e guias).
import { h, api, avatar, toast, openDialog, uploadFile, formatSize } from './util.js';

let current = null; // { el, channel, sort, q, opts }

const ago = (date) => {
  const s = Math.max(0, (Date.now() - new Date(date)) / 1000);
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  if (s < 30 * 86400) return `há ${Math.floor(s / 86400)} d`;
  return new Date(date).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
};

// opts: { canPost, onOpenPost(id), renderContent(text) }
export function renderForumPage(el, channel, opts) {
  const same = current && current.channel.id === channel.id && current.el === el;
  current = { el, channel, sort: same ? current.sort : 'active', q: same ? current.q : '', opts, posts: same ? current.posts : null };
  draw();
  loadPosts();
}

export function forgetForum() { current = null; }

// Algo mudou (post novo, resolvido...): recarrega se esse fórum estiver aberto.
export function onForumChanged(channelId) {
  if (current && current.channel.id === channelId && current.el.isConnected && !current.el.hidden) loadPosts();
}

let seq = 0;
async function loadPosts() {
  const cur = current;
  const my = ++seq;
  try {
    const qs = new URLSearchParams({ sort: cur.sort, ...(cur.q ? { q: cur.q } : {}) });
    const { posts } = await api(`/channels/${cur.channel.id}/posts?${qs}`);
    if (my !== seq || cur !== current) return;
    cur.posts = posts;
    cur.error = null;
  } catch (err) {
    if (my !== seq || cur !== current) return;
    cur.error = err.message;
  }
  drawList();
}

function draw() {
  const { el, channel, opts } = current;
  const search = h('input', { type: 'search', class: 'forum-search', placeholder: 'Buscar posts…', value: current.q, maxlength: '100' });
  let t;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { current.q = search.value.trim(); loadPosts(); }, 300); });
  const sort = h('select', { class: 'forum-sort', title: 'Ordenar' },
    h('option', { value: 'active', selected: current.sort === 'active' }, 'Atividade recente'),
    h('option', { value: 'new', selected: current.sort === 'new' }, 'Mais novos'));
  sort.addEventListener('change', () => { current.sort = sort.value; loadPosts(); });
  el.replaceChildren(h('div', { class: 'forum' },
    h('div', { class: 'forum-head' },
      h('div', { class: 'forum-title' }, h('span', { class: 'forum-icon' }, '💬'), h('h2', {}, channel.name)),
      channel.topic ? h('div', { class: 'forum-topic' }, opts.renderContent(channel.topic)) : null,
      h('div', { class: 'forum-bar' },
        search, sort,
        opts.canPost ? h('button', { class: 'btn primary', onclick: () => newPostDialog(channel, opts) }, '＋ Novo post') : null)),
    h('div', { class: 'forum-list', 'aria-live': 'polite' }, h('p', { class: 'muted forum-empty' }, 'Carregando…'))));
  if (current.posts) drawList();
}

function drawList() {
  const list = current.el.querySelector('.forum-list');
  if (!list) return;
  const { posts, error, opts } = current;
  if (error) return list.replaceChildren(h('p', { class: 'muted forum-empty' }, error));
  if (!posts) return;
  if (!posts.length) {
    return list.replaceChildren(h('div', { class: 'forum-empty' },
      h('div', { class: 'forum-empty-icon' }, '💬'),
      h('p', {}, current.q ? 'Nenhum post encontrado.' : 'Nenhum post ainda.'),
      !current.q && opts.canPost ? h('button', { class: 'btn primary', onclick: () => newPostDialog(current.channel, opts) }, 'Criar o primeiro post') : null));
  }
  list.replaceChildren(...posts.map((p) => h('button', {
    class: `forum-post${p.unread ? ' unread' : ''}${p.solved ? ' solved' : ''}`,
    dataset: { postId: String(p.id) },
    onclick: () => opts.onOpenPost(p.id),
  },
  h('div', { class: 'fp-main' },
    h('div', { class: 'fp-title' },
      p.pinned ? h('span', { class: 'fp-tag pin', title: 'Fixado' }, '📌') : null,
      p.solved ? h('span', { class: 'fp-tag ok' }, '✅ Resolvido') : null,
      h('span', { class: 'fp-name' }, p.title)),
    p.preview ? h('div', { class: 'fp-preview muted' }, p.preview) : null,
    h('div', { class: 'fp-meta muted small' },
      p.author ? avatar(p.author, { size: 'xs' }) : null,
      h('span', {}, p.author ? p.author.displayName : 'Usuário removido'),
      h('span', {}, '•'),
      h('span', { title: 'Respostas' }, `💬 ${p.replies}`),
      h('span', {}, '•'),
      h('span', { title: new Date(p.lastAt).toLocaleString('pt-BR') }, ago(p.lastAt)))),
  p.image ? h('img', { class: 'fp-thumb', src: p.image, alt: '', loading: 'lazy' }) : null)));
}

// Janela "Novo post": título, primeira mensagem e até 4 anexos.
export function newPostDialog(channel, opts) {
  const title = h('input', { maxlength: '100', placeholder: 'Ex.: Como faço para…?' });
  const content = h('textarea', { class: 'textarea', rows: '6', maxlength: '4000', placeholder: 'Conte os detalhes. Dá para usar **negrito**, links e @menções.' });
  const files = [];
  const fileList = h('div', { class: 'post-files' });
  const drawFiles = () => fileList.replaceChildren(...files.map((f, i) => h('span', { class: 'post-file' },
    f.error ? `⚠️ ${f.file.name}` : f.attachment ? `📎 ${f.file.name} (${formatSize(f.file.size)})` : `⏳ ${f.file.name} ${Math.round((f.progress || 0) * 100)}%`,
    h('button', { type: 'button', class: 'icon-btn small', title: 'Tirar', onclick: () => { files.splice(i, 1); drawFiles(); } }, '✕'))));
  const picker = h('input', { type: 'file', multiple: true, hidden: true });
  picker.addEventListener('change', () => {
    for (const file of [...picker.files].slice(0, 4 - files.length)) {
      const item = { file, progress: 0 };
      files.push(item);
      uploadFile(file, (pr) => { item.progress = pr; drawFiles(); })
        .then((a) => { item.attachment = a; drawFiles(); })
        .catch((err) => { item.error = err.message; drawFiles(); toast(err.message); });
    }
    picker.value = '';
    drawFiles();
  });
  openDialog({
    title: `Novo post em 💬 ${channel.name}`,
    wide: true,
    body: h('div', { class: 'new-post' },
      h('label', { class: 'field' }, 'Título', title),
      h('label', { class: 'field' }, 'Mensagem', content),
      h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn small', onclick: () => picker.click() }, '📎 Anexar imagem/arquivo'), picker),
      fileList),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Publicar', kind: 'primary', submit: true,
        onClick: async () => {
          if (!title.value.trim()) throw new Error('Dê um título ao post.');
          if (files.some((f) => !f.attachment && !f.error)) throw new Error('Espere os anexos terminarem de enviar.');
          const attachmentIds = files.filter((f) => f.attachment).map((f) => f.attachment.id);
          if (!content.value.trim() && !attachmentIds.length) throw new Error('Escreva a mensagem do post.');
          const res = await api(`/channels/${channel.id}/posts`, { method: 'POST', body: { title: title.value.trim(), content: content.value, attachmentIds } });
          toast('Post publicado! 🎉');
          if (opts.onCreated) opts.onCreated(res.channel);
        },
      },
    ],
  });
  setTimeout(() => title.focus(), 50);
}

// Botões do cabeçalho quando um post de fórum está aberto.
export function postHeaderActions(post, { isAuthor, canModerate }) {
  const out = [];
  if (isAuthor || canModerate) {
    out.push(h('button', {
      class: `icon-btn post-solve${post.solved ? ' on' : ''}`,
      title: post.solved ? 'Marcar como não resolvido' : 'Marcar como resolvido',
      onclick: () => api(`/posts/${post.id}`, { method: 'PATCH', body: { solved: !post.solved } })
        .then(() => toast(post.solved ? 'Post reaberto.' : 'Marcado como resolvido ✅')).catch((err) => toast(err.message)),
    }, post.solved ? '✅' : '☑️'));
  }
  if (canModerate) {
    out.push(h('button', {
      class: `icon-btn post-pin${post.pinned ? ' on' : ''}`,
      title: post.pinned ? 'Desafixar do topo do fórum' : 'Fixar no topo do fórum',
      onclick: () => api(`/posts/${post.id}`, { method: 'PATCH', body: { pinned: !post.pinned } }).catch((err) => toast(err.message)),
    }, post.pinned ? '📍' : '📌'));
  }
  return out;
}
