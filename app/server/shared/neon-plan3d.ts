// Plan 3D d'une conversation (spécification §5.8 l.992-997, §5.7.1 l.934-945, §5.7.3 l.967-976, P12, JP-6, JP-8 ; plan d'exécution
// it3 §6 « L29a », §4.1.1, D-3d-07, D-3d-16, D-3d-19) : `planConversation(scene, {theme, mode})` traduit la scène néon (zoom 2 ou
// 3) en `Plan3d`, le modèle que le graphe three.js (L29b), le moteur (L29c) et la page (L29d, L31c) dessinent.
//
// Règles :
// - **Un seul modèle** (D-3d-07) : la scène est lue, jamais modifiée ni recalculée. Le direct et le différé passent par la même
//   `scene()`, donc par le même plan (« différé = direct », P12, JP-8).
// - **P12, honnêteté du dessin** : chaque nœud, faisceau, marque et lot de tuiles porte les `faits` de la scène, recopiés, jamais
//   inventés. Le décor (sol, stations, territoires) n'en porte pas. Une tuile sans état à montrer (ni lue, ni modifiée, ni refusée,
//   ni en cours : par exemple un outil qui a échoué sur ce fichier) n'entre dans aucun lot : la liste et le tableau restent la
//   vérité, et aucun état n'est supposé.
// - **Aucune grandeur** (§5.7.1 l.945) : toutes les distances, hauteurs et courbures sont des constantes (`PLAN3D`,
//   `PLAN3D_CAMERA`). Ni coût, ni durée, ni nombre d'appels n'est lu : le plan ne porte aucune heure.
// - **Positions stables** : les positions viennent de la scène, attribuées une fois dans l'ordre d'apparition des faits ; un fait
//   ajouté ne déplace donc aucun élément déjà placé.
// - **Formes et couleurs** : lues dans `NEON_GRAMMAIRE` (la forme d'abord) ; un faisceau figé garde sa forme et prend le trait
//   d'arrêt (gris).
// - **Étiquettes** (D-3d-19) : 60 au plus, dans l'ordre de priorité conversation, « travaille », attente de votre accord, puis rang
//   d'apparition ; leur texte est écrit par la page (`libelleBouton`), jamais ici.
// - **Salle OMO** (itération « 3s », L3s-a ; §5.7.3 l.973, §5.7.4 l.987, JP-6, JP-10), seulement si la scène les porte (L25b :
//   mode Avancé, conversation de la salle) :
//   - tuiles de la station « Carnet partagé et plan » (`carnet.tuiles` placées) en lots de tuiles au dossier `carnet`, un par
//     état (modifié l'emporte sur lu, comme la bande) ; une tuile au-delà de la rangée n'est pas dessinée (elle reste comptée par
//     la liste et le tableau) ;
//   - liens de la station vers les assistants dessinés qui ont touché le carnet (`carnet.liens`) : `liensCarnet`, trait fin ;
//   - actions de l'extension vues sans demande (`extensions`) : une marque d'anneau au trait orange de l'extension, par
//     assistant — la boucle « par l'extension », dont le nombre et « non contrôlé avant exécution » sont écrits par le tableau ;
//   chacun avec ses faits, recopiés de la scène.
// Module pur (server/shared) : aucun module node, aucun accès à l'environnement, ni horloge ni aléa.
import { NEON_GRAMMAIRE, NEON_SIGNE_FAISCEAU, type NeonTheme, type NeonToken } from "./neon-palette.ts";
import {
  NEON_CADRE,
  type NeonBeam,
  type NeonBeamKind,
  type NeonMarkedOrigin,
  type NeonMode,
  type NeonNode,
  type NeonPoint,
  type NeonScene,
  type NeonTile,
} from "./neon-scene.ts";
import type {
  Plan3d,
  Plan3dBeam,
  Plan3dCamera,
  Plan3dLabel,
  Plan3dLienCarnet,
  Plan3dMark,
  Plan3dNode,
  Plan3dStation,
  Plan3dTileBatch,
  Plan3dZoom,
  Point3,
} from "./salle3d-types.ts";

/**
 * Constantes de la mise en scène 3D : échelle du plan 2D vers le monde, hauteur de chaque genre d'élément, courbure d'un faisceau
 * (`arc`, plus `arcParAnneau` par anneau de délégation), nombre d'étiquettes DOM. Jamais liées à une grandeur mesurée (§5.7.1).
 */
export const PLAN3D = Object.freeze({
  echelle: 0.05,
  hauteurs: Object.freeze({ sol: 0, station: 0.4, noeud: 0.6, marque: 0.9, tuile: 0.1 }),
  arc: 1.2,
  arcParAnneau: 0.2,
  etiquettesMax: 60,
});

/**
 * Salle OMO (« 3s », L3s-a) : dossier des lots de tuiles du carnet partagé (un code, jamais une clé de fichier de 16 chiffres
 * hexadécimaux), et décalage de la boucle « par l'extension » par rapport à son assistant, dans le plan 2D : le même que la bande
 * (NeonBand.tsx, Extension), pour qu'elle ne recouvre pas la marque d'origine posée sur l'assistant.
 */
export const PLAN3D_SALLE = Object.freeze({
  dossierCarnet: "carnet",
  decalageExtension: Object.freeze({ x: -15, y: 13 }),
});

/** Caméra perspective (§5.8) : 35° d'ouverture, inclinée de 55°, distance fixe par zoom. Constantes elles aussi. */
export const PLAN3D_CAMERA = Object.freeze({
  inclinaisonDeg: 55,
  fovDeg: 35,
  distances: Object.freeze({ 1: 26, 2: 15, 3: 9 }) as Readonly<Record<Plan3dZoom, number>>,
});

export interface PlanConversationOptions {
  theme: NeonTheme;
  /** Mode d'affichage du plan : celui de l'utilisateur, ou « simple » pour une scène calculée en Avancé puis simplifiée (D-3d-20). */
  mode: NeonMode;
}

// --- Géométrie (constante) ----------------------------------------------------------------------------------------------------

/** Centre du cadre 2D (280, 110) : origine du monde 3D. */
const CENTRE_2D: NeonPoint = Object.freeze({ x: NEON_CADRE.largeur / 2, y: NEON_CADRE.hauteur / 2 });
const H = PLAN3D.hauteurs;

/** Six décimales : deux plans calculés des mêmes faits sont égaux au bit près (comparaison profonde des tests). */
const arrondi = (v: number) => Math.round(v * 1e6) / 1e6;

/** Point du plan 2D à la hauteur d'un genre : ((x − 280) × échelle, hauteur, (y − 110) × échelle). */
function position3(p: NeonPoint, hauteur: number): Point3 {
  return { x: arrondi((p.x - CENTRE_2D.x) * PLAN3D.echelle), y: hauteur, z: arrondi((p.y - CENTRE_2D.y) * PLAN3D.echelle) };
}

/** Milieu de deux points, élevé de `arc + arcParAnneau × anneau` : point de contrôle d'une courbe de Bézier du second degré. */
function controle(de: Point3, vers: Point3, anneau: number): Point3 {
  return { x: arrondi((de.x + vers.x) / 2), y: arrondi(H.noeud + PLAN3D.arc + PLAN3D.arcParAnneau * anneau), z: arrondi((de.z + vers.z) / 2) };
}

// --- Grammaire ----------------------------------------------------------------------------------------------------------------

/** Formes de `NEON_GRAMMAIRE` portées par une texture défilante (L29b) : demande, préparation, consigne, résultat. */
const FORMES_3D: Readonly<Record<string, Plan3dBeam["forme"]>> = Object.freeze({
  "trait-plein-fleche": "fleche",
  "pointille-fixe": "pointille",
  "trait-plein-chevrons": "chevrons",
  "pointille-losanges": "losanges",
});

/** Forme d'un faisceau, lue dans la grammaire (la forme d'abord, §5.7.1). */
function formeFaisceau(kind: NeonBeamKind): Plan3dBeam["forme"] {
  const forme = FORMES_3D[NEON_GRAMMAIRE[NEON_SIGNE_FAISCEAU[kind]].forme];
  if (forme === undefined) throw new RangeError("forme de faisceau inconnue dans NEON_GRAMMAIRE");
  return forme;
}

/**
 * Trait d'une marque d'origine : orange de l'extension pour ce que l'extension a fait sans demande (§5.7.1) ; discret pour les
 * autres cas (§5.7.2, cas 2, 4, 6 et 7), dont la phrase — « origine non identifiée » comprise — est écrite par la page.
 */
const JETON_ORIGINE: Readonly<Record<NeonMarkedOrigin, NeonToken>> = Object.freeze({
  cockpit: "texteDiscret",
  "reveil-sans-reponse": "texteDiscret",
  "relance-extension": NEON_GRAMMAIRE.extension.trait,
  "interne-extension": NEON_GRAMMAIRE.extension.trait,
  "interne-opencode": "texteDiscret",
  "origine-inconnue": "texteDiscret",
});

/** États d'une tuile, du plus fort au plus faible : une tuile n'entre que dans un lot. */
const ETATS_TUILE: readonly Plan3dTileBatch["etat"][] = Object.freeze(["refuse", "en-cours", "modifie", "lu"]);

/** État à montrer d'une tuile ; null quand la tuile n'en porte aucun (rien n'est supposé, P12). */
function etatTuile(tuile: NeonTile): Plan3dTileBatch["etat"] | null {
  if (tuile.refuse) return "refuse";
  if (tuile.enCours) return "en-cours";
  if (tuile.modifie) return "modifie";
  if (tuile.lu) return "lu";
  return null;
}

/** Halo d'un nœud : pulsé quand il travaille, statique en attente de votre accord, aucun sinon (JP-13, D-3d-17). */
function haloDuNoeud(noeud: NeonNode): Plan3dNode["halo"] {
  if (noeud.etat === "travaille") return "travaille";
  if (noeud.etat === "attente-accord") return "statique";
  return "aucun";
}

/** Priorité d'étiquette (D-3d-19) : conversation, puis « travaille », puis attente de votre accord, puis les autres. */
function prioriteEtiquette(noeud: NeonNode): number {
  if (noeud.role === "conversation") return 0;
  if (noeud.etat === "travaille") return 1;
  if (noeud.etat === "attente-accord") return 2;
  return 3;
}

// --- Plan ---------------------------------------------------------------------------------------------------------------------

const refs = (faits: readonly number[]): number[] => [...faits];

function planNoeuds(vue: NeonScene): Plan3dNode[] {
  return vue.noeuds.map((noeud) => ({
    id: noeud.sessionId,
    parentId: noeud.parentId,
    role: noeud.role,
    secteur: noeud.secteur,
    position: position3(noeud.position, H.noeud),
    etat: noeud.etat,
    halo: haloDuNoeud(noeud),
    nom: noeud.agent,
    faits: refs(noeud.faits),
  }));
}

function planFaisceaux(vue: NeonScene, anneaux: ReadonlyMap<string, number>): Plan3dBeam[] {
  const anneauDe = (id: string | null): number => (id === null ? 0 : (anneaux.get(id) ?? 0));
  return vue.faisceaux.map((faisceau: NeonBeam): Plan3dBeam => {
    const de = position3(faisceau.depart, H.noeud);
    // Cible encore inconnue (délégation en préparation) : le faisceau part et revient au même point, bombé de la même façon.
    const vers = faisceau.arrivee === null ? null : position3(faisceau.arrivee, H.noeud);
    const signe = NEON_SIGNE_FAISCEAU[faisceau.kind];
    return {
      id: faisceau.id,
      kind: faisceau.kind,
      de,
      controle: controle(de, vers ?? de, Math.max(anneauDe(faisceau.de), anneauDe(faisceau.vers))),
      vers,
      forme: formeFaisceau(faisceau.kind),
      jeton: faisceau.fige ? NEON_GRAMMAIRE.arret.trait : NEON_GRAMMAIRE[signe].trait,
      fige: faisceau.fige,
      ouvert: faisceau.fin === null && !faisceau.fige,
      faits: refs(faisceau.faits),
    };
  });
}

function planMarques(vue: NeonScene, positionDuNoeud: (id: string) => Point3): Plan3dMark[] {
  const marques: Plan3dMark[] = [];
  for (const attente of vue.attentes) {
    marques.push({ id: `attente:${attente.permissionId}`, kind: "attente", position: position3(attente.position, H.marque), jeton: NEON_GRAMMAIRE.attente.trait, faits: refs(attente.faits) });
  }
  for (const decision of vue.decisions) {
    marques.push({
      id: `decision:${decision.sessionId}:${decision.permissionId ?? ""}`,
      kind: decision.signe,
      position: position3(decision.position, H.marque),
      jeton: NEON_GRAMMAIRE[decision.signe].trait,
      faits: refs(decision.faits),
    });
  }
  for (const impulsion of vue.impulsions) {
    // Appel d'IA en vol : au milieu du trajet vers la station « GitHub Copilot » (§5.7.3).
    const depart = position3(impulsion.depart, H.marque);
    const arrivee = position3(impulsion.arrivee, H.marque);
    marques.push({
      id: `impulsion:${impulsion.sessionId}:${impulsion.messageId}`,
      kind: "impulsion",
      position: { x: arrondi((depart.x + arrivee.x) / 2), y: H.marque, z: arrondi((depart.z + arrivee.z) / 2) },
      jeton: NEON_GRAMMAIRE.appel.trait,
      faits: refs(impulsion.faits),
    });
  }
  for (const origine of vue.origines) {
    marques.push({
      id: `origine:${origine.sessionId}:${origine.messageId}`,
      kind: "origine",
      position: position3(origine.position, H.marque),
      jeton: JETON_ORIGINE[origine.origine] ?? "texteDiscret",
      faits: refs(origine.faits),
    });
  }
  if (vue.arret !== null && vue.rootId !== null) {
    marques.push({ id: "arret", kind: "arret", position: { ...positionDuNoeud(vue.rootId), y: H.marque }, jeton: NEON_GRAMMAIRE.arret.trait, faits: refs(vue.arret.faits) });
  }
  // Salle OMO (L3s-a) : boucle orange « par l'extension », une par assistant dessiné ; jamais un bouclier ni une croix du cockpit.
  const { x: dx, y: dy } = PLAN3D_SALLE.decalageExtension;
  for (const extension of vue.extensions) {
    marques.push({
      id: `extension:${extension.sessionId}`,
      kind: "origine",
      position: position3({ x: extension.position.x + dx, y: extension.position.y + dy }, H.marque),
      jeton: NEON_GRAMMAIRE.extension.trait,
      faits: refs(extension.faits),
    });
  }
  return marques;
}

/**
 * Tuiles de la station « Carnet partagé et plan » (salle, L3s-a) : lots au dossier `carnet`, modifiées puis lues ; seules les
 * tuiles placées par la scène sont dessinées (au-delà de la rangée, la liste et le tableau les comptent).
 */
function planTuilesCarnet(vue: NeonScene): Plan3dTileBatch[] {
  const placees = vue.carnet.tuiles.filter((tuile) => tuile.position !== null);
  const lots: Plan3dTileBatch[] = [];
  for (const etat of ["modifie", "lu"] as const) {
    const tuiles = placees.filter((tuile) => (tuile.modifie ? "modifie" : "lu") === etat);
    if (tuiles.length === 0) continue;
    lots.push({
      dossier: PLAN3D_SALLE.dossierCarnet,
      etat,
      positions: tuiles.map((tuile) => position3(tuile.position as NeonPoint, H.tuile)),
      faits: [...new Set(tuiles.flatMap((tuile) => tuile.faits))].sort((a, b) => a - b),
    });
  }
  return lots;
}

/** Liens de la station « Carnet partagé et plan » vers les assistants dessinés qui l'ont touché (salle, L3s-a). */
function planLiensCarnet(vue: NeonScene): Plan3dLienCarnet[] {
  return vue.carnet.liens.map((lien) => ({ id: lien.sessionId, de: position3(lien.depart, H.station), vers: position3(lien.arrivee, H.noeud), faits: refs(lien.faits) }));
}

/** Tuiles du zoom 3, par dossier puis par état : un lot par couple dessiné, dans l'ordre des colonnes et des états. */
function planTuiles(vue: NeonScene): Plan3dTileBatch[] {
  const lots: Plan3dTileBatch[] = [];
  for (const dossier of vue.detail?.dossiers ?? []) {
    for (const etat of ETATS_TUILE) {
      const tuiles = dossier.tuiles.filter((tuile) => etatTuile(tuile) === etat);
      if (tuiles.length === 0) continue;
      lots.push({
        dossier: dossier.dossier,
        etat,
        positions: tuiles.map((tuile) => position3(tuile.position, H.tuile)),
        faits: [...new Set(tuiles.flatMap((tuile) => tuile.faits))].sort((a, b) => a - b),
      });
    }
  }
  return lots;
}

/** Étiquettes DOM : une par nœud, triées par priorité puis par rang d'apparition, 60 au plus (D-3d-19). */
function planEtiquettes(noeuds: readonly Plan3dNode[], vue: NeonScene): Plan3dLabel[] {
  return vue.noeuds
    .map((noeud, rang) => ({ rang, priorite: prioriteEtiquette(noeud) }))
    .sort((a, b) => a.priorite - b.priorite || a.rang - b.rang)
    .slice(0, PLAN3D.etiquettesMax)
    .flatMap(({ rang, priorite }) => {
      const noeud = noeuds[rang];
      return noeud === undefined ? [] : [{ id: `etiquette:${noeud.id}`, cible: noeud.id, position: { ...noeud.position, y: H.marque }, nom: noeud.nom, etat: noeud.etat, priorite }];
    });
}

function planCamera(zoom: Plan3dZoom): Plan3dCamera {
  return {
    cible: { x: 0, y: H.sol, z: 0 },
    distance: PLAN3D_CAMERA.distances[zoom],
    inclinaisonDeg: PLAN3D_CAMERA.inclinaisonDeg,
    fovDeg: PLAN3D_CAMERA.fovDeg,
  };
}

/**
 * Plan 3D d'une conversation (zoom 2 ou 3, selon `vue.zoom`). Fonction pure : mêmes faits, même plan, en direct comme en différé.
 * Aucun texte de message, aucune heure, aucun coût : seulement des identifiants, des états, des noms d'assistant et des positions.
 */
export function planConversation(vue: NeonScene, options: PlanConversationOptions): Plan3d {
  const zoom: Plan3dZoom = vue.zoom === 3 ? 3 : 2;
  const anneaux = new Map(vue.noeuds.map((noeud) => [noeud.sessionId, noeud.anneau]));
  const positions = new Map(vue.noeuds.map((noeud) => [noeud.sessionId, position3(noeud.position, H.noeud)]));
  const positionDuNoeud = (id: string): Point3 => positions.get(id) ?? position3(CENTRE_2D, H.noeud);
  const stations: Plan3dStation[] = vue.stations.map((station) => ({ id: station.id, position: position3(station.position, H.station) }));
  const noeuds = planNoeuds(vue);
  const faisceaux = planFaisceaux(vue, anneaux);
  const marques = planMarques(vue, positionDuNoeud);
  const liensCarnet = planLiensCarnet(vue);
  return {
    zoom,
    theme: options.theme,
    mode: options.mode,
    rootId: vue.rootId,
    // Détail d'un assistant : le zoom 3 seul en porte un (neon-scene.ts), donc ni focus ni tuiles aux autres zooms.
    focus: vue.detail?.sessionId ?? null,
    stations,
    territoires: [],
    noeuds,
    faisceaux,
    marques,
    tuiles: [...planTuiles(vue), ...planTuilesCarnet(vue)],
    etiquettes: planEtiquettes(noeuds, vue),
    camera: planCamera(zoom),
    anime: faisceaux.some((faisceau) => faisceau.ouvert) || noeuds.some((noeud) => noeud.halo === "travaille") || marques.some((marque) => marque.kind === "impulsion"),
    enceinte: null,
    carnetVide: vue.carnet.vide,
    // Champ facultatif du contrat (L3s-a) : posé seulement quand la scène porte des liens du carnet.
    ...(liensCarnet.length > 0 ? { liensCarnet } : {}),
  };
}
