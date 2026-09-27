// Contrat 1.1 : arrêt de l'arbre, événements SSE du cockpit et Diagnostic de l'activité. TYPES UNIQUEMENT (aucun code exécuté).
// Spécification §3.9 (SSE), §3.12, §3.14 ; plan d'exécution §4.2 et §4.5 (T0).
import type { ActivityFact } from "./activity-types.ts";
import type { AutonomyChoice, AutonomyRequestView, ChoiceCause, DecisionBy, DecisionVerdict, RequestEnd } from "./autonomy-types.ts";
import type { OmoStopCause } from "./omo-types.ts";

/**
 * Cause d'un arrêt de l'arbre (`stopTree`, §3.12). INCHANGÉE par la Salle OMO (D-2b-41) : la salle a sa propre union,
 * `OmoStopCause`, et les tables exhaustives de `stop-tree.ts` restent donc valides.
 */
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
  /** Cause élargie (D-2b-41) : un arrêt de la Salle OMO porte une `OmoStopCause` ; un lecteur qui ne la connaît pas reste muet (P3). */
  "conversation.arretee": { rootId: string; cause: StopCause | OmoStopCause; unconfirmed: string[] };
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
 * oc-config/plugin(s)/, agents `task: allow`. « illisible » (train it1 V4, demande de contrat de L1f) : un relevé n'a pas pu être
 * fait (opencode muet, réponse inattendue, dossier illisible) ; le bandeau qu'il aurait donné peut manquer, ce qui est dit au lieu
 * d'être tu (P3).
 */
export type DelegationBannerCode = "profondeur" | "arriere-plan" | "extension" | "task-allow" | "illisible";

/** Relevés du Diagnostic du travail délégué (diagnostics-11.ts), dans l'ordre : noms d'un bandeau « illisible ». */
export type DelegationCheck = "configuration" | "profondeur" | "arriere-plan" | "extensions" | "fichiers-extensions" | "agents";

export interface DelegationBanner {
  code: DelegationBannerCode;
  /** Noms concernés (agents, fichiers d'extension), sans chemin absolu ; « illisible » : relevés impossibles (DelegationCheck). */
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
