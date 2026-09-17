// Textes du choix d'autonomie d'une conversation (spécification §2.1, §4.9, §4.11, §4.13 ; plan d'exécution, fiche L6a) : nom
// du sélecteur, libellés et descriptions exactes des quatre choix, « Plan d'abord (nouvelle conversation) », raisons
// d'indisponibilité par code et messages des routes d'autonomie. Convention TEXTES de T0 (contrôlée par textes.test.ts).
// Module unique de ces phrases : repris tel quel, sans doublon, par L6s (sélecteur), L9b (phrases de l'autonomie), L10d
// (activation) et L12a (sélecteur à quatre choix). Les raisons propres à l'activation (regle-allow, mcp-ou-extension,
// profil-sans-confirmation, plancher-non-verifie) restent à écrire par L9b ; en attendant, raisonIndisponible rend la phrase
// générique, vraie pour toute raison.
import type { ActivationRefusalCode, AutonomyChoice } from "./autonomy-types.ts";

export const TEXTES = {
  simple: {},
  avance: {},
  partout: {
    /** Nom du sélecteur (§2.1). */
    selecteur: "Autonomie",
    choix: {
      demander: {
        libelle: "Demander à chaque fois",
        description: "L'IA lit, puis vous demande avant chaque modification, commande, accès web ou travail délégué.",
      },
      modifications: {
        libelle: "Modifications automatiques",
        description: "L'IA modifie les fichiers de ce dossier sans vous demander, sauf les fichiers protégés. Elle demande pour tout le reste.",
      },
      plan: {
        libelle: "Plan d'abord",
        /** Conversation existante (§4.9, point 1) : le plan s'écrit toujours dans une nouvelle conversation. */
        libelleNouvelleConversation: "Plan d'abord (nouvelle conversation)",
        description: "L'IA propose un plan dans une nouvelle conversation qui ne peut rien modifier.",
      },
      autonome: {
        libelle: "Autonome avec contrôle",
        description:
          "L'IA enchaîne le travail. Le cockpit laisse passer les actions jugées sûres et vous demande pour tout le reste. Arrêt automatique aux plafonds.",
      },
    },
    /** Raison d'un choix indisponible ou d'un refus (disponibles[].raison, 403 et 409 des routes), par code. */
    raisons: {
      /** Phrase fixée par le contrat de « a-venir » (autonomy-types.ts), reprise telle quelle. */
      "a-venir": "Pas encore disponible dans cette version du cockpit.",
      /** COCKPIT_AUTONOMY=off (décision n° 13) : seuls « Demander à chaque fois » et « Plan d'abord » restent possibles. */
      "autonomie-coupee": "Coupé sur ce cockpit par son administrateur : « Demander à chaque fois » et « Plan d'abord » restent possibles.",
      "nouvelle-conversation": "« Plan d'abord » s'ouvre toujours dans une nouvelle conversation.",
      /** §4.9, point 6 (F-g). */
      "racine-de-plan": "Conversation de plan : elle garde « Plan d'abord » et ne peut rien modifier, même plus tard.",
      /** Toute autre raison, tant que son module de textes ne l'a pas écrite. */
      autre: "Ce choix n'est pas disponible pour cette conversation.",
    },
    /** Messages d'erreur des routes GET et PUT /api/conversations/:rootId/autonomie. */
    erreurs: {
      identifiant: "Identifiant de conversation invalide.",
      inconnue: "Conversation inconnue du cockpit.",
      /** Corps illisible, choix inconnu, plafonds hors des bornes du cockpit. */
      requete: "Requête invalide.",
      /** Corps de PUT au-delà de 4 Kio (413). */
      tropLong: "Requête trop longue.",
      confirmation: "Confirmation requise : ce choix laisse l'IA agir sans vous demander.",
      /** Un autre choix est arrivé pendant la vérification : le dernier choix envoyé l'emporte. */
      remplace: "Un autre choix a été fait pendant la vérification : celui-ci n'a pas été appliqué.",
    },
  },
};

/** Phrase de la raison d'indisponibilité `code` ; null ou code sans phrase dans ce module : phrase générique. */
export function raisonIndisponible(code: ActivationRefusalCode | null): string {
  const { raisons } = TEXTES.partout;
  switch (code) {
    case "a-venir":
    case "autonomie-coupee":
    case "nouvelle-conversation":
    case "racine-de-plan":
      return raisons[code];
    default:
      return raisons.autre;
  }
}

/** Libellé du choix `choix` ; `nouvelleConversation` : « Plan d'abord (nouvelle conversation) » (conversation existante). */
export function libelleChoix(choix: AutonomyChoice, nouvelleConversation = false): string {
  if (choix === "plan" && nouvelleConversation) return TEXTES.partout.choix.plan.libelleNouvelleConversation;
  return TEXTES.partout.choix[choix].libelle;
}

/** Description exacte du choix `choix` (§4.13). */
export function descriptionChoix(choix: AutonomyChoice): string {
  return TEXTES.partout.choix[choix].description;
}
