// Lecteur « Revoir » (spécification §5.8 l.998, §5.9, §7.7 l.1169, P12 ; plan d'exécution it3, fiche L28a, D-3d-10, D-3d-11) :
// état pur du lecteur en différé, posé sur les moments de neon-scene.ts. Revoir la demande k = scene(tousLesFaits, t) avec t
// parcourant les moments de sa fenêtre : positions de toute la conversation, donc « différé = direct » (D-3d-10).
// - demandes(faits, racine) : fenêtres délimitées par les faits `origine {origine: "demande"}` de la racine ; la demande k va de son
//   fait (inclus) au fait de la demande k+1 (exclu), ou jusqu'au dernier fait.
// - ouvrir(faits, demande | null) : moments de la fenêtre (toute la conversation pour null), lecteur figé sur le dernier, à ×1.
// - Transitions pures (lire, figer, precedent, suivant, aller, choisirVitesse, auDirect) : bornées, jamais d'effet de bord. La
//   lecture ne reste jamais active sur le dernier moment : elle s'y fige.
// - delaiSuivant (D-3d-11) : écart réel / vitesse ; un écart réel de plus de 4 s est montré en 1 s, avec raccourciMs = l'écart
//   (étiquette « {duree} sans nouvel événement, montrées en 1 s », texte de T3d-b) ; null au dernier moment.
// - cibleASuivre : premier nœud, faisceau ou attente apparu ou changé d'état entre deux scènes (« Suivre l'action »).
// Aucune chaîne affichable (D-3d-21) : codes seulement ; les phrases viennent de revoir-texts.ts (T3d-b). Les minuteries
// appartiennent à l'appelant (useReplay, L28c).
// Module pur (server/shared) : aucun module node, aucun accès à l'environnement, ni horloge ni aléa.
import type { ActivityFact } from "./activity-types.ts";
import { moments as momentsDesFaits, type NeonScene } from "./neon-scene.ts";

// copie D-3d-27, remplacée au train de V0
export type ReplaySpeed = 0.25 | 0.5 | 1 | 2 | 4;
// copie D-3d-27, remplacée au train de V0
export type ReplayBadge = { etat: "direct" } | { etat: "differe"; vitesse: ReplaySpeed; heure: number };

/** Vitesses du lecteur, dans l'ordre du menu (D-3d-11) ; ×1 par défaut. */
export const VITESSES: readonly ReplaySpeed[] = Object.freeze([0.25, 0.5, 1, 2, 4]);
/** Écart réel au-delà duquel un moment sans événement est raccourci, et durée montrée à la place (D-3d-11). */
export const RACCOURCI = Object.freeze({ seuilMs: 4_000, montreMs: 1_000 });

/** Une demande de la conversation (D-3d-10). */
export interface Demande {
  /** Rang de la demande : 0 pour la première (« Demande {n} sur {total} », n = index + 1). */
  index: number;
  /** Indice de son fait `origine {origine: "demande"}` dans la liste des faits. */
  debut: number;
  /** Indice du fait de la demande suivante, exclu ; null : jusqu'au dernier fait. */
  fin: number | null;
  fait: ActivityFact;
}

/** État du lecteur ; `moments` : heures des moments de la fenêtre, croissantes (coupures nettes de neon-scene.ts). */
export interface ReplayState {
  moments: readonly number[];
  index: number;
  vitesse: ReplaySpeed;
  lecture: boolean;
  direct: boolean;
}

/** Délai avant le moment suivant ; `raccourciMs` : écart réel d'un moment raccourci (étiquette), null sinon. */
export interface ReplayDelay {
  ms: number;
  raccourciMs: number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Heure d'un fait, lue comme neon-scene.ts (visibleCount) : une heure illisible vaut 0. */
const timeOf = (fact: ActivityFact | undefined): number => (typeof fact?.at === "number" && Number.isFinite(fact.at) ? fact.at : 0);

function estDemande(fait: unknown, rootId: string): fait is ActivityFact {
  return isRecord(fait) && fait.kind === "origine" && fait.rootId === rootId && fait.sessionId === rootId && isRecord(fait.data) && fait.data.origine === "demande";
}

/** Demandes de la racine, dans l'ordre des faits (D-3d-10). */
export function demandes(faits: readonly ActivityFact[], rootId: string): Demande[] {
  const debuts: number[] = [];
  faits.forEach((fait, i) => {
    if (estDemande(fait, rootId)) debuts.push(i);
  });
  return debuts.map((debut, index) => ({ index, debut, fin: debuts[index + 1] ?? null, fait: faits[debut] as ActivityFact }));
}

/**
 * Nombre de faits visibles à chacun des moments (croissants) : même règle que visibleCount de neon-scene.ts (jusqu'au dernier fait
 * dont l'heure est au plus t), en un seul passage à rebours au lieu d'un parcours par moment.
 */
function visiblesAuxMoments(faits: readonly ActivityFact[], moments: readonly number[]): number[] {
  const out = new Array<number>(moments.length).fill(0);
  let last = faits.length - 1;
  for (let k = moments.length - 1; k >= 0; k--) {
    const t = moments[k] ?? 0;
    while (last >= 0 && timeOf(faits[last]) > t) last -= 1;
    out[k] = last + 1;
  }
  return out;
}

/**
 * Vrai si la demande désigne bien un fait de demande de ces faits (un indice hors bornes ou fractionnaire ne désigne aucun fait),
 * avec une fin après son début.
 */
function demandeValide(faits: readonly ActivityFact[], demande: Demande): boolean {
  const { debut, fin } = demande;
  const fait = faits[debut];
  if (!isRecord(fait) || fait.kind !== "origine" || !isRecord(fait.data) || fait.data.origine !== "demande") return false;
  return fin === null || (Number.isSafeInteger(fin) && fin > debut && fin <= faits.length);
}

/**
 * Moments de la fenêtre d'une demande : ceux qui montrent son fait et pas celui de la demande suivante. Fenêtre vide (heures
 * inversées de moins de 223 ms, M15, qui mêlent deux demandes dans un même moment) : le premier moment qui montre la demande.
 */
function momentsDeLaFenetre(faits: readonly ActivityFact[], demande: Demande): number[] {
  if (!demandeValide(faits, demande)) return [];
  const tous = momentsDesFaits(faits);
  const visibles = visiblesAuxMoments(faits, tous);
  const { debut, fin } = demande;
  const dedans = tous.filter((_, k) => {
    const n = visibles[k] ?? 0;
    return n > debut && (fin === null || n <= fin);
  });
  if (dedans.length > 0) return dedans;
  const premier = tous.find((_, k) => (visibles[k] ?? 0) > debut);
  return premier === undefined ? [] : [premier];
}

/** Lecteur ouvert sur une demande (null : toute la conversation), figé sur le dernier moment de la fenêtre, à ×1. */
export function ouvrir(faits: readonly ActivityFact[], demande: Demande | null): ReplayState {
  const moments = demande === null ? momentsDesFaits(faits) : momentsDeLaFenetre(faits, demande);
  return { moments, index: Math.max(0, moments.length - 1), vitesse: 1, lecture: false, direct: false };
}

const dernier = (state: ReplayState): number => Math.max(0, state.moments.length - 1);

/** Place le lecteur (borné) en différé ; la lecture ne reste active qu'avant le dernier moment. Indice illisible : rien ne change. */
function placer(state: ReplayState, index: number, lecture: boolean): ReplayState {
  if (!Number.isFinite(index)) return state;
  const borne = Math.min(Math.max(0, Math.trunc(index)), dernier(state));
  return { ...state, index: borne, lecture: lecture && borne < dernier(state), direct: false };
}

/** « Lire » : depuis le moment courant ; depuis le dernier, reprend au premier. */
export const lire = (state: ReplayState): ReplayState => placer(state, state.index >= dernier(state) ? 0 : state.index, true);

/** « Figer ici » : la lecture s'arrête sur le moment courant (en différé). */
export const figer = (state: ReplayState): ReplayState => ({ ...state, lecture: false, direct: false });

/** Moment précédent (borné au premier). */
export const precedent = (state: ReplayState): ReplayState => placer(state, state.index - 1, state.lecture);

/** Moment suivant (borné au dernier, où la lecture se fige) : aussi le pas de la lecture. */
export const suivant = (state: ReplayState): ReplayState => placer(state, state.index + 1, state.lecture);

/** Moment `index` (borné). */
export const aller = (state: ReplayState, index: number): ReplayState => placer(state, index, state.lecture);

/** Vitesse du lecteur ; une valeur hors de VITESSES est refusée (état inchangé). */
export function choisirVitesse(state: ReplayState, vitesse: number): ReplayState {
  const choisie = VITESSES.find((v) => v === vitesse);
  return choisie === undefined ? state : { ...state, vitesse: choisie };
}

/** « Revenir au direct » (ReplayBarProps.onDirect) : dernier moment, lecture arrêtée. */
export const auDirect = (state: ReplayState): ReplayState => ({ ...state, index: dernier(state), lecture: false, direct: true });

/** Délai avant le moment suivant (D-3d-11) ; null au dernier moment, en direct, ou sans moment suivant. */
export function delaiSuivant(state: ReplayState): ReplayDelay | null {
  if (state.direct || state.index >= dernier(state)) return null;
  const actuel = state.moments[state.index];
  const prochain = state.moments[state.index + 1];
  if (actuel === undefined || prochain === undefined) return null;
  const ecart = prochain - actuel;
  if (ecart > RACCOURCI.seuilMs) return { ms: RACCOURCI.montreMs, raccourciMs: ecart };
  const vitesse = VITESSES.find((v) => v === state.vitesse) ?? 1;
  return { ms: ecart / vitesse, raccourciMs: null };
}

/**
 * Heure `t` à donner à scene() : null en direct ; sinon le moment courant. Sans aucun moment (aucun fait dans la fenêtre) : avant
 * tout fait, pour une scène vide plutôt que la conversation entière.
 */
export function instant(state: ReplayState): number | null {
  if (state.direct) return null;
  return state.moments[state.index] ?? Number.NEGATIVE_INFINITY;
}

/** Badge « EN DIRECT » ou « EN DIFFÉRÉ ×v · heure » (texte de T3d-b) ; heure 0 sans aucun moment. */
export function badge(state: ReplayState): ReplayBadge {
  if (state.direct) return { etat: "direct" };
  return { etat: "differe", vitesse: VITESSES.find((v) => v === state.vitesse) ?? 1, heure: state.moments[state.index] ?? 0 };
}

/**
 * « Suivre l'action » : identifiant du premier signe apparu ou changé d'état entre deux scènes, dans l'ordre nœuds (sessionId),
 * faisceaux (id), attentes (permissionId) ; null si rien n'a changé. Un signe disparu n'est pas suivi.
 */
export function cibleASuivre(avant: NeonScene, apres: NeonScene): string | null {
  const etats = new Map(avant.noeuds.map((noeud) => [noeud.sessionId, noeud.etat]));
  for (const noeud of apres.noeuds) if (etats.get(noeud.sessionId) !== noeud.etat) return noeud.sessionId;
  const faisceaux = new Map(avant.faisceaux.map((faisceau) => [faisceau.id, faisceau]));
  for (const faisceau of apres.faisceaux) {
    const vu = faisceaux.get(faisceau.id);
    if (vu === undefined || vu.fige !== faisceau.fige || vu.fin !== faisceau.fin) return faisceau.id;
  }
  const attentes = new Set(avant.attentes.map((attente) => attente.permissionId));
  for (const attente of apres.attentes) if (!attentes.has(attente.permissionId)) return attente.permissionId;
  return null;
}
