// Propriétaire : L18b.
// Routeur d'instances opencode (spécification §3.8 l.325, §3.10 l.358, P11 ; plan 2 bis, fiche L18b) : une session appartient à
// une instance (sessions.instance, T3c) ; une session de l'autre instance reçoit 404, une session inconnue 409
// « instance-inconnue ». SQUELETTE posé par T3b (plan 2 bis §4.2) : AUCUN comportement.
// - `createInstanceRouter` assemble seulement ce qu'on lui donne. Avec `omo: null` (le dépôt, salle coupée), la salle n'a ni
//   client ni processeur : `of("omo")` rend null et rien de la salle n'est joignable.
// - `instanceOf` rend null tant que L18b ne lit pas `sessions.instance` (T3c) : aucune session n'est rattachée à une instance
//   par ce squelette, donc rien n'est deviné (fermé en cas de doute).
import type { InstanceDeps, InstanceRouter } from "./omo-contracts.ts";
import type { SessionInstance } from "./shared/activity-types.ts";

export interface InstanceRouterInput {
  principale: InstanceDeps;
  /** null : salle coupée (aucun client, aucun processeur). */
  omo: InstanceDeps | null;
}

export function createInstanceRouter(input: InstanceRouterInput): InstanceRouter {
  const { principale, omo } = input;
  return {
    principale,
    omo,
    // L18b : lecture de sessions.instance (colonne posée par T3c). Squelette : aucune session n'est rattachée.
    instanceOf: (): SessionInstance | null => null,
    of: (instance) => (instance === "omo" ? omo : principale),
  };
}
