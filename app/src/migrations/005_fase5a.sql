-- Fase 5A: notificações push, prévia de links, mensagem de voz, enquetes,
-- verificação em duas etapas e "sair de todos os aparelhos".

-- ---------- Conta
-- Cada login guarda a "versão" do token; aumentar a versão derruba todos os logins antigos.
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
-- Verificação em duas etapas (código de 6 dígitos de um app autenticador).
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;          -- ativo
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending TEXT;         -- em configuração
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step BIGINT;     -- evita reusar o mesmo código
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_recovery TEXT[];      -- hashes dos códigos de recuperação

-- ---------- Configurações internas (ex.: chaves das notificações push)
CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------- Notificações push (um registro por navegador/celular)
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    TEXT        NOT NULL UNIQUE,
  p256dh      TEXT        NOT NULL,
  auth        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_ok_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_id);

-- ---------- Prévia de links: guardada na mensagem + cache por endereço
ALTER TABLE messages ADD COLUMN IF NOT EXISTS embeds JSONB;
CREATE TABLE IF NOT EXISTS link_previews (
  url         TEXT PRIMARY KEY,
  data        JSONB,                 -- null = página sem prévia
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Mensagem de voz (duração e "ondinha" do áudio)
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS duration_ms INTEGER;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS waveform TEXT;

-- ---------- Enquetes
CREATE TABLE IF NOT EXISTS polls (
  message_id  BIGINT      PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  question    VARCHAR(300) NOT NULL,
  multi       BOOLEAN     NOT NULL DEFAULT false,
  ends_at     TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS poll_options (
  id          SERIAL PRIMARY KEY,
  message_id  BIGINT      NOT NULL REFERENCES polls(message_id) ON DELETE CASCADE,
  position    SMALLINT    NOT NULL,
  text        VARCHAR(80) NOT NULL
);
CREATE INDEX IF NOT EXISTS poll_options_message_idx ON poll_options (message_id, position);
CREATE TABLE IF NOT EXISTS poll_votes (
  option_id   INTEGER     NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  message_id  BIGINT      NOT NULL REFERENCES polls(message_id) ON DELETE CASCADE,
  user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (option_id, user_id)
);
CREATE INDEX IF NOT EXISTS poll_votes_message_idx ON poll_votes (message_id);
