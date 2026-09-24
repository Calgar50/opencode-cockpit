// Détections en service de la Salle OMO (L23c) : faits du flux et du cockpit remis au module pur de L23a, contrôle du disque borné,
// quarantaine avant l'arrêt, `par: extension`, fenêtres d'arrêt et de relance du cockpit.
//
// Chaque garde a son test qui échoue sans elle (mutations hors dépôt : execution/mesures/mutations-L23c.mjs). Les relevés du disque
// sont les VRAIS (releverEmpreintesSalle de L19a, sur un dossier de travail jetable) ; le port `omoStop` n'est pas encore réel dans
// cette vague (L23b) : il est remplacé par un espion, qui note aussi l'état du disque au moment de l'arrêt (quarantaine AVANT
// l'arrêt). Délais par horloge injectée : aucun test n'attend le temps réel, sauf le dernier bloc, qui passe par le vrai processeur
// de la salle et un faux opencode (G13, programme muni du mot de passe), où l'attente est bornée.
//
// Décision A16 (montages inversés de L16c) : une création à la racine d'un projet, de /workspace ou d'un dossier de premier niveau
// échoue dans la salle (EROFS). Les scénarios « .git créé à la racine d'un projet sans historique », « /workspace/.git » et
// « configuration apparue à la racine » n'y arrivent donc plus que si un montage a bougé : ils sont GARDÉS (filet), et dits comme
// tels. Le scénario réaliste d'aujourd'hui est ajouté : `.git` créé dans une entrée de premier niveau ouverte en écriture
// (`proj/src/.git`), à toute profondeur, casse comprise.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { Cockpit11, FactsPort, Registrar } from "./contracts-11.ts";
import { openMemoryDb } from "./db.ts";
import { EventHub } from "./hub.ts";
import type { OmoControlClock } from "./omo-control.ts";
import type { OmoActivationPort, OmoActiveRequest, OmoControlPort, OmoPrecheckPort, OmoStopPort } from "./omo-contracts.ts";
import {
  createOmoDetectionsService,
  horodatageQuarantaine,
  inscrireDetectionsSalle,
  neutralOmoDetections,
  OMO_DETECTIONS_BORNE_MS,
  OMO_DETECTIONS_CASCADE_MS,
  OMO_DETECTIONS_CONTROLE_MS,
  OMO_DETECTIONS_RACINE_DELAI_MS,
  OMO_DETECTIONS_REGLE_PERMISSION,
  OMO_DETECTIONS_RELANCE_MAX_MS,
  OMO_DETECTIONS_VEILLE_MS,
  OMO_OUTILS_SANS_DEMANDE,
  OMO_PERMISSIONS_DELEGATION,
  OMO_REGLE_SANS_DEMANDE,
  omoDetectionsModule,
  type OmoHorsControleData,
  type OmoSignalesData,
} from "./omo-detections-service.ts";
import { releverEmpreintesSalle } from "./omo-precheck-reader.ts";
import type { OmoPrecheckReferences } from "./omo-precheck-service.ts";
import { emittedRegistry } from "./permission-gate.ts";
import { SessionTracker } from "./sessions.ts";
import type { ActivityFact } from "./shared/activity-types.ts";
import { OUTILS } from "./shared/omo-audit-4.19.4.ts";
import { TEXTES as TEXTES_SANS_DEMANDE } from "./shared/omo-audit-texts.ts";
import type { PrecheckBornes } from "./shared/omo-precheck-rules.ts";
import type { OmoPreparedProjects, OmoSignale, OmoSupervisorState } from "./shared/omo-types.ts";
import { startCockpit } from "./test-support/cockpit-harness.ts";
import { bash, leaks, promptAsync, until } from "./test-support/helpers.ts";

const T0 = 1_790_000_000_000;
const START_1 = "5b0e2c1a-3d4f-4a6b-8c9d-0e1f2a3b4c5d";
const START_2 = "6c1f3d2b-4e5a-4b7c-9d0e-1f2a3b4c5d6e";
const START_3 = "7d2a4e3c-5f6b-4c8d-8e1f-2a3b4c5d6e7f";
/** Racine ouverte par le cockpit (ligne omo_rooms), projet « proj ». */
const ROOT = "ses_racine_proj";
const ROOT_AUTRE = "ses_racine_autre";
const ENFANT = "ses_enfant_1";
/** Contenu fabriqué : reconnaissable dans un message d'échec, inoffensif dans un fichier. */
const CONTENU = "[synthétique] atelier du test L23c, aucun secret.";

// --- Atelier ----------------------------------------------------------------------------------------------------------------------

/** Horloge injectée : minuteries déclenchées par `avancer`, jamais par le temps réel. */
function fausseHorloge(depart = T0) {
  let maintenant = depart;
  let seq = 0;
  const minuteries = new Map<number, { fn: () => void; echeance: number }>();
  const clock: OmoControlClock = {
    now: () => maintenant,
    setTimer: (fn, ms) => {
      seq++;
      minuteries.set(seq, { fn, echeance: maintenant + ms });
      return seq;
    },
    clearTimer: (handle) => void minuteries.delete(handle as number),
  };
  return {
    clock,
    avancer(ms: number) {
      const fin = maintenant + ms;
      for (;;) {
        const due = [...minuteries.entries()].filter(([, m]) => m.echeance <= fin).sort((a, b) => a[1].echeance - b[1].echeance)[0];
        if (!due) break;
        minuteries.delete(due[0]);
        maintenant = due[1].echeance;
        due[1].fn();
      }
      maintenant = fin;
    },
  };
}

function espion() {
  const lignes: Array<{ niveau: string; message: string; champs: Record<string, unknown> | undefined }> = [];
  return {
    lignes,
    log: {
      info: (message: string, champs?: Record<string, unknown>) => void lignes.push({ niveau: "info", message, champs }),
      warn: (message: string, champs?: Record<string, unknown>) => void lignes.push({ niveau: "warn", message, champs }),
    },
    texte: () => JSON.stringify(lignes),
    dit: (fragment: string) => lignes.some((ligne) => ligne.message.includes(fragment)),
  };
}

function ecrire(racine: string, relatif: string, contenu = CONTENU): void {
  const cible = path.join(racine, relatif);
  fs.mkdirSync(path.dirname(cible), { recursive: true });
  fs.writeFileSync(cible, contenu, "utf8");
}

/** Lien symbolique de dossier (ou jonction sous Windows) ; false si le système le refuse. */
function lierDossier(cible: string, chemin: string): boolean {
  for (const type of ["dir", "junction"] as const) {
    try {
      fs.symlinkSync(cible, chemin, type);
      if (fs.lstatSync(chemin).isSymbolicLink()) return true;
    } catch {
      // Essai suivant.
    }
  }
  return false;
}

/**
 * Dossier de travail : trois projets préparés (« proj » ouvert, « autre » préparé NON ouvert, « sansgit » sans historique), un
 * dossier de premier niveau qui n'est pas un projet (« notes », avec une configuration présente dès le démarrage) et un dépôt protégé
 * dont le `.git` est écrit « .Git » sur le disque (« casse »).
 */
function fabriquer(workspace: string, options: Options = {}): OmoPreparedProjects {
  const liste = fabriquerBase(workspace);
  if (options.imbrique) {
    // Projet préparé DANS un dossier de premier niveau : ses fichiers sont relevés deux fois (premier niveau et projet).
    ecrire(workspace, "groupe/app/.git/HEAD", "ref: refs/heads/principale\n");
    ecrire(workspace, "groupe/app/package.json", '{"name": "app"}');
    liste.projets.push({ chemin: "groupe/app", git: "dossier" });
    liste.gitProteges.push({ chemin: "groupe/app/.git", forme: "dossier" });
  }
  for (const chemin of options.gitProtegesEnPlus ?? []) liste.gitProteges.push({ chemin, forme: "dossier" });
  return liste;
}

function fabriquerBase(workspace: string): OmoPreparedProjects {
  ecrire(workspace, "proj/.git/HEAD", "ref: refs/heads/principale\n");
  ecrire(workspace, "proj/README.md");
  ecrire(workspace, "proj/package.json", '{"name": "proj", "private": true}');
  ecrire(workspace, "proj/.vscode/settings.json", '{"[synthétique]": "réglages"}');
  ecrire(workspace, "proj/src/index.ts", "export const a = 1;\n");
  ecrire(workspace, "autre/.git/HEAD", "ref: refs/heads/principale\n");
  ecrire(workspace, "autre/README.md");
  ecrire(workspace, "autre/.vscode/tasks.json", '{"version": "2.0.0"}');
  ecrire(workspace, "sansgit/README.md");
  ecrire(workspace, "notes/.claude/settings.json", '{"[synthétique]": "configuration de l\'hôte"}');
  ecrire(workspace, "notes/doc.md");
  ecrire(workspace, "casse/.Git/HEAD", "ref: refs/heads/principale\n");
  return {
    version: 1,
    genereLe: "2026-09-23T00:00:00.000Z",
    projets: [
      { chemin: "proj", git: "dossier" },
      { chemin: "autre", git: "dossier" },
      { chemin: "sansgit", git: "absent" },
    ],
    gitProteges: [
      { chemin: "proj/.git", forme: "dossier" },
      { chemin: "autre/.git", forme: "dossier" },
      { chemin: "casse/.git", forme: "dossier" },
    ],
  };
}

interface Arret {
  rootId: string | null;
  cause: string;
  at: number;
}

interface Options {
  bornes?: Partial<PrecheckBornes>;
  etatSuperviseur?: OmoSupervisorState | null;
  /** Posé avant les références (fichiers présents au démarrage). */
  preparer?: (workspace: string) => void;
  /** Projet préparé « groupe/app », imbriqué dans le dossier de premier niveau « groupe ». */
  imbrique?: boolean;
  /** `.git` ajoutés à `gitProteges` (omo-projets.json). */
  gitProtegesEnPlus?: string[];
}

function monter(t: TestContext, options: Options = {}) {
  const racine = fs.mkdtempSync(path.join(os.tmpdir(), "omo-detections-service-"));
  t.after(() => {
    try {
      fs.rmSync(racine, { recursive: true, force: true });
    } catch {
      // Dossier temporaire verrouillé : le système le reprendra.
    }
  });
  const workspace = path.join(racine, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const liste = fabriquer(workspace, options);
  const prepares = liste.projets.map((projet) => projet.chemin);
  options.preparer?.(workspace);
  const projectsFile = path.join(racine, "hote", "omo-projets.json");
  ecrire(racine, "hote/omo-projets.json", `${JSON.stringify(liste)}\n`);

  const db = openMemoryDb();
  t.after(() => db.close());
  db.prepare("INSERT INTO omo_rooms (root_id, projet, created_at) VALUES (?, ?, ?)").run(ROOT, "proj", T0);
  db.prepare("INSERT INTO omo_rooms (root_id, projet, created_at) VALUES (?, ?, ?)").run(ROOT_AUTRE, "autre", T0);
  const hub = new EventHub();
  const publies: Array<{ type: string; data: unknown; instance: string | undefined }> = [];
  hub.subscribe((evenement) => {
    if (evenement.kind === "cockpit") publies.push({ type: evenement.type, data: evenement.data, instance: evenement.instance });
  });
  const horloge = fausseHorloge();
  const journal = espion();
  const sessions = new SessionTracker(db, {} as never);
  const registre = emittedRegistry();
  let demande: OmoActiveRequest | null = null;
  let references: OmoPrecheckReferences | null = null;
  const etatSuperviseur = options.etatSuperviseur ?? null;
  const arrets: Arret[] = [];
  let auArret: (() => void) | null = null;
  const stop: OmoStopPort = {
    run: async (rootId, cause) => {
      arrets.push({ rootId, cause, at: horloge.clock.now() });
      auArret?.();
      return { rootId: rootId ?? "", rejected: 0, aborted: [], unconfirmed: [], durationMs: 0 } as never;
    },
    relaunchAfterRequest: async () => undefined,
  };
  const faits: ActivityFact[] = [];
  const facts = {
    append: (liste: readonly ActivityFact[]) => void faits.push(...liste),
    since: () => {
      throw new Error("non utilisé");
    },
    work: { markDelegation: () => false, markWait: () => false },
  } as unknown as FactsPort;
  const precheck = {
    check: async () => ({ ok: false, code: "salle-coupee" }),
    beforeStart: async (startId: string) => ({ ok: false, startId, code: "salle-coupee", resultats: [] }),
    references: () => references,
  } as unknown as OmoPrecheckPort;
  const service = createOmoDetectionsService({
    workspace,
    projectsFile,
    db,
    hub,
    log: journal.log,
    sessions,
    emises: () => registre,
    activation: () => ({ activeRequest: () => demande }) as unknown as OmoActivationPort,
    stop: () => stop,
    precheck: () => precheck,
    control: () => ({ readState: async () => etatSuperviseur }) as unknown as OmoControlPort,
    facts: () => facts,
    clock: horloge.clock,
    ...(options.bornes ? { bornes: options.bornes } : {}),
  });
  t.after(() => service.fermer());

  let numero = 0;
  const a = {
    dossier: racine,
    workspace,
    projectsFile,
    db,
    hub,
    publies,
    journal,
    sessions,
    registre,
    service,
    arrets,
    faits,
    now: () => horloge.clock.now(),
    /** Références de L19b pour ce démarrage : relevé RÉEL du dossier de travail, comme `releverEmpreintesSalle` le fait au démarrage. */
    async demarrer(startId = START_1) {
      references = {
        startId,
        at: horloge.clock.now(),
        releves: await releverEmpreintesSalle({ workspace, prepares, ...(options.bornes ? { bornes: options.bornes } : {}) }),
      };
    },
    /** Pré-contrôle du démarrage suivant en cours (L19b remet ses références à null) : aucun démarrage accepté. */
    retirerReferences() {
      references = null;
    },
    ouvrirDemande(rootId = ROOT, requestId = "req_1") {
      demande = { rootId, requestId, startedAt: horloge.clock.now(), plafondUsd: "1.00" };
    },
    fermerDemande() {
      demande = null;
    },
    auArret(fn: () => void) {
      auArret = fn;
    },
    emettre(type: string, properties: Record<string, unknown>) {
      numero++;
      service.onEvent({ directory: "/workspace/proj", payload: { id: `evt_${numero}`, type, properties } }, { instance: "omo" });
    },
    racine(id = ROOT) {
      a.emettre("session.created", { sessionID: id, info: { id, title: "proj", directory: "/workspace/proj" } });
    },
    enfant(id = ENFANT, parentID = ROOT, permission?: unknown) {
      a.emettre("session.created", { sessionID: id, info: { id, parentID, title: "délégation", directory: "/workspace/proj", ...(permission === undefined ? {} : { permission }) } });
    },
    miseAJour(id: string, permission?: unknown) {
      a.emettre("session.updated", { sessionID: id, info: { id, title: "t", directory: "/workspace/proj", ...(permission === undefined ? {} : { permission }) } });
    },
    statut(sessionID: string, type: "busy" | "idle" | "retry", attempt?: number) {
      a.emettre("session.status", { sessionID, status: type === "retry" ? { type, attempt, message: "Too Many Requests", next: 1 } : { type } });
    },
    outil(callID: string, tool: string, sessionID = ROOT, status: "completed" | "error" | "running" = "completed") {
      a.emettre("message.part.updated", {
        sessionID,
        part: { id: `prt_${callID}`, messageID: "msg_assistant_1", sessionID, type: "tool", tool, callID, state: { status, input: {}, time: { start: 1, end: 2 } } },
      });
    },
    repos(sessionID = ROOT) {
      a.emettre("session.idle", { sessionID });
    },
    async stable() {
      await service.settled();
    },
    async avancer(ms: number) {
      horloge.avancer(ms);
      await service.settled();
    },
    detections: (): OmoHorsControleData[] => publies.filter((p) => p.type === "omo.hors-controle").map((p) => p.data as OmoHorsControleData),
    listes: (): OmoSignalesData[] => publies.filter((p) => p.type === "omo.signales").map((p) => p.data as OmoSignalesData),
    decisions: (): Array<Record<string, unknown>> =>
      db
        .prepare("SELECT request_id, root_id, session_id, permission, resume, choix, regle, verdict, par, raison FROM autonomy_decisions ORDER BY id")
        .all()
        .map((ligne) => ({ ...ligne })),
  };
  return a;
}

type Atelier = ReturnType<typeof monter>;

/** Une seule détection, cette cause, un arrêt de cette cause d'arrêt et de cette racine, au plus 5 s après `depuis`. */
function assertArret(a: Atelier, cause: string, attendu: { rootId?: string | null; arret?: string; depuis?: number } = {}) {
  assert.deepEqual(
    a.detections().map((d) => d.cause),
    [cause],
    `détections : ${JSON.stringify(a.detections())}`,
  );
  assert.equal(a.arrets.length, 1, `arrêts : ${JSON.stringify(a.arrets)}`);
  const arret = a.arrets[0] as Arret;
  assert.equal(arret.cause, attendu.arret ?? "hors-controle");
  if (attendu.rootId !== undefined) assert.equal(arret.rootId, attendu.rootId);
  if (attendu.depuis !== undefined) assert.ok(arret.at - attendu.depuis <= OMO_DETECTIONS_BORNE_MS, `arrêt après ${arret.at - attendu.depuis} ms`);
}

function assertRien(a: Atelier) {
  assert.deepEqual(a.detections(), [], `détections inattendues : ${JSON.stringify(a.detections())}`);
  assert.deepEqual(a.arrets, [], `arrêts inattendus : ${JSON.stringify(a.arrets)}`);
}

// --- Module, port, délais -------------------------------------------------------------------------------------------------------

describe("détections en service : module, port et délais", () => {
  it("port neutre : objet vide (T3b, inchangé)", () => {
    assert.deepEqual(neutralOmoDetections({} as never), {});
  });

  it("module : salle coupée (SALLE_OUVERTE faux) ou non configurée → aucune inscription, port neutre gardé", () => {
    for (const c11 of [
      { salleOuverte: false, omoControlDirs: { controlDir: "c", stateDir: "s", authDir: "a", opencodeDataDir: "o" } },
      { salleOuverte: true, omoControlDirs: null },
    ]) {
      const inscriptions: string[] = [];
      const reg = {
        hook: () => void inscriptions.push("hook"),
        derivation: () => void inscriptions.push("derivation"),
        hub: () => void inscriptions.push("hub"),
        startup: () => void inscriptions.push("startup"),
        routes: () => void inscriptions.push("routes"),
      };
      const port = neutralOmoDetections({} as never);
      const cible = { ...c11, ports: { omoDetections: port } };
      omoDetectionsModule.install(reg as never, cible as never);
      assert.deepEqual(inscriptions, []);
      assert.equal(cible.ports.omoDetections, port);
    }
  });

  it("salle ouverte : dérivation « omoDetections » et abonnement usage.updated, tous deux pour la salle seule (D-2b-40), port posé", (t) => {
    const inscriptions: Array<{ genre: string; cle: string; instances: unknown }> = [];
    const reg: Registrar = {
      hook: () => assert.fail("aucun crochet"),
      derivation: (derivation) => void inscriptions.push({ genre: "derivation", cle: derivation.name, instances: derivation.instances }),
      hub: (type, _fn, options) => void inscriptions.push({ genre: "hub", cle: type, instances: options?.instances }),
      startup: () => assert.fail("aucun démarrage"),
      routes: () => assert.fail("aucune route"),
    };
    const db = openMemoryDb();
    t.after(() => db.close());
    const c11 = {
      env: { workspaceDir: os.tmpdir() },
      omoControlDirs: { controlDir: "c", stateDir: "s", authDir: "a", opencodeDataDir: "o", projectsFile: null },
      db,
      hub: new EventHub(),
      log: espion().log,
      sessions: new SessionTracker(db, {} as never),
      instances: undefined,
      ports: { omoDetections: {} },
    } as unknown as Cockpit11;
    const service = inscrireDetectionsSalle(reg, c11);
    t.after(() => service.fermer());
    assert.deepEqual(inscriptions, [
      { genre: "derivation", cle: "omoDetections", instances: ["omo"] },
      { genre: "hub", cle: "usage.updated", instances: ["omo"] },
    ]);
    assert.equal(c11.ports.omoDetections, service);
  });

  it("délais : l'arrêt tient dans les 5 s de G13 ; règle de la détection 4 et délégations de l'extension ; outils « sans demande » de l'audit", () => {
    assert.equal(OMO_DETECTIONS_BORNE_MS, 5_000);
    assert.ok(OMO_DETECTIONS_RACINE_DELAI_MS < OMO_DETECTIONS_BORNE_MS);
    assert.ok(OMO_DETECTIONS_CONTROLE_MS <= OMO_DETECTIONS_BORNE_MS);
    assert.ok(OMO_DETECTIONS_CASCADE_MS < OMO_DETECTIONS_BORNE_MS);
    assert.ok(OMO_DETECTIONS_RELANCE_MAX_MS >= 30_000, "relance mesurée en 4,9 s (MB-2) : large marge");
    assert.equal(OMO_DETECTIONS_REGLE_PERMISSION, "ajout-allow-ou-ask");
    assert.deepEqual([...OMO_PERMISSIONS_DELEGATION], ["task", "call_omo_agent"]);
    assert.deepEqual([...OMO_OUTILS_SANS_DEMANDE], OUTILS.filter((o) => o.sansDemande).map((o) => o.nom));
    for (const nom of ["call_omo_agent", "task", "background_output", "grep"]) assert.ok(OMO_OUTILS_SANS_DEMANDE.includes(nom), nom);
    assert.ok(!OMO_OUTILS_SANS_DEMANDE.includes("skill"), "skill passe par une demande (ctx.ask)");
    assert.match(horodatageQuarantaine(T0), /^\d{8}T\d{6}Z$/);
  });
});

// --- Armement ---------------------------------------------------------------------------------------------------------------------

describe("détections en service : armement sur un démarrage accepté (L19b)", () => {
  it("aucune référence de démarrage (aucun precheck-ok) : rien n'est transmis", async (t) => {
    const a = monter(t);
    a.statut(ROOT, "busy");
    a.emettre("global.disposed", {});
    await a.avancer(OMO_DETECTIONS_VEILLE_MS * 3);
    assertRien(a);
  });

  it("démarrage lancé AVANT le cockpit (redémarrage, arrêté par L23b) : rien de son flux n'est lu, puis surveillance reprise si la relance ne vient pas", async (t) => {
    const etat = { startId: START_1, startedAt: T0 - 60_000, phase: "opencode-lance" } as unknown as OmoSupervisorState;
    const a = monter(t, { etatSuperviseur: etat });
    await a.demarrer();
    a.statut(ROOT, "busy");
    a.service.onUsage({ sessionId: ROOT, rootId: ROOT, monthSpentUsd: 1, percent: 1 });
    a.emettre("global.disposed", {});
    await a.avancer(OMO_DETECTIONS_VEILLE_MS);
    assertRien(a);
    await a.avancer(OMO_DETECTIONS_RELANCE_MAX_MS + OMO_DETECTIONS_VEILLE_MS);
    const depuis = a.now();
    a.statut(ROOT, "busy");
    await a.stable();
    assertArret(a, "activite-hors-demande", { rootId: ROOT, depuis });
  });

  it("références retirées (pré-contrôle du démarrage suivant en cours) : plus rien n'est lu pour l'ancien démarrage", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.racine();
    await a.stable();
    a.retirerReferences();
    a.statut(ROOT, "busy");
    a.emettre("global.disposed", {});
    await a.avancer(OMO_DETECTIONS_VEILLE_MS);
    assertRien(a);
  });

  it("démarrage lancé APRÈS le cockpit : surveillé tout de suite", async (t) => {
    const etat = { startId: START_1, startedAt: T0 + 1, phase: "opencode-lance" } as unknown as OmoSupervisorState;
    const a = monter(t, { etatSuperviseur: etat });
    await a.demarrer();
    a.statut(ROOT, "busy");
    await a.stable();
    assertArret(a, "activite-hors-demande", { rootId: ROOT });
  });
});

// --- Détection 1 ------------------------------------------------------------------------------------------------------------------

describe("détection 1 : réponse d'autorisation non émise par le portillon de la salle (T-L23-b, JS-6)", () => {
  it("réponse absente du registre → arrêt en 5 s au plus, événement « omo », fait « detection » et journal hors-contrôle", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    a.racine();
    a.emettre("permission.asked", { id: "per_1", sessionID: ROOT, permission: "bash", tool: { messageID: "msg_1", callID: "call_1" } });
    const depuis = a.now();
    a.emettre("permission.replied", { sessionID: ROOT, requestID: "per_1", reply: "once" });
    await a.stable();
    assertArret(a, "reponse-non-emise", { rootId: ROOT, depuis });
    const evenement = a.publies.find((p) => p.type === "omo.hors-controle");
    assert.equal(evenement?.instance, "omo");
    assert.equal((evenement?.data as OmoHorsControleData).rootId, ROOT);
    const fait = a.faits.find((f) => f.kind === "detection");
    assert.deepEqual(fait?.data, { cas: "hors-controle", cause: "reponse-non-emise", quarantaine: 0, signales: 0, incomplet: false });
    assert.equal(fait?.rootId, ROOT);
    assert.ok(a.journal.dit("hors-contrôle"));
    assert.deepEqual(leaks(a.journal.texte()), []);
  });

  it("garde : réponse inscrite au registre AVANT l'envoi → rien", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    a.racine();
    a.registre.record({ requestId: "per_2", reply: "once", by: "cockpit", at: T0 });
    a.emettre("permission.replied", { sessionID: ROOT, requestID: "per_2", reply: "once" });
    await a.stable();
    assertRien(a);
  });

  it("garde F-c : les autres demandes de la session, refusées d'office avec un refus inscrit, ne sont pas une détection", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    a.racine();
    a.registre.record({ requestId: "per_a", reply: "reject", by: "cockpit", at: T0 });
    a.emettre("permission.replied", { sessionID: ROOT, requestID: "per_a", reply: "reject" });
    a.emettre("permission.replied", { sessionID: ROOT, requestID: "per_b", reply: "reject" });
    await a.stable();
    assertRien(a);
    // Un « once » non inscrit reste une réponse que le cockpit n'a pas émise, cascade ou non.
    a.emettre("permission.replied", { sessionID: ROOT, requestID: "per_c", reply: "once" });
    await a.stable();
    assertArret(a, "reponse-non-emise", { rootId: ROOT });
  });

  it("F-c bornée : un refus non inscrit HORS de la fenêtre, ou d'une autre session, est une détection", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    a.racine();
    a.enfant();
    a.registre.record({ requestId: "per_a", reply: "reject", by: "cockpit", at: T0 });
    a.emettre("permission.replied", { sessionID: ROOT, requestID: "per_a", reply: "reject" });
    a.emettre("permission.replied", { sessionID: ENFANT, requestID: "per_b", reply: "reject" });
    await a.stable();
    assertArret(a, "reponse-non-emise");

    const b = monter(t);
    await b.demarrer();
    b.ouvrirDemande();
    b.racine();
    b.registre.record({ requestId: "per_a", reply: "reject", by: "cockpit", at: T0 });
    b.emettre("permission.replied", { sessionID: ROOT, requestID: "per_a", reply: "reject" });
    await b.avancer(OMO_DETECTIONS_CASCADE_MS + 1);
    b.emettre("permission.replied", { sessionID: ROOT, requestID: "per_b", reply: "reject" });
    await b.stable();
    assertArret(b, "reponse-non-emise");
  });
});

// --- Détection 2 ------------------------------------------------------------------------------------------------------------------

describe("détection 2 : racine non créée par le cockpit (T-L23-c)", () => {
  it("racine sans ligne omo_rooms → arrêt au bout du délai, dans les 5 s", async (t) => {
    const a = monter(t);
    await a.demarrer();
    const depuis = a.now();
    a.racine("ses_etrangere");
    await a.stable();
    await a.avancer(OMO_DETECTIONS_RACINE_DELAI_MS - 1);
    assertRien(a);
    await a.avancer(1);
    assertArret(a, "racine-etrangere", { rootId: null, depuis });
  });

  it("garde : racine ouverte par le cockpit dont la ligne omo_rooms est écrite APRÈS l'événement → rien", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.racine("ses_nouvelle");
    await a.stable();
    a.db.prepare("INSERT INTO omo_rooms (root_id, projet, created_at) VALUES (?, ?, ?)").run("ses_nouvelle", "autre", T0);
    await a.avancer(OMO_DETECTIONS_RACINE_DELAI_MS + OMO_DETECTIONS_VEILLE_MS);
    assertRien(a);
  });

  it("conflit d'identifiant entre instances (L18a) → racine étrangère", async (t) => {
    const a = monter(t);
    await a.demarrer();
    const info = { id: "ses_conflit", title: "t", directory: "/workspace/proj", projectID: "p", time: { created: 1, updated: 1 } } as never;
    a.sessions.upsert(info, undefined, { instance: "principale" });
    a.sessions.upsert(info, undefined, { instance: "omo" });
    await a.stable();
    assertArret(a, "racine-etrangere");
  });
});

// --- Détection 3 ------------------------------------------------------------------------------------------------------------------

describe("détection 3 : opencode rechargé sans le cockpit", () => {
  for (const type of ["global.disposed", "server.instance.disposed"]) {
    it(`${type} → arrêt`, async (t) => {
      const a = monter(t);
      await a.demarrer();
      a.ouvrirDemande();
      a.emettre(type, { directory: "/workspace/proj" });
      await a.stable();
      assertArret(a, "dispose-non-demande", { rootId: ROOT });
    });
  }
});

// --- Détection 4 ------------------------------------------------------------------------------------------------------------------

const allow = (permission: string) => ({ permission, pattern: "*", action: "allow" });
const deny = (permission: string) => ({ permission, pattern: "*", action: "deny" });

describe("détection 4 : permission de session modifiée sans le cockpit (MO-5)", () => {
  it("allow ajouté sur une session de la salle → arrêt", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    a.racine();
    a.enfant(ENFANT, ROOT, [deny("question")]);
    a.miseAJour(ENFANT, [deny("question"), allow("bash")]);
    await a.stable();
    assertArret(a, "permission-modifiee", { rootId: ROOT });
  });

  it("session CRÉÉE avec un allow → arrêt (le cockpit n'en pose aucun dans la salle)", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    a.racine();
    a.enfant(ENFANT, ROOT, [allow("edit")]);
    await a.stable();
    assertArret(a, "permission-modifiee");
  });

  it("permission mal formée → arrêt (fermé en cas de doute)", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    a.racine();
    a.miseAJour(ROOT, "tout permis");
    await a.stable();
    assertArret(a, "permission-modifiee");
  });

  it("garde : délégations de l'extension (refus d'outils, allow sur task et call_omo_agent), mise à jour sans permission (R16) → rien", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    a.racine();
    a.miseAJour(ROOT);
    a.enfant(ENFANT, ROOT, [deny("question")]);
    a.miseAJour(ENFANT, [deny("task"), allow("call_omo_agent"), deny("question"), deny("write"), deny("edit")]);
    a.miseAJour(ENFANT, [allow("task"), allow("call_omo_agent"), deny("question")]);
    a.miseAJour(ENFANT);
    await a.stable();
    assertRien(a);
  });

  it("allow sur read (délégation à multimodal-looker, « read: true » de l'extension) → arrêt : seules task et call_omo_agent sont des délégations", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    a.racine();
    a.enfant(ENFANT, ROOT, [deny("question")]);
    a.miseAJour(ENFANT, [deny("task"), allow("call_omo_agent"), deny("question"), allow("read")]);
    await a.stable();
    assertArret(a, "permission-modifiee", { rootId: ROOT });
  });

  it("garde : écho d'un PATCH annoncé par le cockpit → rien ; le même changement sans annonce → arrêt", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    a.racine();
    a.enfant();
    a.service.annoncerPatch(ENFANT, [allow("bash")]);
    a.miseAJour(ENFANT, [allow("bash")]);
    await a.stable();
    assertRien(a);
    a.miseAJour(ENFANT, []);
    a.miseAJour(ENFANT, [allow("bash")]);
    await a.stable();
    assertArret(a, "permission-modifiee");
  });
});

// --- Détection 5 ------------------------------------------------------------------------------------------------------------------

function faitOrigine(rootId: string, sessionId: string, origine: string): ActivityFact {
  return { rootId, sessionId, kind: "origine", ref: "msg_u1", data: { origine, cas: origine === "origine-inconnue" ? 7 : 5, messageId: "msg_u1" }, at: T0 };
}

describe("détection 5 : message de racine d'origine inconnue (§5.7.2 cas 7, MO-1)", () => {
  it("fait « origine » inconnu sur une racine de la salle → arrêt", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    a.racine();
    await a.stable();
    a.hub.cockpit("activite.fait", faitOrigine(ROOT, ROOT, "origine-inconnue"));
    await a.stable();
    assertArret(a, "origine-inconnue", { rootId: ROOT });
  });

  it("garde : origine inconnue sur un enfant (consigne), origine connue, ou racine de l'instance principale → rien", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    a.racine();
    a.enfant();
    await a.stable();
    a.sessions.upsert({ id: "ses_principale", title: "t", directory: "/w", projectID: "p", time: { created: 1, updated: 1 } } as never, undefined, { instance: "principale" });
    a.hub.cockpit("activite.fait", faitOrigine(ROOT, ENFANT, "origine-inconnue"));
    a.hub.cockpit("activite.fait", faitOrigine(ROOT, ROOT, "relance-extension"));
    a.hub.cockpit("activite.fait", faitOrigine("ses_principale", "ses_principale", "origine-inconnue"));
    await a.stable();
    assertRien(a);
  });
});

// --- Détection 6 ------------------------------------------------------------------------------------------------------------------

/** Quarantaine attendue : nouveau nom sous le même parent, jamais supprimé. */
function nomDeQuarantaine(chemin: string, at: number): string {
  return `${chemin}.suspect-${horodatageQuarantaine(at)}`;
}

describe("détection 6 : configuration apparue et .git créé (T-L23-e, D-2b-37)", () => {
  it(".agents/ apparu à la racine d'un projet préparé → config-apparue (depuis A16 : seulement si un montage a bougé)", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    ecrire(a.workspace, "proj/.agents/skills/x/SKILL.md");
    a.repos();
    await a.stable();
    assertArret(a, "config-apparue", { rootId: ROOT });
  });

  it("garde : configuration présente au démarrage et inchangée (dossier de premier niveau qui n'est pas un projet) → rien", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    a.repos();
    await a.stable();
    assertRien(a);
    // La même, modifiée : c'est une configuration qui change sous la salle (le montage de ce dossier est en lecture seule).
    ecrire(a.workspace, "notes/opencode.json", '{"[synthétique]": "neuf"}');
    a.repos();
    await a.stable();
    assertArret(a, "config-apparue");
  });

  it(".git créé dans une entrée de premier niveau ouverte en écriture (A16) → quarantaine AVANT l'arrêt, rien de supprimé", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    ecrire(a.workspace, "proj/src/.git/HEAD", "ref: refs/heads/piege\n");
    const attendu = nomDeQuarantaine("proj/src/.git", a.now());
    let etatAuArret: [boolean, boolean] | null = null;
    a.auArret(() => {
      etatAuArret = [fs.existsSync(path.join(a.workspace, attendu, "HEAD")), fs.existsSync(path.join(a.workspace, "proj/src/.git"))];
    });
    a.repos();
    await a.stable();
    assertArret(a, "git-cree", { rootId: ROOT });
    assert.deepEqual(etatAuArret, [true, false], "le .git est mis de côté avant l'arrêt, avec son contenu");
    const detection = a.detections()[0] as OmoHorsControleData;
    assert.deepEqual(detection.signales, [{ chemin: attendu, genre: "git-quarantaine" }]);
    assert.equal(a.faits.find((f) => f.kind === "detection")?.data.quarantaine, 1);
  });

  it("/workspace/.git créé → quarantaine puis arrêt (depuis A16 : seulement si un montage a bougé)", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    ecrire(a.workspace, ".git/HEAD", "ref: refs/heads/piege\n");
    const attendu = nomDeQuarantaine(".git", a.now());
    a.repos();
    await a.stable();
    assertArret(a, "git-cree");
    assert.ok(fs.existsSync(path.join(a.workspace, attendu, "HEAD")));
    assert.ok(!fs.existsSync(path.join(a.workspace, ".git")));
  });

  it(".git créé à la racine d'un projet préparé sans historique → quarantaine (impossible dans la salle depuis A16, EROFS : gardé en filet)", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    ecrire(a.workspace, "sansgit/.git/HEAD", "ref: refs/heads/piege\n");
    a.repos();
    await a.stable();
    assertArret(a, "git-cree");
    assert.ok(!fs.existsSync(path.join(a.workspace, "sansgit/.git")));
  });

  it(".GIT (autre casse, dépôt pour le git d'un poste Windows) créé plus profond dans une entrée ouverte → vu et mis de côté", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    ecrire(a.workspace, "proj/src/lib/.GIT/HEAD", "ref: refs/heads/piege\n");
    a.repos();
    await a.stable();
    assertArret(a, "git-cree");
    assert.ok(fs.existsSync(path.join(a.workspace, nomDeQuarantaine("proj/src/lib/.GIT", a.arrets[0]?.at ?? 0), "HEAD")));
  });

  it("garde : .git protégé (gitProteges), même écrit « .Git » sur le disque, et .git sous node_modules → jamais « créé », jamais renommé", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    ecrire(a.workspace, "proj/node_modules/paquet/.git/HEAD", "ref: refs/heads/dependance\n");
    a.repos();
    await a.stable();
    assertRien(a);
    assert.ok(fs.existsSync(path.join(a.workspace, "casse/.Git/HEAD")));
    assert.ok(fs.existsSync(path.join(a.workspace, "proj/.git/HEAD")));
  });

  it("lien .git posé dans une entrée ouverte (A16, hygiène des liens) : jamais suivi, jamais renommé, signalé « à relire »", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    const dehors = path.join(a.dossier, "dehors");
    ecrire(a.dossier, "dehors/HEAD", "ref: refs/heads/dehors\n");
    if (!lierDossier(dehors, path.join(a.workspace, "proj/src/.git"))) {
      t.skip("ce système refuse les liens symboliques et les jonctions");
      return;
    }
    a.repos();
    await a.stable();
    assertArret(a, "git-cree");
    assert.ok(fs.lstatSync(path.join(a.workspace, "proj/src/.git")).isSymbolicLink(), "le lien n'est pas renommé");
    assert.equal(fs.readFileSync(path.join(dehors, "HEAD"), "utf8"), "ref: refs/heads/dehors\n", "la cible n'est pas touchée");
    assert.deepEqual((a.detections()[0] as OmoHorsControleData).signales, [{ chemin: "proj/src/.git", genre: "ide-ci" }]);
    assert.ok(a.journal.dit("NON mis de côté"));
  });
});

// --- Détection 7 ------------------------------------------------------------------------------------------------------------------

describe("détection 7 : fichiers d'IDE et de CI (T-L23-d)", () => {
  it(".vscode/tasks.json créé dans le projet ouvert → arrêt, fichier listé « à relire »", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    ecrire(a.workspace, "proj/.vscode/tasks.json", '{"version": "2.0.0", "tasks": []}');
    a.repos();
    await a.stable();
    assertArret(a, "ide-ci-modifie", { rootId: ROOT });
    assert.deepEqual((a.detections()[0] as OmoHorsControleData).signales, [{ chemin: "proj/.vscode/tasks.json", genre: "ide-ci" }]);
  });

  it(".vscode/tasks.json modifié dans un projet préparé NON ouvert → arrêt (portée « prepares », D-2b-35)", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    ecrire(a.workspace, "autre/.vscode/tasks.json", '{"version": "2.0.0", "tasks": [{"label": "piège"}]}');
    a.repos();
    await a.stable();
    assertArret(a, "ide-ci-modifie");
    assert.deepEqual((a.detections()[0] as OmoHorsControleData).signales, [{ chemin: "autre/.vscode/tasks.json", genre: "ide-ci" }]);
  });

  it("hook git HORS de .git (core.hooksPath, relecture 2 bis-vague-0) modifié → arrêt", async (t) => {
    const a = monter(t, {
      preparer: (ws) => {
        ecrire(ws, "proj/.git/config", "[core]\n\thooksPath = .githooks\n");
        ecrire(ws, "proj/.githooks/pre-commit", "#!/bin/sh\nexit 0\n");
      },
    });
    await a.demarrer();
    a.ouvrirDemande();
    ecrire(a.workspace, "proj/.githooks/pre-commit", "#!/bin/sh\necho piege\n");
    a.repos();
    await a.stable();
    assertArret(a, "ide-ci-modifie");
  });

  it("après un outil terminé : un contrôle tout de suite, puis au plus un toutes les 5 s — le dernier n'est jamais perdu", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    a.outil("call_1", "bash");
    await a.stable();
    ecrire(a.workspace, "proj/.vscode/tasks.json", '{"version": "2.0.0"}');
    a.outil("call_2", "edit");
    await a.stable();
    assertRien(a);
    await a.avancer(OMO_DETECTIONS_CONTROLE_MS - 1);
    assertRien(a);
    await a.avancer(1);
    assertArret(a, "ide-ci-modifie");
  });
});

// --- Détection 8 ------------------------------------------------------------------------------------------------------------------

describe("détection 8 : nouvelles tentatives 429 (D-2b-18)", () => {
  it("trois d'affilée dans l'arbre → arrêt « plafond-tentatives »", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    a.racine();
    a.enfant();
    a.statut(ROOT, "retry", 1);
    a.statut(ENFANT, "retry", 1);
    await a.stable();
    assertRien(a);
    a.statut(ROOT, "busy");
    a.statut(ROOT, "retry", 2);
    await a.stable();
    assertArret(a, "tentatives-429", { rootId: ROOT, arret: "plafond-tentatives" });
  });

  it("garde : nouvelle tentative puis progrès (appel d'IA terminé) → compteur remis à zéro", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    a.racine();
    a.statut(ROOT, "retry", 1);
    a.statut(ROOT, "busy");
    a.statut(ROOT, "retry", 2);
    a.emettre("message.part.updated", { sessionID: ROOT, part: { id: "prt_f", messageID: "msg_a", sessionID: ROOT, type: "step-finish", reason: "stop" } });
    a.statut(ROOT, "busy");
    a.statut(ROOT, "retry", 1);
    a.statut(ROOT, "busy");
    a.statut(ROOT, "retry", 2);
    await a.stable();
    assertRien(a);
  });
});

// --- Activité hors demande (D-2b-29) ----------------------------------------------------------------------------------------------

describe("activité de la salle sans demande active (D-2b-29)", () => {
  it("session occupée sans demande → arrêt de la salle", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.racine();
    a.statut(ROOT, "busy");
    await a.stable();
    assertArret(a, "activite-hors-demande", { rootId: ROOT });
  });

  it("usage.updated sans demande → arrêt ; rattrapage sans session → rien", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.racine();
    a.service.onUsage({ monthSpentUsd: 1, percent: 1 });
    await a.stable();
    assertRien(a);
    a.service.onUsage({ sessionId: ROOT, rootId: ROOT, monthSpentUsd: 1, percent: 1, instance: "omo" });
    await a.stable();
    assertArret(a, "activite-hors-demande", { rootId: ROOT });
  });

  it("nouveau message sans demande → arrêt", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.racine();
    a.emettre("message.updated", { sessionID: ROOT, info: { id: "msg_x", sessionID: ROOT, role: "assistant", time: { created: 1 } } });
    await a.stable();
    assertArret(a, "activite-hors-demande");
  });

  it("garde : enfant avec parentID pendant la demande → rien ; le même hors demande → arrêt", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    a.racine();
    a.enfant();
    a.statut(ENFANT, "busy");
    a.emettre("message.updated", { sessionID: ENFANT, info: { id: "msg_e", sessionID: ENFANT, role: "user", time: { created: 1 } } });
    a.service.onUsage({ sessionId: ENFANT, rootId: ROOT, monthSpentUsd: 1, percent: 1 });
    await a.stable();
    assertRien(a);

    const b = monter(t);
    await b.demarrer();
    b.racine();
    b.enfant();
    await b.stable();
    assertArret(b, "activite-hors-demande");
  });

  it("activité d'une AUTRE racine de la salle pendant une demande → arrêt", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande(ROOT);
    a.racine(ROOT);
    a.racine(ROOT_AUTRE);
    a.statut(ROOT_AUTRE, "busy");
    await a.stable();
    assertArret(a, "activite-hors-demande", { rootId: ROOT_AUTRE });
  });
});

// --- Fin de demande et relance ------------------------------------------------------------------------------------------------------

describe("fin de demande, arrêt et relance à neuf demandés par le cockpit", () => {
  it("après la fin de la demande, le flux de l'arrêt (abandon, dernier coût, dispose, refus) n'est pas lu comme l'extension", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    a.racine();
    a.statut(ROOT, "busy");
    await a.stable();
    a.fermerDemande();
    await a.avancer(OMO_DETECTIONS_VEILLE_MS);
    a.statut(ROOT, "busy");
    a.service.onUsage({ sessionId: ROOT, rootId: ROOT, monthSpentUsd: 1, percent: 1 });
    a.emettre("session.error", { sessionID: ROOT, error: { name: "MessageAbortedError" } });
    a.emettre("permission.replied", { sessionID: ROOT, requestID: "per_z", reply: "reject" });
    a.emettre("server.instance.disposed", { directory: "/workspace/proj" });
    await a.stable();
    assertRien(a);
  });

  it("le flux lu AVANT la veille est déjà filtré : la fin de demande est vue à la réception du fait", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    a.racine();
    await a.stable();
    a.fermerDemande();
    a.statut(ROOT, "busy");
    await a.stable();
    assertRien(a);
  });

  it("démarrage suivant (relance à neuf) : état neuf, la salle au repos est surveillée", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    a.racine();
    a.statut(ROOT, "retry", 1);
    a.statut(ROOT, "busy");
    a.statut(ROOT, "retry", 2);
    await a.stable();
    a.fermerDemande();
    await a.avancer(OMO_DETECTIONS_VEILLE_MS);
    await a.demarrer(START_2);
    a.ouvrirDemande(ROOT, "req_2");
    a.statut(ROOT, "busy");
    a.statut(ROOT, "retry", 1);
    await a.stable();
    assertRien(a);
    a.fermerDemande();
    await a.avancer(OMO_DETECTIONS_VEILLE_MS);
    await a.demarrer(START_3);
    a.statut(ROOT, "busy");
    await a.stable();
    assertArret(a, "activite-hors-demande");
  });

  it("relance jamais vue : la salle est de nouveau surveillée au bout de OMO_DETECTIONS_RELANCE_MAX_MS", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    a.racine();
    await a.stable();
    a.fermerDemande();
    await a.avancer(OMO_DETECTIONS_VEILLE_MS);
    a.statut(ROOT, "busy");
    await a.stable();
    assertRien(a);
    await a.avancer(OMO_DETECTIONS_RELANCE_MAX_MS + OMO_DETECTIONS_VEILLE_MS);
    a.statut(ROOT, "busy");
    await a.stable();
    assertArret(a, "activite-hors-demande");
  });

  it("une détection arrête une fois : les faits suivants du même démarrage ne relancent pas d'arrêt", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.racine();
    a.statut(ROOT, "busy");
    a.emettre("global.disposed", {});
    a.emettre("permission.replied", { sessionID: ROOT, requestID: "per_q", reply: "once" });
    await a.stable();
    assertArret(a, "activite-hors-demande");
  });

  it("une détection du flux pendant un contrôle du disque en cours : un seul arrêt, jamais un second pour ce que le contrôle trouve", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    a.racine();
    await a.stable();
    ecrire(a.workspace, "proj/.vscode/tasks.json", '{"version": "2.0.0", "tasks": [{"label": "piège"}]}');
    // L'outil terminé lance un contrôle tout de suite ; la réponse non émise est lue pendant qu'il relève le disque.
    a.outil("call_1", "bash");
    a.emettre("permission.replied", { sessionID: ROOT, requestID: "per_x", reply: "once" });
    await a.stable();
    assertArret(a, "reponse-non-emise", { rootId: ROOT });
  });
});

// --- Fichiers signalés (T-L23-i) --------------------------------------------------------------------------------------------------

describe("fichiers signalés sans arrêt, listés en fin de demande (T-L23-i, §4.14.5 l.850)", () => {
  it("package.json, Makefile et *.ps1 modifiés ou créés → aucun arrêt, liste publiée en fin de demande", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    ecrire(a.workspace, "proj/package.json", '{"name": "proj", "scripts": {"postinstall": "node x.js"}}');
    ecrire(a.workspace, "proj/src/build.ps1", "Write-Output 'synthétique'\n");
    ecrire(a.workspace, "proj/src/Makefile", "all:\n\techo synthétique\n");
    a.outil("call_1", "write");
    a.repos();
    await a.stable();
    assertRien(a);
    a.fermerDemande();
    await a.avancer(OMO_DETECTIONS_VEILLE_MS);
    assertRien(a);
    const signales: OmoSignale[] = [
      { chemin: "proj/package.json", genre: "programme" },
      { chemin: "proj/src/Makefile", genre: "programme" },
      { chemin: "proj/src/build.ps1", genre: "programme" },
    ];
    assert.deepEqual(a.listes(), [{ rootId: ROOT, signales, incomplet: false }]);
    assert.equal(a.publies.find((p) => p.type === "omo.signales")?.instance, "omo");
  });

  it("rien à relire : aucune liste publiée", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    a.repos();
    await a.stable();
    a.fermerDemande();
    await a.avancer(OMO_DETECTIONS_VEILLE_MS);
    assert.deepEqual(a.listes(), []);
  });

  it("descente des fichiers signalés incomplète (signalesIncomplet de L19a) → la liste de fin de demande DIT qu'elle est incomplète", async (t) => {
    const a = monter(t, {
      bornes: { signalesMaxFichiers: 1 },
      preparer: (ws) => {
        ecrire(ws, "proj/scripts/a.ps1", "Write-Output 'a'\n");
        ecrire(ws, "proj/scripts/b.ps1", "Write-Output 'b'\n");
      },
    });
    await a.demarrer();
    a.ouvrirDemande();
    a.repos();
    await a.stable();
    a.fermerDemande();
    await a.avancer(OMO_DETECTIONS_VEILLE_MS);
    assertRien(a);
    assert.deepEqual(
      a.listes().map((l) => l.incomplet),
      [true],
    );
  });
});

// --- par: extension ---------------------------------------------------------------------------------------------------------------

describe("actions de l'extension vues sans demande : autonomy_decisions {par: \"extension\"} et fait (§4.12 l.784)", () => {
  it("outil « sans demande » de l'audit terminé sans permission.asked → ligne du Journal et fait « decision »", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    a.racine();
    a.outil("call_omo_1", "call_omo_agent");
    await a.stable();
    assert.deepEqual(a.decisions(), [
      {
        request_id: "req_1",
        root_id: ROOT,
        session_id: ROOT,
        permission: "call_omo_agent",
        resume: "call_omo_agent",
        choix: "omo",
        regle: OMO_REGLE_SANS_DEMANDE,
        verdict: "non-controle",
        par: "extension",
        raison: TEXTES_SANS_DEMANDE.avance.sansDemande.call_omo_agent,
      },
    ]);
    const fait = a.faits.find((f) => f.kind === "decision");
    assert.deepEqual([fait?.rootId, fait?.ref, fait?.data], [ROOT, "call_omo_1", { verdict: "non-controle", regle: OMO_REGLE_SANS_DEMANDE }]);
    assertRien(a);
  });

  it("garde : outil passé par sa demande, outil hors de l'audit, outil encore en cours, même appel revu → aucune ligne ; outil coupé vu en service → ligne", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    a.racine();
    a.emettre("permission.asked", { id: "per_t", sessionID: ROOT, permission: "task", tool: { messageID: "msg_1", callID: "call_task_1" } });
    a.registre.record({ requestId: "per_t", reply: "once", by: "cockpit", at: T0 });
    a.emettre("permission.replied", { sessionID: ROOT, requestID: "per_t", reply: "once" });
    a.outil("call_task_1", "task");
    a.outil("call_bash_1", "bash");
    a.outil("call_omo_2", "call_omo_agent", ROOT, "running");
    a.outil("call_grep_1", "grep");
    a.outil("call_grep_1", "grep", ROOT, "error");
    await a.stable();
    const lignes = a.decisions();
    assert.deepEqual(
      lignes.map((l) => l.permission),
      ["grep"],
    );
    assert.equal(lignes[0]?.raison, OUTILS.find((o) => o.nom === "grep")?.motif);
    assertRien(a);
  });
});

// --- Gardes propres au service -------------------------------------------------------------------------------------------------------

describe("détections en service : gardes propres au service", () => {
  it("événement de l'instance principale : jamais lu par les détections de la salle", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.service.onEvent({ payload: { type: "session.status", properties: { sessionID: ROOT, status: { type: "busy" } } } }, { instance: "principale" });
    await a.stable();
    assertRien(a);
    a.service.onEvent({ payload: { type: "session.status", properties: { sessionID: ROOT, status: { type: "busy" } } } }, { instance: "omo" });
    await a.stable();
    assertArret(a, "activite-hors-demande");
  });

  it("statut inconnu d'opencode : une activité (fermé en cas de doute)", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.emettre("session.status", { sessionID: ROOT, status: { type: "inconnu-de-cette-version" } });
    await a.stable();
    assertArret(a, "activite-hors-demande");
  });

  it("session jamais vue dont la mise à jour porte un allow : la référence est « aucune règle », la plus stricte → arrêt", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    a.miseAJour("ses_jamais_vue", [allow("bash")]);
    await a.stable();
    assertArret(a, "permission-modifiee");
  });

  it("garde : un message déjà vu, mis à jour plus tard, n'est pas un message nouveau", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    a.racine();
    a.emettre("message.updated", { sessionID: ROOT, info: { id: "msg_a", sessionID: ROOT, role: "assistant", time: { created: 1 } } });
    await a.stable();
    a.fermerDemande();
    await a.avancer(OMO_DETECTIONS_VEILLE_MS);
    await a.avancer(OMO_DETECTIONS_RELANCE_MAX_MS + OMO_DETECTIONS_VEILLE_MS);
    a.emettre("message.updated", { sessionID: ROOT, info: { id: "msg_a", sessionID: ROOT, role: "assistant", time: { created: 1, completed: 2 } } });
    await a.stable();
    assertRien(a);
    a.emettre("message.updated", { sessionID: ROOT, info: { id: "msg_b", sessionID: ROOT, role: "assistant", time: { created: 3 } } });
    await a.stable();
    assertArret(a, "activite-hors-demande");
  });

  it("session.idle : contrôle tout de suite, même dans les 5 s d'un outil terminé", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    a.outil("call_1", "bash");
    await a.stable();
    ecrire(a.workspace, "proj/.vscode/tasks.json", '{"version": "2.0.0"}');
    a.outil("call_2", "edit");
    await a.stable();
    assertRien(a);
    a.repos();
    await a.stable();
    assertArret(a, "ide-ci-modifie");
  });

  it("fichier d'IDE modifié APRÈS le dernier contrôle et avant la fin de la demande → vu par le contrôle de fin de demande", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    a.racine();
    a.repos();
    await a.stable();
    ecrire(a.workspace, "proj/.vscode/tasks.json", '{"version": "2.0.0", "tasks": [{"label": "tard"}]}');
    a.fermerDemande();
    await a.avancer(OMO_DETECTIONS_VEILLE_MS);
    assertArret(a, "ide-ci-modifie", { rootId: ROOT });
    assert.deepEqual(a.listes(), [], "la liste de fin de demande est partie avec la détection");
  });

  it("configuration apparue entre le pré-contrôle et le premier fait : vue (référence « aucune » exigée par le pré-contrôle)", async (t) => {
    const a = monter(t);
    await a.demarrer();
    ecrire(a.workspace, "proj/opencode.json", '{"[synthétique]": "configuration posée tôt"}');
    a.ouvrirDemande();
    a.repos();
    await a.stable();
    assertArret(a, "config-apparue");
  });

  it("configuration : nom d'une autre casse vu ; `.omo/omo.jsonc` vu, `.omo/boulder.json` (état de l'extension) accepté", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    ecrire(a.workspace, "proj/.omo/boulder.json", '{"[synthétique]": "état"}');
    a.repos();
    await a.stable();
    assertRien(a);
    ecrire(a.workspace, "proj/.omo/omo.jsonc", '{"[synthétique]": "configuration"}');
    a.repos();
    await a.stable();
    assertArret(a, "config-apparue");

    // Dossier de premier niveau qui n'est pas un projet : sa référence est relevée à l'armement (premier fait), la configuration
    // vient après.
    const b = monter(t);
    await b.demarrer();
    b.ouvrirDemande();
    b.repos();
    await b.stable();
    ecrire(b.workspace, "notes/OpenCode.JSON", '{"[synthétique]": "casse"}');
    b.repos();
    await b.stable();
    assertArret(b, "config-apparue");
  });

  it("garde : .git listé par install.ps1 (gitProteges) mais absent des références → jamais renommé, listé « à relire »", async (t) => {
    const a = monter(t, { gitProtegesEnPlus: ["sansgit/.git"] });
    await a.demarrer();
    a.ouvrirDemande();
    ecrire(a.workspace, "sansgit/.git/HEAD", "ref: refs/heads/hote\n");
    a.repos();
    await a.stable();
    assertArret(a, "git-cree");
    assert.ok(fs.existsSync(path.join(a.workspace, "sansgit/.git/HEAD")), "un .git protégé n'est jamais renommé");
    assert.deepEqual((a.detections()[0] as OmoHorsControleData).signales, [{ chemin: "sansgit/.git", genre: "ide-ci" }]);
  });

  it("références incomplètes, relevé courant complet : la liste de fin de demande dit toujours qu'elle est incomplète", async (t) => {
    const a = monter(t, {
      bornes: { signalesMaxFichiers: 1 },
      preparer: (ws) => {
        ecrire(ws, "proj/scripts/a.ps1", "Write-Output 'a'\n");
        ecrire(ws, "proj/scripts/b.ps1", "Write-Output 'b'\n");
      },
    });
    await a.demarrer();
    a.ouvrirDemande();
    fs.rmSync(path.join(a.workspace, "proj/scripts/b.ps1"));
    a.repos();
    await a.stable();
    a.fermerDemande();
    await a.avancer(OMO_DETECTIONS_VEILLE_MS);
    assertRien(a);
    assert.deepEqual(a.listes(), [{ rootId: ROOT, signales: [], incomplet: true }]);
  });

  it("références complètes, relevé courant incomplet (fichiers signalés ajoutés au-delà de la borne) : la liste le dit", async (t) => {
    const a = monter(t, { bornes: { signalesMaxFichiers: 1 } });
    await a.demarrer();
    a.ouvrirDemande();
    ecrire(a.workspace, "proj/scripts/a.ps1", "Write-Output 'a'\n");
    ecrire(a.workspace, "proj/scripts/b.ps1", "Write-Output 'b'\n");
    a.repos();
    await a.stable();
    a.fermerDemande();
    await a.avancer(OMO_DETECTIONS_VEILLE_MS);
    assertRien(a);
    assert.deepEqual(
      a.listes().map((l) => l.incomplet),
      [true],
    );
  });

  it("relevé impossible (borne des empreintes) : doute → arrêt (fermé en cas de doute)", async (t) => {
    const a = monter(t, {
      bornes: { empreintesMaxFichiers: 1 },
      preparer: (ws) => ecrire(ws, "proj/.vscode/extensions.json", '{"recommendations": []}'),
    });
    await a.demarrer();
    a.ouvrirDemande();
    a.repos();
    await a.stable();
    assertArret(a, "ide-ci-modifie");
  });

  it("liste des projets préparés illisible à l'armement : aucun .git ne peut être jugé → doute → arrêt", async (t) => {
    const a = monter(t);
    await a.demarrer();
    fs.rmSync(a.projectsFile);
    a.ouvrirDemande();
    a.repos();
    await a.stable();
    assertArret(a, "ide-ci-modifie");
    assert.ok(a.journal.dit("liste des projets préparés illisible"));
  });

  it("parcours des .git borné : limite atteinte → doute → arrêt", async (t) => {
    const a = monter(t, { bornes: { balayageGitEntreesMax: 3 } });
    await a.demarrer();
    a.ouvrirDemande();
    a.repos();
    await a.stable();
    assertArret(a, "ide-ci-modifie");
  });

  it("garde : node_modules très peuplé jamais parcouru par la recherche des .git → la borne n'est pas atteinte, aucun arrêt", async (t) => {
    // Le dossier de travail de l'atelier compte une vingtaine d'entrées hors node_modules ; node_modules en compte 60 de plus.
    const a = monter(t, {
      bornes: { balayageGitEntreesMax: 40 },
      preparer: (ws) => {
        for (let i = 0; i < 60; i++) ecrire(ws, `proj/node_modules/paquet-${i}/index.js`, "module.exports = 1;\n");
      },
    });
    await a.demarrer();
    a.ouvrirDemande();
    a.repos();
    await a.stable();
    assertRien(a);
  });

  it("garde : .git protégé listé AVEC des majuscules (Outils/MonDepot/.git), hors des relevés → jamais « créé », jamais renommé", async (t) => {
    const a = monter(t, {
      gitProtegesEnPlus: ["Outils/MonDepot/.git"],
      preparer: (ws) => ecrire(ws, "Outils/MonDepot/.git/HEAD", "ref: refs/heads/hote\n"),
    });
    await a.demarrer();
    a.ouvrirDemande();
    a.repos();
    await a.stable();
    assertRien(a);
    assert.ok(fs.existsSync(path.join(a.workspace, "Outils/MonDepot/.git/HEAD")), "l'historique de l'utilisateur reste à sa place");
  });

  it("lien posé dans une entrée ouverte au nom d'un fichier signalé (A16, hygiène des liens) : jamais suivi, la liste « à relire » dit qu'elle est incomplète", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    const dehors = path.join(a.dossier, "dehors");
    ecrire(a.dossier, "dehors/Makefile", "all:\n\techo dehors\n");
    if (!lierDossier(dehors, path.join(a.workspace, "proj/src/run.ps1"))) {
      t.skip("ce système refuse les liens symboliques et les jonctions");
      return;
    }
    a.repos();
    await a.stable();
    assertRien(a);
    a.fermerDemande();
    await a.avancer(OMO_DETECTIONS_VEILLE_MS);
    assertRien(a);
    assert.deepEqual(a.listes(), [{ rootId: ROOT, signales: [], incomplet: true }], "rien n'est lu au bout du lien");
    assert.ok(fs.lstatSync(path.join(a.workspace, "proj/src/run.ps1")).isSymbolicLink(), "le lien reste tel quel");
  });

  it("projet préparé remplacé par un lien : rien n'est lu au bout (doute), jamais la configuration de la cible", async (t) => {
    const a = monter(t);
    await a.demarrer();
    a.ouvrirDemande();
    ecrire(a.dossier, "cible/opencode.json", '{"[synthétique]": "au bout du lien"}');
    fs.rmSync(path.join(a.workspace, "sansgit"), { recursive: true, force: true });
    if (!lierDossier(path.join(a.dossier, "cible"), path.join(a.workspace, "sansgit"))) {
      t.skip("ce système refuse les liens symboliques et les jonctions");
      return;
    }
    a.repos();
    await a.stable();
    assertArret(a, "ide-ci-modifie");
  });

  it("projet préparé imbriqué dans un dossier de premier niveau : chemins communs aux deux relevés fusionnés, listés une fois", async (t) => {
    const a = monter(t, { imbrique: true });
    await a.demarrer();
    a.ouvrirDemande();
    a.repos();
    await a.stable();
    assertRien(a);
    ecrire(a.workspace, "groupe/app/package.json", '{"name": "app", "scripts": {"prepare": "node y.js"}}');
    a.repos();
    await a.stable();
    a.fermerDemande();
    await a.avancer(OMO_DETECTIONS_VEILLE_MS);
    assertRien(a);
    assert.deepEqual(a.listes(), [{ rootId: ROOT, signales: [{ chemin: "groupe/app/package.json", genre: "programme" }], incomplet: false }]);
  });
});

// --- G13 : zéro faux positif sur une capture de la salle -------------------------------------------------------------------------

describe("G13 (partie CI) : zéro faux positif sur la capture R16 du banc de la salle", () => {
  it("rejeu de omo-banc-r16.jsonl (jumeaux « sync » compris), racine ouverte par le cockpit, demande active → aucune détection", async (t) => {
    const lignes = fs
      .readFileSync(path.join(import.meta.dirname, "test-support", "fixtures", "omo-banc-r16.jsonl"), "utf8")
      .split("\n")
      .filter((ligne) => ligne.trim() !== "")
      .map((ligne) => JSON.parse(ligne) as { event: { directory?: string; payload: { type: string; properties?: Record<string, unknown> } } });
    const creation = lignes.find((l) => l.event.payload.type === "session.created");
    const racine = (creation?.event.payload.properties?.info as { id: string }).id;
    const a = monter(t);
    a.db.prepare("INSERT INTO omo_rooms (root_id, projet, created_at) VALUES (?, ?, ?)").run(racine, "proj", T0);
    await a.demarrer();
    a.ouvrirDemande(racine);
    for (const ligne of lignes) a.service.onEvent(ligne.event as never, { instance: "omo" });
    await a.stable();
    await a.avancer(OMO_DETECTIONS_RACINE_DELAI_MS + OMO_DETECTIONS_CONTROLE_MS);
    assertRien(a);
    assert.equal(lignes.filter((l) => l.event.payload.type === "sync").length > 0, true, "la capture porte des jumeaux « sync »");
  });
});

// --- G13 : programme muni du mot de passe, sur le faux opencode, par le vrai processeur de la salle --------------------------------

describe("G13 (partie CI) : programme muni du mot de passe de la salle, sur le faux → arrêt en 5 s au plus", () => {
  it("création de racine, rechargement, réponse à sa propre demande : trois arrêts, chacun dans les 5 s", async (t) => {
    const horloge = fausseHorloge();
    const racine = fs.mkdtempSync(path.join(os.tmpdir(), "omo-detections-g13-"));
    t.after(() => fs.rmSync(racine, { recursive: true, force: true }));
    const projectsFile = path.join(racine, "omo-projets.json");
    fs.writeFileSync(projectsFile, JSON.stringify({ version: 1, genereLe: "2026-09-23T00:00:00.000Z", projets: [], gitProteges: [] }));
    let references: OmoPrecheckReferences | null = null;
    let demande: OmoActiveRequest | null = null;
    const arrets: Arret[] = [];
    let service: ReturnType<typeof inscrireDetectionsSalle> | null = null;
    const h = await startCockpit(t, {
      omo: true,
      // La salle reste coupée dans le dépôt : ce module factice installe les détections RÉELLES sur la salle du harnais.
      modules: [{ name: "omoDetections", install: (reg, c11) => void (service = inscrireDetectionsSalle(reg, c11, { projectsFile, clock: horloge.clock })) }],
      ports: {
        omoPrecheck: { check: async () => ({ ok: false, code: "salle-coupee" }), beforeStart: async () => ({ ok: false }), references: () => references } as never,
        omoActivation: { activeRequest: () => demande } as never,
        omoStop: {
          run: async (rootId: string | null, cause: string) => {
            arrets.push({ rootId, cause, at: horloge.clock.now() });
            return {} as never;
          },
          relaunchAfterRequest: async () => undefined,
        } as never,
      },
    });
    assert.ok(h.omo && service);
    const omo = h.omo;
    const detections = service as ReturnType<typeof inscrireDetectionsSalle>;
    const armer = async (startId: string) => {
      references = { startId, at: horloge.clock.now(), releves: await releverEmpreintesSalle({ workspace: h.cockpit.c11.env.workspaceDir, prepares: [] }) };
    };
    // Le « programme » : le mot de passe de la salle, sans passer par le cockpit (ni proxy, ni route de salle).
    const programme = omo.deps.client;

    // 1. Création d'une racine.
    await armer(START_1);
    const debut1 = Date.now();
    const etrangere = await programme.request<{ id: string }>("POST", "/session", { body: { title: "programme" } });
    await until(() => h.sessions.get(etrangere.id));
    await detections.settled();
    horloge.avancer(OMO_DETECTIONS_RACINE_DELAI_MS);
    await detections.settled();
    assert.deepEqual(
      arrets.map((x) => x.cause),
      ["hors-controle"],
    );
    assert.ok(Date.now() - debut1 < OMO_DETECTIONS_BORNE_MS);

    // 2. Rechargement d'opencode (nouveau démarrage : état neuf).
    await armer(START_2);
    const debut2 = Date.now();
    await programme.request("POST", "/instance/dispose", {});
    await until(() => arrets.length === 2);
    assert.ok(Date.now() - debut2 < OMO_DETECTIONS_BORNE_MS);

    // 3. Réponse à sa propre demande, pendant une demande légitime de la salle.
    await armer(START_3);
    const salle = await programme.request<{ id: string }>("POST", "/session", { body: { title: "proj" } });
    h.db.prepare("INSERT INTO omo_rooms (root_id, projet, created_at) VALUES (?, ?, ?)").run(salle.id, "proj", T0);
    demande = { rootId: salle.id, requestId: "req_g13", startedAt: T0, plafondUsd: "1.00" };
    omo.fake.script(salle.id, { tools: [bash("ls")], followUp: { text: "fini" } });
    assert.equal(await promptAsync(programme, salle.id, "[synthétique] liste"), 204);
    const demandeAutorisation = await until(() => omo.fake.pendingPermissions()[0]);
    const debut3 = Date.now();
    await programme.request("POST", `/permission/${demandeAutorisation.id}/reply`, { body: { reply: "once" } });
    await until(() => arrets.length === 3);
    assert.ok(Date.now() - debut3 < OMO_DETECTIONS_BORNE_MS);
    await detections.settled();
    const causes = h
      .cockpitEvents()
      .filter((e) => e.type === "omo.hors-controle")
      .map((e) => (e.data as OmoHorsControleData).cause);
    assert.deepEqual(causes, ["racine-etrangere", "dispose-non-demande", "reponse-non-emise"]);
    assert.deepEqual(
      arrets.map((x) => [x.rootId, x.cause]),
      [
        [null, "hors-controle"],
        [null, "hors-controle"],
        [salle.id, "hors-controle"],
      ],
    );
  });
});
