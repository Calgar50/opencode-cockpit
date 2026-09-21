// Propriétaire : L18b.
// Routeur d'instances opencode (spécification §3.8 l.325, §3.10 l.358, P11 ; plan 2 bis, fiche L18b) : une session appartient à
// une instance (sessions.instance, T3c) ; une session de l'autre instance reçoit 404, une session inconnue 409
// « instance-inconnue » sur le proxy de la salle.
// - `createInstanceRouter` assemble seulement ce qu'on lui donne. Avec `omo: null` (le dépôt, salle coupée), la salle n'a ni
//   client ni processeur : `of("omo")` rend null et rien de la salle n'est joignable.
// - `instanceOf` lit la colonne `sessions.instance` (T3c) par le suivi des sessions. Sans lecteur (`sessions` absent), il rend
//   null : aucune session n'est rattachée, donc rien n'est deviné (fermé en cas de doute).
// - Aucune écriture : le routeur ne crée ni ne modifie jamais une session (l'instance est posée à l'insertion, sessions.ts).
import type { InstanceDeps, InstanceRouter } from "./omo-contracts.ts";
import type { SessionInstance } from "./shared/activity-types.ts";
import { ID_RE } from "./shared/ids.ts";

/** Lecture d'une session suivie : `SessionTracker` en production, objet simple dans les tests. */
export interface InstanceRouterSessions {
  get(id: string): { instance: SessionInstance } | undefined;
}

export interface InstanceRouterInput {
  principale: InstanceDeps;
  /** null : salle coupée (aucun client, aucun processeur). */
  omo: InstanceDeps | null;
  /** Suivi des sessions ; absent : aucune session n'est rattachée à une instance (squelette de T3b). */
  sessions?: InstanceRouterSessions;
}

export function createInstanceRouter(input: InstanceRouterInput): InstanceRouter {
  const { principale, omo, sessions } = input;
  return {
    principale,
    omo,
    instanceOf: (sessionId: string): SessionInstance | null => {
      // Identifiant hors motif : jamais porté à la base, jamais rattaché à une instance.
      if (sessions === undefined || !ID_RE.test(sessionId)) return null;
      const instance = sessions.get(sessionId)?.instance;
      // Valeur inattendue (base écrite ailleurs) : lue comme inconnue, jamais comme « principale ».
      return instance === "principale" || instance === "omo" ? instance : null;
    },
    of: (instance) => (instance === "omo" ? omo : principale),
  };
}
