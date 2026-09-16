// Propriétaire : L5c.
// Carte des agents en direct : bande néon 2D (spécification §5.7.4, JP-13), rendue par ActivityRegion. Aucune boucle d'animation
// dans ce fichier ni dans neon.css (web-animations.test.ts). Composant interne : ses propriétés restent libres pour son
// propriétaire. Squelette T2 : rend null.
import type { ActivityFact } from "../../../lib/types.ts";

export interface NeonBandProps {
  rootId: string;
  facts: ActivityFact[];
  advanced: boolean;
}

export function NeonBand(_props: NeonBandProps): null {
  return null;
}
