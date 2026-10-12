-- Fóruns, perfis mais ricos, níveis (XP), comandos de barra e "não perturbe" agendado.

-- Perfil: capa (banner), cor do perfil, "jogando agora" e horário de silêncio.
ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_id text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_color text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS activity jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS dnd_schedule jsonb;

-- Fórum: cada post é uma thread pendurada no canal do fórum (sem mensagem de origem).
-- "solved" marca a dúvida como resolvida; "pinned" deixa o post no topo.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS solved boolean NOT NULL DEFAULT false;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS topic text;

-- Níveis e XP (opcional por servidor).
ALTER TABLE servers ADD COLUMN IF NOT EXISTS levels jsonb;
CREATE TABLE IF NOT EXISTS nexo_xp (
  server_id int NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id   int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  xp        int NOT NULL DEFAULT 0,
  level     int NOT NULL DEFAULT 0,
  messages  int NOT NULL DEFAULT 0,
  last_at   timestamptz,
  PRIMARY KEY (server_id, user_id)
);
CREATE INDEX IF NOT EXISTS nexo_xp_rank_idx ON nexo_xp (server_id, xp DESC);

-- Comandos de barra criados pelos bots.
CREATE TABLE IF NOT EXISTS nexo_bot_commands (
  bot_id      int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_id, name)
);

-- Mensagem que veio de um comando (/dado, /sortear...): mostra "usou /dado".
ALTER TABLE messages ADD COLUMN IF NOT EXISTS command jsonb;
