PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  uri TEXT,
  title TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  page_count INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE (collection_id, content_hash)
);

CREATE INDEX IF NOT EXISTS documents_collection_idx ON documents(collection_id);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  breadcrumb TEXT NOT NULL DEFAULT '',
  page_from INTEGER,
  page_to INTEGER,
  char_start INTEGER NOT NULL DEFAULT 0,
  char_end INTEGER NOT NULL DEFAULT 0,
  token_est INTEGER NOT NULL DEFAULT 0,
  code_tokens TEXT NOT NULL DEFAULT '',
  meta_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (document_id, ordinal)
);

CREATE INDEX IF NOT EXISTS chunks_collection_idx ON chunks(collection_id);
CREATE INDEX IF NOT EXISTS chunks_document_idx ON chunks(document_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  chunk_id UNINDEXED,
  text,
  code_tokens,
  title,
  breadcrumb,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS embeddings (
  chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vector BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chunk_id, model)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL UNIQUE,
  title TEXT,
  started_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  turns INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  session_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  model TEXT NOT NULL,
  thinking INTEGER NOT NULL DEFAULT 0,
  profile_id TEXT,
  profile_name TEXT,
  retrieval_enabled INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  ttfb_ms INTEGER,
  usage_json TEXT NOT NULL DEFAULT '{}',
  cost_usd REAL NOT NULL DEFAULT 0,
  pricing_basis TEXT NOT NULL DEFAULT 'off-peak',
  request_json TEXT NOT NULL DEFAULT '{}',
  response_json TEXT NOT NULL DEFAULT '{}',
  injected_context TEXT,
  error TEXT,
  feedback TEXT,
  annotation TEXT
);

CREATE INDEX IF NOT EXISTS traces_created_idx ON traces(created_at DESC);
CREATE INDEX IF NOT EXISTS traces_session_idx ON traces(session_key, created_at ASC);
CREATE INDEX IF NOT EXISTS traces_feedback_idx ON traces(feedback);

CREATE TABLE IF NOT EXISTS trace_sources (
  trace_id TEXT NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  chunk_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  title TEXT NOT NULL,
  heading TEXT,
  page INTEGER,
  score REAL NOT NULL DEFAULT 0,
  snippet TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (trace_id, ordinal)
);

CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dataset_versions (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  case_count INTEGER NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  anchor_status_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE (dataset_id, version)
);

CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  case_key TEXT NOT NULL,
  data_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (dataset_id, case_key)
);

CREATE INDEX IF NOT EXISTS cases_dataset_idx ON cases(dataset_id);

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  parent_id TEXT,
  spec_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  UNIQUE (name, version)
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  dataset_version_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  budget_usd REAL NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL DEFAULT '{}',
  summary_json TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);

CREATE INDEX IF NOT EXISTS runs_created_idx ON runs(created_at DESC);

CREATE TABLE IF NOT EXISTS run_items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL,
  status TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  usage_json TEXT NOT NULL DEFAULT '{}',
  cost_usd REAL NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  sources_json TEXT NOT NULL DEFAULT '[]',
  retrieval_json TEXT,
  grader_results_json TEXT NOT NULL DEFAULT '[]',
  pass INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE INDEX IF NOT EXISTS run_items_run_idx ON run_items(run_id);

CREATE TABLE IF NOT EXISTS gates (
  id TEXT PRIMARY KEY,
  baseline_run_id TEXT NOT NULL,
  candidate_run_id TEXT NOT NULL,
  config_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  artifact_md TEXT,
  artifact_html TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS finetune_exports (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  dataset_version_id TEXT NOT NULL,
  format TEXT NOT NULL,
  path TEXT NOT NULL,
  manifest_path TEXT NOT NULL,
  stats_json TEXT NOT NULL DEFAULT '{}',
  filters_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS finetune_jobs (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  base_model TEXT NOT NULL,
  export_id TEXT NOT NULL,
  status TEXT NOT NULL,
  external_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS events_created_idx ON events(created_at DESC);
