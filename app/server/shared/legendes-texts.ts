// Textes des légendes conditionnelles de « Revoir » et de la salle de contrôle (spécification §5.7.1 l.935, §5.8 l.999-1002,
// §6 l.1067 ; JP-5, JP-6 ; plan d'exécution de l'itération 3, §4.2.3, paquet T3d-b). Les clés sont choisies par legendes.ts (L28a),
// qui ne contient aucune chaîne affichable (D-3d-21, contrôlé par textes-3d.test.ts) ; ce module les traduit (phrasesLegende).
// Convention TEXTES de T0, contrôlée par textes.test.ts ; « un sens par mot » et vocabulaire de la 3D : textes-3d.test.ts.
// Honnêteté (§5.8 l.1000-1001) : « Il ne voit pas votre conversation… » n'est jamais dit d'un assistant qui reprend son travail.
// L'extension n'est nommée qu'en mode Avancé.
// Module pur (server/shared).
import type { NeonMode } from "./neon-scene.ts";

// copie D-3d-27, remplacée au train de V0
export type LegendeKey = "neuf" | "reprise" | "carnet" | "tache-de-fond" | "reveil" | "relance";

export const TEXTES = {
  simple: {
    /** Relance sans demande de l'utilisateur, sans nommer l'extension (réservée au mode Avancé). */
    relance: "Relancé automatiquement, sans demande de votre part",
  },
  avance: {
    /** §5.7.2, cas 5 (même phrase que l'origine « relance-extension » de neon-texts.ts). */
    relance: "Relance par l'extension (sans demande)",
  },
  partout: {
    /** §5.8 l.1000 : enfant neuf et aucune tâche reprise. */
    neuf: "Il ne voit pas votre conversation : il reçoit seulement cette consigne et peut lire le projet",
    /** §5.8 l.1001 : sinon. */
    reprise: "Il reprend son travail précédent, avec tout son historique",
    /** §5.8 l.1002 : ajout dans la salle. */
    carnet: "Il peut lire le carnet partagé et le plan",
    /** §6 l.1067 : fait « reveil-sans-reponse ». */
    reveil: "Résultat déposé, lu à son prochain tour (sans appel d'IA)",
    /** §2.1 : délégation qui n'attend pas le résultat. */
    tacheDeFond: "Il travaille en tâche de fond : celui qui lui a confié le travail n'attend pas son résultat.",
    /** §5.8 l.999 : commandes d'une légende. */
    pourquoi: "Pourquoi ?",
    voirConsigne: "Voir la consigne",
    /** §5.7.1 l.935 (JP-6) : leçon centrale, deux premières phrases ; la troisième (leconSalle) s'y ajoute dans la salle. */
    lecon:
      "Les assistants ne s'envoient jamais de message directement : tout passe par celui qui confie le travail, consigne à l'aller, résultat au retour. Chaque appel d'IA part séparément vers GitHub Copilot.",
    leconSalle: "Dans la Salle OMO, ils se laissent aussi des notes dans des fichiers partagés.",
  },
};

/** Phrase de chaque clé commune aux deux modes ; « relance » dépend du mode. */
const PHRASE: Readonly<Record<Exclude<LegendeKey, "relance">, keyof typeof TEXTES.partout>> = {
  neuf: "neuf",
  reprise: "reprise",
  carnet: "carnet",
  "tache-de-fond": "tacheDeFond",
  reveil: "reveil",
};

/** Au plus deux phrases par légende (§5.8 l.999). */
const PHRASES_MAX = 2;

function phraseDe(cle: LegendeKey, mode: NeonMode): string | null {
  if (cle === "relance") return mode === "avance" ? TEXTES.avance.relance : TEXTES.simple.relance;
  return Object.hasOwn(PHRASE, cle) ? TEXTES.partout[PHRASE[cle]] : null;
}

/**
 * Phrases d'une légende, dans l'ordre des clés (legendes.ts suit celui de §5.8 l.1000-1002) : 1 ou 2 phrases, aucune si aucune
 * clé n'est connue. Garde d'honnêteté : « neuf » est écarté dès que « reprise » est présent (§5.8 l.1000-1001) ; doublons et clés
 * inconnues sont ignorés.
 */
export function phrasesLegende(cles: readonly LegendeKey[], mode: NeonMode): string[] {
  const reprise = cles.includes("reprise");
  const vues = new Set<LegendeKey>();
  const phrases: string[] = [];
  for (const cle of cles) {
    if (phrases.length === PHRASES_MAX) break;
    if (vues.has(cle) || (cle === "neuf" && reprise)) continue;
    vues.add(cle);
    const phrase = phraseDe(cle, mode);
    if (phrase !== null) phrases.push(phrase);
  }
  return phrases;
}
