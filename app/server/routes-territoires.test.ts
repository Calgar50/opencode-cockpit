// Tests L31a, route du zoom 1 (spécification §5.8 l.993, §6 l.1065, P11 ; plan d'exécution it3, fiche L31a, D-3d-13, D-3d-14) :
// GET /api/salle-controle/territoires servi par app-factory avec le VRAI port (wiring-3d), le vrai faux opencode et la base du
// harnais. Vérifié : 200 et forme de la réponse, données réelles (deux projets du workspace, une racine occupée lue par
// GET /session/status, une en attente d'accord, une au repos, coûts), mode relu à chaque requête, lecture seule (compte des lignes
// de toutes les tables inchangé, aucune écriture de configuration), aucune autre méthode, et P11 : aucune requête de statut pour un
// dossier qui n'a que des racines de la Salle OMO.
// La route ne porte AUCUN identifiant (web/lib/api-salle3d.ts : territoires() sans paramètre) : un paramètre d'adresse ne peut pas
// la faire répondre 400, et une ligne `sessions` dont l'identifiant est invalide est simplement écartée (territoires.test.ts).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { TerritoiresResponse } from "./shared/salle3d-types.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import { until } from "./test-support/helpers.ts";

const ALPHA = "/workspace/alpha";
const BETA = "/workspace/beta";
const SALLE = "/workspace/salle";

/** Workspace du test : deux projets réels (alpha, beta) plus le dossier de la salle, retirés à la fin. */
function workspace(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "territoires-"));
  for (const nom of ["alpha", "beta", "salle"]) fs.mkdirSync(path.join(dir, nom), { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const lireTerritoires = async (h: CockpitHarness) => {
  const res = await h.call("GET", "/api/salle-controle/territoires", { headers: h.headers.authed });
  assert.equal(res.status, 200, res.body);
  return res.json<TerritoiresResponse>();
};

/** Compte des lignes de toutes les tables de la base (noms lus dans sqlite_master, jamais une entrée de l'utilisateur). */
function compterLignes(h: CockpitHarness): Record<string, number> {
  const tables = h.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
  return Object.fromEntries(tables.map(({ name }) => [name, (h.db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n]));
}

const statutsDemandes = (h: CockpitHarness, depuis: number) =>
  h.fake.requests.slice(depuis).filter((r) => r.pathname === "/session/status").map((r) => r.query.directory ?? "");

const territoireDe = (vue: TerritoiresResponse, projet: string) => vue.projets.find((t) => t.projet === projet);

/** Session créée dans le faux (dossier compris) puis relevée par l'EventProcessor du harnais. */
async function nouvelleConversation(h: CockpitHarness, directory: string, title: string): Promise<string> {
  const session = await h.deps.client.request<{ id: string }>("POST", "/session", { directory, body: { title } });
  await until(() => h.sessions.get(session.id));
  return session.id;
}

describe("route des territoires (L31a) : GET /api/salle-controle/territoires", () => {
  it("200, forme de la réponse, mode relu à chaque requête, lecture seule et aucune autre méthode", async (t) => {
    const h = await startCockpit(t, { env: { workspaceDir: workspace(t) } });
    const depuis = h.fake.requests.length;
    const avant = compterLignes(h);

    const vue = await lireTerritoires(h);
    assert.equal(typeof vue.genereLe, "number");
    assert.equal(vue.mode, "simple");
    assert.equal(vue.salle, null);
    assert.equal(vue.statutVerifie, true);
    assert.deepEqual(
      vue.projets.map((territoire) => [territoire.projet, territoire.nom, territoire.conversations, territoire.compteurs]),
      [
        ["", path.basename(h.fake.directory), [], { travaillent: 0, attendent: 0, cout: 0 }],
        ["alpha", "alpha", [], { travaillent: 0, attendent: 0, cout: 0 }],
        ["beta", "beta", [], { travaillent: 0, attendent: 0, cout: 0 }],
        ["salle", "salle", [], { travaillent: 0, attendent: 0, cout: 0 }],
      ],
      "un territoire par projet du workspace (D-3d-13), rangés par chemin",
    );

    // La route ne porte aucun identifiant : un paramètre d'adresse est ignoré, jamais un 400.
    const avecParametre = await h.call("GET", "/api/salle-controle/territoires?rootId=ses.point", { headers: h.headers.authed });
    assert.equal(avecParametre.status, 200, avecParametre.body);

    for (const methode of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await h.call(methode, "/api/salle-controle/territoires", {
        headers: h.headers.mutating,
        ...(methode === "DELETE" ? {} : { body: {} }),
      });
      assert.ok(res.status === 404 || res.status === 405, `${methode} : ${res.status}`);
    }

    assert.deepEqual(compterLignes(h), avant, "aucune écriture en base");
    assert.deepEqual(statutsDemandes(h, depuis), [], "aucune racine : aucun statut demandé");

    h.settings.update({ ui: { mode: "avance" } });
    assert.equal((await lireTerritoires(h)).mode, "avance", "le mode est relu à chaque requête");
    h.assertNoGlobalRestart();
  });

  it("données réelles : une racine occupée (statut du faux), une en attente d'accord, une au repos, coûts par territoire", async (t) => {
    const h = await startCockpit(t, { env: { workspaceDir: workspace(t) }, settings: { ui: { mode: "avance" } } });
    const occupee = await nouvelleConversation(h, ALPHA, "Refonte");
    const attente = await nouvelleConversation(h, ALPHA, "Correctif");
    const repos = await nouvelleConversation(h, BETA, "Notes");

    // La conversation « occupée » reste occupée : son outil attend une réponse d'autorisation (le faux la tient busy).
    h.fake.script(occupee, { tools: [{ tool: "bash", input: { command: "ls" }, ask: { permission: "bash", patterns: ["ls"] } }] });
    assert.equal(
      await h.deps.client
        .request("POST", `/session/${occupee}/prompt_async`, { directory: ALPHA, body: { agent: "build", parts: [{ type: "text", text: "Liste" }] } })
        .then(() => 204),
      204,
    );
    await until(() => h.fake.statusOf(occupee).type === "busy");
    // Le message envoyé est enregistré par l'EventProcessor : attendu avant de semer les dépenses, sinon la fenêtre de coût
    // s'ouvrirait après elles.
    await until(() => (h.db.prepare("SELECT COUNT(*) AS n FROM prompts WHERE root_id = ?").get(occupee) as { n: number }).n > 0);

    const debut = Date.now() - 1_000;
    for (const [rootId, cout] of [
      [occupee, 0.25],
      [attente, 0.5],
      [repos, 8],
    ] as const) {
      h.db.prepare("INSERT INTO prompts (message_id, session_id, root_id, created_at, kind) VALUES (?, ?, ?, ?, 'message')").run(`msg_${rootId}`, rootId, rootId, debut);
      // Le message réel envoyé à la conversation occupée est déjà enregistré par l'EventProcessor : la fenêtre de coût s'ouvre au
      // DERNIER message de l'utilisateur, donc la dépense est posée après lui.
      const dernier = (h.db.prepare("SELECT MAX(created_at) AS at FROM prompts WHERE root_id = ? AND session_id = ? AND kind = 'message'").get(rootId, rootId) as {
        at: number;
      }).at;
      h.db
        .prepare(
          "INSERT INTO usage (message_id, session_id, root_id, provider_id, model_id, created_at, completed_at, cost) VALUES (?, ?, ?, 'github-copilot', 'gpt-5-mini', ?, ?, ?)",
        )
        .run(`u_${rootId}`, rootId, rootId, dernier + 1, dernier + 1, cout);
      // Dépense antérieure au dernier message : jamais comptée dans la demande en cours.
      h.db
        .prepare(
          "INSERT INTO usage (message_id, session_id, root_id, provider_id, model_id, created_at, completed_at, cost) VALUES (?, ?, ?, 'github-copilot', 'gpt-5-mini', ?, ?, ?)",
        )
        .run(`u_avant_${rootId}`, rootId, rootId, debut - 10, debut - 10, 16);
    }
    h.db.prepare("INSERT INTO permission_waits (permission_id, session_id, root_id, permission, asked_at) VALUES (?, ?, ?, 'bash', ?)").run(
      "per_attente",
      attente,
      attente,
      debut,
    );

    const depuis = h.fake.requests.length;
    const vue = await lireTerritoires(h);

    assert.deepEqual(statutsDemandes(h, depuis).sort(), [ALPHA, BETA], "un statut par dossier distinct de l'instance principale");
    // Lecture seule vers opencode : le tour en cours continue de vivre (l'EventProcessor écrit son usage), mais la route n'envoie
    // que des GET. Le contrôle « aucune écriture en base » est tenu par le premier cas, sans tour en cours.
    assert.deepEqual([...new Set(h.fake.requests.slice(depuis).map((r) => r.method))], ["GET"]);
    assert.equal(vue.statutVerifie, true);
    assert.deepEqual(territoireDe(vue, "alpha")?.compteurs, { travaillent: 1, attendent: 1, cout: 0.75 });
    assert.deepEqual(territoireDe(vue, "beta")?.compteurs, { travaillent: 0, attendent: 0, cout: 0 });
    const conversations = new Map((territoireDe(vue, "alpha")?.conversations ?? []).map((c) => [c.rootId, c]));
    assert.equal(conversations.get(occupee)?.travaillent, 1, "la session occupée du faux est comptée");
    assert.equal(conversations.get(occupee)?.titre, "Refonte");
    assert.equal(conversations.get(occupee)?.coutEnCours, 0.25);
    assert.equal(conversations.get(attente)?.travaillent, 0);
    assert.equal(conversations.get(attente)?.attendent, 1);
    assert.equal(conversations.get(attente)?.coutEnCours, 0.5);
    const auRepos = territoireDe(vue, "beta")?.conversations[0];
    assert.equal(auRepos?.rootId, repos);
    assert.equal(auRepos?.travaillent, 0);
    assert.equal(auRepos?.coutEnCours, 0, "aucun coût « des demandes en cours » sans demande en cours");
    h.assertNoGlobalRestart();
  });

  it("P11 : aucune requête /session/status pour un dossier qui n'a que des racines de la salle (journal du faux)", async (t) => {
    const h = await startCockpit(t, { env: { workspaceDir: workspace(t) }, settings: { ui: { mode: "avance" } }, modules: ["facts"] });
    const principale = await nouvelleConversation(h, ALPHA, "Refonte");
    const dansLaSalle = await nouvelleConversation(h, SALLE, "Demande de la salle");
    h.db.prepare("UPDATE sessions SET instance = 'omo' WHERE id = ?").run(dansLaSalle);

    const depuis = h.fake.requests.length;
    const vue = await lireTerritoires(h);

    assert.deepEqual(statutsDemandes(h, depuis), [ALPHA], "seul le dossier de la racine principale est interrogé");
    assert.equal(
      statutsDemandes(h, depuis).includes(SALLE),
      false,
      "P11 : rien n'est demandé au client principal pour un dossier qui n'a que des racines de la salle",
    );
    assert.deepEqual(territoireDe(vue, "alpha")?.conversations.map((c) => c.rootId), [principale]);
    assert.deepEqual(territoireDe(vue, "salle")?.conversations, [], "la racine de la salle n'est pas un territoire de projet");
    assert.deepEqual(
      vue.salle?.projets.flatMap((territoire) => territoire.conversations.map((c) => c.rootId)),
      [dansLaSalle],
      "elle est dans l'enceinte (JP-10)",
    );
    assert.equal(vue.statutVerifie, false, "une enceinte est montrée : les compteurs de la salle ne sont pas un état vérifié");
    h.assertNoGlobalRestart();
  });

  it("Simple : l'enceinte ne liste que les demandes terminées de la salle, avec « Revoir » (D-3d-14)", async (t) => {
    const h = await startCockpit(t, { env: { workspaceDir: workspace(t) }, modules: ["facts"] });
    const finie = await nouvelleConversation(h, SALLE, "Demande finie");
    const enCours = await nouvelleConversation(h, SALLE, "Demande en cours");
    h.db.prepare("UPDATE sessions SET instance = 'omo' WHERE id IN (?, ?)").run(finie, enCours);
    const maintenant = Date.now();
    for (const rootId of [finie, enCours]) {
      h.cockpit.c11.ports.facts.append([{ rootId, sessionId: rootId, kind: "statut", ref: null, data: { etat: "repos" }, at: maintenant - 500 }]);
    }
    h.db
      .prepare("INSERT INTO autonomy_requests (id, root_id, choix, plafonds, started_at, ended_at) VALUES (?, ?, 'autonome', '{}', ?, ?)")
      .run("req_finie", finie, maintenant - 900, maintenant - 100);
    h.db
      .prepare("INSERT INTO autonomy_requests (id, root_id, choix, plafonds, started_at, ended_at) VALUES (?, ?, 'autonome', '{}', ?, NULL)")
      .run("req_encours", enCours, maintenant - 900);

    const depuis = h.fake.requests.length;
    const simple = await lireTerritoires(h);
    assert.deepEqual(statutsDemandes(h, depuis), [], "P11 en Simple aussi");
    const conversations = simple.salle?.projets.flatMap((territoire) => territoire.conversations) ?? [];
    assert.deepEqual(
      conversations.map((c) => [c.rootId, c.revoir, c.travaillent]),
      [[finie, true, null]],
      "seule la demande terminée est proposée, sans compteur en direct",
    );

    h.settings.update({ ui: { mode: "avance" } });
    const avance = await lireTerritoires(h);
    assert.deepEqual(
      (avance.salle?.projets.flatMap((territoire) => territoire.conversations) ?? []).map((c) => c.rootId).sort(),
      [enCours, finie].sort(),
      "en Avancé, toutes les demandes de la salle sont montrées",
    );
    h.assertNoGlobalRestart();
  });
});
