// Entrar num canal de voz: o Nexo confere a permissão e devolve um token do LiveKit.
const db = require('../db');
const S = require('../serializers');
const voice = require('../voice');
const { humansOnly } = require('../auth');
const { P, channelAccess } = require('../permissions');
const { wrap, fail, parseId } = require('./util');

module.exports = function voiceRoutes(r) {
  r.post('/voice/:channelId/token', humansOnly, wrap(async (req, res) => {
    if (!voice.configured()) {
      fail(503, 'A voz ainda não foi configurada no servidor (faltam as chaves do LiveKit no .env).');
    }
    const channelId = parseId(req.params.channelId);
    const access = channelId && await channelAccess(channelId, req.userId);
    if (!access || (access.kind !== 'voice' && access.kind !== 'dm')) fail(404, 'Canal de voz não encontrado.');
    if (!access.can(P.CONNECT)) {
      fail(403, access.timeoutUntil ? 'Você está de castigo e não pode entrar na voz agora.' : 'Você não tem permissão para entrar neste canal de voz.');
    }

    const { rows } = await db.query('SELECT id, username, display_name, is_bot, avatar_id, status, status_text FROM users WHERE id = $1', [req.userId]);
    const user = S.user(rows[0]);
    // Modo palco: só fala quem modera ou quem foi chamado para o palco.
    const stage = access.kind === 'voice' && !!access.channel.stage;
    const moderator = stage && access.can(P.MANAGE_STAGE);
    const onStage = !stage || moderator || voice.isStageSpeaker(channelId, req.userId);
    const canSpeak = access.can(P.SPEAK) && onStage;
    const canVideo = access.can(P.VIDEO) && onStage;
    res.json({
      token: voice.livekitToken({ user, channelId, canSpeak, canVideo }),
      room: voice.roomName(channelId),
      canSpeak,
      canVideo,
      stage,
      moderator,
    });
  }));
};
