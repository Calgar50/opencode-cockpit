// Zoom 1 de la salle de contrôle 3D (spécification §5.8 l.993, §6 l.1065, P11, P12, JP-10 ; plan d'exécution it3, fiche L31a,
// D-3d-13, D-3d-14, D-3d-16) : placement des projets et plan 3D des territoires, plus la règle « qui travaille » recopiée du
// serveur.
// - placer : table des places, ordre alphabétique à l'ouverture de la vue, projets nouveaux en fin, jamais déplacés (D-3d-16).
// - hexAxial : spirale hexagonale en coordonnées axiales, anneau par anneau (D-3d-16).
// - planTerritoires : Plan3d du zoom 1. Territoires de taille égale ; enceinte séparée, à droite, pour la Salle OMO (JP-10) ;
//   stations « vous » en bas, « copilot » en haut, « controle » à gauche ; AUCUN faisceau (D-3d-13) ; aucune étiquette d'état en
//   Simple pour l'enceinte (D-3d-14) ; 60 étiquettes au plus (D-3d-19). Le décor ne porte aucun fait (P12), donc ni nœud, ni
//   marque, ni tuile : le zoom 1 ne dessine que des plaques, des stations et des étiquettes.
// - sessionsQuiTravaillent : règle de statusBusy d'app/server/assistants.ts (fonction non exportée : recopiée ici, assistants.ts
//   n'est pas modifié) — une session PRÉSENTE dans la réponse de GET /session/status avec une valeur autre que { type: "idle" }
//   travaille ; une session absente est au repos ; une réponse qui n'est pas un objet est illisible (null, jamais 0).
// Aucune chaîne affichable (D-3d-21) : codes seulement ; les noms de projet viennent de la réponse du serveur et les phrases de
// salle3d-texts.ts (T3d-b).
// Module pur (server/shared) : aucun module node, aucun accès à l'environnement, ni horloge ni aléa.
import type { NeonTheme } from "./neon-palette.ts";
import type { NeonMode } from "./neon-scene.ts";
import type { Plan3d, Plan3dLabel, Plan3dStation, Plan3dTerritoire, Point3, TerritoireView, TerritoiresResponse } from "./salle3d-types.ts";

// --- Bornes et mesures de la scène ----------------------------------------------------------------------------------------------

/** Étiquettes DOM superposées au plus (spéc. §5.8 l.996, D-3d-19). */
export const ETIQUETTES_MAX = 60;
/** Rayon d'une plaque hexagonale : le même pour tous les territoires (« de taille égale », D-3d-13). */
export const RAYON_TERRITOIRE = 1;
/** Pas de la spirale : rayon de la plaque plus l'espace entre deux plaques voisines. */
const PAS = 2.4;
/** Écart entre la dernière colonne des projets et la première colonne de l'enceinte de la salle (JP-10). */
const ECART_ENCEINTE = 3 * PAS;
/** Colonnes de l'enceinte : les territoires de la salle sont rangés en colonnes, à droite des projets. */
const ENCEINTE_COLONNES = 2;
/** Distance des stations au centre de la scène, en multiples du pas. */
const STATION_ECART = 3;
/** Caméra du zoom 1 (spéc. §5.8 l.995 : 35°, inclinée de 55°). */
export const CAMERA_ZOOM1 = Object.freeze({ inclinaisonDeg: 55, fovDeg: 35, distanceMin: 12, marge: 2.6 });

/** Priorités d'étiquette (plus petit = plus prioritaire) : stations, puis territoires où l'on travaille, puis attentes, puis le reste. */
const PRIORITE = Object.freeze({ station: 0, travaille: 1, attente: 2, autre: 3 });

/** Six directions du pavage hexagonal en coordonnées axiales, dans l'ordre du parcours d'un anneau. */
const DIRECTIONS: ReadonlyArray<readonly [number, number]> = Object.freeze([
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
] as const);

/** Coordonnées axiales d'une plaque hexagonale (q : colonne, r : rangée). */
export interface HexAxial {
  q: number;
  r: number;
}

// --- Places des projets (D-3d-16) -------------------------------------------------------------------------------------------------

/** Ordre alphabétique stable : comparaison française, puis par points de code (deux clés distinctes ne sont jamais à égalité). */
function comparerCles(a: string, b: string): number {
  const ordre = a.localeCompare(b, "fr");
  if (ordre !== 0) return ordre;
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * Nouvelle table des places (D-3d-16) : chaque projet déjà placé garde sa place, même s'il a disparu de la liste (il la retrouve
 * s'il revient tant que la vue reste ouverte) ; les projets nouveaux prennent les places suivantes, dans l'ordre alphabétique.
 * `places` n'est jamais modifiée. Les places illisibles (non entières, négatives) sont écartées. La chaîne vide est une clé
 * valable : c'est le chemin, relatif au workspace, du projet racine.
 */
export function placer(projets: readonly string[], places: ReadonlyMap<string, number>): Map<string, number> {
  const suivantes = new Map<string, number>();
  let libre = 0;
  for (const [cle, place] of places) {
    if (typeof cle !== "string" || !Number.isSafeInteger(place) || place < 0) continue;
    suivantes.set(cle, place);
    if (place >= libre) libre = place + 1;
  }
  const nouveaux = [...new Set(projets)].filter((cle) => typeof cle === "string" && !suivantes.has(cle)).sort(comparerCles);
  for (const cle of nouveaux) {
    suivantes.set(cle, libre);
    libre += 1;
  }
  return suivantes;
}

/**
 * Coordonnées axiales du rang `rang` de la spirale hexagonale (D-3d-16) : rang 0 au centre, puis anneau par anneau, chaque anneau
 * `k` parcouru dans le même sens à partir de la même direction (6 × k plaques). Rang illisible : erreur, jamais une position devinée.
 */
export function hexAxial(rang: number): HexAxial {
  // Message en code (D-3d-21 : aucune chaîne affichable dans ce module) ; la phrase montrée vient de salle3d-texts.ts.
  if (!Number.isSafeInteger(rang) || rang < 0) throw new RangeError("rang-territoire-invalide");
  if (rang === 0) return { q: 0, r: 0 };
  let anneau = 1;
  let debut = 1;
  while (debut + 6 * anneau <= rang) {
    debut += 6 * anneau;
    anneau += 1;
  }
  const dans = rang - debut;
  const cote = Math.floor(dans / anneau);
  const pas = dans % anneau;
  // Départ de l'anneau : `anneau` pas dans la direction 4 (un coin), puis les côtés entiers déjà parcourus, puis `pas` pas sur le
  // côté courant.
  const depart = DIRECTIONS[4] as readonly [number, number];
  let q = depart[0] * anneau;
  let r = depart[1] * anneau;
  for (let precedent = 0; precedent < cote; precedent++) {
    const direction = DIRECTIONS[precedent] as readonly [number, number];
    q += direction[0] * anneau;
    r += direction[1] * anneau;
  }
  const courante = DIRECTIONS[cote] as readonly [number, number];
  return { q: q + courante[0] * pas, r: r + courante[1] * pas };
}

/** Position au sol (y = 0) d'une plaque : pavage hexagonal à sommet plat, pas `PAS`, décalée de `decalageX`. */
function position(hex: HexAxial, decalageX: number): Point3 {
  return { x: decalageX + PAS * 1.5 * hex.q, y: 0, z: PAS * Math.sqrt(3) * (hex.r + hex.q / 2) };
}

// --- « Qui travaille ? » (D-3d-13, règle de statusBusy) -----------------------------------------------------------------------

const estObjet = (valeur: unknown): valeur is Record<string, unknown> => typeof valeur === "object" && valeur !== null && !Array.isArray(valeur);

/**
 * Sessions de `ids` qui travaillent selon une réponse de GET /session/status (D-3d-13). Règle recopiée de `statusBusy`
 * (app/server/assistants.ts : « Une session absente de la réponse est au repos ; toute autre forme que { type: "idle" } compte
 * comme occupée »), restreinte aux sessions de l'arbre. Réponse qui n'est pas un objet (tableau, texte, null) : null, l'état n'est
 * pas vérifiable — jamais 0.
 */
export function sessionsQuiTravaillent(reponse: unknown, ids: readonly string[]): number | null {
  if (!estObjet(reponse)) return null;
  let travaillent = 0;
  for (const id of new Set(ids)) {
    if (typeof id !== "string" || !Object.hasOwn(reponse, id)) continue;
    const statut = reponse[id];
    if (!estObjet(statut) || statut.type !== "idle") travaillent += 1;
  }
  return travaillent;
}

// --- Plan 3D du zoom 1 ----------------------------------------------------------------------------------------------------------

export interface PlanTerritoiresOptions {
  theme: NeonTheme;
  mode: NeonMode;
}

/** Territoire placé : sa vue, sa place et son appartenance à l'enceinte. */
interface Place {
  vue: TerritoireView;
  centre: Point3;
  enceinte: boolean;
}

/** État d'étiquette d'un territoire : on y travaille, on y attend un accord, ou rien de vérifié. */
function etatTerritoire(vue: TerritoireView): Plan3dLabel["etat"] {
  const { travaillent, attendent } = vue.compteurs;
  if (typeof travaillent === "number" && travaillent > 0) return "travaille";
  if (attendent > 0) return "attente-accord";
  return null;
}

function prioriteTerritoire(etat: Plan3dLabel["etat"]): number {
  if (etat === "travaille") return PRIORITE.travaille;
  if (etat === "attente-accord") return PRIORITE.attente;
  return PRIORITE.autre;
}

/** Identifiant d'un territoire : stable pour une même enceinte et un même chemin de projet. */
const idTerritoire = (enceinte: boolean, projet: string): string => `${enceinte ? "salle" : "projet"}:${projet}`;

/**
 * Plan 3D du zoom 1 (D-3d-13, D-3d-14, D-3d-16). `places` vient de `placer` : un projet absent de la table est placé après les
 * autres, dans l'ordre de la réponse, sans jamais prendre la place d'un autre. L'enceinte de la salle occupe ses propres colonnes,
 * à droite de tous les projets ; ses territoires ne portent aucune étiquette d'état en mode Simple (D-3d-14).
 */
export function planTerritoires(reponse: TerritoiresResponse, places: ReadonlyMap<string, number>, options: PlanTerritoiresOptions): Plan3d {
  const simple = options.mode === "simple";
  const projets = [...reponse.projets];
  const salle = reponse.salle ? [...reponse.salle.projets] : [];

  // Places des projets : celles de la table, puis les rangs libres suivants pour ceux qu'elle ne connaît pas encore.
  const connues = placer(
    projets.map((vue) => vue.projet),
    places,
  );
  const placees: Place[] = [];
  let maxX = 0;
  projets.forEach((vue, index) => {
    // `placer` place toute clé de la liste : le repli sur l'index ne sert qu'à un appelant qui passerait une table incohérente.
    const rang = connues.get(vue.projet) ?? index;
    const centre = position(hexAxial(rang), 0);
    if (centre.x > maxX) maxX = centre.x;
    placees.push({ vue, centre, enceinte: false });
  });
  // Enceinte : colonnes propres, à droite de la dernière plaque de projet (jamais mêlée aux projets, JP-10).
  const departEnceinte = maxX + ECART_ENCEINTE;
  salle.forEach((vue, index) => {
    const colonne = index % ENCEINTE_COLONNES;
    const ligne = Math.floor(index / ENCEINTE_COLONNES);
    placees.push({
      vue,
      centre: { x: departEnceinte + colonne * PAS * 1.5, y: 0, z: PAS * Math.sqrt(3) * (ligne + colonne / 2) },
      enceinte: true,
    });
  });

  const territoires: Plan3dTerritoire[] = placees.map(({ vue, centre, enceinte }) => ({
    id: idTerritoire(enceinte, vue.projet),
    projet: vue.projet,
    centre,
    rayon: RAYON_TERRITOIRE,
    enceinte,
    compteurs: vue.compteurs,
  }));

  // Stations fixes (spéc. §5.8 l.993) : « vous » en bas, « copilot » en haut, « controle » à gauche. Aucune station « carnet » au
  // zoom 1 : le carnet partagé appartient au zoom 2 de la salle.
  const etendueZ = territoires.reduce((max, t) => Math.max(max, Math.abs(t.centre.z)), 0);
  const etendueX = territoires.reduce((max, t) => Math.max(max, Math.abs(t.centre.x)), 0);
  const centreX = territoires.length > 0 ? (Math.min(...territoires.map((t) => t.centre.x)) + Math.max(...territoires.map((t) => t.centre.x))) / 2 : 0;
  const stations: Plan3dStation[] = [
    { id: "vous", position: { x: centreX, y: 0, z: etendueZ + STATION_ECART * PAS } },
    { id: "copilot", position: { x: centreX, y: 0, z: -(etendueZ + STATION_ECART * PAS) } },
    { id: "controle", position: { x: -(etendueX + STATION_ECART * PAS), y: 0, z: 0 } },
  ];

  // Étiquettes : les stations d'abord, puis les territoires par priorité, place stable ; 60 au plus (D-3d-19).
  const etiquettesStations: Plan3dLabel[] = stations.map((station) => ({
    id: `station:${station.id}`,
    cible: station.id,
    position: station.position,
    nom: null,
    etat: null,
    priorite: PRIORITE.station,
  }));
  const etiquettesTerritoires = placees.map(({ vue, centre, enceinte }, rang) => {
    const etat = etatTerritoire(vue);
    // D-3d-14 : en Simple, l'enceinte ne montre aucun état en direct.
    const montre = enceinte && simple ? null : etat;
    return {
      etiquette: {
        id: `territoire:${idTerritoire(enceinte, vue.projet)}`,
        cible: idTerritoire(enceinte, vue.projet),
        position: centre,
        nom: vue.nom,
        etat: montre,
        priorite: prioriteTerritoire(montre),
      } satisfies Plan3dLabel,
      rang,
    };
  });
  etiquettesTerritoires.sort((a, b) => a.etiquette.priorite - b.etiquette.priorite || a.rang - b.rang);
  const etiquettes = [...etiquettesStations, ...etiquettesTerritoires.map((e) => e.etiquette)].slice(0, ETIQUETTES_MAX);

  const rayonScene = Math.max(etendueX, etendueZ) + STATION_ECART * PAS;
  return {
    zoom: 1,
    theme: options.theme,
    mode: options.mode,
    rootId: null,
    focus: null,
    stations,
    territoires,
    noeuds: [],
    // D-3d-13 : aucun faisceau entre projets au zoom 1.
    faisceaux: [],
    // P12 : le décor ne porte aucun fait ; les marques et les tuiles appartiennent aux zooms 2 et 3.
    marques: [],
    tuiles: [],
    etiquettes,
    camera: {
      cible: { x: centreX, y: 0, z: 0 },
      distance: Math.max(CAMERA_ZOOM1.distanceMin, rayonScene * CAMERA_ZOOM1.marge),
      inclinaisonDeg: CAMERA_ZOOM1.inclinaisonDeg,
      fovDeg: CAMERA_ZOOM1.fovDeg,
    },
    // Aucun halo pulsé ni faisceau ouvert au zoom 1 : la boucle d'images reste au repos (D-3d-17).
    anime: false,
    enceinte: reponse.salle ? { projets: salle.map((vue) => vue.projet) } : null,
    carnetVide: true,
  };
}
