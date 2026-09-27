// Contrats serveur 1.1 (plan d'exécution §4.3, T0) : portillon des accords, crochets du proxy, dérivations d'événements, registre
// des modules, dépendances et ports. Types seulement, plus la classe PortUnavailableError levée par les ports neutres.
// Aucun paquet ne modifie ce fichier seul : un changement de contrat est une demande écrite à l'intégrateur, traitée au train
// de vague avec la liste des consommateurs prévenus (plan §2.8). Les ports rendent des CODES, jamais des phrases.
// Salle OMO (plan 2 bis §4.2, T3b) : filtre d'instance des inscriptions (`InstanceFilter`, absent = principale), instance visée
// par un relais (`ProxyContext.instance`), groupe de routes « omo », ports de la salle (OmoPorts) dans Cockpit11Ports, routeur
// d'instances et dossiers de contrôle dans Cockpit11Deps, `Cockpit11.salleOuverte`.
import type { DatabaseSync } from "node:sqlite";
import type { Context, Hono } from "hono";
import type { ArchiveService } from "./archive.ts";
import type { SessionsOccupancy } from "./assistants.ts";
import type { ModelCatalog } from "./catalog.ts";
import type { ConfigWriteQueue } from "./config-queue.ts";
// <c5:import>
import type { ConstructionModuleName, ConstructionRouteGroup } from "./construction-contracts.ts";
// </c5:import>
import type { ControlService } from "./control.ts";
import type { AppEnv } from "./env.ts";
import type { AppDeps, TierPort } from "./http.ts";
import type { EventHub, HubOmoEventMap } from "./hub.ts";
import type { Ledger } from "./ledger.ts";
import type { Logger } from "./log.ts";
import type { OcLookup } from "./oc-lookup.ts";
import type { InstanceRouter, OmoPorts, OmoRouteGroup } from "./omo-contracts.ts";
import type { OcGlobalEvent, OcSession, OpencodeClient } from "./opencode.ts";
import type { ProjectsService } from "./projects.ts";
import type { SessionTracker } from "./sessions.ts";
import type { SettingsStore } from "./settings.ts";
import type { ActivityFact, DelegationDetailsView, DelegationSource, DelegationState, FactsResponse, SessionInstance, WaitState } from "./shared/activity-types.ts";
import type { UiMode } from "./shared/assistant-rules.ts";
import type {
  ActivationRefusalCode,
  AutomaticChoice,
  AutonomyChoice,
  AutonomyErrorCode,
  AutonomyPutBody,
  AutonomyRequestView,
  ConversationAutonomyView,
  DelegationFacts,
  FloorKind,
  RelayOutcome,
  RepliedBy,
  RequestEnd,
} from "./shared/autonomy-types.ts";
import type { DelegationBanner, InternalAgentStatus, StopCause, StopResult } from "./shared/cockpit-event-types.ts";
import type { StudioService } from "./studio.ts";

// --- Portillon des accords (spécification §3.8, P9 ; extrait de http.ts par L1a, complété par L1b) ------------------------

/** Appel d'outil qui a posé une demande (tool.messageID, tool.callID). */
export interface PermissionTool {
  messageID: string;
  callID: string;
}

export interface PendingPermission {
  id: string;
  sessionID: string;
  /** null : demande posée hors d'un appel d'outil ; « invalid » : champ présent mais illisible (rien n'est vérifiable). */
  tool: PermissionTool | "invalid" | null;
}

/** Vérification avant de relayer « once » (comportement 1.0 de checkOnceReply). */
export type OnceVerdict = { ok: true } | { ok: false; status: 409 | 503; request: PendingPermission | null; orphan: boolean };

/** Réponse inscrite au registre AVANT son envoi à opencode. */
export interface EmittedReply {
  requestId: string;
  reply: "once" | "reject";
  by: RepliedBy;
  at: number;
}

/**
 * Portillon unique emprunté par toute réponse envoyée par le serveur (proxy, autonomie, garde des délégations). Sans stopTree :
 * l'arrêt de l'arbre est un port (stop-tree.ts reçoit le portillon en dépendance, aucune dépendance circulaire).
 */
export interface PermissionGate {
  /** File commune (ex-acquireReplyGate) : la fonction rendue libère la place, sans effet au second appel ; borne de 30 s. */
  acquire(): Promise<() => void>;
  pending(directory: string | null): Promise<PendingPermission[]>;
  working(directory: string | null): Promise<Set<string>>;
  checkOnce(requestId: string, directory: string | null): Promise<OnceVerdict>;
  isOrphanOfWorkingSession(requestId: string, directory: string | null): Promise<boolean>;
  rejectOrphans(requests: PendingPermission[], directory: string | null, context: Record<string, unknown>): Promise<void>;
  /** Comportement 1.0 de rejectAbortedPermissions. */
  rejectAborted(sessionId: string, directory: string | null, release: () => void): Promise<void>;
  /**
   * L1b : file → vérification « once » → inscription au registre → relais. `stillAllowed` (Salle OMO, train de V5 de la 2 ter) :
   * condition du service appelant, relue APRÈS la file et la vérification, juste avant l'inscription ; fausse (ou en erreur) →
   * « expiree », rien n'est inscrit ni envoyé. Absente : comportement L1b inchangé.
   */
  relayOnce(requestId: string, directory: string | null, by: RepliedBy, stillAllowed?: () => boolean): Promise<RelayOutcome>;
  /**
   * L1b : refus retenu tant qu'une autre demande de la même session attend (F-c) ou qu'un appel d'outil voisin du même message est
   * encore en préparation ou en cours (sa demande arriverait après la lecture), puis vérifié et envoyé une fois seul. Borne de 45 s :
   * dernière évaluation ; si une autre demande ou un appel voisin retient encore, rien n'est envoyé (« retenu ») et la demande reste
   * à l'utilisateur.
   */
  rejectWhenAlone(requestId: string, sessionId: string, directory: string | null, message: string, by: RepliedBy): Promise<RelayOutcome | "retenu">;
  /** Registre des réponses émises, inscrites avant l'envoi. */
  readonly emitted: { record(entry: EmittedReply): void; has(requestId: string): boolean };
  /**
   * Installation du module « gate » (L1b : dérivation permission.replied, réévaluation des refus retenus). Portée par l'objet
   * pour qu'aucun paquet n'édite wiring-11.ts ; absente = rien à installer.
   */
  install?(reg: Registrar, c11: Cockpit11): void;
}

export interface PermissionGateDeps {
  client: OpencodeClient;
  db: DatabaseSync;
  log: Logger;
  hub: EventHub;
  /** Arbre unique d'une conversation (sessions.descendants, L2b), utilisé par L1b. */
  sessions: SessionTracker;
}

export type CreatePermissionGate = (deps: PermissionGateDeps) => PermissionGate;

// --- Crochets du proxy, dérivations, abonnements (plan §4.3 ; instances : plan 2 bis §4.2, T3b) --------------------------------

/**
 * Instances servies par une inscription (plan 2 bis §4.2, D-2b-40). ABSENT = `["principale"]` : une inscription qui ne dit rien
 * ne sert que l'instance principale, comme en 1.0.x. Les inscriptions des modules de la salle portent `["omo"]` ; la seule
 * exception est l'inscription de démarrage d'`omoControl`, qui est côté cockpit (omo-control-module.ts).
 */
export type InstanceFilter = readonly SessionInstance[];

/** Options communes à une inscription au registre (`Registrar`). */
export interface RegistrationOptions {
  /** Instances servies ; absent : `["principale"]`. */
  instances?: InstanceFilter;
}

/** Étapes du proxy /api/oc/* ouvertes aux modules 1.1. */
export type HookStep = "createSession" | "sessionCreated" | "beforeBilledSend" | "beforeOnceRelay" | "abort";

export interface ProxyContext {
  c: Context;
  method: string;
  /** Chemin relayé sous /api/oc (par exemple « /session/ses_1/prompt_async »). */
  sub: string;
  directory: string | null;
  /** Corps JSON lu par le proxy ({} si vide). createSession peut le compléter (plancher) : le proxy envoie ce corps après les crochets. */
  body: Record<string, unknown>;
  sessionId: string | null;
  /**
   * Instance visée par le relais ; ABSENTE = instance principale (proxy /api/oc/* de http.ts, comportement 1.0.x). Le proxy de la
   * salle (oc-proxy.ts, L18b) la pose à « omo » : runHooks n'appelle alors que les crochets inscrits pour la salle.
   */
  instance?: SessionInstance;
}

/**
 * Signature d'un crochet par étape. Chaque étape est une liste ordonnée (STEP_ORDER) : la première fonction qui rend une
 * Response l'emporte et le relais n'a pas lieu ; null = continuer.
 */
export interface HookSignatures {
  /** POST /session, après forbiddenProxyBody. */
  createSession: (ctx: ProxyContext) => Promise<Response | null>;
  /** Réponse de POST /session : vérification (écart : DELETE de la session et 502 plancher-non-verifie). */
  sessionCreated: (ctx: ProxyContext, session: unknown) => Promise<Response | null>;
  /** prompt_async, command, summarize, après enforceTurn. */
  beforeBilledSend: (ctx: ProxyContext) => Promise<Response | null>;
  /** POST /permission/:id/reply « once », après checkOnce : garde du `task once` (§3.14). */
  beforeOnceRelay: (ctx: ProxyContext, requestId: string) => Promise<Response | null>;
  /** POST /session/:id/abort : racine suivie → stopTree (200 StopResult) ; sinon null (relais 1.0). */
  abort: (ctx: ProxyContext, sessionId: string) => Promise<Response | null>;
}

/** Appelée de façon synchrone avant la file du processeur ; jamais d'attente réseau : poster un travail dans sa propre file. */
export interface EventDerivation {
  readonly name: string;
  /** Instances servies ; absent : `["principale"]` (app-factory ne la branche qu'au processeur de l'instance principale). */
  readonly instances?: InstanceFilter;
  /** `origin` : instance d'où vient l'événement ; ABSENTE = instance principale (processeur 1.0.x, qui appelle avec un seul argument). */
  onEvent(event: OcGlobalEvent, origin?: { instance: SessionInstance }): void;
}

/** usage.updated : avec sessionId et rootId pour un message terminé dont le coût change ; sans eux après un rattrapage. */
export interface UsageUpdatedData {
  sessionId?: string;
  rootId?: string;
  monthSpentUsd: number;
  percent: number;
  /**
   * Instance dont le relevé change (T3c, posé par l'intégrateur au train de V2 : la table vit ici, dans le fichier de T3b).
   * ABSENTE = instance principale, exactement l'objet publié en 1.0.x. L'aiguillage des abonnés ne lit PAS ce champ : il lit
   * l'étiquette de l'enveloppe (`BrowserEvent.instance`), seule source du filtre par instance dans app-factory.ts.
   */
  instance?: SessionInstance;
}

export interface OpencodeConnectionData {
  connected: boolean;
  error: string | null;
}

/**
 * Événements existants du hub (hub.cockpit) auxquels un module 1.1 peut s'abonner. « omo.connection » vient de la table
 * `HubOmoEventMap` de hub.ts (T3c), qui reprend elle-même `OmoEventMap` du contrat de la salle (T3a) : la donnée n'est définie
 * qu'à un seul endroit. Reprise ici par l'intégrateur au train de V2, T3c n'ayant pas le droit d'écrire dans ce fichier.
 */
export interface HubEventMap {
  "usage.updated": UsageUpdatedData;
  "opencode.connection": OpencodeConnectionData;
  "omo.connection": HubOmoEventMap["omo.connection"];
}

export type HubEventType = keyof HubEventMap;

/** Groupes de routes 1.1, montés dans cet ordre juste avant le 404 de /api/* ; « omo » (T3a) en dernier. */
export type RouteGroup = "conversations" | "delegations" | "activity" | "autonomy" | "plans" | "diagnostic-11" | OmoRouteGroup | ConstructionRouteGroup; // c5

/** Registre remis à install() : chaque inscription est rangée par STEP_ORDER ; un couple absent de la table est refusé. */
export interface Registrar {
  hook<S extends HookStep>(step: S, fn: HookSignatures[S], options?: RegistrationOptions): void;
  derivation(derivation: EventDerivation): void;
  hub<K extends HubEventType>(type: K, fn: (data: HubEventMap[K]) => void, options?: RegistrationOptions): void;
  startup(fn: () => Promise<void>, options?: RegistrationOptions): void;
  routes(group: RouteGroup, fn: (app: Hono) => void, options?: RegistrationOptions): void;
}

// --- Dépendances, modules, ports ----------------------------------------------------------------------------------------------

/**
 * Dossiers de contrôle de la Salle OMO côté cockpit (L17b), remis au module `omoControl` (omo-control-module.ts). `null` : salle
 * non configurée, le service réel n'est pas construit et AUCUN fichier n'est écrit. `cockpitDataDir` n'y figure pas : la
 * suspension reste dans le dossier de données du cockpit (`env.dataDir`), hors des volumes de la salle (D-2b-29).
 */
export interface OmoControlDirs {
  /** Volume `control-omo` côté cockpit (lecture-écriture). */
  controlDir: string;
  /** Volume `omo-state` côté cockpit (lecture seule). */
  stateDir: string;
  /** Volume `omo-auth` côté cockpit (lecture-écriture). */
  authDir: string;
  /** Dossier de données de l'instance principale : source d'`auth.json`. */
  opencodeDataDir: string;
  /** `omo-projets.json` généré par install.ps1 (COCKPIT_OMO_PROJECTS_FILE) ; absent : rien n'est déposé. */
  projectsFile?: string | null;
}

/** Sac unique de dépendances, partagé par toutes les fabriques 1.1 : aucune signature de fabrique ne change ensuite. */
export interface Cockpit11Deps {
  env: AppEnv;
  log: Logger;
  db: DatabaseSync;
  client: OpencodeClient;
  hub: EventHub;
  settings: SettingsStore;
  sessions: SessionTracker;
  ledger: Ledger;
  archive: ArchiveService;
  lookup: OcLookup;
  catalog: ModelCatalog;
  tiers: TierPort;
  projects: ProjectsService;
  control: ControlService;
  configQueue: ConfigWriteQueue;
  copilotConfig: AppDeps["copilotConfig"];
  studio: StudioService;
  gate: PermissionGate;
  /**
   * Prédicat de la garde de rechargement (fourni par app-factory en L1a) : billedInFlight > 0 ou reloadBusy() → « busy »,
   * sinon sonde stricte ; jamais « unverifiable » pendant un examen.
   */
  occupancy: () => Promise<SessionsOccupancy>;
  /**
   * Routeur d'instances (T3a), posé par app-factory : les champs ci-dessus (client, gate, lookup, catalog…) restent ceux de
   * l'instance PRINCIPALE. `instances.omo` null = salle coupée : aucune inscription de la salle n'est active. Absent (tests de
   * cadre montés sans app-factory) : lu comme `omo: null`.
   */
  instances?: InstanceRouter;
  /**
   * Dossiers de contrôle de la salle remis au module `omoControl` ; absent ou null : port neutre, aucun fichier écrit, jamais.
   * Relié à `env.omo` (T3c) par l'intégrateur au train de V2.
   */
  omoControlDirs?: OmoControlDirs | null;
}

export interface Cockpit11 extends Cockpit11Deps {
  /** Ports en vigueur : un module lit toujours un autre port par c11.ports.<nom> au moment de l'appel, jamais en copie. */
  ports: Cockpit11Ports;
  /** ACTIVATION_OUVERTE (porte I1). */
  readonly activationOuverte: boolean;
  /** SALLE_OUVERTE (plan 2 bis §2.7) : faux dans le dépôt, basculé seulement dans une copie jetable de banc. */
  readonly salleOuverte: boolean;
  /** Composé par wiring-11 : ports.autonomy.examining() (false tant que L10a n'est pas installé). Branché par L1a. */
  reloadBusy(): boolean;
}

export interface Cockpit11Module {
  readonly name: ModuleName;
  /** Pose son port (c11.ports.<nom>) et ses inscriptions ; ne lit aucun autre port pendant l'installation. */
  install(reg: Registrar, c11: Cockpit11): void;
}

/** Levée par un port neutre dont l'action n'existe pas en 1.0.4 (stopTree.run, floors.createWithFloor…). */
export class PortUnavailableError extends Error {
  override name = "PortUnavailableError";
  readonly port: PortName;

  constructor(port: PortName) {
    super(`port ${port} non disponible : module 1.1 non installé`);
    this.port = port;
  }
}

/** L1c. Neutre : run lève PortUnavailableError ; aucun crochet abort (arrêt relayé comme en 1.0). */
export interface StopTreePort {
  run(rootId: string, cause: StopCause): Promise<StopResult>;
}

export interface DelegationRequestRef {
  rootId: string;
  sessionId: string;
  permissionId: string;
  directory: string | null;
}

/** L1d. Neutre : details → null ; collectDelegationFacts lève ; aucun crochet ni refus Simple. */
export interface TaskGuardPort {
  /**
   * Carte détaillée d'une délégation en attente ; null : inconnue ou hors de la conversation (route : 404). Lève si opencode ne
   * répond pas (route : 503, rien n'est deviné ; code ajouté par L1d au train it1 V3).
   */
  details(rootId: string, permissionId: string): Promise<DelegationDetailsView | null>;
  /** Exporté et documenté par L1d, réutilisé par L10e. */
  collectDelegationFacts(ref: DelegationRequestRef): Promise<DelegationFacts>;
}

/** L1e. Neutre : sans effet (la surveillance agit par ses dérivations et abonnements). */
export interface DelegationWatchPort {}

export interface FloorSessionBody {
  directory: string;
  title?: string;
  parentID?: string;
  metadata?: Record<string, unknown>;
}

/** L3. Neutre : verified → false ; createWithFloor lève ; aucun crochet. */
export interface FloorsPort {
  verified(sessionId: string): Promise<boolean>;
  createWithFloor(kind: FloorKind, body: FloorSessionBody): Promise<OcSession>;
}

/** Clé naturelle d'une délégation (UNIQUE parent_session_id, call_id) et champs posés à la création. */
export interface DelegationUpsert {
  rootId: string;
  parentSessionId: string;
  callId: string;
  agent: string;
  childSessionId?: string | null;
  command?: string | null;
  source?: DelegationSource;
  sansConfirmation?: boolean;
  permissionId?: string | null;
}

export interface WaitUpsert {
  permissionId: string;
  sessionId: string;
  rootId: string;
  permission: string;
  target?: string | null;
}

/**
 * L4b, écrivain unique des tables delegations et permission_waits. Neutre : append sans effet ; since → vide ; work.* sans
 * effet (false).
 */
export interface FactsPort {
  append(facts: readonly ActivityFact[]): void;
  since(rootId: string, since: number, limit?: number): FactsResponse;
  work: {
    /** true si la transition est appliquée (DelegationTransitions) ; false si refusée (un état final ne régresse jamais). */
    markDelegation(delegation: DelegationUpsert, etat: DelegationState, par: RepliedBy | null): boolean;
    /** true si la transition est appliquée (WaitTransitions). */
    markWait(wait: WaitUpsert, etat: WaitState, par: RepliedBy | null): boolean;
  };
}

export type AutonomyPutResult =
  | { ok: true; view: ConversationAutonomyView }
  | { ok: false; status: 400 | 403 | 404 | 409 | 428; error: AutonomyErrorCode | "invalid" | "not-found"; raison: ActivationRefusalCode | null };

/** L6a puis L10d. Neutre : get → vue « demander » ; choiceOf → « demander » ; put → 409 autonomie-indisponible (a-venir). */
export interface ConversationAutonomyPort {
  /** null : racine inconnue (404). */
  get(rootId: string): Promise<ConversationAutonomyView | null>;
  /** Lecture synchrone du choix (dérivations, crochets) ; racine inconnue : « demander ». */
  choiceOf(rootId: string): AutonomyChoice;
  /** `confirmed` : x-cockpit-confirm: 1 présent (relâcher vers un choix automatique). */
  put(rootId: string, body: AutonomyPutBody, options: { confirmed: boolean }): Promise<AutonomyPutResult>;
}

/** L6b. Neutre : aucun (les routes et le crochet beforeBilledSend des plans portent le comportement). */
export interface PlansPort {}

/** L10a. Neutre : examining → false ; aucune dérivation (tout attend l'utilisateur). */
export interface AutonomyPort {
  /** Une décision est en examen : la garde de rechargement répond « busy » (reloadBusy). */
  examining(): boolean;
}

/** L10a. Neutre : current → null ; spent → 0 ; interrupt sans effet. */
export interface RequestsPort {
  current(rootId: string): AutonomyRequestView | null;
  /** Dépense depuis le début de la demande (ledger.spentSince, L2b). */
  spent(requestId: string): number;
  interrupt(rootId: string, fin: RequestEnd): void;
}

export interface ActivationInput {
  rootId: string;
  choix: AutomaticChoice;
  agent: string | null;
  directory: string | null;
}

export type ActivationVerdict = { ok: true } | { ok: false; raison: ActivationRefusalCode };

/** L10d (effectif si ACTIVATION_OUVERTE). Neutre : check → refus « a-venir ». */
export interface ActivationPort {
  check(input: ActivationInput): Promise<ActivationVerdict>;
}

export interface DelegationPolicyInput {
  rootId: string;
  sessionId: string;
  permissionId: string;
  directory: string | null;
  mode: UiMode;
  /**
   * Sort du refus Simple, une fois connu (L10e l'envoie HORS de l'appel : la retenue F-c le garde jusqu'à 45 s tant qu'une autre
   * demande de la conversation attend). Appelé une seule fois, et seulement quand un refus a été lancé. « ok » : le refus est
   * parti ; « retenu », « echec », « deja-repondu », « expiree » : rien n'a été envoyé, la demande attend toujours votre accord.
   * Le cycle (L10a) s'en sert pour n'écrire la décision « Refusé automatiquement » au Journal qu'une fois le refus parti.
   */
  onRefusalSettled?: (relais: RelayOutcome | "retenu", regle: string | null) => void;
}

export interface DelegationPolicyVerdict {
  verdict: "auto" | "attente" | "refus";
  /** Code de règle (D1-D7), null si aucune. */
  regle: string | null;
}

/** L10e. Neutre : decide → attente. */
export interface DelegationPolicyPort {
  decide(input: DelegationPolicyInput): Promise<DelegationPolicyVerdict>;
}

/** L10c. Neutre : sans effet (plafonds, « Passé sans contrôle » et redémarrages passent par ses inscriptions). */
export interface CapWatchPort {}

export interface ControlAiInput {
  rootId: string;
  sessionId: string;
  requestId: string | null;
  /** metadata.command, texte complet. */
  command: string;
  head: string;
  relativeDir: string;
  directory: string | null;
}

/** Raison, en code, d'une IA de contrôle non consultée : la commande attend votre accord. */
export type ControlAiUnavailableCode =
  | "a-venir"
  | "desactive"
  | "ia-rapide-absente"
  | "budget-refuse"
  | "plafond-controles"
  | "facturation-suspendue"
  | "agent-non-installe";

export type ControlAiVerdict =
  | { decision: "autoriser" | "attendre"; raison: string; model: string; costUsd: number | null; ms: number }
  | { decision: "indisponible"; raison: ControlAiUnavailableCode };

/** L11b. Neutre : judge → indisponible (donc attente). */
export interface ControlAiPort {
  judge(input: ControlAiInput): Promise<ControlAiVerdict>;
}

/** L1g (classifieur) puis L11b (cockpit-controle). Neutre : ensureAll = studio.ensureClassifierAgent() avec le catch de main.ts. */
export interface InternalAgentsPort {
  ensureAll(): Promise<void>;
  status(): InternalAgentStatus[];
}

/** L1f. Neutre : delegation → []. */
export interface DiagnosticsPort {
  delegation(): Promise<DelegationBanner[]>;
}

/**
 * Ports 1.1 : ceux de l'instance principale (itérations 1 et 2) et ceux de la Salle OMO (OmoPorts, T3a), posés par T3b en
 * versions neutres. `PortName` et `ModuleName` s'étendent donc tout seuls aux modules de la salle.
 */
export interface Cockpit11Ports extends OmoPorts {
  stopTree: StopTreePort;
  taskGuard: TaskGuardPort;
  delegationWatch: DelegationWatchPort;
  floors: FloorsPort;
  facts: FactsPort;
  conversationAutonomy: ConversationAutonomyPort;
  plans: PlansPort;
  autonomy: AutonomyPort;
  requests: RequestsPort;
  activation: ActivationPort;
  delegationPolicy: DelegationPolicyPort;
  capWatch: CapWatchPort;
  controlAi: ControlAiPort;
  internalAgents: InternalAgentsPort;
  diagnostics: DiagnosticsPort;
}

export type PortName = keyof Cockpit11Ports;

/**
 * « gate » : module sans port (le portillon est une dépendance). Les autres modules portent le nom de leur port, ceux de la
 * salle compris (`OmoModuleName` ⊂ `PortName`, par OmoPorts).
 */
export type ModuleName = "gate" | PortName | ConstructionModuleName; // c5

export type { OmoModuleName } from "./omo-contracts.ts";
