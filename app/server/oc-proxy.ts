// Propriétaire : L18b.
// Proxy de l'instance de la Salle OMO (spécification §3.8 l.325, §3.10 l.358, D-2b-04 ; plan 2 bis, fiche L18b) : liste blanche
// plus étroite que celle de l'instance principale — `POST /session` et les réponses d'autorisation venues du navigateur sont
// refusées (la salle ouvre ses salles par ses propres routes et répond par son répondeur, L22d).
// SQUELETTE posé par T3b (plan 2 bis §4.2) : AUCUNE route, AUCUN relais. Seule la marque d'instance est posée ici : un contexte
// de crochet du proxy de la salle porte `instance: "omo"`, ce qui fait que `runHooks` (wiring-11.ts) n'appelle QUE les crochets
// inscrits pour la salle. Le proxy lui-même arrive avec L18b, au train de V3.
import type { ProxyContext } from "./contracts-11.ts";
import type { SessionInstance } from "./shared/activity-types.ts";

/** Instance servie par ce proxy : toute requête qu'il relaie vise la salle. */
export const OMO_PROXY_INSTANCE: SessionInstance = "omo";

/** Marque un contexte de crochet comme venant du proxy de la salle (L18b construira le contexte complet). */
export function contexteSalle(base: ProxyContext): ProxyContext {
  return { ...base, instance: OMO_PROXY_INSTANCE };
}
