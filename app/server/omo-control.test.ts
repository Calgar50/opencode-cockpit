// Service de contrôle de la Salle OMO côté cockpit (L17b) : ce que le cockpit écrit dans `control-omo` et `omo-auth` est relu par la
// salle (supervisor-lib.mjs, L17a) et par le lecteur du cockpit (omo-control-protocol.ts), sur les vecteurs communs de L17a. Horloge
// injectée : le battement de 5 s est vérifié sans aucune attente réelle.
//
// Chaque garde a son test qui échoue sans elle : conditions fausses (aucun fichier, aucun dossier), battement arrêté et
// `auth.json` retiré quand une condition tombe, `stop-request` lié au démarrage lu et jamais effacé, suspension, seule l'entrée
// `github-copilot` recopiée, bornes de lecture, liens refusés, droits posés, aucun contenu d'`auth.json` au journal ni dans une
// erreur. Les cas POSIX (droits, liens symboliques, masque) sont sautés sous Windows avec leur raison et joués sous Linux.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import * as salle from "../../docker/opencode-omo/supervisor-lib.mjs";
import type { OmoControlPort } from "./omo-contracts.ts";
import { OMO_STOP_CAUSES } from "./omo-contracts.ts";
import {
  analyserProjetsPrepares,
  createOmoControl,
  OMO_AUTH_FOURNISSEUR,
  OMO_AUTH_SOURCE_MAX_OCTETS,
  OMO_BATTEMENT_MS,
  OMO_PROJETS_MAX_OCTETS,
  OmoAuthPublicationError,
  OmoControlRefusError,
  type OmoControlClock,
  type OmoControlService,
} from "./omo-control.ts";
import {
  analyserArret,
  analyserBattement,
  analyserGuardState,
  analyserPrecheckOk,
  arretDuDemarrage,
  ecrireEtat,
  OMO_CONTROL_MAX_OCTETS,
  OMO_DELAIS,
  OmoControlInvalideError,
  OmoControlTropGrosError,
  type OmoSupervisorState,
} from "./shared/omo-control-protocol.ts";
import type { OmoGuardState, OmoPrecheckOkProject, OmoRecreationRaison } from "./shared/omo-types.ts";
import { leaks } from "./test-support/helpers.ts";

const POSIX = process.platform !== "win32";
const SAUT_POSIX = POSIX ? false : "droits POSIX, liens symboliques et masque : non tenus par NTFS (joués sous Linux)";

// --- Vecteurs de L17a ------------------------------------------------------------------------------------------------------------

interface Vecteur {
  nom: string;
  format: "battement" | "arret" | "precheck" | "garde" | "projets" | "etat";
  texte?: string;
  projetsGeneres?: number;
  attendu?: unknown;
  attenduProjets?: number;
}

interface Fixture {
  startId: string;
  autreStartId: string;
  vecteurs: Vecteur[];
  precheckDemarrage: { nom: string; startIdFichier: string | null; at: number; startIdCourant: string; maintenant: number; accepte: boolean }[];
  arretDemarrage: { nom: string; arret: { at: number; startId: string | null } | null; startIdCourant: string; startedAt: number; vise: boolean }[];
}

const FIXTURE = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "test-support", "fixtures", "omo-control-vectors.json"), "utf8")) as Fixture;
const vecteurs = (format: Vecteur["format"]) => FIXTURE.vecteurs.filter((v) => v.format === format);
/** Le texte du vecteur est-il exactement ce qu'écrit le protocole (JSON sur une ligne, saut de ligne final) ? */
const canonique = (texte: string): boolean => texte === `${JSON.stringify(JSON.parse(texte))}\n`;

const T0 = 1_757_000_000_000;
const EMPREINTE = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// --- Horloge, journal, dossiers ----------------------------------------------------------------------------------------------------

/** Horloge du battement : minuteries en attente, déclenchées par `avancer`, jamais par le temps réel. */
function fausseHorloge(depart = T0) {
  let maintenant = depart;
  let seq = 0;
  const minuteries = new Map<number, { fn: () => void; echeance: number; ms: number }>();
  const clock: OmoControlClock = {
    now: () => maintenant,
    setTimer: (fn, ms) => {
      seq++;
      minuteries.set(seq, { fn, echeance: maintenant + ms, ms });
      return seq;
    },
    clearTimer: (handle) => void minuteries.delete(handle as number),
  };
  return {
    clock,
    maintenant: () => maintenant,
    enAttente: () => [...minuteries.values()].map((m) => m.ms),
    /** Place l'horloge à `ms` sans rien déclencher (aucune minuterie ne doit être due avant). */
    placer(ms: number) {
      assert.ok([...minuteries.values()].every((m) => m.echeance > ms), "une minuterie serait sautée");
      maintenant = ms;
    },
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
    compte: (message: string) => lignes.filter((l) => l.message === message).length,
  };
}

/** Volumes de la salle dans un dossier temporaire. `control-omo` et `omo-auth` ne sont PAS créés : « rien écrit » s'y voit. */
function dossiers(t: TestContext) {
  const racine = fs.mkdtempSync(path.join(os.tmpdir(), "omo-control-"));
  t.after(() => fs.rmSync(racine, { recursive: true, force: true }));
  const d = {
    racine,
    controlDir: path.join(racine, "control-omo"),
    stateDir: path.join(racine, "omo-state"),
    authDir: path.join(racine, "omo-auth"),
    dataDir: path.join(racine, "oc-data"),
    projectsFile: path.join(racine, "hote", "omo-projets.json"),
  };
  for (const dossier of [d.stateDir, d.dataDir, path.dirname(d.projectsFile)]) fs.mkdirSync(dossier);
  return d;
}

type Dossiers = ReturnType<typeof dossiers>;

/** `true` : la liste de l'hôte du dossier de test ; une chaîne : ce chemin-là (périphérique, tube) ; sinon aucune liste. */
function fichierProjets(projets: boolean | string | undefined, d: Dossiers): string | null {
  if (typeof projets === "string") return projets;
  return projets === true ? d.projectsFile : null;
}

function monter(t: TestContext, options: { actif?: () => boolean; projets?: boolean | string; depart?: number } = {}) {
  const d = dossiers(t);
  const horloge = fausseHorloge(options.depart);
  const journal = espion();
  let actif = true;
  const ctl = createOmoControl({
    controlDir: d.controlDir,
    stateDir: d.stateDir,
    authDir: d.authDir,
    opencodeDataDir: d.dataDir,
    projectsFile: fichierProjets(options.projets, d),
    clock: horloge.clock,
    actif: options.actif ?? (() => actif),
    log: journal.log,
  });
  t.after(async () => {
    ctl.stopHeartbeat();
    await ctl.settled();
  });
  return {
    d,
    horloge,
    journal,
    ctl,
    couper: () => void (actif = false),
    rallumer: () => void (actif = true),
  };
}

const lire = (fichier: string): string | null => (fs.existsSync(fichier) ? fs.readFileSync(fichier, "utf8") : null);
const controle = (d: Dossiers, nom: string) => path.join(d.controlDir, nom);
const authCible = (d: Dossiers) => path.join(d.authDir, "auth.json");
const authSource = (d: Dossiers) => path.join(d.dataDir, "auth.json");

/** state.json tel que le superviseur le publie (écrit par le protocole lui-même). */
function etatSalle(startId: string, startedAt: number): OmoSupervisorState {
  return {
    startId,
    phase: "opencode-lance",
    imageId: "",
    manifestSha256: EMPREINTE,
    manifesteReference: "ok",
    validation: "ok",
    dossiersConfig: [{ chemin: "/home/node/.omo", ok: true }],
    projets: [{ chemin: "alpha", gitLectureSeule: true }],
    workspaceGit: { verifieLe: startedAt, limiteAtteinte: false, nonProteges: [] },
    startedAt,
  };
}

const publierEtat = (d: Dossiers, etat: OmoSupervisorState) => fs.writeFileSync(path.join(d.stateDir, "state.json"), ecrireEtat(etat));

/** Dossier de travail protégé, comme le superviseur le constate avant de se dire prêt. */
const travailProtege = (startId: string, startedAt: number) => ({
  startId,
  startedAt,
  workspaceGit: { verifieLe: startedAt, limiteAtteinte: false, nonProteges: [] },
  projets: [{ gitLectureSeule: true }],
});

const refus = (code: OmoControlRefusError["code"]) => (err: unknown) => err instanceof OmoControlRefusError && err.code === code;

// --- Authentification factice (aucun vrai jeton : valeurs FACTICE, cf. MX-OMO) --------------------------------------------------

const MARQUES = {
  acces: "FACTICE-ACCES-L17b-4c1e",
  rafraichir: "FACTICE-RAFRAICHIR-L17b-8b2d",
  autre: "FACTICE-AUTRE-FOURNISSEUR-L17b-6f0a",
  principal: "FACTICE-CLE-PRINCIPALE-L17b-2e7c",
};
const ENTREE_COPILOT = { type: "oauth", refresh: MARQUES.rafraichir, access: MARQUES.acces, expires: 4_102_444_800_000 };
const AUTH_COMPLET = { anthropic: { type: "api", key: MARQUES.autre }, [OMO_AUTH_FOURNISSEUR]: ENTREE_COPILOT, opencode: { type: "api", key: MARQUES.principal } };

/** Aucune marque factice dans ce texte (journal, message ou pile d'erreur). */
function sansMarque(texte: string, quoi: string): void {
  for (const marque of Object.values(MARQUES)) assert.equal(texte.includes(marque), false, `${quoi} contient ${marque}`);
  assert.equal(texte.includes("FACTICE"), false, `${quoi} contient une valeur factice`);
}

/** Texte JSON d'exactement `octets` octets (ASCII) avec l'entrée github-copilot et un rembourrage. */
function authRembourre(octets: number): string {
  const vide = JSON.stringify({ [OMO_AUTH_FOURNISSEUR]: ENTREE_COPILOT, bourrage: "" });
  const texte = JSON.stringify({ [OMO_AUTH_FOURNISSEUR]: ENTREE_COPILOT, bourrage: "x".repeat(octets - vide.length) });
  assert.equal(Buffer.byteLength(texte), octets);
  return texte;
}

// --- 1. Salle coupée ---------------------------------------------------------------------------------------------------------------

describe("omo-control : salle coupée, rien n'est écrit", () => {
  it("conditions fausses : aucun fichier ni dossier, quelle que soit la méthode (contrôle, garde, authentification, projets)", async (t) => {
    const { d, horloge, journal, ctl } = monter(t, { actif: () => false, projets: true });
    fs.writeFileSync(authSource(d), JSON.stringify(AUTH_COMPLET));
    fs.writeFileSync(d.projectsFile, vecteurs("projets")[0]?.texte ?? "");
    publierEtat(d, etatSalle(FIXTURE.startId, T0));

    ctl.startHeartbeat();
    horloge.avancer(60_000);
    await ctl.settled();
    await ctl.requestStop("vous");
    await assert.rejects(ctl.writePrecheckOk(FIXTURE.startId, []), refus("salle-coupee"));
    await assert.rejects(ctl.writeGuardState({ version: 1, at: T0, bloquer: ["task"] }), refus("salle-coupee"));
    await ctl.publishAuth();
    assert.equal(await ctl.publishProjects(), "coupee");
    ctl.suspend("activite-hors-demande");
    ctl.resume();
    ctl.stopHeartbeat();
    await ctl.settled();

    assert.equal(fs.existsSync(d.controlDir), false, "control-omo créé");
    assert.equal(fs.existsSync(d.authDir), false, "omo-auth créé");
    assert.deepEqual(horloge.enAttente(), [], "aucune minuterie");
    assert.equal(journal.compte("salle : battement non démarré (salle coupée)"), 1);
    // Lire reste permis : l'état publié par la salle est relu (démarrage du cockpit, D-2b-29).
    assert.equal((await ctl.readState())?.startId, FIXTURE.startId);
  });

  it("conditions fausses : un auth.json laissé par une salle d'avant est retiré, rien d'autre n'apparaît", async (t) => {
    const { d, journal, ctl } = monter(t, { actif: () => false });
    fs.mkdirSync(d.authDir);
    fs.writeFileSync(authCible(d), JSON.stringify({ [OMO_AUTH_FOURNISSEUR]: ENTREE_COPILOT }));
    fs.writeFileSync(authSource(d), JSON.stringify(AUTH_COMPLET));
    await ctl.publishAuth();
    assert.deepEqual(fs.readdirSync(d.authDir), []);
    assert.equal(journal.lignes.at(-1)?.champs?.raison, "coupee");
  });

  it("actif() qui lève vaut « faux » : rien n'est écrit", async (t) => {
    const { d, horloge, ctl } = monter(t, {
      actif: () => {
        throw new Error("configuration illisible");
      },
    });
    ctl.startHeartbeat();
    horloge.avancer(10_000);
    await ctl.requestStop("vous");
    await assert.rejects(ctl.writePrecheckOk(FIXTURE.startId, []), refus("salle-coupee"));
    await ctl.settled();
    assert.equal(fs.existsSync(d.controlDir), false);
  });
});

// --- 2. Battement ------------------------------------------------------------------------------------------------------------------

describe("omo-control : battement toutes les 5 s (D-2b-25)", () => {
  it("écrit tout de suite, puis toutes les 5 s pile ; frais pour le superviseur ; une seule minuterie", async (t) => {
    const { d, horloge, ctl } = monter(t);
    assert.equal(OMO_BATTEMENT_MS, 5000);
    assert.equal(OMO_BATTEMENT_MS, salle.OMO_DELAIS.battementS * 1000);
    ctl.startHeartbeat();
    await ctl.settled();
    const fichier = controle(d, "heartbeat");
    // Premier battement : le texte exact du vecteur « battement ordinaire » de L17a.
    assert.equal(lire(fichier), vecteurs("battement")[0]?.texte);
    assert.deepEqual(horloge.enAttente(), [OMO_BATTEMENT_MS]);

    horloge.avancer(OMO_BATTEMENT_MS - 1);
    await ctl.settled();
    assert.deepEqual(analyserBattement(lire(fichier)), { at: T0 }, "rien avant 5 s");
    horloge.avancer(1);
    await ctl.settled();
    assert.deepEqual(analyserBattement(lire(fichier)), { at: T0 + OMO_BATTEMENT_MS });

    ctl.startHeartbeat();
    assert.deepEqual(horloge.enAttente(), [OMO_BATTEMENT_MS], "un second démarrage ne double pas la minuterie");
    for (let i = 2; i <= 12; i++) {
      horloge.avancer(OMO_BATTEMENT_MS);
      await ctl.settled();
      const battement = salle.lireBattement(d.controlDir);
      assert.deepEqual(battement, { at: T0 + i * OMO_BATTEMENT_MS });
      // Juste avant le battement suivant, le superviseur le trouve encore frais, avec la marge de D-2b-25.
      assert.equal(salle.battementFrais(battement, horloge.maintenant() + OMO_BATTEMENT_MS - 1), true);
      assert.ok(OMO_BATTEMENT_MS < OMO_DELAIS.perimeS * 1000);
    }
    assert.deepEqual(horloge.enAttente(), [OMO_BATTEMENT_MS]);
  });

  it("condition retirée : battement arrêté, heartbeat et auth.json retirés, plus rien ensuite ; revenue, rien ne repart seul", async (t) => {
    const { d, horloge, journal, ctl, couper, rallumer } = monter(t);
    fs.writeFileSync(authSource(d), JSON.stringify(AUTH_COMPLET));
    await ctl.publishAuth();
    ctl.startHeartbeat();
    await ctl.settled();
    assert.ok(fs.existsSync(controle(d, "heartbeat")) && fs.existsSync(authCible(d)));

    couper();
    horloge.avancer(OMO_BATTEMENT_MS);
    await ctl.settled();
    assert.equal(fs.existsSync(controle(d, "heartbeat")), false, "heartbeat retiré");
    assert.equal(fs.existsSync(authCible(d)), false, "auth.json retiré");
    assert.deepEqual(horloge.enAttente(), [], "minuterie coupée");
    assert.ok(journal.lignes.some((l) => l.message === "salle : battement arrêté" && l.champs?.raison === "condition"));

    rallumer();
    horloge.avancer(60_000);
    await ctl.settled();
    assert.equal(fs.existsSync(controle(d, "heartbeat")), false, "aucun redémarrage sans startHeartbeat");
    ctl.startHeartbeat();
    await ctl.settled();
    assert.deepEqual(salle.lireBattement(d.controlDir), { at: horloge.maintenant() });
  });

  it("condition retirée entre deux battements : la première écriture demandée l'arrête aussitôt, sans attendre la minuterie", async (t) => {
    const { d, horloge, ctl, couper } = monter(t);
    fs.writeFileSync(authSource(d), JSON.stringify(AUTH_COMPLET));
    await ctl.publishAuth();
    ctl.startHeartbeat();
    await ctl.settled();
    couper();
    await assert.rejects(ctl.writeGuardState({ version: 1, at: T0, bloquer: [] }), refus("salle-coupee"));
    assert.equal(fs.existsSync(controle(d, "heartbeat")), false);
    assert.equal(fs.existsSync(authCible(d)), false);
    assert.equal(fs.existsSync(controle(d, "guard-state.json")), false);
    assert.deepEqual(horloge.enAttente(), []);
  });

  it("condition tombée puis revenue entre deux écritures en file : aucun battement orphelin (sans minuterie) n'est laissé", async (t) => {
    // Réponses de actif() dans l'ordre des appels ; vide : vrai.
    const reponses: boolean[] = [];
    const { d, horloge, ctl } = monter(t, { actif: () => reponses.shift() ?? true });
    ctl.startHeartbeat();
    await ctl.settled();
    reponses.push(false);
    // En file : la garde (qui verra « faux » et coupera), puis le battement planifié par la minuterie (écrit AVANT la coupure).
    const garde = ctl.writeGuardState({ version: 1, at: T0, bloquer: [] });
    horloge.avancer(OMO_BATTEMENT_MS);
    await assert.rejects(garde, refus("salle-coupee"));
    await ctl.settled();
    assert.equal(fs.existsSync(controle(d, "heartbeat")), false, "battement planifié avant la coupure : jamais écrit après elle");
    assert.deepEqual(horloge.enAttente(), []);
  });

  it("stopHeartbeat : minuterie coupée et heartbeat retiré ; arrêt puis démarrage aussitôt garde le battement", async (t) => {
    const { d, horloge, ctl } = monter(t);
    ctl.startHeartbeat();
    await ctl.settled();
    ctl.stopHeartbeat();
    ctl.startHeartbeat();
    await ctl.settled();
    assert.deepEqual(salle.lireBattement(d.controlDir), { at: T0 }, "le retrait de l'arrêt passe avant le battement du démarrage");
    assert.deepEqual(horloge.enAttente(), [OMO_BATTEMENT_MS]);

    ctl.stopHeartbeat();
    await ctl.settled();
    assert.equal(fs.existsSync(controle(d, "heartbeat")), false);
    assert.deepEqual(horloge.enAttente(), []);
    horloge.avancer(60_000);
    await ctl.settled();
    assert.equal(fs.existsSync(controle(d, "heartbeat")), false);
  });

  it("battement non écrit : dit une fois par série d'échecs, le retour est dit aussi", async (t) => {
    const { d, horloge, journal, ctl } = monter(t);
    fs.writeFileSync(d.controlDir, "pas un dossier");
    ctl.startHeartbeat();
    for (let i = 0; i < 3; i++) {
      horloge.avancer(OMO_BATTEMENT_MS);
      await ctl.settled();
    }
    assert.equal(journal.compte("salle : battement non écrit"), 1);
    fs.rmSync(d.controlDir);
    horloge.avancer(OMO_BATTEMENT_MS);
    await ctl.settled();
    assert.deepEqual(salle.lireBattement(d.controlDir), { at: horloge.maintenant() });
    assert.equal(journal.compte("salle : battement rétabli"), 1);
  });
});

// --- 3. Fichiers lus par la salle -------------------------------------------------------------------------------------------------

describe("omo-control : stop-request, precheck-ok et guard-state.json relus par la salle (vecteurs de L17a)", () => {
  it("requestStop lie l'arrêt au démarrage de state.json ; la relance (nouveau startId) démarre avec son precheck-ok ; stop-request jamais effacé", async (t) => {
    const { d, horloge, ctl } = monter(t);
    ctl.startHeartbeat();
    await ctl.settled();
    publierEtat(d, etatSalle(FIXTURE.startId, T0));
    horloge.avancer(2_000);
    await ctl.requestStop("vous");
    const texteArret = lire(controle(d, "stop-request"));
    assert.equal(texteArret, `${JSON.stringify({ at: T0 + 2_000, cause: "vous", startId: FIXTURE.startId })}\n`);
    const arret = salle.lireArret(d.controlDir);
    assert.deepEqual(arret, analyserArret(texteArret));
    const premier = travailProtege(FIXTURE.startId, T0);
    assert.equal(
      salle.decisionPret({ travail: premier, arret, battement: salle.lireBattement(d.controlDir), precheck: null, maintenantMs: horloge.maintenant() }),
      salle.CODES.arret,
    );

    // Sortie du superviseur, relance à neuf : autre startId, publié après l'arrêt.
    horloge.avancer(3_000);
    await ctl.settled();
    const relance = T0 + 20_000;
    publierEtat(d, etatSalle(FIXTURE.autreStartId, relance));
    horloge.avancer(relance + 1_000 - horloge.maintenant());
    await ctl.settled();
    const projets: OmoPrecheckOkProject[] = [{ chemin: "alpha", sha256: EMPREINTE }];
    await ctl.writePrecheckOk(FIXTURE.autreStartId, projets);
    const second = travailProtege(FIXTURE.autreStartId, relance);
    const lu = {
      arret: salle.lireArret(d.controlDir),
      battement: salle.lireBattement(d.controlDir),
      precheck: salle.lirePrecheckOk(d.controlDir),
    };
    assert.equal(salle.decisionPret({ travail: second, ...lu, maintenantMs: horloge.maintenant() }), salle.CODES.ok, "la relance démarre");
    assert.equal(lire(controle(d, "stop-request")), texteArret, "stop-request jamais effacé ni réécrit");
    assert.deepEqual(lu.precheck, { startId: FIXTURE.autreStartId, at: horloge.maintenant(), projets });
  });

  it("vecteurs « arretDemarrage » : l'arrêt écrit par le cockpit vise exactement le démarrage que dit le vecteur", async (t) => {
    for (const v of FIXTURE.arretDemarrage) {
      if (v.arret === null) continue;
      const { d, horloge, ctl } = monter(t, { depart: v.arret.at });
      // startId nommé : lu dans state.json ; null : état inconnu du cockpit (state.json absent).
      if (v.arret.startId !== null) publierEtat(d, etatSalle(v.arret.startId, v.startedAt));
      await ctl.requestStop("vous");
      const texte = lire(controle(d, "stop-request"));
      assert.equal(horloge.maintenant(), v.arret.at);
      assert.equal(salle.arretDuDemarrage(salle.lireArret(d.controlDir), v.startIdCourant, v.startedAt), v.vise, v.nom);
      assert.equal(arretDuDemarrage(analyserArret(texte), v.startIdCourant, v.startedAt), v.vise, `${v.nom} (cockpit)`);
    }
  });

  it("requestStop : chaque OmoRecreationRaison, dont « fin-de-demande », relue telle quelle ; état inconnu ou trop gros → startId null", async (t) => {
    const causes: OmoRecreationRaison[] = [...OMO_STOP_CAUSES, "fin-de-demande"];
    const { d, ctl } = monter(t);
    for (const cause of causes) {
      await ctl.requestStop(cause);
      const arret = salle.lireArret(d.controlDir);
      assert.deepEqual(arret, { at: T0, cause, startId: null }, cause);
      assert.deepEqual(analyserArret(lire(controle(d, "stop-request"))), arret, cause);
    }
    // Un vecteur du protocole à l'octet près : « arrêt lié au démarrage qu'il arrête ».
    publierEtat(d, etatSalle(FIXTURE.startId, T0));
    await ctl.requestStop("vous");
    assert.equal(lire(controle(d, "stop-request")), vecteurs("arret").find((v) => v.nom === "arrêt lié au démarrage qu'il arrête")?.texte);
    // État de plus de 64 Kio : inconnu, l'arrêt reste un arrêt, rattaché par sa date.
    const gros = { ...etatSalle(FIXTURE.startId, T0), imageId: "", bourrage: "x".repeat(OMO_CONTROL_MAX_OCTETS) };
    fs.writeFileSync(path.join(d.stateDir, "state.json"), JSON.stringify(gros));
    await ctl.requestStop("vous");
    assert.equal(salle.lireArret(d.controlDir)?.startId, null);
  });

  it("writePrecheckOk : relu à l'identique des deux côtés (vecteurs « precheck ») ; 600 projets acceptés, aucune borne de 20", async (t) => {
    let vus = 0;
    for (const v of vecteurs("precheck")) {
      if (v.attendu === null || v.attendu === undefined) continue;
      const attendu = v.attendu as { startId: string; at: number; projets: OmoPrecheckOkProject[] };
      const { d, ctl } = monter(t, { depart: attendu.at });
      await ctl.writePrecheckOk(attendu.startId, attendu.projets);
      const texte = lire(controle(d, "precheck-ok"));
      assert.deepEqual(analyserPrecheckOk(texte), attendu, v.nom);
      assert.deepEqual(salle.lirePrecheckOk(d.controlDir), attendu, `${v.nom} (salle)`);
      if (v.texte !== undefined && canonique(v.texte)) assert.equal(texte, v.texte, `${v.nom} : à l'octet près`);
      vus++;
    }
    assert.ok(vus >= 2);
    for (const v of vecteurs("precheck").filter((x) => x.projetsGeneres !== undefined)) {
      const n = v.projetsGeneres ?? 0;
      const { d, ctl } = monter(t);
      const projets = Array.from({ length: n }, (_, i) => ({ chemin: `projet-${i}`, sha256: EMPREINTE }));
      await ctl.writePrecheckOk(FIXTURE.startId, projets);
      assert.equal(salle.lirePrecheckOk(d.controlDir)?.projets.length, v.attenduProjets, v.nom);
    }
    for (const v of FIXTURE.precheckDemarrage) {
      if (v.startIdFichier === null) continue;
      const { d, ctl } = monter(t, { depart: v.at });
      await ctl.writePrecheckOk(v.startIdFichier, []);
      assert.equal(salle.precheckDuDemarrage(salle.lirePrecheckOk(d.controlDir), v.startIdCourant, v.maintenant), v.accepte, v.nom);
    }
  });

  it("writePrecheckOk : ce que le lecteur refuserait est refusé à l'écriture, journalisé, rien d'écrit", async (t) => {
    const { d, journal, ctl } = monter(t);
    // Vecteurs invalides exprimables par l'appel : même refus à l'écriture qu'à la lecture.
    let vus = 0;
    for (const v of vecteurs("precheck")) {
      if (v.attendu !== null || v.texte === undefined) continue;
      const brut = JSON.parse(v.texte) as { startId?: unknown; projets?: unknown };
      if (typeof brut.startId !== "string" || !Array.isArray(brut.projets)) continue;
      await assert.rejects(ctl.writePrecheckOk(brut.startId, brut.projets as OmoPrecheckOkProject[]), OmoControlInvalideError, v.nom);
      vus++;
    }
    assert.ok(vus >= 3, `${vus} vecteurs invalides joués`);
    const enorme = Array.from({ length: 40 }, (_, i) => ({ chemin: `${"p".repeat(4000)}${i}`, sha256: EMPREINTE }));
    await assert.rejects(ctl.writePrecheckOk(FIXTURE.startId, enorme), OmoControlTropGrosError);
    assert.equal(fs.existsSync(controle(d, "precheck-ok")), false);
    const refusJournal = journal.lignes.filter((l) => l.message === "salle : fichier de contrôle refusé");
    assert.equal(refusJournal.length, vus + 1);
    assert.deepEqual(refusJournal.at(-1)?.champs, { fichier: "precheck-ok", erreur: "OmoControlTropGrosError" });
  });

  it("writeGuardState : vecteurs « garde » relus à l'identique, « rien à bloquer » à l'octet près ; outil inconnu refusé", async (t) => {
    let vus = 0;
    for (const v of vecteurs("garde")) {
      if (v.attendu === null || v.attendu === undefined) continue;
      const attendu = v.attendu as OmoGuardState;
      const { d, ctl } = monter(t);
      await ctl.writeGuardState(attendu);
      const texte = lire(controle(d, "guard-state.json"));
      assert.deepEqual(analyserGuardState(texte), attendu, v.nom);
      if (v.texte !== undefined && canonique(v.texte)) assert.equal(texte, v.texte, `${v.nom} : à l'octet près`);
      vus++;
    }
    assert.equal(vus, 2);
    const { d, ctl } = monter(t);
    await assert.rejects(ctl.writeGuardState({ version: 1, at: T0, bloquer: ["task", "autre_outil"] as unknown as OmoGuardState["bloquer"] }), OmoControlInvalideError);
    assert.equal(fs.existsSync(controle(d, "guard-state.json")), false);
  });
});

// --- 4. Suspension -----------------------------------------------------------------------------------------------------------------

describe("omo-control : suspension (D-2b-29)", () => {
  it("suspendue : aucun precheck-ok (refus dit), celui déjà écrit est retiré ; garde et arrêt restent permis ; resume : de nouveau permis", async (t) => {
    const { d, journal, ctl } = monter(t);
    await ctl.writePrecheckOk(FIXTURE.startId, []);
    assert.equal(ctl.suspended(), false);
    ctl.suspend("activite-hors-demande");
    assert.equal(ctl.suspended(), true);
    await ctl.settled();
    assert.equal(fs.existsSync(controle(d, "precheck-ok")), false, "precheck-ok d'avant retiré");
    await assert.rejects(ctl.writePrecheckOk(FIXTURE.startId, []), refus("salle-suspendue"));
    assert.equal(fs.existsSync(controle(d, "precheck-ok")), false);
    await ctl.writeGuardState({ version: 1, at: T0, bloquer: ["task"] });
    await ctl.requestStop("hors-controle");
    assert.ok(journal.lignes.some((l) => l.message === "salle : suspendue" && l.champs?.raison === "activite-hors-demande"));

    ctl.resume();
    assert.equal(ctl.suspended(), false);
    await ctl.writePrecheckOk(FIXTURE.autreStartId, []);
    assert.equal(salle.lirePrecheckOk(d.controlDir)?.startId, FIXTURE.autreStartId);
  });
});

// --- 5. Authentification (D-2b-26) ---------------------------------------------------------------------------------------------

describe("omo-control : publishAuth, entrée github-copilot seule, jamais journalisée", () => {
  it("seule l'entrée github-copilot est recopiée, relue par copierAuth du superviseur ; aucun contenu au journal", async (t) => {
    const { d, journal, ctl } = monter(t);
    fs.writeFileSync(authSource(d), JSON.stringify(AUTH_COMPLET, null, 2));
    await ctl.publishAuth();
    const texte = lire(authCible(d)) ?? "";
    assert.deepEqual(JSON.parse(texte), { [OMO_AUTH_FOURNISSEUR]: ENTREE_COPILOT });
    assert.equal(texte.includes(MARQUES.autre) || texte.includes(MARQUES.principal), false, "autres entrées absentes");
    assert.deepEqual(fs.readdirSync(d.authDir), ["auth.json"], "aucun fichier temporaire restant");

    const donnees = path.join(d.racine, "oc-omo-data");
    const rapport = salle.copierAuth({ source: authCible(d), donnees });
    assert.deepEqual(rapport, { etat: "posee", octets: Buffer.byteLength(texte) });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(donnees, "auth.json"), "utf8")), { [OMO_AUTH_FOURNISSEUR]: ENTREE_COPILOT });

    sansMarque(journal.texte(), "journal");
    assert.deepEqual(leaks(journal.texte()), []);
    assert.equal(journal.compte("salle : authentification publiée (entrée github-copilot seule)"), 1);
  });

  it("source de 64 Kio pile publiée ; 1 octet de plus : trop grosse, copie d'avant retirée", async (t) => {
    const { d, journal, ctl } = monter(t);
    assert.equal(OMO_AUTH_SOURCE_MAX_OCTETS, 65_536);
    fs.writeFileSync(authSource(d), authRembourre(OMO_AUTH_SOURCE_MAX_OCTETS));
    await ctl.publishAuth();
    assert.deepEqual(JSON.parse(lire(authCible(d)) ?? "null"), { [OMO_AUTH_FOURNISSEUR]: ENTREE_COPILOT });
    fs.writeFileSync(authSource(d), authRembourre(OMO_AUTH_SOURCE_MAX_OCTETS + 1));
    await ctl.publishAuth();
    assert.equal(fs.existsSync(authCible(d)), false);
    assert.equal(journal.lignes.at(-1)?.champs?.raison, "trop-grosse");
    sansMarque(journal.texte(), "journal");
  });

  it("entrée absente, source absente, illisible, invalide ou entrée non objet : copie d'avant retirée, raison dite sans contenu", async (t) => {
    // Un JSON invalide dont l'erreur de JSON.parse RECOPIE un extrait (et la marque) : un journal naïf la fuirait.
    const invalide = `{"${OMO_AUTH_FOURNISSEUR}":{"access":${MARQUES.acces}}}`;
    assert.throws(() => JSON.parse(invalide), (err: unknown) => err instanceof SyntaxError && err.message.includes("FACTICE"));
    const cas: { nom: string; poser: (d: Dossiers) => void; raison: string }[] = [
      { nom: "entrée absente", poser: (d) => fs.writeFileSync(authSource(d), JSON.stringify({ anthropic: AUTH_COMPLET.anthropic })), raison: "sans-entree" },
      { nom: "source absente", poser: () => undefined, raison: "absente" },
      { nom: "source dossier", poser: (d) => fs.mkdirSync(authSource(d)), raison: "illisible" },
      { nom: "JSON invalide", poser: (d) => fs.writeFileSync(authSource(d), invalide), raison: "invalide" },
      { nom: "entrée chaîne", poser: (d) => fs.writeFileSync(authSource(d), JSON.stringify({ [OMO_AUTH_FOURNISSEUR]: MARQUES.acces })), raison: "invalide" },
      { nom: "tableau", poser: (d) => fs.writeFileSync(authSource(d), JSON.stringify([AUTH_COMPLET])), raison: "invalide" },
      { nom: "vide", poser: (d) => fs.writeFileSync(authSource(d), ""), raison: "invalide" },
    ];
    for (const c of cas) {
      const { d, journal, ctl } = monter(t);
      fs.mkdirSync(d.authDir);
      fs.writeFileSync(authCible(d), JSON.stringify({ [OMO_AUTH_FOURNISSEUR]: ENTREE_COPILOT }));
      c.poser(d);
      await ctl.publishAuth();
      assert.equal(fs.existsSync(authCible(d)), false, `${c.nom} : copie d'avant retirée`);
      assert.deepEqual(fs.readdirSync(d.authDir), [], c.nom);
      assert.equal(journal.lignes.at(-1)?.champs?.raison, c.raison, c.nom);
      sansMarque(journal.texte(), `journal (${c.nom})`);
    }
  });

  it("écriture impossible : erreur au message fixe (code seul), copie jamais gardée ; contenu ni au journal ni dans l'erreur", async (t) => {
    const { d, journal, ctl } = monter(t);
    fs.writeFileSync(authSource(d), JSON.stringify(AUTH_COMPLET));
    fs.writeFileSync(d.authDir, "pas un dossier");
    let erreur: unknown = null;
    await ctl.publishAuth().catch((err: unknown) => {
      erreur = err;
    });
    assert.ok(erreur instanceof OmoAuthPublicationError);
    assert.match(erreur.message, /^authentification de la salle : publication impossible \([A-Z]+\)$/);
    assert.equal(erreur.cause, undefined, "aucune cause chaînée");
    sansMarque(`${erreur.message}\n${erreur.stack ?? ""}`, "erreur");
    sansMarque(journal.texte(), "journal");
    assert.ok(journal.lignes.some((l) => l.niveau === "warn" && l.champs?.raison === "ecriture"));
  });

  it("droits : auth.json en 0600, fichiers de contrôle en 0644, même sous un masque 0277 (Linux)", { skip: SAUT_POSIX }, async (t) => {
    const { d, ctl } = monter(t, { projets: true });
    fs.writeFileSync(authSource(d), JSON.stringify(AUTH_COMPLET));
    fs.writeFileSync(d.projectsFile, vecteurs("projets")[0]?.texte ?? "");
    // Volumes déjà là, comme en production (un dossier créé sous ce masque ne serait plus inscriptible).
    fs.mkdirSync(d.controlDir);
    fs.mkdirSync(d.authDir);
    // 0277 retire aussi l'écriture du propriétaire : seuls des droits posés explicitement donnent 0600 et 0644.
    const avant = process.umask(0o277);
    try {
      await ctl.publishAuth();
      ctl.startHeartbeat();
      await ctl.settled();
      await ctl.requestStop("vous");
      await ctl.writePrecheckOk(FIXTURE.startId, []);
      await ctl.writeGuardState({ version: 1, at: T0, bloquer: [] });
    } finally {
      process.umask(avant);
    }
    assert.equal(fs.statSync(authCible(d)).mode & 0o777, 0o600);
    for (const nom of ["heartbeat", "stop-request", "precheck-ok", "guard-state.json", "omo-projets.json"]) {
      assert.equal(fs.statSync(controle(d, nom)).mode & 0o777, 0o644, nom);
    }
  });

  it("liens symboliques : auth.json, state.json et omo-projets.json liés ne sont jamais suivis (Linux)", { skip: SAUT_POSIX }, async (t) => {
    const { d, journal, ctl } = monter(t, { projets: true });
    const ailleurs = path.join(d.racine, "ailleurs");
    fs.mkdirSync(ailleurs);
    fs.writeFileSync(path.join(ailleurs, "auth.json"), JSON.stringify(AUTH_COMPLET));
    fs.writeFileSync(path.join(ailleurs, "state.json"), ecrireEtat(etatSalle(FIXTURE.startId, T0)));
    fs.writeFileSync(path.join(ailleurs, "omo-projets.json"), vecteurs("projets")[0]?.texte ?? "");
    fs.symlinkSync(path.join(ailleurs, "auth.json"), authSource(d));
    fs.symlinkSync(path.join(ailleurs, "state.json"), path.join(d.stateDir, "state.json"));
    fs.symlinkSync(path.join(ailleurs, "omo-projets.json"), d.projectsFile);
    await ctl.publishAuth();
    assert.equal(fs.existsSync(authCible(d)), false);
    assert.equal(journal.lignes.at(-1)?.champs?.raison, "illisible");
    assert.equal(await ctl.readState(), null);
    assert.equal(await ctl.publishProjects(), "illisible");
  });

  it("fichiers spéciaux : un tube nommé ne bloque rien, un périphérique n'est jamais lu comme un fichier (Linux)", { skip: SAUT_POSIX, timeout: 10_000 }, async (t) => {
    const nul = monter(t, { projets: "/dev/null" });
    assert.equal(await nul.ctl.publishProjects(), "illisible", "/dev/null : pas un fichier ordinaire");
    const racineTube = fs.mkdtempSync(path.join(os.tmpdir(), "omo-control-tube-"));
    t.after(() => fs.rmSync(racineTube, { recursive: true, force: true }));
    const tube = path.join(racineTube, "omo-projets.json");
    // Liste d'arguments, sans shell : mkfifo de l'image de test.
    execFileSync("mkfifo", [tube]);
    const fifo = monter(t, { projets: tube });
    assert.equal(await fifo.ctl.publishProjects(), "illisible", "tube nommé : ouvert sans bloquer, refusé");
  });

  it("retrait impossible (dossier en lecture seule), salle coupée ou écriture ratée : dit au journal et par l'erreur, jamais avalé (Linux)", { skip: SAUT_POSIX }, async (t) => {
    if (process.getuid?.() === 0) return t.skip("root passe outre les droits du dossier");
    for (const [cas, actif, raison] of [
      ["salle coupée", false, "coupee"],
      ["écriture ratée", true, "ecriture"],
    ] as const) {
      const { d, journal, ctl } = monter(t, { actif: () => actif });
      fs.writeFileSync(authSource(d), JSON.stringify(AUTH_COMPLET));
      fs.mkdirSync(d.authDir);
      fs.writeFileSync(authCible(d), JSON.stringify({ [OMO_AUTH_FOURNISSEUR]: ENTREE_COPILOT }));
      fs.chmodSync(d.authDir, 0o555);
      try {
        await assert.rejects(ctl.publishAuth(), (err: unknown) => err instanceof OmoAuthPublicationError && err.code === "EACCES", cas);
      } finally {
        // Rendu inscriptible avant le nettoyage du dossier temporaire.
        fs.chmodSync(d.authDir, 0o755);
      }
      const retrait = journal.lignes.find((l) => l.niveau === "warn" && l.message === "salle : auth.json non retiré");
      assert.deepEqual(retrait?.champs, { raison, code: "EACCES" }, cas);
      sansMarque(journal.texte(), `journal (${cas})`);
    }
  });
});

// --- 6. État publié par la salle ---------------------------------------------------------------------------------------------------

describe("omo-control : readState borné (invalide = inconnu)", () => {
  it("vecteurs « etat » ; absent, dossier, 64 Kio pile accepté, 1 octet de plus → inconnu", async (t) => {
    const { d, ctl } = monter(t);
    const fichier = path.join(d.stateDir, "state.json");
    assert.equal(await ctl.readState(), null, "absent");
    for (const v of vecteurs("etat")) {
      fs.writeFileSync(fichier, v.texte ?? "");
      assert.deepEqual(await ctl.readState(), v.attendu ?? null, v.nom);
    }
    const etat = etatSalle(FIXTURE.startId, T0);
    const vide = JSON.stringify({ ...etat, bourrage: "" });
    const pile = JSON.stringify({ ...etat, bourrage: "x".repeat(OMO_CONTROL_MAX_OCTETS - vide.length) });
    assert.equal(Buffer.byteLength(pile), OMO_CONTROL_MAX_OCTETS);
    fs.writeFileSync(fichier, pile);
    assert.equal((await ctl.readState())?.startId, FIXTURE.startId, "64 Kio pile");
    fs.writeFileSync(fichier, `${pile} `);
    assert.equal(await ctl.readState(), null, "64 Kio + 1");
    fs.rmSync(fichier);
    fs.mkdirSync(fichier);
    assert.equal(await ctl.readState(), null, "dossier");
  });
});

// --- 7. Projets préparés ------------------------------------------------------------------------------------------------------------

describe("omo-control : omo-projets.json déposé sous le nom du contrat", () => {
  it("même lecteur que le superviseur (vecteurs « projets » et cas en plus), même borne", () => {
    assert.equal(OMO_PROJETS_MAX_OCTETS, salle.OMO_PROJETS_MAX_OCTETS);
    const textes = [
      ...vecteurs("projets").map((v) => v.texte ?? ""),
      `{"version":1,"genereLe":"${"x".repeat(65)}","projets":[],"gitProteges":[]}`,
      '{"version":1,"genereLe":"2026-09-17T10:00:00Z","projets":[{"chemin":"","git":"dossier"}],"gitProteges":[]}',
      '{"version":1,"genereLe":"2026-09-17T10:00:00Z","projets":[]}',
      '{"version":1,"genereLe":"2026-09-17T10:00:00Z","projets":[],"gitProteges":[{"chemin":"a","forme":"lien"}]}',
      '{"version":1,"genereLe":"2026-09-17T10:00:00Z","projets":[{"chemin":"a","git":"absent","x":1}],"gitProteges":[],"y":2}',
    ];
    for (const texte of textes) assert.deepEqual(analyserProjetsPrepares(texte), salle.analyserProjetsPrepares(texte), texte);
    for (const v of vecteurs("projets")) assert.deepEqual(analyserProjetsPrepares(v.texte), v.attendu ?? null, v.nom);
  });

  it("déposé au démarrage du battement, avant lui, relu par la salle ; source absente ou invalide : copie retirée ; non configuré : rien", async (t) => {
    const vecteur = vecteurs("projets")[0];
    assert.ok(vecteur?.texte);
    const { d, journal, ctl } = monter(t, { projets: true });
    fs.writeFileSync(d.projectsFile, vecteur.texte);
    ctl.startHeartbeat();
    await ctl.settled();
    assert.deepEqual(salle.lireProjetsPrepares(d.controlDir), vecteur.attendu);
    assert.ok(fs.statSync(controle(d, "omo-projets.json")).mtimeMs <= fs.statSync(controle(d, "heartbeat")).mtimeMs);

    fs.writeFileSync(d.projectsFile, vecteurs("projets").find((v) => v.attendu === null)?.texte ?? "");
    assert.equal(await ctl.publishProjects(), "invalide");
    assert.equal(fs.existsSync(controle(d, "omo-projets.json")), false);
    fs.rmSync(d.projectsFile);
    assert.equal(await ctl.publishProjects(), "absent");
    assert.deepEqual(
      journal.lignes.filter((l) => l.message === "salle : liste des projets préparés non déposée").map((l) => l.champs?.issue),
      ["invalide", "absent"],
    );
    fs.writeFileSync(d.projectsFile, `${vecteur.texte}${" ".repeat(OMO_PROJETS_MAX_OCTETS)}`);
    assert.equal(await ctl.publishProjects(), "trop-gros");

    const sans = monter(t);
    assert.equal(await sans.ctl.publishProjects(), "non-configure");
    sans.ctl.startHeartbeat();
    await sans.ctl.settled();
    assert.equal(fs.existsSync(controle(sans.d, "omo-projets.json")), false);
  });
});

// --- 8. Forme du service ------------------------------------------------------------------------------------------------------------

describe("omo-control : forme du service", () => {
  it("port complet, aucune méthode de redémarrage ; ni variable d'environnement, ni câblage importé", async (t) => {
    const { ctl } = monter(t);
    const port: OmoControlPort = ctl;
    const service: OmoControlService = ctl;
    assert.ok(port && service);
    assert.deepEqual(Object.keys(ctl).sort(), [
      "publishAuth",
      "publishProjects",
      "readState",
      "requestStop",
      "resume",
      "settled",
      "startHeartbeat",
      "stopHeartbeat",
      "suspend",
      "suspended",
      "writeGuardState",
      "writePrecheckOk",
    ]);
    assert.equal(Object.keys(ctl).some((nom) => /restart|redemarr|relan|reboot|recreat/i.test(nom)), false);

    const source = fs.readFileSync(path.join(import.meta.dirname, "omo-control.ts"), "utf8");
    assert.equal(/\bprocess\.env\b/.test(source), false, "aucune variable d'environnement lue");
    const imports = [...source.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1] ?? "");
    assert.deepEqual(
      imports.filter((cible) => /wiring-11|main\.ts|app-factory|env\.ts|test-support/.test(cible)),
      [],
      "câblage, environnement et aides de test jamais importés",
    );
  });
});
