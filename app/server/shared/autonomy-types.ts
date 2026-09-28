// Contrat 1.1 « Autonomie à la demande » : TYPES UNIQUEMENT (aucun code exécuté), partagés par le serveur et l'interface.
// Spécification §3.5, §3.9, §4.1-§4.3, §4.9, §4.11 ; plan d'exécution §4.2 (T0). Les ports et les routes rendent des CODES ;
// les phrases affichées sont écrites dans server/shared/*-texts.ts (contrôlés par textes.test.ts).
import type { SessionInstance } from "./activity-types.ts";
import type { AutonomieSettings } from "./api-types.ts";

/** Choix d'autonomie d'une conversation (racine), appliqué à tout son travail délégué. Défaut : « demander ». */
export type AutonomyChoice = "demander" | "modifications" | "plan" | "autonome";

/** Réservé à la Salle OMO (itération 2 ter) : jamais proposé, jamais accepté par les routes des itérations 1 et 2. */
export type ReservedAutonomyChoice = "omo";

/** Choix qui répondent sans vous : relâcher vers eux demande une confirmation (428) et passe par le port d'activation. */
export type AutomaticChoice = "modifications" | "autonome";

/**
 * Fin d'une demande autonome (`autonomy_requests.fin`, colonne TEXT) : valeurs des migrations 4 et 5, plus « interrompue »
 * (redémarrage d'opencode, §4.11 ; aucune modification de schéma).
 */
export type RequestEnd =
  | "terminee"
  | "plafond-cout"
  | "plafond-actions"
  | "plafond-duree"
  | "plafond-fichiers"
  | "vous"
  | "non-controle"
  | "rechargement"
  | "redemarrage-cockpit"
  | "hors-controle"
  | "homme-mort"
  | "recreation"
  | "plafond-tentatives"
  | "plafond-sessions"
  // Salle OMO (D-2b-41) : seuil du budget mensuel atteint (80 ou 100 %, §4.8.2). Les autres fins de la salle sont déjà au-dessus.
  | "seuil-mensuel"
  | "interrompue";

/** `autonomy_decisions.verdict` ; « refus-interdit » : Salle OMO seulement (migration 5). */
export type DecisionVerdict = "auto" | "attente" | "refus-auto" | "non-controle" | "refus-interdit";

/** `autonomy_decisions.par` ; « extension » : action vue sans demande, Salle OMO seulement (migration 5). */
export type DecisionBy = "regles" | "ia-controle" | "vous" | "cockpit" | "extension";

/** Sort d'une réponse relayée par le portillon (`relayOnce`, `rejectWhenAlone`). */
export type RelayOutcome = "ok" | "deja-repondu" | "expiree" | "echec";

/** Auteur d'une réponse à une demande d'autorisation (`permission_waits.replied_by`). */
export type RepliedBy = "vous" | "cockpit" | "controle";

/** Plafonds d'une demande en « Autonome avec contrôle » (§4.8.1). */
export type AutonomyCaps = Pick<AutonomieSettings, "plafondUsd" | "actionsMax" | "delegationsMax" | "dureeMinutes" | "fichiersMax" | "controlesIaMax">;

/**
 * Raison, en code, d'un choix indisponible ou d'une activation refusée (§4.11) ; phrases : autonomy-texts.ts (L9b), section partout.
 * - a-venir : activation fermée par ACTIVATION_OUVERTE (porte I1), ou port d'activation neutre ; raison de `disponibles` et du 409 ;
 *   phrase affichée, reprise telle quelle par L9b et L10d : « Pas encore disponible dans cette version du cockpit. »
 * - autonomie-coupee : COCKPIT_AUTONOMY=off ;
 * - regle-allow : l'assistant agit déjà sans demander (edit, bash hors pwd, task, webfetch ou websearch sur allow) ;
 * - mcp-ou-extension : la configuration effective déclare mcp ou plugin ;
 * - profil-sans-confirmation : profil global « Sans confirmation (déconseillé) » actif ;
 * - plancher-non-verifie : plancher de conversation absent ou non vérifié ;
 * - racine-de-plan : conversation de plan, seul « plan » s'y applique ;
 * - nouvelle-conversation : « Plan d'abord » ouvre une nouvelle conversation (POST /api/plans), jamais par PUT.
 */
export type ActivationRefusalCode =
  | "a-venir"
  | "autonomie-coupee"
  | "regle-allow"
  | "mcp-ou-extension"
  | "profil-sans-confirmation"
  | "plancher-non-verifie"
  | "racine-de-plan"
  | "nouvelle-conversation";

/**
 * Cause d'un changement de choix (`conversation_autonomy.retour_cause`, fait `choix`, événement `autonomie.choix`) :
 * clic de l'utilisateur, ou retour à « demander » (redémarrage du cockpit, opencode redémarré, assistant non conforme, plafond).
 */
export type ChoiceCause =
  | "clic"
  | "redemarrage-cockpit"
  | "interrompue"
  | "agent-non-conforme"
  | "plafond-cout"
  | "plafond-actions"
  | "plafond-duree"
  | "plafond-fichiers";

export interface AutonomyChoiceAvailability {
  choix: AutonomyChoice;
  disponible: boolean;
  /** null si disponible. */
  raison: ActivationRefusalCode | null;
}

/** Réponse de GET et PUT /api/conversations/:rootId/autonomie. */
export interface ConversationAutonomyView {
  rootId: string;
  choix: AutonomyChoice;
  plafonds: AutonomyCaps;
  /** Date du choix en vigueur ; null : jamais choisi (« demander » par défaut). */
  depuis: number | null;
  retourCause: ChoiceCause | null;
  planSourceId: string | null;
  executionDePlanId: string | null;
  /** COCKPIT_AUTONOMY : false = seuls « demander » et « plan » restent possibles. */
  interrupteur: boolean;
  disponibles: AutonomyChoiceAvailability[];
  /** Demande autonome en cours, sinon null. */
  demande: AutonomyRequestView | null;
  /**
   * Instance opencode de la racine (réservation 2 du plan 2 bis). Champ ABSENT : instance principale, comme en 1.0.x. Rempli
   * plus tard par le paquet d'activation de la salle ; aucune route ne l'écrit ici.
   */
  instance?: SessionInstance;
}

export interface AutonomyRequestView {
  id: string;
  rootId: string;
  choix: AutonomyChoice;
  plafonds: AutonomyCaps;
  startedAt: number;
  endedAt: number | null;
  spent: number;
  auto: number;
  attentes: number;
  refus: number;
  controles: number;
  fichiers: number;
  delegations: number;
  fin: RequestEnd | null;
}

/** Ligne du Journal du contrôle (`autonomy_decisions`) ; `resume` masqué à 120 caractères, `raison` jamais un texte de message. */
export interface DecisionView {
  id: number;
  requestId: string | null;
  sessionId: string;
  permissionId: string | null;
  permission: string;
  resume: string;
  choix: AutonomyChoice;
  /** Code de règle (E1-E6, B01…, A-grep, D1-D7…). */
  regle: string;
  rulesVersion: number;
  verdict: DecisionVerdict;
  par: DecisionBy;
  raison: string;
  iaModel: string | null;
  iaCost: number | null;
  iaMs: number | null;
  relais: RelayOutcome | null;
  askedAt: number;
  decidedAt: number | null;
}

/** Corps de PUT /api/conversations/:rootId/autonomie ; relâcher vers un choix automatique exige x-cockpit-confirm: 1. */
export interface AutonomyPutBody {
  choix: AutonomyChoice;
  plafonds?: Partial<AutonomyCaps>;
}

/**
 * Codes d'erreur des routes d'autonomie et de plans (D-03) :
 * 403 autonomie-coupee (modifications, autonome avec COCKPIT_AUTONOMY=off) ; 409 autonomie-indisponible (+ raison) ;
 * 428 confirmation-requise (relâcher sans x-cockpit-confirm) ; 409 raccourci-refuse-autonomie (``!` `` en choix automatique).
 */
export type AutonomyErrorCode = "autonomie-coupee" | "autonomie-indisponible" | "confirmation-requise" | "raccourci-refuse-autonomie";

/** Corps d'erreur des routes d'autonomie : `message` est la phrase du module de textes, `raison` le code. */
export interface AutonomyErrorBody {
  error: AutonomyErrorCode;
  message: string;
  raison?: ActivationRefusalCode;
}

/** Session opencode rendue par les routes de plans (sous-ensemble de OcSession). */
export interface PlanSessionInfo {
  id: string;
  title: string;
  directory: string;
  time: { created: number; updated: number };
}

/** Corps de POST /api/plans (permis avec COCKPIT_AUTONOMY=off). */
export interface PlanCreateBody {
  directory: string;
  /**
   * Conversation d'origine de « Plan d'abord (nouvelle conversation) » (train it1 V3, demande de L6b) : racine de conversation de
   * l'instance principale, dans le même dossier (400 sinon, 404 si inconnue) ; enregistrée dans plan_source_id. Absente : plan
   * commencé depuis une nouvelle conversation.
   */
  source?: string;
}

/**
 * Réponse de POST /api/plans : racine PLAN vérifiée (403 forbidden-directory, 409 budget-guard ou outils-hors-controle, 502
 * plancher-non-verifie ou configuration-illisible).
 */
export interface PlanCreateResponse {
  rootId: string;
  session: PlanSessionInfo;
}

/** Corps de POST /api/plans/:id/execution ; 428 sans x-cockpit-confirm pour un choix automatique, avant toute création de racine. */
export interface PlanExecutionBody {
  choix: Exclude<AutonomyChoice, "plan">;
  plafonds?: Partial<AutonomyCaps>;
}

/** Réponse de POST /api/plans/:id/execution : racine CONVERSATION et brouillon « Exécute le plan suivant. » + dernier texte. */
export interface PlanExecutionResponse {
  rootId: string;
  session: PlanSessionInfo;
  brouillon: string;
}

/** Partie `autonomy` de GET /api/bootstrap (envoyée à partir de L1a). */
export interface BootstrapAutonomy {
  /** COCKPIT_AUTONOMY. */
  interrupteur: boolean;
  /** ACTIVATION_OUVERTE (porte I1) : false tant que l'intégrateur ne l'a pas basculée. */
  activationOuverte: boolean;
}

/** Plancher de règles de session (§3.4), construit par server/shared/session-floors.ts (L3). */
export type FloorKind = "CONVERSATION" | "PLAN" | "ETAPE" | "CONTROLE";

/**
 * Faits d'une délégation (`task`) pour la règle D1-D7 (§4.7) : relevés par la garde du `task once` (L1d,
 * collectDelegationFacts), classés par autonomy-rules.ts (L9b), réutilisés par la délégation en Autonome (L10e).
 */
export interface DelegationFacts {
  /**
   * null : cible absente de GET /agent. `actsWithoutAsking` et `readsEnvWithoutAsking` (pré-publication 1.1.0) : droits EFFECTIFS
   * de la cible (targetRightsFacts, autonomy-rules.ts). L'enfant garde ses propres règles et n'hérite de la conversation que ses
   * refus : un sous-agent intégré comme `explore` (« read * allow » posé après le « *.env ask » des défauts) lirait un .env sans
   * aucune demande.
   */
  target: { name: string; mode: string; internal: boolean; actsWithoutAsking: boolean; readsEnvWithoutAsking: boolean } | null;
  /** null : aucun task_id ; sinon true s'il désigne une session de l'arbre de la racine. */
  taskIdInTree: boolean | null;
  /** Code du risque trouvé dans la consigne (@fichier existant, ``!` ``, URL, ~, chemin absolu, ..), null sinon. */
  promptRisk: string | null;
  modelAllowed: boolean;
  guardAccepts: boolean;
  delegationsSoFar: number;
  estimateUsd: number;
  remainingUsd: number;
}
