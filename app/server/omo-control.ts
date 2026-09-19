// Propriétaire : L17b. Service de contrôle de la Salle OMO côté cockpit (plan 2 bis §6 L17b ; spéc. §3.12.1 l.400-401, §3.15.2
// l.501-503 et l.515, §3.11 l.382, §9.4 n° 3 l.1419, G9 l.1223 ; D-2b-25, D-2b-26, D-2b-29). Implémente OmoControlPort
// (omo-contracts.ts) avec les formats d'omo-control-protocol.ts (L17a) : le cockpit est le seul écrivain du volume de contrôle
// (`control-omo`, monté `/control:ro` dans la salle) et du volume d'authentification (`omo-auth`, monté `/auth-src:ro`) ; il relit,
// borné, l'état publié par le superviseur (`omo-state`, en lecture seule pour lui).
//
// Trois règles tiennent ce module :
// 1. **Rien sans `actif()`** : `actif` (COCKPIT_OMO=on ET COCKPIT_AUTONOMY=on ET SALLE_OUVERTE, fourni par l'appelant ; ce module
//    ne lit aucune variable d'environnement et n'importe pas wiring-11.ts) est relu à CHAQUE écriture, au moment où elle se fait.
//    Faux : aucun fichier écrit, aucun dossier créé ; le battement en cours s'arrête et `auth.json` est retiré. La salle, elle, ne
//    démarre ni ne tient sans battement frais (homme mort, G9).
// 2. **Fermé en cas de doute** : un fichier lu (état, authentification, projets) absent, illisible, lien, trop gros ou mal formé vaut
//    « inconnu » ; un texte que son lecteur relirait « inconnu » est refusé à l'écriture (erreur dite et journalisée, jamais avalée).
// 3. **Aucun secret journalisé** : le contenu d'`auth.json` ne sort jamais de `publishAuth`, ni au journal, ni dans une erreur
//    (seuls un état et un code d'erreur système sont dits). Aucune méthode de redémarrage : la relance passe par `stop-request` et
//    la sortie du superviseur (§3.12.1) ; rien n'efface jamais `stop-request` (D-2b-29, `arretDuDemarrage`).
//
// Aucun branchement ici : wiring-11.ts, main.ts et app-factory.ts appartiennent à T3b (V2). Horloge injectée (battement testé sans
// attente réelle).
import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./fsutil.ts";
import type { Logger } from "./log.ts";
import type { OmoControlPort } from "./omo-contracts.ts";
import {
  analyserEtat,
  analyserObjet,
  cheminTemporaire,
  ecrireArret,
  ecrireBattement,
  ecrireGuardState,
  ecrirePrecheckOk,
  OMO_CONTROL_MAX_OCTETS,
  OMO_DELAIS,
  OMO_FICHIER_ETAT,
  OMO_FICHIER_PROJETS,
  OMO_FICHIERS_CONTROLE,
} from "./shared/omo-control-protocol.ts";
import type {
  OmoDetectionCause,
  OmoGuardState,
  OmoPrecheckOkProject,
  OmoPreparedProjects,
  OmoRecreationRaison,
  OmoSupervisorState,
} from "./shared/omo-types.ts";

// --- Constantes ------------------------------------------------------------------------------------------------------------------

/** Cadence du battement (D-2b-25) : `battementS` du protocole, en millisecondes. */
export const OMO_BATTEMENT_MS = OMO_DELAIS.battementS * 1000;

/** Fichier d'authentification d'opencode, dans `oc-data` (source) comme dans `omo-auth` (copie réduite). */
export const OMO_AUTH_FICHIER = "auth.json";

/** Seule entrée recopiée pour la salle (D-2b-26) : la connexion GitHub se fait dans l'instance principale. */
export const OMO_AUTH_FOURNISSEUR = "github-copilot";

/** `auth.json` d'opencode lu au plus : 64 Kio, comme un fichier de contrôle (fiche L17b). */
export const OMO_AUTH_SOURCE_MAX_OCTETS = OMO_CONTROL_MAX_OCTETS;

/** `omo-projets.json` : même borne que le superviseur (`OMO_PROJETS_MAX_OCTETS` de supervisor-lib.mjs, égalité testée). */
export const OMO_PROJETS_MAX_OCTETS = 1024 * 1024;

/** Droits des fichiers de contrôle : root de la salle (sans DAC_OVERRIDE) les lit en « autres » ; le masque ne décide pas. */
const MODE_CONTROLE = 0o644;

/** Droits de la copie d'`auth.json` : `node` seul (le superviseur la recopie par setpriv, D-2b-27). */
const MODE_SECRET = 0o600;

// --- Types ---------------------------------------------------------------------------------------------------------------------

/** Horloge injectable (tests) : heure et minuterie du battement. */
export interface OmoControlClock {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/** Horloge réelle : la minuterie ne retient pas le processus (arrêt du cockpit). */
export const OMO_CONTROL_SYSTEM_CLOCK: OmoControlClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface OmoControlDeps {
  /** Volume `control-omo` côté cockpit (lecture-écriture). */
  controlDir: string;
  /** Volume `omo-state` côté cockpit (lecture seule) : `state.json` du superviseur. */
  stateDir: string;
  /** Volume `omo-auth` côté cockpit (lecture-écriture) : `auth.json` réduit à l'entrée `github-copilot`. */
  authDir: string;
  /** Dossier de données de l'instance principale (`COCKPIT_OC_DATA_DIR`, monté en lecture seule) : source d'`auth.json`. */
  opencodeDataDir: string;
  /**
   * `omo-projets.json` généré par install.ps1 (`COCKPIT_OMO_PROJECTS_FILE`), déposé dans le volume de contrôle sous le nom du
   * contrat : c'est la seule liste des projets préparés que la salle croit. Absent : rien n'est déposé.
   */
  projectsFile?: string | null;
  /** Absent : horloge réelle. */
  clock?: OmoControlClock;
  /** COCKPIT_OMO=on ET COCKPIT_AUTONOMY=on ET SALLE_OUVERTE, relu à chaque écriture ; une exception vaut « faux ». */
  actif: () => boolean;
  log: Pick<Logger, "info" | "warn">;
}

/** Issue d'un dépôt de `omo-projets.json`. */
export type OmoProjectsPublication = "depose" | "non-configure" | "coupee" | "absent" | "illisible" | "trop-gros" | "invalide";

export interface OmoControlService extends OmoControlPort {
  /**
   * Dépose `omo-projets.json` (format `OmoPreparedProjects`, relu et réécrit normalisé) dans le volume de contrôle. Source absente,
   * illisible, trop grosse ou mal formée : la copie déposée est retirée (la salle ne croit alors que son balayage de /workspace).
   * Fait aussi, avant le premier battement, à chaque `startHeartbeat` : la salle lit la liste avant d'attendre le battement.
   * Hors du port de T3a : demande de contrat au train (plan §2.3).
   */
  publishProjects(): Promise<OmoProjectsPublication>;
  /** Attend la fin des écritures en file (tests, arrêt du cockpit). */
  settled(): Promise<void>;
}

/** Écriture refusée par le service lui-même : salle coupée (conditions fausses) ou suspendue (D-2b-29). */
export class OmoControlRefusError extends Error {
  readonly code: "salle-coupee" | "salle-suspendue";
  constructor(nom: string, code: "salle-coupee" | "salle-suspendue") {
    super(`fichier de contrôle « ${nom} » non écrit : ${code === "salle-coupee" ? "salle coupée" : "salle suspendue"}`);
    this.name = "OmoControlRefusError";
    this.code = code;
  }
}

/**
 * Publication d'`auth.json` en échec. Message FIXE et code système seul : ni contenu, ni message d'origine (celui de JSON.parse
 * recopierait un extrait du fichier), ni cause chaînée.
 */
export class OmoAuthPublicationError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`authentification de la salle : publication impossible (${code})`);
    this.name = "OmoAuthPublicationError";
    this.code = code;
  }
}

// --- Lecture bornée ------------------------------------------------------------------------------------------------------------

type Lecture = { etat: "ok"; texte: string } | { etat: "absent" | "illisible" | "trop-gros" };

/** Code d'une erreur système (`ENOENT`…), « inconnu » sinon : c'est tout ce qu'un journal de ce module dit d'une erreur. */
const codeErreur = (err: unknown): string =>
  typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "string" ? (err as { code: string }).code : "inconnu";

/**
 * Lit au plus `max` octets d'un fichier ordinaire, sans suivre de lien au dernier composant (O_NOFOLLOW) ni rester bloqué sur un
 * tube nommé (O_NONBLOCK), vérifié sur le descripteur ouvert. Lu au plus `max + 1` octets : un fichier qui grossit n'est jamais
 * chargé en entier. `oc-data` est écrit par l'instance principale : un lien `auth.json` posé là ne fait lire au cockpit aucun de
 * ses propres fichiers.
 */
async function lireBorne(chemin: string, max: number): Promise<Lecture> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(chemin, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  } catch (err) {
    return { etat: codeErreur(err) === "ENOENT" ? "absent" : "illisible" };
  }
  try {
    if (!(await handle.stat()).isFile()) return { etat: "illisible" };
    const tampon = Buffer.alloc(max + 1);
    let lus = 0;
    for (;;) {
      const { bytesRead } = await handle.read(tampon, lus, tampon.length - lus, null);
      if (bytesRead === 0) break;
      lus += bytesRead;
      if (lus > max) return { etat: "trop-gros" };
    }
    return { etat: "ok", texte: tampon.subarray(0, lus).toString("utf8") };
  } catch {
    return { etat: "illisible" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

// --- Formats propres au cockpit ------------------------------------------------------------------------------------------------

const estObjet = (valeur: unknown): valeur is Record<string, unknown> => typeof valeur === "object" && valeur !== null && !Array.isArray(valeur);
const estTexte = (valeur: unknown, max: number): valeur is string => typeof valeur === "string" && valeur.length > 0 && valeur.length <= max;

/**
 * `omo-projets.json` (OmoPreparedProjects, T3a), mêmes règles que `analyserProjetsPrepares` de supervisor-lib.mjs (égalité testée
 * sur les vecteurs de L17a) : ce que le cockpit dépose est exactement ce que la salle relira.
 */
export function analyserProjetsPrepares(texte: string | null | undefined): OmoPreparedProjects | null {
  const brut = analyserObjet(texte, OMO_PROJETS_MAX_OCTETS);
  if (!brut || brut.version !== 1 || !estTexte(brut.genereLe, 64)) return null;
  if (!Array.isArray(brut.projets) || !Array.isArray(brut.gitProteges)) return null;
  const projets: OmoPreparedProjects["projets"] = [];
  for (const entree of brut.projets) {
    if (!estObjet(entree) || !estTexte(entree.chemin, 4096)) return null;
    if (entree.git !== "dossier" && entree.git !== "absent") return null;
    projets.push({ chemin: entree.chemin, git: entree.git });
  }
  const gitProteges: OmoPreparedProjects["gitProteges"] = [];
  for (const entree of brut.gitProteges) {
    if (!estObjet(entree) || !estTexte(entree.chemin, 4096)) return null;
    if (entree.forme !== "dossier" && entree.forme !== "fichier") return null;
    gitProteges.push({ chemin: entree.chemin, forme: entree.forme });
  }
  return { version: 1, genereLe: brut.genereLe, projets, gitProteges };
}

/** Raison pour laquelle `auth.json` n'est pas publié (journal : jamais un contenu). */
type AuthRetrait = "coupee" | "absente" | "illisible" | "trop-grosse" | "invalide" | "sans-entree";

const RETRAIT_DE_LECTURE: Readonly<Record<Exclude<Lecture["etat"], "ok">, AuthRetrait>> = {
  absent: "absente",
  illisible: "illisible",
  "trop-gros": "trop-grosse",
};

/**
 * Texte d'`auth.json` réduit à la seule entrée `github-copilot` (un objet), ou la raison du refus. L'erreur de JSON.parse n'est
 * jamais gardée : son message recopie un extrait du fichier.
 */
function reduireAuth(texte: string): { ok: true; texte: string } | { ok: false; raison: AuthRetrait } {
  let brut: unknown;
  try {
    brut = JSON.parse(texte);
  } catch {
    return { ok: false, raison: "invalide" };
  }
  if (!estObjet(brut)) return { ok: false, raison: "invalide" };
  if (!Object.hasOwn(brut, OMO_AUTH_FOURNISSEUR)) return { ok: false, raison: "sans-entree" };
  const entree = brut[OMO_AUTH_FOURNISSEUR];
  if (!estObjet(entree)) return { ok: false, raison: "invalide" };
  return { ok: true, texte: `${JSON.stringify({ [OMO_AUTH_FOURNISSEUR]: entree })}\n` };
}

// --- Écritures -------------------------------------------------------------------------------------------------------------------

/** Écriture atomique d'un fichier de contrôle (writeFileAtomic de fsutil.ts), puis droits posés explicitement. */
async function ecrireControle(fichier: string, texte: string): Promise<void> {
  await writeFileAtomic(fichier, texte);
  await fs.chmod(fichier, MODE_CONTROLE);
}

/**
 * Écriture atomique d'un secret : le fichier temporaire est CRÉÉ en 0600 (jamais lisible par d'autres, même un instant, ce que
 * writeFileAtomic de fsutil.ts, en 0644, ne garantit pas), droits reposés sur le descripteur, puis renommage.
 */
async function ecrireSecret(fichier: string, texte: string): Promise<void> {
  await fs.mkdir(path.dirname(fichier), { recursive: true });
  const temporaire = cheminTemporaire(fichier, crypto.randomBytes(6).toString("hex"));
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(temporaire, "wx", MODE_SECRET);
    await handle.chmod(MODE_SECRET);
    await handle.writeFile(texte, "utf8");
    await handle.close();
    handle = null;
    await fs.rename(temporaire, fichier);
  } catch (err) {
    if (handle) await handle.close().catch(() => undefined);
    await fs.rm(temporaire, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Retire un fichier ; absent (ou dossier parent absent) : rien à faire. */
async function retirer(fichier: string): Promise<void> {
  try {
    await fs.rm(fichier, { force: true });
  } catch (err) {
    if (codeErreur(err) === "ENOENT" || codeErreur(err) === "ENOTDIR") return;
    throw err;
  }
}

// --- Service ---------------------------------------------------------------------------------------------------------------------

export function createOmoControl(deps: OmoControlDeps): OmoControlService {
  const { log } = deps;
  const clock = deps.clock ?? OMO_CONTROL_SYSTEM_CLOCK;
  const projectsFile = deps.projectsFile ?? null;
  const fichier = {
    battement: path.join(deps.controlDir, OMO_FICHIERS_CONTROLE.battement),
    arret: path.join(deps.controlDir, OMO_FICHIERS_CONTROLE.arret),
    precheck: path.join(deps.controlDir, OMO_FICHIERS_CONTROLE.precheck),
    garde: path.join(deps.controlDir, OMO_FICHIERS_CONTROLE.garde),
    projets: path.join(deps.controlDir, OMO_FICHIER_PROJETS),
    etat: path.join(deps.stateDir, OMO_FICHIER_ETAT),
    authSource: path.join(deps.opencodeDataDir, OMO_AUTH_FICHIER),
    auth: path.join(deps.authDir, OMO_AUTH_FICHIER),
  };

  /** Conditions relues à chaque écriture ; une exception de l'appelant vaut « faux » (fermé en cas de doute). */
  const estActif = (): boolean => {
    try {
      return deps.actif() === true;
    } catch {
      return false;
    }
  };

  // Une écriture à la fois, dans l'ordre des demandes : un arrêt du battement ne croise jamais un battement en cours d'écriture.
  let file: Promise<unknown> = Promise.resolve();
  const enFile = <T>(tache: () => Promise<T>): Promise<T> => {
    const suite = file.then(tache);
    file = suite.catch(() => undefined);
    return suite;
  };

  // Battement : `generation` change à chaque démarrage et à chaque arrêt ; une écriture planifiée par un battement arrêté ne fait rien.
  let enMarche = false;
  let generation = 0;
  let minuterie: unknown = null;
  let echecBattement: string | null = null;

  let suspension: { raison: OmoDetectionCause; at: number } | null = null;

  const arreterMinuterie = () => {
    if (minuterie === null) return;
    clock.clearTimer(minuterie);
    minuterie = null;
  };

  /** Retire `auth.json` de la salle. Un échec est dit (journal et erreur), jamais avalé : un secret qui reste doit se voir. */
  const retirerAuth = async (raison: AuthRetrait): Promise<void> => {
    try {
      await retirer(fichier.auth);
    } catch (err) {
      const code = codeErreur(err);
      log.warn("salle : auth.json non retiré", { raison, code });
      throw new OmoAuthPublicationError(code);
    }
    log.info("salle : authentification non publiée", { raison });
  };

  /** Coupe le battement tout de suite (plus aucun battement planifié ne part) ; faux s'il ne tournait pas. */
  const couperBattement = (): boolean => {
    if (!enMarche) return false;
    enMarche = false;
    generation++;
    arreterMinuterie();
    return true;
  };

  /**
   * Dans la file, après `couperBattement` : `heartbeat` retiré (la salle le voit périmé à sa vérification suivante, au lieu d'attendre
   * 20 s). Ne touche pas à l'état du battement : un `startHeartbeat` demandé entre-temps écrit après ce retrait, dans l'ordre.
   */
  const retirerBattement = async (raison: "demande" | "condition"): Promise<void> => {
    try {
      await retirer(fichier.battement);
    } catch (err) {
      log.warn("salle : battement non retiré", { raison, code: codeErreur(err) });
    }
    log.info("salle : battement arrêté", { raison });
  };

  /**
   * Dans la file : conditions relues. Tombées pendant que le battement tourne → battement arrêté et `auth.json` retiré (un échec du
   * retrait est déjà journalisé par retirerAuth ; l'appelant reçoit quand même « faux »). Rend l'état des conditions.
   */
  const conditions = async (): Promise<boolean> => {
    if (estActif()) return true;
    if (couperBattement()) {
      await retirerBattement("condition");
      await retirerAuth("coupee").catch(() => undefined);
    }
    return false;
  };

  const battre = (gen: number): void => {
    if (gen !== generation || !enMarche) return;
    minuterie = clock.setTimer(() => {
      minuterie = null;
      battre(gen);
    }, OMO_BATTEMENT_MS);
    enFile(async () => {
      if (gen !== generation || !enMarche) return;
      if (!(await conditions())) return;
      try {
        await ecrireControle(fichier.battement, ecrireBattement(clock.now()));
      } catch (err) {
        const code = codeErreur(err);
        // Un avertissement par série d'échecs, pas un toutes les 5 s ; le retour est dit aussi.
        if (echecBattement !== code) log.warn("salle : battement non écrit", { code });
        echecBattement = code;
        return;
      }
      if (echecBattement !== null) log.info("salle : battement rétabli");
      echecBattement = null;
    }).catch((err: unknown) => log.warn("salle : battement en échec", { code: codeErreur(err) }));
  };

  const publishProjects = (): Promise<OmoProjectsPublication> =>
    enFile(async (): Promise<OmoProjectsPublication> => {
      if (projectsFile === null) return "non-configure";
      if (!(await conditions())) return "coupee";
      const lecture = await lireBorne(projectsFile, OMO_PROJETS_MAX_OCTETS);
      const projets = lecture.etat === "ok" ? analyserProjetsPrepares(lecture.texte) : null;
      if (projets === null) {
        const issue: OmoProjectsPublication = lecture.etat === "ok" ? "invalide" : lecture.etat;
        await retirer(fichier.projets);
        log.warn("salle : liste des projets préparés non déposée", { issue });
        return issue;
      }
      // Réécrit normalisé (champs connus seulement) : jamais plus long que le texte analysé, déjà tenu sous la borne de la salle.
      await ecrireControle(fichier.projets, `${JSON.stringify(projets)}\n`);
      return "depose";
    });

  /** Contrôle commun aux écritures refusables (precheck-ok, guard-state.json). */
  const ecrireRefusable = (nom: string, cible: string, rendre: () => string, refusSiSuspendue: boolean): Promise<void> =>
    enFile(async () => {
      if (!(await conditions())) throw new OmoControlRefusError(nom, "salle-coupee");
      if (refusSiSuspendue && suspension !== null) throw new OmoControlRefusError(nom, "salle-suspendue");
      let texte: string;
      try {
        texte = rendre();
      } catch (err) {
        // OmoControlTropGrosError ou OmoControlInvalideError : le texte serait relu « inconnu ». Dit, jamais écrit ni avalé.
        log.warn("salle : fichier de contrôle refusé", { fichier: nom, erreur: err instanceof Error ? err.name : "inconnue" });
        throw err;
      }
      await ecrireControle(cible, texte);
    });

  const readState = async (): Promise<OmoSupervisorState | null> => {
    const lecture = await lireBorne(fichier.etat, OMO_CONTROL_MAX_OCTETS);
    return lecture.etat === "ok" ? analyserEtat(lecture.texte) : null;
  };

  return {
    startHeartbeat() {
      if (enMarche) return;
      if (!estActif()) {
        log.info("salle : battement non démarré (salle coupée)");
        return;
      }
      enMarche = true;
      generation++;
      echecBattement = null;
      // La salle lit la liste des projets à sa préparation, avant d'attendre le battement : déposée d'abord.
      if (projectsFile !== null) void publishProjects().catch((err: unknown) => log.warn("salle : liste des projets préparés non déposée", { code: codeErreur(err) }));
      battre(generation);
    },

    stopHeartbeat() {
      // Coupé tout de suite (aucun battement planifié ne part plus), fichier retiré dans la file (retirerBattement ne lève pas).
      if (couperBattement()) void enFile(() => retirerBattement("demande"));
    },

    async requestStop(cause: OmoRecreationRaison) {
      // Démarrage visé lu AVANT la file : l'état est publié par la salle, pas par ce service.
      const etat = await readState();
      await enFile(async () => {
        if (!(await conditions())) {
          // Salle coupée : aucun fichier écrit ; sans battement, l'homme mort l'arrête (30 s au plus). On ne refuse jamais un arrêt.
          log.info("salle : stop-request non écrit (salle coupée, sans battement)", { cause });
          return;
        }
        // Jamais effacé : la relance suivante a un autre startId et ne relit pas cet arrêt (arretDuDemarrage).
        await ecrireControle(fichier.arret, ecrireArret(clock.now(), cause, etat?.startId ?? null));
      });
    },

    writePrecheckOk(startId: string, projets: readonly OmoPrecheckOkProject[]) {
      return ecrireRefusable(OMO_FICHIERS_CONTROLE.precheck, fichier.precheck, () => ecrirePrecheckOk(startId, clock.now(), projets), true);
    },

    writeGuardState(state: OmoGuardState) {
      return ecrireRefusable(OMO_FICHIERS_CONTROLE.garde, fichier.garde, () => ecrireGuardState(state.at, state.bloquer), false);
    },

    publishAuth() {
      return enFile(async () => {
        if (!(await conditions())) return retirerAuth("coupee");
        const lecture = await lireBorne(fichier.authSource, OMO_AUTH_SOURCE_MAX_OCTETS);
        if (lecture.etat !== "ok") return retirerAuth(RETRAIT_DE_LECTURE[lecture.etat]);
        const reduit = reduireAuth(lecture.texte);
        if (!reduit.ok) return retirerAuth(reduit.raison);
        try {
          await ecrireSecret(fichier.auth, reduit.texte);
        } catch (err) {
          const code = codeErreur(err);
          log.warn("salle : authentification non publiée", { raison: "ecriture", code });
          // Une copie d'avant ne doit pas survivre à un échec : retirée, sans masquer l'échec d'origine ; un retrait raté est dit.
          await retirer(fichier.auth).catch((retrait: unknown) => log.warn("salle : auth.json non retiré", { raison: "ecriture", code: codeErreur(retrait) }));
          throw new OmoAuthPublicationError(code);
        }
        log.info("salle : authentification publiée (entrée github-copilot seule)");
      });
    },

    readState,

    suspend(raison: OmoDetectionCause) {
      suspension = { raison, at: clock.now() };
      log.warn("salle : suspendue", { raison });
      // Un precheck-ok déjà écrit ne doit plus rien démarrer : retiré (retirer n'écrit rien, même salle coupée).
      enFile(() => retirer(fichier.precheck)).catch((err: unknown) => log.warn("salle : precheck-ok non retiré", { code: codeErreur(err) }));
    },

    resume() {
      if (suspension === null) return;
      suspension = null;
      log.info("salle : suspension levée");
    },

    suspended: () => suspension !== null,

    publishProjects,

    async settled() {
      let queue: Promise<unknown>;
      do {
        queue = file;
        await queue;
      } while (queue !== file);
    },
  };
}
