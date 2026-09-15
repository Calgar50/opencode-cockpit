// Propriétaire : L1g (classifieur) puis L11b (cockpit-controle).
// Agents internes gardés (spécification §3.11) : installation au repos derrière la garde de rechargement, reprise 30 s → 5 min,
// état pour le Diagnostic. L1a appelle ports.internalAgents.ensureAll() au démarrage et après un redémarrage d'opencode ; une
// reprise peut s'inscrire par reg.startup (couple déjà prévu dans STEP_ORDER).
// Squelette T0 : aucune inscription ; port neutre = 1.0.4 (installation de l'agent de classement, erreur journalisée comme
// dans main.ts, aucun suivi).
// neutralInternalAgents reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan §2.2).
import { CLASSIFIER_AGENT } from "./classifier.ts";
import type { Cockpit11Deps, Cockpit11Module, InternalAgentsPort } from "./contracts-11.ts";
import { errorMessage } from "./log.ts";

export function neutralInternalAgents(deps: Cockpit11Deps): InternalAgentsPort {
  return {
    ensureAll: () =>
      deps.studio.ensureClassifierAgent().catch((err: unknown) => deps.log.warn("agent de classement non installé", { error: errorMessage(err) })),
    status: () => [{ nom: CLASSIFIER_AGENT, etat: "non-suivi", prochainEssai: null }],
  };
}

export const internalAgentsModule: Cockpit11Module = {
  name: "internalAgents",
  install() {
    // Squelette : L1g puis L11b posent c11.ports.internalAgents.
  },
};
