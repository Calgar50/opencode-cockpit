// Propriétaire : L29d.
// Étiquettes DOM de la salle de contrôle 3D (spécification §5.8 l.996 « étiquettes DOM superposées, focalisables, 60 au plus » et
// l.998 « un vrai bouton par nœud » ; §5.5 l.923-924 ; plan d'exécution it3, fiche L29d, D-3d-19) : module PUR, placé HORS de
// three/ et sans aucun import de three, pas même en `import type` (D-3d-05). Il décide de tout ce qui se teste sans navigateur ;
// Etiquettes3d.tsx ne fait que poser les <button> et recopier ces styles à chaque image rendue par le moteur.
// - **Ordre de tabulation** = priorité du plan (D-3d-19 : la conversation, puis « travaille », puis l'attente de votre accord,
//   puis les autres), et, à priorité égale, le rang donné par le plan. La tabulation suit donc ce que la scène montre
//   d'important, jamais la position à l'écran, qui bouge avec la caméra : le parcours clavier reste stable pendant que la vue
//   tourne.
// - **60 au plus** (PLAN3D.etiquettesMax, valeur unique du plan 3D) : au-delà, la liste de la page reste la vérité (P7, §5.8
//   l.998). La borne est reprise ici parce qu'un plan peut venir de plusieurs producteurs (neon-plan3d.ts, territoires.ts) et
//   que le nombre de boutons focalisables est une propriété de l'INTERFACE, pas du plan.
// - **Position écran → style** (left, top) : arrondie au pixel. Une étiquette hors champ (`visible` faux, coordonnée illisible)
//   est MASQUÉE par `visibility: hidden`, donc retirée du parcours clavier et de l'arbre d'accessibilité : un bouton qu'on ne
//   voit pas ne se focalise pas et ne s'annonce pas.
// Aucun texte écrit ici : les noms accessibles viennent de libelleBouton et libelleStation (neon-texts.ts) et de la station
// « Cockpit – contrôle » (salle3d-texts.ts). Aucun DOM, aucune horloge, aucun aléa : testable sous Node (etiquettes-3d.test.ts).
import { PLAN3D } from "../../../server/shared/neon-plan3d.ts";
import type { NeonStationId } from "../../../server/shared/neon-scene.ts";
import { libelleBouton, libelleStation } from "../../../server/shared/neon-texts.ts";
import { TEXTES as TEXTES_SALLE } from "../../../server/shared/salle3d-texts.ts";
import type { Plan3dLabel, Point3 } from "../../../server/shared/salle3d-types.ts";

/** Étiquettes focalisables au plus, en même temps (D-3d-19) : la borne du plan 3D, jamais un second nombre écrit. */
export const ETIQUETTES_MAX = PLAN3D.etiquettesMax;

/** Cible de la station « Cockpit – contrôle », propre au zoom 1 (Plan3dStationId). */
const CIBLE_CONTROLE = "controle";

/** Stations de la scène néon, dont les libellés vivent déjà dans neon-texts.ts. */
const STATIONS_NEON: readonly NeonStationId[] = ["vous", "copilot", "carnet"];

/** Position d'un point du plan à l'écran, en pixels CSS du canevas (Moteur.projeter, slots-3d.ts). */
export interface PositionEcran {
  x: number;
  y: number;
  visible: boolean;
}

/** Style d'une étiquette posée sur le canevas : recopié tel quel sur le bouton à chaque image. */
export interface StyleEtiquette {
  left: string;
  top: string;
  visibility: "visible" | "hidden";
}

/** Étiquette prête à poser : son bouton, son nom accessible et le point du plan à projeter. */
export interface EtiquetteAffichee {
  /** Clé de rendu (identifiant de l'étiquette dans le plan). */
  id: string;
  /** Élément choisi quand on active le bouton : un nœud, un territoire ou une station (Scene3dProps.onSelect). */
  cible: string;
  position: Point3;
  libelle: string;
}

/** Libellé d'une station du plan, ou null quand la cible n'en est pas une. */
function texteDeStation(cible: string): string | null {
  for (const station of STATIONS_NEON) if (station === cible) return libelleStation(station);
  return cible === CIBLE_CONTROLE ? TEXTES_SALLE.partout.stationControle : null;
}

/**
 * Nom accessible d'une étiquette : « {nom}, {état} » par libelleBouton dès qu'un état est montré (nœuds, territoires) ; le nom de
 * la station sinon ; à défaut le nom seul (territoire sans état montré, D-3d-14). null quand aucun nom n'est connu : un bouton
 * sans nom accessible ne se pose pas, la liste de la page reste la vérité.
 */
export function libelleEtiquette(etiquette: Plan3dLabel): string | null {
  if (etiquette.etat !== null) return libelleBouton(etiquette.nom, etiquette.etat);
  return texteDeStation(etiquette.cible) ?? etiquette.nom;
}

/**
 * Ordre de tabulation (D-3d-19) : priorité du plan croissante, puis rang donné par le plan ; 60 au plus. Le tri est explicite sur
 * le rang, sans dépendre de la stabilité de `sort`.
 */
export function ordonnerEtiquettes(etiquettes: readonly Plan3dLabel[]): Plan3dLabel[] {
  return etiquettes
    .map((etiquette, rang) => ({ etiquette, rang }))
    .sort((a, b) => a.etiquette.priorite - b.etiquette.priorite || a.rang - b.rang)
    .slice(0, ETIQUETTES_MAX)
    .map(({ etiquette }) => etiquette);
}

/** Étiquettes à poser, dans l'ordre de tabulation : ordonnées, bornées à 60, celles sans nom accessible retirées. */
export function etiquettesAffichees(etiquettes: readonly Plan3dLabel[]): EtiquetteAffichee[] {
  return ordonnerEtiquettes(etiquettes).flatMap((etiquette) => {
    const libelle = libelleEtiquette(etiquette);
    return libelle === null ? [] : [{ id: etiquette.id, cible: etiquette.cible, position: etiquette.position, libelle }];
  });
}

/**
 * Style d'une étiquette depuis sa position à l'écran : `left` et `top` arrondis au pixel. Hors champ (`visible` faux) ou
 * coordonnée illisible (NaN, ±Infinity : caméra dégénérée, canevas de taille nulle) → masquée, et posée en haut à gauche pour ne
 * jamais allonger la page.
 */
export function styleEtiquette(position: PositionEcran): StyleEtiquette {
  const lisible = position.visible && Number.isFinite(position.x) && Number.isFinite(position.y);
  return {
    left: `${lisible ? Math.round(position.x) : 0}px`,
    top: `${lisible ? Math.round(position.y) : 0}px`,
    visibility: lisible ? "visible" : "hidden",
  };
}
