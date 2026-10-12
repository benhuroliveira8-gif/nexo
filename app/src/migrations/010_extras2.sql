-- Status com prazo, mensagens agendadas, lembretes, mensagens salvas, figurinhas,
-- sons (soundboard), modo palco, boas-vindas e moderação automática.

ALTER TABLE users ADD COLUMN IF NOT EXISTS status_expires_at timestamptz;

CREATE TABLE IF NOT EXISTS nexo_scheduled (
  id         serial PRIMARY KEY,
  user_id    int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id int NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  content    text NOT NULL,
  send_at    timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nexo_scheduled_send_idx ON nexo_scheduled (send_at);
CREATE INDEX IF NOT EXISTS nexo_scheduled_user_idx ON nexo_scheduled (user_id);

CREATE TABLE IF NOT EXISTS nexo_reminders (
  id         serial PRIMARY KEY,
  user_id    int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  remind_at  timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nexo_reminders_at_idx ON nexo_reminders (remind_at);
CREATE INDEX IF NOT EXISTS nexo_reminders_user_idx ON nexo_reminders (user_id);

CREATE TABLE IF NOT EXISTS nexo_saved (
  user_id    int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, message_id)
);

CREATE TABLE IF NOT EXISTS nexo_stickers (
  id         serial PRIMARY KEY,
  server_id  int NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name       text NOT NULL,
  file       text NOT NULL,
  created_by int REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (server_id, name)
);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sticker jsonb;

CREATE TABLE IF NOT EXISTS nexo_sounds (
  id         serial PRIMARY KEY,
  server_id  int NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name       text NOT NULL,
  emoji      text NOT NULL DEFAULT '🔊',
  file       text NOT NULL,
  created_by int REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (server_id, name)
);

ALTER TABLE channels ADD COLUMN IF NOT EXISTS stage boolean NOT NULL DEFAULT false;

ALTER TABLE servers ADD COLUMN IF NOT EXISTS welcome jsonb;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS automod jsonb;
