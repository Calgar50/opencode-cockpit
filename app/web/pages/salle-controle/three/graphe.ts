// Graphe three.js de la salle de contrôle 3D (itération 3, L29b ; spécification §5.8 l.995-997, §7.7 l.1170, JP-6, JP-11, M25
// l.1293 ; plan it3 §4.1.1, §6 « L29b », D-3d-04, D-3d-05, D-3d-17, D-3d-28 ; mesure MX-3D, M3D-2, M3D-5 et M3D-7).
// `creerGraphe(plan, palette)` construit la scène d'un `Plan3d` et rend un `Graphe` : une racine à poser dans la scène du moteur
// (L29c), une mise à jour par différence, une animation bornée et une libération complète.
//
// Ce que le graphe dessine, et ce que cela coûte en objets 3D (`nombreObjets()` les compte, racine exclue) :
// | élément                | objets | composition                                                                              |
// | sol                    |   1    | `Mesh` (`PlaneGeometry` + `ShaderMaterial`, sol.ts)                                      |
// | station                |   3    | `Group` + socle `Mesh` + arêtes `LineSegments`                                           |
// | territoire             |   3    | `Group` + plaque hexagonale `Mesh` + arêtes `LineSegments` au jeton `territoire`         |
// | territoire d'enceinte  |   5    | les 3 ci-dessus + plaque et second anneau d'arêtes à la teinte `extension` (JP-10)       |
// | nœud sans halo         |   2    | `Group` + prisme `Mesh` (`CylinderGeometry` à 6 côtés, jeton `acteur`)                   |
// | nœud avec halo         |   3    | les 2 ci-dessus + `Sprite` additif à texture radiale                                     |
// | faisceau               |   1    | `Mesh` (`TubeGeometry` le long d'une `QuadraticBezierCurve3`, matériau additif)          |
// | marque                 |   1    | `Mesh` (plaque couchée + texture de la forme)                                            |
// | lot de tuiles non vide |   1    | `InstancedMesh` (un par dossier ET par état : au plus 4 par dossier)                     |
// | lien du carnet         |   1    | `Mesh` (`TubeGeometry` FIN et droit, jeton `territoire`, sans texture : jamais un faisceau) |
// Un lot de tuiles vide ne crée aucun objet. Les étiquettes du plan ne sont pas dessinées ici : elles sont posées en DOM (L29d).
// Salle OMO (« 3s », L3s-a) : les tuiles de la station « Carnet partagé et plan » arrivent en lots de tuiles ordinaires (dossier
// `carnet`), la boucle « par l'extension » en marque d'anneau au jeton `extension` ; seuls les liens du carnet ont leur forme,
// un trait fin (comme le pointillé fin de la bande), plus mince que le plus mince des faisceaux.
//
// Règles tenues ici :
// - **P12** : chaque objet hors décor porte `userData.faits`, RECOPIÉ du plan ; le décor (sol, stations, territoires) porte
//   `userData.decor = true` et aucun fait. Chaque objet porte aussi `userData.id`, l'identifiant de son élément, et `famille`
//   (ce que L29d lit pour l'étiqueter et pour répondre à un clic).
// - **D-3d-17** : aucune image n'est demandée ici (aucune `requestAnimationFrame` : elle n'est permise que dans `three/moteur.ts`
//   et `fluidite.ts`, contrôle `salle3d-animations.test.ts`). `animer()` ne fait que poser les valeurs d'une image et dit s'il
//   reste quelque chose à animer : un halo « travaille » ou un faisceau ouvert non figé. Il ne bouge RIEN sous mouvement réduit.
// - **§5.7.1, la forme d'abord** : la forme distingue chaque signe (prisme, plaque hexagonale, chevrons, losanges, pointillé,
//   flèche, hexagone hachuré, bouclier, croix, carré d'arrêt, épaisseur des tuiles) ; la couleur du jeton ne fait que la doubler.
//   Un faisceau figé garde la forme de son faisceau et prend le jeton `arret`, sans défiler.
// - **M3D-5, libération** : un registre interne retient CHAQUE géométrie (l'`EdgesGeometry` à part de sa source, et la géométrie
//   partagée des `Sprite` une seule fois), CHAQUE matériau, CHAQUE texture et CHAQUE `InstancedMesh`. `liberer()` appelle
//   `dispose()` exactement une fois sur chacun, dans cet ordre (géométries, matériaux, textures, puis `InstancedMesh`), puis vide
//   la racine. Sans `InstancedMesh.dispose()`, 5 tampons WebGL restent vivants alors que `renderer.info.memory` affiche 0/0.
//   `renderer.dispose()` et `forceContextLoss()` restent au moteur (L29c, D-3d-28).
// - **cache interne** : les géométries et les matériaux partagés sont comptés par référence ; le dernier élément qui les lâche
//   les libère (et les retire du registre, qui ne les libérera donc pas deux fois). Les textures générées, au plus une par forme,
//   vivent le temps du graphe.
// - **D-3d-05** : three s'importe par imports NOMMÉS statiques, seulement depuis ce dossier (M3D-3 : `import("three")` n'est pas
//   élagué, +30,8 % en gzip).
// Le thème est FIGÉ à la création : la palette ne change pas en cours de route ; un changement de thème demande un nouveau graphe
// (L29c). Aucun texte affiché.
import {
  AdditiveBlending,
  type BufferGeometry,
  Color,
  DoubleSide,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  Sprite,
  SpriteMaterial,
  type Texture,
  TubeGeometry,
} from "three";
import type { NeonPalette, NeonToken } from "../../../../server/shared/neon-palette.ts";
import type {
  Plan3d,
  Plan3dBeam,
  Plan3dLienCarnet,
  Plan3dMark,
  Plan3dNode,
  Plan3dStation,
  Plan3dTerritoire,
  Plan3dTileBatch,
  Point3,
} from "../../../../server/shared/salle3d-types.ts";
import { courbeFaisceau, geometrieAretes, geometriePlaque, geometriePrisme, geometrieTube, geometrieTuile, TAILLES } from "./formes.ts";
import { creerSol } from "./sol.ts";
import { textureFaisceau, textureHalo, textureMarque } from "./textures.ts";

// --- Constantes de l'animation et des couleurs -----------------------------------------------------------------------------------

/** Halo « travaille » : un cycle par 2 s (§5.8 l.995, D-3d-17). */
export const PERIODE_HALO_S = 2;
export const HALO_OPACITE_MIN = 0.2;
export const HALO_OPACITE_MAX = 0.7;
/** Halo « statique » : jamais pulsé, même en 3D (JP-13). */
export const HALO_OPACITE_STATIQUE = 0.32;
/** Côté du sprite du halo, en unités du monde. */
export const HALO_ECHELLE = 4.2;
/** Défilement d'un faisceau ouvert : motifs par seconde. */
export const VITESSE_DEFILEMENT = 0.45;
/** Motifs répétés sur la longueur d'un faisceau : constante, jamais liée à une grandeur (§5.7.1). */
export const REPETITIONS_FAISCEAU = 6;

/** Couleur des nœuds : assistants et appels d'IA prennent le jeton `acteur` (§5.7.1). */
export const JETON_NOEUD: NeonToken = "acteur";
/** Socle et arêtes d'une station (décor), comme la bande 2D (`neon.css`). */
export const JETON_STATION: NeonToken = "territoire";
/** Faisceau figé par un arrêt : jeton `arret`, forme inchangée (NEON_GRAMMAIRE). */
export const JETON_FIGE: NeonToken = "arret";
/** Teinte de l'enceinte de la Salle OMO (JP-10). */
export const JETON_ENCEINTE: NeonToken = "extension";
/** Lien de la station « Carnet partagé et plan » vers un assistant (L3s-a) : trait du territoire, comme la bande (`neon.css`). */
export const JETON_LIEN_CARNET: NeonToken = "territoire";
/** Rayon du tube d'un lien du carnet : trait fin, trois fois plus mince au moins que celui d'un faisceau (formes.ts). */
export const RAYON_LIEN_CARNET = 0.04;
/** Segments et côtés du tube d'un lien du carnet (droit : peu de segments suffisent). */
export const SEGMENTS_LIEN_CARNET = 8;
export const COTES_LIEN_CARNET = 4;
/** Couleur d'une tuile selon son état, comme la bande 2D ; son épaisseur la double (HAUTEURS_TUILE). */
export const JETONS_TUILE: Readonly<Record<Plan3dTileBatch["etat"], NeonToken>> = Object.freeze({
  lu: "resultat",
  modifie: "consigne",
  refuse: "refus",
  "en-cours": "attente",
});

// --- Interface ---------------------------------------------------------------------------------------------------------------------

export interface Graphe {
  /** Objet à poser dans la scène du moteur (L29c) ; ses enfants sont les éléments du plan. */
  readonly racine: Group;
  /** Différence par identifiant : ajoute, met à jour, retire et libère ce qui disparaît. */
  maj(plan: Plan3d): void;
  /**
   * Pose les valeurs d'une image à l'instant `tSec` (secondes) et dit s'il reste quelque chose à animer. Sous mouvement réduit :
   * rend `false` et ne bouge rien (aucune pulsation, aucun défilement).
   */
  animer(tSec: number, mouvementReduit: boolean): boolean;
  /** Objets 3D sous la racine, racine exclue ; 0 après `liberer()`. */
  nombreObjets(): number;
  /**
   * `dispose()` exactement une fois sur chaque ressource créée, puis racine vidée. Un second appel ne libère rien de plus : le
   * registre est vidé au premier. Après lui, `maj()` et `animer()` ne font plus rien.
   */
  liberer(): void;
}

// --- Registre et cache ---------------------------------------------------------------------------------------------------------------

type GenrePartage = "geometrie" | "materiau";

interface Partage<T> {
  valeur: T;
  refs: number;
}

/** Ressources qui n'appartiennent qu'à un élément : libérées dès qu'il disparaît. */
interface Propres {
  geometries: BufferGeometry[];
  materiaux: Material[];
  instances: InstancedMesh[];
}

/** Emprunt à un cache partagé, rendu quand l'élément disparaît. */
type Emprunt = { genre: GenrePartage; cle: string };

/** Un élément du plan dessiné : son objet, ce qui le décrit et ce qu'il tient. */
interface Entree {
  objet: Object3D;
  /** Ce qui force à refaire l'objet (géométrie, matériau, forme) ; le reste se met à jour sur place. */
  signature: string;
  propres: Propres;
  partages: Emprunt[];
  /** Matériau du halo d'un nœud « travaille », pulsé par `animer` ; null sinon. */
  haloPulse: SpriteMaterial | null;
  /** Texture d'un faisceau ouvert non figé, défilée par `animer` ; null sinon. */
  defilante: Texture | null;
}

/** Ce qu'un constructeur d'élément remplit pendant qu'il bâtit son objet. */
interface Atelier {
  propres: Propres;
  partages: Emprunt[];
}

/** Clé de l'entrée du sol : décor permanent, jamais retiré par une mise à jour. */
const CLE_SOL = "sol";

const clePoint = (p: Point3) => `${p.x},${p.y},${p.z}`;

const milieu = (a: Point3, b: Point3): Point3 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });

function poser(objet: Object3D, position: Point3): void {
  objet.position.set(position.x, position.y, position.z);
}

// --- Fabrique ------------------------------------------------------------------------------------------------------------------------

/**
 * Graphe d'un plan 3D, aux couleurs de `palette` (elle doit correspondre à `plan.theme`, figé pour la vie du graphe). Le plan est
 * dessiné tout de suite : `creerGraphe(p, palette)` équivaut à un graphe vide suivi de `maj(p)`.
 */
export function creerGraphe(plan: Plan3d, palette: NeonPalette): Graphe {
  const racine = new Group();
  racine.name = "salle3d";

  const registre = {
    geometries: new Set<BufferGeometry>(),
    materiaux: new Set<Material>(),
    textures: new Set<Texture>(),
    instances: new Set<InstancedMesh>(),
  };
  const cacheGeometries = new Map<string, Partage<BufferGeometry>>();
  const cacheMateriaux = new Map<string, Partage<Material>>();
  const cacheTextures = new Map<string, Texture>();
  const entrees = new Map<string, Entree>();

  let halos: SpriteMaterial[] = [];
  let defilantes: Texture[] = [];
  let anime = false;
  let libere = false;

  const couleur = (jeton: NeonToken) => new Color(palette[jeton]);

  const nouvelAtelier = (): Atelier => ({ propres: { geometries: [], materiaux: [], instances: [] }, partages: [] });

  const entreeDe = (atelier: Atelier, objet: Object3D, halo: SpriteMaterial | null = null, defilante: Texture | null = null): Entree => ({
    objet,
    signature: "",
    propres: atelier.propres,
    partages: atelier.partages,
    haloPulse: halo,
    defilante,
  });

  // --- Ressources -------------------------------------------------------------------------------------------------------------------

  /** Géométrie partagée par sa clé : créée au premier preneur, libérée quand le dernier la rend. */
  function partageGeometrie(atelier: Atelier, cle: string, fabrique: () => BufferGeometry): BufferGeometry {
    let partage = cacheGeometries.get(cle);
    if (partage === undefined) {
      partage = { valeur: fabrique(), refs: 0 };
      registre.geometries.add(partage.valeur);
      cacheGeometries.set(cle, partage);
    }
    partage.refs += 1;
    atelier.partages.push({ genre: "geometrie", cle });
    return partage.valeur;
  }

  /** Matériau partagé par sa clé (le programme part avec le dernier matériau qui l'utilise, M3D-5). */
  function partageMateriau(atelier: Atelier, cle: string, fabrique: () => Material): Material {
    let partage = cacheMateriaux.get(cle);
    if (partage === undefined) {
      partage = { valeur: fabrique(), refs: 0 };
      registre.materiaux.add(partage.valeur);
      cacheMateriaux.set(cle, partage);
    }
    partage.refs += 1;
    atelier.partages.push({ genre: "materiau", cle });
    return partage.valeur;
  }

  function rendrePartage(genre: GenrePartage, cle: string): void {
    if (genre === "geometrie") {
      const partage = cacheGeometries.get(cle);
      if (partage === undefined) return;
      partage.refs -= 1;
      if (partage.refs > 0) return;
      cacheGeometries.delete(cle);
      partage.valeur.dispose();
      registre.geometries.delete(partage.valeur);
      return;
    }
    const partage = cacheMateriaux.get(cle);
    if (partage === undefined) return;
    partage.refs -= 1;
    if (partage.refs > 0) return;
    cacheMateriaux.delete(cle);
    partage.valeur.dispose();
    registre.materiaux.delete(partage.valeur);
  }

  /** Texture générée, au plus une par forme : elle vit le temps du graphe et n'est libérée que par `liberer()`. */
  function textureUnique(cle: string, fabrique: () => Texture): Texture {
    const connue = cacheTextures.get(cle);
    if (connue !== undefined) return connue;
    const texture = fabrique();
    cacheTextures.set(cle, texture);
    registre.textures.add(texture);
    return texture;
  }

  function propreGeometrie(atelier: Atelier, geometrie: BufferGeometry): BufferGeometry {
    registre.geometries.add(geometrie);
    atelier.propres.geometries.push(geometrie);
    return geometrie;
  }

  function propreMateriau<T extends Material>(atelier: Atelier, materiau: T): T {
    registre.materiaux.add(materiau);
    atelier.propres.materiaux.push(materiau);
    return materiau;
  }

  function propreInstance(atelier: Atelier, maille: InstancedMesh): InstancedMesh {
    registre.instances.add(maille);
    atelier.propres.instances.push(maille);
    return maille;
  }

  /** Retire un élément de la racine et libère ce qui ne sert plus qu'à lui. */
  function retirer(cle: string): void {
    const entree = entrees.get(cle);
    if (entree === undefined) return;
    entrees.delete(cle);
    racine.remove(entree.objet);
    for (const geometrie of entree.propres.geometries) {
      geometrie.dispose();
      registre.geometries.delete(geometrie);
    }
    for (const materiau of entree.propres.materiaux) {
      materiau.dispose();
      registre.materiaux.delete(materiau);
    }
    for (const maille of entree.propres.instances) {
      maille.dispose();
      registre.instances.delete(maille);
    }
    for (const emprunt of entree.partages) rendrePartage(emprunt.genre, emprunt.cle);
  }

  /** `userData` de tous les objets d'un élément : identifiant, faits recopiés (P12) ou marque de décor, et ce que L29d lit. */
  function marquer(entree: Entree, id: string, faits: readonly number[] | null, ajouts: Readonly<Record<string, unknown>>): void {
    entree.objet.traverse((objet) => {
      objet.userData.id = id;
      if (faits === null) objet.userData.decor = true;
      else objet.userData.faits = [...faits];
      for (const [nom, valeur] of Object.entries(ajouts)) objet.userData[nom] = valeur;
    });
  }

  // --- Matériaux communs -------------------------------------------------------------------------------------------------------------

  /** Corps d'une plaque ou d'un socle : sombre comme le fond, la couleur vit dans les arêtes (comme la bande 2D). */
  const materiauCorps = (atelier: Atelier) =>
    partageMateriau(atelier, "corps", () => new MeshBasicMaterial({ color: couleur("fond"), transparent: true, opacity: 0.88 }));

  const materiauLigne = (atelier: Atelier, jeton: NeonToken) => partageMateriau(atelier, `ligne:${jeton}`, () => new LineBasicMaterial({ color: couleur(jeton) }));

  // --- Éléments ------------------------------------------------------------------------------------------------------------------------

  /** Sol quadrillé : décor permanent, créé une fois. */
  function creerEntreeSol(): void {
    const atelier = nouvelAtelier();
    const sol = creerSol(palette);
    propreGeometrie(atelier, sol.geometrie);
    propreMateriau(atelier, sol.materiau);
    const entree = entreeDe(atelier, sol.objet);
    entrees.set(CLE_SOL, entree);
    racine.add(sol.objet);
    marquer(entree, CLE_SOL, null, { famille: "sol" });
  }

  function creerStation(station: Plan3dStation): Entree {
    const atelier = nouvelAtelier();
    const groupe = new Group();
    const socle = partageGeometrie(atelier, "station", () => geometriePrisme(TAILLES.stationRayon, TAILLES.stationHauteur));
    const aretes = partageGeometrie(atelier, "station|aretes", () => geometrieAretes(socle));
    groupe.add(new Mesh(socle, materiauCorps(atelier)));
    groupe.add(new LineSegments(aretes, materiauLigne(atelier, JETON_STATION)));
    groupe.name = `station:${station.id}`;
    return entreeDe(atelier, groupe);
  }

  function creerTerritoire(territoire: Plan3dTerritoire): Entree {
    const atelier = nouvelAtelier();
    const groupe = new Group();
    const cle = `territoire:${territoire.rayon}`;
    const plaque = partageGeometrie(atelier, cle, () => geometriePrisme(territoire.rayon, TAILLES.territoireHauteur));
    const aretes = partageGeometrie(atelier, `${cle}|aretes`, () => geometrieAretes(plaque));
    groupe.add(new Mesh(plaque, materiauCorps(atelier)));
    groupe.add(new LineSegments(aretes, materiauLigne(atelier, "territoire")));
    if (territoire.enceinte) {
      // JP-10 : l'enceinte de la Salle OMO se voit à son second anneau d'arêtes et à sa plaque, à la teinte « extension ».
      const cleEnceinte = `enceinte:${territoire.rayon}`;
      const support = partageGeometrie(atelier, cleEnceinte, () => geometriePrisme(territoire.rayon * TAILLES.enceinteAnneau, TAILLES.enceinteHauteur));
      const anneau = partageGeometrie(atelier, `${cleEnceinte}|aretes`, () => geometrieAretes(support));
      const teinte = partageMateriau(
        atelier,
        `plaque:${JETON_ENCEINTE}`,
        () => new MeshBasicMaterial({ color: couleur(JETON_ENCEINTE), transparent: true, opacity: 0.28, depthWrite: false }),
      );
      const plateau = new Mesh(support, teinte);
      plateau.position.set(0, -TAILLES.territoireHauteur / 2, 0);
      const cadre = new LineSegments(anneau, materiauLigne(atelier, JETON_ENCEINTE));
      cadre.position.set(0, -TAILLES.territoireHauteur / 2, 0);
      groupe.add(plateau);
      groupe.add(cadre);
    }
    groupe.name = `territoire:${territoire.id}`;
    return entreeDe(atelier, groupe);
  }

  function creerNoeud(noeud: Plan3dNode): Entree {
    const atelier = nouvelAtelier();
    const groupe = new Group();
    const prisme = partageGeometrie(atelier, "noeud", () => geometriePrisme(TAILLES.noeudRayon, TAILLES.noeudHauteur));
    groupe.add(new Mesh(prisme, partageMateriau(atelier, `noeud:${JETON_NOEUD}`, () => new MeshBasicMaterial({ color: couleur(JETON_NOEUD) }))));
    groupe.name = `noeud:${noeud.id}`;
    if (noeud.halo === "aucun") return entreeDe(atelier, groupe);
    const pulse = noeud.halo === "travaille";
    const materiau = propreMateriau(
      atelier,
      new SpriteMaterial({
        map: textureUnique("halo", textureHalo),
        color: couleur(JETON_NOEUD),
        blending: AdditiveBlending,
        transparent: true,
        depthWrite: false,
        opacity: pulse ? HALO_OPACITE_MAX : HALO_OPACITE_STATIQUE,
        sizeAttenuation: true,
      }),
    );
    const halo = new Sprite(materiau);
    halo.scale.set(HALO_ECHELLE, HALO_ECHELLE, 1);
    halo.renderOrder = 1;
    // M3D-5 : la géométrie des `Sprite` est partagée par three ; le registre (un ensemble) la libère UNE SEULE fois.
    registre.geometries.add(halo.geometry);
    groupe.add(halo);
    return entreeDe(atelier, groupe, pulse ? materiau : null);
  }

  function creerFaisceau(faisceau: Plan3dBeam): Entree {
    const atelier = nouvelAtelier();
    // Cible encore inconnue (faisceau ouvert) : la courbe s'arrête au point de contrôle, sans rien inventer au-delà (P12).
    const fin = faisceau.vers ?? faisceau.controle;
    const pivot = faisceau.vers === null ? milieu(faisceau.de, faisceau.controle) : faisceau.controle;
    const geometrie = propreGeometrie(atelier, geometrieTube(courbeFaisceau(faisceau.de, pivot, fin)));
    const defile = faisceau.ouvert && !faisceau.fige;
    const cleTexture = `faisceau:${faisceau.forme}:${defile ? "defile" : "fixe"}`;
    const texture = textureUnique(cleTexture, () => {
      const generee = textureFaisceau(faisceau.forme);
      generee.repeat.set(REPETITIONS_FAISCEAU, 1);
      return generee;
    });
    const jeton = faisceau.fige ? JETON_FIGE : faisceau.jeton;
    const materiau = partageMateriau(
      atelier,
      `${cleTexture}:${jeton}`,
      () => new MeshBasicMaterial({ color: couleur(jeton), map: texture, transparent: true, opacity: 0.92, depthWrite: false, blending: AdditiveBlending }),
    );
    // La géométrie du tube est déjà dans les coordonnées de la scène : l'objet reste à l'origine.
    const tube = new Mesh(geometrie, materiau);
    tube.renderOrder = 2;
    tube.name = `faisceau:${faisceau.id}`;
    return entreeDe(atelier, tube, null, defile ? texture : null);
  }

  function creerMarque(marque: Plan3dMark): Entree {
    const atelier = nouvelAtelier();
    const plaque = partageGeometrie(atelier, "marque", () => geometriePlaque(TAILLES.marqueCote));
    const texture = textureUnique(`marque:${marque.kind}`, () => textureMarque(marque.kind));
    const materiau = partageMateriau(
      atelier,
      `marque:${marque.kind}:${marque.jeton}`,
      () => new MeshBasicMaterial({ color: couleur(marque.jeton), map: texture, transparent: true, depthWrite: false, side: DoubleSide, blending: AdditiveBlending }),
    );
    const objet = new Mesh(plaque, materiau);
    objet.renderOrder = 3;
    objet.name = `marque:${marque.id}`;
    return entreeDe(atelier, objet);
  }

  /** Lien du carnet partagé (L3s-a) : tube fin et droit de la station vers l'assistant, sans texture ni défilement. */
  function creerLienCarnet(lien: Plan3dLienCarnet): Entree {
    const atelier = nouvelAtelier();
    const courbe = courbeFaisceau(lien.de, milieu(lien.de, lien.vers), lien.vers);
    const geometrie = propreGeometrie(atelier, new TubeGeometry(courbe, SEGMENTS_LIEN_CARNET, RAYON_LIEN_CARNET, COTES_LIEN_CARNET, false));
    const materiau = partageMateriau(
      atelier,
      `lien-carnet:${JETON_LIEN_CARNET}`,
      () => new MeshBasicMaterial({ color: couleur(JETON_LIEN_CARNET), transparent: true, opacity: 0.85, depthWrite: false }),
    );
    // Géométrie déjà dans les coordonnées de la scène, comme un faisceau : l'objet reste à l'origine.
    const tube = new Mesh(geometrie, materiau);
    tube.name = `lien-carnet:${lien.id}`;
    return entreeDe(atelier, tube);
  }

  function creerTuiles(lot: Plan3dTileBatch): Entree {
    const atelier = nouvelAtelier();
    const geometrie = partageGeometrie(atelier, `tuile:${lot.etat}`, () => geometrieTuile(lot.etat));
    const materiau = partageMateriau(atelier, `tuile:${lot.etat}`, () => new MeshBasicMaterial({ color: couleur(JETONS_TUILE[lot.etat]) }));
    const maille = propreInstance(atelier, new InstancedMesh(geometrie, materiau, lot.positions.length));
    maille.frustumCulled = false;
    maille.name = `tuiles:${lot.dossier}:${lot.etat}`;
    return entreeDe(atelier, maille);
  }

  // --- Mise à jour par différence ----------------------------------------------------------------------------------------------------

  function synchroniser<T>(
    famille: string,
    elements: readonly T[],
    cle: (element: T) => string,
    signature: (element: T) => string,
    creer: (element: T) => Entree,
    mettreAJour: (entree: Entree, element: T) => void,
    vus: Set<string>,
  ): void {
    for (const element of elements) {
      const complete = `${famille}:${cle(element)}`;
      // Identifiant en double dans un plan : le premier gagne, le second est ignoré (aucun objet en double).
      if (vus.has(complete)) continue;
      vus.add(complete);
      const attendue = signature(element);
      let entree = entrees.get(complete);
      if (entree !== undefined && entree.signature !== attendue) {
        retirer(complete);
        entree = undefined;
      }
      if (entree === undefined) {
        entree = creer(element);
        entree.signature = attendue;
        entrees.set(complete, entree);
        racine.add(entree.objet);
      }
      mettreAJour(entree, element);
    }
  }

  function recalculerAnimations(): void {
    halos = [];
    const textures = new Set<Texture>();
    let ouverts = 0;
    for (const entree of entrees.values()) {
      if (entree.haloPulse !== null) halos.push(entree.haloPulse);
      if (entree.defilante !== null) {
        textures.add(entree.defilante);
        ouverts += 1;
      }
    }
    defilantes = [...textures];
    anime = halos.length > 0 || ouverts > 0;
  }

  function majTuiles(entree: Entree, lot: Plan3dTileBatch): void {
    const maille = entree.propres.instances[0];
    if (maille !== undefined) {
      const matrice = new Matrix4();
      const total = Math.min(maille.count, lot.positions.length);
      for (let i = 0; i < total; i++) {
        const position = lot.positions[i];
        if (position === undefined) continue;
        maille.setMatrixAt(i, matrice.makeTranslation(position.x, position.y, position.z));
      }
      maille.instanceMatrix.needsUpdate = true;
    }
    marquer(entree, `${lot.dossier}|${lot.etat}`, lot.faits, { famille: "tuiles", dossier: lot.dossier, etat: lot.etat });
  }

  function maj(nouveau: Plan3d): void {
    if (libere) return;
    const vus = new Set<string>([CLE_SOL]);
    synchroniser(
      "station",
      nouveau.stations,
      (station) => station.id,
      (station) => station.id,
      creerStation,
      (entree, station) => {
        poser(entree.objet, station.position);
        marquer(entree, station.id, null, { famille: "station" });
      },
      vus,
    );
    synchroniser(
      "territoire",
      nouveau.territoires,
      (territoire) => territoire.id,
      (territoire) => `${territoire.rayon}|${territoire.enceinte}`,
      creerTerritoire,
      (entree, territoire) => {
        poser(entree.objet, territoire.centre);
        marquer(entree, territoire.id, null, { famille: "territoire", projet: territoire.projet, enceinte: territoire.enceinte });
      },
      vus,
    );
    synchroniser(
      "noeud",
      nouveau.noeuds,
      (noeud) => noeud.id,
      (noeud) => noeud.halo,
      creerNoeud,
      (entree, noeud) => {
        poser(entree.objet, noeud.position);
        marquer(entree, noeud.id, noeud.faits, { famille: "noeud", etat: noeud.etat, nom: noeud.nom, role: noeud.role, secteur: noeud.secteur });
      },
      vus,
    );
    synchroniser(
      "faisceau",
      nouveau.faisceaux,
      (faisceau) => faisceau.id,
      (faisceau) =>
        [faisceau.forme, faisceau.jeton, faisceau.fige, faisceau.ouvert, clePoint(faisceau.de), clePoint(faisceau.controle), faisceau.vers === null ? "-" : clePoint(faisceau.vers)].join("|"),
      creerFaisceau,
      (entree, faisceau) => {
        marquer(entree, faisceau.id, faisceau.faits, { famille: "faisceau", kind: faisceau.kind, fige: faisceau.fige, ouvert: faisceau.ouvert });
      },
      vus,
    );
    synchroniser(
      "marque",
      nouveau.marques,
      (marque) => marque.id,
      (marque) => `${marque.kind}|${marque.jeton}`,
      creerMarque,
      (entree, marque) => {
        poser(entree.objet, marque.position);
        marquer(entree, marque.id, marque.faits, { famille: "marque", kind: marque.kind });
      },
      vus,
    );
    synchroniser(
      "tuiles",
      nouveau.tuiles.filter((lot) => lot.positions.length > 0),
      (lot) => `${lot.dossier}|${lot.etat}`,
      (lot) => `${lot.etat}|${lot.positions.length}`,
      creerTuiles,
      majTuiles,
      vus,
    );
    // Salle OMO (L3s-a) : liens du carnet partagé, s'il y en a ; champ facultatif du plan.
    synchroniser(
      "lien-carnet",
      nouveau.liensCarnet ?? [],
      (lien) => lien.id,
      (lien) => `${clePoint(lien.de)}|${clePoint(lien.vers)}`,
      creerLienCarnet,
      (entree, lien) => marquer(entree, lien.id, lien.faits, { famille: "lien-carnet" }),
      vus,
    );
    // Copie des clés : `retirer` enlève l'entrée de la table pendant le parcours.
    for (const cle of [...entrees.keys()]) if (!vus.has(cle)) retirer(cle);
    recalculerAnimations();
  }

  function animer(tSec: number, mouvementReduit: boolean): boolean {
    if (libere || mouvementReduit || !anime) return false;
    const phase = 0.5 + 0.5 * Math.sin((2 * Math.PI * tSec) / PERIODE_HALO_S);
    const opacite = HALO_OPACITE_MIN + (HALO_OPACITE_MAX - HALO_OPACITE_MIN) * phase;
    for (const materiau of halos) materiau.opacity = opacite;
    const decalage = -((tSec * VITESSE_DEFILEMENT) % 1);
    for (const texture of defilantes) texture.offset.set(decalage, 0);
    return true;
  }

  function nombreObjets(): number {
    let compte = -1;
    racine.traverse(() => {
      compte += 1;
    });
    return compte;
  }

  function liberer(): void {
    libere = true;
    // Ordre de M3D-5 : géométries, matériaux (le programme part avec le dernier), textures, puis chaque InstancedMesh par son
    // propre dispose() — sans lui, 5 tampons WebGL restent vivants alors que `renderer.info.memory` affiche 0/0.
    for (const geometrie of registre.geometries) geometrie.dispose();
    registre.geometries.clear();
    for (const materiau of registre.materiaux) materiau.dispose();
    registre.materiaux.clear();
    for (const texture of registre.textures) texture.dispose();
    registre.textures.clear();
    for (const maille of registre.instances) maille.dispose();
    registre.instances.clear();
    entrees.clear();
    cacheGeometries.clear();
    cacheMateriaux.clear();
    cacheTextures.clear();
    halos = [];
    defilantes = [];
    anime = false;
    racine.clear();
  }

  creerEntreeSol();
  maj(plan);
  return { racine, maj, animer, nombreObjets, liberer };
}
