-- ============================================================
--  Схема базы данных D1 для интеграции
--  МегаФон ВАТС → Cloudflare Worker → IntraService
-- ============================================================

-- Таблица: звонки
-- Хранит каждое событие звонка и его статус обработки
CREATE TABLE IF NOT EXISTS calls (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  callid               TEXT UNIQUE NOT NULL,        -- уникальный ID звонка из МегаФона
  phone                TEXT,                        -- номер клиента
  megafon_user         TEXT,                        -- идентификатор оператора в МегаФоне
  duration             INTEGER DEFAULT 0,            -- длительность разговора в секундах
  record_url           TEXT,                         -- ссылка на запись разговора
  call_start            TEXT,                         -- время начала звонка
  call_type            TEXT,                         -- incoming / outgoing
  call_status          TEXT,                         -- Success / Failed / NoAnswer ...
  status               TEXT DEFAULT 'RECEIVED',      -- RECEIVED / PROCESSING / CREATED / ERROR / RETRY / SKIPPED
  intraservice_task_id INTEGER,                      -- ID созданной заявки в IntraService
  error_type           TEXT,                         -- тип ошибки
  error_message        TEXT,                         -- текст ошибки
  attempt              INTEGER DEFAULT 0,            -- количество попыток обработки
  created_at           TEXT DEFAULT (datetime('now')),
  updated_at           TEXT DEFAULT (datetime('now'))
);

-- Индекс для быстрого поиска по статусу (для retry)
CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status);

-- Таблица: сопоставление сотрудников МегаФон ↔ IntraService
CREATE TABLE IF NOT EXISTS users_mapping (
  megafon_login        TEXT PRIMARY KEY,             -- login сотрудника в МегаФоне
  megafon_name         TEXT,                         -- имя сотрудника в МегаФоне
  email                TEXT,                         -- email (ключ сопоставления)
  intraservice_user_id INTEGER,                      -- ID пользователя в IntraService
  intraservice_name    TEXT,                         -- имя пользователя в IntraService
  active               INTEGER DEFAULT 1,            -- 1 = активен, 0 = отключён
  updated_at           TEXT DEFAULT (datetime('now'))
);

-- Индекс для поиска по email
CREATE INDEX IF NOT EXISTS idx_users_email ON users_mapping(email);

-- Таблица: журнал ошибок
CREATE TABLE IF NOT EXISTS errors (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  callid       TEXT,
  error_type   TEXT,
  error_message TEXT,
  attempt      INTEGER,
  created_at   TEXT DEFAULT (datetime('now'))
);

-- Индекс для поиска ошибок по callid
CREATE INDEX IF NOT EXISTS idx_errors_callid ON errors(callid);
