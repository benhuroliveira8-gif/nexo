-- Fase 3: canais de voz e contas de bot.

-- ---------- Bots: são usuários especiais, que entram por token (sem senha).
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_bot BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bot_owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bot_token_hash VARCHAR(64) UNIQUE;
CREATE INDEX IF NOT EXISTS users_bot_owner_idx ON users (bot_owner_id) WHERE is_bot;

-- ---------- Voz: canais agora podem ser 'text', 'voice' ou 'dm' (coluna "kind" já existe).
-- Novas permissões: entrar na voz (2048), falar (4096) e vídeo/tela (8192).
-- Todo mundo ganha essas três no @everyone; dá para tirar depois nas configurações.
UPDATE roles SET permissions = permissions | 14336 WHERE is_default;
