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
  // 0.2.0 : métadonnées des assistants et IA réellement choisies par tour de chat.
  `
  CREATE TABLE item_meta (
    kind TEXT NOT NULL,                  -- 'agents' | 'commands'
    name TEXT NOT NULL,
    title TEXT,                          -- titre d'assistant (NULL = pas un assistant)
    use_case TEXT,                       -- analyser|relire|rediger|expliquer|autre
    icon TEXT,
    tier TEXT,                           -- rapide|equilibre|expert|NULL (IA précise ou aucune)
    rights TEXT,                         -- lecture|propose|personnalise (recalculé à la lecture)
    task_size TEXT,                      -- S|M|L
    examples TEXT NOT NULL DEFAULT '[]', -- JSON, 3 × 200 caractères au plus
    origin TEXT NOT NULL,                -- assistant|catalogue|adopte|studio
    catalog_id TEXT,
    catalog_version INTEGER,
    applied_model TEXT,
    applied_variant TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (kind, name)
  );

  CREATE TABLE chat_turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    kind TEXT NOT NULL,                  -- message|raccourci|resume
    agent TEXT NOT NULL DEFAULT '',
    command TEXT,
    tier TEXT,
    model TEXT,
    variant TEXT,
    runs TEXT NOT NULL DEFAULT '[]'      -- JSON Run[]
  );
  CREATE INDEX idx_chat_turns_session ON chat_turns(session_id, created_at);
  `,
  // 1.0.0 : début des demandes (280 caractères, non masqué) jamais relu ni supprimé avec la conversation : effacé.
  `
  UPDATE prompts SET preview = '' WHERE preview != '';
  `,
];

/** Ligne de la table item_meta (migration 2). */
export interface ItemMetaRow {
  kind: "agents" | "commands";
  name: string;
  title: string | null;
  use_case: string | null;
  icon: string | null;
  tier: string | null;
  rights: string | null;
  task_size: string | null;
  /** JSON string[] */
  examples: string;
  origin: "assistant" | "catalogue" | "adopte" | "studio";
  catalog_id: string | null;
  catalog_version: number | null;
  applied_model: string | null;
  applied_variant: string | null;
  created_at: number;
  updated_at: number;
}

/** Ligne de la table chat_turns (migration 2). */
export interface ChatTurnRow {
  id: number;
  session_id: string;
  created_at: number;
  kind: "message" | "raccourci" | "resume";
  agent: string;
  command: string | null;
  tier: string | null;
  model: string | null;
  variant: string | null;
  /** JSON Run[] */
  runs: string;
}

function configure(db: DatabaseSync): DatabaseSync {
  // secure_delete : le contenu effacé (conversations supprimées, anciens débuts de demandes) est écrasé dans le fichier.
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;");
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
