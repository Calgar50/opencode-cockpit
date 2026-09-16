// Propriétaire : L12b.
// État d'une demande d'autorisation vu par le contrôle : « Contrôle de sécurité en cours… » ou « En attente de votre accord » ·
// « Règle : … » (spécification §4.3, §4.13), dans la carte de la demande. Propriétés figées dans ../slots.ts.
// Squelette T2 : rend null ; useDecisionStates ne rend aucun état.
import type { DecisionStatusProps, PermissionAutonomyState } from "../slots.ts";

const NONE: ReadonlyMap<string, PermissionAutonomyState> = new Map();

export function DecisionStatus(_props: DecisionStatusProps): null {
  return null;
}

/**
 * États d'examen et de décision des demandes d'une conversation (événements `autonomie.examen` et `autonomie.decision`), par
 * identifiant de demande. Appelé une fois par ChatPage ; `examining` repasse à false au plus tard après 60 s.
 */
export function useDecisionStates(_rootId: string | null): ReadonlyMap<string, PermissionAutonomyState> {
  return NONE;
}
