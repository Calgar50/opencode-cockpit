// Limites fixes de la Salle OMO (spécification §4.8.2 l.723-727 ; plan d'exécution 2 bis-2 ter §4.1, D-2b-11, D-2b-29) : constantes
// du serveur, affichées, jamais réglables (PUT /api/settings sur budget.omo.* refusé). AUCUNE valeur de plafond de coût : le montant
// d'arrêt est saisi à chaque activation (Q7), sans valeur par défaut, borné par budget.autonomie.plafondMaxUsd et le budget mensuel.
// Module pur (server/shared). Contrôlé par omo-contracts.test.ts : aucune clé ni exportation de coût, valeurs de la spécification.

export const OMO_LIMITES = Object.freeze({
  /** Durée d'une demande dans la salle avant stopTreeOmo (plafond-duree). */
  dureeMinutes: 60,
  /** Sessions créées par l'extension pour une demande avant stopTreeOmo (plafond-sessions). */
  sessionsMax: 30,
  /** Nouvelles tentatives 429 d'affilée dans l'arbre avant stopTreeOmo (plafond-tentatives, compteur unique de D-2b-18). */
  tentatives429Max: 3,
  /** Tâches de fond simultanées (background_task.defaultConcurrency de omo.jsonc) : au-delà, l'extension attend. */
  tachesDeFond: 2,
  /** Fin de demande : toutes les sessions de la salle au repos depuis ce nombre de secondes, puis relance à neuf (D-2b-29). */
  finDemandeReposS: 15,
  /** Suspension de la salle : ce nombre de détections « activite-hors-demande » dans cette fenêtre, en minutes (D-2b-29). */
  suspension: Object.freeze({ detections: 2, fenetreMin: 10 }),
});

export type OmoLimites = typeof OMO_LIMITES;
