// Propriétaire : L26b.
// Lignes de Salle OMO du Journal du contrôle (spécification §4.12 l.784, §5.7.4 l.987) : le verdict « refus-interdit », les
// actions « par : extension », les détections après coup et les fichiers mis en quarantaine. Module pur, sans React : le Journal
// (ControlJournal.tsx) ne fait que les afficher, et les données lui arrivent par PROPRIÉTÉS.
// Phrases : server/shared/omo-room-texts.ts (T3a), jamais réécrites ici. Deux libellés de colonne n'y existent pas, parce qu'ils
// n'existent pas non plus dans l'instance principale (autonomy-texts.ts n'a de mot ni pour « refus-interdit » ni pour
// « extension ») : ils sont écrits ici, dans le vocabulaire des autres colonnes du tableau.
// Honnêteté (P3) : une détection est vue APRÈS COUP, jamais avant ; l'action de l'extension est marquée « non contrôlé avant
// exécution » (§5.7.4). Aucun appel réseau, aucune écriture.
import type { DecisionBy, DecisionVerdict } from "../../../../server/shared/autonomy-types.ts";
import { libelleInterdit, phraseDetection, TEXTES } from "../../../../server/shared/omo-room-texts.ts";
import type { OmoDetectionCause, OmoForbiddenCategory, OmoSignale } from "../../../../server/shared/omo-types.ts";

const T = TEXTES.avance;

/** « Décision » d'un refus d'interdit absolu : ce verdict n'existe que dans la Salle OMO (§4.14.3). */
export const DECISION_REFUS_INTERDIT = "Refusé : interdit absolu";

/** « Par » d'une action vue sans demande d'autorisation : l'extension a agi, le cockpit l'a vue ensuite. */
export const PAR_EXTENSION = "l'extension";

/** Détection après coup montrée par le Journal (§4.14.5) ; les données viennent du Déroulé, jamais d'un appel d'ici. */
export interface JournalDetection {
  id: string;
  at: number;
  cause: OmoDetectionCause;
}

const CATEGORIES: ReadonlySet<string> = new Set(Object.keys(T.interdits.categories));

const estCategorieInterdite = (regle: string): regle is OmoForbiddenCategory => CATEGORIES.has(regle);

/** Décision propre à la Salle OMO : le verdict d'interdit absolu ou l'action vue sans demande. */
export function estDecisionOmo(decision: { verdict: DecisionVerdict; par: DecisionBy }): boolean {
  return decision.verdict === "refus-interdit" || decision.par === "extension";
}

/**
 * Marques ajoutées à la raison d'une ligne de la salle : le message d'interdit absolu remis à l'IA quand la règle nomme une
 * catégorie connue, et « non contrôlé avant exécution » pour toute action de l'extension. Liste vide pour une ligne ordinaire.
 */
export function marquesOmo(decision: { verdict: DecisionVerdict; par: DecisionBy; regle: string }): string[] {
  const marques: string[] = [];
  if (decision.verdict === "refus-interdit" && estCategorieInterdite(decision.regle)) {
    marques.push(T.interdits.message.replace("{categorie}", libelleInterdit(decision.regle)));
  }
  if (decision.par === "extension") marques.push(T.marques.nonControle);
  return marques;
}

/** Phrase d'une détection, suivie du rappel qu'elle est venue après coup (§4.14.5 l.851). */
export function phraseDetectionJournal(cause: OmoDetectionCause): string {
  return `${phraseDetection(cause)} ${T.detectionApresCoup}`;
}

/** Phrase d'un fichier signalé ou mis de côté (D-2b-37) ; {chemin} est rempli par le chemin du fichier. */
export function phraseQuarantaine(signale: OmoSignale): string {
  return T.signales[signale.genre].replace("{chemin}", signale.chemin);
}
