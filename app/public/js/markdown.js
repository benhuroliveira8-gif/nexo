// Formatação de texto das mensagens (estilo Discord), sempre montando elementos
// (nunca HTML cru), então ninguém consegue injetar código pelas mensagens.
//
//   **negrito**   *itálico* ou _itálico_   __sublinhado__   ~~riscado~~
//   `código`      ```bloco de código```    > citação        ||spoiler||
//   links e @menções
import { h } from './util.js';

const URL_RE = /^https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]}'"]/i;
const MENTION_RE = /^@([a-z0-9_.]{3,32})/i;
const SPECIAL = new Set(['`', '|', '*', '_', '~', 'h', 'H', '@', '\\', '<']);
const ESCAPABLE = new Set(['*', '_', '~', '`', '|', '>', '\\', '@', '<']);

// ctx: { users: Map(username -> user), meId, onMention(el, user) }
function inline(text, ctx, depth = 0) {
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push(buf); buf = ''; } };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (!SPECIAL.has(ch) || depth > 6) { buf += ch; i++; continue; }
    const rest = text.slice(i);
    const prev = i > 0 ? text[i - 1] : '';
    let m;

    if (ch === '\\' && ESCAPABLE.has(text[i + 1])) { buf += text[i + 1]; i += 2; continue; }

    if (ch === '`' && (m = /^`([^`\n]+)`/.exec(rest))) {
      flush(); out.push(h('code', { class: 'md-code' }, m[1])); i += m[0].length; continue;
    }
    if (ch === '|' && (m = /^\|\|([\s\S]+?)\|\|/.exec(rest))) {
      flush();
      const el = h('span', { class: 'spoiler', title: 'Spoiler: clique para ver', tabindex: '0', role: 'button' }, inline(m[1], ctx, depth + 1));
      const reveal = (e) => { if (!el.classList.contains('revealed')) { e.preventDefault(); e.stopPropagation(); el.classList.add('revealed'); el.removeAttribute('title'); } };
      el.addEventListener('click', reveal);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') reveal(e); });
      out.push(el); i += m[0].length; continue;
    }
    if (ch === '*' && (m = /^\*\*([\s\S]+?)\*\*(?!\*)/.exec(rest))) {
      flush(); out.push(h('strong', {}, inline(m[1], ctx, depth + 1))); i += m[0].length; continue;
    }
    if (ch === '_' && (m = /^__([\s\S]+?)__(?!_)/.exec(rest))) {
      flush(); out.push(h('u', {}, inline(m[1], ctx, depth + 1))); i += m[0].length; continue;
    }
    if (ch === '*' && (m = /^\*(?![\s*])([\s\S]*?[^\s\\])\*(?!\*)/.exec(rest))) {
      flush(); out.push(h('em', {}, inline(m[1], ctx, depth + 1))); i += m[0].length; continue;
    }
    if (ch === '_' && !/[\p{L}\p{N}_]/u.test(prev) && (m = /^_(?![\s_])([\s\S]*?[^\s\\])_(?![\p{L}\p{N}_])/u.exec(rest))) {
      flush(); out.push(h('em', {}, inline(m[1], ctx, depth + 1))); i += m[0].length; continue;
    }
    if (ch === '~' && (m = /^~~([\s\S]+?)~~/.exec(rest))) {
      flush(); out.push(h('s', {}, inline(m[1], ctx, depth + 1))); i += m[0].length; continue;
    }
    // Emoji personalizado do servidor: <:nome:id> ou <a:nome:id>
    if (ch === '<' && (m = /^<(a?):([a-z0-9_]{2,32}):(\d{1,10})>/.exec(rest))) {
      flush(); out.push(customEmoji(m[2], m[3])); i += m[0].length; continue;
    }
    // <https://link> = link sem prévia
    if (ch === '<' && (m = /^<(https?:\/\/[^\s<>"]+)>/i.exec(rest))) {
      flush(); out.push(link(m[1])); i += m[0].length; continue;
    }
    if ((ch === 'h' || ch === 'H') && !/[\w/]/.test(prev) && (m = URL_RE.exec(rest))) {
      flush(); out.push(link(m[0])); i += m[0].length; continue;
    }
    if (ch === '@' && !/[\w@]/.test(prev) && (m = MENTION_RE.exec(rest))) {
      const name = m[1].toLowerCase().replace(/\.+$/, '');
      const user = ctx.users ? ctx.users.get(name) : null;
      if (name === 'everyone' || name === 'here' || user) {
        flush();
        const shown = user ? `@${user.displayName}` : `@${name}`;
        const el = h('span', {
          class: `mention${user && user.id === ctx.meId ? ' me' : ''}`,
          title: user ? `@${user.username}` : null,
        }, shown);
        if (user && ctx.onMention) el.addEventListener('click', () => ctx.onMention(el, user));
        out.push(el);
        i += 1 + name.length; // mantém o ponto final que veio grudado (ex.: "@ana.")
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

export function customEmoji(name, id, cls = 'cemoji') {
  const img = h('img', { class: cls, src: `/emoji/${id}`, alt: `:${name}:`, title: `:${name}:`, draggable: 'false', loading: 'lazy' });
  // Emoji apagado: mostra o nome.
  img.addEventListener('error', () => img.replaceWith(`:${name}:`));
  return img;
}

function link(url) {
  return h('a', { href: url, target: '_blank', rel: 'noopener noreferrer nofollow' }, url);
}

// Só emojis (até 10)? Mostra grandão.
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u;
export function isJumbo(text) {
  const t = String(text || '').replace(/<a?:[a-z0-9_]{2,32}:\d{1,10}>/g, '😀').trim();
  if (!t || !EMOJI_ONLY.test(t) || /^[\d#*\s]+$/.test(t)) return false;
  const count = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(t.replace(/\s+/g, ''))].length;
  return count <= 10;
}

// Texto completo (com blocos de código e citações).
export function renderMarkdown(text, ctx = {}) {
  const out = [];
  const src = String(text || '');
  const parts = src.split(/(```[\s\S]*?```)/g);
  const isCode = (p) => /^```[\s\S]*```$/.test(p) && p.length > 6;
  parts.forEach((part, idx) => {
    if (!part) return;
    const code = /^```([\w+#.-]{0,20})\n?([\s\S]*?)\n?```$/.exec(part);
    if (!isCode(part)) {
      if (idx > 0 && isCode(parts[idx - 1])) part = part.replace(/^\n/, '');
      if (idx < parts.length - 1 && isCode(parts[idx + 1])) part = part.replace(/\n$/, '');
      if (!part) return;
    }
    if (code && part.length > 6) {
      out.push(h('pre', { class: 'md-pre' }, h('code', { class: code[1] ? `lang-${code[1]}` : null }, code[2] || ' ')));
      return;
    }
    // Citações: linhas começando com "> "
    const lines = part.split('\n');
    let i = 0;
    let plain = [];
    const flushPlain = () => {
      if (!plain.length) return;
      out.push(...inline(plain.join('\n'), ctx));
      plain = [];
    };
    while (i < lines.length) {
      if (/^> /.test(lines[i]) || lines[i] === '>') {
        flushPlain();
        const q = [];
        while (i < lines.length && (/^> /.test(lines[i]) || lines[i] === '>')) { q.push(lines[i].replace(/^> ?/, '')); i++; }
        out.push(h('blockquote', { class: 'md-quote' }, inline(q.join('\n'), ctx)));
      } else {
        plain.push(lines[i]);
        i++;
      }
    }
    flushPlain();
  });
  return out;
}

// Versão sem formatação (para notificações, citações de resposta etc.).
export function stripMarkdown(text) {
  return String(text || '')
    .replace(/<a?:([a-z0-9_]{2,32}):\d{1,10}>/g, ':$1:')
    .replace(/\|\|[\s\S]*?\|\|/g, '▒▒▒▒')
    .replace(/```[\w+#.-]*\n?/g, '')
    .replace(/(\*\*|__|~~|`|\*|_)/g, '')
    .replace(/^> /gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}
