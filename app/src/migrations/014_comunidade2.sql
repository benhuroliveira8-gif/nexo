-- Primeiros passos (regras + interesses), mensagens que somem, pastas de servidores,
-- canal de clipes, link do calendário, denúncias e cor do servidor.

-- Primeiros passos: { enabled, rules, interests: [{ id, emoji, label, roleId }] }
ALTER TABLE servers ADD COLUMN IF NOT EXISTS onboarding jsonb;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS theme_color text;
-- Quando a pessoa aceitou as regras (NULL = ainda não). Quem já estava conta como aceito.
ALTER TABLE server_members ADD COLUMN IF NOT EXISTS onboarded_at timestamptz;
UPDATE server_members SET onboarded_at = joined_at WHERE onboarded_at IS NULL;
ALTER TABLE server_members ALTER COLUMN onboarded_at SET DEFAULT now();

-- Mensagens que somem (conversas diretas).
ALTER TABLE channels ADD COLUMN IF NOT EXISTS disappearing_seconds int NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS expires_at timestamptz;
CREATE INDEX IF NOT EXISTS messages_expires_idx ON messages (expires_at) WHERE expires_at IS NOT NULL;

-- Canal de clipes (os clipes da tela compartilhada vão para ele).
ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_clips boolean NOT NULL DEFAULT false;

-- Pastas de servidores (cada pessoa organiza a sua barra) e link secreto do calendário.
ALTER TABLE users ADD COLUMN IF NOT EXISTS server_folders jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS calendar_token text;
CREATE UNIQUE INDEX IF NOT EXISTS users_calendar_token_idx ON users (calendar_token) WHERE calendar_token IS NOT NULL;

-- Denúncias de mensagens (fila da moderação).
CREATE TABLE IF NOT EXISTS nexo_reports (
  id          serial PRIMARY KEY,
  server_id   int NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  channel_id  int REFERENCES channels(id) ON DELETE SET NULL,
  message_id  bigint REFERENCES messages(id) ON DELETE SET NULL,
  reporter_id int REFERENCES users(id) ON DELETE SET NULL,
  author_id   int REFERENCES users(id) ON DELETE SET NULL,
  reason      text NOT NULL,
  details     text,
  snapshot    jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolved_by int REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nexo_reports_server_idx ON nexo_reports (server_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS nexo_reports_once_idx ON nexo_reports (message_id, reporter_id) WHERE status = 'open';
