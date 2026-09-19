// Textes de la reprise de l'amorçage (1.1, décision U4), contrôlés par textes.test.ts : écran « Le cockpit ne répond pas »
// (interface pas encore chargée) et bandeau d'état (interface déjà chargée, gardée pendant la reprise). Honnêteté :
// - « l'affichage peut ne plus être à jour » : pendant la reprise, l'interface montre les dernières données reçues ;
// - « Nouvelle tentative automatique dans {secondes} s » : délai de la tentative programmée, jamais un compte à rebours
//   (aucune minuterie d'affichage) ; une tentative part aussi dès le retour du réseau, de l'onglet ou du flux ;
// - « Le cockpit répond de nouveau » : annoncé seulement après un rechargement réussi.
export const TEXTES = {
  simple: {},
  avance: {},
  partout: {
    titre: "Le cockpit ne répond pas",
    bandeau: "Le cockpit ne répond pas : l'affichage peut ne plus être à jour.",
    prochaineTentative: "Nouvelle tentative automatique dans {secondes} s.",
    reessayer: "Réessayer",
    retabli: "Le cockpit répond de nouveau.",
  },
} as const;

/** Délai de la tentative programmée, en secondes entières (au moins 1). */
export function nextAttemptText(delayMs: number): string {
  return TEXTES.partout.prochaineTentative.replace("{secondes}", String(Math.max(1, Math.round(delayMs / 1000))));
}
