BEGIN;

CREATE TABLE IF NOT EXISTS calls (
  id BIGSERIAL PRIMARY KEY,
  callid TEXT NOT NULL UNIQUE,
  phone TEXT,
  megafon_user TEXT,
  duration INTEGER NOT NULL DEFAULT 0 CHECK (duration >= 0),
  record_url TEXT,
  call_start TEXT,
  call_type TEXT,
  call_status TEXT,
  status TEXT NOT NULL DEFAULT 'RECEIVED',
  intraservice_task_id BIGINT,
  error_type TEXT,
  error_message TEXT,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  next_retry_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calls_status_retry
  ON calls(status, next_retry_at, created_at);

CREATE INDEX IF NOT EXISTS idx_calls_task
  ON calls(intraservice_task_id);

CREATE TABLE IF NOT EXISTS users_mapping (
  megafon_login TEXT PRIMARY KEY,
  megafon_name TEXT,
  email TEXT,
  intraservice_user_id BIGINT,
  intraservice_name TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  mapping_status TEXT NOT NULL DEFAULT 'PENDING',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_mapping_email
  ON users_mapping(email);

CREATE INDEX IF NOT EXISTS idx_users_mapping_active
  ON users_mapping(active, mapping_status);

CREATE TABLE IF NOT EXISTS errors (
  id BIGSERIAL PRIMARY KEY,
  callid TEXT,
  error_type TEXT NOT NULL,
  error_message TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_errors_callid
  ON errors(callid, created_at);

CREATE TABLE IF NOT EXISTS sync_runs (
  id BIGSERIAL PRIMARY KEY,
  operation TEXT NOT NULL,
  status TEXT NOT NULL,
  details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_operation
  ON sync_runs(operation, created_at);

COMMIT;
