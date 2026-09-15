// Propriétaire : L5b.
// Liste des acteurs d'une conversation (la vérité de l'affichage, spécification §5.1, §5.7.4), rendue par ActivityRegion.
// Composant interne : ses propriétés restent libres pour son propriétaire. Squelette T2 : rend null.
import type { ActivityRow } from "../../../lib/types.ts";

export interface ActorListProps {
  rows: ActivityRow[];
  advanced: boolean;
}

export function ActorList(_props: ActorListProps): null {
  return null;
}
