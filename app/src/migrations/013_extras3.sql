-- Busca sem acento e com erro de digitação, texto de PDFs, transcrição de áudios,
-- cargo com emoji e cargo temporário, sala de espera na voz e histórico de quedas.

CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- "Você" e "voce", "AÇÃO" e "acao" viram a mesma coisa na busca.
CREATE OR REPLACE FUNCTION nexo_norm(t text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT lower(public.unaccent('public.unaccent'::regdictionary, coalesce(t, ''))) $$;

CREATE INDEX IF NOT EXISTS messages_norm_trgm_idx ON messages USING gin (nexo_norm(content) gin_trgm_ops);

-- Texto de dentro de PDFs/arquivos de texto e transcrição das mensagens de voz.
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS text_content text;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS transcript text;

-- Cargo com emoji ao lado do nome e cargo temporário (vence sozinho).
ALTER TABLE roles ADD COLUMN IF NOT EXISTS icon text;
ALTER TABLE member_roles ADD COLUMN IF NOT EXISTS expires_at timestamptz;
CREATE INDEX IF NOT EXISTS member_roles_expires_idx ON member_roles (expires_at) WHERE expires_at IS NOT NULL;

-- Sala de espera num canal de voz.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS waiting_room boolean NOT NULL DEFAULT false;

-- Cada vez que o Nexo liga: para o painel de saúde mostrar reinícios e quedas.
CREATE TABLE IF NOT EXISTS nexo_runs (
  id         serial PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_beat  timestamptz NOT NULL DEFAULT now(),
  stopped_at timestamptz,
  clean      boolean,
  version    text
);
