// Migration 5 (lot L2b) : schéma, montée des bases réelles, compatibilité descendante des versions publiées (I5), purge d'une
// conversation (D-07), arbre des sessions, plancher et dépense d'une demande.
// Versions couvertes : toutes celles publiées à l'écriture du paquet (1.0.2, 1.0.3, 1.0.4). La 1.0.5 ne l'était pas : ses requêtes
// sont relevées dans la fixture au rebase (R105), avec la procédure écrite en tête de sql-1.0.4.json.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { ArchiveService } from "./archive.ts";
import type { ModelCatalog } from "./catalog.ts";
import { purgeConversation } from "./conversation-purge.ts";
import { MIGRATIONS, openDb, openMemoryDb, type SqlValue, transaction } from "./db.ts";
import { Ledger } from "./ledger.ts";
import { createLogger } from "./log.ts";
import type { OcAssistantMessage, OcSession, OpencodeClient } from "./opencode.ts";
import { type SessionRow, SessionTracker, TREE_MAX_DEPTH, TREE_MAX_SESSIONS } from "./sessions.ts";
import { SettingsStore } from "./settings.ts";

const T = Date.UTC(2026, 8, 10, 12, 0, 0);

const userVersion = (db: DatabaseSync): number => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
const count = (db: DatabaseSync, sql: string, ...values: SqlValue[]): number => (db.prepare(sql).get(...values) as { n: number }).n;

const session = (id: string, parentID?: string, extra: Partial<OcSession> = {}): OcSession => ({
  id,
  projectID: "p",
  directory: "/workspace/app",
  title: `Session ${id}`,
  time: { created: T, updated: T },
  ...(parentID ? { parentID } : {}),
  ...extra,
});

const assistant = (id: string, sessionID: string, cost: number, created: number): OcAssistantMessage => ({
  id,
  sessionID,
  role: "assistant",
  time: { created, completed: created + 500 },
  parentID: "msg_u1",
  modelID: "claude-sonnet-5",
  providerID: "github-copilot",
  mode: "build",
  agent: "build",
  cost,
  tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
});

function services(db: DatabaseSync = openMemoryDb()) {
  const settings = new SettingsStore(db);
  const ledger = new Ledger({ db, settings, catalog: { prices: new Map() } as unknown as ModelCatalog });
  const sessions = new SessionTracker(db, {} as OpencodeClient);
  return { db, settings, ledger, sessions };
}

/** Base d'une version donnée : les `version` premières migrations appliquées comme migrate(), dans un fichier en WAL comme openDb. */
function createDbAtVersion(dir: string, version: number): DatabaseSync {
  const db = new DatabaseSync(path.join(dir, "cockpit.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;");
  for (let v = 0; v < version; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v] ?? "");
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
  return db;
}

function withTempDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-m5-"));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

// --- Requêtes des versions publiées (fixture relevée hors CI) -------------------------------------------------------------------

interface SqlFixtureEntry {
  id: string;
  fichier: string;
  mode: "exec" | "run" | "get" | "all";
  sql: string;
  params?: SqlValue[] | Record<string, SqlValue>;
}

interface SqlFixture {
  versions: string[];
  migrations: number;
  requetes: SqlFixtureEntry[];
}

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "test-support", "fixtures", "sql-1.0.4.json"), "utf8"),
) as SqlFixture;

const fixtureEntry = (id: string): SqlFixtureEntry => {
  const entry = FIXTURE.requetes.find((e) => e.id === id);
  assert.ok(entry, `requête ${id} absente de la fixture`);
  return entry;
};

/** Exécute une requête de la fixture telle que la version publiée l'exécute ; l'erreur nomme la requête. */
function runEntry(db: DatabaseSync, entry: SqlFixtureEntry): void {
  try {
    if (entry.mode === "exec") {
      db.exec(entry.sql);
      return;
    }
    const statement = db.prepare(entry.sql);
    const call = statement[entry.mode] as unknown as (...values: unknown[]) => unknown;
    const values = entry.params === undefined ? [] : Array.isArray(entry.params) ? entry.params : [entry.params];
    call.apply(statement, values);
  } catch (err) {
    assert.fail(`${entry.id} (${entry.fichier}) : ${(err as Error).message}`);
  }
}

/** Référence : trackedDescendants de la 1.0 (http.ts), recopié tel quel, bornes en paramètre. */
function trackedDescendants10(db: DatabaseSync, sessionId: string, maxSessions = 200): string[] {
  const CLEANUP_MAX_DEPTH = 8;
  const CLEANUP_MAX_SESSIONS = maxSessions;
  const tree = new Set([sessionId]);
  const known = db.prepare("SELECT root_id FROM sessions WHERE id = ?").get(sessionId) as { root_id: string } | undefined;
  const rows = db
    .prepare("SELECT id, parent_id FROM sessions WHERE root_id = ? AND parent_id IS NOT NULL LIMIT ?")
    .all(known?.root_id ?? sessionId, CLEANUP_MAX_SESSIONS * 10) as Array<{ id: string; parent_id: string }>;
  const childrenOf = new Map<string, string[]>();
  for (const row of rows) {
    const list = childrenOf.get(row.parent_id);
    if (list) list.push(row.id);
    else childrenOf.set(row.parent_id, [row.id]);
  }
  let frontier = [sessionId];
  for (let depth = 0; depth < CLEANUP_MAX_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const child of childrenOf.get(id) ?? []) {
        if (tree.has(child) || tree.size >= CLEANUP_MAX_SESSIONS) continue;
        tree.add(child);
        next.push(child);
      }
    }
    frontier = next;
  }
  return [...tree].slice(1);
}

/** Lignes de sessions insérées directement (id, parent, racine), dans l'ordre donné. */
function insertTree(db: DatabaseSync, rows: Array<[id: string, parent: string | null, root: string]>): void {
  const insert = db.prepare("INSERT INTO sessions (id, parent_id, root_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)");
  transaction(db, () => {
    for (const [id, parent, root] of rows) insert.run(id, parent, root);
  });
}

describe("migration 5 : schéma", () => {
  it("T-L2b-a : openMemoryDb atteint la dernière migration ; activity_facts, son index, sessions.instance, omo_room_starts", () => {
    const db = openMemoryDb();
    // Règle d'assertion unique (décision A2 bis) : user_version = nombre d'entrées du tableau des migrations.
    assert.ok(MIGRATIONS.length >= 5);
    assert.equal(userVersion(db), MIGRATIONS.length);
    const columns = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number; dflt_value: string | null; pk: number }>).map(
        (c) => [c.name, c.notnull, c.dflt_value, c.pk],
      );
    assert.deepEqual(columns("activity_facts"), [
      ["id", 0, null, 1],
      ["root_id", 1, null, 0],
      ["session_id", 1, null, 0],
      ["kind", 1, null, 0],
      ["ref", 0, null, 0],
      ["data", 1, "'{}'", 0],
      ["at", 1, null, 0],
    ]);
    assert.deepEqual(columns("omo_room_starts"), [
      ["id", 0, null, 1],
      ["started_at", 1, null, 0],
      ["image_id", 1, null, 0],
      ["manifest_sha256", 1, null, 0],
      ["precheck", 1, null, 0],
      ["cause", 1, null, 0],
      ["ended_at", 0, null, 0],
      ["fin", 0, null, 0],
      // Ajoutée par la migration 6 : la base ouverte ici est à la dernière version.
      ["start_id", 0, null, 0],
    ]);
    assert.deepEqual(
      columns("sessions").find(([name]) => name === "instance"),
      ["instance", 1, "'principale'", 0],
    );
    const indexColumns = (db.prepare("PRAGMA index_info(idx_activity_facts_root)").all() as Array<{ name: string }>).map((c) => c.name);
    assert.deepEqual(indexColumns, ["root_id", "at"]);
    const { sessions } = services(db);
    assert.equal(sessions.upsert(session("ses_instance")).instance, "principale");
  });

  it("migrations déjà publiées ou appliquées identiques à l'octet ; la 5 n'est faite que d'ajouts", () => {
    const sha = (text: string) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
    // 1 à 3 : v1.0.2 à v1.0.4 (tags) ; 4 : chantier 1.1 (306c25c), déjà appliquée sur des bases de développement.
    assert.deepEqual(MIGRATIONS.slice(0, 4).map(sha), [
      "a1d7eaedb12c421d178eb96096bf74f230ffcecf86bc022365ccf66625de77ab",
      "7968115c721d3187feb562f449ea4443034917ca093cce155fac96626983da7e",
      "07fd367363ef2a302a0957df760efa9c20e98cce6247c79861a394915fad622c",
      "3e1298b2cea03ce723d9839aafee8da136c55c9972eabfb97c767f05524f2ed3",
    ]);
    const statements = (MIGRATIONS[4] ?? "")
      .replace(/--[^\n]*/g, "")
      .split(";")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    assert.equal(statements.length, 4);
    for (const statement of statements) {
      assert.match(statement, /^(CREATE TABLE \w+ \(|CREATE INDEX \w+ ON \w+\(|ALTER TABLE \w+ ADD COLUMN \w+ )/, statement);
    }
  });
});

describe("migration 5 : bases existantes", () => {
  for (const from of [3, 4]) {
    it(`T-L2b-b : base réelle en version ${from} (fichier, WAL) : migre en 6 sans perte, sessions en « principale »`, () =>
      withTempDir((dir) => {
        const old = createDbAtVersion(dir, from);
        assert.equal(userVersion(old), from);
        for (const id of ["sessions.upsert.racine", "sessions.upsert.enfant", "ledger.recordAssistant", "ledger.recordUser", "archive.refresh.insertion", "archive.index.insertion"]) {
          runEntry(old, fixtureEntry(id));
        }
        if (from === 4) old.prepare("UPDATE sessions SET agent = 'build', plancher = 'conversation:0a1b' WHERE id = 'ses_i5_racine'").run();
        old.close();

        const db = openDb(dir);
        try {
          assert.equal(userVersion(db), MIGRATIONS.length);
          assert.equal(count(db, "SELECT COUNT(*) AS n FROM activity_facts"), 0);
          assert.equal(count(db, "SELECT COUNT(*) AS n FROM omo_room_starts"), 0);
          const { sessions, ledger } = services(db);
          const root = sessions.get("ses_i5_racine");
          assert.equal(root?.instance, "principale");
          assert.equal(sessions.get("ses_i5_enfant")?.instance, "principale");
          assert.equal(root?.agent, from === 4 ? "build" : null);
          assert.equal(root?.plancher, from === 4 ? "conversation:0a1b" : null);
          assert.equal(ledger.sessionUsage("ses_i5_racine").cost, 0.02);
          assert.equal(count(db, "SELECT COUNT(*) AS n FROM prompts WHERE message_id = 'msg_i5_u' AND kind = 'message'"), 1);
          assert.equal(count(db, "SELECT COUNT(*) AS n FROM conversations_fts WHERE conversations_fts MATCH ?", '"demo"*'), 1);
        } finally {
          db.close();
        }
        // Réouverture : rien à migrer, aucune erreur.
        const again = openDb(dir);
        assert.equal(userVersion(again), MIGRATIONS.length);
        again.close();
      }));
  }

  it("T-L2b-c : les requêtes des versions 1.0.2, 1.0.3 et 1.0.4 s'exécutent sans erreur sur une base en version 6", () =>
    withTempDir((dir) => {
      assert.deepEqual(FIXTURE.versions, ["1.0.2", "1.0.3", "1.0.4"]);
      const migrated = createDbAtVersion(dir, 4);
      migrated.close();
      const bases = [openMemoryDb(), openDb(dir)];
      try {
        for (const db of bases) {
          // Leur boucle de migration (FIXTURE.migrations entrées) ne s'exécute pas : la base reste en version 6.
          assert.ok(userVersion(db) >= FIXTURE.migrations);
          for (const entry of FIXTURE.requetes) runEntry(db, entry);
          assert.equal(userVersion(db), MIGRATIONS.length);
          // Lignes écrites par une version publiée, relues par la 1.1 : valeurs par défaut des migrations 4 et 5.
          const { sessions, ledger } = services(db);
          assert.deepEqual(
            { ...(db.prepare("SELECT instance, agent, plancher, root_id FROM sessions WHERE id = 'ses_i5_enfant'").get() as object) },
            { instance: "principale", agent: null, plancher: null, root_id: "ses_i5_racine" },
          );
          assert.equal(sessions.get("ses_i5_racine")?.instance, "principale");
          assert.equal((db.prepare("SELECT kind FROM prompts WHERE message_id = 'msg_i5_u'").get() as { kind: string }).kind, "message");
          assert.equal((db.prepare("SELECT variant FROM usage WHERE message_id = 'msg_i5_a'").get() as { variant: null }).variant, null);
          assert.deepEqual(
            { ...(db.prepare("SELECT methods, role FROM item_meta WHERE name = 'relire-i5-bis'").get() as object) },
            { methods: "[]", role: "assistant" },
          );
          assert.ok(Math.abs(ledger.spentSince("ses_i5_racine", 0) - 0.042) < 1e-9);
          assert.equal(count(db, "SELECT COUNT(*) AS n FROM conversations"), 0);
        }
      } finally {
        for (const db of bases) db.close();
      }
    }));
});

describe("suppression d'une conversation (D-07)", () => {
  const ROOT = "ses_purge";
  const CHILD = "ses_purge_enfant";
  const GRANDCHILD = "ses_purge_petit";
  const OTHER = "ses_autre";

  async function setup() {
    const base = services();
    const { db, sessions, ledger, settings } = base;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-purge-"));
    const archive = new ArchiveService({
      db,
      client: {} as OpencodeClient,
      settings,
      ledger,
      sessions,
      archiveDir: tmp,
      opencodeWorkspaceDir: "/workspace",
      log: createLogger("error"),
    });
    sessions.upsert(session(ROOT));
    // Petite-fille enregistrée avant sa mère : racine provisoire CHILD, rattachée ensuite.
    sessions.upsert(session(GRANDCHILD, CHILD));
    db.prepare("INSERT INTO activity_facts (root_id, session_id, kind, ref, data, at) VALUES (?, ?, 'statut', NULL, '{}', ?)").run(CHILD, GRANDCHILD, T);
    db.prepare(
      `INSERT INTO autonomy_decisions (root_id, session_id, permission, resume, choix, regle, rules_version, verdict, par, raison, asked_at)
       VALUES (?, ?, 'bash', 'curl --data @notes.txt', 'autonome', 'S4', 1, 'attente', 'regles', 'programme inconnu', ?)`,
    ).run(CHILD, GRANDCHILD, T);
    sessions.upsert(session(CHILD, ROOT));
    assert.equal(sessions.rootOf(GRANDCHILD), ROOT);
    sessions.upsert(session(OTHER));

    for (const id of [ROOT, OTHER]) {
      db.prepare("INSERT INTO conversations (session_id, directory, title, classified_by, created_at, updated_at) VALUES (?, '/workspace/app', 'Titre', 'llm', ?, ?)").run(id, T, T);
      db.prepare(
        `INSERT INTO team_runs (id, team_titre, flow, flow_sha256, estimate_sha256, root_session_id, directory, state, cost, precisions, created_at)
         VALUES (?, 'Revue', '{}', 'flow-sha', 'estimation-sha', ?, '/workspace/app', 'terminee', 0.5, '["précision confidentielle"]', ?)`,
      ).run(`run_${id}`, id, T);
      db.prepare(
        `INSERT INTO team_run_steps (run_id, step_id, ordre, bloc_index, titre, agent, floor_sha256, message_sha256, message_text, result_excerpt, verdict, state, cost)
         VALUES (?, 'e1', 1, 0, 'Lecture', 'relire-script', 'plancher-sha', 'message-sha', 'texte exact envoyé', 'extrait du résultat', 'ok', 'terminee', 0.2)`,
      ).run(`run_${id}`);
      db.prepare(
        `INSERT INTO autonomy_decisions (root_id, session_id, permission, resume, choix, regle, rules_version, verdict, par, raison, ia_cost, relais, asked_at)
         VALUES (?, ?, 'edit', 'modifie notes.md', 'autonome', 'E1', 1, 'auto', 'ia-controle', 'dans le dossier', 0.01, 'ok', ?)`,
      ).run(id, id, T);
      db.prepare("INSERT INTO activity_facts (root_id, session_id, kind, ref, data, at) VALUES (?, ?, 'attente', 'per_1', '{\"etat\":\"attente\"}', ?)").run(id, id, T);
      db.prepare(
        "INSERT INTO delegations (root_id, parent_session_id, call_id, agent, source, state, created_at) VALUES (?, ?, 'call_1', 'general', 'ia', 'terminee', ?)",
      ).run(id, id, T);
      db.prepare("INSERT INTO permission_waits (permission_id, session_id, root_id, permission, asked_at, reply, replied_by) VALUES (?, ?, ?, 'bash', ?, 'once', 'vous')").run(
        `per_${id}`,
        id,
        id,
        T,
      );
      ledger.recordAssistant(assistant(`msg_${id}`, id, 0.3, T + 1_000), sessions.get(id) as SessionRow);
    }
    const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
    return { ...base, archive, cleanup };
  }

  const texts = (db: DatabaseSync, root: string) => ({
    steps: db
      .prepare("SELECT message_text, result_excerpt, message_sha256, floor_sha256, verdict, state, cost FROM team_run_steps WHERE run_id = ?")
      .all(`run_${root}`)
      .map((r) => ({ ...r })),
    runs: db
      .prepare("SELECT precisions, flow_sha256, estimate_sha256, state, cost FROM team_runs WHERE root_session_id = ?")
      .all(root)
      .map((r) => ({ ...r })),
    decisions: db
      .prepare("SELECT resume, raison, regle, verdict, par, ia_cost, relais FROM autonomy_decisions WHERE root_id = ? ORDER BY id")
      .all(root)
      .map((r) => ({ ...r })),
  });

  it("T-L2b-d : archive.remove vide les textes, supprime les faits de tout l'arbre, garde empreintes, coûts et états", async () => {
    const { db, archive, ledger, cleanup } = await setup();
    try {
      const otherBefore = texts(db, OTHER);
      const workBefore = db.prepare("SELECT root_id, state FROM delegations UNION ALL SELECT root_id, reply FROM permission_waits").all().map((r) => ({ ...r }));
      assert.equal(await archive.remove(ROOT), true);

      assert.deepEqual(texts(db, ROOT), {
        steps: [{ message_text: null, result_excerpt: null, message_sha256: "message-sha", floor_sha256: "plancher-sha", verdict: "ok", state: "terminee", cost: 0.2 }],
        runs: [{ precisions: "[]", flow_sha256: "flow-sha", estimate_sha256: "estimation-sha", state: "terminee", cost: 0.5 }],
        decisions: [{ resume: "", raison: "", regle: "E1", verdict: "auto", par: "ia-controle", ia_cost: 0.01, relais: "ok" }],
      });
      // Décision écrite sous la racine provisoire : purgée aussi, sans toucher à sa règle ni à son verdict.
      assert.deepEqual(
        { ...(db.prepare("SELECT resume, raison, regle, verdict FROM autonomy_decisions WHERE root_id = ?").get(CHILD) as object) },
        { resume: "", raison: "", regle: "S4", verdict: "attente" },
      );
      assert.equal(count(db, "SELECT COUNT(*) AS n FROM activity_facts WHERE root_id IN (?, ?)", ROOT, CHILD), 0);
      assert.equal(count(db, "SELECT COUNT(*) AS n FROM conversations WHERE session_id = ?", ROOT), 0);

      // Autre conversation intacte ; coûts et états de travail inchangés.
      assert.deepEqual(texts(db, OTHER), otherBefore);
      assert.equal(count(db, "SELECT COUNT(*) AS n FROM activity_facts WHERE root_id = ?", OTHER), 1);
      assert.equal(count(db, "SELECT COUNT(*) AS n FROM conversations WHERE session_id = ?", OTHER), 1);
      assert.equal(ledger.sessionUsage(ROOT).cost, 0.3);
      assert.deepEqual(db.prepare("SELECT root_id, state FROM delegations UNION ALL SELECT root_id, reply FROM permission_waits").all().map((r) => ({ ...r })), workBefore);
    } finally {
      cleanup();
    }
  });

  it("point unique : ni la suppression dans opencode ni une archive inconnue ne purgent (Déroulé gardé aux Archives)", async () => {
    const { db, archive, sessions, cleanup } = await setup();
    try {
      const before = texts(db, ROOT);
      sessions.markDeleted(ROOT);
      archive.markDeletedInOpencode(ROOT);
      assert.equal(await archive.remove("ses_inconnue"), false);
      assert.deepEqual(texts(db, ROOT), before);
      assert.equal(count(db, "SELECT COUNT(*) AS n FROM activity_facts WHERE root_id IN (?, ?)", ROOT, CHILD), 2);
    } finally {
      cleanup();
    }
  });

  it("archive.remove est atomique : un refus de la suppression laisse les textes et les faits en place", async () => {
    const { db, archive, cleanup } = await setup();
    try {
      const before = texts(db, ROOT);
      db.exec("CREATE TRIGGER refus_suppression BEFORE DELETE ON conversations BEGIN SELECT RAISE(ABORT, 'suppression refusée'); END;");
      await assert.rejects(archive.remove(ROOT), /suppression refusée/);
      assert.deepEqual(texts(db, ROOT), before);
      assert.equal(count(db, "SELECT COUNT(*) AS n FROM activity_facts WHERE root_id IN (?, ?)", ROOT, CHILD), 2);
      assert.equal(db.isTransaction, false);
    } finally {
      cleanup();
    }
  });

  it("purgeConversation : compte les lignes, idempotente, dans la transaction de l'appelant ou dans la sienne", async () => {
    const { db, cleanup } = await setup();
    try {
      assert.deepEqual(transaction(db, () => purgeConversation(db, ROOT)), { runs: 1, steps: 1, decisions: 2, facts: 2 });
      assert.deepEqual(purgeConversation(db, ROOT), { runs: 0, steps: 0, decisions: 0, facts: 0 });
      assert.equal(db.isTransaction, false);
      assert.equal(count(db, "SELECT COUNT(*) AS n FROM activity_facts WHERE root_id = ?", OTHER), 1);
    } finally {
      cleanup();
    }
  });
});

describe("arbre des sessions", () => {
  it("rootOf : racine, enfant rattaché, session inconnue", () => {
    const { sessions } = services();
    sessions.upsert(session("ses_r"));
    sessions.upsert(session("ses_c", "ses_r"));
    assert.equal(sessions.rootOf("ses_r"), "ses_r");
    assert.equal(sessions.rootOf("ses_c"), "ses_r");
    assert.equal(sessions.rootOf("ses_inconnue"), null);
  });

  it("descendants : ordre en largeur, depuis la racine ou une session de l'arbre, autre racine exclue", () => {
    const { db, sessions } = services();
    insertTree(db, [
      ["r", null, "r"],
      ["a", "r", "r"],
      ["b", "r", "r"],
      ["a1", "a", "r"],
      ["b1", "b", "r"],
      ["a11", "a1", "r"],
      ["x", null, "x"],
      ["x1", "x", "x"],
    ]);
    assert.deepEqual(sessions.descendants("r"), ["a", "b", "a1", "b1", "a11"]);
    assert.deepEqual(sessions.descendants("a"), ["a1", "a11"]);
    assert.deepEqual(sessions.descendants("a11"), []);
    assert.deepEqual(sessions.descendants("inconnue"), []);
    for (const id of ["r", "a", "a11", "x", "inconnue"]) assert.deepEqual(sessions.descendants(id), trackedDescendants10(db, id), id);
  });

  it("descendants : bornes de la 1.0 (profondeur 8, 200 sessions dont celle de départ, lignes lues ≤ limit × 10)", () => {
    const { db, sessions } = services();
    // Profondeur : chaîne de 12 niveaux.
    insertTree(db, Array.from({ length: 13 }, (_, i) => [`p${i}`, i === 0 ? null : `p${i - 1}`, "p0"] as [string, string | null, string]));
    assert.equal(TREE_MAX_DEPTH, 8);
    assert.deepEqual(sessions.descendants("p0"), ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"]);
    assert.deepEqual(sessions.descendants("p0"), trackedDescendants10(db, "p0"));
    // Nombre de sessions : 300 enfants directs.
    insertTree(db, [["w", null, "w"], ...Array.from({ length: 300 }, (_, i) => [`w${i}`, "w", "w"] as [string, string, string])]);
    assert.equal(TREE_MAX_SESSIONS, 200);
    assert.equal(sessions.descendants("w").length, 199);
    assert.deepEqual(sessions.descendants("w"), trackedDescendants10(db, "w"));
    // Lignes lues : 60 petits-enfants enregistrés avant les enfants ; limit 5 → 50 lignes, aucun enfant lu.
    insertTree(db, [
      ["l", null, "l"],
      ...Array.from({ length: 60 }, (_, i) => [`l${i % 6}_${i}`, `l${i % 6}`, "l"] as [string, string, string]),
      ...Array.from({ length: 6 }, (_, i) => [`l${i}`, "l", "l"] as [string, string, string]),
    ]);
    assert.deepEqual(sessions.descendants("l", 5), []);
    assert.deepEqual(sessions.descendants("l", 5), trackedDescendants10(db, "l", 5));
    assert.deepEqual(sessions.descendants("l", 7), trackedDescendants10(db, "l", 7));
    assert.equal(sessions.descendants("l", 7).length, 6);
  });

  it("descendants : égal au calcul SQL de la 1.0 sur des arbres pseudo-aléatoires (cycles, racines provisoires, bornes)", () => {
    // Générateur déterministe MINSTD (données de test, aucun usage de sécurité) : produits exacts sous 2^53.
    let seed = 20260915;
    const next = (n: number) => {
      seed = (seed * 48271) % 2147483647;
      return seed % n;
    };
    for (let round = 0; round < 25; round++) {
      const { db, sessions } = services();
      const size = 1 + next(400);
      const ids = Array.from({ length: size }, (_, i) => `s${round}_${i}`);
      const roots = [ids[0] as string, `s${round}_ailleurs`, `s${round}_provisoire`];
      const rows: Array<[string, string | null, string]> = ids.map((id, i) => {
        const kind = next(10);
        if (i === 0) return [id, null, id];
        const parent = kind === 0 ? `s${round}_absent` : kind === 1 ? id : (ids[next(size)] as string);
        return [id, parent, roots[next(10) < 8 ? 0 : next(3)] as string];
      });
      insertTree(db, rows);
      for (let probe = 0; probe < 6; probe++) {
        const start = probe === 5 ? `s${round}_inconnue` : (ids[next(size)] as string);
        const limit = probe === 0 ? TREE_MAX_SESSIONS : 1 + next(60);
        assert.deepEqual(sessions.descendants(start, limit), trackedDescendants10(db, start, limit), `tour ${round}, ${start}, limite ${limit}`);
      }
    }
  });

  it("descendants : borne invalide refusée", () => {
    const { sessions } = services();
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 10_001]) {
      assert.throws(() => sessions.descendants("ses_r", limit), RangeError, String(limit));
    }
    assert.deepEqual(sessions.descendants("ses_r", 10_000), []);
  });

  it("setPlancher : pose, garde à la mise à jour, retire ; session inconnue ; empreinte illisible refusée sans écriture", () => {
    const { sessions } = services();
    sessions.upsert(session("ses_p"));
    const hash = createHash("sha256").update("[]").digest("hex");
    assert.equal(sessions.setPlancher("ses_p", hash), true);
    assert.equal(sessions.get("ses_p")?.plancher, hash);
    // Un événement opencode (upsert) n'efface jamais le plancher vérifié.
    sessions.upsert({ ...session("ses_p"), agent: "build", time: { created: T, updated: T + 1 } });
    assert.equal(sessions.get("ses_p")?.plancher, hash);
    assert.equal(sessions.setPlancher("ses_p", `conversation:${hash}`), true);
    for (const bad of ["", "a b", "x".repeat(129), `${hash}\n`, "empreinte-é", "a;DROP"]) {
      assert.throws(() => sessions.setPlancher("ses_p", bad), RangeError, JSON.stringify(bad));
    }
    assert.equal(sessions.get("ses_p")?.plancher, `conversation:${hash}`);
    assert.equal(sessions.setPlancher("ses_inconnue", hash), false);
    assert.equal(sessions.setPlancher("ses_p", null), true);
    assert.equal(sessions.get("ses_p")?.plancher, null);
  });
});

describe("dépense d'une demande (ledger.spentSince)", () => {
  it("tout l'arbre depuis le début de la demande : enfants, contrôle, étape, étapes d'un tour ; autre racine et avant exclus", () => {
    const { ledger, sessions } = services();
    const since = T + 10_000;
    const root = sessions.upsert(session("ses_d"));
    const child = sessions.upsert(session("ses_d_enfant", "ses_d"));
    const control = sessions.upsert(session("ses_d_controle", "ses_d", { metadata: { cockpit: "controle" } }));
    const step = sessions.upsert(session("ses_d_etape", "ses_d", { metadata: { cockpit: "equipe" } }));
    const other = sessions.upsert(session("ses_o"));
    assert.equal(control.purpose, "controle");
    assert.equal(step.purpose, "equipe");

    ledger.recordAssistant(assistant("msg_avant", "ses_d", 0.5, since - 1), root);
    ledger.recordAssistant(assistant("msg_borne", "ses_d", 0.1, since), root);
    ledger.recordAssistant(assistant("msg_enfant", "ses_d_enfant", 0.2, since + 1_000), child);
    ledger.recordAssistant(assistant("msg_controle", "ses_d_controle", 0.01, since + 2_000), control);
    // Un tour à plusieurs outils : un message par étape, chacun publié deux fois (mesure MX1 §7).
    for (const [id, cost, at] of [["msg_etape_1", 0.03, since + 3_000], ["msg_etape_2", 0.04, since + 4_000]] as const) {
      ledger.recordAssistant(assistant(id, "ses_d_etape", cost, at), step);
      ledger.recordAssistant(assistant(id, "ses_d_etape", cost, at), step);
    }
    ledger.recordAssistant(assistant("msg_autre", "ses_o", 7, since + 1_000), other);
    // Descendant enregistré avant son parent : compté une fois rattaché à la vraie racine.
    const early = sessions.upsert(session("ses_d_tardif", "ses_d_mere"));
    ledger.recordAssistant(assistant("msg_tardif", "ses_d_tardif", 0.05, since + 5_000), early);
    const before = ledger.spentSince("ses_d", since);
    sessions.upsert(session("ses_d_mere", "ses_d"));

    const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);
    near(before, 0.38);
    near(ledger.spentSince("ses_d", since), 0.43);
    near(ledger.spentSince("ses_d", since + 1), 0.33);
    near(ledger.spentSince("ses_d", since - 1), 0.93);
    near(ledger.spentSince("ses_o", since), 7);
    assert.equal(ledger.spentSince("ses_d", since + 60_000), 0);
    assert.equal(ledger.spentSince("ses_inconnue", 0), 0);
    near(ledger.spentSince("ses_d", 0), ledger.sessionUsage("ses_d").cost);
  });

  it("début de demande illisible : erreur, jamais 0", () => {
    const { ledger } = services();
    for (const since of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.throws(() => ledger.spentSince("ses_d", since), RangeError, String(since));
    }
  });
});
