// Textes de « Plan d'abord » (spécification §4.9, §6 l.1044, D12, D-03, D-04 ; plan d'exécution, fiche L6b) : phrase d'honnêteté,
// boutons de la carte de plan (repris par L6c), début du brouillon d'exécution, garde-fou budgétaire à la création et messages des
// routes POST /api/plans et POST /api/plans/:id/execution, et du crochet d'envoi d'une conversation de plan. Convention TEXTES de
// T0 (contrôlée par textes.test.ts). Les refus d'autonomie de l'exécution (403, 409, 428) reprennent autonomy-choice-texts.ts,
// comme PUT …/autonomie : mêmes codes, mêmes phrases.
// Honnêteté (§6, P3), chaque phrase tenue par plans.test.ts :
// - « ne peut rien modifier, même plus tard » : plancher PLAN (edit write apply_patch bash retirés, racine et travail délégué, F-e,
//   F-f), vérifié à la création puis avant chaque envoi facturé d'une conversation de plan ; « plan » permanent (aucun PUT ne le
//   change) ;
// - « Aucun message n'a été envoyé ni facturé » : seule la création a été demandée à opencode ;
// - « non créée » seulement quand rien ne peut rester dans opencode ; sinon « refusée » et « peut rester dans la liste » ;
// - « Créer cette conversation de plan ne coûte rien » : la création n'appelle aucune IA ; chaque message passe ensuite par le
//   garde-fou normal du proxy ;
// - « Rien n'a été facturé » (envoi) : un envoi refusé n'est jamais relayé à opencode.

export const TEXTES = {
  simple: {},
  avance: {},
  partout: {
    /** §4.9, point 6 (F-g) : affichée avec la conversation de plan et sa carte. */
    honnetete: "Cette conversation ne peut rien modifier, même plus tard.",
    /** §4.9, point 4 : carte après chaque réponse d'une conversation de plan (L6c). */
    carte: {
      executerDemander: "Exécuter en demandant à chaque fois",
      executerModifications: "Exécuter avec modifications automatiques",
      executerAutonome: "Exécuter en autonome avec contrôle",
      continuer: "Continuer à planifier",
    },
    /** §4.9, point 5 : première ligne du brouillon d'exécution, suivie du dernier texte du plan (texte simple). */
    brouillon: "Exécute le plan suivant.",
    /** 409 budget-guard de POST /api/plans : budget du mois atteint, création confirmée par x-cockpit-confirm: 1. */
    budget: {
      titre: "Budget du mois atteint",
      message:
        "Budget du mois atteint ({depense} sur {budget}). Créer cette conversation de plan ne coûte rien, mais chacun de ses messages sera facturé sur votre compte GitHub Copilot. Créer la conversation quand même ?",
      confirmer: "Créer quand même",
    },
    /** Messages d'erreur des routes de plans et du crochet d'envoi d'une conversation de plan. */
    erreurs: {
      identifiant: "Identifiant de conversation invalide.",
      /** Corps illisible, clé inconnue, choix « plan » ou inconnu, plafonds hors des bornes du cockpit. */
      requete: "Requête invalide.",
      /** Corps au-delà de 4 Kio (413). */
      tropLong: "Requête trop longue.",
      dossier: "Ce dossier est hors du workspace monté.",
      planInconnu: "Conversation de plan inconnue du cockpit.",
      sourceInconnue: "Conversation d'origine inconnue du cockpit.",
      sansReponse: "Ce plan n'a encore aucune réponse terminée : attendez la fin de sa réponse avant de l'exécuter.",
      lecture: "Conversation d'exécution non créée : le texte du plan n'a pas pu être lu dans opencode. Réessayez dans un instant.",
      planNonCree:
        "Conversation de plan non créée : le cockpit n'a pas pu vérifier qu'elle ne peut rien modifier. Aucun message n'a été envoyé ni facturé.",
      planRefuse:
        "Conversation de plan refusée : le cockpit n'a pas pu vérifier qu'elle ne peut rien modifier. Une conversation vide peut rester dans la liste, sans « Plan d'abord ». Aucun message n'a été envoyé ni facturé.",
      executionNonCreee:
        "Conversation d'exécution non créée : le cockpit n'a pas pu vérifier ses protections, dont le refus de lire les fichiers de clés. Aucun message n'a été envoyé ni facturé.",
      executionRefusee:
        "Conversation d'exécution refusée : le cockpit n'a pas pu vérifier ses protections, dont le refus de lire les fichiers de clés. Une conversation vide peut rester dans la liste. Aucun message n'a été envoyé ni facturé.",
      envoi: "Message non envoyé : le cockpit n'a pas pu vérifier que cette conversation de plan ne peut rien modifier. Rien n'a été facturé. Réessayez dans un instant.",
      envoiEcart:
        "Message non envoyé : le cockpit ne peut pas vérifier que cette conversation de plan ne peut rien modifier. Rien n'a été facturé. Continuez dans une nouvelle conversation de plan.",
    },
  },
};

/** Remplit les gabarits « {nom} » d'un texte ; un nom sans valeur est laissé tel quel. */
function remplir(gabarit: string, valeurs: Readonly<Record<string, string>>): string {
  return gabarit.replace(/\{(\w+)\}/g, (brut, nom: string) => valeurs[nom] ?? brut);
}

/** Message du garde-fou budgétaire de POST /api/plans ; montants déjà formatés (formatUsd). */
export function budgetPlan(depense: string, budget: string): string {
  return remplir(TEXTES.partout.budget.message, { depense, budget });
}

/** Brouillon d'exécution (§4.9, point 5) : « Exécute le plan suivant. », une ligne vide, puis le dernier texte du plan. */
export function brouillonExecution(textePlan: string): string {
  return `${TEXTES.partout.brouillon}\n\n${textePlan}`;
}
