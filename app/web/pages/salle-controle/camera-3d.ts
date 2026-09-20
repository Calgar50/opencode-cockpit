// Caméra de la salle de contrôle 3D (itération 3, L29c ; spécification §5.8 l.996 « caméra perspective de 35°, inclinée de 55° »
// et l.998 « Suivre l'action (translation de caméra en 1 s au plus) » ; plan it3 §6 « L29c », §4.1.3, D-3d-17).
// Module PUR, placé HORS de three/ : il n'importe pas three (three/moteur.ts l'importe, et les tests aussi ; dans three/, il
// serait interdit à tout fichier hors de ce dossier de le lire, three-import.test.ts). Aucune horloge, aucun aléa, aucun texte :
// l'instant est toujours donné en paramètre.
//
// Repère : le plan pose le sol en (x, z) et la hauteur en y (neon-plan3d.ts). L'œil est placé au-dessus et EN AVANT de la cible,
// du côté de la station « Vous » (z croissant), à `distance` de la cible ; `inclinaisonDeg` est l'angle entre le sol et la ligne
// de visée (55° : vue plongeante, jamais à la verticale). Toutes les valeurs viennent du plan (`Plan3dCamera`), qui les tient de
// constantes (`PLAN3D_CAMERA`) : aucune grandeur mesurée n'entre ici (§5.7.1 l.945).
import { PLAN3D_CAMERA } from "../../../server/shared/neon-plan3d.ts";
import type { Plan3dCamera, Point3 } from "../../../server/shared/salle3d-types.ts";

/** Ouverture verticale et inclinaison de la spécification, relues du plan (L29a) : 35° et 55°. */
export const CHAMP_DEG = PLAN3D_CAMERA.fovDeg;
export const INCLINAISON_DEG = PLAN3D_CAMERA.inclinaisonDeg;

/** Bornes de sûreté : une inclinaison de 0° ou de 90° rendrait la visée dégénérée (l'axe vertical est le haut de l'image). */
export const INCLINAISON_MIN_DEG = 5;
export const INCLINAISON_MAX_DEG = 85;
/** Bornes d'un champ utilisable ; la valeur du plan (35°) est loin des deux. */
export const CHAMP_MIN_DEG = 10;
export const CHAMP_MAX_DEG = 100;
/** Distance minimale entre l'œil et la cible. */
export const DISTANCE_MIN = 1;

/** Plans de coupe du tronc de vue : le sol fait 260 unités de côté (TAILLES.solCote), le lointain le contient largement. */
export const PRES = 0.1;
export const LOIN = 800;

/**
 * Cadrage : le plan règle ses distances pour un cadre plus large que haut. Sur un cadre plus étroit, la largeur visible se réduit
 * (elle vaut `distance × tan(champ / 2) × largeur / hauteur`) : la caméra recule d'autant, sans jamais dépasser `FACTEUR_MAX`,
 * pour que la scène reste entière. Sur un cadre plus large, rien ne change : la hauteur visible suffit déjà.
 */
export const ASPECT_REFERENCE = 16 / 9;
export const FACTEUR_CADRAGE_MAX = 3;

/** « Suivre l'action » : translation de caméra en 1 s AU PLUS (spéc. l.998) ; une durée plus longue est ramenée à cette borne. */
export const SUIVI_MS_MAX = 1000;

/** Réglage d'avant le premier plan : celui du zoom 1 (L29a), pour que la caméra soit déjà juste à la première image. */
export const REGLAGE_DEFAUT: Plan3dCamera = Object.freeze({
  cible: Object.freeze({ x: 0, y: 0, z: 0 }),
  distance: PLAN3D_CAMERA.distances[1],
  inclinaisonDeg: INCLINAISON_DEG,
  fovDeg: CHAMP_DEG,
});

const RAD = Math.PI / 180;

const borner = (valeur: number, min: number, max: number) => (Number.isFinite(valeur) ? Math.min(max, Math.max(min, valeur)) : min);

/** Réglage de caméra ramené dans ses bornes : mêmes champs que `Plan3dCamera`. */
export function reglageBorne(reglage: Plan3dCamera): Plan3dCamera {
  return {
    cible: reglage.cible,
    distance: Math.max(DISTANCE_MIN, Number.isFinite(reglage.distance) ? reglage.distance : DISTANCE_MIN),
    inclinaisonDeg: borner(reglage.inclinaisonDeg, INCLINAISON_MIN_DEG, INCLINAISON_MAX_DEG),
    fovDeg: borner(reglage.fovDeg, CHAMP_MIN_DEG, CHAMP_MAX_DEG),
  };
}

/** Facteur de recul pour un cadre de rapport `aspect` (largeur / hauteur) ; 1 sur un cadre au moins aussi large que la référence. */
export function facteurCadrage(aspect: number): number {
  if (!Number.isFinite(aspect) || aspect <= 0) return 1;
  return Math.min(FACTEUR_CADRAGE_MAX, Math.max(1, ASPECT_REFERENCE / aspect));
}

/** Réglage borné, reculé pour tenir dans un cadre de rapport `aspect` (la cible, l'inclinaison et le champ ne changent pas). */
export function cadrer(reglage: Plan3dCamera, aspect: number): Plan3dCamera {
  const borne = reglageBorne(reglage);
  return { ...borne, distance: borne.distance * facteurCadrage(aspect) };
}

/**
 * Position de l'œil pour un réglage : à `distance` de la cible, élevé de l'inclinaison, du côté de la station « Vous » (z > 0).
 * `atan2(y − cible.y, z − cible.z)` redonne donc exactement l'inclinaison, et la distance à la cible vaut `distance`.
 */
export function positionCamera(reglage: Plan3dCamera): Point3 {
  const { cible, distance, inclinaisonDeg } = reglageBorne(reglage);
  const angle = inclinaisonDeg * RAD;
  return { x: cible.x, y: cible.y + distance * Math.sin(angle), z: cible.z + distance * Math.cos(angle) };
}

// --- « Suivre l'action » (spéc. l.998, différé seulement) -------------------------------------------------------------------------

/** Durée retenue pour une translation : bornée à 1 s ; une durée absente, négative ou non finie vaut 0 (déplacement immédiat). */
export function dureeSuivi(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(SUIVI_MS_MAX, ms);
}

/**
 * Avancement d'une translation : 0 au départ, 1 à l'arrivée, lissé aux deux bouts (`t² (3 − 2t)`, sans à-coup). Toujours 1 au
 * bout d'une seconde, même si une durée plus longue a été demandée (borne de `dureeSuivi`).
 */
export function avancementSuivi(ecouleMs: number, ms: number): number {
  const duree = dureeSuivi(ms);
  if (duree <= 0) return 1;
  const t = Math.min(1, Math.max(0, Number.isFinite(ecouleMs) ? ecouleMs / duree : 1));
  return t * t * (3 - 2 * t);
}

/** Point entre `depart` et `arrivee` à l'avancement donné (0 → départ, 1 → arrivée). */
export function interpolerPoint(depart: Point3, arrivee: Point3, avancement: number): Point3 {
  const t = Math.min(1, Math.max(0, Number.isFinite(avancement) ? avancement : 1));
  return {
    x: depart.x + (arrivee.x - depart.x) * t,
    y: depart.y + (arrivee.y - depart.y) * t,
    z: depart.z + (arrivee.z - depart.z) * t,
  };
}

/** Translation de caméra en cours : le moteur la fait avancer à chaque image, sans horloge propre. */
export interface Suivi {
  depart: Point3;
  arrivee: Point3;
  /** Instant de départ, dans l'horloge du moteur (ms). */
  debut: number;
  /** Durée retenue (ms), déjà bornée. */
  ms: number;
}

/**
 * Translation à lancer, ou `null` quand elle est immédiate (durée nulle, mouvement réduit, cible déjà atteinte) : l'appelant pose
 * alors la cible d'un coup.
 */
export function creerSuivi(depart: Point3, arrivee: Point3, debut: number, ms: number): Suivi | null {
  const duree = dureeSuivi(ms);
  if (duree <= 0) return null;
  if (depart.x === arrivee.x && depart.y === arrivee.y && depart.z === arrivee.z) return null;
  return { depart, arrivee, debut, ms: duree };
}

/** Cible à l'instant donné, et fin de la translation (atteinte au plus tard une seconde après son départ). */
export function avancerSuivi(suivi: Suivi, maintenant: number): { cible: Point3; fini: boolean } {
  const avancement = avancementSuivi(maintenant - suivi.debut, suivi.ms);
  return { cible: interpolerPoint(suivi.depart, suivi.arrivee, avancement), fini: avancement >= 1 };
}
