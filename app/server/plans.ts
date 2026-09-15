// Propriétaire : L6b.
// Plan d'abord (spécification §4.9) : racine PLAN vérifiée, choix « plan » permanent, crochet beforeBilledSend pour une racine de
// plan, exécution sur une nouvelle racine CONVERSATION (428 et activation par la logique de PUT …/autonomie), groupe « plans ».
// Squelette T0 : aucune inscription ; port neutre = aucun (1.0.4).
// neutralPlans reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan §2.2).
import type { Cockpit11Module, PlansPort } from "./contracts-11.ts";

export function neutralPlans(): PlansPort {
  return {};
}

export const plansModule: Cockpit11Module = {
  name: "plans",
  install() {
    // Squelette : L6b pose le crochet « beforeBilledSend » et le groupe de routes « plans ».
  },
};
