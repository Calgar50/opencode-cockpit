// Tests de croisement du train de V3 de la Salle OMO (plan d'exécution 2 bis-2 ter §2.3, §5.2 ; propriété de l'intégrateur) :
// L18a (données et événements par instance), L18b (routeur d'instances et proxy de la salle), L18c (salles, statut, arrêt),
// L19b (pré-contrôle en service), L21 (banc hors ligne et manifeste réel).
//
// Ce que la vague doit prouver ENSEMBLE, et qu'aucun paquet ne peut prouver seul :
//   1. l'intégrateur a branché `instance-runtime` (L18a) dans main.ts DERRIÈRE `SALLE_OUVERTE` et les dossiers de COCKPIT_OMO :
//      aucune variable d'environnement n'ouvre la salle, et le flux de la salle démarre avec le reste ;
//   2. harnais complet APRÈS V3 (second processeur RÉEL, proxy de la salle, routes de la salle) = salle toujours coupée :
//      toute route refuse, le bootstrap n'a pas de champ `omo`, et les trois volumes de la salle restent vides ;
//   3. une salle ouverte par la VRAIE route de L18c est vue comme « omo » par le routeur d'instances de L18b : 404 croisé dans
//      les deux sens, sans qu'aucune requête ne parte, et l'arrêt générique de l'it2 rend 404 sans appel ;
//   4. le pré-contrôle RÉEL de L19b sous la route d'ouverture de L18c : projet piégé → 409 masqué, projet sain → 200 ;
//   5. le pré-contrôle de L19b lit les projets ouverts par le service RÉEL de L18c (`omoRoom.openProjects`), et son `precheck-ok`
//      est lié au `start_id` du démarrage ;
//   6. un événement de la salle traité par le PROCESSEUR RÉEL de L18a n'écrit jamais sur une racine de l'instance principale,
//      même à identifiant égal, et la coupure du flux de la salle ne met jamais l'instance principale en « synchro due » ;
//   7. le manifeste RÉEL commité par L21 est celui que le compose et le contrat attendent, et les plafonds relevés par le banc
//      (M22) sont ceux que le compose porte après le train ;
//   8. le défaut n° 2 mesuré par le banc (L21 §3) est corrigé DANS LE PRODUIT : l'image pose `CLAUDE_CONFIG_DIR` hors des cinq
//      dossiers de configuration montés `:ro`, et le contournement du banc ne fait plus que prouver la non-régression.
// Aucun conteneur, aucun réseau, aucune pause fixe : deux faux opencode en mémoire et des lectures de fichiers.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { Hono } from "hono";
import { parse as parseYaml } from "yaml";
import type { Cockpit11, Cockpit11Module, HookSignatures, ProxyContext } from "./contracts-11.ts";
import { forbiddenCommandArguments, forbiddenProxyBody } from "./http.ts";
import { createInstanceRouter } from "./instance-router.ts";
import { createOcProxy, PROXY_RULES, PROXY_RULES_OMO } from "./oc-proxy.ts";
import { createOmoControl } from "./omo-control.ts";
import { type InstanceDeps, OMO_SALLE_CONTRACT_FILE, type OmoStopPort } from "./omo-contracts.ts";
import { createOmoPrecheckService } from "./omo-precheck-service.ts";
import { createOmoRoom } from "./omo-room.ts";
import type { OcGlobalEvent, OcSession } from "./opencode.ts";
import { registerOmoRoutes } from "./routes-omo.ts";
import type { StopResult } from "./shared/cockpit-event-types.ts";
import { analyserPrecheckOk, ecrireEtat } from "./shared/omo-control-protocol.ts";
import type { OmoPreparedProjects, OmoSalleContract, OmoStopCause, OmoSupervisorState } from "./shared/omo-types.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import { createId } from "./test-support/fake-opencode.ts";
import { SALLE_OUVERTE } from "./wiring-11.ts";

const RACINE = path.resolve(import.meta.dirname, "..", "..");
const lire = (...morceaux: string[]) => fs.readFileSync(path.join(RACINE, ...morceaux), "utf8");
const lireServeur = (nom: string) => fs.readFileSync(path.join(import.meta.dirname, nom), "utf8");

const T0 = 1_757_000_000_000;
const EMPREINTE = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const DEMARRAGE = "c0155e11-0a3b-4d7e-9f21-3b8c6d40a915";
/** Second démarrage, qui ne correspond à aucun `state.json` publié. */
const AUTRE_DEMARRAGE = "d1266f22-1b4c-4e8f-8a32-4c9d7e51b026";
const ARRET: StopResult = { rootId: "", rejected: 0, aborted: [], unconfirmed: [], durationMs: 0 };

/**
 * Chemins que le PROCESSEUR d'une instance appelle de lui-même (flux d'événements et rattrapage), sans qu'aucune requête du
 * navigateur ne le demande. Depuis L18a, le faux de la salle les voit dès le démarrage du harnais, comme le faux de l'instance
 * principale les voyait déjà. Les gardes « zéro requête » de ce fichier mesurent le cockpit, pas le processeur.
 */
const CHEMINS_PROCESSEUR = new Set(["/global/event", "/experimental/session"]);

/** Requêtes vues par un faux opencode depuis un repère, hors trafic propre de son processeur. */
const requetes = (fake: CockpitHarness["fake"], depuis = 0) =>
  fake.requests
    .slice(depuis)
    .filter((r) => !CHEMINS_PROCESSEUR.has(r.pathname))
    .map((r) => `${r.method} ${r.pathname}`);

// --- 1. Branchement d'instance-runtime dans main.ts (sortie de la fiche L18a) -----------------------------------------------------

describe("croisement V3 : l'intégrateur a branché instance-runtime derrière SALLE_OUVERTE", () => {
  it("main.ts ne construit l'instance de la salle que si la PORTE DU CODE et les dossiers de COCKPIT_OMO sont là", () => {
    const source = lireServeur("main.ts");
    assert.match(source, /import \{ creerInstanceOmo, type OmoRuntime \} from "\.\/instance-runtime\.ts";/, "instance-runtime importé");
    assert.match(source, /import \{ SALLE_OUVERTE \} from "\.\/wiring-11\.ts";/, "la porte du code est lue dans wiring-11.ts");
    // La condition porte sur la constante ET sur les dossiers de contrôle : COCKPIT_OMO=on seul ne suffit jamais.
    assert.match(source, /SALLE_OUVERTE && omoControlDirs !== null\s*\?\s*creerInstanceOmo\(/, "porte du code ET dossiers de contrôle");
    assert.match(source, /omo: omoRuntime\?\.deps \?\? null,/, "les dépendances de l'instance vont au câblage");
    assert.match(source, /processor\.start\(\);\s*(\/\/[^\n]*\n\s*)*omoRuntime\?\.start\(\);/, "le flux de la salle démarre après celui du cockpit");
    assert.match(source, /omoRuntime\?\.close\(\);/, "le flux de la salle est arrêté avec le cockpit");
  });

  it("aucune variable d'environnement n'ouvre la salle : la porte reste une constante du code, fausse dans le dépôt", () => {
    assert.equal(SALLE_OUVERTE, false, "SALLE_OUVERTE doit rester fausse dans la branche (plan 2 bis §2.7)");
    const source = lireServeur("main.ts");
    // Aucune lecture d'environnement ne vient relayer la porte : la seule condition ajoutée est la constante et les dossiers.
    const ligne = source.split("\n").find((l) => l.includes("SALLE_OUVERTE &&")) ?? "";
    assert.doesNotMatch(ligne, /process\.env|COCKPIT_OMO|env\.omo/, ligne);
  });
});

// --- 2. Harnais complet après V3 : la salle reste coupée --------------------------------------------------------------------------

describe("croisement V3 : harnais complet (omo + tous les modules) = salle toujours coupée", () => {
  it("routes de la salle, proxy de la salle et bootstrap : tout refuse, et les volumes de la salle restent vides", async (t: TestContext) => {
    const h = await startCockpit(t, { modules: "tous", omo: true, settings: { ui: { mode: "avance" } } });
    assert.notEqual(h.omo, null, "le second processeur réel est branché");
    await h.cockpit.startup();

    for (const [methode, chemin, entetes] of [
      ["POST", "/api/omo/rooms", h.headers.confirmed],
      ["GET", "/api/omo/status", h.headers.authed],
      ["GET", "/api/omo/precheck?projet=app", h.headers.authed],
      ["POST", "/api/omo/rooms/ses_inconnue/stop", h.headers.mutating],
      ["GET", "/api/omo/oc/session", h.headers.authed],
    ] as const) {
      const res = await h.call(methode, chemin, { headers: entetes, ...(methode === "POST" ? { body: { projet: "app" } } : {}) });
      assert.equal(res.status, 403, `${methode} ${chemin} : ${res.body}`);
      assert.equal(res.json<{ error: string }>().error, "salle-coupee", `${methode} ${chemin}`);
    }

    const bootstrap = await h.call("GET", "/api/bootstrap", { headers: h.headers.authed });
    assert.equal(bootstrap.status, 200, bootstrap.body);
    assert.equal(Object.hasOwn(bootstrap.json<Record<string, unknown>>(), "omo"), false, "aucun champ omo sans réglages de salle");

    // Le second processeur tourne : il lit le flux de son faux. Il n'a écrit AUCUN fichier dans les volumes de la salle.
    assert.deepEqual(h.omo?.fichiers(), []);
    h.assertNoGlobalRestart();
  });
});

// --- Atelier commun aux croisements 3, 4 et 5 : la salle réellement montée --------------------------------------------------------

const projetsPrepares = (...chemins: string[]): OmoPreparedProjects => ({
  version: 1,
  genereLe: "2026-09-21T10:00:00Z",
  projets: chemins.map((chemin) => ({ chemin, git: "dossier" as const })),
  gitProteges: chemins.map((chemin) => ({ chemin: `${chemin}/.git`, forme: "dossier" as const })),
});

function etatDe(startId: string, projets: readonly string[]): OmoSupervisorState {
  return {
    startId,
    phase: "attente",
    imageId: "sha256:image-de-croisement",
    manifestSha256: EMPREINTE,
    manifesteReference: "ok",
    validation: "ok",
    dossiersConfig: [{ chemin: "/home/node/.config/opencode", ok: true }],
    projets: projets.map((chemin) => ({ chemin, gitLectureSeule: true })),
    workspaceGit: { verifieLe: T0, limiteAtteinte: false, nonProteges: [] },
    startedAt: T0,
  };
}

function ecrireFichier(racine: string, relatif: string, contenu: string): void {
  const cible = path.join(racine, relatif);
  fs.mkdirSync(path.dirname(cible), { recursive: true });
  fs.writeFileSync(cible, contenu, "utf8");
}

/** Projet ordinaire du dossier de travail : un `.git`, un README et des réglages d'IDE. Rien de piégé. */
function fabriquerProjet(workspace: string, nom: string): void {
  ecrireFichier(workspace, `${nom}/.git/HEAD`, "ref: refs/heads/principale\n");
  ecrireFichier(workspace, `${nom}/README.md`, "[synthétique] projet de croisement, aucun secret.\n");
  ecrireFichier(workspace, `${nom}/.vscode/settings.json`, '{"[synthétique]": "réglages d\'IDE"}');
}

/** Piège JS-4 : une configuration d'opencode dans le projet, que les règles pures de L19a refusent. */
const piegerProjet = (workspace: string, nom: string) => ecrireFichier(workspace, `${nom}/opencode.json`, '{"[synthétique]": "configuration piégée"}');

interface Atelier {
  h: CockpitHarness;
  workspace: string;
  /** Ce que le port d'arrêt (L23b, encore absent) a reçu. */
  arrets: Array<{ rootId: string | null; cause: OmoStopCause }>;
  /** Service de contrôle RÉEL de L17b, sur des dossiers temporaires. */
  precheckOk(): ReturnType<typeof analyserPrecheckOk> | null;
  publierEtat(etat: OmoSupervisorState): void;
  /** Demande le pré-contrôle de démarrage, comme la surveillance de `state.json` le ferait. */
  beforeStart(startId: string): Promise<{ ok: boolean; code?: string }>;
  /** Deux montages de proxy, exactement comme createApp les construit (SALLE_OUVERTE fermée dans le dépôt). */
  proxies: Hono;
}

/**
 * Cockpit réel avec la salle branchée : second faux opencode (option `omo`, processeur RÉEL de L18a), service et routes de L18c,
 * pré-contrôle RÉEL de L19b posé sur le même `c11`, écrivain RÉEL de L17b sur des dossiers temporaires. La porte `SALLE_OUVERTE`
 * reste FAUSSE dans le dépôt : un module factice au nom réel l'ouvre pour ce test seul, sans toucher à la constante.
 */
async function atelier(t: TestContext, options: { projets?: string[]; pieges?: string[] } = {}): Promise<Atelier> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "croisement-v3-"));
  t.after(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Dossier temporaire verrouillé : le système le reprendra.
    }
  });
  const dossier = (nom: string) => {
    const complet = path.join(tmp, nom);
    fs.mkdirSync(complet, { recursive: true });
    return complet;
  };
  const workspace = dossier("workspace");
  const controlDir = path.join(tmp, "control-omo");
  const stateDir = dossier("omo-state");
  const authDir = dossier("omo-auth");
  const egressJournal = dossier("egress");
  const projectsFile = path.join(dossier("hote"), "omo-projets.json");

  const noms = options.projets ?? ["app"];
  for (const nom of noms) fabriquerProjet(workspace, nom);
  for (const nom of options.pieges ?? []) piegerProjet(workspace, nom);
  fs.writeFileSync(projectsFile, `${JSON.stringify(projetsPrepares(...noms))}\n`, "utf8");

  const arrets: Atelier["arrets"] = [];
  const omoStop: OmoStopPort = {
    run: async (rootId, cause) => {
      arrets.push({ rootId, cause });
      return { ...ARRET, rootId: rootId ?? "" };
    },
    relaunchAfterRequest: async () => undefined,
  };

  let precheckService: ReturnType<typeof createOmoPrecheckService> | null = null;
  // Module factice au nom réel : les VRAIS service et routes de L18c, et le VRAI pré-contrôle de L19b, sur un c11 dont la seule
  // porte SALLE_OUVERTE est ouverte. `ports` est le même objet que celui de c11 : la route lit donc le pré-contrôle réel.
  const moduleSalle: Cockpit11Module = {
    name: "omoRoom",
    install(reg, c11) {
      const ouvert: Cockpit11 = { ...c11, salleOuverte: true };
      const control = createOmoControl({
        controlDir,
        stateDir,
        authDir,
        opencodeDataDir: dossier("oc-data"),
        cockpitDataDir: dossier("donnees-cockpit"),
        projectsFile: null,
        actif: () => true,
        log: c11.log,
      });
      ouvert.ports.omoControl = control;
      ouvert.ports.omoStop = omoStop;
      ouvert.ports.omoRoom = createOmoRoom({
        db: c11.db,
        sessions: c11.sessions,
        log: c11.log,
        env: c11.env,
        workspace,
        controlDir,
        authDir,
        projectsFile,
        egressJournal,
        ports: () => c11.ports,
        instance: () => c11.instances?.omo ?? null,
        salleOuverte: () => ouvert.salleOuverte,
      });
      // Pré-contrôle RÉEL de L19b : il lit les projets ouverts par le service RÉEL de L18c, posé juste au-dessus.
      precheckService = createOmoPrecheckService({
        workspace,
        projectsFile,
        db: c11.db,
        hub: c11.hub,
        log: c11.log,
        control: () => ouvert.ports.omoControl,
        room: () => ouvert.ports.omoRoom,
        actif: () => true,
      });
      ouvert.ports.omoPrecheck = precheckService;
      t.after(async () => {
        precheckService?.stop();
        await precheckService?.settled();
        control.stopHeartbeat();
        await control.settled();
      });
      reg.routes("omo", (app) => registerOmoRoutes(app, ouvert), { instances: ["omo"] });
    },
  };

  const h = await startCockpit(t, {
    omo: true,
    modules: [moduleSalle],
    settings: { ui: { mode: "avance" } },
    env: { workspaceDir: workspace },
  });

  // Les deux montages du proxy, avec exactement les dépendances que createApp leur donne. La porte du dépôt reste fermée :
  // c'est le montage de test qui traverse, comme dans les tests de L18b.
  const principale: InstanceDeps = {
    instance: "principale",
    client: h.deps.client,
    gate: h.cockpit.gate,
    lookup: h.deps.lookup,
    catalog: h.deps.catalog,
    processor: h.deps.processor,
    billRefusal: () => null,
    beginBilled: () => () => undefined,
    isAllowedDirectory: (directory) => h.deps.projects.isAllowedDirectory(directory),
  };
  const salle = h.omo?.deps as InstanceDeps;
  const instances = createInstanceRouter({ principale, omo: salle, sessions: h.sessions });
  const commun = {
    env: h.deps.env,
    log: h.deps.log,
    projects: h.deps.projects,
    hooks: h.cockpit.wiring,
    instanceOf: (id: string) => instances.instanceOf(id),
    forbiddenProxyBody,
    forbiddenCommandArguments,
    enforceTurn: async (_c: unknown, _sub: string, _directory: string | null, body: string) => body,
  };
  const proxies = new Hono();
  proxies.all("/api/oc/*", createOcProxy({ ...commun, instance: principale, prefix: "/api/oc", rules: PROXY_RULES }));
  proxies.all("/api/omo/oc/*", createOcProxy({ ...commun, instance: salle, prefix: "/api/omo/oc", rules: PROXY_RULES_OMO }));

  return {
    h,
    workspace,
    arrets,
    proxies,
    precheckOk: () => {
      const fichier = path.join(controlDir, "precheck-ok");
      return fs.existsSync(fichier) ? analyserPrecheckOk(fs.readFileSync(fichier, "utf8")) : null;
    },
    publierEtat: (etat) => fs.writeFileSync(path.join(stateDir, "state.json"), ecrireEtat(etat), "utf8"),
    beforeStart: async (startId) => {
      const service = precheckService as ReturnType<typeof createOmoPrecheckService> | null;
      assert.ok(service, "pré-contrôle installé");
      return service.beforeStart(startId);
    },
  };
}

const ouvrirSalle = async (a: Atelier, projet = "app"): Promise<string> => {
  const res = await a.h.call("POST", "/api/omo/rooms", { headers: a.h.headers.confirmed, body: { projet } });
  assert.equal(res.status, 200, res.body);
  return res.json<{ rootId: string }>().rootId;
};

// --- 3. Une salle ouverte par L18c est cloisonnée par le routeur de L18b ----------------------------------------------------------

describe("croisement V3 : la salle ouverte par L18c est cloisonnée par le routeur et le proxy de L18b", () => {
  it("404 croisé dans les deux sens, sans qu'aucune requête ne parte ; l'arrêt générique de l'it2 rend 404 sans appel", async (t: TestContext) => {
    const a = await atelier(t);
    const racineSalle = await ouvrirSalle(a);
    assert.equal(a.h.sessions.get(racineSalle)?.instance, "omo", "la racine de la salle porte son instance");

    // Une racine ordinaire de l'instance principale, créée comme en 1.0.x.
    const creee = await a.h.deps.client.request<OcSession>("POST", "/session", {
      query: { directory: a.h.fake.directory },
      body: { title: "Conversation" },
    });
    a.h.sessions.upsert({ ...creee, directory: a.h.fake.directory } as OcSession, undefined, { instance: "principale" });

    const repairePrincipal = a.h.fake.requests.length;
    const repaireSalle = a.h.omo?.fake.requests.length ?? 0;

    // La racine de la salle est introuvable sur le montage de l'instance principale, et l'inverse est vrai aussi.
    const versPrincipale = await a.proxies.request(`/api/oc/session/${racineSalle}`);
    assert.equal(versPrincipale.status, 404);
    assert.equal(((await versPrincipale.json()) as { error: string }).error, "not-found");
    const versSalle = await a.proxies.request(`/api/omo/oc/session/${creee.id}`);
    assert.equal(versSalle.status, 404);
    assert.equal(((await versSalle.json()) as { error: string }).error, "not-found");

    assert.deepEqual(requetes(a.h.fake, repairePrincipal), [], "aucune requête au faux principal");
    assert.deepEqual(requetes(a.h.omo!.fake, repaireSalle), [], "aucune requête au faux de la salle");

    // « Arrêter » générique de l'it2 sur une racine de la salle : 404 sans aucun appel (C1-3, §5.2 vague 3).
    const arretGenerique = await a.h.call("POST", `/api/conversations/${racineSalle}/stop`, { headers: a.h.headers.mutating });
    assert.equal(arretGenerique.status, 404, arretGenerique.body);
    assert.deepEqual(requetes(a.h.fake, repairePrincipal), [], "aucune requête au faux principal pour l'arrêt générique");
    assert.deepEqual(a.arrets, [], "l'arrêt de la salle n'est pas déclenché par la route générique");

    // La route dédiée de la salle, elle, appelle le port d'arrêt, et rien ne part vers l'instance principale.
    const arretSalle = await a.h.call("POST", `/api/omo/rooms/${racineSalle}/stop`, { headers: a.h.headers.mutating });
    assert.equal(arretSalle.status, 200, arretSalle.body);
    assert.deepEqual(a.arrets, [{ rootId: racineSalle, cause: "vous" }]);
    assert.deepEqual(requetes(a.h.fake, repairePrincipal), [], "aucune requête au faux principal pour l'arrêt de la salle");
    a.h.assertNoGlobalRestart();
  });

  it("T-L18-b : en mode Simple, le proxy du cockpit refuse la salle, et le montage du dépôt reste fermé", async (t: TestContext) => {
    const h = await startCockpit(t, { omo: true });
    const repaire = h.omo?.fake.requests.length ?? 0;
    const res = await h.call("POST", "/api/omo/oc/session/ses_croisement/prompt_async", {
      headers: h.headers.mutating,
      body: { parts: [{ type: "text", text: "Bonjour" }] },
    });
    assert.equal(res.status, 403, res.body);
    assert.deepEqual(requetes(h.omo!.fake, repaire), [], "rien ne part vers la salle en mode Simple");
  });
});

// --- 4 et 5. Pré-contrôle réel de L19b sous la route de L18c ----------------------------------------------------------------------

describe("croisement V3 : le pré-contrôle réel de L19b décide sous la route d'ouverture de L18c", () => {
  it("projet piégé → 409 avec la liste masquée ; projet sain → 200, racine sur le faux de la SALLE, ligne omo_rooms", async (t: TestContext) => {
    const a = await atelier(t, { projets: ["app", "piege"], pieges: ["piege"] });
    const repairePrincipal = a.h.fake.requests.length;

    const refuse = await a.h.call("POST", "/api/omo/rooms", { headers: a.h.headers.confirmed, body: { projet: "piege" } });
    assert.equal(refuse.status, 409, refuse.body);
    const corps = refuse.json<{ error: string; message: string; trouves?: string[] }>();
    // L18c rend le code du VERDICT du port, pas un code générique : ici la règle JS-4 de L19a (configuration d'opencode
    // dans le projet). C'est cette chaîne exacte qui relie le refus rendu au navigateur à la règle qui l'a décidé.
    assert.equal(corps.error, "config-opencode");
    assert.ok(corps.message.length > 0, "une phrase accompagne le refus");
    // Liste masquée : aucun chemin de l'hôte ne sort (le dossier temporaire du test est un chemin d'hôte).
    assert.doesNotMatch(refuse.body, /[A-Za-z]:\\|\/tmp\/|\/var\/folders/, refuse.body);
    assert.doesNotMatch(refuse.body, new RegExp(a.workspace.replaceAll("\\", "\\\\").replaceAll("/", "\\/")), "aucun chemin d'hôte");

    const racine = await ouvrirSalle(a, "app");
    const creations = (a.h.omo?.fake.requests ?? []).filter((r) => r.method === "POST" && r.pathname === "/session");
    assert.equal(creations.length, 1, "la racine naît sur le faux de la salle");
    assert.deepEqual(requetes(a.h.fake, repairePrincipal), [], "aucune requête au faux principal");
    const lignes = a.h.db.prepare("SELECT root_id, projet FROM omo_rooms ORDER BY root_id").all() as Array<{ root_id: string; projet: string }>;
    assert.deepEqual(
      lignes.map((l) => ({ root_id: l.root_id, projet: l.projet })),
      [{ root_id: racine, projet: "app" }],
    );
    assert.equal(a.h.sessions.get(racine)?.instance, "omo");
  });

  it("portée « prepares » bloquante : un projet préparé piégé, JAMAIS ouvert, refuse le démarrage — aucun precheck-ok", async (t: TestContext) => {
    const a = await atelier(t, { projets: ["app", "piege"], pieges: ["piege"] });
    // Seul « app » est ouvert : le piège est dans un projet préparé que personne n'a ouvert.
    await ouvrirSalle(a, "app");
    assert.deepEqual(a.h.cockpit.c11.ports.omoRoom.openProjects(), ["app"], "le pré-contrôle lit les projets ouverts du service réel");

    a.publierEtat(etatDe(DEMARRAGE, ["app", "piege"]));
    const verdict = await a.beforeStart(DEMARRAGE);
    assert.equal(verdict.ok, false, JSON.stringify(verdict));
    assert.equal(a.precheckOk(), null, "aucun precheck-ok : la salle ne démarre pas");
  });

  it("precheck-ok lié au start_id : écrit pour le démarrage contrôlé, jamais pour un autre", async (t: TestContext) => {
    const a = await atelier(t, { projets: ["app"] });
    await ouvrirSalle(a, "app");
    a.publierEtat(etatDe(DEMARRAGE, ["app"]));

    const verdict = await a.beforeStart(DEMARRAGE);
    assert.equal(verdict.ok, true, JSON.stringify(verdict));
    const ecrit = a.precheckOk();
    assert.ok(ecrit, "precheck-ok écrit et relisible");
    assert.equal(ecrit.startId, DEMARRAGE, "lié au démarrage");
    assert.deepEqual(
      ecrit.projets.map((p) => p.chemin),
      ["app"],
    );

    // Un startId qui ne correspond pas à `state.json` ne donne aucun nouveau precheck-ok.
    const autre = await a.beforeStart(AUTRE_DEMARRAGE);
    assert.equal(autre.ok, false, JSON.stringify(autre));
    assert.equal(a.precheckOk()?.startId, DEMARRAGE, "l'ancien precheck-ok n'est pas réécrit");

    // La ligne de démarrage porte le même identifiant, et sa cause reste vide jusqu'à la clôture (D-2b-21).
    const lignes = a.h.db.prepare("SELECT start_id, cause FROM omo_room_starts ORDER BY id").all() as Array<{ start_id: string; cause: string }>;
    assert.equal(lignes.at(-1)?.start_id, DEMARRAGE);
    assert.equal(lignes.at(-1)?.cause, "");
  });
});

// --- 6. Événements : le processeur réel de la salle n'écrit jamais chez l'instance principale ---------------------------------------

describe("croisement V3 : aucune écriture croisée entre instances, même à identifiant égal", () => {
  it("un événement de la salle sur une racine de l'instance principale à identifiant ÉGAL ne reprend rien", async (t: TestContext) => {
    const h = await startCockpit(t, { omo: true, settings: { ui: { mode: "avance" } } });
    const racine = createId("ses");
    // La racine appartient à l'instance PRINCIPALE, avec son titre.
    h.sessions.upsert(
      {
        id: racine,
        projectID: "p",
        directory: "/workspace/app",
        title: "Titre de l'instance principale",
        time: { created: T0, updated: T0 },
      } as OcSession,
      undefined,
      { instance: "principale" },
    );

    const evenement: OcGlobalEvent = {
      directory: "/workspace/app",
      payload: {
        id: createId("evt"),
        type: "session.updated",
        properties: { info: { id: racine, projectID: "p", directory: "/workspace/app", title: "Titre volé par la salle", time: { created: T0, updated: T0 } } },
      },
    };
    await h.emitOmo(evenement);

    const vue = h.sessions.get(racine);
    assert.equal(vue?.instance, "principale", "l'instance de la racine ne change pas");
    assert.equal(vue?.title, "Titre de l'instance principale", "le titre n'est jamais repris par l'autre instance");
  });

  it("coupure du flux de la salle : l'instance principale n'est JAMAIS mise en « synchro due »", async (t: TestContext) => {
    const h = await startCockpit(t, { modules: "tous", omo: true, settings: { ui: { mode: "avance" } } });
    const avant = h.cockpitEvents().length;
    // Le faux de la salle tombe : son processeur publie « omo.connection », jamais « opencode.connection ».
    h.hub.cockpit("omo.connection", { connected: false }, "omo");
    const nouveaux = h.cockpitEvents().slice(avant);
    assert.ok(
      nouveaux.every((e) => e.type !== "opencode.connection"),
      JSON.stringify(nouveaux),
    );
    // Le compte des envois facturés de la salle est le sien : il ne bloque ni le Studio ni le rechargement de l'instance principale.
    assert.equal(h.omo?.runtime.billedInFlight(), 0);
  });
});

// --- 7. Banc de L21 : manifeste réel, plafonds mesurés ------------------------------------------------------------------------------

describe("croisement V3 : le banc de L21 et le compose du produit disent la même chose", () => {
  it("le manifeste commité est la référence RÉELLE, au format de manifest.sh, et il porte tout le contrat", () => {
    const manifeste = lire("docker", "opencode-omo", "omo-manifest.sha256");
    const toutes = manifeste.split("\n").filter((l) => l.trim() !== "");
    // Deux lignes d'en-tête, écrites par build-omo-image.ps1 : la version auditée et l'image de base épinglée.
    const entete = toutes.filter((l) => l.startsWith("#"));
    assert.equal(entete.length, 2, entete.join(" | "));
    assert.match(entete[1] ?? "", /@sha256:[0-9a-f]{64}$/, "image de base épinglée par empreinte");
    const lignes = toutes.filter((l) => !l.startsWith("#"));
    assert.ok(lignes.length > 1_000, `manifeste d'amorce ? ${lignes.length} lignes`);
    // Format de manifest.sh : une empreinte, deux espaces, un chemin absolu du conteneur.
    for (const ligne of lignes.slice(0, 50)) assert.match(ligne, /^[0-9a-f]{64} {2}\//, ligne);
    assert.ok(
      lignes.some((l) => l.includes("/opt/omo/node_modules/oh-my-openagent/")),
      "le manifeste couvre l'extension auditée",
    );
  });

  it("les plafonds du compose sont ceux que la mesure M22 a conclus, et le relevé du banc les relit au lieu d'en garder une copie", () => {
    const compose = lire("docker-compose.yml");
    const bloc = compose.slice(compose.search(/^ {2}opencode-omo:$/m));
    assert.match(bloc, /^\s*pids_limit: 128$/m, "pids_limit ajusté par M22");
    assert.match(bloc, /^\s*cpus: 2$/m, "cpus inchangé");
    assert.match(bloc, /^\s*mem_limit: 1g$/m, "mem_limit ajusté par M22");
    // Le relevé du banc ne porte plus les plafonds en dur : il les lit dans le compose, sinon il mentirait au passage suivant.
    const mesures = lire("e2e", "omo-banc", "scenarios", "mesures.mjs");
    assert.match(mesures, /plafondsActuels: plafondsDuCompose\(/, "le relevé lit le compose");
    assert.doesNotMatch(mesures, /plafondsActuels: \{/, "aucune copie en dur des plafonds");
  });
});

// --- 8. Défaut n° 2 du banc (L21 §3) : le produit pose CLAUDE_CONFIG_DIR hors des cinq dossiers en lecture seule --------------------

/**
 * Le banc hors ligne a mesuré que la salle MEURT au premier envoi sans cette variable : l'extension calcule ses dossiers de
 * travail par `getClaudeConfigDir()`, qui rend `~/.claude` — l'un des cinq dossiers de configuration montés `:ro` (D-2b-33) — et
 * y crée `transcripts` et `todos` même avec `claude_code.hooks: false`. Le rapport L21 §3 demande ce croisement au train de V3 :
 * il tombe si la variable disparaît, ou si sa valeur retombe sous l'un des cinq dossiers. Les cinq chemins sont LUS du contrat.
 */
describe("croisement V3 : la salle peut écrire ses transcriptions (CLAUDE_CONFIG_DIR, défaut n° 2 de L21)", () => {
  const CONTRAT_SALLE = JSON.parse(lire(...OMO_SALLE_CONTRACT_FILE.split("/"))) as OmoSalleContract;
  /** Variables posées par les instructions ENV du Dockerfile de la salle, continuations `\` comprises. */
  const variablesDeLImage = (): Map<string, string> => {
    const texte = lire("docker", "opencode-omo", "Dockerfile").replaceAll(/\\\r?\n/g, " ");
    const map = new Map<string, string>();
    for (const ligne of texte.split("\n")) {
      const env = /^\s*ENV\s+(.*)$/.exec(ligne);
      if (!env) continue;
      for (const paire of (env[1] as string).trim().split(/\s+/)) {
        const k = paire.indexOf("=");
        if (k > 0) map.set(paire.slice(0, k), paire.slice(k + 1));
      }
    }
    return map;
  };

  it("le Dockerfile pose CLAUDE_CONFIG_DIR, en chemin absolu, hors des cinq dossiers de configuration montés `:ro`", () => {
    const valeur = variablesDeLImage().get("CLAUDE_CONFIG_DIR");
    assert.ok(valeur !== undefined, "CLAUDE_CONFIG_DIR a disparu du Dockerfile : la salle mourra au premier envoi (L21 §3)");
    assert.ok(valeur.startsWith("/"), `chemin absolu attendu : ${valeur}`);
    assert.equal(CONTRAT_SALLE.dossiersConfigHome.length, 5, "cinq dossiers de configuration attendus (D-2b-33)");
    for (const dossier of CONTRAT_SALLE.dossiersConfigHome) {
      assert.ok(valeur !== dossier && !valeur.startsWith(`${dossier}/`), `CLAUDE_CONFIG_DIR retombe sous ${dossier}, monté en lecture seule`);
    }
    // Et sous un dossier que `node` peut écrire : un tmpfs du service de la salle, à l'uid de `node`.
    const compose = parseYaml(lire("docker-compose.yml")) as { services: Record<string, { tmpfs?: string[] }> };
    const inscriptibles = (compose.services["opencode-omo"]?.tmpfs ?? [])
      .filter((entree) => entree.includes("uid=1000"))
      .map((entree) => entree.split(":")[0] as string);
    assert.ok(
      inscriptibles.some((point) => valeur.startsWith(`${point}/`)),
      `CLAUDE_CONFIG_DIR (${valeur}) n'est sous aucun tmpfs donné à node : ${inscriptibles.join(", ")}`,
    );
  });

  it("le contournement du banc ne fait plus que prouver la non-régression : il pose la MÊME valeur que le produit", () => {
    const valeur = variablesDeLImage().get("CLAUDE_CONFIG_DIR");
    const contournement = lire("e2e", "omo-banc", "banc-contournement.compose.yml");
    const posee = /^\s*CLAUDE_CONFIG_DIR:\s*(\S+)\s*$/m.exec(contournement)?.[1];
    assert.equal(posee, valeur, "le banc et le produit doivent poser le même chemin, sinon le banc ne mesure plus le produit");
  });
});
