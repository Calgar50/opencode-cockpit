// Propriétaire : L10c.
// Plafonds d'une demande autonome (spécification §4.8.1), « Passé sans contrôle » (§4.10) et redémarrages d'opencode
// (§4.11) : dérivation, abonnement usage.updated, reprise au démarrage (capWatch.recover, inscription startup).
// Squelette T0 : aucune inscription ; port neutre = sans effet (1.0.4).
// neutralCapWatch reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan §2.2).
import type { CapWatchPort, Cockpit11Module } from "./contracts-11.ts";

export function neutralCapWatch(): CapWatchPort {
  return {};
}

export const capWatchModule: Cockpit11Module = {
  name: "capWatch",
  install() {
    // Squelette : L10c pose sa dérivation, son abonnement « usage.updated » et sa reprise au démarrage.
  },
};
