// Contrat des équipes (itération 4, plan d'exécution it4 §4.1.1, T4) : TYPES UNIQUEMENT (aucun code exécuté), partagés par le
// serveur et l'interface (web/lib/types.ts les réexporte). Valeurs, tables et fonctions pures : team-limits.ts, qui porte aussi la
// liste exécutable de chaque union fermée (clés des textes de T4t, croisement de V0). Un changement de contrat après la vague 0
// est une demande écrite à l'intégrateur, traitée au train avec la liste des consommateurs prévenus (plan it4 §2.4).
// Formes de l'itération 4 (D-eq-10) : blocs « etape », « avis » et « pause » seulement ; clé JSON « avis » (jamais « regards ») ;
// ni « facultatif », ni « methodes », ni `recoit: {etapes}` (l'itération 5 ajoute « relecture » et « aiguillage »).
import type { RightLine, Rule, TaskSize, Tier, UiMode } from "./assistant-rules.ts";
import type { FLOW_LIMITS, FLOW_VERSION } from "./team-limits.ts";

// --- Déroulé ------------------------------------------------------------------------------------------------------------------

/** Ce qu'une étape reçoit en plus de sa consigne (sémantique : receivedFrom de team-limits.ts). */
export type StepInput = "demande" | "precedent" | "tous";

/** Une étape : la part d'un assistant dans une équipe. */
export interface FlowStep {
  /** /^[a-z0-9-]{1,24}$/ (STEP_ID_RE), unique dans l'équipe. */
  id: string;
  /** 2 à 60 caractères. */
  titre: string;
  /** Nom de l'assistant (agent opencode) qui fait l'étape. */
  assistant: string;
  /** Niveau d'IA choisi par l'équipe (mode Avancé seulement) ; null : IA propre de l'assistant (décision n° 3). */
  niveau: Tier | null;
  taille: TaskSize;
  /** 0 à 4 000 caractères (FLOW_LIMITS.consigne). */
  consigne: string;
  recoit: StepInput;
}

/** Bloc du déroulé, union FERMÉE (D-eq-10). `message` d'une pause : 0 à 300 caractères. */
export type FlowBlock =
  | { type: "etape"; id: string; etape: FlowStep }
  | { type: "avis"; id: string; avis: FlowStep[]; synthese: FlowStep }
  | { type: "pause"; id: string; message: string };

/** Déroulé d'une équipe, JSON « Flow v1 » (colonne teams.flow). */
export interface Flow {
  version: typeof FLOW_VERSION;
  blocs: FlowBlock[];
}

export type FlowLimits = typeof FLOW_LIMITS;

/**
 * Une étape dans l'ordre d'exécution (planSteps). `blocIndex` : rang du bloc dans `flow.blocs` (pauses comprises, à partir de 0) ;
 * `ordre` : rang d'exécution à partir de 1 ; `tour` : 1 en itération 4.
 */
export interface PlannedOrder {
  stepId: string;
  blocId: string;
  blocIndex: number;
  ordre: number;
  tour: 1;
  role: "etape" | "avis" | "synthese";
}

// --- Assistants d'étape -------------------------------------------------------------------------------------------------------

/** Assistant vu par le pré-lancement : règles effectives d'opencode, profil de droits et origine lus dans item_meta. */
export interface StepAssistant {
  name: string;
  title: string;
  origin: "catalogue" | "cree" | "studio" | "natif" | "interne";
  rights: "lecture" | "propose" | "personnalise" | "integre";
  mode: "primary" | "subagent" | "all";
  hidden: boolean;
  /** Règles effectives (GET /agent). */
  rules: Rule[];
  /** IA propre de l'assistant (« fournisseur/IA »), null sans IA propre. */
  model: string | null;
  /** Assistant installé et proposable (IA propre au catalogue et disponible, P1). */
  available: boolean;
  /** Actions maximum (`steps` de l'agent), null si absent. */
  steps: number | null;
  taille: TaskSize | null;
}

// --- Problèmes du déroulé -----------------------------------------------------------------------------------------------------

export type FlowProblemCode =
  | "vide"
  | "trop-de-blocs"
  | "trop-d-etapes"
  | "pause-mal-placee"
  | "avis-nombre"
  | "synthese-requise"
  | "id-invalide"
  | "id-double"
  | "titre"
  | "consigne-longue"
  | "recoit-invalide"
  | "assistant-absent"
  | "assistant-interne"
  | "assistant-non-proposable"
  | "delegue"
  | "internet"
  | "autorise-sans-demander"
  | "propose-reporte"
  | "personnalise"
  | "niveau-avance"
  | "niveau-indisponible";

/** Problème du déroulé ; le texte est dans team-texts.ts (T4t), par code. */
export interface FlowProblem {
  code: FlowProblemCode;
  /** Identifiant du bloc concerné, null pour un problème de l'équipe entière. */
  bloc: string | null;
  /** Identifiant de l'étape concernée, null pour un problème de bloc ou d'équipe. */
  etape: string | null;
  /** Bloquant : l'équipe ne peut être ni enregistrée ni lancée. */
  bloquant: boolean;
  /** Nom de l'assistant concerné. */
  nom?: string;
  /** Niveau d'IA concerné (niveau-indisponible). */
  niveau?: Tier;
}

// --- Estimation ---------------------------------------------------------------------------------------------------------------

/** Estimation d'une étape (dollars). `typique` et `maximum` nuls : prix de l'IA inconnu (étape marquée). */
export interface StepEstimate {
  stepId: string;
  titre: string;
  assistant: string;
  model: string | null;
  modelLabel: string | null;
  niveau: Tier | null;
  /** IA choisie par l'équipe (mode Avancé : « IA de l'étape : … (choisie par l'équipe) »). */
  choisieParEquipe: boolean;
  typique: number | null;
  maximum: number | null;
  /** « observe » : moyenne d'au moins OBSERVED_MIN_SAMPLES étapes terminées ; « profil » : profil de taille. */
  source: "observe" | "profil";
}

/** Estimation d'un déroulé (dollars) : « en général » = typique, « au plus » = maximum = plafond d'arrêt (P3). */
export interface FlowEstimate {
  typique: number;
  maximum: number;
  plafond: number;
  etapesFacturees: number;
  /** Dépassement possible au plafond : un appel par étape en cours, sur les étapes simultanées les plus chères. */
  depassementUnAppel: number;
  /** Coût des résultats relayés d'une étape à l'autre (receivedFrom). */
  relais: number;
  parEtape: StepEstimate[];
}

// --- Affichage ----------------------------------------------------------------------------------------------------------------

/** Ligne de la disposition du schéma (par les données, identifiants stables). */
export interface FlowRow {
  /** Identifiant du bloc. */
  bloc: string;
  kind: "etape" | "avis" | "synthese" | "pause";
  cellules: Array<{ stepId: string | null; titre: string; sousTitre: string }>;
  /** Identifiants des étapes dont cette ligne reçoit le résultat. */
  recoitDe: string[];
}

// --- États --------------------------------------------------------------------------------------------------------------------

/** État d'un lancement (colonne team_runs.state). */
export type TeamRunState =
  | "preparation"
  | "en-cours"
  | "attente-verification"
  | "attente-budget"
  | "attente-modification"
  | "terminee"
  | "arretee"
  | "echec"
  | "interrompue"
  | "plafond";

/** État d'une étape, par tentative (colonne team_run_steps.state). */
export type TeamStepState =
  | "prevue"
  | "en-file"
  | "en-cours"
  | "attente-accord"
  | "terminee"
  | "echec"
  | "arretee"
  | "interrompue"
  | "plafond"
  | "non-lancee";

/**
 * Cause d'un état de lancement. « changement » : état d'opencode changé entre l'estimation et le lancement (contrôle de fraîcheur,
 * D-eq-17).
 */
export type TeamRunCause =
  | "vous"
  | "equipe"
  | "plafond"
  | "echec"
  | "rechargement"
  | "redemarrage-cockpit"
  | "budget"
  | "modification"
  | "pause"
  | "changement";

/** États finaux d'un lancement : aucune transition n'en sort. */
export type TeamRunFinalState = "terminee" | "arretee";

/** Lancements arrêtés en chemin : seulement la relance (« preparation », nouvelle tentative) ou la fermeture (« arretee »). */
export type TeamRunStoppedState = "echec" | "interrompue" | "plafond";

/** États finaux d'une étape (une relance crée une nouvelle tentative : la ligne finale ne change plus). */
export type TeamStepFinalState = "terminee" | "echec" | "arretee" | "interrompue" | "plafond" | "non-lancee";

/** Forme de TEAM_RUN_TRANSITIONS : un état final ne régresse jamais, aucun état ne se cite lui-même. */
export type TeamRunTransitions = {
  readonly [S in TeamRunState]: S extends TeamRunFinalState
    ? readonly []
    : S extends TeamRunStoppedState
      ? readonly ("preparation" | "arretee")[]
      : readonly Exclude<TeamRunState, S>[];
};

/** Forme de TEAM_STEP_TRANSITIONS : un état final ne régresse jamais, aucun état ne se cite lui-même. */
export type TeamStepTransitions = {
  readonly [S in TeamStepState]: S extends TeamStepFinalState ? readonly [] : readonly Exclude<TeamStepState, S>[];
};

// --- Vues ---------------------------------------------------------------------------------------------------------------------

/** Équipe installée (GET /api/teams). `etat` : « a-completer » si un assistant manque, « avance » hors grammaire Simple. */
export interface TeamView {
  id: string;
  titre: string;
  description: string;
  flow: Flow;
  forme: "a-la-suite" | "avis" | "mixte";
  origine: "exemple" | "creee" | "dupliquee";
  exempleId: string | null;
  etat: "ok" | "a-completer" | "avance";
  estimate: FlowEstimate | null;
  layout: FlowRow[];
  liste: string[];
  droits: RightLine[];
  dernierLancement: { at: number; cost: number } | null;
}

export interface TeamExampleView {
  id: string;
  titre: string;
  description: string;
  flow: Flow;
  installee: boolean;
  /** Assistants du catalogue que l'installation ajoute. */
  assistantsManquants: string[];
  layout: FlowRow[];
  liste: string[];
}

export interface TeamsListResponse {
  teams: TeamView[];
  exemples: TeamExampleView[];
  /** EQUIPES_SIMPLE_OUVERTES (décision U1) : false tant que les recettes du §7.11 n° 4 ne sont pas faites. */
  ouvertesEnSimple: boolean;
}

/** Étape d'un lancement, par tentative. */
export interface StepRunView {
  stepId: string;
  blocIndex: number;
  ordre: number;
  tour: number;
  tentative: number;
  titre: string;
  assistant: string;
  assistantTitre: string;
  ia: { model: string | null; label: string | null; variant: string | null; choisieParEquipe: boolean };
  state: TeamStepState;
  /** Code de la cause (TeamRunCause) ou raison d'un échec ; null sans cause. */
  cause: string | null;
  sessionId: string | null;
  queuedAt: number | null;
  startedAt: number | null;
  endedAt: number | null;
  cost: number;
  /** Actions maximum atteintes : réponse peut-être incomplète. */
  tronquee: boolean;
  /** Extrait du résultat (2 000 caractères au plus, secrets masqués) ; null avant la fin ou après la suppression. */
  extrait: string | null;
  droits: RightLine[];
}

/**
 * Pause d'un lancement. « changement » : pause du contrôle de fraîcheur, avant toute injection et toute étape (`blocId` nul,
 * `changement` rempli avec le code du contrôle).
 */
export interface TeamPauseView {
  kind: "verification" | "budget" | "modification" | "redemarrage-cockpit" | "changement";
  blocId: string | null;
  message: string;
  /** Résultat transmis à la suite (modifiable : « Résumé transmis »). */
  resultat: { etape: string; titre: string; texte: string } | null;
  /** Coût du reste du chemin. */
  suite: { typique: number; maximum: number };
  changement: { code: TeamErrorCode; details?: Record<string, unknown> } | null;
}

export interface TeamRunView {
  id: string;
  teamId: string | null;
  titre: string;
  rootId: string;
  directory: string;
  state: TeamRunState;
  cause: TeamRunCause | null;
  modeUi: UiMode | null;
  /** Estimation retenue au lancement (colonnes estimate_typique, estimate_max). */
  estimate: { typique: number; maximum: number } | null;
  plafond: number | null;
  cost: number;
  steps: StepRunView[];
  pause: TeamPauseView | null;
  relancable: boolean;
  /** Coût du chemin restant (suiteEstimate, calcul local sans lecture d'opencode) : libellé [Relancer la suite (≈ x $)]. */
  suite: { typique: number; maximum: number } | null;
  resultatsAjoutes: boolean;
  /**
   * Identifiants des messages injectés (colonnes request_message_id et result_message_id) : seule preuve admise pour rendre un
   * message de la transcription comme message d'équipe (L38c).
   */
  requestMessageId: string | null;
  resultMessageId: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

/** Résumé d'un lancement (ActivityResponse.runs). */
export interface TeamRunSummary {
  id: string;
  titre: string;
  state: TeamRunState;
  cause: TeamRunCause | null;
  cost: number;
  plafond: number | null;
  createdAt: number;
  endedAt: number | null;
  etapesPrevues: number;
  etapesTerminees: number;
}

// --- Corps et réponses des routes ---------------------------------------------------------------------------------------------

/** PUT /api/teams/:id : titre 3 à 80 caractères, description 0 à 300. */
export interface TeamPutBody {
  titre: string;
  description: string;
  flow: Flow;
}

export interface TeamPreviewBody {
  flow: Flow;
  titre?: string;
  description?: string;
}

export interface TeamPreviewResponse {
  problems: FlowProblem[];
  estimate: FlowEstimate | null;
  droits: RightLine[];
  layout: FlowRow[];
  liste: string[];
}

export interface TeamEstimateBody {
  directory: string;
  /** Conversation existante, null : nouvelle conversation. */
  rootId: string | null;
}

/** Confirmation qu'un lancement peut demander dans son corps (P6, le garde-fou budgétaire, passe par x-cockpit-confirm: 1). */
export type TeamConfirmation = "workspace" | "secret" | "plafond" | "budget";

export interface TeamEstimateResponse {
  estimate: FlowEstimate;
  /** Empreinte de l'estimation (D-eq-19), liée à l'instantané des lectures (D-eq-17). */
  estimateSha256: string;
  problems: FlowProblem[];
  plafond: number;
  confirmations: TeamConfirmation[];
  /** Refus prévisible constaté sur les lectures de l'estimation (affiché avant tout clic) ; null sinon. */
  blocage: { status: 403 | 409 | 422; code: TeamErrorCode; details?: Record<string, unknown> } | null;
  /** Fin de validité de l'instantané (horodatage en millisecondes). */
  expireA: number;
  /** Dépense déjà faite par le lancement : relance seulement, sinon null. */
  deja: number | null;
}

/**
 * POST /api/teams/:id/run. `confirmations.budget` : P7 budget-insuffisant ; `confirmations.plafond` : P8 plafond-a-confirmer ;
 * la confirmation du garde-fou budgétaire P6 (budget-guard) passe par l'en-tête x-cockpit-confirm: 1, comme les envois de la 1.1.
 */
export interface TeamRunBody {
  directory: string;
  rootId: string | null;
  /** 20 000 caractères au plus (FLOW_LIMITS.demande). */
  demande: string;
  /** Chemins seulement (D-eq-18), 20 au plus, 512 caractères chacun. */
  fichiers: string[];
  /** Assistant de la conversation (injections noReply) : ni sous-agent, ni interne, ni caché. */
  agentConversation: string;
  estimateSha256: string;
  confirmations: { workspace?: true; secret?: true; plafond?: true; budget?: true };
}

export interface TeamRunStarted {
  runId: string;
  rootId: string;
}

/** POST /api/team-runs/:runId/continue : précision 1 000 caractères au plus ; correction du résumé transmis. */
export interface TeamContinueBody {
  precision?: string;
  correction?: string;
}

export interface TeamRelaunchBody {
  estimateSha256: string;
}

/** POST /api/teams/examples/:id/install. */
export interface TeamInstallResponse {
  team: TeamView;
  /** Assistants du catalogue installés par cet appel. */
  assistantsInstalles: string[];
}

/** GET /api/team-runs?rootId= et ?sessionId=. */
export interface TeamRunsResponse {
  runs: TeamRunView[];
}

/** POST /api/team-runs/:runId/ajouter-resultats. */
export interface TeamAddResultsResponse {
  messageId: string;
}

// --- Codes --------------------------------------------------------------------------------------------------------------------

/** Codes d'erreur des routes d'équipe (phrases dans team-texts.ts, T4t). « opencode-injoignable » : estimation, 502. */
export type TeamErrorCode =
  | "invalid"
  | "not-found"
  | "equipe-invalide"
  | "mode-avance"
  | "equipes-simple-fermees"
  | "forbidden-directory"
  | "fichier-refuse"
  | "fournisseur-refuse"
  | "ia-indisponible"
  | "assistant-absent"
  | "equipe-en-cours"
  | "conversation-occupee"
  | "instance-salle"
  | "trop-d-equipes"
  | "budget-guard"
  | "budget-insuffisant"
  | "plafond-trop-haut"
  | "plafond-a-confirmer"
  | "confirmation-workspace"
  | "secret-probable"
  | "estimation-perimee"
  | "profondeur-delegation"
  | "extension-configuree"
  | "dossier-externe"
  | "plancher-etape"
  | "etape-consultable"
  | "etat-incompatible"
  | "pas-relancable"
  | "deja-ajoute"
  | "confirmation-requise"
  | "opencode-injoignable"
  | "a-venir";

/**
 * Codes rendus tels quels, avec leur message, par la garde de rechargement de la 1.1 (reload-guard.ts) sur la route
 * d'installation d'un exemple : ce ne sont pas des TeamErrorCode, et T4t n'écrit aucun texte pour eux. « salle-coupee » n'est
 * pas non plus un TeamErrorCode (code de la route de la carte, L39a).
 */
export type TeamGuardCode = "sessions-busy" | "redemarrage-en-cours" | "reponses-non-verifiables";

/** Corps d'un refus d'une route d'équipe. */
export interface TeamErrorBody {
  error: TeamErrorCode | TeamGuardCode;
  message: string;
  details?: Record<string, unknown>;
  /** 422 equipe-invalide. */
  problems?: FlowProblem[];
}

// --- Événements et injection --------------------------------------------------------------------------------------------------

/** Événements SSE des équipes (hub.cockpit, publiés par emitEquipe de team-events.ts ; CockpitEventMap n'est pas modifiée). */
export interface EquipeEventMap {
  "equipe.lancement": { runId: string; rootId: string; state: TeamRunState; cause: TeamRunCause | null };
  "equipe.etape": { runId: string; rootId: string; stepId: string; tour: number; tentative: number; state: TeamStepState; sessionId: string | null };
}

export type EquipeEventType = keyof EquipeEventMap;

/** Injection de la demande et du résultat (D-eq-14) : messages noReply, ou repli « carte seule » + [Ajouter à la conversation]. */
export type EquipesInjection = "noReply" | "carte-seule";
