// Contrats serveur des équipes (itération 4, plan d'exécution it4 §4.1.2, T4, D-eq-02) : dépendances, registre des modules,
// verrou du proxy et des Archives, types des ports et formes des lignes de la migration 4. Types seulement, plus la classe
// EqPortUnavailableError levée par un port neutre dont l'action n'a pas de refus en code. Réutilise EventDerivation, HubEventMap,
// StopTreePort et Cockpit11 de contracts-11.ts sans jamais les modifier. Un changement de contrat après la vague 0 est une demande
// écrite à l'intégrateur, traitée au train (plan it4 §2.4). Les ports rendent des CODES, jamais des phrases.
import type { Hono } from "hono";
import type { AssistantService } from "./assistants.ts";
import type { Classifier } from "./classifier.ts";
import type { Cockpit11, EventDerivation, HubEventMap, HubEventType, StopTreePort } from "./contracts-11.ts";
import type { RightLine, Rule, TaskSize, UiMode } from "./shared/assistant-rules.ts";
import type { StopCause, StopResult } from "./shared/cockpit-event-types.ts";
import type {
  EquipesInjection,
  Flow,
  FlowEstimate,
  StepAssistant,
  TeamContinueBody,
  TeamErrorCode,
  TeamEstimateBody,
  TeamEstimateResponse,
  TeamRunBody,
  TeamRunCause,
  TeamRunStarted,
  TeamRunState,
  TeamRunView,
  TeamStepState,
} from "./shared/team-types.ts";

// --- Dépendances --------------------------------------------------------------------------------------------------------------

/**
 * Dépendances des modules d'équipes. Tout le reste se lit dans `c11` au moment de l'appel (ports compris). `assistants` ne sert
 * qu'à l'installation des exemples (L37a) : Cockpit11Deps n'a pas d'AssistantService et AppDeps.assistants n'est typé qu'en
 * AssistantsPort. ATTENTION : AssistantService.install() n'a AUCUNE garde de rechargement propre ; son appelant pose la garde.
 */
export interface EqDeps {
  c11: Cockpit11;
  classifier: Pick<Classifier, "onIdle">;
  assistants: Pick<AssistantService, "install">;
}

// --- Verrou du proxy et des Archives (D-eq-04) --------------------------------------------------------------------------------

/**
 * Requête soumise au verrou des équipes. `entree: "proxy"` : en tête du gestionnaire /api/oc/* (après authentification et CSRF,
 * avant la lecture du corps) ; `sessionId` et `permissionId` lus par SESSION_ROUTE et PERMISSION_REPLY_ROUTE ; `directory` : dossier
 * de la requête s'il est dans le workspace, sinon null. `entree: "archive"` : DELETE /api/archive/:id, `sessionId` validé par
 * shared/ids.ts, `sub` vide.
 */
export interface TeamProxyGuardRequest {
  entree: "proxy" | "archive";
  method: string;
  sub: string;
  directory: string | null;
  sessionId: string | null;
  permissionId: string | null;
}

/** Réponse non nulle : rendue telle quelle, rien n'est relayé ni supprimé ; null : la route continue comme avant. */
export type TeamProxyGuard = (req: TeamProxyGuardRequest) => Promise<Response | null>;

// --- Formes des lignes (migration 4 de db.ts, lue sans l'écrire) --------------------------------------------------------------

/** Ligne de `teams`. `flow` : JSON « Flow v1 » ; `avance` : 1 = hors de la grammaire du mode Simple. */
export interface TeamRow {
  id: string;
  titre: string;
  description: string;
  flow: string;
  origine: "exemple" | "creee" | "dupliquee";
  exemple_id: string | null;
  exemple_version: number | null;
  avance: number;
  created_at: number;
  updated_at: number;
}

/**
 * Ligne de `team_runs`. JSON en texte : `flow`, `facultatifs` (« [] » en itération 4), `confirmations`, `precisions` (vidée à la
 * suppression de la conversation). `state` et `cause` : écrits par le magasin seulement (canTransition).
 */
export interface RunRow {
  id: string;
  team_id: string | null;
  team_titre: string;
  flow: string;
  flow_sha256: string;
  estimate_sha256: string | null;
  mode_ui: UiMode | null;
  root_session_id: string;
  directory: string;
  request_message_id: string | null;
  result_message_id: string | null;
  state: TeamRunState;
  cause: TeamRunCause | null;
  facultatifs: string;
  estimate_typique: number | null;
  estimate_max: number | null;
  plafond: number | null;
  cost: number;
  confirmations: string;
  precisions: string;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
}

/**
 * Ligne de `team_run_steps`, clé (run_id, step_id, tour, tentative). `message_text` : texte exact envoyé à l'étape, vidé à la
 * suppression de la conversation, JAMAIS journalisé (U2, D-eq-26 : un journal ne cite que `message_sha256`). `result_excerpt` :
 * vidé aussi. `rights`, `right_lines` : JSON en texte.
 */
export interface StepRow {
  run_id: string;
  step_id: string;
  tour: number;
  tentative: number;
  ordre: number;
  bloc_index: number;
  titre: string;
  agent: string;
  agent_file_sha256: string | null;
  rules_sha256: string | null;
  floor_sha256: string | null;
  rights: string | null;
  right_lines: string | null;
  model: string | null;
  variant: string | null;
  steps: number | null;
  session_id: string | null;
  state: TeamStepState;
  cause: string | null;
  tronquee: number;
  message_sha256: string | null;
  message_text: string | null;
  correction_sha256: string | null;
  result_excerpt: string | null;
  verdict: string | null;
  choix: string | null;
  queued_at: number | null;
  started_at: number | null;
  ended_at: number | null;
  cost: number;
}

/** Ligne de `team_run_events` ; `data` : JSON en texte, jamais un texte de message. */
export interface EventRow {
  id: number;
  run_id: string;
  kind: string;
  par: "vous" | "cockpit";
  data: string;
  at: number;
}

// --- Types des ports ----------------------------------------------------------------------------------------------------------

/**
 * Entrée du pré-lancement. `confirmed` : en-tête x-cockpit-confirm: 1 (garde-fou budgétaire P6). `relance` (L37c) : `restantes` =
 * étapes non terminées dans l'ordre de planSteps, `depense` = spentOfRun(runId) ; en relance, `body` est reconstitué LOCALEMENT
 * (dossier, racine et confirmations d'origine lus en base ; demande et fichiers par requestFromStepMessage sur le `message_text`
 * d'une étape QUI A REÇU LA DEMANDE, D-eq-27 ; textes purgés → pas-relancable), `body.estimateSha256` vient de TeamRelaunchBody,
 * P4 ignore ce lancement lui-même, l'estimation porte sur `restantes` seulement et plafond = depense + maximum du reste.
 */
export interface PreflightInput {
  team: TeamRow;
  body: TeamRunBody;
  mode: UiMode;
  confirmed: boolean;
  relance?: { runId: string; restantes: string[]; depense: number };
}

/** Estimation : 502 opencode-injoignable quand les lectures sont impossibles (aucun instantané gardé). */
export type EstimateOutcome =
  | { ok: true; response: TeamEstimateResponse }
  | { ok: false; status: 400 | 403 | 404 | 409 | 422 | 502; code: TeamErrorCode; details?: Record<string, unknown> };

/** Étape du plan de lancement : instantané P11 (règles effectives, fichier d'agent, plancher ETAPE, droits, IA). */
export interface PlannedStep {
  stepId: string;
  blocIndex: number;
  ordre: number;
  titre: string;
  assistant: string;
  /** Règles effectives de l'assistant (GET /agent), à l'estimation. */
  agentRules: Rule[];
  rulesSha256: string;
  /** SHA-256 du fichier d'agent (lecture locale par le Studio) ; null : assistant natif ou fichier illisible. */
  agentFileSha256: string | null;
  /** buildFloor("ETAPE", {agentRules, truncateGlob}) et son empreinte floorHash. */
  floor: Rule[];
  floorSha256: string;
  /** rightLines des règles ++ plancher. */
  droits: RightLine[];
  model: string;
  variant: string | null;
  steps: number | null;
  taille: TaskSize;
}

/**
 * Instantané de l'estimation (interne à L37p, JAMAIS exporté vers le web) : lectures d'opencode faites par l'estimation et
 * réutilisées par le pré-lancement (D-eq-17). 10 min de validité, 32 au plus (le plus ancien sort), en mémoire seulement, jamais
 * écrit en base ni journalisé ; ne contient ni la demande ni les fichiers.
 */
export interface EstimateSnapshot {
  estimateSha256: string;
  teamId: string;
  /** Lancement relancé, null pour un premier lancement. */
  runId: string | null;
  directory: string;
  rootId: string | null;
  mode: UiMode;
  at: number;
  assistants: ReadonlyMap<string, StepAssistant>;
  agents: Array<{ name: string; mode: "primary" | "subagent" | "all"; hidden: boolean }>;
  config: { subagentDepth: number; mcp: boolean; plugin: boolean };
  /** Racine occupée à l'estimation ; null sans racine. */
  rootBusy: boolean | null;
  etapes: PlannedStep[];
}

/** Plan rendu par le pré-lancement accepté : rien n'est créé, ni racine ni session. */
export interface RunPlan {
  flow: Flow;
  flowSha256: string;
  estimate: FlowEstimate;
  estimateSha256: string;
  plafond: number;
  rootId: string | null;
  directory: string;
  modeUi: UiMode;
  agentConversation: string;
  /** IA de la conversation pour les injections : lastChatChoice, sinon l'IA propre de l'assistant, sinon null (champ omis). */
  iaConversation: { model: string; variant: string | null } | null;
  etapes: PlannedStep[];
}

/** Pré-lancement : ni 428 (rendu par la route de relance avant check), ni 502 (check ne lit rien). */
export type PreflightOutcome =
  | { ok: true; plan: RunPlan }
  | { ok: false; status: 400 | 403 | 404 | 409 | 422; code: TeamErrorCode; details?: Record<string, unknown> };

/** Contrôle de fraîcheur (après l'acceptation) : règles changées → « modification », autre écart → « changement » avec son code. */
export type RecheckOutcome =
  | { ok: true }
  | { ok: false; genre: "modification" }
  | { ok: false; genre: "changement"; code: TeamErrorCode; details?: Record<string, unknown> };

/** Refus du runner. Un succès rend l'objet attendu, sans champ `ok` : l'appelant discrimine par `ok === false`. */
export interface RunnerRefusal {
  ok: false;
  status: 403 | 404 | 409 | 428;
  code: TeamErrorCode;
  details?: Record<string, unknown>;
}

// --- Ports (défaut neutre dans wiring-eq.ts) ----------------------------------------------------------------------------------

/** L37a. Neutre : get → null ; estimate → refus a-venir. */
export interface TeamsPort {
  get(id: string): TeamRow | null;
  estimate(teamId: string, body: TeamEstimateBody, mode: UiMode): Promise<EstimateOutcome>;
}

/**
 * L37p. `estimate` : SEUL point du pré-lancement qui lit opencode (A4), garde l'instantané ; `check` n'émet AUCUNE requête (corps,
 * base, système de fichiers, réglages, catalogue et instantané seulement : jamais lookup, client ni une fonction qui peut en
 * émettre) ; `recheck` : contrôle de fraîcheur appelé par le runner APRÈS l'acceptation, jamais par une route de refus. Neutre :
 * assistants → carte vide ; estimate, check → refus a-venir ; recheck → changement a-venir.
 */
export interface TeamPreflightPort {
  assistants(directory: string): Promise<ReadonlyMap<string, StepAssistant>>;
  estimate(team: TeamRow, body: TeamEstimateBody, mode: UiMode, relance?: { runId: string }): Promise<EstimateOutcome>;
  check(input: PreflightInput): Promise<PreflightOutcome>;
  recheck(plan: RunPlan, rootId: string): Promise<RecheckOutcome>;
}

/**
 * L37b (et L37c pour relaunch, close, addResults par ses routes). Neutre : launch lève EqPortUnavailableError ; continue, relaunch,
 * close, addResults → refus a-venir ; view, runOfStepSession, activeRunOf, stepOf → null ; runsOf → [] ; stepsBusy → false ;
 * stopRequested, stopped, interrupt sans effet. `stepsBusy` (D-eq-06) : vrai tant qu'une équipe est « preparation » ou « en-cours »
 * ou qu'une étape est « en-file », « en-cours » ou « attente-accord » ; faux pendant les pauses « attente-* ».
 */
export interface TeamRunnerPort {
  launch(plan: RunPlan, body: TeamRunBody): Promise<TeamRunStarted>;
  continue(runId: string, body: TeamContinueBody, confirmed: boolean): Promise<TeamRunView | RunnerRefusal>;
  view(runId: string): TeamRunView | null;
  runsOf(rootId: string): TeamRunView[];
  runOfStepSession(sessionId: string): TeamRunView | null;
  activeRunOf(rootId: string): { runId: string; state: TeamRunState } | null;
  stepOf(sessionId: string): { runId: string; stepId: string } | null;
  stepsBusy(): boolean;
  /** Appelé par le décorateur de stopTree AVANT l'arrêt interne : plus aucune étape lancée (D-eq-05). */
  stopRequested(rootId: string, cause: StopCause): void;
  /** Appelé par le décorateur APRÈS l'arrêt ; `result` null si l'arrêt a échoué. */
  stopped(rootId: string, cause: StopCause, result: StopResult | null): void;
  interrupt(runId: string, cause: TeamRunCause): void;
  relaunch(runId: string, plan: RunPlan): Promise<TeamRunView | RunnerRefusal>;
  close(runId: string): TeamRunView | RunnerRefusal;
  addResults(runId: string): Promise<{ messageId: string } | RunnerRefusal>;
}

/** L37c. Neutre : proxyGuard → null ; stopForCap sans effet. */
export interface TeamGuardsPort {
  proxyGuard: TeamProxyGuard;
  stopForCap(runId: string): Promise<void>;
}

export interface EqPorts {
  teams: TeamsPort;
  preflight: TeamPreflightPort;
  runner: TeamRunnerPort;
  guards: TeamGuardsPort;
}

export type EqPortName = keyof EqPorts;

/** Levée par un port neutre dont l'action n'a pas de refus en code (runner.launch). */
export class EqPortUnavailableError extends Error {
  override name = "EqPortUnavailableError";
  readonly port: EqPortName;

  constructor(port: EqPortName) {
    super(`port d'équipes ${port} non disponible : module de l'itération 4 non installé`);
    this.port = port;
  }
}

// --- Modules et registre ------------------------------------------------------------------------------------------------------

/** Modules d'équipes ; « agentMap » n'a pas de port (routes seulement). */
export type EqModuleName = "agentMap" | "teams" | "teamPreflight" | "teamRunner" | "teamGuards";

/** Groupes de routes d'équipes, montés après ceux de la 1.1, avant le 404 de /api/*. */
export type EqRouteGroup = "agent-map" | "teams" | "team-runs";

/** Registre remis à install() : chaque inscription est rangée par EQ_STEP_ORDER ; un couple absent de la table est refusé. */
export interface EqRegistrar {
  /** Dérivation synchrone, ajoutée au processeur après celles de la 1.1 ; jamais d'attente réseau. */
  derivation(derivation: EventDerivation): void;
  hub<K extends HubEventType>(type: K, fn: (data: HubEventMap[K]) => void): void;
  /** Démarrage, après celui de la 1.1. */
  startup(fn: () => Promise<void>): void;
  routes(group: EqRouteGroup, fn: (app: Hono) => void): void;
  /** Verrou appelé à l'entrée du proxy et avant DELETE /api/archive/:id (D-eq-04). */
  proxyGuard(fn: TeamProxyGuard): void;
  /** Décorateur de c11.ports.stopTree, posé par apply (D-eq-05). */
  stopTreeDecorator(fn: (inner: StopTreePort) => StopTreePort): void;
  /** Prédicat composé dans c11.reloadBusy par apply (D-eq-06). */
  reloadBusy(fn: () => boolean): void;
}

/**
 * Contexte des modules. `simpleOuvertes` : EQUIPES_SIMPLE_OUVERTES (décision U1), surchargé par les tests seulement ;
 * `injection` : EQUIPES_INJECTION (D-eq-14). Un module lit un autre port par eq.ports.<nom> au moment de l'appel, jamais en copie.
 */
export interface EqContext extends EqDeps {
  ports: EqPorts;
  readonly simpleOuvertes: boolean;
  readonly injection: EquipesInjection;
}

export interface EqModule {
  readonly name: EqModuleName;
  /** Pose son port (eq.ports.<nom>) et ses inscriptions ; ne lit aucun autre port pendant l'installation. */
  install(reg: EqRegistrar, eq: EqContext): void;
}
