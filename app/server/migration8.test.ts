// Migration 8 (paquet L28d, itération 3) : table revoir_consignes des consignes gardées localement (U2, D-3d-30) et entrées 6 et 7
// RÉSERVÉES VIDES (A2, A2 bis, D-3d-23). La boucle migrate de db.ts est positionnelle : chaque branche du chantier 1.1 remplit SON
// numéro et laisse les numéros réservés inférieurs en commentaire SQL seul, pour que la 8 garde son numéro quel que soit l'ordre
// des fusions. La 8 n'est donc faite que d'ajouts et ne cite aucun objet des migrations 6 et 7 : elle s'applique aussi bien après
// les vraies 6 et 7 (grande fusion) qu'après deux entrées vides (cette branche).
// SEUL test qui vérifie le NOMBRE d'entrées (règle unique du §2.7 : partout ailleurs, user_version === MIGRATIONS.length pour une
// base neuve ou migrée jusqu'au bout, >= N quand le test ne vise qu'une migration donnée, jamais un nombre écrit).
// Montées vérifiées : depuis 5, 6 et 7 (bases de branche), et depuis une base d'une version publiée (1.0.4, 4 migrations).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { MIGRATIONS, openDb, openMemoryDb, transaction } from "./db.ts";

/** Numéro de la migration des consignes ; son indice dans MIGRATIONS est ce numéro moins un. */
const MIGRATION_CONSIGNES = 8;
/** Migrations d'une base réelle de la 1.0.4 (croisements-it1-v1.test.ts). */
const PUBLIEE_1_0_4 = 4;

const userVersion = (db: DatabaseSync): number => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;

/** Base d'une version donnée : les `version` premières migrations appliquées comme migrate(), en WAL comme openDb (migration5). */
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

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-m8-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Instructions d'une entrée, commentaires SQL retirés et espaces réduits ; une entrée vide n'en a aucune. */
const instructions = (sql: string): string[] =>
  sql
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);

/** Lignes témoins écrites avant la montée : elles doivent survivre intactes. */
function insertTemoins(db: DatabaseSync): void {
  db.prepare("INSERT INTO sessions (id, parent_id, root_id, directory, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "ses_m8_racine",
    null,
    "ses_m8_racine",
    "/workspace",
    "Racine témoin",
    10,
    10,
  );
  db.prepare("INSERT INTO prompts (message_id, session_id, root_id, created_at, preview) VALUES (?, ?, ?, ?, ?)").run("msg_m8", "ses_m8_racine", "ses_m8_racine", 10, "");
}

function assertTemoinsIntacts(db: DatabaseSync): void {
  assert.deepEqual({ ...(db.prepare("SELECT id, root_id, title FROM sessions WHERE id = 'ses_m8_racine'").get() as object) }, {
    id: "ses_m8_racine",
    root_id: "ses_m8_racine",
    title: "Racine témoin",
  });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM prompts WHERE message_id = 'msg_m8'").get() as { n: number }).n, 1);
}

/** Colonnes d'une table : nom, NOT NULL, valeur par défaut, place dans la clé primaire. */
const colonnes = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number; dflt_value: string | null; pk: number }>).map((c) => [
    c.name,
    c.notnull,
    c.dflt_value,
    c.pk,
  ]);

describe("migration 8 : place dans le tableau (numéros réservés, A2)", () => {
  it("MIGRATIONS a huit entrées après la grande fusion de la 3D : 1 à 5, vraie 6 de la salle, 7 réservée vide, 8 en dernier", () => {
    assert.equal(MIGRATIONS.length, MIGRATION_CONSIGNES);
    const huit = MIGRATIONS[MIGRATION_CONSIGNES - 1] ?? "";
    assert.match(huit, /CREATE TABLE revoir_consignes/);
    // Grande fusion (GF2, A2 bis) : la vraie migration 6 de la salle a REMPLACÉ l'entrée 6 réservée vide, à son rang
    // (plan it5 §8.5) ; jamais deux entrées au même rang, et la table de la salle n'apparaît dans aucune autre entrée.
    const six = MIGRATIONS[5] ?? "";
    assert.match(six, /CREATE TABLE omo_rooms/, "entrée 6 : la vraie migration de la salle");
    assert.equal(MIGRATIONS.filter((entree) => /CREATE TABLE omo_rooms/.test(entree)).length, 1, "une seule entrée crée omo_rooms");
    // Entrée 7 : un commentaire seul, aucune instruction une fois les commentaires retirés.
    for (const numero of [7]) {
      const entree = MIGRATIONS[numero - 1] ?? "";
      assert.deepEqual(instructions(entree), [], `entrée ${numero}`);
      assert.match(entree, /^\s*--[^\n]*\s*$/, `entrée ${numero} : un commentaire seul`);
      assert.match(entree, /vide sur cette branche \(A2\)/, `entrée ${numero} : raison écrite`);
    }
  });

  it("la 8 n'est faite que de CREATE TABLE et CREATE INDEX, et ne cite que revoir_consignes", () => {
    const huit = MIGRATIONS[MIGRATION_CONSIGNES - 1] ?? "";
    const lignes = instructions(huit);
    assert.equal(lignes.length, 2);
    for (const ligne of lignes) assert.match(ligne, /^(CREATE TABLE \w+ \(|CREATE INDEX \w+ ON \w+\()/, ligne);
    // Aucun objet des migrations 6 et 7 (ni d'ailleurs) : la 8 s'applique même quand une entrée réservée est vide.
    const objets = [...huit.replace(/--[^\n]*/g, "").matchAll(/(?:CREATE TABLE|CREATE INDEX|ALTER TABLE|INSERT INTO|UPDATE|DELETE FROM|REFERENCES|\bON)\s+(\w+)/g)].map(
      (m) => m[1],
    );
    assert.deepEqual([...new Set(objets)].sort(), ["idx_revoir_consignes_root", "revoir_consignes"]);
    assert.equal(/\b(ALTER|DROP|INSERT|UPDATE|DELETE)\b/.test(huit.replace(/--[^\n]*/g, "")), false, "ajouts seuls");
  });

  it("empreintes des migrations 1 à 4 inchangées : une entrée publiée n'est jamais réécrite", () => {
    const sha = (text: string) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
    assert.deepEqual(MIGRATIONS.slice(0, 4).map(sha), [
      "a1d7eaedb12c421d178eb96096bf74f230ffcecf86bc022365ccf66625de77ab",
      "7968115c721d3187feb562f449ea4443034917ca093cce155fac96626983da7e",
      "07fd367363ef2a302a0957df760efa9c20e98cce6247c79861a394915fad622c",
      "3e1298b2cea03ce723d9839aafee8da136c55c9972eabfb97c767f05524f2ed3",
    ]);
  });
});

describe("migration 8 : schéma de revoir_consignes", () => {
  it("base neuve : table, colonnes, unicité (parent_session_id, call_id) et index (root_id, call_id)", () => {
    const db = openMemoryDb();
    try {
      assert.equal(userVersion(db), MIGRATIONS.length);
      assert.deepEqual(colonnes(db, "revoir_consignes"), [
        ["id", 0, null, 1],
        ["root_id", 1, null, 0],
        ["parent_session_id", 1, null, 0],
        ["enfant_session_id", 0, null, 0],
        ["call_id", 1, null, 0],
        ["texte", 1, null, 0],
        ["longueur", 1, null, 0],
        ["tronque", 1, "0", 0],
        ["at", 1, null, 0],
      ]);
      const index = (db.prepare("PRAGMA index_info(idx_revoir_consignes_root)").all() as Array<{ name: string }>).map((c) => c.name);
      assert.deepEqual(index, ["root_id", "call_id"]);
      const insert = db.prepare("INSERT INTO revoir_consignes (root_id, parent_session_id, enfant_session_id, call_id, texte, longueur, at) VALUES (?, ?, ?, ?, ?, ?, ?)");
      insert.run("r", "p", "e", "call_1", "[synthétique] consigne", 22, 1);
      // Unicité (parent_session_id, call_id) : le même appel n'est jamais gardé deux fois.
      assert.throws(() => insert.run("r", "p", "e2", "call_1", "[synthétique] autre", 19, 2));
      insert.run("r", "p2", "e", "call_1", "[synthétique] autre parent", 26, 3);
      assert.equal((db.prepare("SELECT tronque FROM revoir_consignes WHERE parent_session_id = 'p2'").get() as { tronque: number }).tronque, 0);
    } finally {
      db.close();
    }
  });
});

describe("migration 8 : montées", () => {
  for (const depuis of [5, 6, 7]) {
    it(`base de branche en version ${depuis} : montée en ${MIGRATION_CONSIGNES}, lignes existantes intactes, réouverture sans rien à migrer`, () =>
      withTempDir((dir) => {
        const vieille = createDbAtVersion(dir, depuis);
        assert.equal(userVersion(vieille), depuis);
        insertTemoins(vieille);
        vieille.close();

        const db = openDb(dir);
        try {
          assert.equal(userVersion(db), MIGRATIONS.length);
          assert.equal((db.prepare("SELECT COUNT(*) AS n FROM revoir_consignes").get() as { n: number }).n, 0);
          assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_revoir_consignes_root'").get(), "index créé");
          assertTemoinsIntacts(db);
        } finally {
          db.close();
        }

        const encore = openDb(dir);
        try {
          assert.equal(userVersion(encore), MIGRATIONS.length);
        } finally {
          encore.close();
        }
      }));
  }

  it("base réelle d'une version publiée (1.0.4) : montée jusqu'à la 8, sessions gardées", () =>
    withTempDir((dir) => {
      const vieille = createDbAtVersion(dir, PUBLIEE_1_0_4);
      insertTemoins(vieille);
      vieille.close();

      const db = openDb(dir);
      try {
        assert.equal(userVersion(db), MIGRATION_CONSIGNES);
        assert.equal(userVersion(db), MIGRATIONS.length);
        assertTemoinsIntacts(db);
        assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'revoir_consignes'").get(), "table créée");
      } finally {
        db.close();
      }
    }));

  it("le SQL de la 8 s'applique SEUL sur un schéma en version 5 : aucune entrée réservée n'est nécessaire", () =>
    withTempDir((dir) => {
      const db = createDbAtVersion(dir, 5);
      try {
        assert.equal(userVersion(db), 5);
        db.exec(MIGRATIONS[MIGRATION_CONSIGNES - 1] ?? "");
        db.exec("PRAGMA user_version = 8");
        assert.equal((db.prepare("SELECT COUNT(*) AS n FROM revoir_consignes").get() as { n: number }).n, 0);
        assert.deepEqual(
          colonnes(db, "revoir_consignes").map(([nom]) => nom),
          ["id", "root_id", "parent_session_id", "enfant_session_id", "call_id", "texte", "longueur", "tronque", "at"],
        );
      } finally {
        db.close();
      }
    }));
});
