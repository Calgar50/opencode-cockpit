// Contrat 1.1 : arrêt de l'arbre, événements SSE du cockpit et Diagnostic de l'activité. TYPES UNIQUEMENT (aucun code exécuté).
// Spécification §3.9 (SSE), §3.12, §3.14 ; plan d'exécution §4.2 et §4.5 (T0).
import type { ActivityFact } from "./activity-types.ts";
import type { AutonomyChoice, AutonomyRequestView, ChoiceCause, DecisionBy, DecisionVerdict, RequestEnd } from "./autonomy-types.ts";

/** Cause d'un arrêt de l'arbre (`stopTree`, §3.12). */
export type StopCause = "vous" | "plafond-cout" | "plafond-delegations" | "non-controle" | "rechargement" | "equipe";

/** Réponse de POST /api/conversations/:rootId/stop, et du proxy d'arrêt pour une racine suivie (L1c). */
export interface StopResult {
  rootId: string;
  /** Demandes d'autorisation de l'arbre refusées dans la file des réponses. */
  rejected: number;
  /** Sessions arrêtées (racine puis descendants occupés). */
  aborted: string[];
  /** Sessions encore occupées après la sonde de 10 s et un second arrêt (« arrêt non confirmé »). */
  unconfirmed: string[];
  durationMs: number;
}

/** Événements SSE du cockpit ajoutés par la 1.1 (`hub.cockpit(type, data)`, publiés par `emitCockpit`). */
export interface CockpitEventMap {
  "autonomie.choix": { rootId: string; choix: AutonomyChoice; cause: ChoiceCause };
  "autonomie.examen": { rootId: string; sessionId: string; permissionId: string };
  "autonomie.decision": {
    rootId: string;
    sessionId: string;
    permissionId: string | null;
    verdict: DecisionVerdict;
    regle: string;
    raison: string;
    par: DecisionBy;
  };
  "autonomie.demande": {
    rootId: string;
    requestId: string;
    compteurs: Pick<AutonomyRequestView, "auto" | "attentes" | "refus" | "controles" | "fichiers" | "delegations">;
    spent: number;
    fin?: RequestEnd;
  };
  "conversation.arretee": { rootId: string; cause: StopCause; unconfirmed: string[] };
  "delegation.plafond": { rootId: string; kind: "nombre" | "cout" };
  "delegation.expiree": { rootId: string; permissionId: string };
  "activite.fait": ActivityFact;
}

export type CockpitEventType = keyof CockpitEventMap;

/** État d'installation d'un agent interne (cockpit-classifier, cockpit-controle), §3.11. */
export type InternalAgentState = "installe" | "en-attente" | "echec" | "non-suivi";

export interface InternalAgentStatus {
  nom: string;
  etat: InternalAgentState;
  /** Prochaine tentative (reprise 30 s → 5 min), null si aucune. */
  prochainEssai: number | null;
}

/**
 * Bandeaux du Diagnostic sur le travail délégué (§3.14) : subagent_depth > 1, sous-agents en arrière-plan, extensions dans
 * oc-config/plugin(s)/, agents `task: allow`.
 */
export type DelegationBannerCode = "profondeur" | "arriere-plan" | "extension" | "task-allow";

export interface DelegationBanner {
  code: DelegationBannerCode;
  /** Noms concernés (agents, fichiers d'extension), sans chemin absolu. */
  noms: string[];
}

/** Réponse de GET /api/diagnostic/activite (route T0, données L1f et L11b). */
export interface DiagnosticActiviteResponse {
  delegation: DelegationBanner[];
  agentsInternes: InternalAgentStatus[];
  /** COCKPIT_AUTONOMY. */
  interrupteur: boolean;
  /** budget.autonomie.controleIa. */
  controleIa: boolean;
  /** ACTIVATION_OUVERTE (porte I1). */
  activationOuverte: boolean;
}
