-- Silenciar servidor/canal, caixa de menções, modo lento, webhooks e confirmação de e-mail.

-- Notificações por servidor ou canal. target = 's:<id do servidor>' ou 'c:<id do canal>'.
-- level: 'all' (todas), 'mentions' (só menções), 'none' (nada); NULL = padrão.
CREATE TABLE IF NOT EXISTS nexo_notify (
  user_id     int  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target      text NOT NULL,
  level       text CHECK (level IN ('all', 'mentions', 'none')),
  muted_until timestamptz,
  PRIMARY KEY (user_id, target)
);

-- Caixa de menções: até qual mensagem a pessoa já viu.
ALTER TABLE users ADD COLUMN IF NOT EXISTS mentions_seen_id bigint NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS messages_everyone_idx ON messages (channel_id, id) WHERE mention_everyone;

-- Modo lento (segundos entre mensagens de cada pessoa).
ALTER TABLE channels ADD COLUMN IF NOT EXISTS slowmode_seconds int NOT NULL DEFAULT 0;

-- Webhooks: um link secreto que posta num canal. Cada webhook tem uma "conta" própria
-- (is_webhook) que aparece como autora das mensagens.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_webhook boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS nexo_webhooks (
  id           serial PRIMARY KEY,
  server_id    int NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  channel_id   int NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id      int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL,
  created_by   int REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  uses         int NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS nexo_webhooks_channel_idx ON nexo_webhooks (channel_id);

-- E-mail (confirmação no cadastro e recuperação de senha).
-- email = endereço confirmado; email_new = esperando o código.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_new text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_required boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_code_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_code_expires_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_code_tries int NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_reset_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_reset_expires_at timestamptz;
-- Só e-mail confirmado fica em "email" e é único (ninguém reserva o e-mail dos outros sem confirmar).
CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (lower(email)) WHERE email IS NOT NULL;
