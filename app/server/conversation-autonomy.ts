// Propriétaire : L6a.
// Choix d'autonomie par conversation (conversation_autonomy, spécification §4.2, §4.11) : get et put, resserrer immédiat,
// relâcher → 428 sans confirmation, choix automatiques confiés au port activation, fait « choix », retour à « demander » au
// démarrage (inscription startup), groupe de routes « autonomy » (routes-autonomy.ts).
// Squelette T0 : aucune inscription ; port neutre = vue « demander », aucun choix automatique disponible.
// neutralConversationAutonomy reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan §2.2).
import type { Cockpit11Deps, Cockpit11Module, ConversationAutonomyPort } from "./contracts-11.ts";
import type { ActivationRefusalCode, ConversationAutonomyView } from "./shared/autonomy-types.ts";

export function neutralConversationAutonomy(deps: Cockpit11Deps): ConversationAutonomyPort {
  const view = (rootId: string): ConversationAutonomyView => {
    const caps = deps.settings.get().budget.autonomie;
    const automatic: ActivationRefusalCode = deps.env.autonomy ? "a-venir" : "autonomie-coupee";
    return {
      rootId,
      choix: "demander",
      plafonds: {
        plafondUsd: caps.plafondUsd,
        actionsMax: caps.actionsMax,
        delegationsMax: caps.delegationsMax,
        dureeMinutes: caps.dureeMinutes,
        fichiersMax: caps.fichiersMax,
        controlesIaMax: caps.controlesIaMax,
      },
      depuis: null,
      retourCause: null,
      planSourceId: null,
      executionDePlanId: null,
      interrupteur: deps.env.autonomy,
      disponibles: [
        { choix: "demander", disponible: true, raison: null },
        { choix: "modifications", disponible: false, raison: automatic },
        { choix: "plan", disponible: false, raison: "nouvelle-conversation" },
        { choix: "autonome", disponible: false, raison: automatic },
      ],
      demande: null,
    };
  };
  return {
    get: async (rootId) => view(rootId),
    choiceOf: () => "demander",
    put: async () => ({ ok: false, status: 409, error: "autonomie-indisponible", raison: "a-venir" }),
  };
}

export const conversationAutonomyModule: Cockpit11Module = {
  name: "conversationAutonomy",
  install() {
    // Squelette : L6a pose c11.ports.conversationAutonomy, le retour à « demander » au démarrage et le groupe « autonomy ».
  },
};
