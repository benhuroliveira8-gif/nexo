-- Eventos do servidor (ex.: "Jogatina sexta às 21h") e quem confirmou presença.
CREATE TABLE IF NOT EXISTS nexo_events (
  id          serial PRIMARY KEY,
  server_id   int NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  channel_id  int REFERENCES channels(id) ON DELETE SET NULL,
  title       text NOT NULL,
  description text NOT NULL DEFAULT '',
  starts_at   timestamptz NOT NULL,
  created_by  int REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  reminded_at timestamptz,   -- aviso "começa em 15 minutos" já mandado
  started_at  timestamptz    -- aviso "começou" já mandado
);
CREATE INDEX IF NOT EXISTS nexo_events_server_idx ON nexo_events (server_id, starts_at);
CREATE INDEX IF NOT EXISTS nexo_events_pending_idx ON nexo_events (starts_at) WHERE started_at IS NULL;

CREATE TABLE IF NOT EXISTS nexo_event_rsvps (
  event_id   int NOT NULL REFERENCES nexo_events(id) ON DELETE CASCADE,
  user_id    int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     text NOT NULL CHECK (status IN ('going', 'maybe')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);

-- Nova permissão "Criar eventos" (bit 18): liberada para todos nos servidores que já existem.
UPDATE roles SET permissions = permissions | 262144 WHERE is_default AND (permissions & 262144) = 0;
