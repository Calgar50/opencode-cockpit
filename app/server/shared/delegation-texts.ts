// Textes du travail délégué par l'IA hors équipes (spécification §3.14, §6 l.1038, décision n° 4 ; plan d'exécution, fiche L1d et
// question Q5) : avis du mode Simple, message envoyé à l'IA avec le refus Simple, refus de la garde du « task once » par code
// (409 delegation-refusee) et messages de la route des détails d'une délégation. Convention TEXTES de T0 (textes.test.ts).
// Q5 (décision de l'utilisateur, option b) : l'avis Simple s'arrête à « elle continue seule. », sans [Voir les équipes] ni phrase
// sur les équipes tant qu'elles n'existent pas (P3) ; le texte complet viendra en itération 4 (L38).
// Honnêteté (P3), chaque phrase tenue par task-once-guard.test.ts :
// - « Rien n'a été lancé » : un refus de la garde ne relaie jamais le « once » (aucune réponse reçue par opencode) ;
// - « La demande d'autorisation reste en attente » : la garde ne répond rien à opencode, la demande reste à l'utilisateur ;
// - l'avis Simple : le refus part avec le message à l'IA par rejectWhenAlone, jamais avant la réponse à une autre demande de la même
//   conversation (votre autre demande n'est pas annulée) ; M9 (l'IA continue seule sur une IA Copilot réelle) : recette en attente.
import { formatUsd } from "./assistant-rules.ts";
import type { DelegationRefusalCode } from "./activity-types.ts";

export const TEXTES = {
  simple: {
    /** Avis affiché en mode Simple quand l'IA veut déléguer (Q5, option b). */
    avis: "En mode Simple, l'IA ne délègue pas : elle continue seule.",
  },
  avance: {},
  partout: {
    /** Message joint au refus Simple, lu par l'IA (refus avec message : elle peut continuer seule). */
    messageIa: "Travaille seul : le mode Simple n'autorise pas la délégation.",
    /** Refus de la garde du « task once » (§3.14), par code : 409 delegation-refusee, rien n'est relayé. */
    refus: {
      "demande-morte": "Cette demande d'autorisation n'est plus active : rien n'a été lancé.",
      "cible-refusee":
        "Travail délégué refusé : l'assistant demandé est inconnu, réservé aux conversations ou interne au cockpit. Rien n'a été lancé. La demande d'autorisation reste en attente.",
      "task-id-hors-arbre":
        "Travail délégué refusé : l'IA veut reprendre un travail qui n'appartient pas à cette conversation. Rien n'a été lancé. La demande d'autorisation reste en attente.",
      "consigne-refusee":
        "Travail délégué refusé : sa consigne cite un fichier avec « @ » (il serait lu sans vous demander), une commande « !` » ou une adresse web, ou elle est illisible. Rien n'a été lancé. La demande d'autorisation reste en attente.",
      "ia-refusee":
        "Travail délégué refusé : son IA n'est pas autorisée par le cockpit ou n'est pas disponible pour votre compte GitHub Copilot. Rien n'a été lancé. La demande d'autorisation reste en attente.",
      /** Garde-fou budgétaire, budget du mois atteint. */
      "budget-refuse":
        "Travail délégué refusé par le garde-fou budgétaire : le budget du mois est atteint. Rien n'a été lancé. La demande d'autorisation reste en attente.",
      /** Garde-fou budgétaire, IA plus chère que le prix fixé au-delà du seuil du budget du mois. */
      "budget-refuse-ia-chere":
        "Travail délégué refusé par le garde-fou budgétaire : le seuil du budget du mois est dépassé et son IA coûte plus que le prix fixé. Rien n'a été lancé. La demande d'autorisation reste en attente.",
      "plafond-atteint":
        "Travail délégué refusé : plafond de cette demande atteint (délégations : {delegations} sur {delegationsMax} ; dépense : {depense} sur {plafond}). Rien n'a été lancé. La demande d'autorisation reste en attente.",
    },
    /**
     * opencode n'a pas répondu pendant la vérification : 503, rien n'est relayé. Générique : la garde ne sait pas encore s'il s'agit
     * d'une délégation quand la liste des demandes est illisible.
     */
    verificationImpossible: "opencode ne répond pas : impossible de vérifier cette demande d'autorisation. Rien n'a été envoyé, réessayez dans un instant.",
    /** Route GET /api/conversations/:rootId/delegations/:permissionId. */
    erreurs: {
      identifiant: "Identifiant de conversation ou de demande invalide.",
      inconnue: "Aucune demande de travail délégué en attente avec cet identifiant dans cette conversation.",
    },
  },
};

/** Remplit un gabarit « {nom} » ; un nom absent des valeurs garde son gabarit. */
function remplir(gabarit: string, valeurs: Readonly<Record<string, string | number>>): string {
  return gabarit.replace(/\{(\w+)\}/g, (match: string, nom: string) => (Object.hasOwn(valeurs, nom) ? String(valeurs[nom]) : match));
}

/** Avis du mode Simple sur la délégation (Q5). */
export function avisSimple(): string {
  return TEXTES.simple.avis;
}

/** Message joint au refus Simple, envoyé à l'IA (décision n° 4). */
export function messageRefusSimple(): string {
  return TEXTES.partout.messageIa;
}

/** Compteurs du plafond par demande, pour la phrase « plafond-atteint ». */
export interface PlafondValeurs {
  delegations: number;
  delegationsMax: number;
  depenseUsd: number;
  plafondUsd: number;
}

/**
 * Phrase d'un refus de la garde. `budget` : code du garde-fou budgétaire (ledger.guard) pour « budget-refuse » ; `plafond` : compteurs
 * pour « plafond-atteint » (sans eux, la phrase garde ses gabarits : jamais de chiffre inventé).
 */
export function refusDelegation(
  code: DelegationRefusalCode,
  details: { budget?: "budget-exhausted" | "expensive-model" | null; plafond?: PlafondValeurs | null } = {},
): string {
  const { refus } = TEXTES.partout;
  switch (code) {
    case "budget-refuse":
      return details.budget === "expensive-model" ? refus["budget-refuse-ia-chere"] : refus["budget-refuse"];
    case "plafond-atteint": {
      const p = details.plafond;
      if (!p) return refus["plafond-atteint"];
      return remplir(refus["plafond-atteint"], {
        delegations: p.delegations,
        delegationsMax: p.delegationsMax,
        depense: formatUsd(p.depenseUsd),
        plafond: formatUsd(p.plafondUsd),
      });
    }
    default:
      return refus[code];
  }
}

/** 503 : vérification impossible (opencode injoignable ou réponse illisible). */
export function verificationImpossible(): string {
  return TEXTES.partout.verificationImpossible;
}

/** Messages d'erreur de la route des détails : 400 et 404. */
export function erreurDetails(erreur: "identifiant" | "inconnue"): string {
  return TEXTES.partout.erreurs[erreur];
}
