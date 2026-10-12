-- Administração do Nexo (contas, bloqueio, recuperar senha, disco), "ouvindo" pelo Last.fm,
-- capa do servidor, cargos com degradê, canal de anúncios e convite que dá cargo.

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked_reason text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_key_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_code_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_expires_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS lastfm_user text;

-- A primeira conta de pessoa vira administradora do Nexo (se ainda não houver nenhuma).
UPDATE users SET is_admin = true
WHERE id = (SELECT min(id) FROM users WHERE NOT is_bot)
  AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin);

-- Anexo antigo apagado pela limpeza automática (a mensagem continua, o arquivo não).
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS purged_at timestamptz;
CREATE INDEX IF NOT EXISTS attachments_created_idx ON attachments (created_at);

ALTER TABLE servers ADD COLUMN IF NOT EXISTS banner_id text;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS color2 text;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS announce boolean NOT NULL DEFAULT false;
ALTER TABLE invites ADD COLUMN IF NOT EXISTS role_id int REFERENCES roles(id) ON DELETE SET NULL;
