// Tests L23b : arrêt de la Salle OMO (omo-stop.ts) — stopTreeOmo, relance de fin de demande, suspension, crochet `abort` et
// démarrage (spécification §3.12.1, §4.14.4, §3.5, G5 partie hors ligne, JS-1 ; plan 2 bis-2 ter, fiche L23b ; D-2b-29, D-2b-37 ;
// M27, M29).
// Unitaires : serveur de la salle scripté (journal des appels), portillon RÉEL de la salle (registre des réponses émises), ports
// voisins en espions, horloge et pauses injectées : ordre (T-L23-g), ordre inversé (M29), sonde de 15 s et « arrêt non confirmé »,
// boulder.json (T-L23-h), clôture par start_id, relance de fin de demande, suspension, routes appelées (T-L23-a).
// Intégration : harnais du cockpit avec la salle (second faux opencode, processeur RÉEL de L18a), module RÉEL ouvert par un module
// factice au nom réel (SALLE_OUVERTE reste fausse dans le dépôt), écrivain RÉEL de L17b sur des dossiers temporaires : T-L23-a sur
// le vrai faux, T-L23-j (P6 limité à l'instance principale), T-L23-k, redémarrage du cockpit pendant une délégation.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { Context } from "hono";
import type { Cockpit11Module, FactsPort, PermissionGate, ProxyContext } from "./contracts-11.ts";
import { PortUnavailableError } from "./contracts-11.ts";
import { openMemoryDb } from "./db.ts";
import { EventHub } from "./hub.ts";
import { createLogger, type Logger } from "./log.ts";
import type { OmoActivationPort, OmoActiveRequest, OmoControlPort, OmoRoomPort, OmoStopPort } from "./omo-contracts.ts";
import { OMO_STOP_CAUSES } from "./omo-contracts.ts";
import { createOmoControl } from "./omo-control.ts";
import {
  createOmoStop,
  creerModuleOmoStop,
  neutralOmoStop,
  nomBoulderArrete,
  OMO_FENETRE_SUSPENSION_MS,
  OMO_ORDRE_ARRET,
  OMO_SONDE_FENETRE_MS,
  OMO_SONDE_INTERVALLE_MS,
  type OmoOrdreArret,
  omoStopModule,
  REQUEST_END_OF_OMO_STOP,
  STATUT_CAUSE_OF_OMO_STOP,
} from "./omo-stop.ts";
import { type OpencodeClient, OpencodeError } from "./opencode.ts";
import { createPermissionGate } from "./permission-gate.ts";
import { SessionTracker } from "./sessions.ts";
import type { ActivityFact } from "./shared/activity-types.ts";
import type { RequestEnd } from "./shared/autonomy-types.ts";
import type { StopResult } from "./shared/cockpit-event-types.ts";
import { analyserArret, ecrireEtat } from "./shared/omo-control-protocol.ts";
import { OMO_LIMITES } from "./shared/omo-limits.ts";
import type { OmoStopCause, OmoSupervisorPhase, OmoSupervisorState } from "./shared/omo-types.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import type { FakeSession } from "./test-support/fake-opencode.ts";
import { assertSubsequence, bash, promptAsync, until, within } from "./test-support/helpers.ts";

const ROOT = "ses_racine";
const CHILD = "ses_enfant";
const SALLE2 = "ses_salle2";
const ORPHELINE = "ses_orpheline";
const PRINCIPALE = "ses_principale";
const DIR_A = "/workspace/app";
const DIR_B = "/workspace/lib";
const START = "0f5c3b1e-1111-4111-8111-000000000001";
const START_AUTRE = "0f5c3b1e-1111-4111-8111-000000000002";
const START_ANCIEN = "0f5c3b1e-1111-4111-8111-000000000003";

/** Routes que l'arrêt de la salle peut appeler, et elles seules (en-tête de omo-stop.ts). */
const ROUTES_PERMISES: readonly RegExp[] = [
  /^GET \/permission$/,
  /^POST \/permission\/[A-Za-z0-9_-]+\/reply$/,
  /^GET \/session\/status$/,
  /^POST \/session\/[A-Za-z0-9_-]+\/abort$/,
  /^GET \/global\/health$/,
];

/** Routes qui ne doivent JAMAIS partir d'un arrêt : commande, nouveau message, suppression, rechargement (T-L23-a, T-L23-j, T-L23-k). */
const ROUTES_INTERDITES = /\/command$|\/prompt(?:_async)?$|\/message$|\/shell$|\/summarize$|stop-continuation|\/dispose$|\/global\/config$/;

/** state.json tel que le superviseur le publie. */
function etat(startId: string, phase: OmoSupervisorPhase = "opencode-lance"): OmoSupervisorState {
  return {
    startId,
    phase,
    imageId: "",
    manifestSha256: "",
    manifesteReference: "ok",
    validation: "ok",
    dossiersConfig: [{ chemin: "/home/node/.omo", ok: true }],
    projets: [{ chemin: "app", gitLectureSeule: true }],
    workspaceGit: { verifieLe: 1, limiteAtteinte: false, nonProteges: [] },
    startedAt: 1,
  };
}

/** Dossier temporaire nettoyé après le test (les liens posés sont retirés AVANT, sans récursion). */
function atelier(t: TestContext): { racine: string; dossier(nom: string): string; poser(relatif: string, contenu: string): void; lier(cible: string, chemin: string): boolean } {
  const racine = fs.mkdtempSync(path.join(os.tmpdir(), "omo-stop-"));
  const liens: string[] = [];
  t.after(() => {
    for (const lien of liens) {
      try {
        fs.rmdirSync(lien);
      } catch {
        try {
          fs.unlinkSync(lien);
        } catch {
          // Lien déjà retiré.
        }
      }
    }
    try {
      fs.rmSync(racine, { recursive: true, force: true });
    } catch {
      // Dossier temporaire verrouillé : le système le reprendra.
    }
  });
  const dossier = (nom: string) => {
    const complet = path.join(racine, ...nom.split("/"));
    fs.mkdirSync(complet, { recursive: true });
    return complet;
  };
  const poser = (relatif: string, contenu: string) => {
    const complet = path.join(racine, ...relatif.split("/"));
    fs.mkdirSync(path.dirname(complet), { recursive: true });
    fs.writeFileSync(complet, contenu, "utf8");
  };
  /** Lien de dossier (symbolique, sinon jonction sous Windows) ; false si le disque refuse les deux. */
  const lier = (cible: string, chemin: string): boolean => {
    for (const type of ["dir", "junction"] as const) {
      try {
        fs.symlinkSync(cible, chemin, type);
        liens.push(chemin);
        return fs.lstatSync(chemin).isSymbolicLink();
      } catch {
        // Essai suivant.
      }
    }
    return false;
  };
  return { racine, dossier, poser, lier };
}

/** Fichiers sous `racine` (chemins relatifs, « / »), sans suivre les liens, triés. */
function fichiers(racine: string): string[] {
  const sortie: string[] = [];
  const descendre = (relatif: string) => {
    for (const entree of fs.readdirSync(path.join(racine, relatif), { withFileTypes: true })) {
      const chemin = relatif === "" ? entree.name : `${relatif}/${entree.name}`;
      if (entree.isSymbolicLink()) continue;
      if (entree.isDirectory()) descendre(chemin);
      else if (entree.isFile()) sortie.push(chemin);
    }
  };
  descendre("");
  return sortie.sort();
}

// --- Unitaires : serveur de la salle scripté ---------------------------------------------------------------------------------------

/**
 * Comportement du superviseur après stop-request :
 * - obeit : opencode arrêté, /global/health ne répond plus (erreur réseau) ;
 * - obeit-tard : idem, mais seulement à partir de la 4e sonde ;
 * - sourd : rien ne change, /global/health répond toujours ;
 * - http : /global/health rend une erreur HTTP (un serveur répond encore) ;
 * - etat-arret : /global/health répond, mais state.json passe en phase « arret » ;
 * - nouveau-demarrage : /global/health répond, mais state.json montre un autre démarrage.
 */
type Superviseur = "obeit" | "obeit-tard" | "sourd" | "http" | "etat-arret" | "nouveau-demarrage";

interface OptionsUnite {
  occupees?: Array<[string, string | null]>;
  attentes?: Array<{ id: string; sessionID: string; dossier: string | null }>;
  /** Sessions qu'un abandon ne met pas au repos. */
  tetues?: string[];
  superviseur?: Superviseur;
  /** state.json au départ ; absent : démarrage START en phase opencode-lance ; null : illisible. */
  etat?: OmoSupervisorState | null;
  statusFails?: boolean;
  projets?: string[];
  active?: OmoActiveRequest | null;
  ordre?: OmoOrdreArret;
  /** Instance de la salle absente (aucun client). */
  sansInstance?: boolean;
  /** Durée de chaque requête à la salle, comptée sur l'horloge injectée (échéance de la file des réponses). */
  lent?: number;
}

function salleScriptee(options: OptionsUnite, journal: string[], attendre: (ms: number) => void = () => undefined) {
  const occupees = new Map<string, string | null>(options.occupees ?? []);
  const attentes = (options.attentes ?? []).map((a) => ({ ...a }));
  const appels: Array<{ route: string; directory: string | null; body: unknown }> = [];
  let arrete = false;
  let sondes = 0;
  const request = async (method: string, pathname: string, init: { query?: Record<string, unknown>; body?: unknown } = {}): Promise<unknown> => {
    const directory = typeof init.query?.directory === "string" ? init.query.directory : null;
    const route = `${method} ${pathname}`;
    journal.push(route);
    appels.push({ route, directory, body: init.body });
    if (options.lent !== undefined) attendre(options.lent);
    if (route === "GET /permission") return attentes.filter((a) => a.dossier === directory).map(({ id, sessionID }) => ({ id, sessionID }));
    if (route === "GET /session/status") {
      if (options.statusFails) throw new Error("états illisibles");
      return Object.fromEntries([...occupees].filter(([, dossier]) => dossier === directory).map(([id]) => [id, { type: "busy" }]));
    }
    const reponse = /^POST \/permission\/([^/]+)\/reply$/.exec(route);
    if (reponse) {
      const trouvee = attentes.find((a) => a.id === reponse[1]);
      if (!trouvee) throw new OpencodeError(404, { _tag: "PermissionNotFoundError" });
      // F-c : un refus retire toutes les demandes de la même session.
      for (let i = attentes.length - 1; i >= 0; i--) if (attentes[i]?.sessionID === trouvee.sessionID) attentes.splice(i, 1);
      return true;
    }
    const abandon = /^POST \/session\/([^/]+)\/abort$/.exec(route);
    if (abandon) {
      const id = abandon[1] ?? "";
      if (!options.tetues?.includes(id)) occupees.delete(id);
      return true;
    }
    if (route === "GET /global/health") {
      sondes++;
      const superviseur = options.superviseur ?? "obeit";
      if (arrete && superviseur === "obeit") throw new TypeError("fetch failed");
      if (arrete && superviseur === "obeit-tard" && sondes >= 4) throw new TypeError("fetch failed");
      if (arrete && superviseur === "http") throw new OpencodeError(503, null);
      return { healthy: true, version: "1.18.30" };
    }
    throw new Error(`route inattendue : ${route}`);
  };
  return {
    client: { request } as unknown as OpencodeClient,
    appels,
    occupees,
    attentes,
    arreter: () => {
      arrete = true;
    },
  };
}

/** Portillon RÉEL de la salle dont la file et le registre sont notés au journal. */
function portillonJournalise(gate: PermissionGate, journal: string[]): PermissionGate {
  return {
    ...gate,
    acquire: async () => {
      const release = await gate.acquire();
      journal.push("file:prise");
      let rendue = false;
      return () => {
        if (!rendue) {
          rendue = true;
          journal.push("file:rendue");
        }
        release();
      };
    },
    emitted: {
      record: (entry) => {
        journal.push(`registre ${entry.requestId} ${entry.reply} ${entry.by}`);
        gate.emitted.record(entry);
      },
      has: (id) => gate.emitted.has(id),
    },
  };
}

function unite(t: TestContext, options: OptionsUnite = {}) {
  const journal: string[] = [];
  const db = openMemoryDb();
  t.after(() => db.close());
  let horloge = 1_000_000;
  const now = () => horloge;
  const avancer = (ms: number) => {
    horloge += ms;
  };
  const salle = salleScriptee(options, journal, avancer);
  const sessions = new SessionTracker(db, salle.client);
  const ajouter = (id: string, directory: string, instance: "omo" | "principale", parentID?: string) =>
    sessions.upsert({ id, ...(parentID ? { parentID } : {}), projectID: "global", directory, title: id, time: { created: 1, updated: 1 } }, undefined, { instance });
  ajouter(ROOT, DIR_A, "omo");
  ajouter(CHILD, DIR_A, "omo", ROOT);
  ajouter(ORPHELINE, DIR_A, "omo");
  ajouter(SALLE2, DIR_B, "omo");
  ajouter(PRINCIPALE, "/workspace/principal", "principale");

  // Dossier de travail : deux projets ouverts, chacun avec son carnet.
  const at = atelier(t);
  const workspace = at.dossier("workspace");
  at.poser("workspace/app/.omo/boulder.json", '{"plan":"app"}');
  at.poser("workspace/lib/.omo/boulder.json", '{"plan":"lib"}');

  const inserer = db.prepare("INSERT INTO omo_room_starts (started_at, image_id, manifest_sha256, precheck, cause, start_id, ended_at, fin) VALUES (1, '', '', '[]', ?, ?, ?, ?)");
  inserer.run("", START, null, null);
  inserer.run("", START_AUTRE, null, null);
  inserer.run("vous", START_ANCIEN, 5, "arret-confirme");

  const pauses: number[] = [];
  const journaux: Array<{ niveau: "info" | "warn"; message: string; fields: Record<string, unknown> | undefined }> = [];
  const log: Logger = {
    ...createLogger("error"),
    info: (message, fields) => {
      journal.push(`journal ${message}`);
      journaux.push({ niveau: "info", message, fields });
    },
    warn: (message, fields) => {
      journal.push(`journal ${message}`);
      journaux.push({ niveau: "warn", message, fields });
    },
  };

  let etatCourant: OmoSupervisorState | null = options.etat === undefined ? etat(START) : options.etat;
  const stopRequests: string[] = [];
  const suspensions: string[] = [];
  let battementsArretes = 0;
  const control: OmoControlPort = {
    startHeartbeat: () => undefined,
    stopHeartbeat: () => {
      journal.push("battement arrêté");
      battementsArretes++;
    },
    requestStop: async (cause) => {
      journal.push(`stop-request ${cause}`);
      stopRequests.push(cause);
      salle.arreter();
      const superviseur = options.superviseur ?? "obeit";
      if (superviseur === "etat-arret" && etatCourant !== null) etatCourant = { ...etatCourant, phase: "arret" };
      if (superviseur === "nouveau-demarrage") etatCourant = etat(START_AUTRE, "attente");
    },
    writePrecheckOk: async () => undefined,
    writeGuardState: async () => undefined,
    publishAuth: async () => undefined,
    readState: async () => etatCourant,
    suspend: (raison) => {
      journal.push(`suspendue ${raison}`);
      suspensions.push(raison);
    },
    resume: () => undefined,
    suspended: () => false,
  };
  const projets = options.projets ?? ["app", "lib"];
  const omoRoom: OmoRoomPort = {
    open: async () => assert.fail("ouverture inattendue"),
    status: async () => assert.fail("statut inattendu"),
    openProjects: () => [...projets],
    isRoomRoot: (id) => id === ROOT || id === SALLE2,
  };
  let active: OmoActiveRequest | null = options.active === undefined ? null : options.active;
  const fins: Array<[string, RequestEnd]> = [];
  const omoActivation: OmoActivationPort = {
    view: async () => null,
    put: async () => assert.fail("activation inattendue"),
    consume: async () => assert.fail("envoi inattendu"),
    activeRequest: () => active,
    endRequest: (rootId, fin) => {
      journal.push(`fin ${rootId} ${fin}`);
      fins.push([rootId, fin]);
    },
  };
  const faits: ActivityFact[] = [];
  const facts: FactsPort = {
    append: (liste) => {
      for (const fait of liste) {
        journal.push(`fait ${fait.kind} ${String(fait.data.cause)}`);
        faits.push(fait);
      }
    },
    since: () => ({ facts: [], partial: false }),
    work: { markDelegation: () => assert.fail("aucune délégation marquée par l'arrêt de la salle"), markWait: () => false },
  };
  const evenements: Array<{ type: string; data: unknown; instance: string | undefined }> = [];
  const hub = {
    cockpit: (type: string, data: unknown, instance?: string) => {
      const etatRecreation = type === "omo.recreation" ? ` ${(data as { etat: string }).etat}` : "";
      journal.push(`evenement ${type}${etatRecreation}`);
      evenements.push({ type, data, instance });
    },
  };
  const gate = portillonJournalise(createPermissionGate({ client: salle.client, db, log: createLogger("error"), hub: new EventHub(), sessions, instance: "omo" }), journal);
  const stop = createOmoStop(
    {
      instance: () => (options.sansInstance ? null : { client: salle.client, gate }),
      db,
      sessions,
      hub,
      log,
      workspace,
      ports: () => ({ omoControl: control, omoRoom, omoActivation, facts }),
    },
    {
      now,
      sleep: async (ms) => {
        journal.push(`pause ${ms}`);
        pauses.push(ms);
        avancer(ms);
      },
      ...(options.ordre ? { ordre: options.ordre } : {}),
    },
  );
  const lignes = () =>
    (db.prepare("SELECT start_id, cause, ended_at, fin FROM omo_room_starts ORDER BY id").all() as Array<Record<string, unknown>>).map((l) => ({ ...l }));
  return {
    ...salle,
    journal,
    db,
    gate,
    stop,
    at,
    workspace,
    now,
    avancer,
    pauses,
    journaux,
    stopRequests,
    suspensions,
    fins,
    faits,
    evenements,
    lignes,
    battementsArretes: () => battementsArretes,
    setActive: (valeur: OmoActiveRequest | null) => {
      active = valeur;
    },
    setEtat: (valeur: OmoSupervisorState | null) => {
      etatCourant = valeur;
    },
  };
}

const DEMANDE: OmoActiveRequest = { rootId: ROOT, requestId: "req_1", startedAt: 1, plafondUsd: "2.00" };

/** Routes du journal (hors pauses, ports et journal). */
const routes = (journal: readonly string[]) => journal.filter((e) => /^(?:GET|POST|PUT|PATCH|DELETE) /.test(e));

describe("L23b : stopTreeOmo (unitaires)", () => {
  it("T-L23-g : ordre — demande marquée → file de la salle prise → refus de TOUTES les attentes (registre avant l'envoi) → racine, autres racines de salle, reste → file rendue → stop-request → sonde → boulder.json → clôture → fait, conversation.arretee, omo.recreation", async (t) => {
    const s = unite(t, {
      occupees: [
        [ROOT, DIR_A],
        [CHILD, DIR_A],
        [ORPHELINE, DIR_A],
        [SALLE2, DIR_B],
      ],
      attentes: [
        { id: "per_racine", sessionID: ROOT, dossier: DIR_A },
        { id: "per_enfant_a", sessionID: CHILD, dossier: DIR_A },
        { id: "per_enfant_b", sessionID: CHILD, dossier: DIR_A },
        { id: "per_salle2", sessionID: SALLE2, dossier: DIR_B },
      ],
      active: DEMANDE,
    });
    const debut = s.now();

    const result = await s.stop.run(ROOT, "vous");

    assertSubsequence(s.journal, [
      `fin ${ROOT} vous`,
      "file:prise",
      "GET /permission",
      "GET /permission",
      "GET /permission",
      "registre per_racine reject cockpit",
      "POST /permission/per_racine/reply",
      "registre per_enfant_a reject cockpit",
      "POST /permission/per_enfant_a/reply",
      "registre per_enfant_b reject cockpit",
      "POST /permission/per_enfant_b/reply",
      "registre per_salle2 reject cockpit",
      "POST /permission/per_salle2/reply",
      "GET /session/status",
      `POST /session/${ROOT}/abort`,
      `POST /session/${SALLE2}/abort`,
      `POST /session/${CHILD}/abort`,
      `POST /session/${ORPHELINE}/abort`,
      "file:rendue",
      "stop-request vous",
      "evenement omo.recreation demandee",
      "GET /global/health",
      "journal arrêt de la salle : boulder.json mis de côté",
      "journal arrêt de la salle : boulder.json mis de côté",
      "fait statut arret",
      "evenement conversation.arretee",
      "evenement omo.recreation arret-confirme",
      "journal arrêt de la salle",
    ]);
    // Chaque refus est inscrit au registre de la SALLE avant son envoi (P9, base de la détection 1).
    for (const id of ["per_racine", "per_enfant_a", "per_enfant_b", "per_salle2"]) {
      assert.ok(s.journal.indexOf(`registre ${id} reject cockpit`) < s.journal.indexOf(`POST /permission/${id}/reply`), id);
      assert.equal(s.gate.emitted.has(id), true, id);
    }
    // Les trois dossiers de la salle (défaut de l'instance, puis ceux de ses sessions), jamais celui de l'instance principale.
    assert.deepEqual(
      s.appels.filter((a) => a.route === "GET /permission").map((a) => a.directory),
      [null, DIR_A, DIR_B],
    );
    assert.equal(
      s.appels.some((a) => a.directory === "/workspace/principal"),
      false,
    );
    // Refus « reject » seulement, jamais de message.
    for (const appel of s.appels.filter((a) => a.route.endsWith("/reply"))) assert.deepEqual(appel.body, { reply: "reject" });
    // Abandon de la racine dans le dossier où elle a été vue.
    assert.equal(s.appels.find((a) => a.route === `POST /session/${ROOT}/abort`)?.directory, DIR_A);
    assert.equal(s.appels.find((a) => a.route === `POST /session/${SALLE2}/abort`)?.directory, DIR_B);
    // Arrêt confirmé à la première sonde : ni pause, ni battement arrêté.
    assert.deepEqual(s.pauses, []);
    assert.equal(s.battementsArretes(), 0);

    assert.deepEqual(result, { rootId: ROOT, rejected: 4, aborted: [ROOT, SALLE2, CHILD, ORPHELINE], unconfirmed: [], durationMs: 0 });
    assert.deepEqual(s.fins, [[ROOT, "vous"]]);
    assert.deepEqual(s.stopRequests, ["vous"]);
    assert.deepEqual(
      s.faits.map((f) => [f.rootId, f.sessionId, f.kind, f.data]),
      [[ROOT, ROOT, "statut", { cause: "arret", motif: "vous", nonConfirmees: 0, debut }]],
    );
    assert.deepEqual(s.evenements, [
      { type: "omo.recreation", data: { etat: "demandee", raison: "vous" }, instance: "omo" },
      { type: "conversation.arretee", data: { rootId: ROOT, cause: "vous", unconfirmed: [] }, instance: "omo" },
      { type: "omo.recreation", data: { etat: "arret-confirme", raison: "vous" }, instance: "omo" },
    ]);
    // Clôture de la ligne du démarrage visé seulement (par start_id).
    assert.deepEqual(s.lignes(), [
      { start_id: START, cause: "vous", ended_at: debut, fin: "arret-confirme" },
      { start_id: START_AUTRE, cause: "", ended_at: null, fin: null },
      { start_id: START_ANCIEN, cause: "vous", ended_at: 5, fin: "arret-confirme" },
    ]);
  });

  it("M29 : l'ordre « abandon puis stop-request » est celui du dépôt, et configurable (« arret-puis-abandon » : le processus d'abord)", async (t) => {
    assert.equal(OMO_ORDRE_ARRET, "abandon-puis-arret");
    const defaut = unite(t, { occupees: [[ROOT, DIR_A]] });
    await defaut.stop.run(ROOT, "plafond-cout");
    assertSubsequence(defaut.journal, ["file:prise", `POST /session/${ROOT}/abort`, "file:rendue", "stop-request plafond-cout", "GET /global/health"]);

    const inverse = unite(t, { occupees: [[ROOT, DIR_A]], ordre: "arret-puis-abandon" });
    await inverse.stop.run(ROOT, "plafond-cout");
    assertSubsequence(inverse.journal, ["stop-request plafond-cout", "evenement omo.recreation demandee", "file:prise", `POST /session/${ROOT}/abort`, "file:rendue", "GET /global/health"]);
    assert.ok(inverse.journal.indexOf("stop-request plafond-cout") < inverse.journal.indexOf("file:prise"));
  });

  it("T-L23-a : pendant ET après l'arrêt comme la relance, seules les routes permises partent — zéro /command, aucun message, aucune suppression, aucun rechargement", async (t) => {
    const s = unite(t, {
      occupees: [
        [ROOT, DIR_A],
        [CHILD, DIR_A],
      ],
      attentes: [{ id: "per_racine", sessionID: ROOT, dossier: DIR_A }],
      active: DEMANDE,
    });
    await s.stop.run(ROOT, "hors-controle");
    await s.stop.relaunchAfterRequest(ROOT);
    // « Après » : rien ne reste planifié par l'arrêt.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const parties = routes(s.journal);
    assert.ok(parties.length > 0);
    for (const route of parties) {
      assert.ok(
        ROUTES_PERMISES.some((re) => re.test(route)),
        `route non permise pendant l'arrêt : ${route}`,
      );
      assert.doesNotMatch(route, ROUTES_INTERDITES);
    }
    assert.equal(parties.filter((r) => r.endsWith("/command")).length, 0);
  });

  it("sonde : 15 s au plus, toutes les 500 ms ; sans confirmation → « arrêt non confirmé » journalisé, battement arrêté, sessions restées occupées rendues ; démarrage clos « arret-non-confirme »", async (t) => {
    const s = unite(t, { occupees: [[ROOT, DIR_A]], tetues: [ROOT], superviseur: "sourd", active: DEMANDE });
    const debut = s.now();
    const result = await s.stop.run(ROOT, "plafond-duree");

    assert.equal(OMO_SONDE_FENETRE_MS, 15_000);
    assert.equal(OMO_SONDE_INTERVALLE_MS, 500);
    assert.deepEqual(s.pauses, Array.from({ length: OMO_SONDE_FENETRE_MS / OMO_SONDE_INTERVALLE_MS }, () => OMO_SONDE_INTERVALLE_MS));
    assert.equal(s.journal.filter((e) => e === "GET /global/health").length, OMO_SONDE_FENETRE_MS / OMO_SONDE_INTERVALLE_MS + 1);
    assert.equal(s.battementsArretes(), 1);
    assertSubsequence(s.journal, [
      "stop-request plafond-duree",
      "GET /global/health",
      "pause 500",
      "GET /global/health",
      "journal arrêt de la salle non confirmé : battement arrêté, l'homme mort l'arrête en 30 s",
      "battement arrêté",
      "journal arrêt de la salle : boulder.json mis de côté",
      "fait statut plafond",
      "evenement omo.recreation arret-non-confirme",
    ]);
    assert.deepEqual(result.unconfirmed, [ROOT]);
    assert.equal(result.durationMs, OMO_SONDE_FENETRE_MS);
    assert.equal(s.faits[0]?.data.nonConfirmees, 1);
    assert.deepEqual(s.lignes()[0], { start_id: START, cause: "plafond-duree", ended_at: debut + OMO_SONDE_FENETRE_MS, fin: "arret-non-confirme" });
  });

  it("confirmation : plus de réponse de /global/health, phase « arret » ou autre démarrage dans state.json ; une erreur HTTP n'en est pas une", async (t) => {
    const cas: Array<[Superviseur, number, "arret-confirme" | "arret-non-confirme"]> = [
      ["obeit", 0, "arret-confirme"],
      ["obeit-tard", 3, "arret-confirme"],
      ["etat-arret", 0, "arret-confirme"],
      ["nouveau-demarrage", 0, "arret-confirme"],
      ["http", OMO_SONDE_FENETRE_MS / OMO_SONDE_INTERVALLE_MS, "arret-non-confirme"],
    ];
    for (const [superviseur, pauses, fin] of cas) {
      const s = unite(t, { superviseur });
      await s.stop.run(ROOT, "vous");
      assert.equal(s.pauses.length, pauses, superviseur);
      assert.equal(s.lignes()[0]?.fin, fin, superviseur);
      assert.equal(s.battementsArretes(), fin === "arret-confirme" ? 0 : 1, superviseur);
    }
  });

  it("T-L23-h : boulder.json de chaque projet ouvert renommé sans collision, jamais supprimé ni écrasé ; `.omo` lien vers un dossier extérieur → RIEN n'est renommé, fait journalisé", async (t) => {
    const s = unite(t, { projets: ["app", "lib", "lien", "vide"] });
    // Collision : le nom visé existe déjà dans lib.
    const nom = nomBoulderArrete(s.now());
    assert.equal(nom, `boulder.arrete-${s.now()}.json`);
    s.at.poser(`workspace/lib/.omo/${nom}`, "ancien");
    // `.omo` de « lien » : un lien vers un dossier HORS du dossier de travail.
    s.at.poser("dehors/.omo/boulder.json", '{"plan":"dehors"}');
    s.at.dossier("workspace/lien");
    assert.ok(s.at.lier(path.join(s.at.racine, "dehors", ".omo"), path.join(s.workspace, "lien", ".omo")), "lien de dossier impossible sur ce disque");
    s.at.dossier("workspace/vide");
    const avant = fichiers(s.at.racine);

    await s.stop.run(ROOT, "vous");

    const apres = fichiers(s.at.racine);
    assert.equal(apres.length, avant.length, "aucun fichier supprimé");
    assert.equal(fs.readFileSync(path.join(s.workspace, "app", ".omo", nom), "utf8"), '{"plan":"app"}');
    assert.equal(fs.readFileSync(path.join(s.workspace, "lib", ".omo", `${nom}-2`), "utf8"), '{"plan":"lib"}');
    assert.equal(fs.readFileSync(path.join(s.workspace, "lib", ".omo", nom), "utf8"), "ancien", "l'existant n'est jamais écrasé");
    for (const projet of ["app", "lib"]) assert.equal(fs.existsSync(path.join(s.workspace, projet, ".omo", "boulder.json")), false, projet);
    // Le lien : rien n'a bougé, ni derrière lui ni à côté.
    assert.equal(fs.readFileSync(path.join(s.at.racine, "dehors", ".omo", "boulder.json"), "utf8"), '{"plan":"dehors"}');
    assert.deepEqual(fs.readdirSync(path.join(s.at.racine, "dehors", ".omo")), ["boulder.json"]);
    assert.deepEqual(
      s.journaux.filter((j) => j.message.startsWith("arrêt de la salle : boulder.json")).map((j) => [j.niveau, j.message, j.fields]),
      [
        ["info", "arrêt de la salle : boulder.json mis de côté", { projet: "app", nom }],
        ["info", "arrêt de la salle : boulder.json mis de côté", { projet: "lib", nom: `${nom}-2` }],
        ["warn", "arrêt de la salle : boulder.json non renommé, un lien est sur son chemin", { projet: "lien", raison: "lien-symbolique" }],
      ],
    );
  });

  it("clôture par start_id : toutes les lignes OUVERTES du démarrage visé, aucune autre, jamais une ligne déjà close ; démarrage inconnu → aucune ligne close, fait journalisé", async (t) => {
    const s = unite(t);
    s.db.prepare("INSERT INTO omo_room_starts (started_at, image_id, manifest_sha256, precheck, cause, start_id) VALUES (2, '', '', '[]', '', ?)").run(START);
    s.db
      .prepare("INSERT INTO omo_room_starts (started_at, image_id, manifest_sha256, precheck, cause, start_id, ended_at, fin) VALUES (3, '', '', '[]', 'homme-mort', ?, 7, 'arret-non-confirme')")
      .run(START);
    await s.stop.run(ROOT, "seuil-mensuel");
    assert.deepEqual(
      s.lignes().map((l) => [l.start_id, l.cause, l.ended_at, l.fin]),
      [
        [START, "seuil-mensuel", s.now(), "arret-confirme"],
        [START_AUTRE, "", null, null],
        [START_ANCIEN, "vous", 5, "arret-confirme"],
        [START, "seuil-mensuel", s.now(), "arret-confirme"],
        [START, "homme-mort", 7, "arret-non-confirme"],
      ],
    );

    const inconnu = unite(t, { etat: null });
    await inconnu.stop.run(ROOT, "vous");
    assert.deepEqual(
      inconnu.lignes().map((l) => l.ended_at),
      [null, null, 5],
    );
    assert.ok(inconnu.journaux.some((j) => j.niveau === "warn" && j.message === "arrêt de la salle : démarrage inconnu, aucune ligne omo_room_starts close"));
    // Sans démarrage connu, seule la sonde HTTP peut confirmer : ici elle le fait (le superviseur obéit).
    assert.deepEqual(inconnu.stopRequests, ["vous"]);
  });

  it("relance de fin de demande : stop-request « fin-de-demande » SANS renommer boulder.json, sans refus, sans abandon, sans marquer la demande ; démarrage clos ; omo.recreation {raison: fin-de-demande}", async (t) => {
    const s = unite(t, { occupees: [[ROOT, DIR_A]], attentes: [{ id: "per_racine", sessionID: ROOT, dossier: DIR_A }] });
    const avant = fichiers(s.at.racine);
    await s.stop.relaunchAfterRequest(ROOT);

    assert.deepEqual(s.stopRequests, ["fin-de-demande"]);
    assert.deepEqual(fichiers(s.at.racine), avant, "boulder.json jamais renommé en fin de demande");
    assert.deepEqual(routes(s.journal), ["GET /global/health"]);
    assert.equal(s.journal.includes("file:prise"), false);
    assert.deepEqual(s.fins, []);
    assert.deepEqual(s.faits, []);
    assert.deepEqual(s.evenements, [
      { type: "omo.recreation", data: { etat: "demandee", raison: "fin-de-demande" }, instance: "omo" },
      { type: "omo.recreation", data: { etat: "arret-confirme", raison: "fin-de-demande" }, instance: "omo" },
    ]);
    assert.deepEqual(s.lignes()[0], { start_id: START, cause: "fin-de-demande", ended_at: s.now(), fin: "arret-confirme" });
    assert.deepEqual(s.suspensions, []);
  });

  it("relecture 2ter-vague-4 : enCours() vrai dès l'appel de run ou de relaunchAfterRequest (demande close, stop-request pas encore écrit) et jusqu'à la fin de la sonde, faux ensuite", async (t) => {
    const s = unite(t, { occupees: [[ROOT, DIR_A]], active: DEMANDE });
    assert.equal(s.stop.enCours?.(), false, "aucun arrêt");
    // File des réponses de la salle tenue par le test : l'arrêt attend à l'étape 2, demande déjà close (étape 1).
    const liberer = await s.gate.acquire();
    const arret = s.stop.run(ROOT, "vous");
    assert.equal(s.stop.enCours?.(), true, "posé de façon synchrone par run");
    await until(() => s.fins.length > 0);
    assert.deepEqual([s.fins.length, s.stopRequests.length, s.stop.enCours?.()], [1, 0, true], "demande close, stop-request pas encore écrit : en cours");
    liberer();
    await arret;
    assert.deepEqual(s.stopRequests, ["vous"]);
    assert.equal(s.stop.enCours?.(), false, "arrêt fini");

    const relance = s.stop.relaunchAfterRequest(ROOT);
    assert.equal(s.stop.enCours?.(), true, "posé de façon synchrone par relaunchAfterRequest");
    await relance;
    assert.equal(s.stop.enCours?.(), false, "relance finie");
    assert.equal(neutralOmoStop({} as never).enCours, undefined, "port neutre inchangé : aucun arrêt possible");
  });

  it("relance pendant un arrêt : aucun second stop-request ; deux arrêts simultanés n'en font qu'un", async (t) => {
    const s = unite(t, { occupees: [[ROOT, DIR_A]] });
    const premier = s.stop.run(ROOT, "vous");
    const second = s.stop.run(ROOT, "plafond-cout");
    const relance = s.stop.relaunchAfterRequest(ROOT);
    assert.equal(premier, second, "le même arrêt");
    await Promise.all([premier, relance]);
    assert.deepEqual(s.stopRequests, ["vous"]);
    assert.equal(s.journal.filter((e) => e === "file:prise").length, 1);
  });

  it("suspension : deux arrêts pour activité hors demande en 10 min → omoControl.suspend AVANT le stop-request du second ; au-delà de 10 min, avec une demande active ou pour une autre cause → rien", async (t) => {
    assert.deepEqual(OMO_LIMITES.suspension, { detections: 2, fenetreMin: 10 });
    assert.equal(OMO_FENETRE_SUSPENSION_MS, 600_000);

    const s = unite(t);
    await s.stop.run(null, "hors-controle");
    assert.deepEqual(s.suspensions, []);
    s.avancer(OMO_FENETRE_SUSPENSION_MS);
    await s.stop.run(null, "hors-controle");
    assert.deepEqual(s.suspensions, ["activite-hors-demande"]);
    const second = s.journal.lastIndexOf("stop-request hors-controle");
    assert.ok(s.journal.indexOf("suspendue activite-hors-demande") < second, "suspendue avant le stop-request : la relance ne reçoit aucun precheck-ok");

    const loin = unite(t);
    await loin.stop.run(null, "hors-controle");
    loin.avancer(OMO_FENETRE_SUSPENSION_MS + 1);
    await loin.stop.run(null, "hors-controle");
    assert.deepEqual(loin.suspensions, [], "au-delà de 10 min");

    const pendant = unite(t, { active: DEMANDE });
    await pendant.stop.run(ROOT, "hors-controle");
    await pendant.stop.run(ROOT, "hors-controle");
    assert.deepEqual(pendant.suspensions, [], "détection pendant une demande : pas une activité hors demande");

    const autres = unite(t);
    for (const cause of ["vous", "redemarrage-cockpit", "homme-mort"] as const) await autres.stop.run(null, cause);
    assert.deepEqual(autres.suspensions, []);
  });

  it("racine absente : celle de la demande active est visée ; sans demande active, aucune racine (ni fait, ni conversation.arretee), rootId vide ; identifiant illisible → arrêt sans racine", async (t) => {
    const avecDemande = unite(t, { occupees: [[SALLE2, DIR_B]], active: DEMANDE });
    const r1 = await avecDemande.stop.run(null, "homme-mort");
    assert.equal(r1.rootId, ROOT);
    assert.deepEqual(avecDemande.fins, [[ROOT, "homme-mort"]]);
    assert.deepEqual(r1.aborted, [ROOT, SALLE2], "racine de la demande d'abord");
    assert.deepEqual(
      avecDemande.faits.map((f) => [f.rootId, f.data.cause]),
      [[ROOT, "interrompue"]],
    );

    const sans = unite(t, { occupees: [[ORPHELINE, DIR_A], [SALLE2, DIR_B]] });
    const r2 = await sans.stop.run(null, "redemarrage-cockpit");
    assert.equal(r2.rootId, "");
    assert.deepEqual(r2.aborted, [SALLE2, ORPHELINE], "racines de salle d'abord");
    assert.deepEqual(sans.fins, []);
    assert.deepEqual(sans.faits, []);
    assert.deepEqual(
      sans.evenements.map((e) => e.type),
      ["omo.recreation", "omo.recreation"],
    );

    const illisible = unite(t);
    const r3 = await illisible.stop.run("ses/../x", "vous");
    assert.equal(r3.rootId, "");
    assert.equal(routes(illisible.journal).some((r) => r.includes("..")), false);
    assert.ok(illisible.journaux.some((j) => j.message === "arrêt de la salle : racine illisible, arrêt sans racine"));
    assert.deepEqual(illisible.stopRequests, ["vous"]);
  });

  it("états illisibles : la racine est quand même arrêtée ; instance absente : aucun appel, stop-request écrit, confirmation par state.json seul", async (t) => {
    const illisible = unite(t, { occupees: [[ROOT, DIR_A], [CHILD, DIR_A]], statusFails: true });
    const r = await illisible.stop.run(ROOT, "vous");
    assert.deepEqual(r.aborted, [ROOT]);
    assert.deepEqual(illisible.stopRequests, ["vous"]);

    const sansInstance = unite(t, { sansInstance: true, superviseur: "etat-arret", active: DEMANDE });
    const r2 = await sansInstance.stop.run(ROOT, "vous");
    assert.deepEqual(routes(sansInstance.journal), []);
    assert.deepEqual(sansInstance.stopRequests, ["vous"]);
    assert.deepEqual([r2.rejected, r2.aborted], [0, []]);
    assert.equal(sansInstance.lignes()[0]?.fin, "arret-confirme");
    assert.deepEqual(sansInstance.pauses, []);
  });

  it("échéance de la file des réponses (20 s, sous sa libération d'office) : les appels suivants sont sautés et dits, l'abandon de la racine est toujours tenté", async (t) => {
    const s = unite(t, {
      lent: 6_000,
      occupees: [
        [ROOT, DIR_A],
        [CHILD, DIR_A],
      ],
      attentes: ["per_1", "per_2", "per_3", "per_4", "per_5"].map((id, i) => ({ id, sessionID: `ses_attente_${i}`, dossier: DIR_A })),
    });
    const result = await s.stop.run(ROOT, "vous");
    assert.equal(result.rejected, 1, "un seul refus avant l'échéance");
    assert.deepEqual(result.aborted, [ROOT]);
    assert.equal(s.journal.includes(`POST /session/${CHILD}/abort`), false);
    assertSubsequence(s.journal, [
      "file:prise",
      "POST /permission/per_1/reply",
      `POST /session/${ROOT}/abort`,
      "journal arrêt de la salle : appels sautés, échéance de la file des réponses atteinte",
      "file:rendue",
      "stop-request vous",
    ]);
    assert.deepEqual(s.journaux.find((j) => j.message.includes("appels sautés"))?.fields, { sautes: 2 });
  });

  it("chaque cause a sa fin de demande et sa cause de fait ; jamais une valeur devinée", async (t) => {
    assert.deepEqual(Object.keys(REQUEST_END_OF_OMO_STOP).sort(), [...OMO_STOP_CAUSES].sort());
    assert.deepEqual(Object.keys(STATUT_CAUSE_OF_OMO_STOP).sort(), [...OMO_STOP_CAUSES].sort());
    const s = unite(t, { active: DEMANDE });
    for (const cause of OMO_STOP_CAUSES) await s.stop.run(ROOT, cause);
    assert.deepEqual(
      s.fins,
      OMO_STOP_CAUSES.map((cause): [string, RequestEnd] => [ROOT, cause]),
    );
    assert.deepEqual(
      s.faits.map((f) => [f.data.motif, f.data.cause]),
      OMO_STOP_CAUSES.map((cause) => [cause, STATUT_CAUSE_OF_OMO_STOP[cause]]),
    );
    assert.deepEqual(s.stopRequests, [...OMO_STOP_CAUSES]);
  });
});

// --- Module : porte de la salle, crochet `abort`, démarrage ------------------------------------------------------------------------

/** Contexte de proxy minimal : `c.json` suffit au crochet. */
function contexte(sessionId: string): ProxyContext {
  const c = { json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }) };
  return { c: c as unknown as Context, method: "POST", sub: `/session/${sessionId}/abort`, directory: null, body: {}, sessionId };
}

/** Module factice au nom réel : le VRAI module, sur un c11 dont la seule porte SALLE_OUVERTE est ouverte (et les dossiers donnés). */
function moduleOuvert(options: Parameters<typeof creerModuleOmoStop>[0] = {}, dossiers = true): Cockpit11Module {
  const reel = creerModuleOmoStop(options);
  return {
    name: "omoStop",
    install(reg, c11) {
      reel.install(reg, { ...c11, salleOuverte: true, ...(dossiers ? {} : { omoControlDirs: null }) });
    },
  };
}

const ARRET_ESPION: StopResult = { rootId: "", rejected: 0, aborted: [], unconfirmed: [], durationMs: 0 };

describe("L23b : module omoStop", () => {
  it("salle fermée (le dépôt) ou non configurée : port NEUTRE, aucune inscription ; ouverte et configurée : crochet abort et démarrage, instances [omo]", async (t) => {
    assert.equal(omoStopModule.name, "omoStop");
    const fermee = await startCockpit(t, { omo: true, modules: ["omoStop"] });
    assert.deepEqual(fermee.cockpit.wiring.registrations.filter((r) => r.module === "omoStop"), []);
    await assert.rejects(fermee.cockpit.c11.ports.omoStop.run(ROOT, "vous"), PortUnavailableError);

    const sansDossiers = await startCockpit(t, { omo: true, modules: [moduleOuvert({}, false)] });
    assert.deepEqual(sansDossiers.cockpit.wiring.registrations.filter((r) => r.module === "omoStop"), []);
    await assert.rejects(sansDossiers.cockpit.c11.ports.omoStop.run(ROOT, "vous"), PortUnavailableError);

    // Sonde sans attente : le faux de la salle répond toujours, l'arrêt n'est donc pas confirmé, mais le port est bien le réel.
    const ouverte = await startCockpit(t, { omo: true, modules: [moduleOuvert({ sleep: async () => undefined, sondeFenetreMs: 0 })] });
    assert.deepEqual(ouverte.cockpit.wiring.registrations.filter((r) => r.module === "omoStop"), [
      { kind: "hook", key: "abort", module: "omoStop", instances: ["omo"] },
      { kind: "startup", key: "startup", module: "omoStop", instances: ["omo"] },
    ]);
    const neutre = neutralOmoStop(ouverte.cockpit.c11);
    await assert.rejects(neutre.run(ROOT, "vous"), PortUnavailableError);
    const reel = await ouverte.cockpit.c11.ports.omoStop.run(ROOT, "vous");
    assert.deepEqual([reel.rootId, reel.rejected, reel.unconfirmed], [ROOT, 0, []]);
  });

  it("crochet abort de la salle : racine d'une salle → toute la salle s'arrête (200 StopResult, cause « vous ») ; enfant, session qui se donne pour parent, racine étrangère, session principale, identifiant illisible → relais ; le proxy principal ne l'appelle jamais", async (t) => {
    const arrets: Array<[string | null, OmoStopCause]> = [];
    const espion: OmoStopPort = {
      run: async (rootId, cause) => {
        arrets.push([rootId, cause]);
        return { ...ARRET_ESPION, rootId: rootId ?? "" };
      },
      relaunchAfterRequest: async () => undefined,
    };
    // omo_rooms volontairement trompeur : un enfant, une session qui se donne pour parent et une session PRINCIPALE y figurent.
    // Chaque garde du crochet (instance, sans parent, inscrite dans omo_rooms) doit tenir seule.
    const omoRoom: OmoRoomPort = { open: async () => assert.fail(), status: async () => assert.fail(), openProjects: () => [], isRoomRoot: (id) => id !== ORPHELINE };
    const h = await startCockpit(t, { omo: true, modules: [moduleOuvert()], ports: { omoStop: espion, omoRoom } });
    const ajouter = (id: string, instance: "omo" | "principale", parentID?: string) =>
      h.sessions.upsert({ id, ...(parentID ? { parentID } : {}), projectID: "global", directory: DIR_A, title: id, time: { created: 1, updated: 1 } }, undefined, { instance });
    ajouter(ROOT, "omo");
    ajouter(CHILD, "omo", ROOT);
    ajouter(ORPHELINE, "omo");
    ajouter(PRINCIPALE, "principale");
    // Événement fabriqué par la salle : une session qui se donne pour parent reste sa propre racine au suivi (root_id = id). Seule
    // la garde « sans parent » l'écarte ; la garde « racine d'elle-même » ne la voit pas.
    const AUTOPARENT = "ses_autoparent";
    const autoparent = ajouter(AUTOPARENT, "omo", AUTOPARENT);
    assert.deepEqual([autoparent.parent_id, autoparent.root_id, autoparent.instance], [AUTOPARENT, AUTOPARENT, "omo"]);
    assert.ok(h.omo);

    const reponse = await h.omo.runHooks("abort", contexte(ROOT), ROOT);
    assert.equal(reponse?.status, 200);
    assert.deepEqual(await reponse?.json(), { ...ARRET_ESPION, rootId: ROOT });
    assert.deepEqual(arrets, [[ROOT, "vous"]]);

    for (const id of [CHILD, AUTOPARENT, ORPHELINE, PRINCIPALE, "ses/x", "ses_inconnue"]) assert.equal(await h.omo.runHooks("abort", contexte(id), id), null, id);
    // Proxy de l'instance principale (contexte sans instance) : le crochet de la salle n'est jamais appelé.
    assert.equal(await h.cockpit.wiring.runHooks("abort", contexte(ROOT), ROOT), null);
    assert.deepEqual(arrets, [[ROOT, "vous"]]);
  });

  it("démarrage du cockpit : state.json en phase opencode-lance → stopTreeOmo(null, « redemarrage-cockpit ») ; autre phase ou état inconnu → rien", async (t) => {
    for (const [lu, attendu] of [
      [etat(START), [[null, "redemarrage-cockpit"]]],
      [etat(START, "attente"), []],
      [etat(START, "arret"), []],
      [null, []],
    ] as const) {
      const arrets: Array<[string | null, OmoStopCause]> = [];
      const espion: OmoStopPort = {
        run: async (rootId, cause) => {
          arrets.push([rootId, cause]);
          return ARRET_ESPION;
        },
        relaunchAfterRequest: async () => undefined,
      };
      const control = { ...controleNeutre(), readState: async () => lu };
      const h = await startCockpit(t, { omo: true, modules: [moduleOuvert()], ports: { omoStop: espion, omoControl: control } });
      await h.cockpit.startup();
      assert.deepEqual(arrets, attendu, lu?.phase ?? "inconnu");
    }
  });
});

function controleNeutre(): OmoControlPort {
  return {
    startHeartbeat: () => undefined,
    stopHeartbeat: () => undefined,
    requestStop: async () => undefined,
    writePrecheckOk: async () => undefined,
    writeGuardState: async () => undefined,
    publishAuth: async () => undefined,
    readState: async () => null,
    suspend: () => undefined,
    resume: () => undefined,
    suspended: () => false,
  };
}

// --- Intégration : faux opencode de la salle ---------------------------------------------------------------------------------------

interface AtelierSalle {
  h: CockpitHarness;
  workspace: string;
  dirApp: string;
  controlDir: string;
  stateDir: string;
  fins: Array<[string, RequestEnd]>;
  racines: Set<string>;
  publier(etat: OmoSupervisorState): void;
}

/**
 * Cockpit réel avec la salle : second faux opencode (processeur réel de L18a), module RÉEL de L23b ouvert par un module factice au
 * nom réel, module « floors » (L3) installé, écrivain RÉEL de L17b sur des dossiers temporaires. Superviseur simulé par la pause
 * de la sonde : dès que stop-request existe, state.json passe en phase « arret ».
 */
async function atelierSalle(t: TestContext): Promise<AtelierSalle> {
  const at = atelier(t);
  const workspace = at.dossier("workspace");
  const dirApp = at.dossier("workspace/app");
  at.poser("workspace/app/.omo/boulder.json", '{"plan":"app"}');
  const controlDir = at.dossier("control-omo");
  const stateDir = at.dossier("omo-state");
  const control = createOmoControl({
    controlDir,
    stateDir,
    authDir: at.dossier("omo-auth"),
    opencodeDataDir: at.dossier("oc-data"),
    cockpitDataDir: at.dossier("donnees-cockpit"),
    projectsFile: null,
    actif: () => true,
    log: createLogger("error"),
  });
  t.after(async () => {
    control.stopHeartbeat();
    await control.settled();
  });
  const publier = (valeur: OmoSupervisorState) => fs.writeFileSync(path.join(stateDir, "state.json"), ecrireEtat(valeur));
  const racines = new Set<string>();
  const omoRoom: OmoRoomPort = { open: async () => assert.fail(), status: async () => assert.fail(), openProjects: () => ["app"], isRoomRoot: (id) => racines.has(id) };
  const fins: Array<[string, RequestEnd]> = [];
  const omoActivation: OmoActivationPort = {
    view: async () => null,
    put: async () => assert.fail("activation inattendue"),
    consume: async () => assert.fail("envoi inattendu"),
    activeRequest: () => null,
    endRequest: (rootId, fin) => void fins.push([rootId, fin]),
  };
  const superviseur = async () => {
    if (fs.existsSync(path.join(controlDir, "stop-request"))) {
      const lu = await control.readState();
      if (lu !== null) publier({ ...lu, phase: "arret" });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  };
  const h = await startCockpit(t, {
    omo: true,
    modules: ["floors", moduleOuvert({ sleep: superviseur })],
    ports: { omoControl: control, omoRoom, omoActivation },
    env: { workspaceDir: workspace },
  });
  return { h, workspace, dirApp, controlDir, stateDir, fins, racines, publier };
}

const delegation = (description: string) => ({
  tool: "task",
  input: { description, prompt: `Consigne : ${description}`, subagent_type: "general" },
  child: { agent: "general", workMs: 60_000 },
});

/** Racine d'une salle sur le faux de la SALLE, dans le dossier du projet, occupée par une délégation et une demande « bash ». */
async function racineOccupee(a: AtelierSalle): Promise<{ root: FakeSession; enfant: string }> {
  const omo = a.h.omo;
  assert.ok(omo);
  const root = await omo.deps.client.request<FakeSession>("POST", "/session", { directory: a.dirApp, body: { title: "app" } });
  await until(() => a.h.sessions.get(root.id)?.instance === "omo");
  a.h.db.prepare("INSERT INTO omo_rooms (root_id, projet, created_at) VALUES (?, 'app', 1)").run(root.id);
  a.racines.add(root.id);
  omo.fake.script(root.id, { tools: [delegation("Analyser les journaux"), bash("ls")] });
  assert.equal(await promptAsync(omo.deps.client, root.id, "Travaille."), 204);
  const enfant = ((await omo.fake.waitForEvent("session.created", (p) => (p.info as FakeSession).parentID === root.id)).properties.info as FakeSession).id;
  await until(() => omo.fake.statusOf(root.id).type === "busy" && omo.fake.statusOf(enfant).type === "busy" && omo.fake.pendingPermissions().length === 1);
  await until(() => a.h.sessions.get(enfant));
  a.publier(etat(START));
  a.h.db.prepare("INSERT INTO omo_room_starts (started_at, image_id, manifest_sha256, precheck, cause, start_id) VALUES (1, '', '', '[]', '', ?)").run(START);
  return { root, enfant };
}

/** Requêtes reçues par un faux depuis un repère, « MÉTHODE /chemin ». */
const recues = (requetes: ReadonlyArray<{ method: string; pathname: string }>, depuis: number) => requetes.slice(depuis).map((r) => `${r.method} ${r.pathname}`);

describe("L23b : arrêt de la salle sur le faux opencode", () => {
  it("T-L23-a, T-L23-j, T-L23-k : « Arrêter » pendant une délégation — attente refusée, racine puis enfant abandonnés, stop-request du démarrage ; zéro /command ni message, rien à l'instance principale, aucune session supprimée", async (t) => {
    const a = await atelierSalle(t);
    const omo = a.h.omo;
    assert.ok(omo);
    const { root, enfant } = await racineOccupee(a);
    // T-L23-k : une session de la salle sans plancher n'est jamais supprimée (le plancher ne sert pas la salle).
    assert.equal(await omo.runHooks("sessionCreated", contexte(root.id), root), null);
    const repereSalle = omo.fake.requests.length;
    const reperePrincipal = a.h.fake.requests.length;

    const result = await within(a.h.cockpit.c11.ports.omoStop.run(root.id, "vous"), "arrêt de la salle", 10_000);

    const pendant = recues(omo.fake.requests, repereSalle);
    // Toute écriture vers la salle pendant l'arrêt est une route permise (les lectures GET peuvent venir du processeur de la salle).
    const ecritures = pendant.filter((r) => !r.startsWith("GET "));
    assert.ok(ecritures.length > 0);
    for (const route of ecritures) {
      assert.ok(ROUTES_PERMISES.some((re) => re.test(route)), `route non permise : ${route}`);
      assert.doesNotMatch(route, ROUTES_INTERDITES);
    }
    assert.equal(pendant.filter((r) => r.endsWith("/command")).length, 0, pendant.join("\n"));
    assert.equal(pendant.filter((r) => r.startsWith("DELETE")).length, 0, "aucune session supprimée");
    assert.ok(pendant.indexOf(`POST /session/${root.id}/abort`) < pendant.indexOf(`POST /session/${enfant}/abort`), "racine d'abord");
    assert.deepEqual(result.aborted.slice(0, 1), [root.id]);
    assert.equal(result.rejected, 1);
    assert.deepEqual(omo.fake.pendingPermissions(), []);
    await within(Promise.all([omo.fake.settled(root.id), omo.fake.settled(enfant)]), "salle au repos");

    // T-L23-j (P6) : l'instance PRINCIPALE n'a rien reçu ; la salle, elle, est relancée par stop-request (fichier du démarrage visé).
    assert.deepEqual(recues(a.h.fake.requests, reperePrincipal), []);
    a.h.assertNoGlobalRestart();
    const arret = analyserArret(fs.readFileSync(path.join(a.controlDir, "stop-request"), "utf8"));
    assert.equal(arret?.cause, "vous");
    assert.equal(arret?.startId, START);
    assert.equal(a.h.sessions.get(root.id)?.deleted_at, null);
    assert.equal(a.h.sessions.get(enfant)?.deleted_at, null);

    // G5 (partie hors ligne) : boulder.json mis de côté, démarrage clos, demande marquée.
    assert.deepEqual(fs.readdirSync(path.join(a.dirApp, ".omo")).map((n) => /^boulder\.arrete-\d+\.json$/.test(n)), [true]);
    assert.deepEqual(
      { ...(a.h.db.prepare("SELECT cause, fin FROM omo_room_starts WHERE start_id = ?").get(START) as object) },
      { cause: "vous", fin: "arret-confirme" },
    );
    assert.deepEqual(a.fins, [[root.id, "vous"]]);

    // Après : aucun appel qui écrive à la salle (lectures du processeur seules), zéro /command.
    const repereApres = omo.fake.requests.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    const apres = recues(omo.fake.requests, repereApres);
    assert.deepEqual(apres.filter((r) => !r.startsWith("GET")), [], apres.join("\n"));
    assert.equal(recues(omo.fake.requests, 0).filter((r) => r.endsWith("/command")).length, 0);
    assert.equal(recues(omo.fake.requests, 0).filter((r) => r.startsWith("DELETE")).length, 0);
  });

  it("redémarrage du cockpit pendant une délégation : stop-request « redemarrage-cockpit » du démarrage en cours, fin redemarrage-cockpit, salle au repos, aucun appel au faux après la reprise", async (t) => {
    const a = await atelierSalle(t);
    const omo = a.h.omo;
    assert.ok(omo);
    const { root, enfant } = await racineOccupee(a);
    const reperePrincipal = a.h.fake.requests.length;

    await within(a.h.cockpit.startup(), "démarrage du cockpit", 10_000);

    const arret = analyserArret(fs.readFileSync(path.join(a.controlDir, "stop-request"), "utf8"));
    assert.equal(arret?.cause, "redemarrage-cockpit");
    assert.equal(arret?.startId, START);
    assert.deepEqual(
      { ...(a.h.db.prepare("SELECT cause, fin FROM omo_room_starts WHERE start_id = ?").get(START) as object) },
      { cause: "redemarrage-cockpit", fin: "arret-confirme" },
    );
    assert.deepEqual(
      a.h
        .cockpitEvents()
        .filter((e) => e.type === "omo.recreation")
        .map((e) => e.data),
      [
        { etat: "demandee", raison: "redemarrage-cockpit" },
        { etat: "arret-confirme", raison: "redemarrage-cockpit" },
      ],
    );
    await within(Promise.all([omo.fake.settled(root.id), omo.fake.settled(enfant)]), "salle au repos");
    assert.deepEqual(omo.fake.pendingPermissions(), []);
    // Aucune demande active après un redémarrage (elle vivait en mémoire) : rien à marquer ici, la fin est celle du démarrage.
    assert.deepEqual(a.fins, []);
    assert.deepEqual(recues(a.h.fake.requests, reperePrincipal), []);
    a.h.assertNoGlobalRestart();

    const repereApres = omo.fake.requests.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(recues(omo.fake.requests, repereApres), []);
    assert.equal(recues(omo.fake.requests, 0).filter((r) => r.endsWith("/command")).length, 0);
  });
});
