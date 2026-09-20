// Propriétaire : L10c.
// La seule phrase de la surveillance d'une demande autonome qui manque à shared/autonomy-texts.ts (L9b) : la raison écrite au
// Journal du contrôle (spécification §4.12) quand le cockpit voit APRÈS COUP une commande qu'opencode a lancée sans poser de
// demande d'autorisation (§4.10, formes F-l, mesure MX2 §3). Tout le reste est déjà écrit par L9b : les plafonds
// (phrasePlafond), les fins de demande (phraseFin, dont « Passé sans contrôle : la demande a été arrêtée. »), les retours à
// « Demander à chaque fois » (phraseRetour), le libellé de la décision (libelleDecision « non-controle ») et la phrase du code de
// règle « F-l » (phraseRegle, TEXTES.partout.regles), qui dit quelle forme est passée sans demande.
// Module pur (server/shared) : ni module node, ni horloge, ni accès au processus. Structure imposée par le test « textes »
// (plan d'exécution §4.6) : TEXTES = { simple, avance, partout }, feuilles en chaînes, et seulement des fonctions à côté.
export const TEXTES = {
  /** Aucune phrase propre au mode Simple : celle du Journal est la même dans les deux modes. */
  simple: {},
  /** Aucune phrase propre au mode Avancé. */
  avance: {},
  partout: {
    /** Colonne « Raison » du Journal du contrôle (§4.12) pour une commande passée sans contrôle. */
    nonControle: "Commande lancée sans demande d'autorisation : le cockpit l'a vue après coup",
  },
} as const;

/** Raison écrite au Journal du contrôle pour une commande passée sans contrôle (§4.10). */
export function raisonNonControle(): string {
  return TEXTES.partout.nonControle;
}
