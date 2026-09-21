// Tests T3c : migration 6, NUMÉRO RÉSERVÉ À LA SALLE OMO (décision A2 du 19/09 : 7 aux équipes, 8 à la salle de contrôle et
// « Revoir », 9 à la construction ; décision A2 bis : montée positionnelle, `user_version` = nombre d'entrées de MIGRATIONS).
// Plan d'exécution 2 bis-2 ter §4.3, D-2b-42 ; spécification §3.5 l.249-271.
// Vérifié ici : ajouts SEULEMENT, montée d'une base v4 et d'une base v5 sans perte, table et index attendus, requêtes des
// versions publiées (1.0.2, 1.0.3, 1.0.4) encore valables sur une base en version 6, entrées antérieures inchangées à l'octet.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { MIGRATIONS, openDb, openMemoryDb, type SqlValue, transaction } from "./db.ts";

const userVersion = (db: DatabaseSync): number => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
const count = (db: DatabaseSync, sql: string, ...values: SqlValue[]): number => (db.prepare(sql).get(...values) as { n: number }).n;

/** Numéro de la migration de la salle (A2) : la 6, et elle seule. Les 7, 8 et 9 appartiennent à d'autres branches. */
const MIGRATION_SALLE = 6;

/** Base d'une version donnée : les `version` premières migrations appliquées comme migrate(), dans un fichier en WAL. */
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-m6-"));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

const colonnes = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number; dflt_value: string | null; pk: number }>).map((c) => [
    c.name,
    c.notnull,
    c.dflt_value,
    c.pk,
  ]);

// --- Requêtes des versions publiées (même fixture que la migration 5) -----------------------------------------------------------

interface SqlFixtureEntry {
  id: string;
  fichier: string;
  mode: "exec" | "run" | "get" | "all";
  sql: string;
  params?: SqlValue[] | Record<string, SqlValue>;
}

const FIXTURE = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "test-support", "fixtures", "sql-1.0.4.json"), "utf8")) as {
  versions: string[];
  migrations: number;
  requetes: SqlFixtureEntry[];
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

describe("migration 6 (Salle OMO) : schéma", () => {
  it("D-2b-42 : openMemoryDb atteint user_version 6 = MIGRATIONS.length ; omo_rooms, omo_room_starts.start_id et son index", () => {
    const db = openMemoryDb();
    // Règle d'assertion unique (A2 bis) : la version de la base est le nombre d'entrées du tableau, jamais un compte à part.
    assert.equal(MIGRATIONS.length, MIGRATION_SALLE);
    assert.equal(userVersion(db), MIGRATIONS.length);

    assert.deepEqual(colonnes(db, "omo_rooms"), [
      ["root_id", 0, null, 1],
      ["projet", 1, null, 0],
      ["created_at", 1, null, 0],
    ]);
    assert.deepEqual(
      colonnes(db, "omo_room_starts").find(([nom]) => nom === "start_id"),
      ["start_id", 0, null, 0],
    );
    const index = (db.prepare("PRAGMA index_info(idx_omo_room_starts_start)").all() as Array<{ name: string }>).map((c) => c.name);
    assert.deepEqual(index, ["start_id"]);
    assert.equal(
      count(db, "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_omo_room_starts_start' AND tbl_name = 'omo_room_starts'"),
      1,
    );

    // Table de la salle utilisable, clé primaire tenue : une racine ouvre au plus une salle.
    db.prepare("INSERT INTO omo_rooms (root_id, projet, created_at) VALUES (?, ?, ?)").run("ses_racine", "app", 1);
    assert.throws(() => db.prepare("INSERT INTO omo_rooms (root_id, projet, created_at) VALUES (?, ?, ?)").run("ses_racine", "autre", 2));
    assert.throws(() => db.prepare("INSERT INTO omo_rooms (root_id, projet, created_at) VALUES (?, ?, ?)").run("ses_b", null, 2));
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM omo_rooms"), 1);
    db.close();
  });

  it("la migration 6 n'est faite que d'ajouts, et les entrées antérieures sont inchangées à l'octet", () => {
    const sha = (text: string) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
    // 1 à 3 : v1.0.2 à v1.0.4 (étiquettes) ; 4 et 5 : chantier 1.1, déjà appliquées sur des bases de développement. Une entrée
    // publiée ou appliquée n'est JAMAIS réécrite (A2 bis) : la 6 ne pouvait donc que s'ajouter.
    assert.deepEqual(MIGRATIONS.slice(0, 5).map(sha), [
      "a1d7eaedb12c421d178eb96096bf74f230ffcecf86bc022365ccf66625de77ab",
      "7968115c721d3187feb562f449ea4443034917ca093cce155fac96626983da7e",
      "07fd367363ef2a302a0957df760efa9c20e98cce6247c79861a394915fad622c",
      "3e1298b2cea03ce723d9839aafee8da136c55c9972eabfb97c767f05524f2ed3",
      "6e04138727161b1e4e5437d72f010ca9fe217b5fafc3cf0d4116e36bb4a238f6",
    ]);
    const statements = (MIGRATIONS[MIGRATION_SALLE - 1] ?? "")
      .replace(/--[^\n]*/g, "")
      .split(";")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    assert.equal(statements.length, 3);
    for (const statement of statements) {
      assert.match(statement, /^(CREATE TABLE \w+ \(|CREATE INDEX \w+ ON \w+\(|ALTER TABLE \w+ ADD COLUMN \w+ )/, statement);
    }
    // Aucun numéro réservé à une autre branche n'est posé ici (A2).
    assert.equal(MIGRATIONS.length, MIGRATION_SALLE);
  });
});

describe("migration 6 : bases existantes", () => {
  for (const from of [4, 5]) {
    it(`base réelle en version ${from} (fichier, WAL) : migre en 6 sans perte, start_id vide`, () =>
      withTempDir((dir) => {
        const old = createDbAtVersion(dir, from);
        assert.equal(userVersion(old), from);
        for (const id of ["sessions.upsert.racine", "sessions.upsert.enfant", "ledger.recordAssistant", "ledger.recordUser"]) {
          const entry = FIXTURE.requetes.find((e) => e.id === id);
          assert.ok(entry, `requête ${id} absente de la fixture`);
          runEntry(old, entry);
        }
        if (from === 5) {
          old
            .prepare("INSERT INTO omo_room_starts (started_at, image_id, manifest_sha256, precheck, cause) VALUES (?, ?, ?, ?, ?)")
            .run(1, "sha256:image", "sha256:manifeste", "[]", "vous");
        }
        old.close();

        const db = openDb(dir);
        try {
          assert.equal(userVersion(db), MIGRATIONS.length);
          assert.equal(count(db, "SELECT COUNT(*) AS n FROM omo_rooms"), 0);
          assert.equal(count(db, "SELECT COUNT(*) AS n FROM omo_room_starts"), from === 5 ? 1 : 0);
          if (from === 5) {
            // Ligne écrite avant la migration : gardée telle quelle, la colonne ajoutée est vide.
            assert.deepEqual({ ...(db.prepare("SELECT image_id, cause, start_id FROM omo_room_starts").get() as object) }, {
              image_id: "sha256:image",
              cause: "vous",
              start_id: null,
            });
          }
          // Données des versions publiées intactes, valeurs d'office des migrations 4 et 5 gardées.
          assert.equal(count(db, "SELECT COUNT(*) AS n FROM sessions"), 2);
          assert.deepEqual({ ...(db.prepare("SELECT instance, agent FROM sessions WHERE id = 'ses_i5_enfant'").get() as object) }, {
            instance: "principale",
            agent: null,
          });
          // La salle est utilisable dès la montée, sans toucher aux tables de l'instance principale.
          db.prepare("INSERT INTO omo_rooms (root_id, projet, created_at) VALUES (?, ?, ?)").run("ses_i5_racine", "app", 7);
          db.prepare("UPDATE omo_room_starts SET start_id = ?").run("start_1");
          assert.equal(count(db, "SELECT COUNT(*) AS n FROM omo_room_starts WHERE start_id = 'start_1'"), from === 5 ? 1 : 0);
        } finally {
          db.close();
        }
        // Réouverture : rien à migrer, aucune erreur, et la salle garde ses lignes.
        const again = openDb(dir);
        assert.equal(userVersion(again), MIGRATIONS.length);
        assert.equal(count(again, "SELECT COUNT(*) AS n FROM omo_rooms"), 1);
        again.close();
      }));
  }

  it("base déjà en version 6 : la montée ne rejoue rien et ne perd aucune ligne de la salle", () =>
    withTempDir((dir) => {
      const db = openDb(dir);
      db.prepare("INSERT INTO omo_rooms (root_id, projet, created_at) VALUES (?, ?, ?)").run("ses_a", "app", 1);
      db.close();
      const again = openDb(dir);
      try {
        assert.equal(userVersion(again), MIGRATIONS.length);
        assert.equal(count(again, "SELECT COUNT(*) AS n FROM omo_rooms"), 1);
      } finally {
        again.close();
      }
    }));

  it("les requêtes des versions 1.0.2, 1.0.3 et 1.0.4 s'exécutent sans erreur sur une base en version 6", () =>
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
          // La migration 6 n'a touché à rien de ce que lisent les versions publiées.
          assert.equal(count(db, "SELECT COUNT(*) AS n FROM omo_rooms"), 0);
          assert.deepEqual({ ...(db.prepare("SELECT instance, agent FROM sessions WHERE id = 'ses_i5_enfant'").get() as object) }, {
            instance: "principale",
            agent: null,
          });
        }
      } finally {
        for (const db of bases) db.close();
      }
    }));
});
