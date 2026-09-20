// Graphe three.js de la salle de contrôle 3D (itération 3, L29b ; spécification §5.8 l.995-997, §7.7 l.1170, JP-6, JP-11 ;
// plan it3 §6 « L29b », D-3d-04, D-3d-05, D-3d-17 ; mesure MX-3D, M3D-2, M3D-5 et M3D-7).
// Tout se joue en Node avec le VRAI three, sans DOM ni WebGL (M3D-7 : hors `WebGLRenderer`, tout se crée et se libère sans
// document) ; la partie « compteur `renderer.info` » est jouée en e2e par L35.
// Les libérations sont comptées par des espions posés sur les `dispose()` des prototypes de three : ils voient CHAQUE appel, y
// compris sur une ressource que la scène ne porte plus (M3D-5 : sans `InstancedMesh.dispose()`, 5 tampons restent vivants alors
// que `renderer.info.memory` affiche 0/0).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { BufferGeometry, Color, DataTexture, InstancedMesh, LineBasicMaterial, type Material, MeshBasicMaterial, type Object3D, ShaderMaterial, SpriteMaterial, Texture } from "three";
import {
  creerGraphe,
  type Graphe,
  HALO_OPACITE_MAX,
  HALO_OPACITE_STATIQUE,
  JETON_ENCEINTE,
  JETON_FIGE,
  JETON_NOEUD,
  JETON_STATION,
  JETONS_TUILE,
  PERIODE_HALO_S,
  VITESSE_DEFILEMENT,
} from "../web/pages/salle-controle/three/graphe.ts";
import { COTES_HEXAGONE, courbeFaisceau, HAUTEURS_TUILE, segmentsTube } from "../web/pages/salle-controle/three/formes.ts";
import {
  HAUTEUR_FAISCEAU,
  LARGEUR_FAISCEAU,
  masqueHalo,
  MASQUES_FAISCEAU,
  MASQUES_MARQUE,
  octetsDuMasque,
  TAILLE_MARQUE,
} from "../web/pages/salle-controle/three/textures.ts";
import { NEON_PALETTES } from "./shared/neon-palette.ts";
import type { Plan3d, Plan3dBeam, Plan3dMark, Plan3dNode, Plan3dStation, Plan3dTerritoire, Plan3dTileBatch, Point3 } from "./shared/salle3d-types.ts";

const PALETTE = NEON_PALETTES.sombre;
const DOSSIER_THREE = path.join(import.meta.dirname, "..", "web", "pages", "salle-controle", "three");

// --- Plans synthétiques ------------------------------------------------------------------------------------------------------------

const point = (x: number, y: number, z: number): Point3 => ({ x, y, z });

const station = (id: Plan3dStation["id"], x: number): Plan3dStation => ({ id, position: point(x, 0, 0) });

const territoire = (id: string, enceinte: boolean): Plan3dTerritoire => ({
  id,
  projet: `projets/${id}`,
  centre: point(0, 0, 0),
  rayon: 6,
  enceinte,
  compteurs: { travaillent: 1, attendent: 0, cout: 0 },
});

const noeud = (id: string, halo: Plan3dNode["halo"], faits: number[] = [1]): Plan3dNode => ({
  id,
  parentId: null,
  role: "conversation",
  secteur: null,
  position: point(0, 1, 0),
  etat: halo === "travaille" ? "travaille" : "termine",
  halo,
  nom: null,
  faits,
});

const faisceau = (id: string, forme: Plan3dBeam["forme"], options: Partial<Plan3dBeam> = {}): Plan3dBeam => ({
  id,
  kind: "consigne",
  de: point(0, 1, 0),
  controle: point(4, 5, 0),
  vers: point(8, 1, 0),
  forme,
  jeton: "consigne",
  fige: false,
  ouvert: false,
  faits: [2],
  ...options,
});

const marque = (id: string, kind: Plan3dMark["kind"], jeton: Plan3dMark["jeton"]): Plan3dMark => ({ id, kind, position: point(1, 0.2, 1), jeton, faits: [3] });

const lot = (dossier: string, etat: Plan3dTileBatch["etat"], nombre: number): Plan3dTileBatch => ({
  dossier,
  etat,
  positions: Array.from({ length: nombre }, (_, i) => point(i, 0.2, 0)),
  faits: [4],
});

function plan(parties: Partial<Plan3d> = {}): Plan3d {
  return {
    zoom: 2,
    theme: "sombre",
    mode: "avance",
    rootId: "ses_racine",
    focus: null,
    stations: [],
    territoires: [],
    noeuds: [],
    faisceaux: [],
    marques: [],
    tuiles: [],
    etiquettes: [],
    camera: { cible: point(0, 0, 0), distance: 40, inclinaisonDeg: 55, fovDeg: 35 },
    anime: false,
    enceinte: null,
    carnetVide: true,
    ...parties,
  };
}

/** Plan qui contient chaque genre d'élément, y compris un lot de tuiles vide (qui ne crée aucun objet). */
const MARQUES: ReadonlyArray<Plan3dMark["kind"]> = ["attente", "auto", "refus", "origine", "impulsion", "arret"];

function planComplet(): Plan3d {
  return plan({
    stations: [station("vous", 0), station("copilot", 10), station("carnet", -10), station("controle", 20)],
    territoires: [territoire("t1", false), territoire("t2", true)],
    noeuds: [noeud("n1", "aucun"), noeud("n2", "statique"), noeud("n3", "travaille")],
    faisceaux: [faisceau("b1", "chevrons", { ouvert: true }), faisceau("b2", "losanges"), faisceau("b3", "fleche", { fige: true, jeton: "vous" })],
    marques: MARQUES.map((kind, i) => marque(`m${i}`, kind, "attente")),
    tuiles: [lot("src", "lu", 3), lot("src", "modifie", 2), lot("docs", "refuse", 0)],
    anime: true,
  });
}

/**
 * Objets attendus, par genre d'élément (en-tête de graphe.ts) : sol 1 · station 3 · territoire 3 (5 avec enceinte) · nœud 2
 * (3 avec halo) · faisceau 1 · marque 1 · lot de tuiles non vide 1.
 */
const OBJETS_PLAN_COMPLET = 1 + 4 * 3 + (3 + 5) + (2 + 3 + 3) + 3 + 6 + 2;

// --- Espions sur dispose() ------------------------------------------------------------------------------------------------------------

interface Espion {
  /** Nombre d'appels à `dispose()` par objet. */
  comptes: Map<object, number>;
  restaurer(): void;
}

/**
 * Enveloppe `dispose()` sur les prototypes de three : géométries (toutes les sous-classes en héritent), textures, `InstancedMesh`
 * et chacun des quatre matériaux employés par le graphe.
 */
function espionnerDispose(): Espion {
  const comptes = new Map<object, number>();
  const restaurations: Array<() => void> = [];
  const poser = <T extends { dispose(): void }>(prototype: T): void => {
    const original = prototype.dispose;
    prototype.dispose = function remplacant(this: T): void {
      comptes.set(this, (comptes.get(this) ?? 0) + 1);
      original.call(this);
    };
    restaurations.push(() => {
      prototype.dispose = original;
    });
  };
  poser(BufferGeometry.prototype);
  poser(Texture.prototype);
  poser(InstancedMesh.prototype);
  poser(MeshBasicMaterial.prototype);
  poser(LineBasicMaterial.prototype);
  poser(SpriteMaterial.prototype);
  poser(ShaderMaterial.prototype);
  return {
    comptes,
    restaurer: () => {
      for (const restaurer of restaurations) restaurer();
    },
  };
}

/** Compte les `dispose()` faits pendant `action`, espions retirés même en cas d'échec. */
function pendant(action: () => void): Map<object, number> {
  const espion = espionnerDispose();
  try {
    action();
  } finally {
    espion.restaurer();
  }
  return espion.comptes;
}

// --- Lecture de la scène ----------------------------------------------------------------------------------------------------------------

/** Vue d'un objet qui porte des ressources (`Mesh`, `LineSegments`, `Sprite`, `InstancedMesh`) ; un `Group` n'en porte aucune. */
interface Porteur {
  geometry?: BufferGeometry;
  material?: Material & { map?: Texture | null; color?: Color };
}

const porteur = (objet: Object3D): Porteur => objet as unknown as Porteur;

function objets(racine: Object3D): Object3D[] {
  const tous: Object3D[] = [];
  racine.traverse((objet) => {
    if (objet !== racine) tous.push(objet);
  });
  return tous;
}

const parNom = (racine: Object3D, nom: string): Object3D | undefined => objets(racine).find((objet) => objet.name === nom);

/** Toutes les ressources que la scène porte : géométries, matériaux, textures de leurs cartes, et les `InstancedMesh` eux-mêmes. */
function ressources(racine: Object3D): Set<object> {
  const vues = new Set<object>();
  for (const objet of objets(racine)) {
    const { geometry, material } = porteur(objet);
    if (geometry !== undefined) vues.add(geometry);
    if (material !== undefined) {
      vues.add(material);
      if (material.map !== undefined && material.map !== null) vues.add(material.map);
    }
    if (objet instanceof InstancedMesh) vues.add(objet);
  }
  return vues;
}

/** Texture de la carte d'un objet nommé. */
function textureDe(graphe: Graphe, nom: string): Texture {
  const objet = parNom(graphe.racine, nom);
  assert.ok(objet !== undefined, `objet « ${nom} » présent`);
  const carte = porteur(objet).material?.map;
  assert.ok(carte instanceof Texture, `objet « ${nom} » porte une texture`);
  return carte;
}

/** Matériau du halo d'un nœud (le `Sprite` du groupe). */
function haloDe(graphe: Graphe, id: string): SpriteMaterial {
  const groupe = parNom(graphe.racine, `noeud:${id}`);
  assert.ok(groupe !== undefined, `nœud ${id} présent`);
  const sprite = groupe.children.map(porteur).find((enfant) => enfant.material instanceof SpriteMaterial);
  assert.ok(sprite?.material instanceof SpriteMaterial, `nœud ${id} a un halo`);
  return sprite.material;
}

const hex = (jeton: keyof typeof PALETTE) => new Color(PALETTE[jeton]).getHex();

const couleurDe = (racine: Object3D, nom: string) => porteur(parNom(racine, nom) ?? racine).material?.color?.getHex();

// --- Tests -----------------------------------------------------------------------------------------------------------------------------

describe("graphe 3D : construction", () => {
  it("plan synthétique de chaque genre d'élément : nombre d'objets attendu, un lot de tuiles vide n'en crée aucun", () => {
    const graphe = creerGraphe(planComplet(), PALETTE);
    try {
      assert.equal(graphe.nombreObjets(), OBJETS_PLAN_COMPLET);
      assert.equal(parNom(graphe.racine, "sol")?.name, "sol");
      assert.equal(parNom(graphe.racine, "tuiles:docs:refuse"), undefined, "lot vide : aucun objet");
      for (const id of ["vous", "copilot", "carnet", "controle"]) assert.ok(parNom(graphe.racine, `station:${id}`) !== undefined, id);
    } finally {
      graphe.liberer();
    }
  });

  it("P12 : userData.faits recopié du plan hors décor ; le décor (sol, stations, territoires) n'en porte aucun", () => {
    const source = planComplet();
    const graphe = creerGraphe(source, PALETTE);
    try {
      let horsDecor = 0;
      for (const objet of objets(graphe.racine)) {
        const { decor, faits, id } = objet.userData;
        assert.equal(typeof id, "string", `${objet.name} porte un identifiant`);
        if (decor === true) {
          assert.equal(faits, undefined, `${objet.name} est du décor : aucun fait`);
          continue;
        }
        horsDecor += 1;
        assert.ok(Array.isArray(faits) && faits.length > 0, `${objet.name} porte des faits`);
      }
      assert.equal(horsDecor, 2 + 3 + 3 + 3 + 6 + 2, "nœuds (2 + 3 + 3 objets), 3 faisceaux, 6 marques et 2 lots de tuiles");
      // Recopié, jamais partagé avec le plan (P12 : le graphe ne tient pas la liste du plan).
      const premier = objets(graphe.racine).find((objet) => objet.name === "faisceau:b1");
      assert.deepEqual(premier?.userData.faits, [2]);
      assert.notEqual(premier?.userData.faits, source.faisceaux[0]?.faits);
    } finally {
      graphe.liberer();
    }
  });

  it("couleurs : nœuds au jeton acteur, stations et territoires au jeton territoire, enceinte à extension, faisceau figé à arret", () => {
    // Jetons attendus, écrits ici en toutes lettres : le test ne suit pas les constantes du module (§5.7.1, NEON_GRAMMAIRE).
    assert.deepEqual([JETON_NOEUD, JETON_STATION, JETON_ENCEINTE, JETON_FIGE], ["acteur", "territoire", "extension", "arret"]);
    assert.deepEqual(JETONS_TUILE, { lu: "resultat", modifie: "consigne", refuse: "refus", "en-cours": "attente" });
    const graphe = creerGraphe(planComplet(), PALETTE);
    try {
      const noeuds = parNom(graphe.racine, "noeud:n1");
      assert.equal(porteur(noeuds?.children[0] ?? graphe.racine).material?.color?.getHex(), hex("acteur"));
      const station1 = parNom(graphe.racine, "station:vous");
      assert.equal(porteur(station1?.children[1] ?? graphe.racine).material?.color?.getHex(), hex("territoire"));
      const enceinte = parNom(graphe.racine, "territoire:t2");
      assert.equal(porteur(enceinte?.children[3] ?? graphe.racine).material?.color?.getHex(), hex("extension"));
      assert.equal(couleurDe(graphe.racine, "faisceau:b3"), hex("arret"), "figé : jeton arret, quel que soit le jeton du plan");
      assert.equal(couleurDe(graphe.racine, "faisceau:b2"), hex("consigne"));
      assert.equal(couleurDe(graphe.racine, "tuiles:src:lu"), hex("resultat"));
      assert.equal(couleurDe(graphe.racine, "tuiles:src:modifie"), hex("consigne"));
    } finally {
      graphe.liberer();
    }
  });

  it("textures générées : DataTexture seulement (M3D-2), halo produit UNE fois et partagé", () => {
    const graphe = creerGraphe(planComplet(), PALETTE);
    try {
      const textures = [...ressources(graphe.racine)].filter((valeur): valeur is Texture => valeur instanceof Texture);
      assert.ok(textures.length >= 8, `${textures.length} textures`);
      for (const texture of textures) assert.ok(texture instanceof DataTexture, "texture générée, ni image ni canevas");
      assert.equal(haloDe(graphe, "n2").map, haloDe(graphe, "n3").map, "halo : une seule texture pour tous les nœuds");
    } finally {
      graphe.liberer();
    }
  });

  it("tuiles : un InstancedMesh par dossier ET par état, donc au plus 4 par dossier même à 200 tuiles", () => {
    const graphe = creerGraphe(
      plan({ tuiles: [lot("src", "lu", 50), lot("src", "modifie", 50), lot("src", "refuse", 50), lot("src", "en-cours", 50), lot("docs", "lu", 20)] }),
      PALETTE,
    );
    try {
      const mailles = objets(graphe.racine).filter((objet): objet is InstancedMesh => objet instanceof InstancedMesh);
      const parDossier = new Map<string, number>();
      for (const maille of mailles) {
        const dossier = String(maille.userData.dossier);
        parDossier.set(dossier, (parDossier.get(dossier) ?? 0) + 1);
      }
      assert.equal(parDossier.get("src"), 4, "200 tuiles d'un dossier : 4 InstancedMesh au plus");
      assert.equal(parDossier.get("docs"), 1);
      assert.equal(
        mailles.reduce((total, maille) => total + maille.count, 0),
        220,
      );
    } finally {
      graphe.liberer();
    }
  });
});

describe("graphe 3D : mise à jour par différence", () => {
  it("retirer la moitié des nœuds libère leurs ressources propres une fois, et garde ce qui sert encore", () => {
    const quatre = [noeud("n1", "travaille"), noeud("n2", "travaille"), noeud("n3", "travaille"), noeud("n4", "travaille")];
    const graphe = creerGraphe(plan({ noeuds: quatre }), PALETTE);
    try {
      const partis = [haloDe(graphe, "n3"), haloDe(graphe, "n4")];
      const restes = [haloDe(graphe, "n1"), haloDe(graphe, "n2")];
      const prisme = porteur(parNom(graphe.racine, "noeud:n1")?.children[0] ?? graphe.racine).geometry;
      const texture = restes[0]?.map;
      const comptes = pendant(() => graphe.maj(plan({ noeuds: quatre.slice(0, 2) })));

      assert.equal(graphe.nombreObjets(), 1 + 2 * 3, "sol et deux nœuds à halo");
      for (const materiau of partis) assert.equal(comptes.get(materiau), 1, "halo d'un nœud retiré : libéré une fois");
      for (const materiau of restes) assert.equal(comptes.get(materiau), undefined, "halo d'un nœud gardé : intact");
      assert.equal(comptes.get(prisme as object), undefined, "géométrie partagée : gardée tant qu'un nœud l'utilise");
      assert.equal(comptes.get(texture as object), undefined, "texture générée : gardée pour la vie du graphe");
      assert.deepEqual([...comptes.values()], [1, 1], "rien d'autre n'est libéré");
    } finally {
      graphe.liberer();
    }
  });

  it("retirer le dernier porteur d'une ressource partagée la libère une fois ; le lot de tuiles part avec son InstancedMesh", () => {
    const graphe = creerGraphe(plan({ noeuds: [noeud("n1", "statique")], tuiles: [lot("src", "lu", 4)] }), PALETTE);
    try {
      const maille = objets(graphe.racine).find((objet): objet is InstancedMesh => objet instanceof InstancedMesh);
      assert.ok(maille !== undefined);
      const geometrie = porteur(maille).geometry;
      const materiau = porteur(maille).material;
      const comptes = pendant(() => graphe.maj(plan({ noeuds: [noeud("n1", "statique")] })));
      assert.equal(comptes.get(maille), 1, "InstancedMesh libéré par son propre dispose()");
      assert.equal(comptes.get(geometrie as object), 1, "géométrie de tuile : dernier porteur parti");
      assert.equal(comptes.get(materiau as object), 1, "matériau de tuile : dernier porteur parti");
      assert.equal(graphe.nombreObjets(), 1 + 3);
    } finally {
      graphe.liberer();
    }
  });

  it("un élément dont la signature change est refait, un élément inchangé est gardé et seulement reposé", () => {
    const graphe = creerGraphe(plan({ noeuds: [noeud("n1", "statique")] }), PALETTE);
    try {
      const avant = parNom(graphe.racine, "noeud:n1");
      const deplace: Plan3dNode = { ...noeud("n1", "statique"), position: point(5, 1, 5), faits: [7, 8] };
      graphe.maj(plan({ noeuds: [deplace] }));
      const apres = parNom(graphe.racine, "noeud:n1");
      assert.equal(apres, avant, "même halo : l'objet est gardé");
      assert.deepEqual([apres?.position.x, apres?.position.z], [5, 5]);
      assert.deepEqual(apres?.userData.faits, [7, 8], "faits recopiés à chaque mise à jour");

      const comptes = pendant(() => graphe.maj(plan({ noeuds: [noeud("n1", "travaille")] })));
      assert.notEqual(parNom(graphe.racine, "noeud:n1"), avant, "halo changé : l'objet est refait");
      assert.equal([...comptes.values()].filter((n) => n !== 1).length, 0, "l'ancien halo est libéré une seule fois");
      assert.equal(graphe.nombreObjets(), 1 + 3);
    } finally {
      graphe.liberer();
    }
  });

  it("le sol survit à toutes les mises à jour, y compris un plan vide", () => {
    const graphe = creerGraphe(planComplet(), PALETTE);
    try {
      graphe.maj(plan());
      assert.equal(graphe.nombreObjets(), 1);
      assert.ok(parNom(graphe.racine, "sol") !== undefined);
    } finally {
      graphe.liberer();
    }
  });
});

describe("graphe 3D : animation", () => {
  it("mouvement réduit : rend false et ne bouge rien (aucune pulsation, aucun défilement)", () => {
    const graphe = creerGraphe(plan({ noeuds: [noeud("n1", "travaille")], faisceaux: [faisceau("b1", "chevrons", { ouvert: true })] }), PALETTE);
    try {
      const halo = haloDe(graphe, "n1");
      const texture = textureDe(graphe, "faisceau:b1");
      assert.equal(graphe.animer(0.7, true), false);
      assert.equal(halo.opacity, HALO_OPACITE_MAX);
      assert.equal(texture.offset.x, 0);
    } finally {
      graphe.liberer();
    }
  });

  it("halo « travaille » pulsé d'un cycle par 2 s, halo « statique » jamais touché (JP-13)", () => {
    const graphe = creerGraphe(plan({ noeuds: [noeud("n1", "travaille"), noeud("n2", "statique")] }), PALETTE);
    try {
      const pulse = haloDe(graphe, "n1");
      const fixe = haloDe(graphe, "n2");
      assert.equal(graphe.animer(PERIODE_HALO_S / 4, false), true);
      const haut = pulse.opacity;
      assert.equal(graphe.animer((PERIODE_HALO_S * 3) / 4, false), true);
      assert.ok(pulse.opacity < haut, "l'opacité redescend sur la seconde moitié du cycle");
      assert.ok(Math.abs(graphe.animer(PERIODE_HALO_S, false) ? pulse.opacity - haut : 1) > 0, "un cycle complet par 2 s");
      assert.equal(fixe.opacity, HALO_OPACITE_STATIQUE, "halo statique : jamais pulsé");
    } finally {
      graphe.liberer();
    }
  });

  it("un faisceau ouvert non figé défile ; un faisceau figé ne défile pas et garde sa forme", () => {
    const graphe = creerGraphe(
      plan({
        noeuds: [noeud("n1", "travaille")],
        faisceaux: [faisceau("b1", "chevrons", { ouvert: true }), faisceau("b2", "chevrons", { ouvert: true, fige: true })],
      }),
      PALETTE,
    );
    try {
      const vivant = textureDe(graphe, "faisceau:b1");
      const gele = textureDe(graphe, "faisceau:b2");
      assert.notEqual(vivant, gele, "le figé a sa propre texture : il ne suit pas le défilement du vivant");
      assert.equal(graphe.animer(1, false), true);
      assert.equal(vivant.offset.x, -((1 * VITESSE_DEFILEMENT) % 1));
      assert.equal(gele.offset.x, 0);
    } finally {
      graphe.liberer();
    }
  });

  it("rien à animer (aucun halo « travaille », aucun faisceau ouvert) : rend false sans rien bouger", () => {
    const graphe = creerGraphe(plan({ noeuds: [noeud("n1", "statique")], faisceaux: [faisceau("b1", "losanges")] }), PALETTE);
    try {
      const texture = textureDe(graphe, "faisceau:b1");
      assert.equal(graphe.animer(1.5, false), false);
      assert.equal(texture.offset.x, 0);
      assert.equal(haloDe(graphe, "n1").opacity, HALO_OPACITE_STATIQUE);
      // Le halo « travaille » suffit à relancer l'animation ; la mise à jour le remarque.
      graphe.maj(plan({ noeuds: [noeud("n1", "travaille")], faisceaux: [faisceau("b1", "losanges")] }));
      assert.equal(graphe.animer(1.5, false), true);
    } finally {
      graphe.liberer();
    }
  });
});

describe("graphe 3D : libération", () => {
  it("liberer() : dispose() exactement une fois sur chaque ressource, InstancedMesh compris, puis nombreObjets() === 0", () => {
    const graphe = creerGraphe(planComplet(), PALETTE);
    const attendues = ressources(graphe.racine);
    const mailles = objets(graphe.racine).filter((objet) => objet instanceof InstancedMesh);
    assert.equal(mailles.length, 2, "deux lots de tuiles non vides");
    const comptes = pendant(() => graphe.liberer());

    assert.equal(graphe.nombreObjets(), 0);
    for (const ressource of attendues) assert.equal(comptes.get(ressource), 1, "chaque ressource de la scène libérée une fois");
    assert.deepEqual(
      [...comptes.values()].filter((appels) => appels !== 1),
      [],
      "aucune ressource libérée deux fois",
    );
    assert.equal(comptes.size, attendues.size, "aucune ressource créée hors de la scène, aucune oubliée");
    for (const maille of mailles) assert.equal(comptes.get(maille), 1, "InstancedMesh libéré par son propre dispose()");
  });

  it("la géométrie que three partage entre tous les Sprite est libérée une seule fois (M3D-5)", () => {
    const graphe = creerGraphe(plan({ noeuds: [noeud("n1", "travaille"), noeud("n2", "statique"), noeud("n3", "travaille")] }), PALETTE);
    const partagee = porteur(parNom(graphe.racine, "noeud:n1")?.children[1] ?? graphe.racine).geometry;
    assert.ok(partagee !== undefined, "le Sprite porte une géométrie");
    assert.equal(porteur(parNom(graphe.racine, "noeud:n2")?.children[1] ?? graphe.racine).geometry, partagee, "géométrie partagée par three");
    const comptes = pendant(() => graphe.liberer());
    assert.equal(comptes.get(partagee), 1);
  });

  it("liberer() deux fois ne libère rien de plus ; maj() et animer() après liberer() ne font rien", () => {
    const graphe = creerGraphe(planComplet(), PALETTE);
    graphe.liberer();
    const comptes = pendant(() => {
      graphe.liberer();
      graphe.maj(planComplet());
    });
    assert.deepEqual([...comptes.values()], []);
    assert.equal(graphe.nombreObjets(), 0);
    assert.equal(graphe.animer(1, false), false);
  });
});

describe("graphe 3D : formes et textures générées (§5.7.1, la forme d'abord)", () => {
  const empreinte = (octets: Uint8Array) => [...octets].join(",");

  it("chaque genre de marque a son propre tracé ; chaque forme de faisceau aussi", () => {
    const marques = MARQUES.map((genre) => empreinte(octetsDuMasque(TAILLE_MARQUE, TAILLE_MARQUE, MASQUES_MARQUE[genre])));
    assert.equal(new Set(marques).size, MARQUES.length, "six marques, six tracés");
    const formes: ReadonlyArray<Plan3dBeam["forme"]> = ["fleche", "chevrons", "losanges", "pointille"];
    const motifs = formes.map((forme) => empreinte(octetsDuMasque(LARGEUR_FAISCEAU, HAUTEUR_FAISCEAU, MASQUES_FAISCEAU[forme])));
    assert.equal(new Set(motifs).size, formes.length, "quatre formes de faisceau, quatre motifs");
    for (const motif of [...marques, ...motifs]) assert.ok(motif.split(",").some((niveau) => niveau !== "0"), "aucun masque vide");
  });

  it("masque du halo : plein au centre, éteint au bord ; les octets portent le même niveau sur les quatre voies", () => {
    const octets = octetsDuMasque(8, 8, masqueHalo);
    assert.equal(octets.length, 8 * 8 * 4);
    for (let i = 0; i < octets.length; i += 4) assert.equal(new Set(octets.slice(i, i + 4)).size, 1, "masque blanc : R = V = B = A");
    const centreHaut = octets[(4 * 8 + 4) * 4] ?? 0;
    const coin = octets[0] ?? 0;
    assert.ok(centreHaut > coin, "le halo s'éteint vers le bord");
  });

  it("épaisseur des tuiles : une par état, toutes différentes ; hexagones à 6 côtés", () => {
    assert.equal(COTES_HEXAGONE, 6);
    const hauteurs = Object.values(HAUTEURS_TUILE);
    assert.equal(hauteurs.length, 4);
    assert.equal(new Set(hauteurs).size, 4, "la forme distingue les quatre états avant la couleur");
  });

  it("segments d'un tube : bornés, et plus nombreux pour une courbe plus longue", () => {
    const courte = segmentsTube(courbeFaisceau(point(0, 0, 0), point(0.2, 0.2, 0), point(0.4, 0, 0)));
    const longue = segmentsTube(courbeFaisceau(point(0, 0, 0), point(0, 20, 0), point(60, 0, 0)));
    assert.equal(courte, 12, "plancher");
    assert.equal(longue, 64, "plafond");
    assert.ok(segmentsTube(courbeFaisceau(point(0, 0, 0), point(4, 4, 0), point(8, 0, 0))) > courte);
  });
});

describe("graphe 3D : sources du dossier three/", () => {
  const lire = (nom: string) => fs.readFileSync(path.join(DOSSIER_THREE, nom), "utf8");

  it("GLSL du sol : deux constantes du module, écrites en entier, sans aucune chaîne construite à l'exécution", () => {
    const source = lire("sol.ts");
    const nuanceurs = [...source.matchAll(/export const SOL_(?:VERTEX|FRAGMENT) = `([\s\S]*?)`;/g)].map((trouve) => trouve[1] ?? "");
    assert.equal(nuanceurs.length, 2, "les deux nuanceurs sont des constantes du module");
    for (const glsl of nuanceurs) {
      assert.ok(glsl.includes("gl_Position") || glsl.includes("gl_FragColor"), "nuanceur non vide");
      assert.ok(!glsl.includes("${"), "aucune substitution de gabarit dans le GLSL");
      assert.ok(!/`\s*\+|\+\s*`/.test(glsl), "aucune concaténation dans le GLSL");
    }
    // Ce qui change d'un thème à l'autre passe par des uniformes : le texte du nuanceur ne cite aucune couleur.
    for (const glsl of nuanceurs) assert.ok(!/#[0-9A-Fa-f]{6}/.test(glsl), "aucune couleur écrite dans le GLSL");
  });

  // Les interdits (new Function, eval, import("three") dynamique, three/webgpu…) sont tenus par la garde du build et par
  // three-import.test.ts, qui sautent les commentaires ; ici, seule la forme positive est contrôlée.
  it("D-3d-05 : chaque module du graphe importe three par des noms statiques", () => {
    for (const nom of ["graphe.ts", "textures.ts", "sol.ts", "formes.ts"]) {
      assert.match(lire(nom), /^import\s*(?:type\s*)?\{[\s\S]*?\}\s*from\s*"three";$/m, `${nom} importe three par des noms`);
    }
  });
});
