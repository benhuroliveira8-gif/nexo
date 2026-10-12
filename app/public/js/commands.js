// Comandos de barra: /dado, /moeda, /sortear, /enquete, /nivel, /ranking, /shrug
// e os comandos criados pelos bots do servidor.
import { h, api } from './util.js';

const cache = new Map(); // channelId -> { at, list, promise }
const TTL = 60000;

export function commandsFor(channelId) {
  const c = cache.get(channelId);
  return c && c.list ? c.list : null;
}

export function loadCommands(channelId, { force = false } = {}) {
  const c = cache.get(channelId);
  if (!force && c && (c.promise || Date.now() - c.at < TTL)) return c.promise || Promise.resolve(c.list);
  const entry = { at: Date.now(), list: c ? c.list : null, promise: null };
  entry.promise = api(`/channels/${channelId}/commands`)
    .then(({ commands }) => { entry.list = commands; entry.at = Date.now(); return commands; })
    .catch(() => { entry.list = entry.list || []; return entry.list; })
    .finally(() => { entry.promise = null; });
  cache.set(channelId, entry);
  return entry.promise;
}
export const forgetCommands = () => cache.clear();

// "/da" → sugestões. Só no começo da mensagem e antes do primeiro espaço.
export function matchSlash(textBeforeCaret) {
  const m = /^\/([a-z0-9_-]{0,32})$/i.exec(textBeforeCaret);
  return m ? m[1].toLowerCase() : null;
}

export function suggestions(list, q) {
  return (list || [])
    .filter((c) => c.name.startsWith(q) || (q.length >= 2 && c.name.includes(q)))
    .sort((a, b) => (b.name.startsWith(q) - a.name.startsWith(q)) || (!!b.builtin - !!a.builtin) || a.name.localeCompare(b.name))
    .slice(0, 10);
}

// A mensagem é um comando conhecido? Devolve { name, args, command } ou null.
export function parseCommand(content, list) {
  const m = /^\/([a-z0-9_-]{1,32})(?:\s+([\s\S]*))?$/i.exec(content.trim());
  if (!m) return null;
  const name = m[1].toLowerCase();
  const command = (list || []).find((c) => c.name === name);
  if (!command) return null;
  return { name, args: (m[2] || '').trim(), command };
}

export function runCommand(channelId, { name, args, command }) {
  return api(`/channels/${channelId}/commands`, {
    method: 'POST',
    body: { name, args, ...(command && command.bot ? { botId: command.bot.id } : {}) },
  });
}

// Item da lista do autocompletar.
export function commandItem(c) {
  return [
    h('span', { class: 'ac-slash' }, c.bot ? '🤖' : '⚡'),
    h('strong', {}, `/${c.name}`),
    c.usage ? h('span', { class: 'ac-usage' }, c.usage) : null,
    h('span', { class: 'muted truncate' }, c.bot ? `${c.description || ''} — ${c.bot.displayName}` : c.description),
  ];
}

// Linha "usou /dado" em cima da mensagem que veio de um comando.
export function commandLine(m, botName) {
  if (!m.command) return null;
  return h('div', { class: 'cmd-line' }, '⚡ usou ', h('code', {}, `/${m.command.name}`), botName ? ` de ${botName}` : null);
}

// Resposta que só quem usou o comando vê (não fica salva).
export function ephemeralMessage(channelId, text) {
  return {
    id: `eph-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    ephemeral: true, kind: 'ephemeral', channelId, content: text, createdAt: new Date().toISOString(),
    author: { id: 0, username: 'nexo', displayName: 'Nexo', isBot: true }, mentions: [], reactions: [], attachments: [],
  };
}
