// Tests de croisement du train it1 V1 (plan d'exécution §2.3, §5.2 ; propriété de l'intégrateur) : T2 (emplacements de
// l'interface, clients d'API), L2b (migration 5, sessions, purge, dépense bornée), L1a (portillon extrait, points d'insertion,
// garde de rechargement), L4a (faits purs) et L7a (banc e2e, hors de app/).
// Ce que la vague doit prouver ensemble, et qu'aucun paquet ne peut prouver seul :
//   1. tous les modules installés (« tous ») = comportement 1.0.4 — « always » 403, « once » vérifié, arrêt relayé ;
//   2. une base réelle en version 4 (fichier WAL) ouverte par le code fusionné : migrée en 5, puis servie par les services de
//      L2b (descendants, dépense bornée, purge) sans rien perdre ;
//   3. la liste des conversations que l'interface demande (GET /session, par le proxy) traverse la pile fusionnée jusqu'au faux
//      opencode — écart de fidélité relevé par le banc e2e de L7a, corrigé au train ;
//   4. les trois messages voisins de la garde de rechargement sont fondus en un seul (reste connu de L1a) ;
//   5. server/shared reste pur dans son entier, pas seulement pour les deux modules de L4a.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import type { ModelCatalog } from "./catalog.ts";
import { purgeConversation } from "./conversation-purge.ts";
import { MIGRATIONS, openDb, transaction } from "./db.ts";
import { Ledger } from "./ledger.ts";
import type { OpencodeClient } from "./opencode.ts";
import { SessionTracker } from "./sessions.ts";
import { SettingsStore } from "./settings.ts";
import { MESSAGES } from "./shared/assistant-rules.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import type { FakePermissionRequest, FakeSession } from "./test-support/fake-opencode.ts";
import { bash, within } from "./test-support/helpers.ts";

const MODEL = { providerID: "github-copilot", modelID: "gpt-5-mini" };

/**
 * Inscription du câblage, lue sans dépendre du champ `instances` que T3b ajoutera (plan 2 bis §4.2, D-2b-40) : une inscription
 * qui ne le porte pas sert l'instance principale.
 */
interface Inscription {
  kind: string;
  key: string;
  module: string;
  instances?: readonly string[];
}

/**
 * Ouverture 2bis-V2 : ce fichier ne compare que les inscriptions de l'instance PRINCIPALE. Le compte figé des groupes de routes
 * tombait sinon dès que la salle inscrivait le sien (groupe « omo », L18c), dans un fichier de croisement qu'aucun paquet n'a le
 * droit de corriger.
 */
const sertPrincipale = (r: Inscription): boolean => (r.instances ?? ["principale"]).includes("principale");

/** Conversation relayée par le proxy dont un « bash » attend une autorisation (même montage que permission-gate.test.ts). */
async function pendingAsk(h: CockpitHarness, title: string): Promise<{ session: FakeSession; asked: FakePermissionRequest }> {
  const created = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title } });
  assert.equal(created.status, 200, created.body);
  const session = created.json<FakeSession>();
  const since = h.fake.emitted.length;
  h.fake.script(session.id, { tools: [bash("ls")], followUp: { text: "fin" } });
  const sent = await h.call("POST", `/api/oc/session/${session.id}/prompt_async`, {
    headers: h.headers.mutating,
    body: { agent: "build", model: MODEL, parts: [{ type: "text", text: "Liste." }] },
  });
  assert.equal(sent.status, 204, sent.body);
  const asked = (await h.fake.waitForEvent("permission.asked", (p) => p.sessionID === session.id, { since })).properties as unknown as FakePermissionRequest;
  return { session, asked };
}

describe("croisements it1 V1 : tous les modules installés", () => {
  it("app-factory avec modules: « tous » = comportement 1.0 : « always » 403, « once » vérifié, arrêt relayé, demande restée refusée", async (t) => {
    const h = await startCockpit(t, { modules: "tous" });
    // Squelettes de T0 : route du Diagnostic ; modules livrés en V2 : routes « conversations » (L1c, arrêt de l'arbre), activité
    // (L4b, avec sa dérivation : les faits dérivés n'envoient rien à opencode) et choix d'autonomie (L6a) ; V3 : détails des
    // délégations (L1d, dont le crochet laisse passer le « once » d'une autre demande qu'une délégation) et plans (L6b, crochet
    // d'envoi limité aux conversations de plan). Le reste du cadre reste au repos, ports neutres ; comportement 1.0 inchangé
    // ci-dessous.
    const groupes = h.cockpit.wiring.registrations.filter((r) => r.kind === "routes");
    assert.deepEqual(
      groupes.filter(sertPrincipale).map((r) => r.key),
      ["conversations", "delegations", "activity", "autonomy", "plans", "diagnostic-11"],
      "inscriptions de routes : conversations, délégations, activité, choix d'autonomie, plans, Diagnostic",
    );
    assert.equal(h.cockpit.wiring.routes.length, groupes.length, "une fonction de routes câblée par inscription");
    // Non-régression de l'ouverture 2bis-V2 : le groupe de routes de la salle sort de la liste comparée, un groupe de l'instance
    // principale y reste.
    const principaux = groupes.filter(sertPrincipale);
    const avecSalle: Inscription[] = [...groupes, { kind: "routes", key: "omo", module: "omoRoom", instances: ["omo"] }];
    assert.deepEqual(avecSalle.filter(sertPrincipale).map((r) => r.key), principaux.map((r) => r.key), "un groupe de la salle ne change rien");
    assert.equal([...groupes, { kind: "routes", key: "autre", module: "autre" }].filter(sertPrincipale).length, principaux.length + 1, "un groupe principal, si");

    const { session, asked } = await pendingAsk(h, "Croisement V1");
    const always = await h.call("POST", `/api/oc/permission/${asked.id}/reply`, { headers: h.headers.mutating, body: { reply: "always" } });
    assert.equal(always.status, 403, always.body);
    assert.equal(always.json<{ error: string }>().error, "toujours-refuse");
    const expired = await h.call("POST", "/api/oc/permission/per_inexistante/reply", { headers: h.headers.mutating, body: { reply: "once" } });
    assert.equal(expired.status, 409, expired.body);
    assert.equal(expired.json<{ error: string }>().error, "demande-expiree");
    assert.ok(!h.fake.requests.some((r) => r.method === "POST" && r.pathname.startsWith("/permission/")), "rien relayé avant le « once » légitime");

    const once = await h.call("POST", `/api/oc/permission/${asked.id}/reply`, { headers: h.headers.mutating, body: { reply: "once" } });
    assert.equal(once.status, 200, once.body);
    assert.equal(h.cockpit.gate.emitted.has(asked.id), true, "réponse inscrite au registre (P9)");
    assert.deepEqual(
      h.fake.requests.filter((r) => r.method === "POST" && r.pathname === `/permission/${asked.id}/reply`).map((r) => r.body),
      [{ reply: "once" }],
    );

    const stop = await h.call("POST", `/api/oc/session/${session.id}/abort`, { headers: h.headers.mutating });
    assert.equal(stop.status, 200, stop.body);
    assert.ok(h.fake.requests.some((r) => r.method === "POST" && r.pathname === `/session/${session.id}/abort`), "arrêt relayé");
    await within(h.fake.settled(session.id), "réponse arrêtée");
    h.assertNoGlobalRestart();
  });

  it("liste des conversations de l'interface (GET /session par le proxy) : servie par le faux, bornée au dossier demandé", async (t) => {
    const h = await startCockpit(t, { modules: "tous" });
    const created = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title: "Visible" } });
    assert.equal(created.status, 200, created.body);
    const session = created.json<FakeSession>();
    // Adresse exacte de web/lib/api.ts (oc.sessions) : le banc e2e de L7a la voyait répondre 404.
    const list = await h.call("GET", `/api/oc/session?directory=${encodeURIComponent(session.directory)}&roots=true&limit=300`, { headers: h.headers.authed });
    assert.equal(list.status, 200, list.body);
    assert.ok(
      list.json<FakeSession[]>().some((s) => s.id === session.id),
      "la conversation créée figure dans la liste",
    );
    // Instance d'un autre dossier du workspace : jamais mêlée (Session.list borne à l'instance du dossier demandé).
    const ailleurs = await h.call("GET", `/api/oc/session?directory=${encodeURIComponent(`${session.directory}/app`)}&roots=true&limit=300`, {
      headers: h.headers.authed,
    });
    assert.equal(ailleurs.status, 200, ailleurs.body);
    assert.deepEqual(ailleurs.json<FakeSession[]>(), []);
    h.assertNoGlobalRestart();
  });

  it("garde de rechargement : une seule phrase pour la recharge et le redémarrage (configRestartBusy et configReloadBusy fondues)", () => {
    const keys = Object.keys(MESSAGES);
    assert.ok(!keys.includes("configRestartBusy"), "configRestartBusy supprimée");
    assert.ok(!keys.includes("configReloadBusy"), "configReloadBusy fondue dans reloadBusy");
    assert.equal(
      MESSAGES.reloadBusy,
      "Des réponses sont en cours : ce changement recharge ou redémarre opencode et les couperait. Attendez qu'elles se terminent.",
    );
  });
});

describe("croisements it1 V1 : base réelle v4 ouverte par le code fusionné", () => {
  it("fichier en version 4 → migré en 5, puis servi par les services de L2b sans rien perdre", async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "croisement-v1-"));
    // Fermetures d'abord, effacement ensuite : sous Windows, un fichier SQLite encore ouvert refuse d'être supprimé (EPERM).
    const ouvertes: DatabaseSync[] = [];
    t.after(() => {
      for (const open of ouvertes) {
        try {
          open.close();
        } catch {
          // déjà fermée
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    });

    // 1. Base réelle de la 1.0.4 : les 4 premières migrations seulement, dans un fichier WAL, comme openDb.
    {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(path.join(dir, "cockpit.db"));
      db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
      db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;");
      for (let v = 0; v < 4; v++) {
        transaction(db, () => {
          db.exec(MIGRATIONS[v] ?? "");
          db.exec(`PRAGMA user_version = ${v + 1}`);
        });
      }
      const now = Date.now();
      db.prepare("INSERT INTO sessions (id, parent_id, root_id, directory, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        "ses_racine",
        null,
        "ses_racine",
        "/workspace",
        "Racine 1.0.4",
        now,
        now,
      );
      db.prepare("INSERT INTO sessions (id, parent_id, root_id, directory, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        "ses_enfant",
        "ses_racine",
        "ses_racine",
        "/workspace",
        "Enfant 1.0.4",
        now,
        now,
      );
      db.close();
    }

    // 2. Ouverture par le code fusionné : migration 5 appliquée, données de la 1.0.4 intactes, défaut de sessions.instance posé.
    const db = openDb(dir);
    ouvertes.push(db);
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 5);
    const rows = (db.prepare("SELECT id, root_id, title, instance FROM sessions ORDER BY id").all() as Array<Record<string, unknown>>).map((row) => ({ ...row }));
    assert.deepEqual(rows, [
      { id: "ses_enfant", root_id: "ses_racine", title: "Enfant 1.0.4", instance: "principale" },
      { id: "ses_racine", root_id: "ses_racine", title: "Racine 1.0.4", instance: "principale" },
    ]);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'activity_facts'").get(), "table des faits créée");

    // 3. Services de L2b sur cette base migrée : arbre, dépense bornée, purge.
    const sessions = new SessionTracker(db, {} as OpencodeClient);
    assert.deepEqual(sessions.descendants("ses_racine", 10), ["ses_enfant"]);
    assert.equal(sessions.rootOf("ses_enfant"), "ses_racine");

    const settings = new SettingsStore(db);
    const ledger = new Ledger({ db, settings, catalog: { prices: new Map() } as unknown as ModelCatalog });
    assert.equal(ledger.spentSince("ses_racine", 0), 0, "aucune dépense enregistrée : zéro, pas une erreur");

    const purged = purgeConversation(db, "ses_racine");
    assert.ok(purged.facts >= 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE root_id = 'ses_racine'").get() as { n: number }).n, 2, "la purge ne supprime aucune session");

    // 4. Réouverture : plus rien à migrer.
    db.close();
    const again = openDb(dir);
    ouvertes.push(again);
    assert.equal((again.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 5);
  });
});

describe("croisements it1 V1 : pureté de tout server/shared", () => {
  it("chaque module de server/shared : ni module node, ni process, ni horloge, ni aléa, ni réseau ; imports permis seulement", () => {
    const dir = path.join(import.meta.dirname, "shared");
    const files = fs.readdirSync(dir).filter((name) => name.endsWith(".ts"));
    assert.ok(files.length >= 10, `server/shared : ${files.length} modules relus`);
    for (const file of files) {
      const source = fs.readFileSync(path.join(dir, file), "utf8");
      assert.equal(source.includes('"node:'), false, file);
      assert.equal(/\bprocess\./.test(source), false, file);
      // Horloge : Date.now, new Date() et new Date sans argument. new Date(valeur) (lecture d'une date reçue, 1.0.5) reste pur.
      assert.equal(/\bDate\.now\b|new Date\s*\(\s*\)|new Date\b(?!\s*\()|Math\.random|\bfetch\s*\(|\bsetTimeout\b|\bperformance\./.test(source), false, file);
      const imports = [...source.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1] ?? "");
      // Un module partagé ne remonte que vers des modules purs du serveur, tous nommés ici.
      for (const spec of imports) assert.ok(spec === "../redact.ts" || spec === "../pricing.ts" || /^\.\/[\w.-]+\.ts$/.test(spec), `${file} : ${spec}`);
    }
  });
});
