-- Fase 2: cargos e permissões, DMs e amigos, anexos, reações,
-- edição de mensagens, menções e mensagens não lidas.

-- ---------- Canais: agora podem ser de servidor ('text') ou mensagem direta ('dm')
ALTER TABLE channels ALTER COLUMN server_id DROP NOT NULL;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS kind VARCHAR(10) NOT NULL DEFAULT 'text';
ALTER TABLE channels ADD COLUMN IF NOT EXISTS dm_key VARCHAR(40) UNIQUE;

CREATE TABLE IF NOT EXISTS dm_members (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS dm_members_user_idx ON dm_members (user_id);

-- ---------- Mensagens: texto pode ser vazio quando há anexo; edição; menções
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_content_check;
ALTER TABLE messages ADD CONSTRAINT messages_content_len CHECK (char_length(content) <= 4000);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS mention_everyone BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS message_mentions (
  message_id BIGINT  NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS message_mentions_user_idx ON message_mentions (user_id, message_id);

CREATE TABLE IF NOT EXISTS reactions (
  message_id BIGINT      NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  emoji      VARCHAR(64) NOT NULL,
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, emoji, user_id)
);

CREATE TABLE IF NOT EXISTS attachments (
  id           VARCHAR(32)  PRIMARY KEY,
  uploader_id  INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  message_id   BIGINT       REFERENCES messages(id) ON DELETE CASCADE,
  filename     VARCHAR(255) NOT NULL,
  content_type VARCHAR(100) NOT NULL,
  size         INTEGER      NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attachments_message_idx ON attachments (message_id);

-- ---------- Cargos e permissões
CREATE TABLE IF NOT EXISTS roles (
  id          SERIAL      PRIMARY KEY,
  server_id   INTEGER     NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name        VARCHAR(32) NOT NULL,
  color       VARCHAR(7),
  permissions BIGINT      NOT NULL DEFAULT 0,
  position    INTEGER     NOT NULL DEFAULT 0,
  is_default  BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS roles_server_idx ON roles (server_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS roles_one_default ON roles (server_id) WHERE is_default;

CREATE TABLE IF NOT EXISTS member_roles (
  server_id INTEGER NOT NULL,
  user_id   INTEGER NOT NULL,
  role_id   INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (server_id, user_id, role_id),
  FOREIGN KEY (server_id, user_id) REFERENCES server_members (server_id, user_id) ON DELETE CASCADE
);

-- Cria o cargo @everyone dos servidores que já existiam.
-- 480 = criar convite + enviar mensagens + anexar arquivos + reagir
INSERT INTO roles (server_id, name, permissions, position, is_default)
SELECT s.id, '@everyone', 480, 0, true
FROM servers s
WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.server_id = s.id AND r.is_default);

-- ---------- Leitura (para mostrar canais não lidos e contagem de menções)
CREATE TABLE IF NOT EXISTS channel_reads (
  user_id      INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  channel_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_read_id BIGINT  NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, channel_id)
);

-- Tudo que já existia conta como lido, para ninguém ganhar centenas de "não lidas".
INSERT INTO channel_reads (user_id, channel_id, last_read_id)
SELECT m.user_id, c.id, COALESCE((SELECT max(id) FROM messages WHERE channel_id = c.id), 0)
FROM channels c
JOIN server_members m ON m.server_id = c.server_id
ON CONFLICT DO NOTHING;

-- ---------- Amizades
CREATE TABLE IF NOT EXISTS friendships (
  requester_id INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       VARCHAR(10) NOT NULL DEFAULT 'pending',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (requester_id, addressee_id),
  CHECK (requester_id <> addressee_id)
);
CREATE INDEX IF NOT EXISTS friendships_addressee_idx ON friendships (addressee_id);
CREATE UNIQUE INDEX IF NOT EXISTS friendships_pair_idx
  ON friendships (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id));
