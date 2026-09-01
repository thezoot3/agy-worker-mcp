-- agy-worker-mcp project state.
-- Transcribed from docs/01-architecture.md 결정 2. READ-ONLY after Stage 1.
--
-- Every statement is idempotent: this file is executed on every connection open,
-- and several server processes may race to be first.

PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS meta(
  key   TEXT PRIMARY KEY,
  value TEXT
);                                     -- schema_version, project_root

CREATE TABLE IF NOT EXISTS sessions(
  session_id      TEXT PRIMARY KEY,
  conversation_id TEXT,                 -- captured from the first init event
  cwd     TEXT NOT NULL,
  model   TEXT,
  effort  TEXT,
  profile TEXT,
  turn_count  INTEGER NOT NULL DEFAULT 0,
  last_job_id TEXT,
  created_at   INTEGER,
  last_used_at INTEGER,
  state TEXT NOT NULL                   -- active | closed
);

CREATE TABLE IF NOT EXISTS jobs(
  job_id     TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(session_id),
  lifecycle  TEXT NOT NULL,             -- queued|starting|running|canceling|finished
  outcome    TEXT,
  headline   TEXT,
  cwd        TEXT NOT NULL,
  profile    TEXT NOT NULL,
  write_mode   INTEGER NOT NULL,        -- 0 readonly / 1 write
  session_mode TEXT NOT NULL,           -- oneshot | session
  pid INTEGER, pgid INTEGER, proc_start_time TEXT,   -- guards against pid reuse
  created_at  INTEGER,
  started_at  INTEGER,
  finished_at INTEGER,
  deadline_at INTEGER,
  exit_code       INTEGER,
  agent_status    TEXT,
  contract_status TEXT,
  on_denial TEXT NOT NULL DEFAULT 'continue',        -- abort | continue | guide
  requested_by   TEXT,
  parent_task_id TEXT
);

CREATE INDEX IF NOT EXISTS jobs_live ON jobs(lifecycle, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_session ON jobs(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sessions_conversation ON sessions(conversation_id);

CREATE TABLE IF NOT EXISTS locks(
  scope TEXT NOT NULL,                  -- cwd_write | session
  key   TEXT NOT NULL,
  holder_job_id TEXT NOT NULL,
  acquired_at   INTEGER NOT NULL,
  PRIMARY KEY(scope, key)
);
