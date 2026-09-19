// Propriétaire : L31a.
// Territoires du zoom 1 de la salle de contrôle (spécification §5.8 l.993, D-3d-13, D-3d-14, P11) : un territoire par projet, trois
// compteurs, enceinte de la Salle OMO. Squelette T3d-a : port neutre, aucune lecture, aucune requête à opencode.
import type { Salle3dDeps, TerritoiresPort } from "./contracts-3d.ts";

export function createTerritoiresPort(_deps: Salle3dDeps): TerritoiresPort {
  return {
    lire: async (mode, now) => ({ genereLe: now, mode, projets: [], salle: null, statutVerifie: false }),
  };
}
