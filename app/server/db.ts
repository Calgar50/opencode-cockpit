import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;
export type SqlValue = string | number | bigint | null | Uint8Array;

// Chaque entrée est appliquée une seule fois, dans l'ordre (PRAGMA user_version).
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    root_id TEXT NOT NULL,
    directory TEXT NOT NULL DEFAULT '',
    project_id TEXT,
    title TEXT NOT NULL DEFAULT '',
    purpose TEXT NOT NULL DEFAULT 'chat',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE INDEX idx_sessions_root ON sessions(root_id);
  CREATE INDEX idx_sessions_updated ON sessions(updated_at);

  CREATE TABLE usage (
    message_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    root_id TEXT NOT NULL,
    directory TEXT NOT NULL DEFAULT '',
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    agent TEXT NOT NULL DEFAULT '',
    purpose TEXT NOT NULL DEFAULT 'chat',
    parent_message_id TEXT,
    created_at INTEGER NOT NULL,
    completed_at INTEGER,
    tokens_input INTEGER NOT NULL DEFAULT 0,
    tokens_output INTEGER NOT NULL DEFAULT 0,
    tokens_reasoning INTEGER NOT NULL DEFAULT 0,
    tokens_cache_read INTEGER NOT NULL DEFAULT 0,
    tokens_cache_write INTEGER NOT NULL DEFAULT 0,
    cost_reported REAL NOT NULL DEFAULT 0,
    cost_estimated REAL,
    cost REAL NOT NULL DEFAULT 0,
    cost_source TEXT NOT NULL DEFAULT 'none',
    error TEXT
  );
  CREATE INDEX idx_usage_created ON usage(created_at);
  CREATE INDEX idx_usage_root ON usage(root_id);
  CREATE INDEX idx_usage_session ON usage(session_id);

  CREATE TABLE prompts (
    message_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    root_id TEXT NOT NULL,
    directory TEXT NOT NULL DEFAULT '',
    provider_id TEXT NOT NULL DEFAULT '',
    model_id TEXT NOT NULL DEFAULT '',
    agent TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    preview TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX idx_prompts_created ON prompts(created_at);
  CREATE INDEX idx_prompts_root ON prompts(root_id);

  CREATE TABLE conversations (
    session_id TEXT PRIMARY KEY,
    directory TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    title_manual INTEGER NOT NULL DEFAULT 0,
    category TEXT NOT NULL DEFAULT 'other',
    tags TEXT NOT NULL DEFAULT '[]',
    summary TEXT NOT NULL DEFAULT '',
    classified_by TEXT NOT NULL DEFAULT 'none',
    confidence REAL,
    classified_at INTEGER,
    prompts_at_classification INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    prompt_count INTEGER NOT NULL DEFAULT 0,
    message_count INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0,
    models TEXT NOT NULL DEFAULT '[]',
    tools TEXT NOT NULL DEFAULT '{}',
    files TEXT NOT NULL DEFAULT '[]',
    additions INTEGER NOT NULL DEFAULT 0,
    deletions INTEGER NOT NULL DEFAULT 0,
    archive_path TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    deleted_in_opencode INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_conv_category ON conversations(category);
  CREATE INDEX idx_conv_updated ON conversations(updated_at);

  CREATE VIRTUAL TABLE conversations_fts USING fts5(
    session_id UNINDEXED,
    title,
    summary,
    tags,
    transcript,
    tokenize = 'unicode61 remove_diacritics 2'
  );

  CREATE TABLE budget_alerts (
    month TEXT NOT NULL,
    threshold INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (month, threshold)
  );

  CREATE TABLE quota_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    taken_at INTEGER NOT NULL,
    plan TEXT,
    entitlement REAL,
    remaining REAL,
    percent_remaining REAL,
    unlimited INTEGER NOT NULL DEFAULT 0,
    overage_count REAL
  );
  `,
];

function configure(db: DatabaseSync): DatabaseSync {
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

export function openDb(dataDir: string): DatabaseSync {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "cockpit.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  return configure(db);
}

export function openMemoryDb(): DatabaseSync {
  return configure(new DatabaseSync(":memory:"));
}

function migrate(db: DatabaseSync): void {
  const { user_version: current } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let version = current; version < MIGRATIONS.length; version++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[version] ?? "");
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** node:sqlite refuse `undefined` : on le convertit en NULL. */
export function params(values: Record<string, SqlValue | undefined | boolean>): Record<string, SqlValue> {
  const out: Record<string, SqlValue> = {};
  for (const [key, value] of Object.entries(values)) {
    out[key] = value === undefined ? null : typeof value === "boolean" ? (value ? 1 : 0) : value;
  }
  return out;
}
