// Propriétaire : GF5 (grande fusion, décision A31 a ; mesures/D11-permission.md §6.1 à §6.6 ; spécification §3.8, §3.12, P3, P9).
// Table des demandes d'autorisation en attente, alimentée par le flux d'événements d'UNE instance d'opencode (principale ou salle).
//
// Pourquoi : opencode 1.18.30 répond 400 à GET /permission?directory=D tant qu'une demande en attente du dossier D a un argument
// facultatif omis recopié dans ses métadonnées (webfetch sans `timeout`, glob sans `path`, grep sans `path` ni `include`, websearch ;
// jamais bash). La liste échoue EN BLOC pour tout le dossier ; les événements permission.asked et permission.replied, eux, sont
// complets (mesure D11). Cette table est le REPLI : le portillon (permission-gate.ts) ne la lit que sur la signature EXACTE du défaut,
// et seulement quand elle est prouvée complète. Sinon, fermé en cas de doute.
//
// Règles (réserves du sceptique, A31 a) :
// - une table par instance, un tableau de demandes par dossier ; clé = `directory` de l'enveloppe de /global/event, normalisé comme
//   le `query.directory` du portillon (null pour la racine d'opencode) ; « global » de global.disposed n'est JAMAIS normalisé ;
// - permission.asked ajoute ou remplace (même place, comme la Map d'opencode) une demande validée comme readAsked/toTaskPermission,
//   bornée ; permission.replied la retire ; server.instance.disposed vide le dossier ; global.disposed vide toute l'instance ;
// - bornes : TABLE_MAX_PAR_DOSSIER par dossier, TABLE_MAX_PAR_INSTANCE pour l'instance ; au-delà, ou demande illisible, le dossier
//   devient « incertain » (jamais fiable avant une nouvelle lecture réussie ou une libération vue) ;
// - FIABLE seulement si le flux est ouvert ET, depuis son ouverture (server.connected), une lecture GET /permission RÉUSSIE du
//   dossier a remplacé la table, ou une libération du dossier a été vue ; toute coupure ou reconnexion rend tous les dossiers non
//   fiables ; au démarrage, rien n'est fiable ;
// - resynchronisation SANS COURSE : les événements reçus pendant une lecture sont gardés et REJOUÉS sur la liste lue ; une lecture
//   commencée sous un autre flux ne compte pas ;
// - resynchronisation PROACTIVE : à chaque ouverture du flux (dossiers déjà connus) et à la première apparition d'un dossier sur le
//   flux en cours, par la fonction de relecture que le portillon pose (jamais d'appel réseau ici : la dérivation est synchrone).
// INVARIANT DE SÛRETÉ : la table ne dit que l'EXISTENCE d'une demande (et ce qu'elle porte). Aucun accord ne se décide sur elle :
// « once » exige toujours la conversation au travail, l'appel d'outil en cours et, pour une délégation, l'appel `task` relus EN
// DIRECT (checkOnce, readToolCall), exactement comme avec la liste d'opencode.
import path from "node:path";
import type { EventDerivation } from "./contracts-11.ts";
import type { OcGlobalEvent } from "./opencode.ts";
import type { SessionInstance } from "./shared/activity-types.ts";
import type { OutilBloquant } from "./shared/attentes-texts.ts";
import { ID_RE } from "./shared/ids.ts";

/** Demandes gardées par dossier au plus ; au-delà, le dossier est « incertain ». */
export const TABLE_MAX_PAR_DOSSIER = 500;
/** Demandes gardées pour toute l'instance au plus ; au-delà, le dossier qui reçoit la demande est « incertain ». */
export const TABLE_MAX_PAR_INSTANCE = 2_000;
/** Taille maximale des métadonnées d'une demande, en caractères de leur JSON ; au-delà : dossier « incertain » (jamais tronqué). */
export const METADONNEES_MAX = 64 * 1024;
/** Motifs d'une demande (patterns, always) : nombre et longueur au plus ; au-delà : dossier « incertain » (jamais tronqué). */
export const MOTIFS_MAX = 256;
export const MOTIF_MAX = 4_096;
/** Dossiers suivis au plus ; au-delà, un dossier nouveau n'est pas suivi (donc jamais fiable). */
export const DOSSIERS_MAX = 1_000;
/** Même borne que le portillon (CALL_ID_MAX_LENGTH). */
const CALL_ID_MAX = 512;
/** Même motif que readAsked (autonomy.ts) et toTaskPermission (task-once-guard.ts). */
const PERMISSION_RE = /^[a-z_]{1,32}$/;

/**
 * Arguments facultatifs qu'opencode 1.18.30 recopie dans les métadonnées d'une demande (tool/*.ts, appels à ctx.ask), dans l'ordre
 * d'écriture : omis, ils y laissent une clé `undefined`, que l'encodage de GET /permission refuse. Mesure D11 (webfetch, glob,
 * grep) ; websearch lu dans le code. bash n'y figure pas. Même table que le faux opencode (test-support), comparée par un test.
 */
export const METADONNEES_FACULTATIVES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  webfetch: Object.freeze(["timeout"]),
  glob: Object.freeze(["path"]),
  grep: Object.freeze(["path", "include"]),
  websearch: Object.freeze(["numResults", "livecrawl", "type", "contextMaxCharacters"]),
});

/**
 * Message du 400 d'opencode 1.18.30 quand GET /permission ne sait pas encoder une demande (mesure D11 : corps exact
 * {name:"BadRequest", data:{kind:"Body", message}}). Indice de la demande fautive dans la liste de l'instance, puis clé citée.
 */
export const SIGNATURE_DEFAUT = /^Expected JSON value, got undefined\n\s+at \[(\d+)\]\["metadata"\]\["([A-Za-z]+)"\]$/;

/** Demande en attente, telle qu'opencode la liste (PermissionRequest), champs validés et bornés. */
export interface DemandeEnAttente {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  /** null : demande posée hors d'un appel d'outil (doom_loop). */
  tool: { messageID: string; callID: string } | null;
}

/** Défaut de liste reconnu : indice et clé cités par opencode. */
export interface DefautDeListe {
  indice: number;
  cle: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Corps d'une réponse d'opencode qui porte EXACTEMENT la signature du défaut ; null pour toute autre forme (fermé en cas de doute). */
export function defautDansCorps(status: number, corps: unknown): DefautDeListe | null {
  if (status !== 400 || !isRecord(corps) || corps.name !== "BadRequest" || !isRecord(corps.data)) return null;
  const { kind, message } = corps.data;
  if (kind !== "Body" || typeof message !== "string") return null;
  const lu = SIGNATURE_DEFAUT.exec(message);
  if (!lu) return null;
  const indice = Number(lu[1]);
  return Number.isSafeInteger(indice) ? { indice, cle: lu[2] ?? "" } : null;
}

/**
 * Première demande qu'opencode 1.18.30 ne saurait pas encoder, dans l'ordre de la liste, et sa première clé facultative absente ;
 * null : liste encodable. Sert au CONTRÔLE FORT : la table doit prédire exactement l'erreur d'opencode.
 */
export function premiereIllisible(demandes: readonly Pick<DemandeEnAttente, "permission" | "metadata">[]): DefautDeListe | null {
  for (const [indice, demande] of demandes.entries()) {
    const cles = Object.hasOwn(METADONNEES_FACULTATIVES, demande.permission) ? METADONNEES_FACULTATIVES[demande.permission] : undefined;
    const cle = cles?.find((nom) => !Object.hasOwn(demande.metadata, nom) || demande.metadata[nom] === undefined);
    if (cle !== undefined) return { indice, cle };
  }
  return null;
}

/** Liste de motifs bornée ; null si elle ne l'est pas (jamais tronquée en silence). */
function motifs(valeur: unknown): string[] | null {
  if (valeur === undefined) return [];
  if (!Array.isArray(valeur) || valeur.length > MOTIFS_MAX) return null;
  return valeur.every((m): m is string => typeof m === "string" && m.length <= MOTIF_MAX) ? [...valeur] : null;
}

/**
 * Demande lue dans un événement permission.asked ou dans une entrée de GET /permission, validée comme readAsked et
 * toTaskPermission, bornée sans troncature ; null : illisible (le dossier devient « incertain »).
 */
export function lireDemande(brut: unknown): DemandeEnAttente | null {
  if (!isRecord(brut)) return null;
  const { id, sessionID, permission } = brut;
  if (typeof id !== "string" || !ID_RE.test(id) || typeof sessionID !== "string" || !ID_RE.test(sessionID)) return null;
  if (typeof permission !== "string" || !PERMISSION_RE.test(permission)) return null;
  const patterns = motifs(brut.patterns);
  const always = motifs(brut.always);
  if (patterns === null || always === null) return null;
  const metadata = brut.metadata === undefined ? {} : brut.metadata;
  if (!isRecord(metadata)) return null;
  let taille: number;
  try {
    taille = JSON.stringify(metadata).length;
  } catch {
    return null;
  }
  if (taille > METADONNEES_MAX) return null;
  let tool: DemandeEnAttente["tool"] = null;
  if (brut.tool !== undefined && brut.tool !== null) {
    if (!isRecord(brut.tool)) return null;
    const { messageID, callID } = brut.tool;
    if (typeof messageID !== "string" || !ID_RE.test(messageID) || typeof callID !== "string" || callID.length === 0 || callID.length > CALL_ID_MAX) return null;
    tool = { messageID, callID };
  }
  // Copie propre : aucune référence gardée sur l'objet de l'événement.
  return { id, sessionID, permission, patterns, metadata: JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>, always, tool };
}

/** Demande au format d'opencode (PermissionRequest) : ce que le proxy sert au navigateur à la place de la liste illisible. */
export function auFormatOpencode(demande: DemandeEnAttente): Record<string, unknown> {
  return {
    id: demande.id,
    sessionID: demande.sessionID,
    permission: demande.permission,
    patterns: [...demande.patterns],
    metadata: JSON.parse(JSON.stringify(demande.metadata)) as Record<string, unknown>,
    always: [...demande.always],
    ...(demande.tool === null ? {} : { tool: { ...demande.tool } }),
  };
}

/** Cible de global.disposed : toute l'instance (jamais une clé de dossier, même un dossier nommé « global » ou « tous »). */
const TOUS: unique symbol = Symbol("tous les dossiers");

/** Clé d'un dossier : null pour la racine d'opencode (ou dossier absent), sinon le chemin normalisé comme opencode l'ouvre. */
export type CleDossier = string | null;

/**
 * Normalise un dossier comme le `query.directory` du portillon : vide ou absent → null ; chemin POSIX résolu (« .. » et « . »
 * compris, comme opencode) sans barre finale ; la racine d'opencode → null. Jamais appelé sur « global » (global.disposed).
 */
export function cleDossier(directory: string | null | undefined, racine: string | null): CleDossier {
  if (typeof directory !== "string" || directory === "") return null;
  let cle = directory.startsWith("/") ? path.posix.resolve("/", directory) : directory;
  while (cle.length > 1 && cle.endsWith("/")) cle = cle.slice(0, -1);
  if (racine !== null && racine !== "" && cle === cleDossier(racine, null)) return null;
  return cle;
}

/** État d'un dossier rendu au portillon. */
export interface EtatDossier {
  /** Table complète prouvée pour le flux en cours (voir l'en-tête). */
  fiable: boolean;
  /** Demandes, dans l'ordre d'opencode (ordre d'insertion). Copies. */
  demandes: DemandeEnAttente[];
}

/** Lecture GET /permission en cours : repère du flux au départ et événements du dossier reçus depuis. */
export interface Lecture {
  readonly cle: CleDossier;
  readonly flux: number;
  readonly tampon: OcGlobalEvent[];
}

export interface TableDesAttentes {
  readonly instance: SessionInstance;
  /** Racine d'opencode de l'instance (clé null) ; posée à l'installation (c11.projects.opencodeRoot). */
  poserRacine(racine: string | null): void;
  /**
   * Relecture proactive d'un dossier (le portillon la pose : GET /permission, protégé par isAllowedDirectory) ; appelée hors de la
   * dérivation (microtâche), au plus une à la fois par dossier.
   */
  poserRelecture(relire: ((directory: string | null) => Promise<void>) | null): void;
  /** Dérivation « pending » (STEP_ORDER, avant « gate ») : synchrone, sans réseau. */
  readonly derivation: EventDerivation;
  /** Flux coupé ou rouvert (opencode.connection, omo.connection) : plus rien n'est fiable jusqu'au prochain server.connected. */
  surConnexion(): void;
  /** Début d'une lecture GET /permission du dossier : les événements reçus pendant la lecture seront rejoués sur la liste lue. */
  debutLecture(directory: string | null): Lecture;
  /** Lecture réussie : la liste remplace la table du dossier, puis les événements reçus pendant la lecture sont rejoués. */
  finLecture(lecture: Lecture, liste: readonly unknown[]): void;
  /** Lecture en échec : rien ne change. */
  abandonLecture(lecture: Lecture): void;
  etat(directory: string | null): EtatDossier;
  /** Relevé pour les tests et le journal : dossiers suivis, demandes, état. */
  releve(): Array<{ cle: CleDossier; fiable: boolean; incertain: boolean; demandes: string[] }>;
  /** Relectures proactives planifiées ou en cours (harnais : attendre qu'elles soient finies avant de compter les requêtes). */
  relecturesEnCours(): number;
}

interface Dossier {
  demandes: Map<string, DemandeEnAttente>;
  /** Repère du flux pour lequel la table est prouvée complète ; -1 : jamais. */
  fiableSous: number;
  incertain: boolean;
  /** Chemin tel que reçu (lecture proactive avec le même texte que l'enveloppe). */
  chemin: string | null;
}

export interface OptionsTable {
  instance?: SessionInstance;
  racine?: string | null;
  /** Planification de la relecture proactive (tests) ; défaut : queueMicrotask. */
  planifier?: (travail: () => void) => void;
}

export function createPendingTable(options: OptionsTable = {}): TableDesAttentes {
  const instance: SessionInstance = options.instance ?? "principale";
  const planifier = options.planifier ?? ((travail: () => void) => queueMicrotask(travail));
  let racine: string | null = options.racine ?? null;
  let relire: ((directory: string | null) => Promise<void>) | null = null;
  /** Repère du flux : change à chaque ouverture (server.connected) et à chaque coupure. */
  let flux = 0;
  /** Vrai entre un server.connected et la coupure suivante. */
  let ouvert = false;
  const dossiers = new Map<CleDossier, Dossier>();
  /** Dossiers déjà vus sur le flux en cours (relecture proactive à la première apparition). */
  const vus = new Set<CleDossier>();
  const lectures = new Set<Lecture & { tampon: OcGlobalEvent[] }>();
  /** Relectures proactives en cours, par dossier. */
  const enRelecture = new Set<CleDossier>();

  const cle = (directory: string | null | undefined): CleDossier => cleDossier(directory, racine);
  const total = (): number => {
    let n = 0;
    for (const d of dossiers.values()) n += d.demandes.size;
    return n;
  };

  const dossier = (k: CleDossier, chemin: string | null): Dossier | null => {
    let d = dossiers.get(k);
    if (d !== undefined) return d;
    if (dossiers.size >= DOSSIERS_MAX) {
      // Place faite par le plus ancien dossier vide ; sinon, le nouveau n'est pas suivi (donc jamais fiable).
      const vide = [...dossiers.entries()].find(([, x]) => x.demandes.size === 0);
      if (vide === undefined) return null;
      dossiers.delete(vide[0]);
    }
    d = { demandes: new Map(), fiableSous: -1, incertain: false, chemin };
    dossiers.set(k, d);
    return d;
  };

  const vider = (d: Dossier): void => {
    d.demandes.clear();
    d.incertain = false;
    d.fiableSous = ouvert ? flux : -1;
  };

  /**
   * Dossier visé par un événement : « tous » pour global.disposed (jamais normalisé : « global » n'est pas un dossier), la clé du
   * dossier libéré pour server.instance.disposed, celle de l'enveloppe pour permission.* ; null : événement sans effet sur la table.
   */
  const viseDe = (global: OcGlobalEvent): { type: string; cle: CleDossier | typeof TOUS; chemin: string | null } | null => {
    const payload = isRecord(global) ? global.payload : null;
    if (!isRecord(payload) || typeof payload.type !== "string") return null;
    const type = payload.type;
    if (type === "global.disposed") return { type, cle: TOUS, chemin: null };
    const chemin = typeof global.directory === "string" ? global.directory : null;
    if (type === "server.instance.disposed") {
      const proprietes = isRecord(payload.properties) ? payload.properties : null;
      const libere = proprietes !== null && typeof proprietes.directory === "string" ? proprietes.directory : chemin;
      return { type, cle: cle(libere), chemin: libere };
    }
    if (type === "permission.asked" || type === "permission.replied") return { type, cle: cle(chemin), chemin };
    return null;
  };

  /**
   * Applique un événement à la table. `seulement` (rejeu d'une lecture) : l'événement ne touche que ce dossier — un rejeu ne doit
   * jamais revider un AUTRE dossier qui a reçu des demandes depuis.
   */
  const appliquer = (global: OcGlobalEvent, seulement?: CleDossier): void => {
    const vise = viseDe(global);
    if (vise === null) return;
    const payload = global.payload as unknown as Record<string, unknown>;
    const proprietes = isRecord(payload.properties) ? payload.properties : null;
    const { type } = vise;
    if (type === "global.disposed") {
      // Toute l'instance est libérée : chaque dossier connu est vide et fiable pour ce flux.
      if (seulement !== undefined) {
        const d = dossiers.get(seulement);
        if (d !== undefined) vider(d);
        return;
      }
      for (const d of dossiers.values()) vider(d);
      return;
    }
    if (vise.cle === TOUS || (seulement !== undefined && vise.cle !== seulement)) return;
    if (type === "server.instance.disposed") {
      const d = dossier(vise.cle, vise.chemin);
      if (d !== null) vider(d);
      return;
    }
    const d = dossier(vise.cle, vise.chemin);
    if (d === null) return;
    if (type === "permission.replied") {
      const requestID = proprietes?.requestID;
      if (typeof requestID !== "string" || !ID_RE.test(requestID)) {
        // Réponse illisible : une demande peut rester à tort dans la table.
        d.incertain = true;
        return;
      }
      d.demandes.delete(requestID);
      return;
    }
    const demande = lireDemande(proprietes);
    if (demande === null) {
      d.incertain = true;
      return;
    }
    const nouvelle = !d.demandes.has(demande.id);
    if (nouvelle && (d.demandes.size >= TABLE_MAX_PAR_DOSSIER || total() >= TABLE_MAX_PAR_INSTANCE)) {
      d.incertain = true;
      return;
    }
    // Map.set sur une clé existante garde sa place, comme la Map `pending` d'opencode (permission/index.ts).
    d.demandes.set(demande.id, demande);
  };

  const planifierRelecture = (k: CleDossier, chemin: string | null): void => {
    const fn = relire;
    if (fn === null || enRelecture.has(k)) return;
    enRelecture.add(k);
    planifier(() => {
      void fn(k === null ? null : (chemin ?? k))
        .catch(() => undefined)
        .finally(() => enRelecture.delete(k));
    });
  };

  const ouverture = (): void => {
    flux++;
    ouvert = true;
    vus.clear();
    for (const d of dossiers.values()) d.fiableSous = -1;
    for (const [k, d] of dossiers) {
      vus.add(k);
      planifierRelecture(k, d.chemin);
    }
  };

  const coupure = (): void => {
    flux++;
    ouvert = false;
    vus.clear();
    for (const d of dossiers.values()) d.fiableSous = -1;
  };

  const derivation: EventDerivation = {
    name: "pending",
    ...(instance === "principale" ? {} : { instances: [instance] }),
    onEvent(global, origin) {
      if ((origin?.instance ?? "principale") !== instance) return;
      const payload = isRecord(global) ? global.payload : null;
      const type = isRecord(payload) && typeof payload.type === "string" ? payload.type : null;
      if (type === null) return;
      if (type === "server.connected") {
        ouverture();
        return;
      }
      const vise = viseDe(global);
      // Événement gardé pour chaque lecture en cours du dossier qu'il touche (global.disposed : toutes) ; rejoué sur ce seul dossier.
      if (vise !== null) for (const lecture of lectures) if (vise.cle === TOUS || lecture.cle === vise.cle) lecture.tampon.push(global);
      appliquer(global);
      // Première apparition d'un dossier sur le flux en cours : relecture proactive (jamais pour « global »).
      const chemin = typeof global.directory === "string" ? global.directory : null;
      if (ouvert && type !== "global.disposed" && chemin !== null && chemin !== "") {
        const k = cle(chemin);
        if (!vus.has(k)) {
          vus.add(k);
          if (dossier(k, chemin) !== null) planifierRelecture(k, chemin);
        }
      }
    },
  };

  return {
    instance,
    poserRacine(valeur) {
      racine = valeur;
    },
    poserRelecture(fn) {
      relire = fn;
    },
    derivation,
    surConnexion() {
      // Coupure : les événements manquent. Réouverture annoncée par le client : le server.connected du nouveau flux ouvrira le repère.
      coupure();
    },
    debutLecture(directory) {
      const lecture = { cle: cle(directory), flux, tampon: [] as OcGlobalEvent[] };
      lectures.add(lecture);
      return lecture;
    },
    finLecture(lecture, liste) {
      const l = lecture as Lecture & { tampon: OcGlobalEvent[] };
      lectures.delete(l);
      // Lecture commencée sous un autre flux, ou flux fermé : elle ne prouve rien.
      if (!ouvert || l.flux !== flux) return;
      const d = dossier(l.cle, null);
      if (d === null) return;
      const lues: DemandeEnAttente[] = [];
      let illisible = liste.length > TABLE_MAX_PAR_DOSSIER;
      for (const item of illisible ? [] : liste) {
        const demande = lireDemande(item);
        if (demande === null) {
          illisible = true;
          break;
        }
        lues.push(demande);
      }
      d.demandes = new Map(lues.map((demande) => [demande.id, demande]));
      d.incertain = illisible || total() > TABLE_MAX_PAR_INSTANCE;
      // Rejeu des événements reçus pendant la lecture, dans l'ordre, sur ce seul dossier (resynchronisation sans course).
      for (const evenement of l.tampon) appliquer(evenement, l.cle);
      d.fiableSous = flux;
    },
    abandonLecture(lecture) {
      lectures.delete(lecture as Lecture & { tampon: OcGlobalEvent[] });
    },
    etat(directory) {
      const d = dossiers.get(cle(directory));
      if (d === undefined) return { fiable: false, demandes: [] };
      const demandes = [...d.demandes.values()].map((demande) => lireDemande(demande) ?? demande);
      return { fiable: ouvert && !d.incertain && d.fiableSous === flux, demandes };
    },
    relecturesEnCours() {
      return enRelecture.size;
    },
    releve() {
      return [...dossiers.entries()].map(([k, d]) => ({
        cle: k,
        fiable: ouvert && !d.incertain && d.fiableSous === flux,
        incertain: d.incertain,
        demandes: [...d.demandes.keys()],
      }));
    },
  };
}

/**
 * Liste d'opencode illisible (signature exacte du défaut) alors que la table n'est pas prouvée complète : rien n'est deviné. Levée
 * par gate.pending ; le « once » répond 503 avec la phrase « liste bloquée » (jamais « opencode ne répond pas »).
 */
export class ListeBloqueeError extends Error {
  override name = "ListeBloqueeError";
  readonly outil: OutilBloquant;

  constructor(outil: OutilBloquant) {
    super(`liste des demandes d'autorisation illisible : une demande en attente l'en empêche (${outil}), table des attentes non fiable`);
    this.outil = outil;
  }
}
