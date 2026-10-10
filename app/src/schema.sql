-- Esquema do banco (Fase 1). Roda automaticamente quando o app inicia.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(32) NOT NULL UNIQUE,
  display_name  VARCHAR(32) NOT NULL,
  password_hash TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS servers (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  owner_id    INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_code VARCHAR(16)  NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS server_members (
  server_id INTEGER     NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id   INTEGER     NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, user_id)
);

CREATE INDEX IF NOT EXISTS server_members_user_idx ON server_members (user_id);

CREATE TABLE IF NOT EXISTS channels (
  id         SERIAL PRIMARY KEY,
  server_id  INTEGER      NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name       VARCHAR(100) NOT NULL,
  position   INTEGER      NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS channels_server_idx ON channels (server_id, position);

CREATE TABLE IF NOT EXISTS messages (
  id         BIGSERIAL PRIMARY KEY,
  channel_id INTEGER     NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id  INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  content    TEXT        NOT NULL CHECK (char_length(content) BETWEEN 1 AND 4000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_channel_idx ON messages (channel_id, id DESC);
