// Resumo do que você perdeu, cargo temporário (vence sozinho) e "baixar os meus dados".
const fs = require('fs');
const path = require('path');
const db = require('../db');
const events = require('../events');
const M = require('../messages');
const { audit } = require('../audit');
const { ZipWriter } = require('../zip');
const { P, channelAccess, memberContext } = require('../permissions');
const { humansOnly } = require('../auth');
const { wrap, fail, parseId } = require('./util');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');
const AVATAR_DIR = path.join(UPLOAD_DIR, 'avatars');
const CATCHUP_MIN = Number(process.env.CATCHUP_MIN) || 15;
const EXPORT_MAX_BYTES = 500 * 1024 * 1024;
const EXPORT_MAX_FILES = 3000;
const exportsRunning = new Map(); // userId -> quando começou

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = function extras3Routes(r) {
  // ================================================================ Resumo do que você perdeu
  // GET /channels/:id/catchup → { count, since, authors, mentions, top, firstUnreadId }
  r.get('/channels/:id/catchup', wrap(async (req, res) => {
    const channelId = parseId(req.params.id);
    const access = channelId && await channelAccess(channelId, req.userId);
    if (!access || !['text', 'thread', 'dm'].includes(access.kind)) fail(404, 'Canal não encontrado.');
    const { rows: rd } = await db.query('SELECT last_read_id FROM channel_reads WHERE user_id = $1 AND channel_id = $2', [req.userId, channelId]);
    const lastRead = rd[0] ? String(rd[0].last_read_id) : '0';
    const { rows: c } = await db.query(
      `SELECT count(*)::int AS n, min(id)::text AS first_id, min(created_at) AS since FROM (
         SELECT id, created_at FROM messages WHERE channel_id = $1 AND id > $2 AND kind = 'default'
           AND author_id IS DISTINCT FROM $3 LIMIT 1000) x`,
      [channelId, lastRead, req.userId],
    );
    const count = c[0].n;
    if (count < CATCHUP_MIN) return res.json({ count, min: CATCHUP_MIN });
    const [authors, mentions, top] = await Promise.all([
      db.query(
        `SELECT u.id, u.display_name, count(*)::int AS n FROM messages m JOIN users u ON u.id = m.author_id
         WHERE m.channel_id = $1 AND m.id > $2 AND m.kind = 'default' AND m.author_id <> $3
         GROUP BY u.id ORDER BY n DESC LIMIT 6`,
        [channelId, lastRead, req.userId],
      ),
      db.query(
        `${M.SELECT_MESSAGE} WHERE msg.channel_id = $1 AND msg.id > $2 AND msg.kind = 'default' AND msg.author_id IS DISTINCT FROM $3
           AND (msg.mention_everyone OR EXISTS (SELECT 1 FROM message_mentions mm WHERE mm.message_id = msg.id AND mm.user_id = $3)
                OR EXISTS (SELECT 1 FROM messages o WHERE o.id = msg.reply_to_id AND o.author_id = $3))
         ORDER BY msg.id DESC LIMIT 5`,
        [channelId, lastRead, req.userId],
      ),
      db.query(
        `${M.SELECT_MESSAGE} WHERE msg.channel_id = $1 AND msg.id > $2 AND msg.kind = 'default'
           AND (SELECT count(*) FROM reactions r WHERE r.message_id = msg.id) >= 2
         ORDER BY (SELECT count(*) FROM reactions r WHERE r.message_id = msg.id) DESC, msg.id DESC LIMIT 3`,
        [channelId, lastRead],
      ),
    ]);
    const short = (m) => ({
      id: m.id, author: m.author, createdAt: m.createdAt, preview: M.previewText(m).slice(0, 140),
      reactions: m.reactions.reduce((a, x) => a + x.count, 0),
    });
    res.json({
      count,
      min: CATCHUP_MIN,
      since: c[0].since,
      firstUnreadId: c[0].first_id,
      authors: authors.rows.map((a) => ({ id: a.id, displayName: a.display_name, count: a.n })),
      mentions: (await M.hydrate(mentions.rows)).map(short),
      top: (await M.hydrate(top.rows)).map(short),
    });
  }));

  // ================================================================ Cargo temporário
  // POST /servers/:id/members/:userId/temp-role { roleId, hours }
  r.post('/servers/:id/members/:userId/temp-role', wrap(async (req, res) => {
    const serverId = parseId(req.params.id);
    const ctx = serverId && await memberContext(serverId, req.userId);
    if (!ctx) fail(404, 'Servidor não encontrado.');
    if (!ctx.can(P.MANAGE_ROLES)) fail(403, 'Você não tem permissão para gerenciar cargos.');
    const targetId = parseId(req.params.userId);
    const target = targetId && await memberContext(serverId, targetId);
    if (!target) fail(404, 'Membro não encontrado.');
    if (targetId !== req.userId && !ctx.isOwner && target.top >= ctx.top) fail(403, 'Esse membro tem um cargo igual ou acima do seu.');
    const roleId = parseId(req.body.roleId);
    const { rows: rr } = roleId ? await db.query('SELECT * FROM roles WHERE id = $1 AND server_id = $2', [roleId, serverId]) : { rows: [] };
    const role = rr[0];
    if (!role || role.is_default) fail(400, 'Cargo inválido.');
    if (!ctx.isOwner && role.position >= ctx.top) fail(403, 'Esse cargo está acima (ou no mesmo nível) do seu cargo mais alto.');
    const hours = Number(req.body.hours);
    if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 365) fail(400, 'Duração inválida (de 1 hora a 1 ano).');
    const { rows } = await db.query(
      `INSERT INTO member_roles (server_id, user_id, role_id, expires_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4::float8 * 3600))
       ON CONFLICT (server_id, user_id, role_id) DO UPDATE SET expires_at = EXCLUDED.expires_at RETURNING expires_at`,
      [serverId, targetId, roleId, hours],
    );
    const { rows: u } = await db.query('SELECT display_name FROM users WHERE id = $1', [targetId]);
    audit(serverId, req.userId, 'member_temp_role', { targetId, targetName: u[0] && u[0].display_name, details: { role: role.name, hours } });
    events.serverChanged(serverId);
    res.json({ expiresAt: rows[0].expires_at });
  }));

  // ================================================================ Baixar os meus dados (.zip)
  r.get('/me/export', humansOnly, wrap(async (req, res) => {
    const last = exportsRunning.get(req.userId);
    if (last && Date.now() - last < 5 * 60 * 1000) fail(429, 'Você já pediu um arquivo agora há pouco. Espere uns minutos.');
    exportsRunning.set(req.userId, Date.now());
    const uid = req.userId;
    const [me, msgs, saved, reminders, scheduled, friends, servers] = await Promise.all([
      db.query('SELECT * FROM users WHERE id = $1', [uid]),
      db.query(
        `SELECT m.id::text, m.channel_id, m.content, m.created_at, m.edited_at, m.reply_to_id::text AS reply_to,
                c.kind, c.name AS channel_name, s.name AS server_name,
                COALESCE((SELECT json_agg(json_build_object('id', a.id, 'nome', a.filename, 'tamanho', a.size, 'removido', a.purged_at IS NOT NULL))
                          FROM attachments a WHERE a.message_id = m.id), '[]') AS anexos
         FROM messages m JOIN channels c ON c.id = m.channel_id LEFT JOIN servers s ON s.id = c.server_id
         WHERE m.author_id = $1 ORDER BY m.id`,
        [uid],
      ),
      db.query(`SELECT n.created_at AS salva_em, m.id::text, m.content, m.created_at, u.display_name AS autor
                FROM nexo_saved n JOIN messages m ON m.id = n.message_id LEFT JOIN users u ON u.id = m.author_id
                WHERE n.user_id = $1 ORDER BY n.created_at DESC`, [uid]),
      db.query('SELECT message_id::text, remind_at FROM nexo_reminders WHERE user_id = $1 ORDER BY remind_at', [uid]),
      db.query('SELECT channel_id, content, send_at FROM nexo_scheduled WHERE user_id = $1 ORDER BY send_at', [uid]),
      db.query(`SELECT u.username, u.display_name, f.status, f.created_at FROM friendships f
                JOIN users u ON u.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
                WHERE f.requester_id = $1 OR f.addressee_id = $1`, [uid]),
      db.query(`SELECT s.name, sm.joined_at AS entrou_em, s.owner_id = $1 AS dono FROM server_members sm JOIN servers s ON s.id = sm.server_id
                WHERE sm.user_id = $1 ORDER BY s.name`, [uid]),
    ]);
    const u = me.rows[0];
    // Nome das conversas diretas (com quem).
    const dmIds = [...new Set(msgs.rows.filter((m) => m.kind === 'dm').map((m) => m.channel_id))];
    const dmNames = new Map();
    if (dmIds.length) {
      const { rows } = await db.query(
        `SELECT d.channel_id, string_agg(u.display_name, ', ' ORDER BY u.display_name) AS names, c.name
         FROM dm_members d JOIN users u ON u.id = d.user_id JOIN channels c ON c.id = d.channel_id
         WHERE d.channel_id = ANY($1::int[]) AND d.user_id <> $2 GROUP BY d.channel_id, c.name`,
        [dmIds, uid],
      );
      rows.forEach((r2) => dmNames.set(r2.channel_id, r2.name || r2.names));
    }
    const place = (m) => (m.kind === 'dm' ? `Conversa com ${dmNames.get(m.channel_id) || 'alguém'}`
      : `${m.server_name || 'Servidor'} › ${m.kind === 'thread' ? '🧵 ' : '#'}${m.channel_name}`);

    const stamp = new Date().toISOString().slice(0, 10);
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="nexo-${u.username}-${stamp}.zip"`,
      'Cache-Control': 'no-store',
    });
    const zip = new ZipWriter(res);
    try {
      const notes = [];
      // Fotos e anexos que você enviou.
      const files = [];
      let bytes = 0;
      for (const [label, id] of [['foto-de-perfil', u.avatar_id], ['capa', u.banner_id]]) {
        if (id && /^[a-f0-9]{24}\.(png|jpg|gif|webp)$/.test(id)) {
          const data = await fs.promises.readFile(path.join(AVATAR_DIR, id)).catch(() => null);
          if (data) files.push([`fotos/${label}.${id.split('.')[1]}`, data]);
        }
      }
      const { rows: atts } = await db.query(
        `SELECT id, filename, size FROM attachments WHERE uploader_id = $1 AND message_id IS NOT NULL AND purged_at IS NULL ORDER BY created_at`,
        [uid],
      );
      let skipped = 0;
      for (const a of atts) {
        if (files.length >= EXPORT_MAX_FILES || bytes + a.size > EXPORT_MAX_BYTES) { skipped++; continue; }
        if (!/^[a-f0-9]{32}$/.test(a.id)) continue;
        const data = await fs.promises.readFile(path.join(UPLOAD_DIR, a.id)).catch(() => null);
        if (!data) continue;
        bytes += data.length;
        files.push([`anexos/${a.id.slice(0, 8)}-${a.filename.replace(/[\\/]/g, '_')}`, data]);
      }
      if (skipped) notes.push(`${skipped} anexo(s) ficaram de fora porque o arquivo passaria de 500 MB. Peça de novo mais tarde ou baixe direto nas conversas.`);

      const profile = {
        usuario: u.username, nome: u.display_name, sobreMim: u.about, status: u.status_text, criadoEm: u.created_at,
        corDoPerfil: u.profile_color, atividade: u.activity, lastfm: u.lastfm_user,
        naoPerturbeAgendado: u.dnd_schedule, verificacaoEmDuasEtapas: !!u.totp_enabled,
      };
      const messages = msgs.rows.map((m) => ({
        id: m.id, onde: place(m), texto: m.content, enviadaEm: m.created_at, editadaEm: m.edited_at, respondendoA: m.reply_to, anexos: m.anexos,
      }));
      await zip.add('LEIA-ME.txt', [
        `Seus dados no Nexo (@${u.username}) — gerado em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`,
        '',
        'mensagens.html   suas mensagens, fácil de ler no navegador',
        'mensagens.json   as mesmas mensagens, para programas',
        'perfil.json      seu perfil',
        'salvas.json      mensagens que você salvou (🔖)',
        'lembretes.json, agendadas.json, amigos.json, servidores.json',
        'fotos/           sua foto de perfil e capa',
        'anexos/          arquivos que você enviou',
        '',
        `Total: ${messages.length} mensagem(ns), ${files.length} arquivo(s).`,
        ...notes,
      ].join('\r\n'));
      await zip.add('perfil.json', JSON.stringify(profile, null, 2));
      await zip.add('mensagens.json', JSON.stringify(messages, null, 2));
      let html = `<!doctype html><meta charset="utf-8"><title>Minhas mensagens no Nexo</title>
<style>body{font-family:system-ui,sans-serif;max-width:860px;margin:24px auto;padding:0 16px;color:#222}h2{margin-top:28px;border-bottom:1px solid #ddd}
.m{margin:6px 0}.t{color:#888;font-size:12px;margin-right:8px}.a{color:#666;font-size:13px}</style>
<h1>Minhas mensagens no Nexo</h1><p>@${esc(u.username)} · ${messages.length} mensagem(ns)</p>`;
      let current = null;
      for (const m of messages) {
        if (m.onde !== current) { current = m.onde; html += `<h2>${esc(current)}</h2>`; }
        html += `<div class="m"><span class="t">${esc(new Date(m.enviadaEm).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }))}</span>${esc(m.texto).replace(/\n/g, '<br>')}${
          m.anexos.length ? ` <span class="a">📎 ${m.anexos.map((a) => esc(a.nome)).join(', ')}</span>` : ''}</div>`;
      }
      await zip.add('mensagens.html', html);
      await zip.add('salvas.json', JSON.stringify(saved.rows, null, 2));
      await zip.add('lembretes.json', JSON.stringify(reminders.rows, null, 2));
      await zip.add('agendadas.json', JSON.stringify(scheduled.rows, null, 2));
      await zip.add('amigos.json', JSON.stringify(friends.rows, null, 2));
      await zip.add('servidores.json', JSON.stringify(servers.rows, null, 2));
      for (const [name, data] of files) await zip.add(name, data, { compress: false });
      await zip.finish();
    } catch (err) {
      console.error('Erro ao gerar o arquivo de dados:', err.message);
      res.destroy(err);
    }
  }));
};

// Cargos temporários vencidos: tira e avisa (roda junto com as outras tarefas de fundo).
async function expireTempRoles() {
  const { rows } = await db.query(
    `DELETE FROM member_roles mr USING roles r
     WHERE r.id = mr.role_id AND mr.expires_at IS NOT NULL AND mr.expires_at <= now()
     RETURNING mr.server_id, mr.user_id, r.name, (SELECT display_name FROM users WHERE id = mr.user_id) AS user_name`,
  );
  const servers = new Set();
  for (const x of rows) {
    servers.add(x.server_id);
    audit(x.server_id, null, 'role_expired', { targetId: x.user_id, targetName: x.user_name, details: { role: x.name } });
  }
  servers.forEach((id) => events.serverChanged(id));
  return rows.length;
}

module.exports.expireTempRoles = expireTempRoles;
