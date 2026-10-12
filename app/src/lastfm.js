// "Ouvindo" automático: quem liga a conta do Last.fm no perfil aparece como
// "🎧 Ouvindo Artista — Música" enquanto toca (Spotify, YouTube Music, Deezer... conectados ao Last.fm).
// Precisa de LASTFM_API_KEY no .env (grátis em https://www.last.fm/api/account/create).
const db = require('./db');
const presence = require('./presence');

const KEY = String(process.env.LASTFM_API_KEY || '').trim();
const API = process.env.LASTFM_API_URL || 'https://ws.audioscrobbler.com/2.0/';
const TICK = Number(process.env.LASTFM_TICK_MS) || 60 * 1000;
const enabled = () => !!KEY;

async function nowPlaying(user) {
  const url = `${API}?method=user.getrecenttracks&user=${encodeURIComponent(user)}&api_key=${encodeURIComponent(KEY)}&format=json&limit=1`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'error' });
  if (!res.ok) throw new Error(`Last.fm respondeu ${res.status}`);
  const data = await res.json();
  const t = data && data.recenttracks && [].concat(data.recenttracks.track || [])[0];
  if (!t || !(t['@attr'] && t['@attr'].nowplaying === 'true')) return null;
  const artist = (t.artist && (t.artist['#text'] || t.artist.name)) || '';
  const name = String(t.name || '').trim();
  if (!name) return null;
  return `${artist ? `${artist} — ` : ''}${name}`.replace(/\s+/g, ' ').slice(0, 64);
}

async function tick() {
  const { rows } = await db.query(
    'SELECT id, lastfm_user, activity FROM users WHERE lastfm_user IS NOT NULL AND NOT is_bot AND blocked_at IS NULL ORDER BY id',
  );
  // eslint-disable-next-line global-require
  const { profileChanged } = require('./routes/auth');
  for (const u of rows.filter((x) => presence.isConnected(x.id)).slice(0, 50)) {
    const cur = u.activity;
    // Atividade escrita à mão tem prioridade: não troca.
    if (cur && cur.name && !cur.auto) continue;
    let song = null;
    try { song = await nowPlaying(u.lastfm_user); } catch { continue; }
    let next = null;
    if (song) next = { type: 'listening', name: song, auto: 'lastfm', since: cur && cur.auto && cur.name === song ? cur.since : new Date().toISOString() };
    const same = (!cur && !next) || (cur && next && cur.name === next.name && cur.type === next.type);
    if (same) continue;
    await db.query('UPDATE users SET activity = $2 WHERE id = $1', [u.id, next ? JSON.stringify(next) : null]);
    await profileChanged(u.id).catch(() => {});
  }
}

function startLastfm() {
  if (!enabled()) return;
  const run = () => tick().catch((err) => console.error('Erro no Last.fm:', err.message));
  setTimeout(run, 5000).unref();
  setInterval(run, TICK).unref();
  console.log('"Ouvindo" pelo Last.fm ligado.');
}

module.exports = { startLastfm, enabled, tick };
