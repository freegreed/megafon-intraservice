PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  callid TEXT NOT NULL UNIQUE,
  phone TEXT,
  megafon_user TEXT,
  duration INTEGER NOT NULL DEFAULT 0,
  record_url TEXT,
  call_start TEXT,
  call_type TEXT,
  call_status TEXT,
  status TEXT NOT NULL DEFAULT 'RECEIVED',
  intraservice_task_id INTEGER,
  error_type TEXT,
  error_message TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_calls_status_retry
  ON calls(status, next_retry_at, created_at);

CREATE INDEX IF NOT EXISTS idx_calls_task
  ON calls(intraservice_task_id);

CREATE TABLE IF NOT EXISTS errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  callid TEXT,
  error_type TEXT NOT NULL,
  error_message TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_errors_callid
  ON errors(callid, created_at);
