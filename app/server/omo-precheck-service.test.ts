// Pré-contrôle en service de la Salle OMO (L19b) : `check`, `beforeStart`, portée « prepares » (D-2b-35), ligne
// `omo_room_starts` liée au `start_id` (D-2b-21, D-2b-42) et `precheck-ok` lié au démarrage.
//
// Chaque garde a son test qui échoue sans elle : portée « prepares » (un projet préparé piégé NON ouvert refuse le démarrage)
// et portée « ouverts » (seul le projet piégé est refusé) ; fichier piégé ajouté entre deux démarrages ; `startId` différent de
// celui de `state.json` ; `.git` non protégé vu par la salle, dépôt git hors protection vu par le cockpit, balayage tronqué ;
// dossier de configuration non conforme ; salle suspendue ; même `startId` après une reprise ; liste des projets préparés
// illisible ; refus de l'écrivain de L17b (espion levant `OmoControlTropGrosError`) rendu LISIBLE et journalisé.
//
// L'écrivain est le VRAI service de L17b (`createOmoControl`) sur des dossiers temporaires : ce que ce module demande est donc
// écrit — ou refusé — comme en production, et `precheck-ok` est relu par le lecteur du format et comparé aux vecteurs communs
// de `omo-control-vectors.json`. Horloge injectée : la surveillance de `state.json` est vérifiée sans aucune attente réelle.
// Aucun secret, aucun chemin d'hôte dans les listes masquées ni dans le journal (`leaks`).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, it, type TestContext } from "node:test";
import { openMemoryDb } from "./db.ts";
import { type BrowserEvent, EventHub } from "./hub.ts";
import { createOmoControl, type OmoControlClock } from "./omo-control.ts";
import type { OmoControlPort, OmoRoomPort } from "./omo-contracts.ts";
import {
  createOmoPrecheckService,
  neutralOmoPrecheck,
  OMO_PRECHECK_SURVEILLANCE_MS,
  omoPrecheckModule,
  PRECHECK_PORTEE,
  type OmoPrecheckService,
} from "./omo-precheck-service.ts";
import { analyserPrecheckOk, ecrireEtat, OmoControlTropGrosError } from "./shared/omo-control-protocol.ts";
import { PRECHECK_BORNES } from "./shared/omo-precheck-rules.ts";
import type { OmoPreparedProjects, OmoSupervisorState } from "./shared/omo-types.ts";
import { leaks } from "./test-support/helpers.ts";

const T0 = 1_757_000_000_000;
const EMPREINTE = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/** Marque des contenus fabriqués : reconnaissable dans un message d'échec, inoffensive dans un fichier. */
const CONTENU = "[synthétique] atelier du test L19b, aucun secret.";

interface Vecteur {
  nom: string;
  format: string;
  texte?: string;
  attendu?: unknown;
}

const FIXTURE = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "test-support", "fixtures", "omo-control-vectors.json"), "utf8")) as {
  startId: string;
  autreStartId: string;
  vecteurs: Vecteur[];
};

const DEMARRAGE = FIXTURE.startId;
const AUTRE_DEMARRAGE = FIXTURE.autreStartId;

// --- Atelier ----------------------------------------------------------------------------------------------------------------------

/** Horloge de la surveillance : minuteries en attente, déclenchées par `avancer`, jamais par le temps réel. */
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
    enAttente: () => minuteries.size,
    /** Avance de `ms`, en déclenchant dans l'ordre chaque minuterie échue. */
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

interface Ligne {
  niveau: "info" | "warn";
  message: string;
  champs: Record<string, unknown> | undefined;
}

/** Espion du journal : tout ce que le service écrit, messages et champs. */
function espion() {
  const lignes: Ligne[] = [];
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

/** Projet ordinaire du dossier de travail : un `.git` (dossier), un README, un package.json et des réglages d'IDE. */
function fabriquerProjet(workspace: string, nom: string): void {
  ecrire(workspace, `${nom}/.git/HEAD`, "ref: refs/heads/principale\n");
  ecrire(workspace, `${nom}/README.md`);
  ecrire(workspace, `${nom}/package.json`, '{"name": "projet", "private": true}');
  ecrire(workspace, `${nom}/.vscode/settings.json`, '{"[synthétique]": "réglages d\'IDE"}');
}

/** Piège JS-4 posé dans un projet : une configuration d'opencode, refusée par les règles pures de L19a. */
function piegerProjet(workspace: string, nom: string): void {
  ecrire(workspace, `${nom}/opencode.json`, '{"[synthétique]": "configuration piégée"}');
}

function listeProjets(projets: readonly string[]): OmoPreparedProjects {
  return {
    version: 1,
    genereLe: "2026-09-19T00:00:00.000Z",
    projets: projets.map((chemin) => ({ chemin, git: "dossier" as const })),
    gitProteges: projets.map((chemin) => ({ chemin: `${chemin}/.git`, forme: "dossier" as const })),
  };
}

function etatDe(startId: string, over: Partial<OmoSupervisorState> = {}): OmoSupervisorState {
  return {
    startId,
    phase: "attente",
    imageId: "sha256:image-de-test",
    manifestSha256: EMPREINTE,
    manifesteReference: "ok",
    validation: "ok",
    dossiersConfig: [{ chemin: "/home/node/.config/opencode", ok: true }],
    projets: [{ chemin: "sain", gitLectureSeule: true }],
    workspaceGit: { verifieLe: T0, limiteAtteinte: false, nonProteges: [] },
    startedAt: T0,
    ...over,
  };
}

interface Options {
  /** Projets fabriqués dans le dossier de travail, tous déclarés préparés. */
  projets?: string[];
  /** Projets piégés dès la fabrication. */
  pieges?: string[];
  /** Projets rendus par `omoRoom.openProjects` (port surchargé). */
  ouverts?: string[];
  portee?: "prepares" | "ouverts";
  /** Faux : la salle est coupée (COCKPIT_OMO, COCKPIT_AUTONOMY ou SALLE_OUVERTE). */
  actif?: boolean;
  /** Faux : aucun `omo-projets.json` n'est remis au service. */
  liste?: boolean;
  /** Écrivain de rechange (espion de refus) à la place du vrai service de L17b. */
  control?: (reel: OmoControlPort) => OmoControlPort;
}

function monter(t: TestContext, options: Options = {}) {
  const racine = fs.mkdtempSync(path.join(os.tmpdir(), "omo-precheck-service-"));
  t.after(() => {
    try {
      fs.rmSync(racine, { recursive: true, force: true });
    } catch {
      // Dossier temporaire verrouillé : le système le reprendra.
    }
  });
  const d = {
    workspace: path.join(racine, "workspace"),
    controlDir: path.join(racine, "control-omo"),
    stateDir: path.join(racine, "omo-state"),
    authDir: path.join(racine, "omo-auth"),
    dataDir: path.join(racine, "oc-data"),
    donnees: path.join(racine, "donnees-cockpit"),
    projectsFile: path.join(racine, "hote", "omo-projets.json"),
  };
  for (const dossier of [d.workspace, d.stateDir, d.dataDir, d.donnees, path.dirname(d.projectsFile)]) fs.mkdirSync(dossier, { recursive: true });
  const projets = options.projets ?? ["sain"];
  for (const nom of projets) fabriquerProjet(d.workspace, nom);
  for (const nom of options.pieges ?? []) piegerProjet(d.workspace, nom);
  fs.writeFileSync(d.projectsFile, `${JSON.stringify(listeProjets(projets))}\n`, "utf8");

  const horloge = fausseHorloge();
  const journal = espion();
  const hub = new EventHub();
  const recus: BrowserEvent[] = [];
  hub.subscribe((evenement) => void recus.push(evenement));
  const db: DatabaseSync = openMemoryDb();
  t.after(() => db.close());
  let actif = options.actif ?? true;
  const reel = createOmoControl({
    controlDir: d.controlDir,
    stateDir: d.stateDir,
    authDir: d.authDir,
    opencodeDataDir: d.dataDir,
    cockpitDataDir: d.donnees,
    projectsFile: null,
    clock: horloge.clock,
    actif: () => actif,
    log: journal.log,
  });
  const control = options.control ? options.control(reel) : reel;
  let ouverts = options.ouverts ?? [];
  /** Port des salles surchargé : seul `openProjects` sert au pré-contrôle. */
  const room: OmoRoomPort = {
    open: async () => ({ ok: false, status: 403, code: "salle-coupee", precheck: null }),
    status: async () => {
      throw new Error("statut non attendu du pré-contrôle");
    },
    openProjects: () => [...ouverts],
    isRoomRoot: () => false,
  };
  const service: OmoPrecheckService = createOmoPrecheckService({
    workspace: d.workspace,
    projectsFile: options.liste === false ? null : d.projectsFile,
    db,
    hub,
    log: journal.log,
    control: () => control,
    room: () => room,
    actif: () => actif,
    clock: horloge.clock,
    portee: options.portee,
  });
  t.after(async () => {
    service.stop();
    await service.settled();
    reel.stopHeartbeat();
    await reel.settled();
  });

  const fichierPrecheck = path.join(d.controlDir, "precheck-ok");
  return {
    d,
    db,
    horloge,
    journal,
    service,
    reel,
    recus,
    couper: () => void (actif = false),
    ouvrir: (noms: string[]) => void (ouverts = noms),
    /** Publie `state.json` comme le superviseur (format et validation du protocole). */
    publierEtat: (etat: OmoSupervisorState) => fs.writeFileSync(path.join(d.stateDir, "state.json"), ecrireEtat(etat), "utf8"),
    /** `precheck-ok` relu par le lecteur du format ; `null` quand le fichier est absent. */
    precheckOk: () => (fs.existsSync(fichierPrecheck) ? analyserPrecheckOk(fs.readFileSync(fichierPrecheck, "utf8")) : null),
    /** Lignes de `omo_room_starts`, dans l'ordre d'insertion. */
    demarrages: () =>
      db.prepare("SELECT start_id, started_at, image_id, manifest_sha256, precheck, cause, ended_at, fin FROM omo_room_starts ORDER BY id").all() as Array<{
        start_id: string | null;
        started_at: number;
        image_id: string;
        manifest_sha256: string;
        precheck: string;
        cause: string;
        ended_at: number | null;
        fin: string | null;
      }>,
    /** Événements `omo.precheck` publiés sur le hub. */
    precheckEmis: () => recus.filter((evenement) => evenement.kind === "cockpit" && evenement.type === "omo.precheck"),
  };
}

type Atelier = ReturnType<typeof monter>;

/** Démarrage complet : état publié, puis pré-contrôle demandé. */
async function demarrer(a: Atelier, startId = DEMARRAGE, etat?: OmoSupervisorState) {
  a.publierEtat(etat ?? etatDe(startId));
  return a.service.beforeStart(startId);
}

// --- Portée et constante du dépôt ---------------------------------------------------------------------------------------------

describe("pré-contrôle en service : portée", () => {
  it("le dépôt garde la portée « prepares » tant que M31 n'est pas confirmée (D-2b-35)", () => {
    // Train de V3 : le banc de L21 a relevé M31 en mode dégradé (« --sans-git »), faute de pouvoir démarrer la salle avec un
    // projet préparé portant un dépôt. Ce n'est pas la confirmation attendue : la portée du dépôt ne bouge pas.
    assert.equal(PRECHECK_PORTEE, "prepares");
  });

  it("aucun délai n'est lu dans l'environnement : la surveillance est une constante comptée par l'horloge injectée", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "omo-precheck-service.ts"), "utf8");
    assert.ok(!source.includes("process.env"), "le service lit une variable d'environnement");
    assert.ok(!/\bsetTimeout\s*\(|\bsetInterval\s*\(|Date\.now\s*\(/.test(source), "le service compte le temps sans son horloge injectée");
    assert.equal(typeof OMO_PRECHECK_SURVEILLANCE_MS, "number");
  });

  it("port neutre : check et beforeStart refusent « salle-coupee » sans écrire de precheck-ok", async () => {
    const port = neutralOmoPrecheck({} as never);
    assert.deepEqual(await port.check("sain"), { ok: false, code: "salle-coupee" });
    assert.deepEqual(await port.beforeStart(DEMARRAGE), { ok: false, startId: DEMARRAGE, code: "salle-coupee", resultats: [] });
  });

  it("module : aucune inscription et port neutre gardé tant que la salle est coupée", () => {
    const inscriptions: string[] = [];
    const reg = {
      hook: () => void inscriptions.push("hook"),
      derivation: () => void inscriptions.push("derivation"),
      hub: () => void inscriptions.push("hub"),
      startup: () => void inscriptions.push("startup"),
      routes: () => void inscriptions.push("routes"),
    };
    const port = neutralOmoPrecheck({} as never);
    const c11 = { salleOuverte: false, omoControlDirs: null, ports: { omoPrecheck: port } };
    omoPrecheckModule.install(reg as never, c11 as never);
    assert.deepEqual(inscriptions, []);
    assert.equal(c11.ports.omoPrecheck, port, "le port neutre a été remplacé alors que la salle est coupée");
  });
});

// --- check(projet) --------------------------------------------------------------------------------------------------------------

describe("pré-contrôle en service : check(projet)", () => {
  it("salle coupée : aucun relevé, code « salle-coupee »", async (t) => {
    const a = monter(t, { actif: false });
    assert.deepEqual(await a.service.check("sain"), { ok: false, code: "salle-coupee" });
  });

  it("projet préparé et sain : conforme, sans chemin listé", async (t) => {
    const a = monter(t);
    const issue = await a.service.check("sain");
    assert.ok(issue.ok, "pré-contrôle non fait");
    assert.deepEqual(issue.resultat, { projet: "sain", verdict: "conforme", raison: null, trouves: [] });
  });

  it("projet piégé : refusé, liste masquée, relative, sans chemin d'hôte", async (t) => {
    const a = monter(t, { projets: ["sain", "piege"], pieges: ["piege"] });
    const issue = await a.service.check("piege");
    assert.ok(issue.ok, "pré-contrôle non fait");
    assert.equal(issue.resultat.verdict, "refuse");
    assert.equal(issue.resultat.raison, "config-opencode");
    assert.deepEqual(issue.resultat.trouves, ["./opencode.json"]);
    assert.deepEqual(leaks(JSON.stringify(issue.resultat)), [], "la liste masquée fuit un chemin d'hôte");
    assert.ok(issue.resultat.trouves.length <= PRECHECK_BORNES.trouvesMax, "liste masquée non bornée");
  });

  it("liste des projets préparés absente : aucun projet n'est tenu pour préparé (« relancez install.ps1 »)", async (t) => {
    const a = monter(t, { liste: false });
    const issue = await a.service.check("sain");
    assert.ok(issue.ok, "pré-contrôle non fait");
    assert.equal(issue.resultat.verdict, "refuse");
    assert.equal(issue.resultat.raison, "non-prepare");
    assert.ok(a.journal.dit("liste des projets préparés illisible"), a.journal.texte());
  });
});

// --- T-L19-e : portée « prepares » puis « ouverts » -------------------------------------------------------------------------------

describe("pré-contrôle en service : portée « prepares » (T-L19-e, D-2b-35)", () => {
  it("un projet préparé piégé NON ouvert refuse le démarrage entier : aucun precheck-ok", async (t) => {
    const a = monter(t, { projets: ["sain", "piege"], pieges: ["piege"], ouverts: ["sain"] });
    const issue = await demarrer(a);
    assert.equal(issue.ok, false);
    assert.equal(issue.code, "precheck-refuse");
    assert.deepEqual(
      issue.resultats.map((resultat) => [resultat.projet, resultat.verdict]),
      [
        ["sain", "conforme"],
        ["piege", "refuse"],
      ],
    );
    assert.equal(a.precheckOk(), null, "un precheck-ok a été écrit alors qu'un projet préparé est piégé");
    assert.ok(a.journal.dit("projet non conforme"), a.journal.texte());
  });

  it("portée « ouverts » (après M31) : seul le projet piégé est refusé, les autres démarrent", async (t) => {
    const a = monter(t, { projets: ["sain", "piege"], pieges: ["piege"], ouverts: ["sain", "piege"], portee: "ouverts" });
    const issue = await demarrer(a);
    assert.equal(issue.ok, true);
    assert.deepEqual(
      issue.resultats.map((resultat) => [resultat.projet, resultat.verdict]),
      [
        ["sain", "conforme"],
        ["piege", "refuse"],
      ],
    );
    const ecrit = a.precheckOk();
    assert.equal(ecrit?.startId, DEMARRAGE);
    assert.deepEqual(
      ecrit?.projets.map((projet) => projet.chemin),
      ["sain"],
      "le projet piégé est entré dans precheck-ok",
    );
  });

  it("portée « ouverts » : un projet préparé piégé mais NON ouvert n'est pas contrôlé", async (t) => {
    const a = monter(t, { projets: ["sain", "piege"], pieges: ["piege"], ouverts: ["sain"], portee: "ouverts" });
    const issue = await demarrer(a);
    assert.equal(issue.ok, true);
    assert.deepEqual(
      issue.resultats.map((resultat) => resultat.projet),
      ["sain"],
    );
    assert.deepEqual(
      a.precheckOk()?.projets.map((projet) => projet.chemin),
      ["sain"],
    );
  });
});

// --- T-L19-f : piège ajouté entre deux démarrages ---------------------------------------------------------------------------------

describe("pré-contrôle en service : démarrages successifs (T-L19-f)", () => {
  it("fichier piégé ajouté entre deux démarrages : accepté au premier, refusé au suivant", async (t) => {
    const a = monter(t, { projets: ["sain", "autre"], ouverts: ["sain"] });
    const premier = await demarrer(a);
    assert.equal(premier.ok, true);
    assert.equal(a.precheckOk()?.startId, DEMARRAGE);
    const empreintesPremier = a.precheckOk()?.projets ?? [];
    assert.deepEqual(
      empreintesPremier.map((projet) => projet.chemin),
      ["sain", "autre"],
      "la portée « prepares » contrôle les deux projets préparés",
    );

    piegerProjet(a.d.workspace, "autre");
    const second = await demarrer(a, AUTRE_DEMARRAGE);
    assert.equal(second.ok, false);
    assert.equal(second.code, "precheck-refuse");
    assert.equal(second.resultats.find((resultat) => resultat.projet === "autre")?.raison, "config-opencode");
    // Le fichier du démarrage précédent reste, mais il porte l'ANCIEN startId : le superviseur ne démarre rien avec lui.
    assert.equal(a.precheckOk()?.startId, DEMARRAGE, "precheck-ok a été réécrit pour le démarrage refusé");
  });

  it("précontrôle refusé : les références du démarrage précédent ne sont plus exposées", async (t) => {
    const a = monter(t, { projets: ["sain"], ouverts: ["sain"] });
    await demarrer(a);
    assert.equal(a.service.references()?.startId, DEMARRAGE);
    piegerProjet(a.d.workspace, "sain");
    await demarrer(a, AUTRE_DEMARRAGE);
    assert.equal(a.service.references(), null, "des références d'un démarrage qui n'a pas eu lieu restent exposées");
  });
});

// --- Conditions qui interdisent tout precheck-ok ----------------------------------------------------------------------------------

describe("pré-contrôle en service : aucun precheck-ok", () => {
  it("startId différent de celui de state.json", async (t) => {
    const a = monter(t, { ouverts: ["sain"] });
    a.publierEtat(etatDe(DEMARRAGE));
    const issue = await a.service.beforeStart(AUTRE_DEMARRAGE);
    assert.deepEqual([issue.ok, issue.ok ? null : issue.code], [false, "salle-en-relance"]);
    assert.equal(a.precheckOk(), null);
    assert.deepEqual(a.demarrages(), [], "une ligne a été inscrite pour un démarrage qui n'est pas celui de l'état");
  });

  it("état du superviseur inconnu (state.json absent)", async (t) => {
    const a = monter(t, { ouverts: ["sain"] });
    const issue = await a.service.beforeStart(DEMARRAGE);
    assert.deepEqual([issue.ok, issue.ok ? null : issue.code], [false, "salle-en-relance"]);
    assert.equal(a.precheckOk(), null);
  });

  it("démarrage sans identifiant reconnu", async (t) => {
    const a = monter(t, { ouverts: ["sain"] });
    a.publierEtat(etatDe(DEMARRAGE));
    const issue = await a.service.beforeStart("dem_1");
    assert.deepEqual([issue.ok, issue.ok ? null : issue.code], [false, "salle-en-relance"]);
    assert.equal(a.precheckOk(), null);
  });

  it("salle coupée : rien n'est lu, rien n'est écrit", async (t) => {
    const a = monter(t, { ouverts: ["sain"], actif: false });
    a.publierEtat(etatDe(DEMARRAGE));
    const issue = await a.service.beforeStart(DEMARRAGE);
    assert.deepEqual([issue.ok, issue.ok ? null : issue.code], [false, "salle-coupee"]);
    assert.deepEqual([a.precheckOk(), a.demarrages().length, a.precheckEmis().length], [null, 0, 0]);
  });

  it("salle suspendue (D-2b-29) : refusée AVANT tout contrôle, sans ligne ni événement", async (t) => {
    const a = monter(t, { ouverts: ["sain"] });
    a.reel.suspend("activite-hors-demande");
    const issue = await demarrer(a);
    assert.deepEqual([issue.ok, issue.ok ? null : issue.code], [false, "salle-suspendue"]);
    assert.deepEqual(issue.ok ? null : issue.resultats, []);
    // Sans la garde d'entrée, les projets seraient relevés, la ligne inscrite et le flux alimenté avant que l'écrivain refuse.
    assert.deepEqual([a.precheckOk(), a.demarrages().length, a.precheckEmis().length], [null, 0, 0]);
    assert.ok(a.journal.dit("salle suspendue"), a.journal.texte());
  });

  it("reprise d'une salle suspendue : le même startId n'est jamais recontrôlé, un nouveau démarrage est exigé", async (t) => {
    const a = monter(t, { ouverts: ["sain"] });
    const premier = await demarrer(a);
    assert.equal(premier.ok, true);
    a.reel.suspend("activite-hors-demande");
    await a.reel.settled();
    assert.equal(a.precheckOk(), null, "la suspension n'a pas retiré le precheck-ok");
    a.reel.resume();
    await a.reel.settled();
    const repris = await a.service.beforeStart(DEMARRAGE);
    assert.deepEqual([repris.ok, repris.ok ? null : repris.code], [false, "salle-en-relance"]);
    assert.equal(a.precheckOk(), null, "un precheck-ok a été réécrit sur le même démarrage");
    assert.equal(a.demarrages().length, 1, "le même démarrage a été inscrit deux fois");
    assert.ok(a.journal.dit("un nouveau démarrage est exigé"), a.journal.texte());
  });

  it("dossier de configuration non conforme dans state.json", async (t) => {
    const a = monter(t, { ouverts: ["sain"] });
    const issue = await demarrer(a, DEMARRAGE, etatDe(DEMARRAGE, { dossiersConfig: [{ chemin: "/home/node/.config/opencode", ok: false }] }));
    assert.deepEqual([issue.ok, issue.ok ? null : issue.code], [false, "precheck-refuse"]);
    assert.equal(a.precheckOk(), null);
    assert.ok(a.journal.dit("dossier de configuration non conforme"), a.journal.texte());
  });

  it("`.git` non protégé au balayage de la salle", async (t) => {
    const a = monter(t, { ouverts: ["sain"] });
    const issue = await demarrer(a, DEMARRAGE, etatDe(DEMARRAGE, { workspaceGit: { verifieLe: T0, limiteAtteinte: false, nonProteges: ["autre/.git"] } }));
    assert.deepEqual([issue.ok, issue.ok ? null : issue.code], [false, "git-inscriptible"]);
    assert.equal(a.precheckOk(), null);
  });

  it("balayage git de la salle tronqué (limiteAtteinte)", async (t) => {
    const a = monter(t, { ouverts: ["sain"] });
    const issue = await demarrer(a, DEMARRAGE, etatDe(DEMARRAGE, { workspaceGit: { verifieLe: T0, limiteAtteinte: true, nonProteges: [] } }));
    assert.deepEqual([issue.ok, issue.ok ? null : issue.code], [false, "git-inscriptible"]);
    assert.equal(a.precheckOk(), null);
  });

  it("dépôt git cloné depuis le démarrage de la salle, hors gitProteges : vu par le balayage du cockpit", async (t) => {
    const a = monter(t, { ouverts: ["sain"] });
    ecrire(a.d.workspace, "clone-recent/.git/HEAD", "ref: refs/heads/principale\n");
    const issue = await demarrer(a);
    assert.deepEqual([issue.ok, issue.ok ? null : issue.code], [false, "workspace-non-verifie"]);
    assert.equal(a.precheckOk(), null);
    assert.ok(a.journal.dit("dépôt git hors protection"), a.journal.texte());
  });

  it("liste des projets préparés illisible : le démarrage est refusé, jamais accepté à vide", async (t) => {
    const a = monter(t, { ouverts: ["sain"], liste: false });
    const issue = await demarrer(a);
    assert.deepEqual([issue.ok, issue.ok ? null : issue.code], [false, "precheck-refuse"]);
    assert.equal(a.precheckOk(), null);
    assert.deepEqual(a.demarrages(), [], "un démarrage a été inscrit sans liste de projets préparés");
  });

  it("refus de l'écrivain (OmoControlTropGrosError) : refus lisible et journalisé, jamais une salle qui attend", async (t) => {
    const a = monter(t, {
      ouverts: ["sain"],
      control: (reel) => ({
        ...reel,
        writePrecheckOk: () => Promise.reject(new OmoControlTropGrosError("precheck-ok", 70_000)),
      }),
    });
    const issue = await demarrer(a);
    assert.deepEqual([issue.ok, issue.ok ? null : issue.code], [false, "precheck-refuse"]);
    assert.equal(a.precheckOk(), null);
    const ligne = a.journal.lignes.find((entree) => entree.message.includes("precheck-ok refusé par l'écrivain"));
    assert.deepEqual(ligne?.champs, { erreur: "OmoControlTropGrosError", code: "precheck-refuse" });
    assert.deepEqual(leaks(a.journal.texte()), [], "le journal du refus fuit un chemin d'hôte ou un secret");
    // Le démarrage reste inscrit : le refus est visible, et il n'y a pas de second pré-contrôle du même démarrage.
    assert.equal(a.demarrages().length, 1);
  });
});

// --- Démarrage accepté : base, precheck-ok, SSE, références -----------------------------------------------------------------------

describe("pré-contrôle en service : démarrage accepté", () => {
  it("ligne omo_room_starts avec start_id, résultats masqués et cause vide jusqu'à la clôture (D-2b-21, D-2b-42)", async (t) => {
    const a = monter(t, { projets: ["sain", "autre"], ouverts: ["sain"] });
    await demarrer(a);
    const lignes = a.demarrages();
    assert.equal(lignes.length, 1);
    const ligne = lignes[0];
    assert.equal(ligne?.start_id, DEMARRAGE);
    assert.equal(ligne?.started_at, T0);
    assert.equal(ligne?.image_id, "sha256:image-de-test");
    assert.equal(ligne?.manifest_sha256, EMPREINTE);
    assert.deepEqual([ligne?.cause, ligne?.ended_at, ligne?.fin], ["", null, null]);
    const resultats = JSON.parse(ligne?.precheck ?? "[]") as Array<{ projet: string; verdict: string; trouves: string[] }>;
    assert.deepEqual(
      resultats.map((resultat) => resultat.projet),
      ["sain", "autre"],
    );
    assert.deepEqual(leaks(ligne?.precheck ?? ""), [], "les résultats en base fuient un chemin d'hôte");
  });

  it("precheck-ok lié au startId, tous les projets contrôlés, sans borne de 20", async (t) => {
    const projets = Array.from({ length: 24 }, (_, index) => `projet-${String(index).padStart(2, "0")}`);
    const a = monter(t, { projets, ouverts: [projets[0] ?? "projet-00"] });
    const issue = await demarrer(a);
    assert.equal(issue.ok, true);
    const ecrit = a.precheckOk();
    assert.equal(ecrit?.startId, DEMARRAGE);
    assert.equal(ecrit?.at, T0);
    assert.deepEqual(
      ecrit?.projets.map((projet) => projet.chemin),
      projets,
      "precheck-ok ne porte pas tous les projets contrôlés",
    );
    assert.ok((ecrit?.projets.length ?? 0) > 20, "la borne de 20 s'applique encore à precheck-ok (relecture 2 bis-vague-0)");
    assert.ok(
      ecrit?.projets.every((projet) => /^[0-9a-f]{64}$/.test(projet.sha256)),
      "empreinte de projet mal formée",
    );
  });

  it("SSE omo.precheck : un événement par projet contrôlé, étiqueté « omo »", async (t) => {
    const a = monter(t, { projets: ["sain", "piege"], pieges: ["piege"], ouverts: ["sain"] });
    await demarrer(a);
    const emis = a.precheckEmis();
    assert.equal(emis.length, 2);
    assert.deepEqual(
      emis.map((evenement) => (evenement.kind === "cockpit" ? [(evenement.data as { projet: string }).projet, evenement.instance] : [])),
      [
        ["sain", "omo"],
        ["piege", "omo"],
      ],
    );
    assert.deepEqual(leaks(JSON.stringify(emis)), [], "un événement de pré-contrôle fuit un chemin d'hôte");
  });

  it("empreintes de référence : dossier de travail, premier niveau et projets préparés, champs gardés pour L23c", async (t) => {
    const a = monter(t, { projets: ["sain", "autre"], ouverts: ["sain"] });
    await demarrer(a);
    const references = a.service.references();
    assert.equal(references?.startId, DEMARRAGE);
    assert.equal(references?.at, T0);
    const racines = (references?.releves ?? []).map((releve) => releve.racine).sort();
    assert.deepEqual(racines, [".", "autre", "sain"]);
    for (const releve of references?.releves ?? []) {
      assert.equal(typeof releve.signalesIncomplet, "boolean", `${releve.racine} : signalesIncomplet perdu`);
      assert.ok(Array.isArray(releve.ideCiDynamiques), `${releve.racine} : ideCiDynamiques perdu`);
    }
    const sain = (references?.releves ?? []).find((releve) => releve.racine === "sain");
    assert.ok(
      sain?.fichiers.some((fichier) => fichier.chemin === ".vscode/settings.json"),
      "les empreintes des fichiers d'IDE manquent à la référence",
    );
  });
});

// --- Surveillance de state.json ---------------------------------------------------------------------------------------------------

describe("pré-contrôle en service : surveillance de state.json", () => {
  it("un nouveau startId déclenche un pré-contrôle, et un seul", async (t) => {
    const a = monter(t, { ouverts: ["sain"] });
    a.service.start();
    a.publierEtat(etatDe(DEMARRAGE));
    a.horloge.avancer(OMO_PRECHECK_SURVEILLANCE_MS);
    await a.service.settled();
    assert.equal(a.precheckOk()?.startId, DEMARRAGE);
    assert.equal(a.demarrages().length, 1);
    a.horloge.avancer(OMO_PRECHECK_SURVEILLANCE_MS * 5);
    await a.service.settled();
    assert.equal(a.demarrages().length, 1, "le même démarrage a été pré-contrôlé plusieurs fois");
  });

  it("un démarrage suivant est pré-contrôlé à son tour ; l'arrêt de la surveillance ne laisse aucune minuterie", async (t) => {
    const a = monter(t, { ouverts: ["sain"] });
    a.service.start();
    a.publierEtat(etatDe(DEMARRAGE));
    a.horloge.avancer(OMO_PRECHECK_SURVEILLANCE_MS);
    await a.service.settled();
    a.publierEtat(etatDe(AUTRE_DEMARRAGE));
    a.horloge.avancer(OMO_PRECHECK_SURVEILLANCE_MS);
    await a.service.settled();
    assert.deepEqual(
      a.demarrages().map((ligne) => ligne.start_id),
      [DEMARRAGE, AUTRE_DEMARRAGE],
    );
    assert.equal(a.precheckOk()?.startId, AUTRE_DEMARRAGE);
    a.service.stop();
    a.horloge.avancer(OMO_PRECHECK_SURVEILLANCE_MS * 3);
    await a.service.settled();
    assert.equal(a.demarrages().length, 2, "la surveillance tourne encore après stop()");
  });

  it("salle coupée : la surveillance ne lit rien et n'écrit rien", async (t) => {
    const a = monter(t, { ouverts: ["sain"], actif: false });
    a.service.start();
    a.publierEtat(etatDe(DEMARRAGE));
    a.horloge.avancer(OMO_PRECHECK_SURVEILLANCE_MS * 4);
    await a.service.settled();
    assert.deepEqual([a.precheckOk(), a.demarrages().length], [null, 0]);
  });
});

// --- Vecteurs communs ---------------------------------------------------------------------------------------------------------------

describe("pré-contrôle en service : vecteurs de omo-control-vectors.json", () => {
  it("chaque état du superviseur est lu comme le veut le vecteur, et seul un état valide déclenche un pré-contrôle", async (t) => {
    const vecteurs = FIXTURE.vecteurs.filter((vecteur) => vecteur.format === "etat");
    assert.ok(vecteurs.length >= 3, "vecteurs « etat » absents de omo-control-vectors.json");
    for (const vecteur of vecteurs) {
      const a = monter(t, { ouverts: ["sain"] });
      fs.writeFileSync(path.join(a.d.stateDir, "state.json"), vecteur.texte ?? "", "utf8");
      a.service.start();
      a.horloge.avancer(OMO_PRECHECK_SURVEILLANCE_MS);
      await a.service.settled();
      const attendu = vecteur.attendu as { startId?: string } | null | undefined;
      const lisible = attendu !== null && attendu !== undefined;
      assert.equal(a.demarrages().length, lisible ? 1 : 0, vecteur.nom);
      assert.equal(a.precheckOk()?.startId ?? null, lisible ? (attendu.startId ?? null) : null, vecteur.nom);
    }
  });

  it("le precheck-ok écrit est relu par le lecteur du format, comme les vecteurs « precheck »", async (t) => {
    const a = monter(t, { projets: ["sain", "autre"], ouverts: ["sain"] });
    await demarrer(a);
    const texte = fs.readFileSync(path.join(a.d.controlDir, "precheck-ok"), "utf8");
    assert.equal(texte, `${JSON.stringify(JSON.parse(texte))}\n`, "precheck-ok n'est pas au format canonique des vecteurs");
    const relu = analyserPrecheckOk(texte);
    assert.equal(relu?.startId, DEMARRAGE);
    assert.equal(relu?.projets.length, 2);
  });
});
