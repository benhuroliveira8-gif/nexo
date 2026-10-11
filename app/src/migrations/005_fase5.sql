-- Fase 5: categorias, canais privados, moderação (ban, castigo, auditoria), convites com
-- validade, ícone do servidor, "sobre mim", 2FA, notificações push, enquetes, prévias de link,
-- mensagens de voz e grupos de mensagem direta.

-- ---------- Categorias (são "canais" do tipo 'category') e canais privados
ALTER TABLE channels ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES channels(id) ON DELETE SET NULL;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS private BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS channels_category_idx ON channels (category_id);

-- Quais cargos podem ver um canal privado.
CREATE TABLE IF NOT EXISTS channel_roles (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  role_id    INTEGER NOT NULL REFERENCES roles(id)    ON DELETE CASCADE,
  PRIMARY KEY (channel_id, role_id)
);
CREATE INDEX IF NOT EXISTS channel_roles_role_idx ON channel_roles (role_id);

-- Servidores que já existiam ganham as categorias "Canais de texto" e "Canais de voz"
-- (assim a lista continua com a mesma cara de antes).
INSERT INTO channels (server_id, name, kind, position)
SELECT s.id, 'Canais de texto', 'category', 0 FROM servers s;
INSERT INTO channels (server_id, name, kind, position)
SELECT s.id, 'Canais de voz', 'category', 1 FROM servers s;
UPDATE channels c SET category_id = cat.id
FROM channels cat
WHERE cat.server_id = c.server_id AND cat.kind = 'category'
  AND c.kind IN ('text', 'voice')
  AND cat.name = CASE c.kind WHEN 'text' THEN 'Canais de texto' ELSE 'Canais de voz' END;

-- ---------- Ícone do servidor (arquivo em UPLOAD_DIR/avatars)
ALTER TABLE servers ADD COLUMN IF NOT EXISTS icon_id VARCHAR(40);

-- ---------- Convites: vários por servidor, com validade e limite de usos
CREATE TABLE IF NOT EXISTS invites (
  code       VARCHAR(16) PRIMARY KEY,
  server_id  INTEGER     NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  created_by INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  max_uses   INTEGER,                -- NULL = sem limite
  uses       INTEGER     NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ,            -- NULL = nunca expira
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invites_server_idx ON invites (server_id);
-- Os convites antigos continuam funcionando (sem validade).
INSERT INTO invites (code, server_id, created_by)
SELECT s.invite_code, s.id, s.owner_id FROM servers s WHERE s.invite_code IS NOT NULL
ON CONFLICT DO NOTHING;
ALTER TABLE servers ALTER COLUMN invite_code DROP NOT NULL;

-- ---------- Moderação
CREATE TABLE IF NOT EXISTS server_bans (
  server_id  INTEGER     NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id    INTEGER     NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  banned_by  INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  reason     VARCHAR(300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, user_id)
);

-- Castigo (timeout): até essa hora a pessoa só pode ler.
ALTER TABLE server_members ADD COLUMN IF NOT EXISTS timeout_until TIMESTAMPTZ;

-- Registro de auditoria: quem fez o quê no servidor.
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL   PRIMARY KEY,
  server_id   INTEGER     NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  actor_id    INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  action      VARCHAR(40) NOT NULL,
  target_id   INTEGER,
  target_name VARCHAR(120),
  details     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_server_idx ON audit_log (server_id, id DESC);

-- ---------- Conta: "sobre mim", sair de todos os aparelhos e 2FA
ALTER TABLE users ADD COLUMN IF NOT EXISTS about VARCHAR(190);
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_recovery TEXT[];

-- ---------- Notificações push (celular/computador com o Nexo fechado)
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         SERIAL       PRIMARY KEY,
  user_id    INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT         NOT NULL UNIQUE,
  p256dh     VARCHAR(200) NOT NULL,
  auth       VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_id);

-- Configurações internas geradas sozinhas (ex.: chaves do push).
CREATE TABLE IF NOT EXISTS app_settings (
  key   VARCHAR(60) PRIMARY KEY,
  value TEXT        NOT NULL
);

-- ---------- Mensagens: tipo (normal ou aviso do sistema) e prévias de link
ALTER TABLE messages ADD COLUMN IF NOT EXISTS kind VARCHAR(12) NOT NULL DEFAULT 'default';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS embeds JSONB;

CREATE TABLE IF NOT EXISTS link_previews (
  url        TEXT        PRIMARY KEY,
  data       JSONB,                  -- NULL = o link não tem prévia
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Enquetes
CREATE TABLE IF NOT EXISTS polls (
  message_id BIGINT       PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  question   VARCHAR(300) NOT NULL,
  options    JSONB        NOT NULL,  -- ["opção 1", "opção 2", ...]
  multiple   BOOLEAN      NOT NULL DEFAULT false,
  ends_at    TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS poll_votes (
  message_id   BIGINT   NOT NULL REFERENCES polls(message_id) ON DELETE CASCADE,
  option_index SMALLINT NOT NULL,
  user_id      INTEGER  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, option_index)
);

-- ---------- Mensagens de voz (são anexos de áudio com duração e "onda")
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS is_voice BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS duration REAL;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS waveform VARCHAR(200);

-- ---------- Grupos de mensagem direta: canais 'dm' sem dm_key, com nome e dono (created_by)
CREATE INDEX IF NOT EXISTS dm_members_channel_idx ON dm_members (channel_id);
