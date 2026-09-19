// Fluidité et repli 2D de la salle de contrôle (spécification §5.8 l.1003-1008, JP-12 ; §7.7 l.1171 ; plan it3, fiche L30,
// D-3d-17, D-3d-18, D-3d-25, D-3d-27) : module PUR, partagé avec l'interface (web/pages/salle-controle/fluidite.ts). Ni « node: »,
// ni process, ni horloge, ni aléa : chaque heure et chaque durée vient de l'appelant.
//
// - verdictCapacites : 2D ou 3D d'après les réglages d'accessibilité, la préférence du poste et le contexte webgl2, dans l'ordre
//   de la spécification ; « 3d » veut dire « 3D sous réserve de la sonde » ;
// - verdictSonde : sonde forcée de 90 images ; 3D si le 95e centile est ≤ 20 ms et si 3 images au plus dépassent 50 ms ;
// - surveiller : surveillance des seules images animées ; bascule proposée après 5 s de temps animé lent, automatique à 10 s ;
// - lirePreference / ecrirePreference : préférence par poste (clé localStorage « cockpit.salle3d », D-3d-25), illisible = auto.
// Aucun texte affiché : les raisons (FluidityReason) sont mises en phrases par la page (messageFluidite de salle3d-texts.ts). Les
// noms de RENDUS_LOGICIELS sont des motifs de comparaison, jamais affichés (D-3d-21).

// copie D-3d-27, remplacée au train de V0
export type FluidityReason = "accessibilite" | "webgl-absent" | "rendu-logiciel" | "sonde-lente" | "saccades" | "preference-2d";
// copie D-3d-27, remplacée au train de V0
export type FluidityVerdict = { mode: "3d" } | { mode: "2d"; raison: FluidityReason };

/** Les six raisons d'un affichage 2D, dans l'ordre du type (validation de la préférence lue). */
export const RAISONS_FLUIDITE = [
  "accessibilite",
  "webgl-absent",
  "rendu-logiciel",
  "sonde-lente",
  "saccades",
  "preference-2d",
] as const satisfies readonly FluidityReason[];

/** Seuils de la spécification (§5.8 l.1006-1007). */
export const FLUIDITE = {
  sonde: { images: 90, p95MaxMs: 20, lenteMs: 50, lentesMax: 3 },
  surveillance: { seuilMs: 33, proposerMs: 5_000, basculerMs: 10_000 },
} as const;

/** Surveillance : une période lente prend fin quand la médiane de ces dernières images animées repasse sous le seuil. */
export const MEDIANE_IMAGES = 10;

/**
 * Surveillance : part d'une seule image dans le temps animé lent. Une image d'une minute (onglet masqué, poste en veille, boucle
 * du moteur relancée) ne vaut pas une minute de saccades ; une scène vraiment figée bascule quand même, une seconde par image.
 */
export const IMAGE_MAX_MS = 1_000;

/** Moteurs de rendu sans carte graphique (bureau à distance, machine virtuelle) : sous-chaîne, casse ignorée. */
export const RENDUS_LOGICIELS = ["SwiftShader", "llvmpipe", "Microsoft Basic Render"] as const;

/** Clé localStorage de la préférence du poste (D-3d-25). */
export const PREFERENCE_CLE = "cockpit.salle3d";

/** Préférence lue plus longue que cette borne (caractères) : illisible, donc auto. */
export const PREFERENCE_BRUT_MAX = 256;

export type PreferenceChoix = "2d" | "auto";

/** Préférence du poste, format D-3d-25 : `{"v":1,"choix":"2d"|"auto","raison":<code>,"le":<ms>}`. */
export interface Preference {
  v: 1;
  choix: PreferenceChoix;
  /** Cause du choix (null : aucune, par exemple après [Réessayer]). */
  raison: FluidityReason | null;
  /** Heure de l'écriture, en millisecondes depuis 1970 (null si inconnue). */
  le: number | null;
}

/** Ce que le navigateur dit du poste (web/pages/salle-controle/fluidite.ts, capacites()). */
export interface CapacitesNavigateur {
  /** `prefers-reduced-motion: reduce`. */
  mouvementReduit: boolean;
  /** `forced-colors: active`. */
  couleursForcees: boolean;
  /** Un contexte webgl2 est obtenu, avec ou sans failIfMajorPerformanceCaveat. */
  webgl2: boolean;
  /** Contexte webgl2 refusé quand il est demandé avec failIfMajorPerformanceCaveat: true. */
  contexteRefuse: boolean;
  /** Nom du moteur de rendu (WEBGL_debug_renderer_info) ; null si l'extension est absente : la sonde décide. */
  moteur: string | null;
}

export interface CapacitesPoste extends CapacitesNavigateur {
  /** Choix gardé pour ce poste (lirePreference). */
  preference: PreferenceChoix;
}

export interface ResultatSonde {
  ok: boolean;
  /** 95e centile des durées d'image (ms) ; NaN sans image. */
  p95: number;
  /** Images de plus de 50 ms. */
  lentes: number;
}

export interface PeriodeLente {
  /** Heure (horloge de l'appelant) de la première image lente de la période. */
  debut: number;
  /** Temps animé cumulé depuis cette image (ms), chaque image bornée à IMAGE_MAX_MS. */
  lentMs: number;
  /** La bascule a déjà été proposée pendant cette période. */
  proposee: boolean;
}

export interface EtatSurveillance {
  /** Durées des dernières images animées (MEDIANE_IMAGES au plus), la plus récente en dernier. */
  recentes: readonly number[];
  /** Période lente en cours, null sinon. */
  periode: PeriodeLente | null;
}

export type ActionSurveillance = "rien" | "proposer" | "basculer";

export const SURVEILLANCE_INITIALE: EtatSurveillance = Object.freeze({ recentes: Object.freeze([]), periode: null });

const deuxD = (raison: FluidityReason): FluidityVerdict => ({ mode: "2d", raison });

/** Le nom du moteur de rendu désigne-t-il un rendu logiciel (RENDUS_LOGICIELS) ? */
export function estRenduLogiciel(moteur: string): boolean {
  const nom = moteur.toLowerCase();
  return RENDUS_LOGICIELS.some((motif) => nom.includes(motif.toLowerCase()));
}

/**
 * Verdict avant la sonde, dans l'ordre de la spécification (§5.8 l.1004-1008) :
 * 1. mouvement réduit ou couleurs forcées → « accessibilite » (l'emporte sur tout) ;
 * 2. préférence 2D du poste → « preference-2d » ;
 * 3. aucun contexte webgl2 → « webgl-absent » ; contexte refusé avec failIfMajorPerformanceCaveat → « rendu-logiciel » ;
 * 4. moteur de rendu logiciel (SwiftShader, llvmpipe, Microsoft Basic Render) → « rendu-logiciel » ;
 * 5. sinon 3D sous réserve de la sonde ; moteur inconnu (extension absente) : la sonde décide.
 */
export function verdictCapacites(capacites: CapacitesPoste): FluidityVerdict {
  if (capacites.mouvementReduit || capacites.couleursForcees) return deuxD("accessibilite");
  if (capacites.preference === "2d") return deuxD("preference-2d");
  if (!capacites.webgl2) return deuxD("webgl-absent");
  if (capacites.contexteRefuse) return deuxD("rendu-logiciel");
  if (capacites.moteur !== null && estRenduLogiciel(capacites.moteur)) return deuxD("rendu-logiciel");
  return { mode: "3d" };
}

/**
 * Centile `p` (0 < p ≤ 100) au rang le plus proche : la plus petite valeur telle qu'au moins p % des valeurs lui sont inférieures
 * ou égales. NaN pour une liste vide ou un `p` hors bornes. La liste reçue n'est jamais modifiée.
 */
export function centile(valeurs: readonly number[], p: number): number {
  const tri = [...valeurs].sort((a, b) => a - b);
  // Rang hors de la liste (liste vide, p ≤ 0, p > 100, p NaN) : aucune valeur, donc NaN.
  return tri[Math.ceil((p * tri.length) / 100) - 1] ?? Number.NaN;
}

/** Médiane (moyenne des deux valeurs centrales pour un nombre pair) ; NaN pour une liste vide. */
export function mediane(valeurs: readonly number[]): number {
  const tri = [...valeurs].sort((a, b) => a - b);
  const milieu = Math.floor(tri.length / 2);
  const haut = tri[milieu] ?? Number.NaN;
  return tri.length % 2 === 1 ? haut : ((tri[milieu - 1] ?? Number.NaN) + haut) / 2;
}

/** Durée d'image mesurable : nombre fini et positif ou nul. */
const mesurable = (ms: number) => Number.isFinite(ms) && ms >= 0;

/**
 * Sonde forcée (§5.8 l.1006) : `ok` si au moins 90 images sont mesurées, si leur 95e centile est ≤ 20 ms et si 3 images au plus
 * dépassent 50 ms. Moins de 90 images → pas ok. Une durée non mesurable (NaN, infinie, négative) compte comme une image lente :
 * dans le doute, la 3D n'est pas retenue.
 */
export function verdictSonde(ms: readonly number[]): ResultatSonde {
  const { images, p95MaxMs, lenteMs, lentesMax } = FLUIDITE.sonde;
  const durees = ms.map((valeur) => (mesurable(valeur) ? valeur : Number.POSITIVE_INFINITY));
  const p95 = centile(durees, 95);
  const lentes = durees.filter((valeur) => valeur > lenteMs).length;
  return { ok: durees.length >= images && p95 <= p95MaxMs && lentes <= lentesMax, p95, lentes };
}

/**
 * Surveillance (§5.8 l.1007) d'une image rendue en 3D. Les images non animées sont ignorées (état rendu tel quel), comme les
 * durées non mesurables. Une période lente commence à la première image animée de plus de 33 ms ; elle est remise à zéro quand
 * la médiane des 10 dernières images animées repasse sous 33 ms. Son temps animé (chaque image bornée à IMAGE_MAX_MS) donne
 * « proposer » une fois à 5 s, puis « basculer » à 10 s et au-delà.
 */
export function surveiller(etat: EtatSurveillance, image: { ms: number; anime: boolean; now: number }): { etat: EtatSurveillance; action: ActionSurveillance } {
  if (!image.anime || !mesurable(image.ms)) return { etat, action: "rien" };
  const { seuilMs, proposerMs, basculerMs } = FLUIDITE.surveillance;
  const recentes = [...etat.recentes, image.ms].slice(-MEDIANE_IMAGES);
  const part = Math.min(image.ms, IMAGE_MAX_MS);
  let periode = etat.periode;
  if (periode !== null) periode = mediane(recentes) < seuilMs ? null : { ...periode, lentMs: periode.lentMs + part };
  else if (image.ms > seuilMs) periode = { debut: image.now, lentMs: part, proposee: false };
  if (periode === null) return { etat: { recentes, periode }, action: "rien" };
  if (periode.lentMs >= basculerMs) return { etat: { recentes, periode }, action: "basculer" };
  if (periode.lentMs >= proposerMs && !periode.proposee) return { etat: { recentes, periode: { ...periode, proposee: true } }, action: "proposer" };
  return { etat: { recentes, periode }, action: "rien" };
}

const estRaison = (valeur: unknown): valeur is FluidityReason => (RAISONS_FLUIDITE as readonly unknown[]).includes(valeur);

/** Préférence par défaut : auto (la sonde décide). */
export function preferenceAuto(): Preference {
  return { v: 1, choix: "auto", raison: null, le: null };
}

/**
 * Préférence gardée (D-3d-25). Absente, trop longue, JSON invalide, version inconnue, choix, raison ou heure hors format :
 * illisible, donc auto. Seuls les quatre champs du format sont lus.
 */
export function lirePreference(brut: string | null): Preference {
  if (typeof brut !== "string" || brut.length > PREFERENCE_BRUT_MAX) return preferenceAuto();
  let valeur: unknown;
  try {
    valeur = JSON.parse(brut);
  } catch {
    return preferenceAuto();
  }
  if (typeof valeur !== "object" || valeur === null) return preferenceAuto();
  const { v, choix, raison, le } = valeur as Record<string, unknown>;
  if (v !== 1 || (choix !== "2d" && choix !== "auto")) return preferenceAuto();
  if (raison !== null && !estRaison(raison)) return preferenceAuto();
  if (le !== null && !(typeof le === "number" && mesurable(le))) return preferenceAuto();
  return { v: 1, choix, raison, le };
}

/** Valeur à écrire sous PREFERENCE_CLE (D-3d-25) ; une heure non mesurable est écrite null. */
export function ecrirePreference(choix: PreferenceChoix, raison: FluidityReason | null, le: number): string {
  const preference: Preference = { v: 1, choix, raison, le: mesurable(le) ? Math.floor(le) : null };
  return JSON.stringify(preference);
}
