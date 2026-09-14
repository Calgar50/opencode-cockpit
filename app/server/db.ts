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
  // 1.1 : équipes, travail délégué, attentes d'accord, autonomie à la demande ; IA et réflexion par appel, genre de demande.
  // Ajouts seulement : une version antérieure rouvre cette base (sa boucle de migration s'arrête à son propre nombre).
  `
  CREATE TABLE teams (
    id TEXT PRIMARY KEY,
    titre TEXT NOT NULL,
    description TEXT NOT NULL,
    flow TEXT NOT NULL,                      -- JSON Flow v1
    origine TEXT NOT NULL,                   -- exemple|creee|dupliquee
    exemple_id TEXT,
    exemple_version INTEGER,
    avance INTEGER NOT NULL DEFAULT 0,       -- 1 = hors de la grammaire du mode Simple
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE team_runs (
    id TEXT PRIMARY KEY,
    team_id TEXT,
    team_titre TEXT NOT NULL,
    flow TEXT NOT NULL,
    flow_sha256 TEXT NOT NULL,
    estimate_sha256 TEXT,
    mode_ui TEXT,                            -- simple|avance au lancement
    root_session_id TEXT NOT NULL,
    directory TEXT NOT NULL,
    request_message_id TEXT,
    result_message_id TEXT,
    state TEXT NOT NULL,                     -- preparation|en-cours|attente-verification|attente-choix|attente-budget|terminee|arretee|echec|interrompue|plafond
    cause TEXT,
    facultatifs TEXT NOT NULL DEFAULT '[]',
    estimate_typique REAL,
    estimate_max REAL,
    plafond REAL,
    cost REAL NOT NULL DEFAULT 0,
    confirmations TEXT NOT NULL DEFAULT '{}',
    precisions TEXT NOT NULL DEFAULT '[]',   -- vidé à la suppression de la conversation
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    ended_at INTEGER
  );
  CREATE INDEX idx_team_runs_root ON team_runs(root_session_id, created_at);
  CREATE INDEX idx_team_runs_state ON team_runs(state);

  CREATE TABLE team_run_steps (
    run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
    step_id TEXT NOT NULL,
    tour INTEGER NOT NULL DEFAULT 1,
    tentative INTEGER NOT NULL DEFAULT 1,
    ordre INTEGER NOT NULL,
    bloc_index INTEGER NOT NULL,
    titre TEXT NOT NULL,
    agent TEXT NOT NULL,
    agent_file_sha256 TEXT,
    rules_sha256 TEXT,
    floor_sha256 TEXT,
    rights TEXT,
    right_lines TEXT,
    model TEXT,
    variant TEXT,
    steps INTEGER,
    session_id TEXT,
    state TEXT NOT NULL,
    cause TEXT,
    tronquee INTEGER NOT NULL DEFAULT 0,
    message_sha256 TEXT,
    message_text TEXT,                       -- texte exact envoyé ; vidé à la suppression de la conversation
    correction_sha256 TEXT,
    result_excerpt TEXT,                     -- vidé à la suppression de la conversation
    verdict TEXT,
    choix TEXT,
    queued_at INTEGER,
    started_at INTEGER,
    ended_at INTEGER,
    cost REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (run_id, step_id, tour, tentative)
  );
  CREATE INDEX idx_team_run_steps_session ON team_run_steps(session_id);
  CREATE INDEX idx_team_run_steps_agent ON team_run_steps(agent, model, ended_at);

  CREATE TABLE team_run_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES team_runs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    par TEXT NOT NULL,                       -- vous|cockpit
    data TEXT NOT NULL DEFAULT '{}',
    at INTEGER NOT NULL
  );
  CREATE INDEX idx_team_run_events_run ON team_run_events(run_id, at);

  CREATE TABLE delegations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    root_id TEXT NOT NULL,
    parent_session_id TEXT NOT NULL,
    child_session_id TEXT,
    call_id TEXT NOT NULL,
    agent TEXT NOT NULL,
    command TEXT,
    source TEXT NOT NULL,                    -- ia|raccourci
    sans_confirmation INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL,                     -- prepare|attente-accord|autorisee|travaille|terminee|arretee|jamais-demarree|refusee|expiree
    permission_id TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    ended_at INTEGER,
    UNIQUE (parent_session_id, call_id)
  );
  CREATE INDEX idx_delegations_root ON delegations(root_id, created_at);

  CREATE TABLE permission_waits (
    permission_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    root_id TEXT NOT NULL,
    permission TEXT NOT NULL,
    target TEXT,
    asked_at INTEGER NOT NULL,
    replied_at INTEGER,
    reply TEXT,                              -- once|reject|expiree
    replied_by TEXT                          -- vous|cockpit|controle
  );
  CREATE INDEX idx_permission_waits_root ON permission_waits(root_id, asked_at);

  CREATE TABLE conversation_autonomy (
    root_id TEXT PRIMARY KEY,
    choix TEXT NOT NULL,                     -- demander|modifications|plan|autonome
    plafonds TEXT NOT NULL DEFAULT '{}',
    depuis INTEGER NOT NULL,
    retour_cause TEXT,
    plan_source_id TEXT,
    execution_de_plan_id TEXT
  );

  CREATE TABLE autonomy_requests (
    id TEXT PRIMARY KEY,
    root_id TEXT NOT NULL,
    prompt_message_id TEXT,
    choix TEXT NOT NULL,
    plafonds TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    spent REAL NOT NULL DEFAULT 0,
    auto INTEGER NOT NULL DEFAULT 0,
    attentes INTEGER NOT NULL DEFAULT 0,
    refus INTEGER NOT NULL DEFAULT 0,
    controles INTEGER NOT NULL DEFAULT 0,
    fichiers INTEGER NOT NULL DEFAULT 0,
    delegations INTEGER NOT NULL DEFAULT 0,
    fin TEXT                                 -- terminee|plafond-cout|plafond-actions|plafond-duree|plafond-fichiers|vous|non-controle|rechargement|redemarrage-cockpit
  );
  CREATE INDEX idx_autonomy_requests_root ON autonomy_requests(root_id, started_at);

  CREATE TABLE autonomy_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT,
    root_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    permission_id TEXT,
    permission TEXT NOT NULL,
    resume TEXT NOT NULL DEFAULT '',         -- vidé à la suppression de la conversation
    choix TEXT NOT NULL,
    regle TEXT NOT NULL,
    rules_version INTEGER NOT NULL,
    verdict TEXT NOT NULL,                   -- auto|attente|refus-auto|non-controle
    par TEXT NOT NULL,                       -- regles|ia-controle|vous|cockpit
    raison TEXT NOT NULL DEFAULT '',         -- vidé à la suppression de la conversation
    ia_model TEXT,
    ia_cost REAL,
    ia_ms INTEGER,
    relais TEXT,                             -- ok|deja-repondu|expiree|echec
    asked_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE INDEX idx_autonomy_decisions_root ON autonomy_decisions(root_id, asked_at);

  ALTER TABLE sessions ADD COLUMN agent TEXT;
  ALTER TABLE sessions ADD COLUMN plancher TEXT;
  ALTER TABLE usage ADD COLUMN variant TEXT;
  ALTER TABLE prompts ADD COLUMN kind TEXT NOT NULL DEFAULT 'message';  -- message|equipe-demande|equipe-resultat
  ALTER TABLE item_meta ADD COLUMN methods TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE item_meta ADD COLUMN role TEXT NOT NULL DEFAULT 'assistant';
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
