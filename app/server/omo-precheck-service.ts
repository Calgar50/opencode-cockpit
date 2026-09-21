// Propriétaire : L19b.
// Pré-contrôle des projets de la Salle OMO côté cockpit (spécification §3.15.2 l.523-530, §4.14.1 l.811, §3.9 l.341 et l.345,
// §7.5 l.1147, G8 l.1222, M31 l.1299 ; plan 2 bis, fiche L19b ; D-2b-21, D-2b-35, D-2b-42) : port `omoPrecheck` et surveillance
// de `state.json`.
//
// - `check(projet)` : relevé borné (omo-precheck-reader.ts) puis décision pure (omo-precheck-rules.ts) ; rend le résultat masqué
//   du projet (20 chemins au plus). `ok: false` ne dit PAS qu'un projet est refusé : il dit que le pré-contrôle n'a pas pu être
//   fait (salle coupée). Un projet refusé est un `ok: true` dont le verdict est « refuse », avec sa raison et sa liste masquée :
//   c'est ce que L18c rend en 409.
// - `beforeStart(startId)` : déclenché par un NOUVEAU `startId` lu dans `state.json` (surveillance par l'horloge injectée, jamais
//   par un délai lu dans l'environnement). Contrôle chaque projet ouvert (`omoRoom.openProjects`) ET tous les projets préparés
//   tant que `PRECHECK_PORTEE` vaut « prepares » (D-2b-35 : la bascule vers « ouverts » n'arrive qu'après M31, confirmé par L21,
//   et se fait au train, jamais ici). Portée « prepares » : UN SEUL projet non conforme → aucun `precheck-ok`, donc aucun
//   démarrage, et la liste masquée est rendue à l'appelant. Portée « ouverts » : un projet non conforme est écarté sans bloquer
//   les autres (§3.15.2).
// - Aucun `precheck-ok` non plus si `state.json` montre un dossier de configuration non conforme, un `.git` non protégé
//   (`workspaceGit.nonProteges`) ou un balayage tronqué (`limiteAtteinte`), si le balayage git refait par le cockpit trouve un
//   dépôt hors `gitProteges` (un dépôt cloné depuis le démarrage de la salle), si la liste des projets préparés est illisible,
//   si les empreintes de référence ne peuvent pas être relevées, ou si la salle est suspendue (D-2b-29). Fermé en cas de doute.
// - `precheck-ok` est écrit par `omoControl.writePrecheckOk(startId, projets)` : lié au démarrage en cours, il porte TOUS les
//   projets contrôlés et conformes, sans borne de 20 (relecture 2 bis-vague-0 ; seuls les 64 Kio du format le bornent). Un refus
//   de l'écrivain (`OmoControlTropGrosError`, `OmoControlInvalideError`, `OmoControlRefusError`) devient un refus LISIBLE et
//   journalisé : jamais une salle qui attend un fichier qui ne viendra pas.
// - Une ligne `omo_room_starts` est insérée par démarrage contrôlé, avec `start_id` et les résultats masqués (D-2b-21, D-2b-42) ;
//   `cause` y reste vide jusqu'à la clôture par L23b. SSE `omo.precheck` par projet contrôlé, étiqueté « omo ».
// - Empreintes de référence (tous les projets préparés, `/workspace` et son premier niveau, champs `signalesIncomplet` et
//   `ideCiDynamiques` compris) gardées et exposées par `references()` pour la détection de L23c ; remises à null à chaque
//   nouveau démarrage contrôlé et gardées seulement quand `precheck-ok` a été écrit.
// - Reprise d'une salle suspendue : un `startId` déjà contrôlé n'est JAMAIS recontrôlé et ne réécrit jamais de `precheck-ok` ; il
//   faut un nouveau démarrage, pour que les références et le balayage git soient refaits ensemble.
// - Ce module ne lit ni ne modifie omo-precheck-rules.ts, omo-precheck-reader.ts, omo-control.ts ni omo-room.ts : il les appelle.
//   Les ports voisins sont lus à CHAQUE appel (`deps.control()`, `deps.room()`), jamais en copie : une surcharge de test ou un
//   port posé plus tard reste pris en compte.
// `neutralOmoPrecheck` reste exporté et inchangé (T3b) : c'est le port des tests qui ne déclarent pas ce module, et celui du
// dépôt tant que `SALLE_OUVERTE` est faux.
import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import type { Cockpit11Deps, Cockpit11Module } from "./contracts-11.ts";
import type { EventHub } from "./hub.ts";
import type { Logger } from "./log.ts";
import { analyserProjetsPrepares, OMO_CONTROL_SYSTEM_CLOCK, OMO_PROJETS_MAX_OCTETS, type OmoControlClock } from "./omo-control.ts";
import type { OmoBeforeStartOutcome, OmoControlPort, OmoPrecheckOutcome, OmoPrecheckPort, OmoRoomPort } from "./omo-contracts.ts";
import { releverEmpreintesSalle, releverGitsWorkspace, releverProjet, type PrecheckOptions, type ReleveEmpreintes } from "./omo-precheck-reader.ts";
import { estStartId } from "./shared/omo-control-protocol.ts";
import { decidePrecheck, gitsHorsProtection, PRECHECK_BORNES, type PrecheckBornes, type PrecheckFaits } from "./shared/omo-precheck-rules.ts";
import type {
  OmoActivationRefusalCode,
  OmoEventMap,
  OmoPrecheckOkProject,
  OmoPrecheckProjectResult,
  OmoPreparedProjects,
  OmoSupervisorState,
} from "./shared/omo-types.ts";

/**
 * Portée du pré-contrôle avant chaque démarrage (D-2b-35, M31 l.1299).
 * - « prepares » : tous les projets préparés, ouverts ou non, plus les projets ouverts. Un seul non conforme refuse le démarrage.
 * - « ouverts » : les projets ouverts seulement ; un projet non conforme est écarté sans bloquer les autres.
 * La valeur du dépôt reste « prepares » tant que M31 (l'extension ne touche que le dossier ouvert et ses parents) n'est pas
 * confirmée par le banc de L21 ; la bascule est faite au train de la vague 3, jamais par ce module.
 */
export const PRECHECK_PORTEE: OmoPrecheckPortee = "prepares";

export type OmoPrecheckPortee = "prepares" | "ouverts";

/** Période de la surveillance de `state.json`, comptée par l'horloge injectée (jamais par une variable d'environnement). */
export const OMO_PRECHECK_SURVEILLANCE_MS = 1_000;

/** Nombre de démarrages gardés en mémoire pour refuser un second pré-contrôle du même `startId` (liste bornée). */
const DEMARRAGES_GARDES = 16;

/** `cause` d'une ligne `omo_room_starts` non close : vide, jamais une cause d'arrêt ; L23b la remplit à la clôture (D-2b-21). */
const CAUSE_NON_CLOSE = "";

/** Empreintes de référence d'un démarrage accepté, base de la détection §4.14.5 (lues par L23c). */
export interface OmoPrecheckReferences {
  /** Démarrage auquel ces références se rapportent : un autre démarrage en refait de neuves. */
  startId: string;
  /** Heure du relevé (horloge injectée). */
  at: number;
  /** Un relevé par dossier contrôlé : `/workspace`, chacun de ses dossiers de premier niveau et chaque projet préparé. */
  releves: ReleveEmpreintes[];
}

export interface OmoPrecheckService extends OmoPrecheckPort {
  /** Démarre la surveillance de `state.json` (inscription de démarrage du module). */
  start(): void;
  stop(): void;
  /** Références du dernier démarrage accepté ; `null` tant qu'aucun `precheck-ok` n'a été écrit (L23c n'invente rien). */
  references(): OmoPrecheckReferences | null;
  /** Attend la fin des pré-contrôles en file (tests, arrêt du cockpit). */
  settled(): Promise<void>;
}

export interface OmoPrecheckDeps {
  /** Dossier de travail monté (`/workspace` dans la salle, un dossier temporaire dans les tests). */
  workspace: string;
  /** `omo-projets.json` généré par `install.ps1` ; `null` ou illisible : aucun projet n'est tenu pour préparé. */
  projectsFile: string | null;
  db: DatabaseSync;
  hub: Pick<EventHub, "cockpit">;
  log: Pick<Logger, "info" | "warn">;
  /** Port de contrôle en vigueur, relu à chaque appel. */
  control: () => OmoControlPort;
  /** Port des salles en vigueur, relu à chaque appel (`openProjects`). */
  room: () => OmoRoomPort;
  /** COCKPIT_OMO=on ET COCKPIT_AUTONOMY=on ET SALLE_OUVERTE, relu à chaque pré-contrôle ; une exception vaut « faux ». */
  actif: () => boolean;
  /** Absent : horloge réelle. */
  clock?: OmoControlClock;
  /** Bornes de production par défaut ; un test peut en passer de plus petites. Jamais lues dans l'environnement. */
  bornes?: Partial<PrecheckBornes>;
  /** Portée du dépôt par défaut ; un test la bascule sur « ouverts » pour vérifier l'après-M31. */
  portee?: OmoPrecheckPortee;
}

/**
 * Port neutre : le service réel n'est pas construit (salle coupée). `check` et `beforeStart` refusent « salle-coupee » et
 * n'écrivent AUCUN `precheck-ok` : le superviseur ne démarrera donc rien, même si un démarrage était en cours.
 */
export function neutralOmoPrecheck(_deps: Cockpit11Deps): OmoPrecheckPort {
  return {
    check: async () => ({ ok: false, code: "salle-coupee" }),
    // Aucun precheck-ok : le superviseur ne démarrera donc rien, même si un démarrage était en cours.
    beforeStart: async (startId) => ({ ok: false, startId, code: "salle-coupee", resultats: [] }),
  };
}

// --- Lecture bornée de la liste des projets préparés -----------------------------------------------------------------------------

/**
 * Lit au plus `max` octets d'un fichier ordinaire, sans suivre de lien au dernier composant (O_NOFOLLOW) ni rester bloqué sur un
 * tube nommé (O_NONBLOCK), vérifiés sur le descripteur ouvert. `null` : absent, illisible, trop gros ou pas un fichier — toutes
 * des raisons de ne rien tenir pour préparé (fermé en cas de doute). Même règle que le lecteur de L17b, sur un autre fichier.
 */
async function lireBorne(chemin: string, max: number): Promise<string | null> {
  let handle;
  try {
    handle = await fs.open(chemin, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > max) return null;
    // `read` peut rendre moins d'octets que demandé : la boucle s'arrête sur une lecture vide, jamais sur une taille attendue.
    const tampon = Buffer.alloc(max + 1);
    let lus = 0;
    for (;;) {
      const { bytesRead } = await handle.read(tampon, lus, tampon.length - lus, lus);
      if (bytesRead === 0) break;
      lus += bytesRead;
      if (lus > max) return null;
    }
    return tampon.subarray(0, lus).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Code d'une erreur système (`ENOENT`…), « inconnu » sinon : c'est tout ce qu'un journal de ce module dit d'une erreur. */
const codeErreur = (err: unknown): string =>
  typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "string" ? (err as { code: string }).code : "inconnu";

/** Nom d'une erreur (`OmoControlTropGrosError`…) : jamais son message, qui pourrait recopier un extrait de fichier. */
const nomErreur = (err: unknown): string => (err instanceof Error ? err.name : "inconnue");

/**
 * Chemin relatif normalisé d'un projet (séparateurs, « ./ » et « / » de fin sans effet), comme le fait le lecteur : deux
 * écritures du même projet ne sont contrôlées qu'une fois.
 */
function normaliserProjet(projet: string): string {
  const segments = projet.split(/[\\/]/).filter((segment) => segment !== "" && segment !== ".");
  return segments.length === 0 ? "." : segments.join("/");
}

/**
 * Empreinte d'un relevé de projet, écrite dans `precheck-ok` et relue par le cockpit seul : tout ce que le relevé porte y entre,
 * y compris `signalesIncomplet` et `ideCiDynamiques`, pour qu'une référence incomplète ne se confonde jamais avec une complète.
 */
function empreinteDuReleve(releve: ReleveEmpreintes): string {
  const canonique = JSON.stringify({
    racine: releve.racine,
    git: releve.git,
    fichiers: releve.fichiers.map((fichier) => [fichier.chemin, fichier.sha256]),
    liens: releve.liens,
    illisibles: releve.illisibles,
    impossible: releve.impossible,
    signalesIncomplet: releve.signalesIncomplet,
    ideCiDynamiques: releve.ideCiDynamiques,
  });
  return crypto.createHash("sha256").update(canonique, "utf8").digest("hex");
}

/** Faits d'un projet que le lecteur n'a pas pu atteindre du tout (dossier de travail introuvable) : un doute, donc un refus. */
function faitsIllisibles(projet: string, prepare: boolean): PrecheckFaits {
  return {
    projet: normaliserProjet(projet),
    horsWorkspace: false,
    prepare,
    profondeurDepassee: false,
    empreinteImpossible: false,
    trouves: [{ remontee: 0, nom: "", raison: "illisible" }],
  };
}

// --- Service --------------------------------------------------------------------------------------------------------------------

export function createOmoPrecheckService(deps: OmoPrecheckDeps): OmoPrecheckService {
  const { log } = deps;
  const clock = deps.clock ?? OMO_CONTROL_SYSTEM_CLOCK;
  const bornes: Readonly<PrecheckBornes> = Object.freeze({ ...PRECHECK_BORNES, ...deps.bornes });
  const portee = deps.portee ?? PRECHECK_PORTEE;

  /** Conditions relues à chaque pré-contrôle ; une exception de l'appelant vaut « faux » (fermé en cas de doute). */
  const estActif = (): boolean => {
    try {
      return deps.actif() === true;
    } catch {
      return false;
    }
  };

  // Un pré-contrôle à la fois, dans l'ordre des demandes : deux démarrages ne se croisent jamais sur les mêmes dossiers.
  let file: Promise<unknown> = Promise.resolve();
  const enFile = <T>(tache: () => Promise<T>): Promise<T> => {
    const suite = file.then(tache);
    file = suite.catch(() => undefined);
    return suite;
  };

  /** Démarrages déjà contrôlés (liste bornée) : un `startId` n'est pré-contrôlé qu'une fois, quel qu'en soit le résultat. */
  const traites: string[] = [];
  const marquerTraite = (startId: string): void => {
    traites.push(startId);
    if (traites.length > DEMARRAGES_GARDES) traites.shift();
  };

  /** Dernier `startId` vu par la surveillance : sans lui, chaque tour d'horloge redemanderait un pré-contrôle déjà refusé. */
  let dernierVu: string | null = null;
  let references: OmoPrecheckReferences | null = null;
  let enMarche = false;
  let minuterie: unknown = null;
  /** Tour de veille en cours ; il met le pré-contrôle en file APRÈS une lecture d'état, donc `settled()` l'attend d'abord. */
  let veille: Promise<void> = Promise.resolve();

  const optionsDe = (prepares: readonly string[]): PrecheckOptions => ({ workspace: deps.workspace, prepares, bornes });

  /** `omo-projets.json` de l'hôte, relu à chaque pré-contrôle (`install.ps1` peut l'avoir refait) ; `null` : liste inutilisable. */
  const lireProjetsPrepares = async (): Promise<OmoPreparedProjects | null> => {
    if (deps.projectsFile === null) return null;
    const texte = await lireBorne(deps.projectsFile, OMO_PROJETS_MAX_OCTETS);
    return analyserProjetsPrepares(texte);
  };

  /** Relevé puis décision d'un projet ; l'empreinte est `null` quand le projet n'a pas pu être atteint (donc refusé). */
  const controlerProjet = async (projet: string, options: PrecheckOptions): Promise<{ resultat: OmoPrecheckProjectResult; empreinte: string | null }> => {
    try {
      const { faits, empreintes } = await releverProjet(projet, options);
      return { resultat: decidePrecheck(faits, bornes), empreinte: empreintes === null ? null : empreinteDuReleve(empreintes) };
    } catch (err) {
      // Seul le dossier de travail introuvable lève : tout le reste est un fait. Le doute devient un refus lisible.
      log.warn("salle : projet non relevé par le pré-contrôle", { code: codeErreur(err) });
      const prepare = (options.prepares ?? []).map(normaliserProjet).includes(normaliserProjet(projet));
      return { resultat: decidePrecheck(faitsIllisibles(projet, prepare), bornes), empreinte: null };
    }
  };

  /** Projets ouverts, lus sur le port en vigueur ; une exception ne fait pas tomber le pré-contrôle, elle refuse par la suite. */
  const projetsOuverts = (): string[] => {
    try {
      return deps.room().openProjects();
    } catch (err) {
      log.warn("salle : projets ouverts illisibles", { code: codeErreur(err) });
      return [];
    }
  };

  /** Projets à contrôler avant ce démarrage, sans doublon : portée « prepares » (D-2b-35) ou projets ouverts seuls (après M31). */
  const projetsAControler = (prepares: OmoPreparedProjects): string[] => {
    const noms = portee === "prepares" ? [...prepares.projets.map((projet) => projet.chemin), ...projetsOuverts()] : projetsOuverts();
    const vus: string[] = [];
    for (const nom of noms) {
      const normalise = normaliserProjet(nom);
      if (!vus.includes(normalise)) vus.push(normalise);
    }
    return vus;
  };

  const emettre = (resultat: OmoPrecheckProjectResult): void => {
    const donnees: OmoEventMap["omo.precheck"] = { projet: resultat.projet, resultat };
    deps.hub.cockpit("omo.precheck", donnees, "omo");
  };

  /** Ligne du démarrage contrôlé (D-2b-21, D-2b-42) ; `false` : rien n'a été enregistré, donc rien ne démarre. */
  const inscrireDemarrage = (at: number, etat: OmoSupervisorState, startId: string, resultats: readonly OmoPrecheckProjectResult[]): boolean => {
    try {
      deps.db
        .prepare("INSERT INTO omo_room_starts (started_at, image_id, manifest_sha256, precheck, cause, start_id) VALUES (?, ?, ?, ?, ?, ?)")
        .run(at, etat.imageId, etat.manifestSha256, JSON.stringify(resultats), CAUSE_NON_CLOSE, startId);
      return true;
    } catch (err) {
      log.warn("salle : démarrage non enregistré", { code: codeErreur(err) });
      return false;
    }
  };

  /** Refus de l'écrivain de L17b traduit en code du contrat : une salle coupée ou suspendue se dit, le reste est un refus lisible. */
  const codeDuRefusDEcriture = (err: unknown): OmoActivationRefusalCode => {
    const code = (err as { code?: unknown } | null | undefined)?.code;
    if (code === "salle-coupee" || code === "salle-suspendue") return code;
    return "precheck-refuse";
  };

  const check = async (projet: string): Promise<OmoPrecheckOutcome> => {
    if (!estActif()) return { ok: false, code: "salle-coupee" };
    // Liste illisible : aucun projet n'est tenu pour préparé, la décision pure le dit (« non-prepare », l.1063).
    const prepares = await lireProjetsPrepares();
    if (prepares === null) log.warn("salle : liste des projets préparés illisible, aucun projet tenu pour préparé");
    const options = optionsDe((prepares?.projets ?? []).map((prepare) => prepare.chemin));
    const { resultat } = await controlerProjet(projet, options);
    return { ok: true, resultat };
  };

  /**
   * Première condition qui interdit tout `precheck-ok` pour ce démarrage, `null` si rien ne s'y oppose. Fermé en cas de doute :
   * projet non conforme (portée « prepares », D-2b-35), dossier de configuration de la salle non conforme, `.git` non protégé
   * ou balayage tronqué vus par la salle, puis dépôt git hors protection vu par le cockpit lui-même.
   */
  const conditionBloquante = async (
    etat: OmoSupervisorState,
    prepares: OmoPreparedProjects,
    resultats: readonly OmoPrecheckProjectResult[],
    options: PrecheckOptions,
  ): Promise<OmoActivationRefusalCode | null> => {
    const nonConformes = resultats.filter((resultat) => resultat.verdict === "refuse");
    if (portee === "prepares" && nonConformes.length > 0) {
      // D-2b-35 : un seul projet non conforme refuse le démarrage entier, tant que M31 n'est pas confirmée.
      log.warn("salle : démarrage refusé, projet non conforme", { projets: nonConformes.length, portee });
      return "precheck-refuse";
    }
    const configNonConformes = etat.dossiersConfig.filter((dossier) => !dossier.ok);
    if (configNonConformes.length > 0) {
      log.warn("salle : démarrage refusé, dossier de configuration non conforme", { dossiers: configNonConformes.map((dossier) => dossier.chemin) });
      return "precheck-refuse";
    }
    if (etat.workspaceGit.limiteAtteinte || etat.workspaceGit.nonProteges.length > 0) {
      log.warn("salle : démarrage refusé, historique git non protégé (balayage de la salle)", {
        limiteAtteinte: etat.workspaceGit.limiteAtteinte,
        depots: etat.workspaceGit.nonProteges.length,
      });
      return "git-inscriptible";
    }
    // Le balayage de state.json date du démarrage de la salle : le cockpit refait le sien, avec les mêmes règles, et le compare
    // à `gitProteges` (liste que la salle ne peut pas réécrire). Un dépôt cloné depuis est donc vu.
    const gits = await releverGitsWorkspace(options);
    const horsProtection = gitsHorsProtection(gits.depots, prepares.gitProteges);
    if (gits.limiteAtteinte || horsProtection.length > 0) {
      log.warn("salle : démarrage refusé, dépôt git hors protection", { limiteAtteinte: gits.limiteAtteinte, depots: horsProtection.length });
      return "workspace-non-verifie";
    }
    return null;
  };

  async function precontrolerDemarrage(startId: string): Promise<OmoBeforeStartOutcome> {
    const refus = (code: OmoActivationRefusalCode, resultats: OmoPrecheckProjectResult[] = []): OmoBeforeStartOutcome => ({
      ok: false,
      startId,
      code,
      resultats,
    });
    if (!estActif()) {
      log.info("salle : aucun pré-contrôle (salle coupée)");
      return refus("salle-coupee");
    }
    const control = deps.control();
    if (control.suspended()) {
      log.warn("salle : pré-contrôle refusé, salle suspendue");
      return refus("salle-suspendue");
    }
    if (!estStartId(startId)) {
      log.warn("salle : pré-contrôle refusé, démarrage sans identifiant reconnu");
      return refus("salle-en-relance");
    }
    // Reprise d'une salle suspendue : jamais un second precheck-ok sur le même démarrage ; il en faut un nouveau, pour que les
    // références et le balayage git soient refaits ensemble.
    if (traites.includes(startId)) {
      log.warn("salle : pré-contrôle déjà fait pour ce démarrage, un nouveau démarrage est exigé");
      return refus("salle-en-relance");
    }
    const etat = await control.readState();
    if (etat === null || etat.startId !== startId) {
      log.warn("salle : pré-contrôle refusé, état du démarrage indisponible", { connu: etat !== null });
      return refus("salle-en-relance");
    }
    const prepares = await lireProjetsPrepares();
    if (prepares === null) {
      log.warn("salle : pré-contrôle refusé, liste des projets préparés illisible");
      return refus("precheck-refuse");
    }

    // À partir d'ici le démarrage est contrôlé : une seule fois, quel que soit le résultat, et les références d'avant tombent.
    marquerTraite(startId);
    references = null;
    const options = optionsDe(prepares.projets.map((projet) => projet.chemin));
    const resultats: OmoPrecheckProjectResult[] = [];
    const empreintes = new Map<string, string>();
    for (const projet of projetsAControler(prepares)) {
      const { resultat, empreinte } = await controlerProjet(projet, options);
      resultats.push(resultat);
      if (empreinte !== null) empreintes.set(resultat.projet, empreinte);
      emettre(resultat);
    }
    const at = clock.now();
    if (!inscrireDemarrage(at, etat, startId, resultats)) return refus("precheck-refuse", resultats);

    const bloquante = await conditionBloquante(etat, prepares, resultats, options);
    if (bloquante !== null) return refus(bloquante, resultats);
    let releves: ReleveEmpreintes[];
    try {
      releves = await releverEmpreintesSalle(options);
    } catch (err) {
      log.warn("salle : démarrage refusé, empreintes de référence impossibles", { code: codeErreur(err) });
      return refus("precheck-refuse", resultats);
    }

    // `precheck-ok` porte TOUS les projets contrôlés et conformes, sans borne de 20 (relecture 2 bis-vague-0).
    const projets: OmoPrecheckOkProject[] = [];
    for (const resultat of resultats) {
      if (resultat.verdict !== "conforme") continue;
      const sha256 = empreintes.get(resultat.projet);
      if (sha256 === undefined) {
        // Un projet conforme a toujours son relevé : sans empreinte, le doute l'emporte et rien ne démarre.
        log.warn("salle : démarrage refusé, projet conforme sans empreinte");
        return refus("precheck-refuse", resultats);
      }
      projets.push({ chemin: resultat.projet, sha256 });
    }
    try {
      await control.writePrecheckOk(startId, projets);
    } catch (err) {
      // Refus LISIBLE de l'écrivain (trop gros, invalide, salle coupée ou suspendue) : jamais une salle qui attend sans raison.
      const code = codeDuRefusDEcriture(err);
      log.warn("salle : precheck-ok refusé par l'écrivain", { erreur: nomErreur(err), code });
      return refus(code, resultats);
    }
    references = { startId, at, releves };
    log.info("salle : pré-contrôle du démarrage accepté", { projets: projets.length, portee });
    return { ok: true, startId, resultats };
  }

  const beforeStart = (startId: string): Promise<OmoBeforeStartOutcome> => enFile(() => precontrolerDemarrage(startId));

  const planifier = (): void => {
    minuterie = clock.setTimer(() => {
      minuterie = null;
      // Gardé : `settled()` attend le tour de veille AVANT la file, sinon un pré-contrôle pas encore mis en file lui échapperait.
      veille = tour();
    }, OMO_PRECHECK_SURVEILLANCE_MS);
  };

  /** Un tour de surveillance : un `startId` jamais vu déclenche le pré-contrôle du démarrage ; le reste ne fait rien. */
  const tour = async (): Promise<void> => {
    try {
      if (!estActif()) return;
      const etat = await deps.control().readState();
      const startId = etat?.startId ?? null;
      if (startId === null || startId === dernierVu) return;
      dernierVu = startId;
      await beforeStart(startId);
    } catch (err) {
      log.warn("salle : surveillance du démarrage en échec", { code: codeErreur(err) });
    } finally {
      if (enMarche) planifier();
    }
  };

  return {
    check,
    beforeStart,

    start() {
      if (enMarche) return;
      enMarche = true;
      planifier();
    },

    stop() {
      enMarche = false;
      if (minuterie !== null) {
        clock.clearTimer(minuterie);
        minuterie = null;
      }
    },

    references: () => references,

    /** Le tour de veille d'abord (c'est lui qui met un pré-contrôle en file), puis la file, jusqu'à ce que les deux soient stables. */
    async settled() {
      for (;;) {
        const tourEnCours = veille;
        const queue = file;
        await tourEnCours;
        await queue;
        if (tourEnCours === veille && queue === file) return;
      }
    },
  };
}

/**
 * Le service réel n'est construit que si la salle est configurée ET ouverte : dans le dépôt (`SALLE_OUVERTE` faux), le port
 * NEUTRE reste en place et le module n'inscrit rien — aucun `state.json` n'est lu, aucun `precheck-ok` n'est écrit, jamais.
 * L'inscription de démarrage porte `instances: ["omo"]` (D-2b-40) : c'est la surveillance de la salle.
 */
export const omoPrecheckModule: Cockpit11Module = {
  name: "omoPrecheck",
  install(reg, c11) {
    const dirs = c11.omoControlDirs ?? null;
    if (!c11.salleOuverte || dirs === null) return;
    const service = createOmoPrecheckService({
      workspace: c11.env.workspaceDir,
      projectsFile: dirs.projectsFile ?? null,
      db: c11.db,
      hub: c11.hub,
      log: c11.log,
      control: () => c11.ports.omoControl,
      room: () => c11.ports.omoRoom,
      actif: () => c11.salleOuverte && c11.env.autonomy,
    });
    c11.ports.omoPrecheck = service;
    reg.startup(async () => void service.start(), { instances: ["omo"] });
  },
};
