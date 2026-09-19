// Propriétaire : L28b.
// « Revoir » côté serveur (spécification §5.9 l.1018-1024, Q6, D-3d-08, D-3d-09) : règle d'accès, faits de la conversation, titre
// masqué. Lecture seule en base : aucune requête à opencode, aucune écriture. Squelette T3d-a : port neutre (racine inconnue).
import type { RevoirPort, Salle3dDeps } from "./contracts-3d.ts";

export function createRevoirPort(_deps: Salle3dDeps): RevoirPort {
  return {
    lire: () => ({ ok: false, status: 404, code: "racine-inconnue" }),
    etat: (rootId) => ({ rootId, acces: false, raison: "racine-inconnue" }),
  };
}
