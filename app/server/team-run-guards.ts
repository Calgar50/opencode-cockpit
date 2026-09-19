// Propriétaire : L37c.
// Incidents des équipes (spécification §3.12, §3.13 ; plan d'exécution it4, fiche L37c, D-eq-04, D-eq-05) : verrous du proxy et
// des Archives, décorateur de stopTree, plafond (usage.updated), rechargement (global.disposed, server.instance.disposed), routes
// d'incident du groupe « team-runs » (stop, estimate, relancer, fermer, ajouter-resultats).
// Squelette T4 : deux inscriptions de câblage, sans effet avec les ports neutres :
//   - le verrou (proxy et Archives) délègue à eq.ports.guards.proxyGuard, lu au moment de l'appel (neutre : null) ;
//   - le décorateur de stopTree (D-eq-05) prévient le runner AVANT l'arrêt interne (plus aucune étape lancée), puis APRÈS ; une
//     erreur du runner est journalisée et n'empêche jamais l'arrêt.
// Port neutre : proxyGuard → null ; stopForCap sans effet.
// neutralGuards reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan it4 §2.3).
import type { StopTreePort } from "./contracts-11.ts";
import type { EqContext, EqModule, TeamGuardsPort } from "./contracts-eq.ts";
import { errorMessage } from "./log.ts";
import type { StopResult } from "./shared/cockpit-event-types.ts";

export function neutralGuards(): TeamGuardsPort {
  return {
    proxyGuard: async () => null,
    stopForCap: async () => undefined,
  };
}

/** Décorateur de stopTree (D-eq-05) : runner.stopRequested avant l'arrêt interne, runner.stopped après, même en échec. */
export function teamStopTree(eq: EqContext, inner: StopTreePort): StopTreePort {
  const notify = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (err) {
      eq.c11.log.warn(`équipes : ${what} en échec, l'arrêt continue`, { error: errorMessage(err) });
    }
  };
  return {
    async run(rootId, cause) {
      notify("stopRequested", () => eq.ports.runner.stopRequested(rootId, cause));
      let result: StopResult | null = null;
      try {
        result = await inner.run(rootId, cause);
        return result;
      } finally {
        notify("stopped", () => eq.ports.runner.stopped(rootId, cause, result));
      }
    },
  };
}

export const teamGuardsModule: EqModule = {
  name: "teamGuards",
  install(reg, eq) {
    reg.proxyGuard((req) => eq.ports.guards.proxyGuard(req));
    reg.stopTreeDecorator((inner) => teamStopTree(eq, inner));
    // Squelette : L37c pose eq.ports.guards, ses dérivations, son abonnement « usage.updated » et ses routes.
  },
};
