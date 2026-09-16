// Propriétaire : L5b.
// Bandeau « Qui travaille ? » (spécification §5.1, §5.4, §5.6), rendu par ActivityRegion. Composant interne : ses propriétés
// restent libres pour son propriétaire. Squelette T2 : rend null.
import type { ActivityRow } from "../../../lib/types.ts";

export interface WhoIsWorkingProps {
  rows: ActivityRow[];
  onReply: (permissionId: string) => void;
}

export function WhoIsWorking(_props: WhoIsWorkingProps): null {
  return null;
}
