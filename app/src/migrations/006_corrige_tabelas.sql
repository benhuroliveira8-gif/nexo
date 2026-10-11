-- Correção da Fase 5: alguns bancos já tinham tabelas com o mesmo nome (ex.: "poll_votes")
-- mas com outro formato. Aí o "CREATE TABLE IF NOT EXISTS" da 005 pulava a criação e o app
-- quebrava. Aqui, toda tabela da Fase 5 que não tiver as colunas certas é movida para o
-- esquema "antigo" (nada é apagado) e criada de novo no formato certo.

CREATE SCHEMA IF NOT EXISTS antigo;

DO $$
DECLARE
  spec RECORD;
  missing INT;
  moved_invites BOOLEAN := false;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      -- poll_votes antes de polls (depende dela)
      ('poll_votes',         ARRAY['message_id','option_index','user_id','created_at']),
      ('polls',              ARRAY['message_id','question','options','multiple','ends_at']),
      ('channel_roles',      ARRAY['channel_id','role_id']),
      ('invites',            ARRAY['code','server_id','created_by','max_uses','uses','expires_at','created_at']),
      ('server_bans',        ARRAY['server_id','user_id','banned_by','reason','created_at']),
      ('audit_log',          ARRAY['id','server_id','actor_id','action','target_id','target_name','details','created_at']),
      ('push_subscriptions', ARRAY['id','user_id','endpoint','p256dh','auth','created_at']),
      ('app_settings',       ARRAY['key','value']),
      ('link_previews',      ARRAY['url','data','fetched_at'])
    ) AS t(name, cols)
  LOOP
    IF to_regclass('public.' || spec.name) IS NULL THEN
      CONTINUE;
    END IF;
    SELECT count(*) INTO missing
    FROM unnest(spec.cols) AS c(col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = spec.name AND column_name = c.col
    );
    -- Se a tabela de votos está errada, a de enquetes vai junto (uma depende da outra).
    IF missing = 0 AND spec.name = 'polls' AND to_regclass('public.poll_votes') IS NULL THEN
      missing := 1;
    END IF;
    IF missing > 0 THEN
      RAISE NOTICE 'Tabela % com formato antigo: movendo para antigo.%', spec.name, spec.name;
      EXECUTE format('DROP TABLE IF EXISTS antigo.%I CASCADE', spec.name);
      EXECUTE format('ALTER TABLE public.%I SET SCHEMA antigo', spec.name);
      IF spec.name = 'invites' THEN moved_invites := true; END IF;
    END IF;
  END LOOP;

  -- Recria as tabelas que foram movidas (as que já estavam certas não mudam).
  CREATE TABLE IF NOT EXISTS public.channel_roles (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    role_id    INTEGER NOT NULL REFERENCES roles(id)    ON DELETE CASCADE,
    PRIMARY KEY (channel_id, role_id)
  );
  CREATE INDEX IF NOT EXISTS channel_roles_role_idx ON public.channel_roles (role_id);

  CREATE TABLE IF NOT EXISTS public.invites (
    code       VARCHAR(16) PRIMARY KEY,
    server_id  INTEGER     NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    created_by INTEGER     REFERENCES users(id) ON DELETE SET NULL,
    max_uses   INTEGER,
    uses       INTEGER     NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS invites_server_idx ON public.invites (server_id);
  IF moved_invites THEN
    -- Os convites que já existiam continuam valendo.
    BEGIN
      EXECUTE 'INSERT INTO public.invites (code, server_id, created_by)
               SELECT code, server_id, created_by FROM antigo.invites
               WHERE server_id IN (SELECT id FROM servers)
               ON CONFLICT DO NOTHING';
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Não deu para copiar os convites antigos: %', SQLERRM;
    END;
  END IF;
  INSERT INTO public.invites (code, server_id, created_by)
  SELECT s.invite_code, s.id, s.owner_id FROM servers s WHERE s.invite_code IS NOT NULL
  ON CONFLICT DO NOTHING;
  -- Servidor sem nenhum convite ganha um (sem validade).
  INSERT INTO public.invites (code, server_id, created_by)
  SELECT substr(md5(random()::text || s.id::text), 1, 8), s.id, s.owner_id FROM servers s
  WHERE NOT EXISTS (SELECT 1 FROM public.invites i WHERE i.server_id = s.id)
  ON CONFLICT DO NOTHING;

  CREATE TABLE IF NOT EXISTS public.server_bans (
    server_id  INTEGER     NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id    INTEGER     NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    banned_by  INTEGER     REFERENCES users(id) ON DELETE SET NULL,
    reason     VARCHAR(300),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (server_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS public.audit_log (
    id          BIGSERIAL   PRIMARY KEY,
    server_id   INTEGER     NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    actor_id    INTEGER     REFERENCES users(id) ON DELETE SET NULL,
    action      VARCHAR(40) NOT NULL,
    target_id   INTEGER,
    target_name VARCHAR(120),
    details     JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS audit_log_server_idx ON public.audit_log (server_id, id DESC);

  CREATE TABLE IF NOT EXISTS public.push_subscriptions (
    id         SERIAL       PRIMARY KEY,
    user_id    INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint   TEXT         NOT NULL UNIQUE,
    p256dh     VARCHAR(200) NOT NULL,
    auth       VARCHAR(100) NOT NULL,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON public.push_subscriptions (user_id);

  CREATE TABLE IF NOT EXISTS public.app_settings (
    key   VARCHAR(60) PRIMARY KEY,
    value TEXT        NOT NULL
  );

  CREATE TABLE IF NOT EXISTS public.link_previews (
    url        TEXT        PRIMARY KEY,
    data       JSONB,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS public.polls (
    message_id BIGINT       PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    question   VARCHAR(300) NOT NULL,
    options    JSONB        NOT NULL,
    multiple   BOOLEAN      NOT NULL DEFAULT false,
    ends_at    TIMESTAMPTZ
  );
  CREATE TABLE IF NOT EXISTS public.poll_votes (
    message_id   BIGINT   NOT NULL REFERENCES public.polls(message_id) ON DELETE CASCADE,
    option_index SMALLINT NOT NULL,
    user_id      INTEGER  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id, option_index)
  );
END $$;
