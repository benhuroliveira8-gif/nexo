-- Emojis personalizados de cada servidor (as imagens ficam em UPLOAD_DIR/emojis).
-- Nome de tabela próprio do Nexo, para não bater com tabelas antigas de outro formato.
CREATE TABLE IF NOT EXISTS nexo_emojis (
  id         SERIAL      PRIMARY KEY,
  server_id  INTEGER     NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name       VARCHAR(32) NOT NULL,
  file       VARCHAR(40) NOT NULL,
  animated   BOOLEAN     NOT NULL DEFAULT false,
  created_by INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (server_id, name)
);
CREATE INDEX IF NOT EXISTS nexo_emojis_server_idx ON nexo_emojis (server_id);
