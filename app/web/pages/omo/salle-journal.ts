// Propriétaire : L26a (relecture 2ter-vague-2).
// Données du Journal du contrôle de la Salle OMO, rendu par la page de la salle (spécification §4.12 l.784 : bandeau permanent
// « Salle OMO · extension active · … » [Arrêter] [Journal] ; « Le journal montre aussi `refus-interdit`, les actions
// `par: extension` et les détections »). Module pur, sans React ni réseau : la page lui passe ce que le flux lui apporte, il rend
// ce que le Journal (ControlJournal.tsx, L26b) reçoit par PROPRIÉTÉS. Les décisions, elles, sont lues par la page avec
// `useControlDecisions` (GET /api/conversations/:rootId/activity, permis en mode Avancé pour une racine de la salle).
//
// Données du flux NON FIABLES : une cause ou un genre qu'aucun texte de T3a ne nomme est écarté, jamais deviné ni affiché
// « undefined » (P3). Les détections sont celles vues PENDANT la visite : le fait `detection` persisté et les fichiers signalés
// portés par `omo.hors-controle` arrivent avec L23c (vague 4, reste V2-2 du train) ; d'ici là, rien n'est inventé.
import { TEXTES } from "../../../server/shared/omo-room-texts.ts";
import type { OmoDetectionCause, OmoSignale } from "../../../server/shared/omo-types.ts";
import type { JournalDetection } from "../chat/autonomy/omo-journal.ts";

/** Détections gardées pendant une visite : au-delà, les plus anciennes sortent (le flux n'est pas une mémoire). */
export const DETECTIONS_MAX = 50;

/** Détection lue dans un événement `omo.hors-controle`. */
export interface DetectionLue {
  /** Racine de la demande ; null : activité sans racine attribuable (hors demande), qui concerne la salle entière. */
  rootId: string | null;
  cause: OmoDetectionCause;
  /** Fichiers signalés, quand le flux les porte (D-2b-37 ; demande de contrat de L26a) ; vide sinon. */
  signales: OmoSignale[];
}

/** Détection reçue par la page : numérotée et datée à la RÉCEPTION (le flux est en direct). */
export interface DetectionRecue extends DetectionLue {
  id: string;
  at: number;
}

const estCause = (valeur: unknown): valeur is OmoDetectionCause =>
  typeof valeur === "string" && Object.hasOwn(TEXTES.avance.detections, valeur);

const estGenre = (valeur: unknown): valeur is OmoSignale["genre"] =>
  typeof valeur === "string" && Object.hasOwn(TEXTES.avance.signales, valeur);

const estObjet = (valeur: unknown): valeur is Record<string, unknown> => typeof valeur === "object" && valeur !== null;

/** Détection lue dans les données d'un événement du flux : lue avec prudence, jamais devinée ; null si la cause est illisible. */
export function lireDetection(data: unknown): DetectionLue | null {
  if (!estObjet(data) || !estCause(data.cause)) return null;
  const signales: OmoSignale[] = [];
  if (Array.isArray(data.signales)) {
    for (const entree of data.signales as unknown[]) {
      if (!estObjet(entree) || typeof entree.chemin !== "string" || !estGenre(entree.genre)) continue;
      signales.push({ chemin: entree.chemin, genre: entree.genre });
    }
  }
  return { rootId: typeof data.rootId === "string" ? data.rootId : null, cause: data.cause, signales };
}

/** Ajoute une détection reçue à la liste de la visite, bornée à `DETECTIONS_MAX`. */
export function ajouterDetection(liste: readonly DetectionRecue[], lue: DetectionLue, id: string, at: number): DetectionRecue[] {
  return [...liste, { ...lue, id, at }].slice(-DETECTIONS_MAX);
}

/**
 * Détections et fichiers mis de côté du Journal de la racine ouverte : ses détections et celles sans racine (hors demande, qui
 * visent la salle entière), jamais celles d'une autre racine ; fichiers sans doublon, dans l'ordre d'arrivée.
 */
export function journalDeLaSalle(rootId: string, recues: readonly DetectionRecue[]): { detections: JournalDetection[]; quarantaine: OmoSignale[] } {
  const miennes = recues.filter((detection) => detection.rootId === rootId || detection.rootId === null);
  const vus = new Set<string>();
  const quarantaine: OmoSignale[] = [];
  for (const detection of miennes) {
    for (const signale of detection.signales) {
      const cle = `${signale.genre}:${signale.chemin}`;
      if (vus.has(cle)) continue;
      vus.add(cle);
      quarantaine.push(signale);
    }
  }
  return { detections: miennes.map(({ id, at, cause }) => ({ id, at, cause })), quarantaine };
}

/** Le Journal de `rootId` est à relire après cet événement : une décision enregistrée pour CETTE racine. */
export function relireJournalApres(type: string, data: unknown, rootId: string): boolean {
  if (!estObjet(data) || data.rootId !== rootId) return false;
  return type === "autonomie.decision" || (type === "activite.fait" && data.kind === "decision");
}
