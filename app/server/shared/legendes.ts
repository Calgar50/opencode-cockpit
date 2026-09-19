// Légendes conditionnelles (spécification §5.8 l.999-1002, §5.7.3, §7.7 l.1169, JP-2, JP-3, JP-5, U2 ; plan d'exécution it3, fiche
// L28a, D-3d-21) : pour les faits arrivés à un moment du lecteur, les clés des phrases à montrer et l'élément qui change.
// - Consigne envoyée (fait `consigne {etat: "envoyee"}`, enfant connu) : « reprise » si `data.reprise === true` OU si l'enfant était
//   déjà connu avant la consigne (un fait de sa session autre que sa création, ou une consigne ou un résultat qui le désigne) ;
//   « neuf » seulement sinon : la phrase « ne voit pas votre conversation » n'est JAMAIS émise sur une reprise (spéc. l.1169). Dans
//   la salle, ajout de « carnet ». Ancre : le nœud de l'enfant ; `callId` : celui du fait consigne, pour [Voir la consigne] (U2).
// - Tâche de fond (JP-3) : si le prédicat `tacheDeFond` le dit (défaut : jamais ; branché en « 3s »), légende à part, ancrée au
//   faisceau de la consigne : une légende garde ainsi 1 ou 2 phrases (spéc. l.999) et « carnet » ne l'efface pas.
// - Origine `reveil-sans-reponse` → « reveil » ; origine `relance-extension` → « relance » : ancre le nœud du message, callId null.
// - Au plus 2 clés par légende, dans l'ordre de spéc. l.1000-1002 (neuf ou reprise, puis carnet).
// Aucune chaîne affichable (D-3d-21, prouvé par textes-3d.test.ts de T3d-b) : les phrases sont dans legendes-texts.ts.
// Module pur (server/shared) : aucun module node, aucun accès à l'environnement, ni horloge ni aléa.
import type { ActivityFact } from "./activity-types.ts";
import { moments, visibleCount } from "./neon-scene.ts";

// copie D-3d-27, remplacée au train de V0
export type LegendeKey = "neuf" | "reprise" | "carnet" | "tache-de-fond" | "reveil" | "relance";

/** Élément de la scène qui porte la légende : nœud (sessionId) ou faisceau (id de NeonBeam). */
export interface LegendeAncre {
  genre: "noeud" | "faisceau";
  id: string;
}

export interface Legende {
  cles: LegendeKey[];
  ancre: LegendeAncre;
  /** Session dont parle la légende : l'enfant d'une consigne, sinon la session du message. */
  sessionId: string;
  /** Appel `task` d'une légende de consigne ([Voir la consigne], U2) ; null sinon. */
  callId: string | null;
}

export interface LegendesOptions {
  /** Racine de la Salle OMO : ajout de « carnet » aux consignes. */
  salle: boolean;
  /** Vrai pour une consigne confiée en tâche de fond (JP-3) ; absent : jamais. */
  tacheDeFond?: (fait: ActivityFact) => boolean;
}

/** Clés au plus par légende : 1 ou 2 phrases (spéc. l.999). */
export const LEGENDE_CLES_MAX = 2;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** Fait lisible, avec la même garde que scene() (neon-scene.ts). */
const estLisible = (fait: unknown): fait is ActivityFact =>
  isRecord(fait) && typeof fait.rootId === "string" && typeof fait.sessionId === "string" && typeof fait.kind === "string" && isRecord(fait.data);

/** Origines d'un message qui portent une légende (§5.7.2, cas 4 et 5). */
const CLES_ORIGINE: ReadonlyMap<string, LegendeKey> = new Map<string, LegendeKey>([
  ["reveil-sans-reponse", "reveil"],
  ["relance-extension", "relance"],
]);

/** Id du faisceau de la consigne, comme neon-scene.ts le compose (vérifié contre la scène par legendes.test.ts). */
const faisceauDeConsigne = (parent: string, callId: string): string => ["consigne", parent, callId].join(":");

/** Ajoute aux sessions connues ce qu'un fait en apprend ; la création d'une session ne la fait pas connaître. */
function apprendre(connues: Set<string>, fait: ActivityFact): void {
  const creation = fait.kind === "statut" && fait.data.etat === "creee";
  if (!creation) connues.add(fait.sessionId);
  const designe = (fait.kind === "consigne" && fait.data.etat === "envoyee") || fait.kind === "resultat";
  const enfant = designe ? str(fait.data.enfant) : null;
  if (enfant !== null) connues.add(enfant);
}

function legendesDuFait(fait: ActivityFact, connues: ReadonlySet<string>, options: LegendesOptions): Legende[] {
  if (fait.kind === "origine") {
    const cle = CLES_ORIGINE.get(String(fait.data.origine));
    return cle === undefined ? [] : [{ cles: [cle], ancre: { genre: "noeud", id: fait.sessionId }, sessionId: fait.sessionId, callId: null }];
  }
  if (fait.kind !== "consigne" || fait.data.etat !== "envoyee") return [];
  const enfant = str(fait.data.enfant);
  if (enfant === null) return [];
  const callId = str(fait.data.callId) ?? str(fait.ref);
  const reprise = fait.data.reprise === true || connues.has(enfant);
  // Ordre de spéc. l.1000-1002 ; 2 clés au plus (LEGENDE_CLES_MAX) par construction.
  const cles: LegendeKey[] = [reprise ? "reprise" : "neuf"];
  if (options.salle) cles.push("carnet");
  const out: Legende[] = [{ cles, ancre: { genre: "noeud", id: enfant }, sessionId: enfant, callId }];
  if (callId !== null && options.tacheDeFond?.(fait) === true) {
    out.push({ cles: ["tache-de-fond"], ancre: { genre: "faisceau", id: faisceauDeConsigne(fait.sessionId, callId) }, sessionId: enfant, callId });
  }
  return out;
}

/**
 * Légendes des faits arrivés au moment `t` (null : le dernier moment, en direct) : ceux que ce moment montre et que le moment
 * précédent ne montrait pas. Un `t` entre deux moments vaut le dernier moment qui le précède ; avant le premier : aucune.
 */
export function legendesAuMoment(faits: readonly ActivityFact[], t: number | null, options: LegendesOptions): Legende[] {
  const coupures = moments(faits);
  let p = coupures.length - 1;
  if (t !== null) while (p >= 0 && (coupures[p] ?? 0) > t) p -= 1;
  if (p < 0) return [];
  const fin = visibleCount(faits, coupures[p] ?? 0);
  const debut = p === 0 ? 0 : visibleCount(faits, coupures[p - 1] ?? 0);
  const rootId = faits.find(estLisible)?.rootId ?? null;
  const connues = new Set<string>();
  const out: Legende[] = [];
  for (let i = 0; i < fin; i++) {
    const fait = faits[i];
    if (!estLisible(fait) || fait.rootId !== rootId) continue;
    if (i >= debut) out.push(...legendesDuFait(fait, connues, options));
    apprendre(connues, fait);
  }
  return out;
}
