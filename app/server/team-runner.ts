// Propriétaire : L37b.
// TeamRunner (spécification §3.13 ; plan d'exécution it4, fiche L37b) : lancement, sessions d'étape sous plancher ETAPE vérifié,
// ordonnanceur, injections, dérivations d'étapes, reprise au démarrage (recover), groupe « team-runs » (routes-team-runs.ts).
// Squelette T4 : une seule inscription, le prédicat de la garde de rechargement (D-eq-06), qui lit eq.ports.runner.stepsBusy() au
// moment de l'appel (neutre : false, donc rien ne change) ; port neutre : launch lève EqPortUnavailableError ; continue, relaunch,
// close, addResults → refus « a-venir » ; lectures → null ou [] ; stepsBusy → false ; notifications sans effet.
// neutralRunner reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan it4 §2.3).
import { type EqModule, EqPortUnavailableError, type RunnerRefusal, type TeamRunnerPort } from "./contracts-eq.ts";

/** Refus « a-venir », un objet neuf à chaque appel (l'appelant peut le compléter). */
const aVenir = (): RunnerRefusal => ({ ok: false, status: 409, code: "a-venir" });

export function neutralRunner(): TeamRunnerPort {
  return {
    launch: () => Promise.reject(new EqPortUnavailableError("runner")),
    continue: async () => aVenir(),
    view: () => null,
    runsOf: () => [],
    runOfStepSession: () => null,
    activeRunOf: () => null,
    stepOf: () => null,
    stepsBusy: () => false,
    stopRequested: () => undefined,
    stopped: () => undefined,
    interrupt: () => undefined,
    relaunch: async () => aVenir(),
    close: () => aVenir(),
    addResults: async () => aVenir(),
  };
}

export const teamRunnerModule: EqModule = {
  name: "teamRunner",
  install(reg, eq) {
    // Étapes en cours ou en file : la garde de rechargement répond « busy » (composé dans c11.reloadBusy par apply).
    reg.reloadBusy(() => eq.ports.runner.stepsBusy());
    // Squelette : L37b pose eq.ports.runner, ses dérivations, son abonnement « opencode.connection », son démarrage et ses routes.
  },
};
