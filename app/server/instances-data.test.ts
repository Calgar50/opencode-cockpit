// Tests L18a : DONNÉES par instance (plan 2 bis, fiche L18a ; spécification §3.10 l.358-359, §3.11 l.382, §3.13 l.412,
// P6 l.41, P11 l.46, §7.5 l.1146 ; D-2b-05, D-2b-20, §1.3 réservation 4).
// Ce que chaque test garde :
// - sessions : instance posée à l'insertion seulement, `instanceOf`, recherche par le client de SON instance ;
// - archive : lecture par l'instance de la session ; une conversation de la salle n'est JAMAIS marquée supprimée par un 404
//   de l'instance principale (D-2b-05) ;
// - classement : jamais pour une racine de la salle, et heuristique seule même demandé à la main ;
// - knownDirectories limité à l'instance principale (réservation 4) ;
// - usage de la salle enregistré (ledger) par le client de la salle ;
// - faits écrits pour une racine de la salle ;
// - instance-runtime : mot de passe de la salle, catalogue sans onChange, OcLookup sans lecture de fichiers, portillon à
//   registre propre, compteur d'envois facturés propre.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { ArchiveService } from "./archive.ts";
import { knownDirectories } from "./assistants.ts";
import { ModelCatalog } from "./catalog.ts";
import { Classifier } from "./classifier.ts";
import { openMemoryDb } from "./db.ts";
import { EventHub } from "./hub.ts";
import { creerInstanceOmo, OMO_SANS_CONFIGURATION } from "./instance-runtime.ts";
import { Ledger } from "./ledger.ts";
import { createLogger } from "./log.ts";
import { OpencodeError, type OcSession, type OpencodeClient } from "./opencode.ts";
import { ProjectsService } from "./projects.ts";
import { SessionTracker } from "./sessions.ts";
import { SettingsStore } from "./settings.ts";
import type { SessionInstance } from "./shared/activity-types.ts";
import { startCockpit } from "./test-support/cockpit-harness.ts";
import { until } from "./test-support/helpers.ts";

// Horodatage des fixtures : RELATIF à l'exécution, JAMAIS une date de calendrier.
// knownDirectories() (assistants.ts) ne garde que les sessions dont `updated_at` tombe dans les dernières 24 h
// (RECENT_SESSION_MS). Une date figée — ici Date.UTC(2026, 8, 21, 11, 0, 0) — rendait donc ce fichier rouge à
// heure fixe, le 22/09/2026 à 11:00 UTC, sur toutes les machines et pour toujours ensuite. `knownDirectories`
// n'accepte pas d'horloge injectée (contrairement à `now?: () => number` ailleurs dans le dépôt) : la fixture
// prend l'heure de l'exécution, moins une minute. Ne pas y remettre de date absolue.
const T = Date.now() - 60_000;

const session = (id: string, extra: Partial<OcSession> = {}): OcSession => ({
  id,
  projectID: "p",
  directory: "/workspace/app",
  title: `Session ${id}`,
  time: { created: T, updated: T },
  ...extra,
});

/** Client qui note ses requêtes et rend les sessions qu'on lui confie (ou un 404 d'opencode). */
function clientNote(connues: Record<string, OcSession> = {}, nom = "client") {
  const demandes: string[] = [];
  const client = {
    request: async <R>(method: string, chemin: string): Promise<R> => {
      demandes.push(`${method} ${chemin}`);
      const id = decodeURIComponent(chemin.replace("/session/", "").replace("/message", ""));
      const info = connues[id];
      if (!info) throw new OpencodeError(404, `${nom} : session inconnue`, "NotFound");
      return (chemin.endsWith("/message") ? [] : info) as R;
    },
  } as unknown as OpencodeClient;
  return { client, demandes };
}

describe("L18a : sessions par instance", () => {
  it("instanceOf : instance d'une session suivie, null pour une session inconnue", () => {
    const db = openMemoryDb();
    const sessions = new SessionTracker(db, {} as OpencodeClient);
    sessions.upsert(session("ses_p"));
    sessions.upsert(session("ses_o"), undefined, { instance: "omo" });
    assert.equal(sessions.instanceOf("ses_p"), "principale");
    assert.equal(sessions.instanceOf("ses_o"), "omo");
    assert.equal(sessions.instanceOf("ses_inconnue"), null);
    db.close();
  });

  it("ensure part sur le client de l'instance (useClient) : la salle n'interroge JAMAIS l'opencode de l'instance principale", async () => {
    const db = openMemoryDb();
    const principale = clientNote({ ses_fille: session("ses_fille", { parentID: "ses_mere" }), ses_mere: session("ses_mere") }, "principale");
    const salle = clientNote({ ses_fille: session("ses_fille", { parentID: "ses_mere" }), ses_mere: session("ses_mere") }, "salle");
    const sessions = new SessionTracker(db, principale.client);
    sessions.useClient("omo", salle.client);

    const fille = await sessions.ensure("ses_fille", "/workspace/app", 0, "omo");
    assert.equal(fille?.instance, "omo");
    assert.equal(sessions.get("ses_mere")?.instance, "omo", "la lignée découverte reçoit l'instance");
    assert.deepEqual(principale.demandes, [], "aucune requête à l'instance principale");
    assert.deepEqual(salle.demandes, ["GET /session/ses_fille", "GET /session/ses_mere"]);
    db.close();
  });

  it("session suivie par l'AUTRE instance, même à lignée incomplète : rendue telle quelle, sans aucune requête", async () => {
    const db = openMemoryDb();
    const principale = clientNote({ ses_o: session("ses_o", { parentID: "ses_absente", title: "Volée" }) }, "principale");
    const salle = clientNote({}, "salle");
    const sessions = new SessionTracker(db, principale.client);
    sessions.useClient("omo", salle.client);
    // Parent INCONNU du cockpit : sans la garde d'instance, ensure repartirait interroger opencode pour compléter la lignée.
    sessions.upsert(session("ses_o", { parentID: "ses_absente", title: "Salle" }), undefined, { instance: "omo" });
    assert.equal(sessions.get("ses_o")?.parent_id, "ses_absente");
    assert.equal(sessions.get("ses_absente"), undefined);

    const ligne = await sessions.ensure("ses_o", "/workspace/app");
    assert.equal(ligne?.instance, "omo");
    assert.equal(ligne?.title, "Salle");
    assert.deepEqual(principale.demandes, [], "aucune requête à l'instance principale pour une session de la salle");
    assert.deepEqual(salle.demandes, []);
    db.close();
  });
});

/** Archive branchée sur une base en mémoire, avec une conversation déjà enregistrée. */
function archiveEnMemoire(instanceDeLaSession: SessionInstance) {
  const db = openMemoryDb();
  const settings = new SettingsStore(db);
  const catalog = { list: () => [], prices: new Map(), loaded: true } as unknown as ConstructorParameters<typeof Ledger>[0]["catalog"];
  const ledger = new Ledger({ db, settings, catalog });
  const principale = clientNote({}, "principale");
  const sessions = new SessionTracker(db, principale.client);
  sessions.upsert(session("ses_conv"), undefined, { instance: instanceDeLaSession });
  db.prepare("INSERT INTO conversations (session_id, directory, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("ses_conv", "/workspace/app", "T", T, T);
  const archive = new ArchiveService({
    db,
    client: principale.client,
    settings,
    ledger,
    sessions,
    archiveDir: path.join(process.cwd(), "introuvable"),
    opencodeWorkspaceDir: "/workspace",
    log: createLogger("error"),
  });
  const supprimee = () => (db.prepare("SELECT deleted_in_opencode FROM conversations WHERE session_id = ?").get("ses_conv") as { deleted_in_opencode: number }).deleted_in_opencode;
  return { db, archive, sessions, principale, supprimee };
}

describe("L18a : archive lue par l'instance de la session (D-2b-05)", () => {
  it("conversation de la salle, instance absente : rien n'est demandé à l'instance principale et rien n'est marqué supprimé", async () => {
    const a = archiveEnMemoire("omo");
    assert.equal(await a.archive.refresh("ses_conv"), null);
    assert.deepEqual(a.principale.demandes, [], "aucun 404 de l'instance principale n'est provoqué");
    assert.equal(a.supprimee(), 0, "la conversation de la salle n'est JAMAIS marquée supprimée");
    a.db.close();
  });

  it("conversation de la salle, client de la salle posé : c'est LUI qui est lu, et son 404 marque bien la conversation", async () => {
    const a = archiveEnMemoire("omo");
    const salle = clientNote({}, "salle");
    a.archive.useClient("omo", salle.client);
    assert.equal(await a.archive.refresh("ses_conv"), null);
    assert.deepEqual(a.principale.demandes, []);
    assert.deepEqual(salle.demandes, ["GET /session/ses_conv"]);
    assert.equal(a.supprimee(), 1, "un 404 de SON instance marque la conversation supprimée");
    a.db.close();
  });

  it("conversation de l'instance principale : comportement 1.0.x, son 404 marque la conversation supprimée", async () => {
    const a = archiveEnMemoire("principale");
    assert.equal(await a.archive.refresh("ses_conv"), null);
    assert.deepEqual(a.principale.demandes, ["GET /session/ses_conv"]);
    assert.equal(a.supprimee(), 1);
    a.db.close();
  });
});

describe("L18a : classement limité à l'instance principale (D-2b-05)", () => {
  function classement(instance: SessionInstance) {
    const db = openMemoryDb();
    const settings = new SettingsStore(db);
    settings.update({ classifier: { mode: "llm", model: "github-copilot/gpt-5-mini" } });
    const catalog = { list: () => [{ key: "github-copilot/gpt-5-mini", providerID: "github-copilot", price: { rates: { input: 1, output: 1 } } }] } as unknown as ModelCatalog;
    const demandes: string[] = [];
    const client = {
      request: async <R>(method: string, chemin: string): Promise<R> => {
        demandes.push(`${method} ${chemin}`);
        return { id: "ses_classement", directory: "/workspace" } as R;
      },
    } as unknown as OpencodeClient;
    const sessions = new SessionTracker(db, client);
    sessions.upsert(session("ses_racine"), undefined, { instance });
    const conversation = { sessionId: "ses_racine", project: "app", classifiedBy: "heuristic" } as never;
    const digest = {
      sessionId: "ses_racine",
      directory: "/workspace/app",
      title: "Corriger un bug",
      createdAt: 0,
      updatedAt: 0,
      prompts: ["Corrige ce bug"],
      answers: [],
      tools: {},
      files: [],
      commands: [],
      models: [],
      additions: 0,
      deletions: 0,
      messageCount: 2,
      promptCount: 1,
      transcript: "",
    };
    const classes: string[] = [];
    const relectures: string[] = [];
    const classifier = new Classifier({
      client,
      settings,
      catalog,
      archive: {
        refresh: async (id: string) => {
          relectures.push(id);
          return { conversation, digest };
        },
        get: () => conversation,
        applyClassification: (_id: string, result: { by: string }) => {
          classes.push(result.by);
          return conversation;
        },
      } as never,
      sessions,
      ledger: { recordAssistant: () => undefined } as never,
      hub: new EventHub(),
      log: createLogger("error"),
      opencodeWorkspaceDir: "/workspace",
      allowedProviders: ["github-copilot"],
      canBill: () => true,
    });
    return { db, classifier, demandes, classes, relectures };
  }

  it("racine de la salle : run() classe par heuristique SANS aucun appel facturé", async () => {
    const c = classement("omo");
    assert.deepEqual(await c.classifier.run("ses_racine", { force: true }), { sessionId: "ses_racine", project: "app", classifiedBy: "heuristic" } as never);
    assert.deepEqual(c.demandes, [], "aucune session de classement créée, aucun message envoyé");
    assert.deepEqual(c.classes, ["heuristic"]);
    c.db.close();
  });

  it("racine de la salle : onIdle n'archive rien (horloge simulée, aucune attente réelle) ; l'instance principale, si", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const salle = classement("omo");
    salle.classifier.onIdle("ses_racine");
    t.mock.timers.tick(10_000);
    assert.deepEqual(salle.relectures, [], "aucun archivage différé pour une racine de la salle");
    salle.db.close();

    // Contre-épreuve : la même minuterie part bien pour une racine de l'instance principale.
    const principale = classement("principale");
    principale.classifier.onIdle("ses_racine");
    t.mock.timers.tick(10_000);
    assert.deepEqual(principale.relectures, ["ses_racine"]);
    principale.db.close();
  });

  it("racine de l'instance principale : le classement par IA part bien (la garde est bien celle de l'instance)", async () => {
    const c = classement("principale");
    await c.classifier.run("ses_racine", { force: true });
    assert.ok(c.demandes.includes("POST /session"), `classement facturé attendu : ${c.demandes.join(", ")}`);
    c.db.close();
  });

  it("le processeur n'appelle jamais le classement pour la salle (session.idle, session.status)", async (t) => {
    const h = await startCockpit(t, { omo: true });
    assert.ok(h.omo);
    const appels: string[] = [];
    // Espion posé à la place du classement du harnais (partagé par les deux processeurs).
    Object.assign(h.deps.classifier, { onIdle: (id: string) => void appels.push(`idle:${id}`), onBusy: (id: string) => void appels.push(`busy:${id}`) });
    const creee = await h.omo.deps.client.request<OcSession>("POST", "/session", { body: { title: "Salle" } });
    await until(() => h.sessions.get(creee.id));
    await h.emitOmo({ directory: "/workspace", payload: { type: "session.idle", properties: { sessionID: creee.id } } });
    await h.emitOmo({ directory: "/workspace", payload: { type: "session.status", properties: { sessionID: creee.id, status: { type: "busy" } } } });
    assert.deepEqual(appels, []);
  });
});

describe("L18a : knownDirectories limité à l'instance principale (réservation 4)", () => {
  it("les dossiers des sessions de la salle n'entrent pas dans la liste interrogée", async () => {
    const db = openMemoryDb();
    const sessions = new SessionTracker(db, {} as OpencodeClient);
    sessions.upsert(session("ses_p", { directory: "/workspace/app" }));
    sessions.upsert(session("ses_o", { directory: "/workspace/salle" }), undefined, { instance: "omo" });
    const projects = { isAllowedDirectory: () => true, list: async () => [] } as unknown as ProjectsService;
    assert.deepEqual(await knownDirectories({ projects, db }), [null, "/workspace/app"]);
    db.close();
  });

  // Garde de la fixture relative : si `T` redevenait une date de calendrier, les deux sessions sortiraient de la
  // fenêtre de 24 h et le test ci-dessus passerait au vert POUR LA MAUVAISE RAISON (liste réduite à [null], donc
  // plus aucune preuve que c'est bien l'instance qui écarte la salle). Ici, seule la vieille sort.
  it("la fenêtre de 24 h discrimine vraiment : une session récente entre, une de plus de 24 h non", async () => {
    const db = openMemoryDb();
    const sessions = new SessionTracker(db, {} as OpencodeClient);
    const vieux = T - 25 * 3_600_000;
    sessions.upsert(session("ses_recente", { directory: "/workspace/app" }));
    sessions.upsert(session("ses_ancienne", { directory: "/workspace/ancien", time: { created: vieux, updated: vieux } }));
    const projects = { isAllowedDirectory: () => true, list: async () => [] } as unknown as ProjectsService;
    assert.deepEqual(await knownDirectories({ projects, db }), [null, "/workspace/app"]);
    db.close();
  });
});

describe("L18a : usage et faits de la salle", () => {
  it("usage de la salle enregistré par SON client : ligne d'usage, usage.updated étiqueté, rien côté instance principale", async (t) => {
    const h = await startCockpit(t, { omo: true });
    assert.ok(h.omo);
    const creee = await h.omo.deps.client.request<OcSession>("POST", "/session", { body: { title: "Salle facturée" } });
    await until(() => h.sessions.get(creee.id));
    const avant = h.fake.requests.length;
    h.omo.fake.script(creee.id, { text: "Réponse.", cost: 0.042, tokens: { input: 10, output: 5 } });
    await h.omo.deps.client.request("POST", `/session/${creee.id}/prompt_async`, {
      body: { agent: "build", model: { providerID: "github-copilot", modelID: "gpt-5-mini" }, parts: [{ type: "text", text: "Salut" }] },
    });
    await h.omo.fake.settled(creee.id);
    const ligne = await until(
      () =>
        h.db.prepare("SELECT session_id, cost_reported FROM usage WHERE session_id = ? AND completed_at IS NOT NULL").get(creee.id) as
          | { session_id: string; cost_reported: number }
          | undefined,
    );
    assert.deepEqual({ ...ligne }, { session_id: creee.id, cost_reported: 0.042 });
    assert.equal(h.fake.requests.length, avant, "aucune requête au faux de l'instance principale");
    h.assertNoGlobalRestart();
  });

  it("session de la salle INCONNUE du cockpit : ensure part sur le faux de la salle, l'usage y est relevé", async (t) => {
    const h = await startCockpit(t, { omo: true });
    assert.ok(h.omo);
    const creee = await h.omo.deps.client.request<OcSession>("POST", "/session", { body: { title: "Oubliée" } });
    await until(() => h.sessions.get(creee.id));
    // Oubliée par le cockpit (par exemple créée pendant une coupure du flux) : le prochain message la fera rechercher.
    h.db.prepare("DELETE FROM sessions WHERE id = ?").run(creee.id);
    const avantPrincipale = h.fake.requests.length;
    await h.emitOmo({
      directory: "/workspace",
      payload: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_oubliee",
            sessionID: creee.id,
            role: "assistant",
            time: { created: T, completed: T + 10 },
            cost: 0.009,
            tokens: { input: 4, output: 2 },
            modelID: "gpt-5-mini",
            providerID: "github-copilot",
          },
        },
      },
    });
    const ligne = await until(() => h.sessions.get(creee.id));
    assert.equal(ligne.instance, "omo", "la session retrouvée est écrite « omo »");
    assert.ok(
      h.omo.fake.requests.some((r) => r.method === "GET" && r.pathname === `/session/${creee.id}`),
      "la recherche est partie sur le faux de la salle",
    );
    assert.equal(h.fake.requests.length, avantPrincipale, "aucune requête au faux de l'instance principale");
    const usage = await until(() => h.db.prepare("SELECT cost_reported FROM usage WHERE session_id = ?").get(creee.id) as { cost_reported: number } | undefined);
    assert.equal(usage.cost_reported, 0.009, "usage de la salle relevé");
  });

  it("archive d'une racine de la salle : relue sur le faux de la salle, jamais sur celui de l'instance principale", async (t) => {
    const h = await startCockpit(t, { omo: true });
    assert.ok(h.omo);
    const creee = await h.omo.deps.client.request<OcSession>("POST", "/session", { body: { title: "Archivée" } });
    await until(() => h.sessions.get(creee.id));
    h.omo.fake.script(creee.id, { text: "Réponse.", cost: 0.001, tokens: { input: 1, output: 1 } });
    await h.omo.deps.client.request("POST", `/session/${creee.id}/prompt_async`, {
      body: { agent: "build", model: { providerID: "github-copilot", modelID: "gpt-5-mini" }, parts: [{ type: "text", text: "Archive-moi" }] },
    });
    await h.omo.fake.settled(creee.id);
    const avantPrincipale = h.fake.requests.length;
    const relu = await h.deps.archive.refresh(creee.id);
    assert.ok(relu, "la conversation de la salle est bien archivée");
    assert.equal(h.fake.requests.length, avantPrincipale, "aucune requête au faux de l'instance principale");
    assert.ok(h.omo.fake.requests.some((r) => r.method === "GET" && r.pathname === `/session/${creee.id}/message`));
    // Classée par heuristique seule (D-2b-05).
    assert.equal(relu.conversation.classifiedBy, "heuristic");
  });

  it("faits écrits pour une racine de la salle, et la dérivation de l'instance principale n'y touche pas", async (t) => {
    const h = await startCockpit(t, { omo: true, modules: ["facts"] });
    assert.ok(h.omo);
    const creee = await h.omo.deps.client.request<OcSession>("POST", "/session", { body: { title: "Racine de la salle" } });
    const faits = () =>
      h.db.prepare("SELECT kind, data FROM activity_facts WHERE root_id = ? ORDER BY id").all(creee.id) as Array<{ kind: string; data: string }>;
    await until(() => faits().length > 0);
    assert.ok(
      faits().some((f) => f.kind === "statut" && f.data.includes('"instance":"omo"')),
      `faits de la salle attendus : ${JSON.stringify(faits())}`,
    );
    // Aucun fait écrit sous une racine de l'instance principale.
    const principales = h.db.prepare("SELECT COUNT(*) AS n FROM activity_facts WHERE root_id != ?").get(creee.id) as { n: number };
    assert.equal(principales.n, 0);
  });
});

describe("L18a : instance-runtime (InstanceDeps de la salle)", () => {
  it("le client porte le mot de passe de la salle, jamais celui de l'instance principale", async (t) => {
    const h = await startCockpit(t, { omo: true });
    assert.ok(h.omo);
    // Une requête authentifiée aboutit sur le faux de la salle : c'est SON mot de passe qui a été présenté.
    const reponse = await h.omo.deps.client.request<{ healthy?: boolean }>("GET", "/global/health");
    assert.ok(reponse);
    const refusees = h.omo.fake.requests.filter((r) => r.authorized === false);
    assert.deepEqual(refusees, []);
    assert.notEqual(h.omo.deps.client.baseUrl, h.deps.client.baseUrl);
    assert.equal(h.omo.deps.client.baseUrl, h.omo.fake.url);
  });

  it("catalogue de la salle : AUCUN abonné onChange (rien ne remonte vers les niveaux ni vers la synchro Copilot)", async (t) => {
    const h = await startCockpit(t, { omo: true });
    assert.ok(h.omo);
    const avant = h.cockpitEvents().length;
    await h.omo.deps.catalog.refresh();
    await h.omo.deps.catalog.refresh();
    assert.deepEqual(
      h.cockpitEvents().slice(avant).filter((e) => e.type === "ai.changed"),
      [],
      "un changement du catalogue de la salle ne publie pas ai.changed",
    );
    // Le catalogue de la salle est un objet distinct de celui de l'instance principale.
    assert.notEqual(h.omo.deps.catalog, h.deps.catalog);
  });

  it("OcLookup de la salle : aucune variante lue dans la configuration de l'instance principale", async (t) => {
    const h = await startCockpit(t, { omo: true });
    assert.ok(h.omo);
    // Une commande globale du cockpit, avec une variante posée dans SON dossier de configuration.
    const dossier = path.join(h.deps.env.opencodeConfigDir, "commands");
    fs.mkdirSync(dossier, { recursive: true });
    fs.writeFileSync(path.join(dossier, "revue.md"), "---\nvariant: rapide\n---\nRevue.\n");
    const commande = { name: "revue", description: "Revue", template: "Relis le code.", hints: [], source: "command" as const };
    h.fake.setCommands([commande]);
    h.omo.fake.setCommands([commande]);

    const principale = await h.deps.lookup.get(null);
    assert.equal(principale.commands.find((c) => c.name === "revue")?.fileVariant, "rapide", "la variante est bien lue pour l'instance principale");
    const salle = await h.omo.deps.lookup.get(null);
    assert.equal(salle.commands.find((c) => c.name === "revue")?.fileVariant, undefined, "la salle ne lit AUCUN fichier du cockpit");
    // Le dossier réservé n'est jamais créé.
    assert.equal(fs.existsSync(path.join(h.deps.env.dataDir, OMO_SANS_CONFIGURATION)), false);
  });

  it("portillon de la salle : registre des réponses émises PROPRE (D-2b-20)", async (t) => {
    const h = await startCockpit(t, { omo: true });
    assert.ok(h.omo);
    assert.notEqual(h.omo.deps.gate, h.cockpit.gate);
    h.cockpit.gate.emitted.record({ requestId: "per_principale", reply: "once", by: "vous", at: T });
    h.omo.deps.gate.emitted.record({ requestId: "per_salle", reply: "reject", by: "cockpit", at: T });
    assert.equal(h.cockpit.gate.emitted.has("per_principale"), true);
    assert.equal(h.cockpit.gate.emitted.has("per_salle"), false, "le registre de l'instance principale ignore la salle");
    assert.equal(h.omo.deps.gate.emitted.has("per_salle"), true);
    assert.equal(h.omo.deps.gate.emitted.has("per_principale"), false, "et inversement");
  });

  it("la dérivation du portillon de la salle est inscrite avec instances [\"omo\"], à la suite de celle du cockpit", async (t) => {
    const h = await startCockpit(t, { omo: true, modules: ["gate"] });
    assert.deepEqual(h.cockpit.wiring.registrations, [
      { kind: "derivation", key: "gate", module: "gate" },
      { kind: "derivation", key: "gate", module: "gate", instances: ["omo"] },
    ]);
    // Salle coupée : une seule inscription, exactement celle de la 1.0.x.
    const sansSalle = await startCockpit(t, { modules: ["gate"] });
    assert.deepEqual(sansSalle.cockpit.wiring.registrations, [{ kind: "derivation", key: "gate", module: "gate" }]);
  });

  it("faits : une dérivation par instance ; sans salle, l'inscription garde sa forme d'origine", async (t) => {
    const avecSalle = await startCockpit(t, { omo: true, modules: ["facts"] });
    assert.deepEqual(avecSalle.cockpit.wiring.registrations, [
      { kind: "derivation", key: "facts", module: "facts" },
      { kind: "derivation", key: "facts", module: "facts", instances: ["omo"] },
      { kind: "routes", key: "activity", module: "facts" },
    ]);
    const sansSalle = await startCockpit(t, { modules: ["facts"] });
    assert.deepEqual(sansSalle.cockpit.wiring.registrations, [
      { kind: "derivation", key: "facts", module: "facts" },
      { kind: "routes", key: "activity", module: "facts" },
    ]);
  });

  it("compteur d'envois facturés PROPRE : un envoi de la salle en vol ne compte jamais pour l'instance principale", async (t) => {
    const h = await startCockpit(t, { omo: true });
    assert.ok(h.omo);
    assert.equal(h.omo.runtime.billedInFlight(), 0);
    const fin = h.omo.deps.beginBilled();
    const fin2 = h.omo.deps.beginBilled();
    assert.equal(h.omo.runtime.billedInFlight(), 2);
    // La garde de rechargement de l'instance principale ne voit rien : elle lit le compteur du proxy principal.
    assert.equal(await h.cockpit.c11.occupancy(), "idle");
    fin();
    fin();
    assert.equal(h.omo.runtime.billedInFlight(), 1, "la fermeture est sans effet au second appel");
    fin2();
    assert.equal(h.omo.runtime.billedInFlight(), 0);
    // Aucun refus d'envoi hérité de l'instance principale : les conditions de la salle sont revérifiées par ses crochets.
    assert.equal(h.omo.deps.billRefusal(), null);
  });

  it("creerInstanceOmo sans salle configurée : l'instance est construite, mais rien n'est demandé tant qu'elle n'est pas démarrée", async (t) => {
    const h = await startCockpit(t);
    const runtime = creerInstanceOmo({
      env: h.deps.env,
      log: h.deps.log,
      db: h.db,
      hub: h.hub,
      sessions: h.sessions,
      ledger: h.ledger,
      archive: h.deps.archive,
      classifier: h.deps.classifier,
      projects: h.deps.projects,
    });
    t.after(() => runtime.close());
    assert.equal(runtime.deps.instance, "omo");
    assert.equal(runtime.deps.processor.instance, "omo");
    assert.equal(runtime.deps.processor.status.connected, false);
    assert.equal(runtime.billedInFlight(), 0);
  });
});
