// Propriétaire : L5t.
// Carte d'un travail délégué dans la transcription (spécification §5.1). Composant interne : ses propriétés restent libres pour
// son propriétaire. Squelette T2 : rend null.
import type { DelegationView } from "../../../lib/types.ts";

export interface DelegationCardProps {
  delegation: DelegationView;
  onOpenSession: (sessionId: string) => void;
}

export function DelegationCard(_props: DelegationCardProps): null {
  return null;
}
