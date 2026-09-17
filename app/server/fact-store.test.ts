// Magasin de faits et écrivain unique (spécification §3.5, §3.10 point 6, P12 ; plan d'exécution, fiche L4b) : append et since,
// aucun texte dans data (tout ou rien), borne de 20 000 faits par racine puis « Déroulé partiel », purge (L2b), transitions des
// délégations et des attentes d'accord (activity-types.ts : un état final ne régresse jamais), identité complétée sans rien
// remplacer, « sans confirmation » jamais avec une demande connue, validation, et aucun autre écrivain des deux tables.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { DelegationUpsert, WaitUpsert } from "./contracts-11.ts";
import { purgeConversation } from "./conversation-purge.ts";
import { openMemoryDb, transaction } from "./db.ts";
import { createFactStore, FACTS_PER_ROOT_MAX, neutralFacts, PARTIAL_FACT_ETAT } from "./fact-store.ts";
import { EventHub } from "./hub.ts";
import type { ActivityFact, DelegationState, WaitState } from "./shared/activity-types.ts";

const ROOT = "ses_racine";
const CHILD = "ses_enfant";
const OTHER = "ses_autre";
const SERVER_DIR = import.meta.dirname;

function setup() {
  const db = openMemoryDb();
  const hub = new EventHub();
  const events: Array<{ type: string; data: unknown }> = [];
  hub.subscribe((event) => {
    if (event.kind === "cockpit") events.push({ type: event.type, data: event.data });
  });
  const clock = { now: 1_000 };
  const facts = createFactStore({ db, hub, now: () => clock.now });
  return { db, hub, events, clock, facts };
}

const fact = (over: Partial<ActivityFact> = {}): ActivityFact => ({ rootId: ROOT, sessionId: ROOT, kind: "statut", ref: null, data: { etat: "occupee" }, at: 10, ...over });

const count = (db: ReturnType<typeof openMemoryDb>, sql: string, ...args: Array<string | number>) => (db.prepare(sql).get(...args) as { n: number }).n;

/** Faits posés directement en base (préparation rapide de la borne). */
function seedFacts(db: ReturnType<typeof openMemoryDb>, rootId: string, n: number): void {
  transaction(db, () => {
    const insert = db.prepare("INSERT INTO activity_facts (root_id, session_id, kind, ref, data, at) VALUES (?, ?, 'statut', NULL, '{\"etat\":\"occupee\"}', ?)");
    for (let i = 0; i < n; i++) insert.run(rootId, rootId, i);
  });
}

describe("magasin de faits : append et since", () => {
  it("append : faits écrits dans l'ordre avec leur identifiant, un activite.fait par fait écrit ; since : depuis un instant, borne, autre racine", () => {
    const s = setup();
    s.facts.append([fact({ at: 10 }), fact({ at: 20, data: { etat: "repos" } }), fact({ at: 30, kind: "attente", ref: "per_1", data: { permission: "bash" } })]);
    const all = s.facts.since(ROOT, 0);
    assert.equal(all.partial, false);
    assert.deepEqual(
      all.facts.map((f) => [f.kind, f.ref, f.data, f.at]),
      [
        ["statut", null, { etat: "occupee" }, 10],
        ["statut", null, { etat: "repos" }, 20],
        ["attente", "per_1", { permission: "bash" }, 30],
      ],
    );
    assert.ok(all.facts.every((f) => Number.isSafeInteger(f.id)));
    assert.deepEqual(
      s.events.map((e) => [e.type, (e.data as ActivityFact).id]),
      all.facts.map((f) => ["activite.fait", f.id]),
    );
    assert.deepEqual(s.facts.since(ROOT, 20).facts.map((f) => f.at), [20, 30]);
    assert.deepEqual(s.facts.since(ROOT, 0, 1).facts.map((f) => f.at), [10]);
    assert.deepEqual(s.facts.since(OTHER, 0), { facts: [], partial: false });
    s.facts.append([]);
    assert.equal(s.events.length, 3);
  });

  it("since lit l'arbre de la conversation : un fait écrit sous une racine provisoire (session rattachée ensuite) est rendu", () => {
    const s = setup();
    s.db.prepare("INSERT INTO sessions (id, parent_id, root_id, created_at, updated_at) VALUES (?, NULL, ?, 1, 1), (?, ?, ?, 1, 1)").run(ROOT, ROOT, CHILD, ROOT, ROOT);
    s.facts.append([fact({ rootId: CHILD, sessionId: CHILD, at: 5 }), fact({ at: 6 }), fact({ rootId: OTHER, sessionId: OTHER, at: 7 })]);
    assert.deepEqual(s.facts.since(ROOT, 0).facts.map((f) => f.sessionId), [CHILD, ROOT]);
  });

  it("aucun texte dans data : un seul fait refusé et rien n'est écrit ni diffusé", () => {
    const s = setup();
    const refused: ActivityFact[] = [
      fact({ data: { etat: "Voici la consigne envoyée" } }),
      fact({ data: { jeton: `ghp_${"a".repeat(36)}` } }),
      fact({ data: { detail: { texte: "x" } } as never }),
      fact({ ref: "Réponse libre" }),
      fact({ kind: "inconnu" as never }),
      fact({ rootId: "../racine" }),
      fact({ at: -1 }),
    ];
    for (const bad of refused) {
      assert.throws(() => s.facts.append([fact({ at: 1 }), bad]), RangeError, JSON.stringify(bad));
    }
    assert.equal(count(s.db, "SELECT COUNT(*) AS n FROM activity_facts"), 0);
    assert.deepEqual(s.events, []);
  });

  it("since : une ligne modifiée hors du magasin (texte, JSON illisible) n'est jamais rendue ; arguments invalides refusés", () => {
    const s = setup();
    s.facts.append([fact({ at: 1 })]);
    const insert = s.db.prepare("INSERT INTO activity_facts (root_id, session_id, kind, ref, data, at) VALUES (?, ?, 'statut', NULL, ?, 2)");
    insert.run(ROOT, ROOT, JSON.stringify({ etat: "texte avec des espaces" }));
    insert.run(ROOT, ROOT, "{illisible");
    assert.deepEqual(s.facts.since(ROOT, 0).facts.map((f) => f.at), [1]);
    assert.throws(() => s.facts.since("ses racine", 0), RangeError);
    for (const from of [-1, 1.5, Number.NaN]) assert.throws(() => s.facts.since(ROOT, from), RangeError, String(from));
    for (const limit of [0, FACTS_PER_ROOT_MAX + 1, 2.5]) assert.throws(() => s.facts.since(ROOT, 0, limit), RangeError, String(limit));
  });

  it("port neutre (module non installé) : rien n'est écrit", () => {
    const s = setup();
    const neutral = neutralFacts();
    neutral.append([fact()]);
    assert.equal(neutral.work.markDelegation({ rootId: ROOT, parentSessionId: ROOT, callId: "call_1", agent: "" }, "prepare", null), false);
    assert.equal(count(s.db, "SELECT COUNT(*) AS n FROM activity_facts"), 0);
  });
});

describe("magasin de faits : 20 000 faits par racine, puis « Déroulé partiel »", () => {
  it("le 20 000e fait est « Déroulé partiel » (à l'heure du premier fait non enregistré), puis plus rien ; partial ; une autre racine continue ; après redémarrage aussi", () => {
    const s = setup();
    seedFacts(s.db, ROOT, FACTS_PER_ROOT_MAX - 2);
    s.facts.append([fact({ at: 100_000 }), fact({ at: 100_001, data: { etat: "repos" } }), fact({ at: 100_002 })]);
    assert.equal(count(s.db, "SELECT COUNT(*) AS n FROM activity_facts WHERE root_id = ?", ROOT), FACTS_PER_ROOT_MAX);
    const tail = s.facts.since(ROOT, 100_000);
    assert.equal(tail.partial, true);
    assert.deepEqual(
      tail.facts.map((f) => [f.kind, f.sessionId, f.data, f.at]),
      [
        ["statut", ROOT, { etat: "occupee" }, 100_000],
        ["affichage", ROOT, { etat: PARTIAL_FACT_ETAT }, 100_001],
      ],
    );
    assert.deepEqual(
      s.events.map((e) => (e.data as ActivityFact).kind),
      ["statut", "affichage"],
    );
    s.facts.append([fact({ at: 100_003 }), fact({ rootId: OTHER, sessionId: OTHER, at: 100_004 })]);
    assert.equal(count(s.db, "SELECT COUNT(*) AS n FROM activity_facts WHERE root_id = ?", ROOT), FACTS_PER_ROOT_MAX);
    assert.equal(s.facts.since(OTHER, 0).facts.length, 1);
    assert.equal(s.facts.since(OTHER, 0).partial, false);

    // Redémarrage : un nouveau magasin relit la borne dans la base.
    const restarted = createFactStore({ db: s.db, hub: s.hub });
    restarted.append([fact({ at: 100_005 })]);
    assert.equal(count(s.db, "SELECT COUNT(*) AS n FROM activity_facts WHERE root_id = ?", ROOT), FACTS_PER_ROOT_MAX);
    assert.equal(restarted.since(ROOT, 0, 1).partial, true);
  });

  it("purge (L2b, purgeConversation) : faits supprimés, la conversation close s'enregistre de nouveau", () => {
    const s = setup();
    seedFacts(s.db, ROOT, FACTS_PER_ROOT_MAX);
    s.db.prepare("UPDATE activity_facts SET kind = 'affichage', data = ? WHERE id = (SELECT MAX(id) FROM activity_facts)").run(JSON.stringify({ etat: PARTIAL_FACT_ETAT }));
    s.facts.append([fact({ at: 1 })]);
    assert.equal(s.facts.since(ROOT, 0, 1).partial, true);
    assert.equal(purgeConversation(s.db, ROOT).facts, FACTS_PER_ROOT_MAX);
    assert.deepEqual(s.facts.since(ROOT, 0), { facts: [], partial: false });
    s.facts.append([fact({ at: 2 })]);
    assert.deepEqual(s.facts.since(ROOT, 0).facts.map((f) => f.at), [2]);
  });

  it("compte gardé en mémoire : revérifié avant de fermer la racine (une purge entre-temps ne la ferme pas trop tôt)", () => {
    const s = setup();
    seedFacts(s.db, ROOT, FACTS_PER_ROOT_MAX - 2);
    s.facts.append([fact({ at: 1 })]);
    assert.equal(purgeConversation(s.db, ROOT).facts, FACTS_PER_ROOT_MAX - 1);
    s.facts.append([fact({ at: 2 }), fact({ at: 3 })]);
    assert.equal(s.facts.since(ROOT, 0).partial, false);
    assert.deepEqual(s.facts.since(ROOT, 0).facts.map((f) => [f.kind, f.at]), [["statut", 2], ["statut", 3]]);
  });
});

// Copie littérale de DelegationTransitions et WaitTransitions (activity-types.ts) : le test ne relit pas les tables du magasin.
const DELEGATION_EXPECTED: Record<DelegationState, readonly DelegationState[]> = {
  prepare: ["attente-accord", "autorisee", "travaille", "refusee", "expiree", "arretee", "jamais-demarree"],
  "attente-accord": ["autorisee", "refusee", "expiree", "arretee", "jamais-demarree"],
  autorisee: ["travaille", "terminee", "arretee", "jamais-demarree"],
  travaille: ["terminee", "arretee"],
  terminee: [],
  arretee: [],
  "jamais-demarree": [],
  refusee: [],
  expiree: [],
};
const WAIT_EXPECTED: Record<WaitState, readonly WaitState[]> = { attente: ["once", "reject", "expiree"], once: [], reject: [], expiree: [] };

const delegation = (callId: string, over: Partial<DelegationUpsert> = {}): DelegationUpsert => ({ rootId: ROOT, parentSessionId: ROOT, callId, agent: "", ...over });
const wait = (permissionId: string, over: Partial<WaitUpsert> = {}): WaitUpsert => ({ permissionId, sessionId: ROOT, rootId: ROOT, permission: "bash", ...over });

interface DelegationRow {
  state: string;
  agent: string;
  child_session_id: string | null;
  permission_id: string | null;
  command: string | null;
  source: string;
  sans_confirmation: number;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
}

const delegationRow = (db: ReturnType<typeof openMemoryDb>, callId: string) =>
  db.prepare("SELECT * FROM delegations WHERE parent_session_id = ? AND call_id = ?").get(ROOT, callId) as unknown as DelegationRow;

describe("écrivain unique : délégations (work.markDelegation)", () => {
  it("chaque couple (état, état suivant) suit DelegationTransitions ; un état final ne régresse jamais", () => {
    const s = setup();
    const states = Object.keys(DELEGATION_EXPECTED) as DelegationState[];
    let n = 0;
    for (const from of states) {
      for (const to of states) {
        const callId = `call_${n++}`;
        assert.equal(s.facts.work.markDelegation(delegation(callId), from, null), true, `création en ${from}`);
        const allowed = DELEGATION_EXPECTED[from].includes(to);
        assert.equal(s.facts.work.markDelegation(delegation(callId), to, null), allowed, `${from} → ${to}`);
        assert.equal(delegationRow(s.db, callId).state, allowed ? to : from, `${from} → ${to}`);
      }
    }
  });

  it("« terminee » après « arretee » refusé : état et heure de fin inchangés ; heures de début et de fin posées une fois", () => {
    const s = setup();
    assert.equal(s.facts.work.markDelegation(delegation("call_a"), "prepare", null), true);
    s.clock.now = 2_000;
    assert.equal(s.facts.work.markDelegation(delegation("call_a", { childSessionId: CHILD, agent: "explore" }), "travaille", null), true);
    s.clock.now = 3_000;
    assert.equal(s.facts.work.markDelegation(delegation("call_a"), "arretee", null), true);
    s.clock.now = 4_000;
    assert.equal(s.facts.work.markDelegation(delegation("call_a"), "terminee", null), false);
    assert.equal(s.facts.work.markDelegation(delegation("call_a"), "travaille", null), false);
    const row = delegationRow(s.db, "call_a");
    assert.deepEqual([row.state, row.created_at, row.started_at, row.ended_at], ["arretee", 1_000, 2_000, 3_000]);
  });

  it("identité complétée sans rien remplacer, même quand la transition est refusée", () => {
    const s = setup();
    s.facts.work.markDelegation(delegation("call_b"), "prepare", null);
    s.facts.work.markDelegation(delegation("call_b", { agent: "explore", childSessionId: CHILD, command: "revue", permissionId: "per_1" }), "terminee", null);
    let row = delegationRow(s.db, "call_b");
    assert.deepEqual([row.state, row.agent, row.child_session_id, row.command, row.permission_id], ["prepare", "explore", CHILD, "revue", "per_1"]);
    s.facts.work.markDelegation(delegation("call_b", { agent: "general", childSessionId: OTHER, command: "autre", permissionId: "per_2" }), "travaille", null);
    row = delegationRow(s.db, "call_b");
    assert.deepEqual([row.state, row.agent, row.child_session_id, row.command, row.permission_id], ["travaille", "explore", CHILD, "revue", "per_1"]);
  });

  it("« sans confirmation » jamais avec une demande connue ; un raccourci l'emporte sur « ia », jamais l'inverse", () => {
    const s = setup();
    s.facts.work.markDelegation(delegation("call_c", { sansConfirmation: true, permissionId: "per_c" }), "attente-accord", null);
    assert.equal(delegationRow(s.db, "call_c").sans_confirmation, 0);

    s.facts.work.markDelegation(delegation("call_d"), "prepare", null);
    assert.deepEqual([delegationRow(s.db, "call_d").source, delegationRow(s.db, "call_d").sans_confirmation], ["ia", 0]);
    s.facts.work.markDelegation(delegation("call_d", { source: "raccourci", sansConfirmation: true }), "travaille", null);
    assert.deepEqual([delegationRow(s.db, "call_d").source, delegationRow(s.db, "call_d").sans_confirmation], ["raccourci", 1]);
    s.facts.work.markDelegation(delegation("call_d", { source: "ia", sansConfirmation: false }), "terminee", null);
    assert.deepEqual([delegationRow(s.db, "call_d").source, delegationRow(s.db, "call_d").sans_confirmation], ["raccourci", 1]);
    // Demande découverte ensuite (transition refusée comprise) : plus « sans confirmation ».
    s.facts.work.markDelegation(delegation("call_d", { permissionId: "per_d" }), "terminee", null);
    assert.deepEqual([delegationRow(s.db, "call_d").permission_id, delegationRow(s.db, "call_d").sans_confirmation], ["per_d", 0]);
  });

  it("validation : identifiant, nom, source, état ou auteur invalides → RangeError, rien n'est écrit", () => {
    const s = setup();
    const cases: Array<[string, DelegationUpsert, string, string | null]> = [
      ["racine", delegation("call_1", { rootId: "ses racine" }), "prepare", null],
      ["appel", delegation("../call"), "prepare", null],
      ["enfant", delegation("call_1", { childSessionId: "enfant/1" }), "prepare", null],
      ["demande en forme de secret", delegation("call_1", { permissionId: `ghp_${"b".repeat(36)}` }), "prepare", null],
      ["assistant en texte libre", delegation("call_1", { agent: "Analyse les journaux" }), "prepare", null],
      ["commande en texte libre", delegation("call_1", { command: "npm test" }), "prepare", null],
      ["source", delegation("call_1", { source: "extension" as never }), "prepare", null],
      ["sans confirmation", delegation("call_1", { sansConfirmation: 1 as never }), "prepare", null],
      ["état", delegation("call_1"), "echec", null],
      ["auteur", delegation("call_1"), "prepare", "ia-controle"],
    ];
    for (const [label, upsert, etat, par] of cases) {
      assert.throws(() => s.facts.work.markDelegation(upsert, etat as DelegationState, par as never), RangeError, label);
    }
    assert.equal(count(s.db, "SELECT COUNT(*) AS n FROM delegations"), 0);
  });
});

interface WaitRow {
  reply: string | null;
  replied_by: string | null;
  asked_at: number;
  replied_at: number | null;
  target: string | null;
}

const waitRow = (db: ReturnType<typeof openMemoryDb>, id: string) => db.prepare("SELECT * FROM permission_waits WHERE permission_id = ?").get(id) as unknown as WaitRow;

describe("écrivain unique : attentes d'accord (work.markWait)", () => {
  it("chaque couple (état, état suivant) suit WaitTransitions ; « once » après « expiree » refusé", () => {
    const s = setup();
    const states = Object.keys(WAIT_EXPECTED) as WaitState[];
    let n = 0;
    for (const from of states) {
      for (const to of states) {
        const id = `per_${n++}`;
        assert.equal(s.facts.work.markWait(wait(id), from, null), true, `création en ${from}`);
        const allowed = WAIT_EXPECTED[from].includes(to);
        assert.equal(s.facts.work.markWait(wait(id), to, "vous"), allowed, `${from} → ${to}`);
        assert.equal(waitRow(s.db, id).reply ?? "attente", allowed ? to : from, `${from} → ${to}`);
      }
    }
  });

  it("heures et auteur : réponse vue dans le flux (auteur inconnu) puis complétée par le service qui l'a envoyée, jamais remplacée", () => {
    const s = setup();
    s.facts.work.markWait(wait("per_a", { permission: "task", target: "explore" }), "attente", null);
    s.clock.now = 2_000;
    assert.equal(s.facts.work.markWait(wait("per_a"), "once", null), true);
    const answered = waitRow(s.db, "per_a");
    assert.deepEqual([answered.reply, answered.replied_by, answered.asked_at, answered.replied_at, answered.target], ["once", null, 1_000, 2_000, "explore"]);
    s.clock.now = 3_000;
    assert.equal(s.facts.work.markWait(wait("per_a"), "once", "vous"), false);
    assert.equal(s.facts.work.markWait(wait("per_a"), "once", "cockpit"), false);
    assert.equal(s.facts.work.markWait(wait("per_a"), "reject", "controle"), false);
    assert.deepEqual([waitRow(s.db, "per_a").reply, waitRow(s.db, "per_a").replied_by, waitRow(s.db, "per_a").replied_at], ["once", "vous", 2_000]);

    // Réponse inscrite d'abord par le service, puis vue dans le flux : rien ne change.
    s.facts.work.markWait(wait("per_b"), "reject", "cockpit");
    assert.equal(s.facts.work.markWait(wait("per_b"), "reject", null), false);
    assert.deepEqual([waitRow(s.db, "per_b").reply, waitRow(s.db, "per_b").replied_by], ["reject", "cockpit"]);
  });

  it("validation : permission, cible, identifiants, état ou auteur invalides → RangeError, rien n'est écrit", () => {
    const s = setup();
    const cases: Array<[string, WaitUpsert, string, string | null]> = [
      ["permission en texte", wait("per_1", { permission: "Lancer npm test" }), "attente", null],
      ["cible en texte", wait("per_1", { target: "un fichier secret" }), "attente", null],
      ["demande", wait("per 1"), "attente", null],
      ["session", wait("per_1", { sessionId: "../x" }), "attente", null],
      ["état", wait("per_1"), "always", null],
      ["auteur", wait("per_1"), "once", "regles"],
    ];
    for (const [label, upsert, etat, par] of cases) {
      assert.throws(() => s.facts.work.markWait(upsert, etat as WaitState, par as never), RangeError, label);
    }
    assert.equal(count(s.db, "SELECT COUNT(*) AS n FROM permission_waits"), 0);
  });
});

/** Écriture SQL dans delegations ou permission_waits (insertion, mise à jour, suppression, remplacement). */
const WRITER_RE = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`]?(?:delegations|permission_waits)\b/i;

function serverSources(): string[] {
  return (fs.readdirSync(SERVER_DIR, { recursive: true }) as string[])
    .map((entry) => entry.replaceAll("\\", "/"))
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.startsWith("test-support/"));
}

describe("écrivain unique : aucun autre écrivain de delegations et permission_waits", () => {
  it("le motif reconnaît chaque forme d'écriture, et pas une lecture", () => {
    for (const sql of [
      "INSERT INTO delegations (id) VALUES (1)",
      "insert or ignore into permission_waits (permission_id)",
      "REPLACE INTO delegations",
      "UPDATE delegations SET state = 'x'",
      "update or replace permission_waits set reply = 'once'",
      "DELETE FROM permission_waits WHERE 1",
      "INSERT INTO `delegations`",
      "UPDATE\n        permission_waits SET",
    ]) {
      assert.match(sql, WRITER_RE, sql);
    }
    for (const sql of ["SELECT * FROM delegations", "FROM permission_waits w JOIN sessions", "CREATE TABLE delegations (", "INSERT INTO delegations_archive"]) {
      assert.doesNotMatch(sql, WRITER_RE, sql);
    }
  });

  it("seul fact-store.ts (work.markDelegation, work.markWait) écrit ces tables ; la migration 4 de db.ts les crée seulement", () => {
    const writers = serverSources().filter((file) => WRITER_RE.test(fs.readFileSync(path.join(SERVER_DIR, file), "utf8")));
    assert.deepEqual(writers, ["fact-store.ts"]);
  });
});
