// Contrats serveur de la Salle OMO (plan d'exécution 2 bis-2 ter §4.1.2, T3a ; spécification §3.8-§3.10, §3.12.1, §4.14) :
// dépendances par instance, routeur d'instances, ports de la salle, noms de modules, ordre proposé des inscriptions (appliqué par
// T3b dans wiring-11.ts), listes fermées des codes de omo-types.ts et schéma du contrat machine docker/opencode-omo/contrat-salle.json.
// Aucun comportement ni branchement : rien ici n'est importé par le câblage avant T3b. Les ports rendent des CODES, jamais des
// phrases (omo-room-texts.ts). Un changement de contrat après le train de V0 est une demande écrite à l'intégrateur.
import { z } from "zod";
import type { ModelCatalog } from "./catalog.ts";
import type { BillRefusal } from "./config-queue.ts";
import type { HookStep, HubEventType, ModuleName, PermissionGate } from "./contracts-11.ts";
import type { OcLookup } from "./oc-lookup.ts";
import type { OpencodeClient } from "./opencode.ts";
import type { EventProcessor } from "./processor.ts";
import type { SessionInstance } from "./shared/activity-types.ts";
import type { UiMode } from "./shared/assistant-rules.ts";
import type { RequestEnd } from "./shared/autonomy-types.ts";
import type { StopResult } from "./shared/cockpit-event-types.ts";
import type {
  EgressRefusalReason,
  OmoActivationBody,
  OmoActivationRefusalCode,
  OmoActivationView,
  OmoDetectionCause,
  OmoEtatSalle,
  OmoForbiddenCategory,
  OmoGitForm,
  OmoGuardState,
  OmoPrecheckOkProject,
  OmoPrecheckProjectResult,
  OmoPrecheckReason,
  OmoRecreationRaison,
  OmoRoomCreateBody,
  OmoRoomCreateResponse,
  OmoSalleContract,
  OmoSignale,
  OmoStatusResponse,
  OmoStopCause,
  OmoSupervisorState,
} from "./shared/omo-types.ts";

// --- Instances (C1 : client unique ; D-2b-01, D-2b-20) ---------------------------------------------------------------------------

/** Dépendances propres à une instance opencode : chaque instance a son client, son portillon (registre propre), son processeur. */
export interface InstanceDeps {
  instance: SessionInstance;
  client: OpencodeClient;
  /** Portillon de l'instance ; celui de la salle a son propre registre des réponses émises (base de la détection 1). */
  gate: PermissionGate;
  lookup: OcLookup;
  catalog: ModelCatalog;
  processor: EventProcessor;
  /** Refus d'un envoi facturé (configuration en cours d'application, adresse Copilot à revérifier…), null si admis. */
  billRefusal(): BillRefusal | null;
  /** Envoi facturé admis : compté jusqu'à l'appel de la fonction rendue. */
  beginBilled(): () => void;
  /** Dossier transmis à l'instance, dans le dossier de travail monté. */
  isAllowedDirectory(dir: string): boolean;
}

/** Routage par sessions.instance (P11) : une session de l'autre instance → 404 ; une session inconnue → 409 instance-inconnue. */
export interface InstanceRouter {
  principale: InstanceDeps;
  /** null tant que la salle est coupée (COCKPIT_OMO=off ou SALLE_OUVERTE faux) : aucun client, aucun processeur. */
  omo: InstanceDeps | null;
  /** Instance d'une session suivie ; null si la session est inconnue du cockpit. */
  instanceOf(sessionId: string): SessionInstance | null;
  /** null : instance absente (salle coupée). */
  of(instance: SessionInstance): InstanceDeps | null;
}

// --- Ports de la salle (T3b pose les ports neutres, les paquets V3-V4 les remplissent) --------------------------------------------

/**
 * L17b. Dossier de contrôle et d'authentification de la salle, écrit par le cockpit seul. AUCUNE méthode de redémarrage : la
 * relance passe par stop-request et la sortie du superviseur (§3.12.1). Tant que SALLE_OUVERTE est faux : aucun fichier écrit.
 */
export interface OmoControlPort {
  /** Battement toutes les 5 s (D-2b-25), seulement si COCKPIT_OMO=on, COCKPIT_AUTONOMY=on et SALLE_OUVERTE. */
  startHeartbeat(): void;
  stopHeartbeat(): void;
  /** Écrit stop-request {at, cause} : une cause d'arrêt, ou « fin-de-demande » pour la relance à neuf de fin de demande (D-2b-29). */
  requestStop(cause: OmoRecreationRaison): Promise<void>;
  /** Écrit precheck-ok lié au démarrage en cours ; jamais si la salle est suspendue. */
  writePrecheckOk(startId: string, projets: readonly OmoPrecheckOkProject[]): Promise<void>;
  /** Écrit guard-state.json, lu par le plugin de garde (filet). */
  writeGuardState(state: OmoGuardState): Promise<void>;
  /** D-2b-26 : recopie la seule entrée github-copilot d'auth.json dans omo-auth (0600), ou supprime le fichier ; jamais journalisé. */
  publishAuth(): Promise<void>;
  /** state.json lu borné ; null = inconnu (absent, invalide ou trop gros). */
  readState(): Promise<OmoSupervisorState | null>;
  /** D-2b-29 : salle suspendue, aucun precheck-ok ; levée par la réouverture confirmée d'une salle. */
  suspend(raison: OmoDetectionCause): void;
  resume(): void;
  suspended(): boolean;
}

export type OmoRoomOpenResult =
  | { ok: true; room: OmoRoomCreateResponse }
  | {
      ok: false;
      status: 400 | 403 | 409;
      code: OmoActivationRefusalCode | OmoPrecheckReason;
      /** Résultat masqué du pré-contrôle quand il refuse le projet ; null sinon. */
      precheck: OmoPrecheckProjectResult | null;
    };

/** L18c. Neutre : open → 403 salle-coupee ; status → salle coupée ; openProjects → [] ; isRoomRoot → false. */
export interface OmoRoomPort {
  /** POST /api/omo/rooms : `confirmed` = x-cockpit-confirm: 1 présent. */
  open(body: OmoRoomCreateBody, options: { mode: UiMode; confirmed: boolean }): Promise<OmoRoomOpenResult>;
  status(): Promise<OmoStatusResponse>;
  /** Projets des salles ouvertes (omo_rooms), relatifs à /workspace. */
  openProjects(): string[];
  isRoomRoot(rootId: string): boolean;
}

export type OmoPrecheckOutcome = { ok: true; resultat: OmoPrecheckProjectResult } | { ok: false; code: OmoActivationRefusalCode };

export type OmoBeforeStartOutcome =
  /** precheck-ok écrit pour ce démarrage. */
  | { ok: true; startId: string; resultats: OmoPrecheckProjectResult[] }
  /** Aucun precheck-ok : un projet non conforme (portée « prepares », D-2b-35), .git non protégé, salle suspendue ou coupée. */
  | { ok: false; startId: string; code: OmoActivationRefusalCode; resultats: OmoPrecheckProjectResult[] };

/** L19b. Neutre : check et beforeStart → refus salle-coupee, aucun precheck-ok. */
export interface OmoPrecheckPort {
  check(projet: string): Promise<OmoPrecheckOutcome>;
  /** Déclenché par un nouveau startId dans state.json. */
  beforeStart(startId: string): Promise<OmoBeforeStartOutcome>;
}

export type OmoActivationPutResult =
  | { ok: true; view: OmoActivationView }
  | { ok: false; status: 400 | 403 | 404 | 409; code: OmoActivationRefusalCode | "invalid" | "not-found" };

export type OmoConsumeResult = { ok: true; requestId: string } | { ok: false; code: OmoActivationRefusalCode };

/** Demande active de la salle (une seule à la fois, D-2b-08). */
export interface OmoActiveRequest {
  rootId: string;
  requestId: string;
  startedAt: number;
  /** Montant saisi et confirmé, en chaîne (jamais une valeur par défaut). */
  plafondUsd: string;
}

/** L22c. Neutre : view avec salleOuverte faux ; put → 409 salle-coupee ; consume → salle-coupee ; activeRequest → null. */
export interface OmoActivationPort {
  /** null : racine inconnue ou hors salle. */
  view(rootId: string): Promise<OmoActivationView | null>;
  /** PUT …/autonomie {choix: "omo", plafondUsd} ; `confirmed` exigé à chaque demande. Crée un jeton à usage unique (D-2b-07). */
  put(rootId: string, body: OmoActivationBody, options: { mode: UiMode; confirmed: boolean }): Promise<OmoActivationPutResult>;
  /** beforeBilledSend de la salle : consomme le jeton et revérifie chaque condition (409 sans envoi). */
  consume(rootId: string): Promise<OmoConsumeResult>;
  activeRequest(): OmoActiveRequest | null;
  endRequest(rootId: string, fin: RequestEnd): void;
}

/** L23b. Neutre : run lève PortUnavailableError ; relaunchAfterRequest sans effet ; aucun crochet. */
export interface OmoStopPort {
  /** stopTreeOmo (§3.12.1) ; rootId null : arrêt de la salle sans racine (redémarrage du cockpit, activité hors demande). */
  run(rootId: string | null, cause: OmoStopCause): Promise<StopResult>;
  /** Fin de demande (D-2b-29) : stop-request sans renommer boulder.json, omo.recreation {raison: "fin-de-demande"}. */
  relaunchAfterRequest(rootId: string): Promise<void>;
}

/** Détections, répondeur et plafonds agissent par leurs inscriptions : ports vides. */
export interface OmoDetectionsPort {}
export interface OmoResponderPort {}
export interface OmoCapsPort {}

export interface OmoPorts {
  omoControl: OmoControlPort;
  omoRoom: OmoRoomPort;
  omoPrecheck: OmoPrecheckPort;
  omoActivation: OmoActivationPort;
  omoStop: OmoStopPort;
  omoDetections: OmoDetectionsPort;
  omoResponder: OmoResponderPort;
  omoCaps: OmoCapsPort;
}

export type OmoModuleName = keyof OmoPorts;

export const OMO_MODULE_NAMES = [
  "omoControl",
  "omoRoom",
  "omoPrecheck",
  "omoActivation",
  "omoStop",
  "omoDetections",
  "omoResponder",
  "omoCaps",
] as const satisfies readonly OmoModuleName[];

// --- Ordre proposé des inscriptions de l'instance omo (plan §4.1.2), appliqué par T3b ------------------------------------------

/** Groupe de routes de la salle (/api/omo/*), monté après les groupes existants. */
export type OmoRouteGroup = "omo";

export type OmoStepModule = ModuleName | OmoModuleName;

export interface OmoStepOrder {
  instance: "omo";
  hooks: { readonly [S in HookStep]: readonly OmoStepModule[] };
  derivations: readonly OmoStepModule[];
  hub: ReadonlyArray<readonly [OmoStepModule, HubEventType]>;
  startup: readonly OmoStepModule[];
  routes: ReadonlyArray<readonly [OmoRouteGroup, OmoStepModule]>;
}

/**
 * - createSession, sessionCreated, beforeOnceRelay : aucune inscription (POST /session et réponses du navigateur refusés par le
 *   proxy de la salle, D-2b-04) ;
 * - beforeBilledSend : jeton et conditions revérifiées, puis garde-fou budgétaire sur le message de l'utilisateur ;
 * - abort : arrêt de la salle (D-2b-30) ;
 * - dérivations : portillon de la salle, détections, répondeur, faits, plafonds ;
 * - hub : plafonds (usage.updated de la salle), puis détections (usage.updated hors demande) ;
 * - démarrage : lecture d'état, arrêt si la salle tourne au redémarrage du cockpit (D-2b-29), salles, surveillance de state.json.
 */
export const OMO_ORDRE_PROPOSE = {
  instance: "omo",
  hooks: {
    createSession: [],
    sessionCreated: [],
    beforeBilledSend: ["omoActivation", "omoCaps"],
    beforeOnceRelay: [],
    abort: ["omoStop"],
  },
  derivations: ["gate", "omoDetections", "omoResponder", "facts", "omoCaps"],
  hub: [
    ["omoCaps", "usage.updated"],
    ["omoDetections", "usage.updated"],
  ],
  startup: ["omoControl", "omoStop", "omoRoom", "omoPrecheck"],
  routes: [["omo", "omoRoom"]],
} as const satisfies OmoStepOrder;

// --- Listes fermées des codes (unions de omo-types.ts), comparées au train de V0 ---------------------------------------------------

export const OMO_PRECHECK_REASONS = [
  "config-extension",
  "config-opencode",
  "fichier-cle",
  "lien-symbolique",
  "illisible",
  "profondeur",
  "hors-workspace",
  "non-prepare",
  "empreinte-impossible",
] as const satisfies readonly OmoPrecheckReason[];

export const OMO_ACTIVATION_REFUSAL_CODES = [
  "salle-coupee",
  "autonomie-coupee",
  "mode-avance",
  "racine-hors-salle",
  "confirmation-requise",
  "plafond-vide",
  "plafond-invalide",
  "plafond-hors-bornes",
  "budget-mensuel",
  "precheck-refuse",
  "git-inscriptible",
  "manifeste",
  "image-inattendue",
  "battement-absent",
  "demande-active",
  "adresse-copilot-changee",
  "catalogue-absent",
  "jeton-consomme",
  "salle-suspendue",
  "salle-en-relance",
  "workspace-non-verifie",
] as const satisfies readonly OmoActivationRefusalCode[];

export const OMO_STOP_CAUSES = [
  "vous",
  "plafond-cout",
  "plafond-duree",
  "plafond-sessions",
  "plafond-tentatives",
  "seuil-mensuel",
  "hors-controle",
  "homme-mort",
  "redemarrage-cockpit",
] as const satisfies readonly OmoStopCause[];

export const OMO_DETECTION_CAUSES = [
  "reponse-non-emise",
  "racine-etrangere",
  "dispose-non-demande",
  "permission-modifiee",
  "origine-inconnue",
  "config-apparue",
  "git-cree",
  "ide-ci-modifie",
  "tentatives-429",
  "activite-hors-demande",
] as const satisfies readonly OmoDetectionCause[];

export const OMO_FORBIDDEN_CATEGORIES = [
  "fichier-cle",
  "env",
  "production",
  "reseau",
  "git-envoi",
  "git-options-globales",
  "hors-projet",
  "config-extension",
  "ide-ci",
  "git-interne",
  "web",
] as const satisfies readonly OmoForbiddenCategory[];

export const EGRESS_REFUSAL_REASONS = ["hote", "port", "ip-litterale", "invalide", "methode"] as const satisfies readonly EgressRefusalReason[];

export const OMO_GIT_FORMS = ["dossier", "fichier", "lien", "absent"] as const satisfies readonly OmoGitForm[];

export const OMO_ETATS_SALLE = ["coupee", "arretee", "en-relance", "prete", "demande-active", "suspendue"] as const satisfies readonly OmoEtatSalle[];

export const OMO_SIGNALE_GENRES = ["ide-ci", "programme", "git-quarantaine"] as const satisfies readonly OmoSignale["genre"][];

// --- Schéma de contrat-salle.json (D-2b-39) ---------------------------------------------------------------------------------------

/** Chemin absolu POSIX, sans « . », « .. », « // » ni barre finale. */
const cheminAbsolu = z
  .string()
  .regex(/^(?:\/[A-Za-z0-9._-]+)+$/)
  .refine((chemin) => !chemin.split("/").some((part) => part === "." || part === ".."));

/** Nom relatif (un ou plusieurs segments), sans « . » ni « .. ». */
const nomRelatif = z
  .string()
  .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/)
  .refine((nom) => !nom.split("/").some((part) => part === "." || part === ".."));

const nomVariable = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const serviceEcrivain = z.enum(["salle", "egress", "cockpit"]);

/** Valide contrat-salle.json : forme exacte de OmoSalleContract (clé inconnue refusée), chemins absolus. */
export const OMO_SALLE_CONTRACT_SCHEMA = z.strictObject({
  version: z.literal(1),
  description: z.string().min(1),
  services: z.strictObject({
    salle: z.literal("opencode-omo"),
    egress: z.literal("egress"),
    cockpit: z.literal("cockpit"),
    principale: z.literal("opencode"),
  }),
  profil: z.literal("omo"),
  reseau: z.literal("omo-internal"),
  volumes: z.array(
    z.strictObject({
      nom: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
      proprietaire: z.enum(["root", "node"]),
      ecrivain: serviceEcrivain.nullable(),
      montages: z.array(z.strictObject({ service: serviceEcrivain, cible: cheminAbsolu, mode: z.enum(["rw", "ro"]) })).min(1),
    }),
  ),
  cheminsImage: z.strictObject({
    superviseur: cheminAbsolu,
    superviseurLib: cheminAbsolu,
    valider: cheminAbsolu,
    validerCoeur: cheminAbsolu,
    enumerations: cheminAbsolu,
    manifeste: cheminAbsolu,
    referenceManifeste: cheminAbsolu,
    garde: cheminAbsolu,
    configuration: cheminAbsolu,
    extension: cheminAbsolu,
    licence: cheminAbsolu,
  }),
  perimetreManifeste: z.array(cheminAbsolu).min(1),
  dossiersConfigHome: z.array(cheminAbsolu).min(1),
  nomsPrecontrole: z.strictObject({ fichiers: z.array(nomRelatif).min(1), dossiers: z.array(nomRelatif).min(1) }),
  fichiersControle: z.strictObject({
    battement: z.literal("heartbeat"),
    arret: z.literal("stop-request"),
    precheck: z.literal("precheck-ok"),
    garde: z.literal("guard-state.json"),
  }),
  etat: z.literal("state.json"),
  egress: z.strictObject({ port: z.literal(3128) }),
  variables: z.strictObject({ cockpit: z.array(nomVariable).min(1), salle: z.array(nomVariable).min(1) }),
  securite: z.strictObject({
    cap_drop: z.tuple([z.literal("ALL")]),
    cap_add: z.array(z.enum(["SETUID", "SETGID"])),
    security_opt: z.array(z.string().min(1)),
    read_only: z.literal(true),
    tmpfs: z.array(z.string().regex(/^(?:\/[A-Za-z0-9._-]+)+(?::[a-z0-9=,]+)?$/)).min(1),
  }),
}) satisfies z.ZodType<OmoSalleContract>;

/** Nom de fichier du contrat, relatif à la racine du dépôt. */
export const OMO_SALLE_CONTRACT_FILE = "docker/opencode-omo/contrat-salle.json";
