// Propriétaire : L23c.
// Détections après coup de la Salle OMO, en service (spécification §4.14.5 l.838-852, JS-6, JS-7 ; §5.7.2 cas 7 l.958 ; §3.9 l.345 ;
// §4.12 l.784 ; §7.6 l.1156 ; G13 l.1227 ; plan 2 bis-2 ter, fiche L23c, D-2b-18, D-2b-29, D-2b-35, D-2b-37 ; mesures MO-1, MO-5,
// R16 ; décisions n° 7 du 19/09 et A16 du 22/09) : port `omoDetections`, dérivation de la salle, abonnement `usage.updated` de la
// salle. `neutralOmoDetections` (T3b) reste exporté et INCHANGÉ : c'est le port des tests qui ne déclarent pas ce module, et celui du
// dépôt tant que `SALLE_OUVERTE` est faux.
//
// Ce service ne DÉCIDE rien : les règles sont celles du module pur de L23a (shared/omo-detections.ts), à qui il remet des faits déjà
// réduits, un à la fois, dans l'ordre du flux. Il fait tout le reste :
// - faits du flux de la salle : arbre des sessions (mémoire propre, tenue avant que la file du processeur ne les enregistre) ;
//   registre des réponses émises par le portillon de la SALLE (détection 1, JS-6) ; racines ouvertes lues dans `omo_rooms`
//   (détection 2) ; `global.disposed` et `server.instance.disposed` (3) ; permission de session (4) ; origine des messages de racine
//   (5 : le fait `origine` écrit par la dérivation des faits de L4b, seul calcul de l'origine, écouté sur le hub — rien n'est
//   recalculé ici, P12 ; l'identité douteuse de MO-1 y est déjà rendue « origine-inconnue », variante retenue par L25a, aucune
//   union changée) ; nouvelles tentatives et progrès (8, D-2b-18) ; activité hors demande (D-2b-29, `demandeActive` lu par
//   `omoActivation.activeRequest()`) ; conflits d'identifiant entre instances (L18a, `onInstanceConflict`), remis comme une racine
//   que le cockpit n'a pas ouverte ;
// - contrôle du disque (détections 6 et 7, fichiers signalés) : BORNÉ (bornes du pré-contrôle), au plus un toutes les 5 s après
//   chaque outil terminé, et à chaque `session.idle`. Il relève TOUS les projets préparés, `/workspace` et son premier niveau
//   (relevés de L19a) et les compare aux références du démarrage gardées par L19b ;
// - quarantaine (D-2b-37) APRÈS l'arrêt, jamais pendant que la salle peut écrire (relecture 2ter-vague-4, second tour ; ordre
//   inverse de la fiche L23c, qui la plaçait avant l'arrêt) : chaque `.git` créé est renommé `.git.suspect-{horodatage}` par
//   `renommerSansSuivreLiens` (L19a), jamais supprimé, jamais à travers un lien ; un renommage refusé est journalisé et le chemin
//   reste listé « à relire ». Le renommage se fait par CHEMIN : tant que la salle tourne, elle peut remplacer un dossier du chemin
//   par un lien vers un autre projet entre les vérifications et le `rename`, et aucune tenue par descripteur n'est établie sur le
//   partage de Docker Desktop. D'où l'ordre : arrêt, puis démarrage SUIVANT vu dans `state.json` (le conteneur qui a porté la
//   demande est sorti, et avec lui tout ce que l'IA y avait lancé ; ce démarrage-là n'a pas lancé opencode), puis quarantaine,
//   puis relance à neuf (le superviseur de ce démarrage a balayé le dossier de travail AVANT le renommage : il a vu le `.git` et
//   ne lancerait jamais rien). Relance non vue dans `OMO_DETECTIONS_RELANCE_MAX_MS`, ou opencode déjà relancé : RIEN n'est renommé, chemin « à relire » ;
// - l'arrêt : `tentatives-429` → `omoStop.run(…, "plafond-tentatives")`, toute autre cause → `omoStop.run(…, "hors-controle")`,
//   précédé de l'événement `omo.hors-controle` (cause, fichiers signalés), du fait `detection` et du journal « hors-contrôle » —
//   sauf quand un `.git` est à mettre de côté : ces trois-là suivent alors la quarantaine, dont ils disent le résultat ;
// - `autonomy_decisions {par: "extension"}` et fait `decision` pour chaque partie d'outil terminée SANS `permission.asked` et
//   listée « sans demande » par l'audit de L20 (§4.12 l.784) ; fichiers à relire listés en fin de demande.
//
// Choix tenus ici, chacun gardé par un test qui tombe sans lui :
// - ARRÊT OU RELANCE DEMANDÉS PAR LE COCKPIT : rien n'est transmis au module pur pendant qu'une demande se termine ou s'arrête, ni
//   pendant la relance à neuf qui suit (D-2b-29) — sinon l'abandon des sessions, leur dernier coût et un `dispose` seraient lus
//   comme venant de l'extension. La fenêtre s'ouvre quand la demande vue disparaît de `activeRequest()` (fin, plafond, « Arrêter »),
//   quand ce service arrête lui-même la salle, ou sur un démarrage trouvé lancé avant le cockpit (redémarrage du cockpit, arrêté par
//   L23b) ; elle se ferme au démarrage suivant (nouvelles références de L19b, nouvel état pur), ou au bout de
//   `OMO_DETECTIONS_RELANCE_MAX_MS` : une salle qui ne se relance pas est de nouveau surveillée, jamais oubliée ;
// - détection 4 (MO-5, relue sur le `dist` de la 4.19.4) : un envoi portant `tools` REMPLACE la permission de session, et
//   l'extension en porte à chaque délégation (symboles `buildSyncPromptTools2`, `getAgentToolRestrictions`, `buildFallbackBody`) :
//   refus d'outils, et `allow` sur `task` et `call_omo_agent`. Règle en service : `ajout-allow-ou-ask` (conséquence de MO-5 reportée,
//   fiche L23c), et les `allow` sur ces deux permissions ne comptent pas — ce sont les délégations de l'extension, libres mais
//   bornées (décision n° 7 du 19/09 : plugin de garde, plafonds, détections). Les enfants naissent avec `question: deny`
//   (`QUESTION_DENIED_SESSION_PERMISSION`) : la règle « toute différence » de MX-OMO §13 arrêterait chaque délégation (G13). Tout
//   autre `allow` ou `ask` ajouté arrête la salle, y compris le `read: true` que l'extension donne à `multimodal-looker`
//   (`AGENT_RESTRICTIONS`) : une règle de session, lue après celles de l'instance, passerait les refus des clés et des `.env*`, et cet
//   agent n'est coupé que par `omo.jsonc`, qui n'est pas appliqué (A14). Une permission mal formée arrête aussi (fermé en cas de doute) ;
// - F-c : un refus envoyé par le portillon emporte d'office les autres demandes de la même session, sans passer par lui. Un
//   `reject` non inscrit reçu dans `OMO_DETECTIONS_CASCADE_MS` après un `reject` inscrit de la même session est cette cascade ;
//   un `once` ou un `always` non inscrit reste toujours une détection ;
// - racine ouverte par le cockpit : la ligne `omo_rooms` est écrite APRÈS la réponse de `POST /session`, et l'événement
//   `session.created` peut arriver avant. Une racine absente d'`omo_rooms` est relue après `OMO_DETECTIONS_RACINE_DELAI_MS`
//   (moins de 5 s : G13) ;
// - configuration apparue (détection 6) : les relevés de L19a ne portent pas les noms de configuration. Ils sont relevés ici, à la
//   racine de chaque dossier contrôlé ; la référence d'un projet préparé, de ses parents et de `/workspace` est « aucune » (le
//   pré-contrôle du démarrage l'a exigé, D-2b-35), celle d'un autre dossier de premier niveau est relevée à l'armement ;
// - `.git` créé (détection 6) : les relevés ne voient le `.git` qu'à la racine d'un dossier contrôlé. Le dossier de travail est donc
//   parcouru en plus (borné, sans suivre de lien, `node_modules` exclu), CASSE IGNORÉE — sur le partage de Docker Desktop, `.GIT`
//   est un dépôt pour le git du poste, et `releverGitsWorkspace` (L19a) ne cherche que « .git ». Tout `.git` hors de `gitProteges`
//   (omo-projets.json) est neuf : le démarrage n'a été accepté que sans aucun autre (L19b). Un `.git` protégé n'est JAMAIS renommé.
//
// Décision A16 (22/09, montages inversés de L16c) : `/workspace` est en lecture seule, l'écriture n'est rouverte que sur les
// entrées de premier niveau des projets préparés. Dans ce monde, aucun fichier ne peut plus être créé à la racine d'un projet, de
// `/workspace` ni d'un dossier de premier niveau (EROFS franc) : un `.git` ou une configuration n'y apparaît plus que si un montage
// a bougé. Aucun cas n'est retiré pour autant : ils restent le filet de ce montage déplacé. Un `.git` PEUT en revanche apparaître
// dans une entrée ouverte en écriture (`PROJET/src/.git`, à toute profondeur) : c'est le parcours du dossier de travail qui le voit.
// Règle d'hygiène A16 (5) : un lien symbolique posé dans une entrée ouverte arrive sur le poste comme un VRAI lien. Ici, aucun lien
// n'est jamais suivi (`lstat`, `O_NOFOLLOW`, `renommerSansSuivreLiens`). Un lien à la place d'un fichier d'IDE et de CI ou d'une
// configuration change sa forme : détection, et il est listé « à relire » ; un lien au nom d'un fichier signalé (`run.ps1`) ne se
// relève pas, et la liste « à relire » de fin de demande DIT qu'elle est incomplète (L19a, `signalesIncomplet`) ; un `.git` lien
// n'est jamais renommé. Les autres liens sont signalés par la sonde du superviseur (L16c, `constatGit`) au démarrage suivant, qui
// suit chaque fin de demande (relance à neuf).
import crypto from "node:crypto";
import { type Dirent, constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Cockpit11, Cockpit11Deps, Cockpit11Module, FactsPort, PermissionGate, Registrar, UsageUpdatedData } from "./contracts-11.ts";
import type { EventHub } from "./hub.ts";
import { errorMessage, type Logger } from "./log.ts";
import { analyserProjetsPrepares, OMO_CONTROL_SYSTEM_CLOCK, OMO_PROJETS_MAX_OCTETS, type OmoControlClock } from "./omo-control.ts";
import type { OmoActivationPort, OmoActiveRequest, OmoControlPort, OmoDetectionsPort, OmoPrecheckPort, OmoStopPort } from "./omo-contracts.ts";
import type { OmoPrecheckReferences } from "./omo-precheck-service.ts";
import { releverEmpreintesSalle, renommerSansSuivreLiens, type ReleveEmpreintes } from "./omo-precheck-reader.ts";
import type { OcGlobalEvent } from "./opencode.ts";
import type { SessionInstanceConflict, SessionTracker } from "./sessions.ts";
import { assertFact } from "./shared/activity-facts.ts";
import type { DecisionFactData, FactValue, SessionInstance } from "./shared/activity-types.ts";
import { AUTONOMY_RULES_VERSION } from "./shared/autonomy-rules.ts";
import { ID_RE } from "./shared/ids.ts";
import { OUTILS } from "./shared/omo-audit-4.19.4.ts";
import { TEXTES as TEXTES_SANS_DEMANDE } from "./shared/omo-audit-texts.ts";
import {
  detect,
  etatInitial,
  OMO_CONFIG_NOMS,
  type OmoDetection,
  type OmoDetectionInput,
  type OmoDetectionState,
  type OmoDiskElement,
  type OmoDiskSnapshot,
  type OmoPermissionRule,
  type OmoReglePermission,
} from "./shared/omo-detections.ts";
import { PRECHECK_BORNES, type PrecheckBornes } from "./shared/omo-precheck-rules.ts";
import type { OmoEventMap, OmoPreparedProjects, OmoSignale, OmoStopCause, OmoSupervisorState } from "./shared/omo-types.ts";

// --- Délais et bornes (horloge injectée, jamais lus dans l'environnement) ---------------------------------------------------------

/** Au plus un contrôle du disque toutes les 5 s après un outil terminé (fiche L23c) ; `session.idle` n'attend pas ce délai. */
export const OMO_DETECTIONS_CONTROLE_MS = 5_000;

/** Période de la veille : fin de demande, démarrage suivant, relance trop longue. */
export const OMO_DETECTIONS_VEILLE_MS = 1_000;

/** Délai laissé à la ligne `omo_rooms` d'une racine ouverte par le cockpit (écrite après la réponse de `POST /session`). */
export const OMO_DETECTIONS_RACINE_DELAI_MS = 2_000;

/** F-c : fenêtre d'une cascade de refus d'opencode après un refus inscrit du portillon, dans la même session. */
export const OMO_DETECTIONS_CASCADE_MS = 1_000;

/** Relance à neuf attendue au plus (MB-2 : 4,9 s mesurées ; 60 s « très large ») ; au-delà, la salle est de nouveau surveillée. */
export const OMO_DETECTIONS_RELANCE_MAX_MS = 60_000;

/** G13 : arrêt en 5 s au plus après le fait (§4.14.5 l.852). Les délais ci-dessus y tiennent (test). */
export const OMO_DETECTIONS_BORNE_MS = 5_000;

/** Règle de la détection 4 en service (MO-5, fiche L23c) : seul l'AJOUT d'un `allow` ou d'un `ask` compte. */
export const OMO_DETECTIONS_REGLE_PERMISSION: OmoReglePermission = "ajout-allow-ou-ask";

/**
 * Permissions que l'extension ouvre d'elle-même (`allow`) à chaque délégation, par le champ `tools` de ses envois (MO-5) : ses
 * délégations sont libres mais bornées (décision n° 7 du 19/09). Un `allow` sur toute autre permission reste une détection.
 */
export const OMO_PERMISSIONS_DELEGATION: readonly string[] = Object.freeze(["task", "call_omo_agent"]);

/** Outils de l'audit (L20) qui agissent sans demande d'autorisation, gardés ou coupés : un outil coupé vu en service l'est aussi. */
export const OMO_OUTILS_SANS_DEMANDE: readonly string[] = Object.freeze(OUTILS.filter((outil) => outil.sansDemande).map((outil) => outil.nom));

/** Code de règle d'une action de l'extension vue sans demande (`autonomy_decisions.regle`). */
export const OMO_REGLE_SANS_DEMANDE = "omo-sans-demande";

/** Entrées des mémoires du flux (sessions, messages, appels, demandes) ; au-delà, les plus anciennes sont oubliées. */
const MEMOIRE_MAX = 20_000;

/** Identifiant venu du flux de la salle : chaîne non vide, bornée (le flux n'est pas fiable). */
const IDENT_MAX = 256;

// --- Données publiées -------------------------------------------------------------------------------------------------------------

/**
 * `omo.hors-controle` : les données du contrat (T3a), fichiers signalés et mis en quarantaine TOUJOURS portés par ce service
 * (demande de contrat de L26a, lue par web/pages/omo/salle-journal.ts) ; `signalesIncomplet` : la liste n'a pas pu tout voir.
 */
export type OmoHorsControleData = Required<OmoEventMap["omo.hors-controle"]>;

/**
 * `omo.signales` : fichiers à relire en fin de demande (§4.14.5 l.850), étiqueté « omo ». `incomplet` : la descente des fichiers
 * signalés n'a pas tout vu (L19a, `signalesIncomplet`), la liste le DIT. Type repris dans `OmoEventMap` au train de V4.
 */
export type OmoSignalesData = OmoEventMap["omo.signales"];

// --- Port neutre et service ---------------------------------------------------------------------------------------------------

export function neutralOmoDetections(_deps: Cockpit11Deps): OmoDetectionsPort {
  return {};
}

/** Port du pré-contrôle en service (L19b) : `references()` n'est pas dans le contrat du port, il est lu s'il existe. */
type PortPrecheck = OmoPrecheckPort & { references?: () => OmoPrecheckReferences | null };

export interface OmoDetectionsDeps {
  /** Dossier de travail vu du cockpit (`/workspace`, monté en écriture pour la quarantaine). */
  workspace: string;
  /** `omo-projets.json` d'install.ps1 : projets préparés et `.git` protégés ; `null` ou illisible : le doute l'emporte. */
  projectsFile: string | null;
  db: DatabaseSync;
  hub: Pick<EventHub, "cockpit" | "subscribe">;
  log: Pick<Logger, "info" | "warn">;
  sessions: Pick<SessionTracker, "get" | "onInstanceConflict">;
  /** Registre des réponses émises par le portillon de la SALLE (D-2b-20) ; `null` : salle absente. */
  emises: () => PermissionGate["emitted"] | null;
  /** Ports en vigueur, relus à CHAQUE appel (jamais en copie) : une surcharge ou un port posé plus tard reste pris en compte. */
  activation: () => OmoActivationPort;
  stop: () => OmoStopPort;
  precheck: () => OmoPrecheckPort;
  control: () => OmoControlPort;
  facts: () => FactsPort;
  /** Absent : horloge réelle. */
  clock?: OmoControlClock;
  /** Bornes de production par défaut ; un test peut en passer de plus petites. */
  bornes?: Partial<PrecheckBornes>;
  /** Règle de la détection 4 ; absente : `OMO_DETECTIONS_REGLE_PERMISSION`. */
  reglePermission?: OmoReglePermission;
}

export interface OmoDetectionsService extends OmoDetectionsPort {
  /** Dérivation de la salle : appelée de façon synchrone par le processeur de la salle, jamais d'attente réseau ici. */
  onEvent(event: OcGlobalEvent, origin?: { instance: SessionInstance }): void;
  /** Abonné `usage.updated` de la salle. */
  onUsage(data: UsageUpdatedData): void;
  /**
   * Permission qu'un PATCH du cockpit va poser sur une session de la salle, annoncée AVANT l'envoi : son écho n'est pas une
   * détection (garde du module pur). Aucun module ne PATCHE la permission d'une session de la salle aujourd'hui.
   */
  annoncerPatch(sessionId: string, permission: readonly OmoPermissionRule[]): void;
  /** Attend la file des faits, les contrôles du disque et les arrêts en cours (tests, arrêt du cockpit). */
  settled(): Promise<void>;
  /** Minuteries arrêtées, abonnements retirés (tests, arrêt du cockpit). */
  fermer(): void;
}

// --- Outils ------------------------------------------------------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const ident = (value: unknown): string | null => (typeof value === "string" && value !== "" && value.length <= IDENT_MAX ? value : null);

/** Code d'une erreur système, « inconnu » sinon : c'est tout ce qu'un journal de ce module dit d'une erreur de disque. */
const codeErreur = (err: unknown): string =>
  typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "string" ? (err as { code: string }).code : "inconnu";

/** Map bornée : au-delà de la borne, l'entrée la plus ancienne est oubliée. */
class Borne<V> {
  readonly #max: number;
  readonly #map = new Map<string, V>();

  constructor(max: number) {
    this.#max = max;
  }

  get(cle: string): V | undefined {
    return this.#map.get(cle);
  }

  has(cle: string): boolean {
    return this.#map.has(cle);
  }

  set(cle: string, valeur: V): void {
    this.#map.delete(cle);
    if (this.#map.size >= this.#max) this.#map.delete(this.#map.keys().next().value as string);
    this.#map.set(cle, valeur);
  }
}

/** Horodatage de quarantaine, compact et sans caractère réservé : 20260923T101500Z. */
export function horodatageQuarantaine(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "");
}

/** Chemin relatif normalisé (séparateurs, « ./ » et « / » de fin sans effet). */
function normaliserRelatif(chemin: string): string {
  return chemin
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
}

/** Permission publiée par opencode dans `info.permission` : absente = aucune règle de session ; autre chose = gardée telle quelle. */
function permissionDe(info: Record<string, unknown> | null): unknown {
  return info === null || info.permission === undefined ? [] : info.permission;
}

/**
 * Retire les `allow` que l'extension pose sur ses délégations (`OMO_PERMISSIONS_DELEGATION`). Une liste qui n'est pas un tableau est
 * rendue telle quelle : le module pur la lit comme une modification (fermé en cas de doute).
 */
function sansDelegations(permission: unknown): unknown {
  if (!Array.isArray(permission)) return permission;
  return permission.filter(
    (regle) => !(isRecord(regle) && regle.action === "allow" && typeof regle.permission === "string" && OMO_PERMISSIONS_DELEGATION.includes(regle.permission)),
  );
}

// --- Lectures bornées, sans suivre de lien --------------------------------------------------------------------------------------

/** Au plus `max` octets d'un fichier ordinaire (O_NOFOLLOW, O_NONBLOCK) ; `null` : absent, illisible, trop gros ou pas un fichier. */
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

/** SHA-256 d'un fichier ordinaire, lu par morceaux, `null` au-delà de `max` octets ou s'il ne se lit pas (jamais à travers un lien). */
async function empreinteBornee(chemin: string, max: number): Promise<string | null> {
  let handle;
  try {
    handle = await fs.open(chemin, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    if (!(await handle.stat()).isFile()) return null;
    const hachage = crypto.createHash("sha256");
    const morceau = Buffer.allocUnsafe(64 * 1024);
    let lus = 0;
    for (;;) {
      const { bytesRead } = await handle.read(morceau, 0, morceau.length, lus);
      if (bytesRead === 0) break;
      lus += bytesRead;
      if (lus > max) return null;
      hachage.update(morceau.subarray(0, bytesRead));
    }
    return hachage.digest("hex");
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Entrées d'un dossier lues en flux et bornées ; `null` : illisible ; `tronque` : plus peuplé que la borne (un doute). */
async function lireEntrees(dossier: string, max: number): Promise<{ entrees: Dirent[]; tronque: boolean } | null> {
  const entrees: Dirent[] = [];
  try {
    const flux = await fs.opendir(dossier);
    for await (const entree of flux) {
      if (entrees.length >= max) return { entrees, tronque: true };
      entrees.push(entree);
    }
  } catch {
    return null;
  }
  return { entrees, tronque: false };
}

/** Vrai si chaque composant de `relatif` sous `racine` est un dossier ordinaire (aucun lien n'est suivi pour l'atteindre). */
async function atteintSansLien(racine: string, relatif: string): Promise<boolean> {
  let courant = racine;
  for (const segment of relatif === "" ? [] : relatif.split("/")) {
    courant = path.join(courant, segment);
    try {
      const info = await fs.lstat(courant);
      if (info.isSymbolicLink() || !info.isDirectory()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

// --- Configuration à la racine des dossiers contrôlés (détection 6) --------------------------------------------------------------

/** Premier segment de chaque nom de configuration, casse ignorée (`.omo` pour `.omo/omo.json`). */
const PREMIERS_CONFIG: ReadonlySet<string> = new Set(OMO_CONFIG_NOMS.map((nom) => (nom.split("/")[0] ?? "").toLowerCase()));
/** Noms de configuration DANS `.omo`, casse ignorée. */
const DANS_OMO: ReadonlySet<string> = new Set(OMO_CONFIG_NOMS.filter((nom) => nom.includes("/")).map((nom) => (nom.split("/")[1] ?? "").toLowerCase()));

interface Releve {
  elements: Map<string, OmoDiskElement>;
  doute: boolean;
}

/** Élément d'une entrée : un lien n'est jamais suivi, un dossier compte par sa présence, un fichier par son empreinte bornée. */
async function elementDe(chemin: string, entree: Dirent, bornes: Readonly<PrecheckBornes>): Promise<OmoDiskElement> {
  if (entree.isSymbolicLink()) return { forme: "lien", empreinte: null };
  if (entree.isDirectory()) return { forme: "dossier", empreinte: null };
  if (entree.isFile()) return { forme: "fichier", empreinte: await empreinteBornee(chemin, bornes.empreinteTailleMaxOctets) };
  return { forme: "autre", empreinte: null };
}

/**
 * Noms de configuration (liste du pré-contrôle, dont `.agents/`, D-2b-34) présents à la racine de chaque dossier contrôlé, casse
 * ignorée. Un dossier de configuration compte par sa présence ; `.omo` n'est ouvert que pour `omo.json[c]`, et un `.omo` lien vaut
 * ces deux noms atteints par un lien (rien n'est suivi). Dossier illisible, trop peuplé ou atteint par un lien : doute.
 */
async function releverConfigs(racine: string, dossiers: readonly string[], bornes: Readonly<PrecheckBornes>): Promise<Releve> {
  const elements = new Map<string, OmoDiskElement>();
  let doute = false;
  for (const dossier of dossiers) {
    const prefixe = dossier === "" ? "" : `${dossier}/`;
    const absolu = dossier === "" ? racine : path.join(racine, dossier);
    if (!(await atteintSansLien(racine, dossier))) {
      doute = true;
      continue;
    }
    const lecture = await lireEntrees(absolu, bornes.entreesMaxParDossier);
    if (lecture === null || lecture.tronque) doute = true;
    for (const entree of lecture?.entrees ?? []) {
      const bas = entree.name.toLowerCase();
      if (!PREMIERS_CONFIG.has(bas)) continue;
      if (bas !== ".omo") {
        elements.set(`${prefixe}${entree.name}`, await elementDe(path.join(absolu, entree.name), entree, bornes));
        continue;
      }
      if (entree.isSymbolicLink()) {
        for (const nom of DANS_OMO) elements.set(`${prefixe}${entree.name}/${nom}`, { forme: "lien", empreinte: null });
        continue;
      }
      if (!entree.isDirectory()) continue;
      const omo = await lireEntrees(path.join(absolu, entree.name), bornes.entreesMaxParDossier);
      if (omo === null || omo.tronque) doute = true;
      for (const dedans of omo?.entrees ?? []) {
        if (!DANS_OMO.has(dedans.name.toLowerCase())) continue;
        elements.set(`${prefixe}${entree.name}/${dedans.name}`, await elementDe(path.join(absolu, entree.name, dedans.name), dedans, bornes));
      }
    }
  }
  return { elements, doute };
}

// --- `.git` du dossier de travail (détection 6, décision A16) ---------------------------------------------------------------------

/**
 * `.git` du dossier de travail, CASSE IGNORÉE (`.GIT` est un dépôt pour le git d'un poste Windows), de toute forme (dossier, fichier
 * `gitdir:`, lien). Aucun lien suivi, `node_modules` et l'intérieur des `.git` sautés, profondeur et entrées bornées ; dossier
 * illisible ou trop peuplé : `limiteAtteinte` (fermé en cas de doute). `node_modules` est sauté comme par le balayage du
 * superviseur (D-2b-28) : ses `.git` ne sont pas des dépôts du poste, et ses dizaines de milliers d'entrées feraient atteindre la
 * borne, donc arrêter la salle à chaque contrôle. Un dépôt nu n'est pas cherché ici : l'activation (L22c) et le démarrage suivant
 * (L19b, superviseur) le refusent.
 */
async function releverGits(racine: string, bornes: Readonly<PrecheckBornes>): Promise<{ gits: string[]; limiteAtteinte: boolean }> {
  const gits: string[] = [];
  let lues = 0;
  const pile: { relatif: string; profondeur: number }[] = [{ relatif: "", profondeur: 0 }];
  while (pile.length > 0) {
    const { relatif, profondeur } = pile.pop() ?? { relatif: "", profondeur: 0 };
    if (profondeur > bornes.profondeurMax) return { gits, limiteAtteinte: true };
    const lecture = await lireEntrees(relatif === "" ? racine : path.join(racine, relatif), bornes.entreesMaxParDossier);
    if (lecture === null || lecture.tronque) return { gits, limiteAtteinte: true };
    for (const entree of lecture.entrees) {
      lues++;
      if (lues > bornes.balayageGitEntreesMax) return { gits, limiteAtteinte: true };
      const chemin = relatif === "" ? entree.name : `${relatif}/${entree.name}`;
      const bas = entree.name.toLowerCase();
      if (bas === ".git") {
        gits.push(chemin);
        continue;
      }
      if (entree.isSymbolicLink() || !entree.isDirectory() || bas === "node_modules") continue;
      pile.push({ relatif: chemin, profondeur: profondeur + 1 });
    }
  }
  return { gits, limiteAtteinte: false };
}

/**
 * Chemins couverts par `gitProteges` (le dépôt et son `.git`), en minuscules : un `.git` protégé n'est jamais « créé », et jamais
 * renommé. La casse est ignorée des DEUX côtés : `Outils/MonDepot/.git`, listé tel quel par install.ps1 et relevé en minuscules,
 * reste l'historique de l'utilisateur.
 */
function couvertsParProtection(gitProteges: readonly { chemin: string }[]): Set<string> {
  const couverts = new Set<string>();
  for (const entree of gitProteges) {
    const chemin = normaliserRelatif(entree.chemin).toLowerCase();
    if (chemin === "") continue;
    couverts.add(chemin);
    couverts.add(`${chemin}/.git`);
  }
  return couverts;
}

// --- Instantané du disque pour le module pur ----------------------------------------------------------------------------------------

interface Fusion {
  dossiers: Set<string>;
  elements: Map<string, OmoDiskElement>;
  dynamiques: Set<string>;
  incomplet: boolean;
}

/**
 * Ajoute un élément ; un chemin commun à deux relevés (dossier de premier niveau et projet préparé qu'il contient, fichiers signalés
 * relevés à toute profondeur) est FUSIONNÉ : une seule entrée, la première lecture. Une lecture qui diffère voit un fichier en train
 * de changer ; le contrôle suivant, comparé aux mêmes références, le verra changé.
 */
function ajouter(fusion: Fusion, chemin: string, element: OmoDiskElement): void {
  if (!fusion.elements.has(chemin)) fusion.elements.set(chemin, element);
}

/**
 * Instantané construit depuis les relevés de L19a : chaque chemin préfixé par la racine de son relevé ; `ideCiDynamiques` préfixés
 * (hooks hors de `.git`, relecture 2 bis-vague-0) ; forme de chaque `.git` relevé ; un relevé impossible rend l'instantané
 * incomplet. `signalesIncomplet` n'y entre pas : il ne fait que dire la liste « à relire » incomplète. Un lien ou un chemin illisible
 * qui est la racine même du relevé (« . ») donne un chemin invalide : le module pur le lit comme un doute.
 */
function fusionner(releves: readonly ReleveEmpreintes[]): Fusion {
  const fusion: Fusion = { dossiers: new Set(), elements: new Map(), dynamiques: new Set(), incomplet: false };
  for (const releve of releves) {
    const racine = normaliserRelatif(releve.racine);
    const prefixe = racine === "" ? "" : `${racine}/`;
    fusion.dossiers.add(racine);
    if (releve.impossible) fusion.incomplet = true;
    for (const fichier of releve.fichiers) ajouter(fusion, `${prefixe}${fichier.chemin}`, { forme: "fichier", empreinte: fichier.sha256 });
    for (const lien of releve.liens) ajouter(fusion, `${prefixe}${lien}`, { forme: "lien", empreinte: null });
    for (const illisible of releve.illisibles) ajouter(fusion, `${prefixe}${illisible}`, { forme: "fichier", empreinte: null });
    if (releve.git !== "absent") ajouter(fusion, `${prefixe}.git`, { forme: releve.git, empreinte: null });
    for (const cible of releve.ideCiDynamiques) fusion.dynamiques.add(`${prefixe}${cible}`);
  }
  return fusion;
}

function instantane(fusion: Fusion, supplements: ReadonlyMap<string, OmoDiskElement>, doute: boolean): OmoDiskSnapshot {
  for (const [chemin, element] of supplements) {
    if (!fusion.elements.has(chemin)) fusion.elements.set(chemin, element);
  }
  return { dossiers: [...fusion.dossiers], elements: fusion.elements, incomplet: fusion.incomplet || doute, ideCiDynamiques: [...fusion.dynamiques] };
}

// --- Service --------------------------------------------------------------------------------------------------------------------

type RaisonArret = "detection" | "fin-de-demande" | "redemarrage-cockpit";

interface Controleur {
  enCours: Promise<void> | null;
  immediat: boolean;
  differe: boolean;
  /** Début du dernier contrôle (horloge injectée) : un outil terminé n'en relance pas un autre avant 5 s. */
  dernierDebut: number;
  minuterie: unknown;
}

/** Surveillance d'UN démarrage de la salle : de ses références (L19b) jusqu'au démarrage suivant. */
interface Periode {
  startId: string;
  references: OmoPrecheckReferences;
  /** Projets préparés d'omo-projets.json, et `.git` protégés ; `null` : liste illisible, tout `.git` trouvé est un doute. */
  prepares: string[];
  gitProteges: readonly { chemin: string }[] | null;
  /** Configuration relevée à l'armement dans les dossiers qui ne sont ni un projet préparé, ni l'un de ses parents. */
  configsAvant: Map<string, OmoDiskElement>;
  configsDoute: boolean;
  etat: OmoDetectionState;
  demande: OmoActiveRequest | null;
  /** Racine de la dernière demande vue : un contrôle de fin de demande s'y rapporte encore. */
  derniereRacine: string | null;
  /** Arrêt ou relance demandés par le cockpit : aucun fait du flux n'est transmis au module pur. */
  arret: { depuis: number; raison: RaisonArret } | null;
  /** Ce service a déjà arrêté la salle pour ce démarrage : une seule détection agit. */
  stoppee: boolean;
  signales: Map<string, OmoSignale>;
  signalesIncomplet: boolean;
  controle: Controleur;
}

export function createOmoDetectionsService(deps: OmoDetectionsDeps): OmoDetectionsService {
  const { log } = deps;
  const clock = deps.clock ?? OMO_CONTROL_SYSTEM_CLOCK;
  const bornes: Readonly<PrecheckBornes> = Object.freeze({ ...PRECHECK_BORNES, ...deps.bornes });
  const reglePermission = deps.reglePermission ?? OMO_DETECTIONS_REGLE_PERMISSION;
  /** Création du service : un démarrage commencé avant lui a été trouvé lancé au redémarrage du cockpit (D-2b-29, L23b). */
  const creeLe = clock.now();

  let periode: Periode | null = null;
  let ferme = false;

  // Mémoires du flux, communes aux démarrages : les sessions de la salle survivent à une relance à neuf (opencode.db est gardé).
  const sessionsVues = new Borne<{ rootId: string | null; permission: unknown }>(MEMOIRE_MAX);
  const messagesVus = new Borne<true>(MEMOIRE_MAX);
  const appelsDemandes = new Borne<true>(MEMOIRE_MAX);
  const appelsTermines = new Borne<true>(MEMOIRE_MAX);
  const refusInscrits = new Borne<number>(MEMOIRE_MAX);

  // --- File des faits : un à la fois, dans l'ordre du flux ; une erreur n'arrête ni la file, ni le processeur -------------------------

  let file: Promise<void> = Promise.resolve();
  const enVol = new Set<Promise<unknown>>();
  const suivre = <T>(promesse: Promise<T>): Promise<T> => {
    enVol.add(promesse);
    void promesse.finally(() => enVol.delete(promesse)).catch(() => undefined);
    return promesse;
  };
  const enFile = (tache: () => Promise<void> | void): void => {
    file = file.then(tache).catch((err: unknown) => log.warn("salle : fait non traité par les détections", { error: errorMessage(err) }));
  };

  const minuteries = new Set<unknown>();
  const plusTard = (fn: () => void, ms: number): void => {
    const poignee = clock.setTimer(() => {
      minuteries.delete(poignee);
      if (!ferme) fn();
    }, ms);
    minuteries.add(poignee);
  };

  /** Attentes en cours (relance attendue avant une quarantaine) : `fermer` les réveille toutes, jamais une promesse pendue. */
  const reveils = new Set<() => void>();
  const dormir = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      let poignee: unknown = null;
      const reveil = (): void => {
        if (!reveils.delete(reveil)) return;
        if (poignee !== null) clock.clearTimer(poignee);
        resolve();
      };
      reveils.add(reveil);
      poignee = clock.setTimer(reveil, ms);
    });

  // --- Lectures des ports, fermées en cas de doute ---------------------------------------------------------------------------------

  const lireDemande = (): OmoActiveRequest | null => {
    try {
      const demande = deps.activation().activeRequest();
      return demande !== null && typeof demande === "object" && ident(demande.rootId) !== null ? demande : null;
    } catch (err) {
      log.warn("salle : demande active illisible", { error: errorMessage(err) });
      return null;
    }
  };

  const lireReferences = (): OmoPrecheckReferences | null => {
    try {
      const port = deps.precheck() as PortPrecheck;
      if (typeof port.references !== "function") return null;
      const references = port.references();
      return references !== null && typeof references === "object" && typeof references.startId === "string" && Array.isArray(references.releves)
        ? references
        : null;
    } catch (err) {
      log.warn("salle : références du démarrage illisibles", { error: errorMessage(err) });
      return null;
    }
  };

  const estRacineSalle = (rootId: string): boolean => {
    try {
      return deps.db.prepare("SELECT 1 FROM omo_rooms WHERE root_id = ?").get(rootId) !== undefined;
    } catch (err) {
      log.warn("salle : racines ouvertes illisibles", { error: errorMessage(err) });
      return false;
    }
  };

  const racineDe = (sessionId: string | null): string | null => {
    if (sessionId === null) return null;
    const vue = sessionsVues.get(sessionId);
    if (vue !== undefined) return vue.rootId;
    try {
      const ligne = deps.sessions.get(sessionId);
      // Une session suivie par l'instance principale n'a pas de racine dans la salle (P11).
      if (ligne !== undefined) return ligne.instance === "omo" ? ligne.root_id : null;
    } catch {
      return null;
    }
    // Racine ouverte par le cockpit dont aucun événement n'a encore été vu : elle est sa propre racine.
    return estRacineSalle(sessionId) ? sessionId : null;
  };

  // --- Armement : un démarrage accepté par L19b ---------------------------------------------------------------------------------------

  const lireProjets = async (): Promise<OmoPreparedProjects | null> => {
    if (deps.projectsFile === null) return null;
    return analyserProjetsPrepares(await lireBorne(deps.projectsFile, OMO_PROJETS_MAX_OCTETS));
  };

  const armer = async (references: OmoPrecheckReferences): Promise<Periode> => {
    const liste = await lireProjets();
    if (liste === null) log.warn("salle : liste des projets préparés illisible, tout .git trouvé sera un doute");
    const prepares = [...new Set((liste?.projets ?? []).map((projet) => normaliserRelatif(projet.chemin)))];
    // Référence « aucune configuration » : chaque projet préparé, chacun de ses parents et /workspace (pré-contrôle, D-2b-35).
    const sansConfig = new Set<string>([""]);
    for (const projet of prepares) {
      const segments = projet.split("/");
      for (let i = 1; i <= segments.length; i++) sansConfig.add(segments.slice(0, i).join("/"));
    }
    const autres = references.releves.map((releve) => normaliserRelatif(releve.racine)).filter((dossier) => !sansConfig.has(dossier));
    let configs: Releve = { elements: new Map(), doute: false };
    try {
      configs = await releverConfigs(await fs.realpath(deps.workspace), autres, bornes);
    } catch (err) {
      configs = { elements: new Map(), doute: true };
      log.warn("salle : configuration de référence non relevée", { code: codeErreur(err) });
    }
    let herite = false;
    try {
      const etat = await deps.control().readState();
      herite = etat !== null && etat.startId === references.startId && typeof etat.startedAt === "number" && etat.startedAt < creeLe;
    } catch {
      herite = false;
    }
    if (herite) log.info("salle : démarrage lancé avant le cockpit, laissé à son arrêt (redémarrage du cockpit)");
    return {
      startId: references.startId,
      references,
      prepares,
      gitProteges: liste?.gitProteges ?? null,
      configsAvant: configs.elements,
      configsDoute: configs.doute,
      etat: etatInitial(),
      demande: null,
      derniereRacine: null,
      arret: herite ? { depuis: clock.now(), raison: "redemarrage-cockpit" } : null,
      stoppee: false,
      signales: new Map(),
      signalesIncomplet: references.releves.some((releve) => releve.signalesIncomplet === true),
      controle: { enCours: null, immediat: false, differe: false, dernierDebut: Number.NEGATIVE_INFINITY, minuterie: null },
    };
  };

  /**
   * Met la surveillance à jour avant chaque fait : démarrage suivant (nouvel état pur), relance trop longue, demande commencée ou
   * finie. Rend la période en vigueur, `null` tant qu'aucun démarrage n'est accepté (L19b n'a écrit aucun `precheck-ok`).
   */
  const synchroniser = async (demande: OmoActiveRequest | null): Promise<Periode | null> => {
    const references = lireReferences();
    if (references === null) {
      if (periode !== null) abandonner(periode);
      periode = null;
      return null;
    }
    if (periode === null || periode.startId !== references.startId) {
      if (periode !== null) abandonner(periode);
      periode = await armer(references);
    }
    const p = periode;
    if (p.arret !== null) {
      if (clock.now() - p.arret.depuis <= OMO_DETECTIONS_RELANCE_MAX_MS) return p;
      // La relance attendue n'est pas venue : la salle est de nouveau surveillée, sans demande, plutôt qu'oubliée.
      log.warn("salle : relance à neuf non vue, surveillance reprise", { raison: p.arret.raison });
      p.arret = null;
      p.stoppee = false;
      p.demande = null;
    }
    if (p.demande !== null && (demande === null || demande.requestId !== p.demande.requestId)) {
      finDeDemande(p, p.demande);
      return p;
    }
    if (demande !== null && p.demande === null) {
      p.demande = demande;
      p.derniereRacine = demande.rootId;
    }
    return p;
  };

  const abandonner = (p: Periode): void => {
    if (p.controle.minuterie !== null) clock.clearTimer(p.controle.minuterie);
    p.controle.minuterie = null;
  };

  // --- Application d'un fait au module pur -------------------------------------------------------------------------------------------

  const appliquer = (p: Periode, entree: OmoDetectionInput): void => {
    const resultat = detect(p.etat, entree, { reglePermission });
    p.etat = resultat.etat;
    if (resultat.detection !== null) void suivre(agir(p, resultat.detection, resultat.quarantaine));
  };

  const permissionModifiee = (p: Periode, sessionId: string, rootId: string | null, avant: unknown, apres: unknown): void => {
    appliquer(p, {
      type: "session.updated",
      sessionId,
      rootId,
      permissionAvant: sansDelegations(avant) as OmoPermissionRule[],
      permissionApres: sansDelegations(apres) as OmoPermissionRule[],
    });
  };

  /** Racine sans parent : ouverte par le cockpit si `omo_rooms` la connaît, relue après le délai sinon. */
  const racineCreee = (p: Periode, sessionId: string, demande: OmoActiveRequest | null): void => {
    const entree = (ouverte: boolean): OmoDetectionInput => ({
      type: "session.created",
      sessionId,
      parentID: null,
      rootId: sessionId,
      racineOuverteParLeCockpit: ouverte,
      demandeActive: demande?.rootId ?? null,
    });
    if (estRacineSalle(sessionId)) {
      appliquer(p, entree(true));
      return;
    }
    plusTard(
      () =>
        enFile(() => {
          if (p !== periode || p.arret !== null) return;
          appliquer(p, entree(estRacineSalle(sessionId)));
        }),
      OMO_DETECTIONS_RACINE_DELAI_MS,
    );
  };

  const traiterEvenement = (p: Periode, type: string, props: Record<string, unknown>, demande: OmoActiveRequest | null, recu: number): void => {
    const demandeActive = demande?.rootId ?? null;
    switch (type) {
      case "session.created":
      case "session.updated": {
        const info = isRecord(props.info) ? props.info : null;
        const sessionId = ident(info?.id) ?? ident(props.sessionID);
        if (sessionId === null) return;
        const parentID = ident(info?.parentID);
        const connue = sessionsVues.get(sessionId);
        const rootId = connue?.rootId ?? (parentID === null ? sessionId : racineDe(parentID));
        const permission = permissionDe(info);
        sessionsVues.set(sessionId, { rootId, permission });
        if (type === "session.created") {
          if (parentID === null) racineCreee(p, sessionId, demande);
          else appliquer(p, { type: "session.created", sessionId, parentID, rootId, racineOuverteParLeCockpit: false, demandeActive });
          // Une session CRÉÉE avec des règles a une permission posée sans le cockpit (le cockpit n'en pose aucune dans la salle).
          if (!(Array.isArray(permission) && permission.length === 0)) permissionModifiee(p, sessionId, rootId, [], permission);
          return;
        }
        // Session jamais vue (événement manqué) : aucune règle de référence, la plus stricte.
        permissionModifiee(p, sessionId, rootId, connue?.permission ?? [], permission);
        return;
      }
      case "message.updated": {
        const info = isRecord(props.info) ? props.info : null;
        const messageId = ident(info?.id);
        const sessionId = ident(info?.sessionID) ?? ident(props.sessionID);
        if (messageId === null || sessionId === null || messagesVus.has(messageId)) return;
        messagesVus.set(messageId, true);
        const rootId = racineDe(sessionId);
        // Origine inconnue : jugée sur le fait `origine` de L4b (plus bas) ; ici, seulement l'activité d'un message nouveau.
        appliquer(p, { type: "message", sessionId, rootId, racine: rootId === sessionId, origine: null, demandeActive });
        return;
      }
      case "message.part.updated": {
        const part = isRecord(props.part) ? props.part : null;
        const sessionId = ident(part?.sessionID) ?? ident(props.sessionID);
        if (part === null || sessionId === null) return;
        if (part.type === "step-finish") {
          appliquer(p, { type: "progres", rootId: racineDe(sessionId) });
          return;
        }
        const etat = isRecord(part.state) ? part.state : null;
        const callId = ident(part.callID);
        if (part.type !== "tool" || callId === null || (etat?.status !== "completed" && etat?.status !== "error")) return;
        if (appelsTermines.has(callId)) return;
        appelsTermines.set(callId, true);
        demanderControle(p, false);
        const outil = typeof part.tool === "string" ? part.tool : "";
        if (OMO_OUTILS_SANS_DEMANDE.includes(outil) && !appelsDemandes.has(callId)) {
          journaliserSansDemande({ rootId: racineDe(sessionId), sessionId, callId, outil, requestId: demande?.requestId ?? null, at: recu });
        }
        return;
      }
      case "permission.asked": {
        const outil = isRecord(props.tool) ? props.tool : null;
        const callId = ident(outil?.callID);
        if (callId !== null) appelsDemandes.set(callId, true);
        return;
      }
      case "permission.replied": {
        const requestId = ident(props.requestID);
        const sessionId = ident(props.sessionID);
        const reponse = props.reply;
        const registre = deps.emises();
        let emise = requestId !== null && registre !== null && registre.has(requestId);
        if (emise && reponse === "reject" && sessionId !== null) refusInscrits.set(sessionId, recu);
        const cascade = sessionId === null ? undefined : refusInscrits.get(sessionId);
        // F-c : les autres demandes de la session, refusées d'office avec un refus du portillon, sans passer par lui.
        if (!emise && reponse === "reject" && cascade !== undefined && recu - cascade <= OMO_DETECTIONS_CASCADE_MS) emise = true;
        appliquer(p, { type: "permission.replied", sessionId: sessionId ?? "", rootId: racineDe(sessionId), emisParPortillon: emise });
        return;
      }
      case "session.status": {
        const sessionId = ident(props.sessionID);
        const statut = isRecord(props.status) ? props.status : null;
        // Statut inconnu : une activité (module pur, « fermé en cas de doute »).
        let genre: "busy" | "idle" | "retry" = "busy";
        if (statut?.type === "idle" || statut?.type === "retry") genre = statut.type;
        const tentative = genre === "retry" && typeof statut?.attempt === "number" ? statut.attempt : null;
        appliquer(p, { type: "session.status", sessionId: sessionId ?? "", rootId: racineDe(sessionId), statut: genre, tentative, demandeActive });
        return;
      }
      case "session.idle":
        demanderControle(p, true);
        return;
      case "global.disposed":
      case "server.instance.disposed":
        // Le cockpit ne recharge jamais la salle : il l'arrête par stop-request (§3.12.1), et cette fenêtre-là n'arrive pas ici.
        appliquer(p, { type: "dispose", evenement: type === "global.disposed" ? "global.disposed" : "server.instance.disposed", demandeParLeCockpit: false });
        return;
      default:
        return;
    }
  };

  // --- Agir : quarantaine, publication, journal, arrêt ----------------------------------------------------------------------------

  const racineConcernee = (p: Periode, detection: OmoDetection): string | null => {
    const candidate = ident(detection.detail.rootId);
    if (candidate !== null && estRacineSalle(candidate)) return candidate;
    return p.demande?.rootId ?? p.derniereRacine ?? null;
  };

  /** Fichiers signalés du démarrage, triés par chemin puis par genre (ordre des unités UTF-16, sans langue). */
  const signalesDe = (p: Periode): OmoSignale[] => {
    const cle = (s: OmoSignale) => `${s.chemin}\u0000${s.genre}`;
    return [...p.signales.values()].sort((a, b) => {
      if (cle(a) === cle(b)) return 0;
      return cle(a) < cle(b) ? -1 : 1;
    });
  };

  const noterSignale = (p: Periode, signale: OmoSignale): void => {
    p.signales.set(`${signale.genre}:${signale.chemin}`, signale);
  };

  /**
   * D-2b-37 : chaque `.git` créé est renommé, jamais supprimé, jamais à travers un lien, jamais s'il est protégé — et jamais tant que
   * la salle peut écrire (`salleRelancee` faux : relance non vue, voir `attendreRelance`) : le chemin reste alors « à relire ».
   */
  const mettreEnQuarantaine = async (p: Periode, chemins: readonly string[], salleRelancee: boolean): Promise<number> => {
    const couverts = couvertsParProtection(p.gitProteges ?? []);
    let renommes = 0;
    for (const chemin of chemins) {
      const nom = path.posix.basename(chemin);
      if (couverts.has(normaliserRelatif(chemin).toLowerCase())) {
        // Listé par install.ps1 : peut-être l'historique de l'utilisateur. Jamais renommé ; à relire, jamais dit « mis de côté ».
        noterSignale(p, { chemin, genre: "ide-ci" });
        log.warn("salle : .git protégé jamais mis de côté", { chemin });
        continue;
      }
      if (!salleRelancee) {
        // Renommer par chemin pendant que la salle peut écrire, c'est la laisser détourner le renommage par un lien (constat L23c).
        noterSignale(p, { chemin, genre: "ide-ci" });
        log.warn("salle : historique git créé NON mis de côté", { chemin, raison: "salle-non-relancee" });
        continue;
      }
      const resultat = await renommerSansSuivreLiens(deps.workspace, chemin, `${nom}.suspect-${horodatageQuarantaine(clock.now())}`);
      if (resultat.ok) {
        const parent = path.posix.dirname(chemin);
        noterSignale(p, { chemin: parent === "." ? resultat.nom : `${parent}/${resultat.nom}`, genre: "git-quarantaine" });
        renommes++;
        log.info("salle : historique git créé mis de côté", { chemin, nom: resultat.nom });
      } else {
        // Rien n'est renommé (lien, collision, erreur) : le chemin reste « à relire », jamais dit « mis de côté » (P3).
        noterSignale(p, { chemin, genre: "ide-ci" });
        log.warn("salle : historique git créé NON mis de côté", { chemin, raison: resultat.raison });
      }
    }
    return renommes;
  };

  /**
   * Fait `detection` d'un arrêt de la salle : `cas: "hors-controle"` (D-2b-41), union de `DetectionFactData` (activity-types.ts)
   * élargie au train de V4 (demande de contrat de ce paquet). Aucun lecteur ne discrimine sur `cas` aujourd'hui (le réducteur
   * d'activité ne lit pas ce fait, la page de la salle lit `omo.hors-controle`). L'arrêt lui-même s'écrit en fait
   * `statut {cause: hors-controle}`, par `stopTreeOmo` (L23b).
   */
  const ecrireFaitDetection = (rootId: string | null, sessionId: string | null, data: Record<string, FactValue>): void => {
    const session = sessionId !== null && ID_RE.test(sessionId) ? sessionId : rootId;
    if (rootId === null || !ID_RE.test(rootId) || session === null) return;
    try {
      deps.facts().append([assertFact({ rootId, sessionId: session, kind: "detection", ref: null, data, at: clock.now() })]);
    } catch (err) {
      log.warn("salle : fait « detection » non écrit", { rootId, error: errorMessage(err) });
    }
  };

  /** Ce qui s'est passé : événement `omo.hors-controle`, fait `detection`, journal « hors-contrôle ». */
  const publierDetection = (p: Periode, detection: OmoDetection, rootId: string | null, renommes: number, nonRenommes: number): void => {
    const signales = signalesDe(p);
    const donnees: OmoHorsControleData = { rootId, cause: detection.cause, signales, signalesIncomplet: p.signalesIncomplet };
    deps.hub.cockpit("omo.hors-controle", donnees, "omo");
    ecrireFaitDetection(rootId, detection.detail.sessionId, {
      cas: "hors-controle",
      cause: detection.cause,
      quarantaine: renommes,
      signales: signales.length,
      incomplet: p.signalesIncomplet,
    });
    log.warn("salle : hors-contrôle, détection après coup", {
      cause: detection.cause,
      rootId,
      sessionId: detection.detail.sessionId,
      chemins: detection.detail.chemins.length,
      quarantaine: renommes,
      nonRenommes,
    });
  };

  /** L'arrêt (L23b) ; un échec est journalisé, jamais avalé en silence. */
  const arreter = async (rootId: string | null, cause: OmoStopCause): Promise<void> => {
    try {
      await deps.stop().run(rootId, cause);
    } catch (err) {
      log.warn("salle : arrêt après une détection en échec", { cause, error: errorMessage(err) });
    }
  };

  /**
   * Relecture 2ter-vague-4, second tour : la salle a-t-elle été vue ARRÊTÉE puis RELANCÉE ? `state.json` est relu toutes les
   * `OMO_DETECTIONS_VEILLE_MS`, `OMO_DETECTIONS_RELANCE_MAX_MS` au plus après la fin de l'arrêt. Seul un démarrage SUIVANT (un autre
   * `startId`) le prouve : Docker ne relance le conteneur qu'une fois sorti celui qui a porté la demande, et tout ce que l'IA y avait
   * lancé, programmes détachés compris, est tombé avec lui. La sonde de L23b n'en dit pas autant (un `/global/health` muet ne dit que
   * la fin d'opencode), ni la phase « arret », publiée juste AVANT la sortie du superviseur. Ce démarrage ne doit pas avoir lancé
   * opencode : son superviseur a balayé le dossier de travail avant tout renommage, il y a vu le `.git` et n'est donc jamais prêt
   * (second verrou) ; une phase « opencode-lance » dit le contraire, et le doute l'emporte. Rend l'état de ce démarrage, `null` sinon.
   */
  const attendreRelance = async (p: Periode): Promise<OmoSupervisorState | null> => {
    const echeance = clock.now() + OMO_DETECTIONS_RELANCE_MAX_MS;
    for (;;) {
      if (ferme) return null;
      let etat: OmoSupervisorState | null = null;
      try {
        etat = await deps.control().readState();
      } catch (err) {
        log.warn("salle : état du superviseur illisible pendant l'attente de la relance", { error: errorMessage(err) });
      }
      if (etat !== null && etat.startId !== p.startId) {
        if (etat.phase !== "opencode-lance") return etat;
        log.warn("salle : opencode déjà relancé, aucun historique git mis de côté");
        return null;
      }
      if (clock.now() >= echeance) {
        log.warn("salle : relance à neuf non vue après l'arrêt, aucun historique git mis de côté", { attenteMs: OMO_DETECTIONS_RELANCE_MAX_MS });
        return null;
      }
      await dormir(OMO_DETECTIONS_VEILLE_MS);
    }
  };

  /**
   * Après la quarantaine : le démarrage relancé a été balayé AVANT le renommage, par son superviseur (qui ne sera donc jamais prêt)
   * et par L19b (qui l'a refusé et n'y revient jamais). Un stop-request de CE démarrage (omoControl y met le `startId` de l'état lu)
   * fait sortir son superviseur : la relance suivante voit les dossiers renommés. Un échec est journalisé ; la salle reste alors en
   * attente, et son état dit pourquoi (L26a).
   */
  const relancerApresQuarantaine = async (renommes: number): Promise<void> => {
    try {
      await deps.control().requestStop("hors-controle");
      log.info("salle : relance à neuf demandée après la mise de côté", { renommes });
    } catch (err) {
      log.warn("salle : relance à neuf non demandée après la mise de côté", { error: errorMessage(err) });
    }
  };

  /**
   * Une détection agit une fois par démarrage : un contrôle du disque déjà en cours quand un fait du flux arrête la salle ne
   * demande pas un second arrêt. Elle agit même si la salle a été relancée entre-temps (contrôle de fin de demande plus lent que la
   * relance) : les fichiers écrits pendant ce démarrage sont dans les références du suivant, qui ne les verra pas.
   *
   * Sans `.git` à mettre de côté : ce qui s'est passé part AVANT l'arrêt, qui ne reçoit pas la cause (« hors-controle »). Avec :
   * l'arrêt d'abord, la relance vue, la quarantaine, puis ce qui s'est passé, avec le résultat réel du renommage (relecture
   * 2ter-vague-4, second tour : jamais de renommage pendant que la salle peut écrire).
   */
  const agir = async (p: Periode, detection: OmoDetection, quarantaine: readonly string[]): Promise<void> => {
    if (p.stoppee) return;
    p.stoppee = true;
    p.arret ??= { depuis: clock.now(), raison: "detection" };
    const rootId = racineConcernee(p, detection);
    p.demande = null;
    const cause: OmoStopCause = detection.cause === "tentatives-429" ? "plafond-tentatives" : "hors-controle";
    if (quarantaine.length === 0) {
      publierDetection(p, detection, rootId, 0, 0);
      await arreter(rootId, cause);
      return;
    }
    log.warn("salle : historique git créé, arrêt de la salle avant de le mettre de côté", { rootId, chemins: quarantaine.length });
    await arreter(rootId, cause);
    // La relance à neuf s'attend à partir de la FIN de l'arrêt (abandon et sonde : jusqu'à 35 s) ; la veille compte de même.
    if (p.arret !== null) p.arret = { ...p.arret, depuis: clock.now() };
    const relance = await attendreRelance(p);
    const renommes = await mettreEnQuarantaine(p, quarantaine, relance !== null);
    if (renommes > 0) await relancerApresQuarantaine(renommes);
    publierDetection(p, detection, rootId, renommes, quarantaine.length - renommes);
  };

  // --- Actions de l'extension vues sans demande (§4.12 l.784) -----------------------------------------------------------------------

  const journaliserSansDemande = (input: { rootId: string | null; sessionId: string; callId: string; outil: string; requestId: string | null; at: number }): void => {
    const { rootId, sessionId, callId, outil, at } = input;
    if (rootId === null || !ID_RE.test(rootId) || !ID_RE.test(sessionId)) {
      log.warn("salle : action sans demande non journalisée (conversation inconnue)", { outil });
      return;
    }
    const libelles: Readonly<Record<string, string>> = TEXTES_SANS_DEMANDE.avance.sansDemande;
    const raison = libelles[outil] ?? OUTILS.find((entree) => entree.nom === outil)?.motif ?? "";
    try {
      deps.db
        .prepare(
          `INSERT INTO autonomy_decisions (request_id, root_id, session_id, permission_id, permission, resume, choix, regle,
             rules_version, verdict, par, raison, ia_model, ia_cost, ia_ms, relais, asked_at, decided_at)
           VALUES (?, ?, ?, NULL, ?, ?, 'omo', ?, ?, 'non-controle', 'extension', ?, NULL, NULL, NULL, NULL, ?, ?)`,
        )
        .run(input.requestId, rootId, sessionId, outil, outil, OMO_REGLE_SANS_DEMANDE, AUTONOMY_RULES_VERSION, raison, at, at);
    } catch (err) {
      log.warn("salle : action sans demande non journalisée", { outil, error: errorMessage(err) });
      return;
    }
    // `par: "extension"` dans le fait aussi, comme dans la ligne du Journal : c'est la seule marque que le réducteur d'activité et la
    // scène de la salle (L25b) lisent pour dessiner la boucle orange « par l'extension », jamais un signe du cockpit (train de V4 :
    // sans elle, ces actions n'étaient ni comptées ni dessinées).
    const data: DecisionFactData = { verdict: "non-controle", regle: OMO_REGLE_SANS_DEMANDE, par: "extension" };
    try {
      deps.facts().append([assertFact({ rootId, sessionId, kind: "decision", ref: ID_RE.test(callId) ? callId : null, data, at })]);
    } catch (err) {
      log.warn("salle : fait « decision » d'une action sans demande non écrit", { outil, error: errorMessage(err) });
    }
  };

  // --- Contrôle du disque -------------------------------------------------------------------------------------------------------

  const controler = async (p: Periode): Promise<void> => {
    let racine: string;
    let doute = p.configsDoute;
    try {
      racine = await fs.realpath(deps.workspace);
    } catch (err) {
      log.warn("salle : dossier de travail illisible pour le contrôle", { code: codeErreur(err) });
      racine = deps.workspace;
      doute = true;
    }
    let releves: ReleveEmpreintes[] = [];
    try {
      releves = await releverEmpreintesSalle({ workspace: deps.workspace, prepares: p.prepares, bornes });
    } catch (err) {
      log.warn("salle : relevé du disque impossible", { code: codeErreur(err) });
      doute = true;
    }
    const dossiers = releves.map((releve) => normaliserRelatif(releve.racine));
    const configs = await releverConfigs(racine, dossiers, bornes);
    const gits = await releverGits(racine, bornes);
    const courant = fusionner(releves);
    const nouveaux = new Map<string, OmoDiskElement>(configs.elements);
    if (gits.limiteAtteinte || p.gitProteges === null) {
      // Sans la liste des `.git` protégés, aucun `.git` trouvé ne peut être jugé : doute, et rien n'est mis de côté.
      doute = true;
    } else {
      const couverts = couvertsParProtection(p.gitProteges);
      for (const git of gits.gits) {
        // Hors de `gitProteges` : absent au démarrage (L19b l'a exigé), donc créé depuis. Forme inconnue ici : « autre » ; un `.git`
        // déjà relevé à la racine d'un dossier contrôlé y garde sa forme (même chemin), et le module pur réunit les casses.
        if (!couverts.has(normaliserRelatif(git).toLowerCase())) nouveaux.set(git, { forme: "autre", empreinte: null });
      }
    }
    const avant = instantane(fusionner(p.references.releves), p.configsAvant, false);
    const apres = instantane(courant, nouveaux, doute || configs.doute);
    const resultat = detect(p.etat, { type: "disque", avant, apres }, { reglePermission });
    if (releves.some((releve) => releve.signalesIncomplet === true)) p.signalesIncomplet = true;
    // Les `.git` sont listés par la quarantaine elle-même, avec leur nouveau nom (ou « à relire » si rien n'a été renommé).
    for (const signale of resultat.signales) if (signale.genre !== "git-quarantaine") noterSignale(p, signale);
    if (resultat.detection !== null) await agir(p, resultat.detection, resultat.quarantaine);
  };

  /** Un contrôle à la fois : `enCours` le marque jusqu'à sa fin, puis la demande suivante (si elle existe) est planifiée. */
  const occuper = (p: Periode, travail: Promise<void>): void => {
    const c = p.controle;
    const marque: Promise<void> = suivre(
      travail.finally(() => {
        if (c.enCours === marque) c.enCours = null;
        planifierControle(p);
      }),
    );
    c.enCours = marque;
  };

  const lancerControle = (p: Periode): void => {
    const c = p.controle;
    if (c.minuterie !== null) clock.clearTimer(c.minuterie);
    c.minuterie = null;
    c.immediat = false;
    c.differe = false;
    c.dernierDebut = clock.now();
    occuper(
      p,
      controler(p).catch((err: unknown) => log.warn("salle : contrôle du disque en échec", { error: errorMessage(err) })),
    );
  };

  /** Un contrôle à la fois ; `session.idle` tout de suite, un outil terminé au plus un toutes les 5 s (le dernier n'est jamais perdu). */
  const planifierControle = (p: Periode): void => {
    const c = p.controle;
    if (ferme || p !== periode || p.arret !== null || p.stoppee || c.enCours !== null) return;
    if (c.immediat) {
      lancerControle(p);
      return;
    }
    if (!c.differe) return;
    const attente = c.dernierDebut + OMO_DETECTIONS_CONTROLE_MS - clock.now();
    if (attente <= 0) {
      lancerControle(p);
      return;
    }
    if (c.minuterie !== null) return;
    c.minuterie = clock.setTimer(() => {
      c.minuterie = null;
      planifierControle(p);
    }, attente);
  };

  const demanderControle = (p: Periode, immediat: boolean): void => {
    if (immediat) p.controle.immediat = true;
    else p.controle.differe = true;
    planifierControle(p);
  };

  /**
   * Fin de la demande vue (terminée, plafond, « Arrêter », redémarrage) : la salle va être relancée à neuf. Rien du flux n'est plus
   * transmis ; un dernier contrôle du disque voit ce qui a été écrit depuis le précédent, puis la liste « à relire » est publiée.
   */
  const finDeDemande = (p: Periode, demande: OmoActiveRequest): void => {
    p.arret = { depuis: clock.now(), raison: "fin-de-demande" };
    p.demande = null;
    p.derniereRacine = demande.rootId;
    if (p.controle.minuterie !== null) clock.clearTimer(p.controle.minuterie);
    p.controle.minuterie = null;
    const precedent = p.controle.enCours;
    occuper(
      p,
      (async () => {
        await precedent;
        // Déjà arrêtée par une détection : la liste est partie avec elle (omo.hors-controle).
        if (p.stoppee) return;
        await controler(p).catch((err: unknown) => log.warn("salle : contrôle de fin de demande en échec", { error: errorMessage(err) }));
        const signales = signalesDe(p);
        if (p.stoppee || (signales.length === 0 && !p.signalesIncomplet)) return;
        const donnees: OmoSignalesData = { rootId: demande.rootId, signales, incomplet: p.signalesIncomplet };
        deps.hub.cockpit("omo.signales", donnees, "omo");
        log.info("salle : fichiers à relire en fin de demande", { rootId: demande.rootId, fichiers: signales.length, incomplet: p.signalesIncomplet });
      })(),
    );
  };

  // --- Entrées : flux, usage, origine, conflits, veille ----------------------------------------------------------------------------

  let veille = false;
  const demarrerVeille = (): void => {
    if (veille || ferme) return;
    veille = true;
    const tour = (): void => {
      const demande = lireDemande();
      enFile(async () => {
        await synchroniser(demande);
      });
      plusTard(tour, OMO_DETECTIONS_VEILLE_MS);
    };
    plusTard(tour, OMO_DETECTIONS_VEILLE_MS);
  };

  /** Un fait du flux ou du cockpit : lu APRÈS la synchronisation, et seulement hors d'un arrêt ou d'une relance du cockpit. */
  const recevoir = (fait: (p: Periode, demande: OmoActiveRequest | null) => void): void => {
    if (ferme) return;
    demarrerVeille();
    const demande = lireDemande();
    enFile(async () => {
      const p = await synchroniser(demande);
      if (p === null || p.arret !== null) return;
      fait(p, demande);
    });
  };

  const onEvent = (global: OcGlobalEvent, origin?: { instance: SessionInstance }): void => {
    if (origin !== undefined && origin.instance !== "omo") return;
    const event = global?.payload;
    // Les jumeaux « sync » (type « sync ») ne sont lus par aucun cas : jamais un fait de plus.
    if (!isRecord(event) || typeof event.type !== "string") return;
    const props = isRecord(event.properties) ? event.properties : {};
    const recu = clock.now();
    recevoir((p, demande) => traiterEvenement(p, event.type as string, props, demande, recu));
  };

  const onUsage = (data: UsageUpdatedData): void => {
    // Après un rattrapage, sans session : une resynchronisation, jamais une activité.
    const sessionId = ident(data?.sessionId);
    if (sessionId === null) return;
    recevoir((p, demande) =>
      appliquer(p, { type: "usage.updated", sessionId, rootId: ident(data.rootId) ?? racineDe(sessionId), demandeActive: demande?.rootId ?? null }),
    );
  };

  // Origine d'un message de racine : le fait `origine` de L4b (§5.7.2, MO-1 compris), publié sans étiquette d'instance. « Racine »
  // se juge par l'arbre de la SALLE (`racineDe`) : un enfant y a sa racine, une session de l'instance principale n'en a pas. Le
  // `rootId` du fait n'est pas relu : il ne ferait qu'écarter un fait qui contredit cet arbre, et le doute ne s'écarte pas.
  const retirerOrigine = deps.hub.subscribe((evenement) => {
    if (evenement.kind !== "cockpit" || evenement.type !== "activite.fait" || !isRecord(evenement.data)) return;
    const fait = evenement.data;
    const data = isRecord(fait.data) ? fait.data : null;
    const sessionId = ident(fait.sessionId);
    if (fait.kind !== "origine" || data?.origine !== "origine-inconnue" || sessionId === null) return;
    recevoir((p, demande) => {
      if (racineDe(sessionId) !== sessionId) return;
      appliquer(p, { type: "message", sessionId, rootId: sessionId, racine: true, origine: "origine-inconnue", demandeActive: demande?.rootId ?? null });
    });
  });

  // Conflit d'identifiant entre instances (L18a, P11) : une session que la salle présente sans l'avoir, ou l'inverse.
  const retirerConflits = deps.sessions.onInstanceConflict((conflit: SessionInstanceConflict) => {
    const sessionId = ident(conflit.sessionId);
    if (sessionId === null) return;
    recevoir((p, demande) =>
      appliquer(p, {
        type: "session.created",
        sessionId,
        parentID: null,
        rootId: sessionId,
        racineOuverteParLeCockpit: false,
        demandeActive: demande?.rootId ?? null,
      }),
    );
  });

  return {
    onEvent,
    onUsage,

    annoncerPatch(sessionId, permission) {
      const id = ident(sessionId);
      if (id === null) return;
      const copie = sansDelegations(permission.map((regle) => ({ ...regle }))) as OmoPermissionRule[];
      enFile(() => {
        if (periode !== null) appliquer(periode, { type: "permission.patch-cockpit", sessionId: id, permission: copie });
      });
    },

    async settled() {
      for (;;) {
        const f = file;
        const enCours = [...enVol];
        await f;
        await Promise.allSettled(enCours);
        if (f === file && enVol.size === 0) return;
      }
    },

    fermer() {
      ferme = true;
      for (const poignee of minuteries) clock.clearTimer(poignee);
      minuteries.clear();
      // Une quarantaine qui attendait la relance s'arrête là : rien n'est renommé (voir `attendreRelance`).
      for (const reveil of [...reveils]) reveil();
      if (periode !== null) abandonner(periode);
      retirerOrigine();
      retirerConflits();
    },
  };
}

// --- Module ---------------------------------------------------------------------------------------------------------------------

export interface OmoDetectionsOptions {
  /** `omo-projets.json` ; absent : celui des dossiers de contrôle de la salle. */
  projectsFile?: string | null;
  clock?: OmoControlClock;
  bornes?: Partial<PrecheckBornes>;
  reglePermission?: OmoReglePermission;
}

/**
 * Construit le service, pose le port et fait les deux inscriptions de la salle (`instances: ["omo"]`, D-2b-40) : dérivation
 * « omoDetections » et abonnement `usage.updated`. Exportée pour les tests, qui l'installent sur une salle ouverte dans leur copie ;
 * le module ne l'appelle que derrière `SALLE_OUVERTE`.
 */
export function inscrireDetectionsSalle(reg: Registrar, c11: Cockpit11, options: OmoDetectionsOptions = {}): OmoDetectionsService {
  const service = createOmoDetectionsService({
    workspace: c11.env.workspaceDir,
    projectsFile: options.projectsFile !== undefined ? options.projectsFile : (c11.omoControlDirs?.projectsFile ?? null),
    db: c11.db,
    hub: c11.hub,
    log: c11.log,
    sessions: c11.sessions,
    emises: () => c11.instances?.omo?.gate.emitted ?? null,
    activation: () => c11.ports.omoActivation,
    stop: () => c11.ports.omoStop,
    precheck: () => c11.ports.omoPrecheck,
    control: () => c11.ports.omoControl,
    facts: () => c11.ports.facts,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.bornes ? { bornes: options.bornes } : {}),
    ...(options.reglePermission ? { reglePermission: options.reglePermission } : {}),
  });
  c11.ports.omoDetections = service;
  reg.derivation({ name: "omoDetections", instances: ["omo"], onEvent: (event, origin) => service.onEvent(event, origin) });
  reg.hub("usage.updated", (data) => service.onUsage(data), { instances: ["omo"] });
  return service;
}

/**
 * Le service réel n'est construit que si la salle est configurée ET ouverte : dans le dépôt (`SALLE_OUVERTE` faux), le port NEUTRE
 * reste en place et le module n'inscrit rien — aucun événement lu, aucun disque relevé, aucun arrêt demandé.
 */
export const omoDetectionsModule: Cockpit11Module = {
  name: "omoDetections",
  install(reg, c11) {
    const dirs = c11.omoControlDirs ?? null;
    if (!c11.salleOuverte || dirs === null) return;
    inscrireDetectionsSalle(reg, c11);
  },
};
