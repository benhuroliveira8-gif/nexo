// Estado global do app e regras de permissão (iguais às do servidor).
import { storage } from './util.js';

export const P = {
  ADMINISTRATOR: 1 << 0,
  MANAGE_SERVER: 1 << 1,
  MANAGE_ROLES: 1 << 2,
  MANAGE_CHANNELS: 1 << 3,
  KICK_MEMBERS: 1 << 4,
  CREATE_INVITE: 1 << 5,
  SEND_MESSAGES: 1 << 6,
  ATTACH_FILES: 1 << 7,
  ADD_REACTIONS: 1 << 8,
  MENTION_EVERYONE: 1 << 9,
  MANAGE_MESSAGES: 1 << 10,
  CONNECT: 1 << 11,
  SPEAK: 1 << 12,
  VIDEO: 1 << 13,
};

export const PERMISSION_INFO = [
  [P.ADMINISTRATOR, 'Administrador', 'Libera todas as permissões. Dê só para quem você confia muito.'],
  [P.MANAGE_SERVER, 'Gerenciar servidor', 'Renomear o servidor e gerar um novo convite.'],
  [P.MANAGE_ROLES, 'Gerenciar cargos', 'Criar e editar cargos abaixo do seu e dá-los a membros.'],
  [P.MANAGE_CHANNELS, 'Gerenciar canais', 'Criar, renomear e apagar canais.'],
  [P.KICK_MEMBERS, 'Expulsar membros', 'Remover membros com cargo abaixo do seu.'],
  [P.MANAGE_MESSAGES, 'Gerenciar mensagens', 'Apagar mensagens de outras pessoas.'],
  [P.MENTION_EVERYONE, 'Mencionar @everyone', 'Notificar todo mundo do servidor de uma vez.'],
  [P.CREATE_INVITE, 'Convidar pessoas', 'Ver e compartilhar o convite do servidor.'],
  [P.SEND_MESSAGES, 'Enviar mensagens', 'Escrever nos canais de texto.'],
  [P.ATTACH_FILES, 'Anexar arquivos', 'Enviar imagens, vídeos e arquivos.'],
  [P.ADD_REACTIONS, 'Adicionar reações', 'Reagir às mensagens com emojis.'],
  [P.CONNECT, 'Entrar em canais de voz', 'Ouvir e entrar nos canais de voz.'],
  [P.SPEAK, 'Falar', 'Usar o microfone nos canais de voz.'],
  [P.VIDEO, 'Vídeo e tela', 'Ligar a câmera e compartilhar a tela nos canais de voz.'],
];

const DM_PERMS = P.SEND_MESSAGES | P.ATTACH_FILES | P.ADD_REACTIONS;

export const state = {
  token: storage('nexo.token'),
  me: null,
  socket: null,
  servers: [],               // [{ id, name, ownerId, unread, mentions }]
  view: 'home',              // 'home' ou o id do servidor aberto
  detail: null,              // detalhes do servidor aberto (canais, membros, cargos, me)
  detailVersion: 0,          // muda sempre que "detail" é recarregado (para refazer a tela)
  channelId: null,           // canal ou DM aberto (null na tela de amigos)
  dms: [],                   // [{ channelId, user, lastMessageAt, unread, mentions }]
  friends: { friends: [], incoming: [], outgoing: [] },
  friendsTab: 'online',
  messages: new Map(),       // channelId -> { items, hasMore, loading, nodes }
  typing: new Map(),         // channelId -> Map(userId -> { name, timer })
  editingId: null,           // mensagem sendo editada
  soundOn: storage('nexo.sound') !== '0',
};

// Permissões do usuário no lugar aberto (servidor ou DM).
export function currentPerms() {
  if (state.view === 'home') return DM_PERMS;
  return state.detail ? state.detail.me.permissions : 0;
}

export const can = (flag) => {
  const perms = currentPerms();
  return (perms & P.ADMINISTRATOR) !== 0 || (perms & flag) === flag;
};

export const isOwner = () => !!(state.detail && state.detail.me.isOwner);

// Posição do cargo mais alto do usuário logado (dono = infinito).
export const myTop = () => (isOwner() ? Infinity : (state.detail ? state.detail.me.top : 0));

export function rolesById() {
  return new Map((state.detail ? state.detail.roles : []).map((r) => [r.id, r]));
}

export function memberById(id) {
  return state.detail ? state.detail.members.find((m) => m.id === id) : null;
}

// Cargos (sem o @everyone) de um membro, do mais alto para o mais baixo.
export function memberRoles(member) {
  if (!member || !state.detail) return [];
  const map = rolesById();
  return member.roleIds.map((id) => map.get(id)).filter(Boolean).sort((a, b) => b.position - a.position);
}

export function memberTop(member) {
  if (!state.detail || !member) return 0;
  if (member.id === state.detail.server.ownerId) return Infinity;
  return memberRoles(member).reduce((max, r) => Math.max(max, r.position), 0);
}

// Cor do nome: a do cargo colorido mais alto.
export function roleColor(userId) {
  const m = memberById(userId);
  const colored = memberRoles(m).find((r) => r.color);
  return colored ? colored.color : null;
}

// Todos os usuários que conhecemos (para mostrar menções com o nome certo).
export function knownUsers() {
  const map = new Map();
  const add = (u) => { if (u && !map.has(u.username)) map.set(u.username, u); };
  add(state.me);
  if (state.detail && state.view !== 'home') state.detail.members.forEach(add);
  state.dms.forEach((d) => add(d.user));
  state.friends.friends.forEach(add);
  return map;
}

export const currentDm = () => state.dms.find((d) => d.channelId === state.channelId) || null;

export function currentChannel() {
  if (state.view === 'home') return null;
  return state.detail ? state.detail.channels.find((c) => c.id === state.channelId) || null : null;
}
