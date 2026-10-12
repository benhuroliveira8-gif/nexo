// Fóruns (cada post vira um tópico com respostas), níveis/XP e comandos de barra
// (/dado, /sortear, /enquete...) — inclusive os comandos criados pelos bots.
const crypto = require('crypto');
const db = require('../db');
const S = require('../serializers');
const events = require('../events');
const M = require('../messages');
const levels = require('../levels');
const { audit } = require('../audit');
const { P, channelAccess, memberContext } = require('../permissions');
const { wrap, fail, parseId } = require('./util');

const MAX_POSTS_LIST = 100;
const MAX_BOT_COMMANDS = 25;
const COMMAND_RE = /^[a-z0-9_-]{1,32}$/;

const cleanTitle = (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 100);
const rand = (n) => crypto.randomInt(n); // 0..n-1

// ---------------------------------------------------------------- Comandos prontos

const BUILTINS = [
  { name: 'dado', description: 'Rola dados. Ex.: /dado, /dado 20 ou /dado 2d6', usage: '[2d6]' },
  { name: 'moeda', description: 'Cara ou coroa?', usage: '' },
  { name: 'sortear', description: 'Sorteia uma das opções (separe por vírgula) ou alguém do canal', usage: '[pizza, hambúrguer, sushi]' },
  { name: 'enquete', description: 'Cria uma enquete. Ex.: /enquete Pizza ou lanche? | Pizza | Lanche', usage: 'pergunta | opção 1 | opção 2' },
  { name: 'nivel', description: 'Mostra o seu nível (ou o de @alguém) neste servidor', usage: '[@usuario]', serverOnly: true, levels: true },
  { name: 'ranking', description: 'Os 10 que mais participam neste servidor', usage: '', serverOnly: true, levels: true },
  { name: 'shrug', description: 'Manda ¯\\_(ツ)_/¯ no fim da mensagem', usage: '[mensagem]' },
];
const BUILTIN_NAMES = new Set(BUILTINS.map((b) => b.name));

function parseDice(args) {
  const a = String(args || '').trim().toLowerCase();
  if (!a) return { count: 1, sides: 6, bonus: 0 };
  let m = /^(\d{1,3})$/.exec(a);
  if (m) return { count: 1, sides: Number(m[1]), bonus: 0 };
  m = /^(\d{0,2})d(\d{1,4})\s*([+-]\s*\d{1,4})?$/.exec(a);
  if (!m) return null;
  return { count: m[1] ? Number(m[1]) : 1, sides: Number(m[2]), bonus: m[3] ? Number(m[3].replace(/\s+/g, '')) : 0 };
}

async function levelsEnabled(serverId) {
  if (!serverId) return false;
  const { rows } = await db.query('SELECT levels FROM servers WHERE id = $1', [serverId]);
  return !!(rows[0] && rows[0].levels && rows[0].levels.enabled);
}

// Bots que estão no lugar (membros do servidor ou da conversa) e os comandos deles.
async function botCommandsFor(access) {
  const { rows } = access.serverId
    ? await db.query(
      `SELECT c.bot_id, c.name, c.description, u.username, u.display_name, u.avatar_id FROM nexo_bot_commands c
       JOIN users u ON u.id = c.bot_id JOIN server_members m ON m.user_id = c.bot_id AND m.server_id = $1
       ORDER BY c.name, c.bot_id`,
      [access.serverId],
    )
    : await db.query(
      `SELECT c.bot_id, c.name, c.description, u.username, u.display_name, u.avatar_id FROM nexo_bot_commands c
       JOIN users u ON u.id = c.bot_id WHERE c.bot_id = ANY($1::int[]) ORDER BY c.name, c.bot_id`,
      [access.memberIds || []],
    );
  const visible = access.viewerIds ? new Set(access.viewerIds) : null;
  return rows.filter((r) => !visible || visible.has(r.bot_id)).map((r) => ({
    name: r.name,
    description: r.description,
    bot: { id: r.bot_id, username: r.username, displayName: r.display_name, avatarUrl: S.avatarUrl(r.avatar_id) },
  }));
}

module.exports = function communityRoutes(r) {
  // ================================================================ Fóruns

  async function forumAccess(req) {
    const channelId = parseId(req.params.id);
    const access = channelId && await channelAccess(channelId, req.userId);
    if (!access || access.kind !== 'forum') fail(404, 'Fórum não encontrado.');
    return access;
  }

  // GET /channels/:id/posts?sort=active|new&q=texto
  r.get('/channels/:id/posts', wrap(async (req, res) => {
    const access = await forumAccess(req);
    const q = String(req.query.q || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    const order = req.query.sort === 'new' ? 't.created_at DESC' : 'COALESCE(last.at, t.created_at) DESC';
    const { rows } = await db.query(
      `SELECT t.id, t.name, t.solved, t.pinned, t.created_at, t.created_by,
              u.username, u.display_name, u.avatar_id, u.is_bot,
              (SELECT count(*)::int FROM messages WHERE channel_id = t.id AND kind = 'default') AS message_count,
              last.at AS last_at, first.content AS first_content, first.id AS first_id,
              (SELECT a.id || '/' || a.filename FROM attachments a WHERE a.message_id = first.id AND a.content_type LIKE 'image/%'
                 ORDER BY a.created_at, a.id LIMIT 1) AS image,
              EXISTS (SELECT 1 FROM messages m WHERE m.channel_id = t.id AND m.id > COALESCE(cr.last_read_id, 0)
                        AND m.author_id IS DISTINCT FROM $2) AS unread
       FROM channels t
       LEFT JOIN users u ON u.id = t.created_by
       LEFT JOIN channel_reads cr ON cr.channel_id = t.id AND cr.user_id = $2
       LEFT JOIN LATERAL (SELECT max(created_at) AS at FROM messages WHERE channel_id = t.id) last ON true
       LEFT JOIN LATERAL (SELECT id, content FROM messages WHERE channel_id = t.id ORDER BY id LIMIT 1) first ON true
       WHERE t.kind = 'thread' AND t.parent_channel_id = $1
         AND ($3 = '' OR t.name ILIKE '%' || $3 || '%' OR first.content ILIKE '%' || $3 || '%')
       ORDER BY t.pinned DESC, ${order}, t.id DESC
       LIMIT ${MAX_POSTS_LIST}`,
      [access.channel.id, req.userId, q.replace(/[\\%_]/g, (c) => `\\${c}`)],
    );
    res.json({
      posts: rows.map((p) => ({
        id: p.id,
        title: p.name,
        solved: p.solved,
        pinned: p.pinned,
        createdAt: p.created_at,
        lastAt: p.last_at || p.created_at,
        replies: Math.max(0, p.message_count - 1),
        unread: p.unread,
        preview: M.previewText({ content: p.first_content || '', attachments: [] }).slice(0, 160),
        image: p.image ? `/files/${p.image.split('/')[0]}/${encodeURIComponent(p.image.split('/').slice(1).join('/'))}` : null,
        author: p.created_by ? { id: p.created_by, username: p.username, displayName: p.display_name, isBot: !!p.is_bot, avatarUrl: S.avatarUrl(p.avatar_id) } : null,
      })),
    });
  }));

  // POST /channels/:id/posts { title, content, attachmentIds }
  r.post('/channels/:id/posts', wrap(async (req, res) => {
    const access = await forumAccess(req);
    if (!access.can(P.SEND_MESSAGES)) fail(403, access.timeoutUntil ? 'Você está de castigo e não pode postar agora.' : 'Você não pode postar neste fórum.');
    const title = cleanTitle(req.body.title);
    if (!title) fail(400, 'Dê um título ao post.');
    if (!String(req.body.content || '').trim() && !(Array.isArray(req.body.attachmentIds) && req.body.attachmentIds.length)) {
      fail(400, 'Escreva a primeira mensagem do post.');
    }
    const { rows } = await db.query(
      `INSERT INTO channels (server_id, name, kind, position, parent_channel_id, created_by)
       VALUES ($1, $2, 'thread', 0, $3, $4) RETURNING *`,
      [access.serverId, title, access.channel.id, req.userId],
    );
    const thread = rows[0];
    let message;
    try {
      const threadAccess = await channelAccess(thread.id, req.userId);
      message = await M.createMessage({ access: threadAccess, userId: req.userId, content: req.body.content, attachmentIds: req.body.attachmentIds });
      M.announceNew(threadAccess, message);
    } catch (err) {
      await db.query('DELETE FROM channels WHERE id = $1', [thread.id]);
      if (err instanceof M.MessageError) fail(400, err.message);
      throw err;
    }
    events.serverChanged(access.serverId);
    events.emitTo(access.rooms, 'forum:changed', { channelId: access.channel.id });
    res.status(201).json({ channel: S.channel(thread), message });
  }));

  // PATCH /posts/:id { solved?, pinned? } — quem postou marca como resolvido; moderadores fixam.
  r.patch('/posts/:id', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const access = id && await channelAccess(id, req.userId);
    if (!access || access.kind !== 'thread') fail(404, 'Post não encontrado.');
    const { rows: parent } = await db.query('SELECT kind FROM channels WHERE id = $1', [access.channel.parent_channel_id]);
    if (!parent[0] || parent[0].kind !== 'forum') fail(404, 'Post não encontrado.');
    const mod = access.can(P.MANAGE_MESSAGES) || access.can(P.MANAGE_CHANNELS);
    const sets = [];
    const vals = [id];
    if (req.body.solved !== undefined) {
      if (!mod && access.channel.created_by !== req.userId) fail(403, 'Só quem postou (ou a moderação) pode marcar como resolvido.');
      vals.push(!!req.body.solved); sets.push(`solved = $${vals.length}`);
    }
    if (req.body.pinned !== undefined) {
      if (!mod) fail(403, 'Só a moderação pode fixar posts.');
      vals.push(!!req.body.pinned); sets.push(`pinned = $${vals.length}`);
    }
    if (!sets.length) fail(400, 'Nada para mudar.');
    const { rows } = await db.query(`UPDATE channels SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
    events.serverChanged(access.serverId);
    events.emitTo(access.rooms, 'forum:changed', { channelId: access.channel.parent_channel_id });
    res.json({ channel: S.channel(rows[0]) });
  }));

  // ================================================================ Níveis

  r.get('/servers/:id/levels', wrap(async (req, res) => {
    const serverId = parseId(req.params.id);
    const ctx = serverId && await memberContext(serverId, req.userId);
    if (!ctx) fail(404, 'Servidor não encontrado.');
    const { rows } = await db.query('SELECT levels FROM servers WHERE id = $1', [serverId]);
    const cfg = rows[0].levels ? { ...levels.DEFAULT_LEVELS, ...rows[0].levels } : { ...levels.DEFAULT_LEVELS };
    const enabled = !!cfg.enabled;
    res.json({
      enabled,
      settings: ctx.can(P.MANAGE_SERVER) ? cfg : null,
      rewards: cfg.rewards,
      me: enabled ? await levels.progressOf(serverId, req.userId) : null,
      ranking: enabled ? await levels.ranking(serverId, Math.min(50, Number(req.query.limit) || 10)) : [],
    });
  }));

  r.put('/servers/:id/levels', wrap(async (req, res) => {
    const serverId = parseId(req.params.id);
    const ctx = serverId && await memberContext(serverId, req.userId);
    if (!ctx) fail(404, 'Servidor não encontrado.');
    if (!ctx.can(P.MANAGE_SERVER)) fail(403, 'Você não tem permissão para isso.');
    const cfg = levels.cleanLevels(req.body || {});
    if (cfg.announce === 'channel') {
      const { rows } = cfg.channelId
        ? await db.query("SELECT 1 FROM channels WHERE id = $1 AND server_id = $2 AND kind = 'text'", [cfg.channelId, serverId])
        : { rows: [] };
      if (!rows[0]) fail(400, 'Escolha um canal de texto para os avisos de nível.');
    }
    if (cfg.rewards.length) {
      const { rows } = await db.query('SELECT id, position, is_default FROM roles WHERE server_id = $1 AND id = ANY($2::int[])', [serverId, cfg.rewards.map((x) => x.roleId)]);
      const byId = new Map(rows.map((x) => [x.id, x]));
      for (const rw of cfg.rewards) {
        const role = byId.get(rw.roleId);
        if (!role || role.is_default) fail(400, 'Algum cargo da recompensa não existe mais.');
        if (!ctx.isOwner && role.position >= ctx.top) fail(403, 'Você só pode dar cargos abaixo do seu.');
      }
    }
    await db.query('UPDATE servers SET levels = $2 WHERE id = $1', [serverId, JSON.stringify(cfg)]);
    levels.forget(serverId);
    await levels.syncRewards(serverId, cfg);
    audit(serverId, req.userId, 'levels_update', { details: { enabled: cfg.enabled, rewards: cfg.rewards.length } });
    events.serverChanged(serverId);
    res.json({ levels: cfg });
  }));

  // Zerar o XP de todo mundo (quem gerencia o servidor).
  r.delete('/servers/:id/levels/xp', wrap(async (req, res) => {
    const serverId = parseId(req.params.id);
    const ctx = serverId && await memberContext(serverId, req.userId);
    if (!ctx) fail(404, 'Servidor não encontrado.');
    if (!ctx.can(P.MANAGE_SERVER)) fail(403, 'Você não tem permissão para isso.');
    await db.query('DELETE FROM nexo_xp WHERE server_id = $1', [serverId]);
    audit(serverId, req.userId, 'levels_reset');
    res.json({ ok: true });
  }));

  // ================================================================ Comandos de barra

  // Bots: registrar os próprios comandos. PUT /commands { commands: [{ name, description }] }
  r.get('/commands', wrap(async (req, res) => {
    if (!req.isBot) fail(403, 'Só bots têm comandos próprios.');
    const { rows } = await db.query('SELECT name, description FROM nexo_bot_commands WHERE bot_id = $1 ORDER BY name', [req.userId]);
    res.json({ commands: rows });
  }));

  r.put('/commands', wrap(async (req, res) => {
    if (!req.isBot) fail(403, 'Só bots podem registrar comandos.');
    const list = Array.isArray(req.body.commands) ? req.body.commands : null;
    if (!list) fail(400, 'Mande { commands: [{ name, description }] }.');
    if (list.length > MAX_BOT_COMMANDS) fail(400, `No máximo ${MAX_BOT_COMMANDS} comandos.`);
    const clean = [];
    const seen = new Set();
    for (const c of list) {
      const name = String((c && c.name) || '').trim().toLowerCase().replace(/^\//, '');
      if (!COMMAND_RE.test(name)) fail(400, `Nome de comando inválido: "${name}". Use letras minúsculas, números, _ ou - (até 32).`);
      if (BUILTIN_NAMES.has(name)) fail(400, `"/${name}" já é um comando do Nexo. Escolha outro nome.`);
      if (seen.has(name)) continue;
      seen.add(name);
      clean.push({ name, description: String((c && c.description) || '').replace(/\s+/g, ' ').trim().slice(0, 100) });
    }
    await db.transaction(async (c) => {
      await c.query('DELETE FROM nexo_bot_commands WHERE bot_id = $1', [req.userId]);
      for (const x of clean) await c.query('INSERT INTO nexo_bot_commands (bot_id, name, description) VALUES ($1, $2, $3)', [req.userId, x.name, x.description]);
    });
    res.json({ commands: clean });
  }));

  async function textAccess(req) {
    const channelId = parseId(req.params.id);
    const access = channelId && await channelAccess(channelId, req.userId);
    if (!access || !['text', 'thread', 'dm'].includes(access.kind)) fail(404, 'Canal não encontrado.');
    return access;
  }

  // Lista para o autocompletar quando a pessoa digita "/".
  r.get('/channels/:id/commands', wrap(async (req, res) => {
    const access = await textAccess(req);
    const lv = await levelsEnabled(access.serverId);
    const builtins = BUILTINS.filter((b) => !b.serverOnly || access.serverId)
      .map(({ name, description, usage, levels: lvCmd }) => ({
        name, usage, builtin: true, description: lvCmd && !lv ? `${description} (níveis desligados aqui)` : description,
      }));
    res.json({ commands: [...builtins, ...await botCommandsFor(access)] });
  }));

  // Executa um comando. POST /channels/:id/commands { name, args, botId? }
  // Devolve { message } (mensagem no canal) ou { ephemeral: { text } } (só quem usou vê).
  r.post('/channels/:id/commands', wrap(async (req, res) => {
    const access = await textAccess(req);
    if (req.isBot) fail(403, 'Bots não usam comandos de barra.');
    const name = String(req.body.name || '').trim().toLowerCase().replace(/^\//, '');
    const args = String(req.body.args || '').replace(/\r\n/g, '\n').trim().slice(0, 1000);
    if (!COMMAND_RE.test(name)) fail(400, 'Comando inválido.');
    if (!access.can(P.SEND_MESSAGES) && !['nivel', 'ranking'].includes(name)) {
      fail(403, access.timeoutUntil ? 'Você está de castigo e não pode usar comandos agora.' : 'Você não pode enviar mensagens aqui.');
    }
    const command = { name, args: args.slice(0, 200) };
    const send = async (opts) => {
      try {
        const message = await M.createMessage({ access, userId: req.userId, command, ...opts });
        M.announceNew(access, message);
        return res.status(201).json({ message });
      } catch (err) {
        if (err instanceof M.MessageError) fail(400, err.message);
        throw err;
      }
    };

    if (BUILTIN_NAMES.has(name)) {
      const builtin = BUILTINS.find((b) => b.name === name);
      if (builtin.serverOnly && !access.serverId) fail(400, `/${name} só funciona em servidores.`);
      if (name === 'dado') {
        const d = parseDice(args);
        if (!d || d.count < 1 || d.count > 20 || d.sides < 2 || d.sides > 1000 || Math.abs(d.bonus) > 1000) {
          fail(400, 'Use /dado, /dado 20 ou /dado 2d6 (até 20 dados de 2 a 1000 lados).');
        }
        const rolls = Array.from({ length: d.count }, () => 1 + rand(d.sides));
        const total = rolls.reduce((a, b) => a + b, 0) + d.bonus;
        const label = `${d.count > 1 ? d.count : ''}d${d.sides}${d.bonus ? (d.bonus > 0 ? `+${d.bonus}` : d.bonus) : ''}`;
        const detail = rolls.length > 1 || d.bonus ? ` (${rolls.join(' + ')}${d.bonus ? ` ${d.bonus > 0 ? '+' : '−'} ${Math.abs(d.bonus)}` : ''})` : '';
        return send({ content: `🎲 Rolou **${label}**: **${total}**${detail}`, skipAutomod: true });
      }
      if (name === 'moeda') {
        return send({ content: `🪙 Jogou uma moeda e deu **${rand(2) ? 'Cara' : 'Coroa'}**!`, skipAutomod: true });
      }
      if (name === 'sortear') {
        const options = args.split(/[,;\n]/).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 50);
        if (options.length === 1) fail(400, 'Dê pelo menos 2 opções separadas por vírgula (ou deixe vazio para sortear alguém).');
        if (options.length >= 2) {
          const pick = options[rand(options.length)];
          return send({ content: `🎰 Sorteio entre ${options.length} opções: ${options.map((o) => `\`${o.replace(/`/g, "'").slice(0, 60)}\``).join(', ')}\n🏆 Resultado: **${pick.replace(/\*/g, '')}**` });
        }
        // Sem opções: sorteia uma pessoa que vê o canal (menos bots e quem pediu).
        const { rows } = access.serverId
          ? await db.query('SELECT u.id, u.username FROM server_members m JOIN users u ON u.id = m.user_id WHERE m.server_id = $1 AND NOT u.is_bot', [access.serverId])
          : await db.query('SELECT u.id, u.username FROM users u WHERE u.id = ANY($1::int[]) AND NOT u.is_bot', [access.memberIds]);
        const visible = access.viewerIds ? new Set(access.viewerIds) : null;
        const people = rows.filter((u) => u.id !== req.userId && (!visible || visible.has(u.id)));
        if (!people.length) fail(400, 'Não tem ninguém para sortear aqui.');
        const pick = people[rand(people.length)];
        return send({ content: `🎰 Sorteio entre ${people.length} ${people.length === 1 ? 'pessoa' : 'pessoas'}… e quem ganhou foi @${pick.username}! 🎉`, skipAutomod: true });
      }
      if (name === 'enquete') {
        const parts = args.split('|').map((x) => x.trim()).filter(Boolean);
        if (parts.length < 3) fail(400, 'Use: /enquete Pergunta? | Opção 1 | Opção 2');
        return send({ content: '', poll: { question: parts[0], options: parts.slice(1), hours: 24 } });
      }
      if (name === 'shrug') {
        command.args = '';
        return send({ content: `${args} ¯\\\\\\_(ツ)\\_/¯`.trim() }); // escapado para o markdown
      }
      if (name === 'nivel' || name === 'ranking') {
        if (!await levelsEnabled(access.serverId)) return res.json({ ephemeral: { text: 'Os níveis estão desligados neste servidor. Quem gerencia o servidor pode ligar em Configurações do servidor → Níveis.' } });
        if (name === 'ranking') {
          const list = await levels.ranking(access.serverId, 10);
          if (!list.length) return res.json({ ephemeral: { text: 'Ninguém ganhou XP ainda. Bora conversar! 💬' } });
          const medal = ['🥇', '🥈', '🥉'];
          return res.json({
            ephemeral: {
              text: `🏆 **Ranking do servidor**\n${list.map((x) => `${medal[x.rank - 1] || `${x.rank}.`} **${x.user.displayName}** — nível ${x.level} (${x.xp} XP)`).join('\n')}`,
            },
          });
        }
        let targetId = req.userId;
        let who = 'Você está';
        const m = /^@?([a-z0-9_.]{3,32})$/i.exec(args);
        if (args && m) {
          const { rows } = await db.query(
            'SELECT u.id, u.display_name FROM users u JOIN server_members sm ON sm.user_id = u.id AND sm.server_id = $2 WHERE u.username = $1',
            [m[1].toLowerCase(), access.serverId],
          );
          if (!rows[0]) fail(404, 'Não achei essa pessoa no servidor.');
          targetId = rows[0].id;
          who = targetId === req.userId ? 'Você está' : `${rows[0].display_name} está`;
        }
        const p = await levels.progressOf(access.serverId, targetId);
        const bar = '▰'.repeat(Math.round((p.current / p.needed) * 10)).padEnd(10, '▱');
        return res.json({
          ephemeral: { text: `⭐ ${who} no **nível ${p.level}**${p.rank ? ` (#${p.rank} no ranking)` : ''}\n${bar} ${p.current}/${p.needed} XP para o próximo nível` },
        });
      }
    }

    // Comando de bot: a mensagem vai no canal e o bot recebe o evento "command" para responder.
    const cmds = (await botCommandsFor(access)).filter((c) => c.name === name);
    const botId = req.body.botId ? parseId(req.body.botId) : null;
    const cmd = botId ? cmds.find((c) => c.bot.id === botId) : cmds[0];
    if (!cmd) fail(404, `Não existe o comando /${name} aqui.`);
    command.botId = cmd.bot.id;
    try {
      const message = await M.createMessage({ access, userId: req.userId, content: `/${name}${args ? ` ${args}` : ''}`, command });
      M.announceNew(access, message);
      events.emitTo([`user:${cmd.bot.id}`], 'command', {
        name, args, messageId: message.id, channelId: access.channel.id, serverId: access.serverId, user: message.author,
      });
      return res.status(201).json({ message });
    } catch (err) {
      if (err instanceof M.MessageError) fail(400, err.message);
      throw err;
    }
  }));
};

module.exports.BUILTINS = BUILTINS;
