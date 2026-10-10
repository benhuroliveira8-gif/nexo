// Formatação das mensagens (parecida com a do Discord):
//   **negrito**  *itálico* ou _itálico_  __sublinhado__  ~~riscado~~  ||spoiler||
//   `código`  ```bloco de código```  > citação  >>> citação até o fim
//   # Título  ## Subtítulo  ### Menor   - lista   1. lista numerada
// Tudo vira elementos com textContent: nunca HTML vindo do usuário.
import { h } from './util.js';

const URL_RE = /https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]}'"*_~|]/;
const RULES = [
  ['escape', /\\([*_~`|\\>#\-])/],
  ['code', /`([^`\n]+)`/],
  ['url', URL_RE],
  ['bold', /\*\*(?=\S)([\s\S]*?\S)\*\*/],
  ['underline', /__(?=\S)([\s\S]*?\S)__/],
  ['strike', /~~(?=\S)([\s\S]*?\S)~~/],
  ['spoiler', /\|\|(?=\S)([\s\S]*?\S)\|\|/],
  ['italic', /\*(?=[^\s*])([^*]*?[^\s*])\*/],
  ['italic', /(?<![\p{L}\p{N}_])_(?=[^\s_])([^_]*?[^\s_])_(?![\p{L}\p{N}_])/u],
];

// Texto de uma linha (ou parágrafo) → nós. "leaf" cuida de links e @menções.
function inline(text, leaf, depth = 0) {
  const out = [];
  let rest = text;
  while (rest) {
    let best = null;
    if (depth < 6) {
      for (const [type, re] of RULES) {
        const m = re.exec(rest);
        if (m && (!best || m.index < best.m.index)) best = { type, m };
      }
    }
    if (!best) { out.push(...leaf(rest)); break; }
    const { type, m } = best;
    if (m.index > 0) out.push(...leaf(rest.slice(0, m.index)));
    const inner = () => inline(m[1], leaf, depth + 1);
    switch (type) {
      case 'escape': out.push(m[1]); break;
      case 'code': out.push(h('code', { class: 'md-code' }, m[1])); break;
      case 'url': out.push(...leaf(m[0])); break;
      case 'bold': out.push(h('strong', {}, inner())); break;
      case 'underline': out.push(h('u', {}, inner())); break;
      case 'strike': out.push(h('s', {}, inner())); break;
      case 'italic': out.push(h('em', {}, inner())); break;
      case 'spoiler': {
        const el = h('span', { class: 'spoiler', title: 'Spoiler: clique para ver', role: 'button', tabindex: '0' }, inner());
        const reveal = (e) => { if (!el.classList.contains('shown')) { e.preventDefault(); e.stopPropagation(); el.classList.add('shown'); } };
        el.addEventListener('click', reveal);
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') reveal(e); });
        out.push(el);
        break;
      }
      default: out.push(m[0]);
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

// Linhas normais (fora de bloco de código) → títulos, citações, listas e parágrafos.
function blocks(text, leaf) {
  const out = [];
  const lines = text.split('\n');
  let para = [];
  const flushPara = () => {
    if (!para.length) return;
    // Linhas em branco no começo/fim de um parágrafo entre blocos não contam.
    while (para.length && para[0] === '' && out.length) para.shift();
    if (para.length) out.push(h('span', { class: 'md-p' }, inline(para.join('\n'), leaf)));
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (/^>>> ?/.test(line)) {
      flushPara();
      const rest = [line.replace(/^>>> ?/, ''), ...lines.slice(i + 1)].join('\n');
      out.push(h('blockquote', { class: 'md-quote' }, blocks(rest, leaf)));
      return out;
    }
    if (/^> ?/.test(line) && line !== '>') {
      flushPara();
      const quoted = [];
      while (i < lines.length && /^> ?/.test(lines[i])) quoted.push(lines[i++].replace(/^> ?/, ''));
      i--;
      out.push(h('blockquote', { class: 'md-quote' }, inline(quoted.join('\n'), leaf)));
      continue;
    }
    if ((m = /^(#{1,3}) (.+)$/.exec(line))) {
      flushPara();
      out.push(h(`h${m[1].length + 2}`, { class: 'md-h' }, inline(m[2], leaf)));
      continue;
    }
    if (/^\s{0,4}([-*]|\d{1,3}\.) \S/.test(line)) {
      flushPara();
      const ordered = /^\s*\d/.test(line);
      const items = [];
      let start = 1;
      while (i < lines.length && (m = /^(\s{0,4})([-*]|(\d{1,3})\.) (.*)$/.exec(lines[i])) && !!m[3] === ordered) {
        if (!items.length && m[3]) start = Number(m[3]);
        items.push(h('li', { class: m[1].length >= 2 ? 'nested' : null }, inline(m[4], leaf)));
        i++;
      }
      i--;
      out.push(h(ordered ? 'ol' : 'ul', { class: 'md-list', start: ordered && start !== 1 ? String(start) : null }, items));
      continue;
    }
    para.push(line);
  }
  flushPara();
  return out;
}

const FENCE_RE = /```(?:([\w+#.-]{1,20})\n)?\n?([\s\S]*?)```/g;

export function renderMarkdown(text, leaf) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(FENCE_RE)) {
    const before = text.slice(last, m.index).replace(/\n$/, '');
    if (before) out.push(...blocks(before, leaf));
    out.push(h('pre', { class: 'md-pre' }, m[1] ? h('span', { class: 'md-lang' }, m[1]) : null,
      h('code', {}, m[2].replace(/\n$/, ''))));
    last = m.index + m[0].length;
    if (text[last] === '\n') last++;
  }
  const tail = text.slice(last);
  if (tail) out.push(...blocks(tail, leaf));
  // Mensagem comum (só um parágrafo): não precisa do invólucro.
  if (out.length === 1 && out[0].classList && out[0].classList.contains('md-p')) return [...out[0].childNodes];
  return out;
}

// Mensagem só com emojis (até 27) aparece com emojis grandes.
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\p{Regional_Indicator}|‍|️|\s)+$/u;
const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('pt', { granularity: 'grapheme' }) : null;
export function isJumboEmoji(text) {
  const t = String(text || '').trim();
  if (!t || !EMOJI_ONLY.test(t) || /^[\d#*\s]+$/.test(t)) return false;
  const count = seg ? [...seg.segment(t.replace(/\s/g, ''))].length : t.length;
  return count <= 27;
}
