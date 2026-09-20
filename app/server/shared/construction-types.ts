// Contrats de la construction (itération 5, plan d'exécution it5 §4.2, T5a ; spécification §2.1, §3.7, §5.3, §5.9 ; C §3, §9.7,
// §9.9 à §9.14 ; RM §5) : méthodes, Seconde lecture, chronologie, coûts par équipe et archives d'équipe. Types SEULEMENT : ce
// fichier ne contient aucun code exécutable (règle des *-types.ts de core.test.ts) et n'importe que des types voisins.
// Les modules qui les servent (methods-service.ts, second-reading.ts, routes-chronologie.ts, team-costs.ts) arrivent en V1 et V2 ;
// T5a n'écrit aucun comportement.
import type { ActorState, SessionRole } from "./activity-types.ts";

// --- Méthodes (C §5.4, RM §5.2, D-5-07) ------------------------------------------------------------------------------------

/** « consigne » : bloc ajouté aux consignes de l'assistant ; « relecture » : liste de contrôle, sans bloc. */
export type MethodKind = "consigne" | "relecture";

/** Assistant cité par une méthode : nom d'agent opencode et titre affiché. */
export interface AssistantRef {
  name: string;
  title: string;
}

/**
 * Méthode du catalogue, vue par l'interface. `bloc` est le texte inséré dans les consignes (vide pour `kind: "relecture"`) ;
 * `enTete` est le commentaire balisé qui l'ouvre. `sources` reste vide en mode Simple (spécification §2.3).
 */
export interface MethodView {
  id: string;
  version: number;
  titre: string;
  phrase: string;
  quand: string;
  attention: string;
  kind: MethodKind;
  bloc: string;
  enTete: string;
  sources: string[];
  utiliseePar: AssistantRef[];
  /** `attachee` : la méthode est déjà dans les consignes de cet assistant. */
  conseilleePour: Array<{ name: string; title: string; attachee: boolean }>;
}

/** Réponse de GET /api/methods (L44b) ; `limites` reprend les valeurs de construction-constants.ts. */
export interface MethodsResponse {
  methods: MethodView[];
  limites: { parAssistant: number; parMessage: number; parEtape: number };
}

// --- Seconde lecture (C §9.7, RM §5.4, D-5-06, D-5-22) ----------------------------------------------------------------------

/** Objet relu : la réponse précédente d'un assistant, ou le résultat d'une équipe. */
export type SecondReadingTarget = "reponse" | "equipe";

export interface SecondReadingEstimateBody {
  directory: string;
  sessionId: string;
  cible: SecondReadingTarget;
}

/**
 * Estimation du coût d'une seconde lecture (D-5-22 : « ≈ {x} $ », jamais un minimum). `base`, dans l'ordre de préférence :
 * « conversation » (longueur actuelle, dernier appel d'IA enregistré de la session, réponse comprise), « observe » (moyenne
 * observée, 5 échantillons au moins), « profil » (profil S) ; « aucune » : aucune estimation, `usd` vaut null.
 */
export interface SecondReadingEstimate {
  installe: boolean;
  assistant: AssistantRef | null;
  ia: { model: string; libelle: string } | null;
  usd: number | null;
  base: "conversation" | "observe" | "profil" | "aucune";
}

// --- Chronologie (Avancé seulement, D-5-09) ---------------------------------------------------------------------------------

/** Ligne `usage` d'un message, lue pour la chronologie d'une racine (L47a). `variant` : null quand rien n'est enregistré. */
export interface ChronologieUsageRow {
  messageId: string;
  sessionId: string;
  agent: string;
  providerId: string;
  modelId: string;
  variant: string | null;
  tokensInput: number;
  tokensOutput: number;
  tokensReasoning: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  cost: number;
  createdAt: number;
  completedAt: number | null;
}

/** Réponse de GET /api/conversations/:rootId/chronologie (L47b) ; `tronque` : borne CHRONO_MAX_ROWS atteinte. */
export interface ChronologieResponse {
  rootId: string;
  rows: ChronologieUsageRow[];
  tronque: boolean;
}

/**
 * Appel d'IA d'une ligne de chronologie. Les jetons valent `null` quand ils ne sont pas enregistrés : jamais 0 à leur place
 * (honnêteté, spécification §6). `end` null : appel encore en cours. `model` null : aucune ligne `usage` pour ce message,
 * donc aucune IA enregistrée — jamais un nom inventé (nullité relevée au train de V0 sur le module de L47a).
 */
export interface ChronologieCall {
  messageId: string;
  start: number;
  end: number | null;
  model: string | null;
  variant: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  tokensCache: number | null;
  tokensReasoning: number | null;
  cost: number | null;
}

/** Repère posé sur la ligne du temps : outil, nouvelle tentative, décision automatique, attente d'accord. `code` : code, jamais une phrase. */
export interface ChronologieTick {
  at: number;
  genre: "outil" | "tentative" | "decision" | "attente";
  code: string;
}

/**
 * Ligne de la chronologie (un acteur) ; `groupe` : clé du groupe qui la replie, null si elle est seule. `start` et `end`
 * viennent de `TimelineRow` du Déroulé de l'it1, déjà nullables : une ligne jamais démarrée n'a pas de début.
 */
export interface ChronologieRow {
  key: string;
  sessionId: string;
  depth: number;
  role: SessionRole;
  state: ActorState;
  start: number | null;
  end: number | null;
  calls: ChronologieCall[];
  ticks: ChronologieTick[];
  groupe: string | null;
}

/** Groupe de lignes du même agent, replié sous « {agent} ×{n} ». */
export interface ChronologieGroup {
  key: string;
  agent: string;
  count: number;
  rowKeys: string[];
}

/**
 * Vue rendue par le module pur `chronologie(state, usage, now)` ; `curseur` : « maintenant », null pour une demande terminée.
 * `start` et `end` sont null pour une conversation sans aucune ligne, aucun appel et aucun repère.
 */
export interface ChronologieView {
  start: number | null;
  end: number | null;
  curseur: number | null;
  rows: ChronologieRow[];
  groupes: ChronologieGroup[];
  partiel: boolean;
}

// --- Coûts par équipe et archives d'équipe (D-5-10, D-5-11) -----------------------------------------------------------------

/**
 * Ligne « Par équipe » de la page Coûts (L46a). `teamId` null : équipe supprimée, dont les lancements restent comptés.
 * `estimeTypique` null : aucune estimation enregistrée pour cette équipe.
 */
export interface TeamCostRow {
  teamId: string | null;
  titre: string;
  lancements: number;
  cout: number;
  moyenne: number;
  estimeTypique: number | null;
}

/**
 * Lancement d'équipe le plus coûteux (TEAM_COSTS_TOP). `etat` est le `TeamRunState` de l'itération 4, réunie dans la branche
 * par FE4 : il est porté en chaîne ici pour que la construction ne dépende d'aucun contrat d'une autre branche.
 */
export interface TeamRunCostRow {
  runId: string;
  titre: string;
  rootId: string;
  directory: string;
  etat: string;
  cout: number;
  estimeTypique: number | null;
  plafond: number | null;
  debut: number;
}

/** Réponse de GET /api/usage/equipes?month= (L46a) ; le paramètre d'URL est `month`, le champ `mois` est celui du corps rendu. */
export interface TeamCostsResponse {
  mois: string;
  parEquipe: TeamCostRow[];
  lancements: TeamRunCostRow[];
}

/**
 * Étape d'un lancement, dans les Archives. `extrait` : début du résultat, tronqué à ARCHIVE_EXCERPT_MAX et passé par
 * `redactSecrets` ; null quand la conversation a été supprimée d'opencode. L'export Markdown n'en reçoit jamais (D-5-10).
 */
export interface ArchiveTeamStep {
  titre: string;
  agent: string;
  ia: string;
  etat: string;
  tour: number | null;
  verdict: string | null;
  choix: string | null;
  cout: number;
  extrait: string | null;
}

/** Lancement d'équipe d'une conversation archivée ; `cause` : code d'arrêt, null si le lancement s'est terminé seul. */
export interface ArchiveTeamRun {
  runId: string;
  titre: string;
  etat: string;
  cause: string | null;
  cout: number;
  estimeTypique: number | null;
  plafond: number | null;
  debut: number;
  fin: number | null;
  etapes: ArchiveTeamStep[];
}

/** Réponse de GET /api/archives/:rootId/equipes (L46a) ; pluriel voulu : `/api/archive/:id` de http.ts capterait le singulier. */
export interface ArchiveTeamsResponse {
  rootId: string;
  lancements: ArchiveTeamRun[];
}

/** Réponse de GET /api/equipes/conversations : racines qui ont lancé une équipe (filtre « Avec une équipe », D-5-11). */
export interface TeamConversationsResponse {
  rootIds: string[];
  tronque: boolean;
}

// --- Codes de refus ---------------------------------------------------------------------------------------------------------

/** Codes rendus par les routes de la construction ; chaque code a sa phrase dans construction-texts.ts (§4.5). */
export type ConstructionErrorCode =
  | "methodes-trop"
  | "methode-inconnue"
  | "methode-non-attachable"
  | "seconde-lecture-absente"
  | "racine-inconnue";
