// Géométries de la salle de contrôle 3D (itération 3, L29b ; spécification §5.8 l.995 ; plan it3 D-3d-17, D-3d-05).
// Formes FIXES, toutes calculées : plaques hexagonales extrudées et leurs arêtes lumineuses, prismes des nœuds, socles des
// stations, plaques des marques, tuiles de fichiers, tubes des faisceaux. Aucune taille ne dépend d'une grandeur (coût, durée,
// nombre d'appels) : la spécification §5.7.1 l'interdit ; seules les tailles constantes de ce module et le rayon d'un territoire,
// donné par le plan, entrent ici.
// Chaque fonction RENVOIE une géométrie neuve : c'est le graphe qui décide de la partager (cache à compteur) et qui la libère
// (registre, M3D-5). Aucun texte affiché.
import { BoxGeometry, type BufferGeometry, CylinderGeometry, EdgesGeometry, PlaneGeometry, QuadraticBezierCurve3, TubeGeometry, Vector3 } from "three";
import type { Plan3dTileBatch, Point3 } from "../../../../server/shared/salle3d-types.ts";

/** Territoires, nœuds et stations : hexagones (§5.8 l.992). */
export const COTES_HEXAGONE = 6;
/** Angle (radians) au-delà duquel `EdgesGeometry` garde une arête : 1° retient toutes les arêtes d'un prisme. */
export const SEUIL_ARETES = Math.PI / 180;

/** Tailles constantes de la scène, en unités du monde. */
export const TAILLES = Object.freeze({
  /** Rayon et hauteur du prisme d'un nœud. */
  noeudRayon: 1.1,
  noeudHauteur: 1.7,
  /** Épaisseur d'une plaque de territoire, et de la plaque d'une enceinte. */
  territoireHauteur: 0.5,
  enceinteHauteur: 0.18,
  /** Écart du second anneau d'arêtes d'une enceinte (JP-10). */
  enceinteAnneau: 1.12,
  /** Socle d'une station. */
  stationRayon: 1.6,
  stationHauteur: 0.35,
  /** Côté de la plaque d'une marque. */
  marqueCote: 1.8,
  /** Côté d'une tuile de fichier. */
  tuileCote: 0.62,
  /** Rayon du tube d'un faisceau, et nombre de côtés de sa section. */
  faisceauRayon: 0.14,
  faisceauCotes: 6,
  /** Côté du sol quadrillé et pas de son quadrillage. */
  solCote: 260,
  solPas: 4,
});

/** Épaisseur d'une tuile par état : la forme distingue les états avant la couleur (§5.7.1). */
export const HAUTEURS_TUILE: Readonly<Record<Plan3dTileBatch["etat"], number>> = Object.freeze({
  lu: 0.1,
  modifie: 0.34,
  refuse: 0.2,
  "en-cours": 0.52,
});

/** Prisme hexagonal (plaque « extrudée » d'un territoire, corps d'un nœud, socle d'une station). */
export function geometriePrisme(rayon: number, hauteur: number): CylinderGeometry {
  return new CylinderGeometry(rayon, rayon, hauteur, COTES_HEXAGONE);
}

/**
 * Arêtes d'une géométrie, à dessiner en `LineSegments`. La géométrie rendue est INDÉPENDANTE de sa source : M3D-5 les compte
 * séparément et le graphe libère les deux.
 */
export function geometrieAretes(source: BufferGeometry): EdgesGeometry {
  return new EdgesGeometry(source, SEUIL_ARETES);
}

/** Plaque carrée posée à plat (dans le plan du sol), porteuse d'une texture de marque. */
export function geometriePlaque(cote: number): PlaneGeometry {
  const geometrie = new PlaneGeometry(cote, cote);
  geometrie.rotateX(-Math.PI / 2);
  return geometrie;
}

/** Tuile de fichier d'un lot (`InstancedMesh`) : son épaisseur dit son état. */
export function geometrieTuile(etat: Plan3dTileBatch["etat"]): BoxGeometry {
  return new BoxGeometry(TAILLES.tuileCote, HAUTEURS_TUILE[etat], TAILLES.tuileCote);
}

/** Vecteur d'un point du plan (le plan ne porte que des nombres). */
export const vecteur = (p: Point3): Vector3 => new Vector3(p.x, p.y, p.z);

/** Courbe de Bézier quadratique d'un faisceau : départ, point de contrôle, arrivée (§5.8 l.995). */
export function courbeFaisceau(de: Point3, controle: Point3, vers: Point3): QuadraticBezierCurve3 {
  return new QuadraticBezierCurve3(vecteur(de), vecteur(controle), vecteur(vers));
}

/** Longueur approchée d'une courbe de faisceau, par ses deux demi-cordes (aucune classe de three en plus). */
export function longueurApprochee(courbe: QuadraticBezierCurve3): number {
  const milieu = courbe.getPoint(0.5, new Vector3());
  return distance(courbe.v0, milieu) + distance(milieu, courbe.v2);
}

/** Nombre de segments d'un tube : proportionnel à la longueur approchée de la courbe, borné. */
export function segmentsTube(courbe: QuadraticBezierCurve3): number {
  return Math.max(12, Math.min(64, Math.round(longueurApprochee(courbe) * 3)));
}

/** Tube d'un faisceau le long de sa courbe (matériau additif à texture défilante, posé par le graphe). */
export function geometrieTube(courbe: QuadraticBezierCurve3): TubeGeometry {
  return new TubeGeometry(courbe, segmentsTube(courbe), TAILLES.faisceauRayon, TAILLES.faisceauCotes, false);
}

function distance(a: Vector3, b: Vector3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
