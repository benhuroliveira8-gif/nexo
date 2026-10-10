-- Fase 4: respostas, threads, mensagens fixadas, busca, status e foto de perfil.

-- ---------- Responder uma mensagem
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id BIGINT REFERENCES messages(id) ON DELETE SET NULL;

-- ---------- Mensagens fixadas
ALTER TABLE messages ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS pinned_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS messages_pinned_idx ON messages (channel_id, pinned_at DESC) WHERE pinned_at IS NOT NULL;

-- ---------- Threads: são canais (kind = 'thread') pendurados numa mensagem de outro canal
ALTER TABLE channels ADD COLUMN IF NOT EXISTS parent_channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS parent_message_id BIGINT REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS channels_parent_idx ON channels (parent_channel_id);
CREATE UNIQUE INDEX IF NOT EXISTS channels_thread_message_idx ON channels (parent_message_id) WHERE kind = 'thread';

-- ---------- Busca: índice de trigramas deixa o "contém o texto" rápido
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS messages_content_trgm_idx ON messages USING gin (content gin_trgm_ops);

-- ---------- Status (online, ausente, não perturbe, invisível) + texto livre ("Jogando...")
ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(10) NOT NULL DEFAULT 'online';
ALTER TABLE users ADD COLUMN IF NOT EXISTS status_text VARCHAR(80);

-- ---------- Foto de perfil (arquivo em UPLOAD_DIR/avatars)
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_id VARCHAR(40);
