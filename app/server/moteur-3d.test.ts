// Moteur three de la salle de contrôle (itération 3, L29c ; spécification §5.8 l.996-998, §7.7 l.1170 ; plan it3 §6 « L29c »,
// §4.1.3, D-3d-17, D-3d-28 ; mesure MX-3D, M3D-5 et M3D-7).
// Tout se joue en Node : le graphe est construit par le VRAI three (M3D-7 : hors `WebGLRenderer`, tout se crée et se libère sans
// document), le rendu est FACTICE (troisième paramètre `fabriqueRendu`, réservé aux tests) et le canevas est un `EventTarget` de
// Node. La partie navigateur (contexte WebGL réel, violations de CSP, compteurs d'objets WebGL) est jouée en e2e par L35.
//
// Ce que ces contrôles pincent (D-3d-28, risque 7 bis du plan) : `forceContextLoss()` émet `webglcontextlost`, et
// `renderer.dispose()` ne retire que l'écouteur de three. Sans le drapeau `libere` du moteur, une fermeture, un changement de zoom
// ou un démontage ferait basculer la page en 2D. Deux gardes indépendantes sont donc exigées, et chacune a son contrôle : le
// RETRAIT de l'écouteur, et le DRAPEAU (qui protège même quand le retrait n'a pas pris effet, canevas remplacé ou `EventTarget`
// dégradé). Le canevas « sans retrait » de ce fichier est le contrôle discriminant du drapeau : sans lui, il échoue.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BufferGeometry } from "three";
import { PERIODE_HALO_S } from "../web/pages/salle-controle/boucle-3d.ts";
import { PERIODE_HALO_S as PERIODE_HALO_GRAPHE } from "../web/pages/salle-controle/three/graphe.ts";
import {
  creerMoteur,
  EVENEMENT_PERTE,
  type FabriqueRendu,
  MARQUE_MEMOIRE,
  MARQUE_SCENE,
  type MemoireRendu,
  type ParametresRendu,
  RATIO_MAX,
  RATIO_MIN,
  type RenduWebGL,
} from "../web/pages/salle-controle/three/moteur.ts";
import type { Moteur, MoteurOptions } from "../web/pages/salle-controle/slots-3d.ts";
import type { Plan3d, Plan3dNode, Point3 } from "./shared/salle3d-types.ts";

const point = (x: number, y: number, z: number): Point3 => ({ x, y, z });

const noeud = (id: string, halo: Plan3dNode["halo"]): Plan3dNode => ({
  id,
  parentId: null,
  role: "conversation",
  secteur: null,
  position: point(0, 0.6, 0),
  etat: halo === "travaille" ? "travaille" : "termine",
  halo,
  nom: null,
  faits: [0],
});

function plan(parties: Partial<Plan3d> = {}): Plan3d {
  return {
    zoom: 2,
    theme: "sombre",
    mode: "avance",
    rootId: "ses_racine",
    focus: null,
    stations: [{ id: "vous", position: point(0, 0.4, 6) }],
    territoires: [],
    noeuds: [noeud("n1", "statique")],
    faisceaux: [],
    marques: [],
    tuiles: [],
    etiquettes: [],
    camera: { cible: point(0, 0, 0), distance: 15, inclinaisonDeg: 55, fovDeg: 35 },
    anime: false,
    enceinte: null,
    carnetVide: true,
    ...parties,
  };
}

// --- Canevas factice (EventTarget de Node) --------------------------------------------------------------------------------------

interface CanevasFactice {
  element: HTMLCanvasElement;
  /** Ajouts et retraits d'écouteurs, dans l'ordre. */
  journal: string[];
  /** Nombre d'écouteurs encore posés (0 quand le retrait a pris effet). */
  poses(): number;
  perdreContexte(): void;
}

/**
 * Canevas d'essai. `retrait: false` : `removeEventListener` est noté mais ne fait rien — c'est le cas dégradé qui rend le drapeau
 * `libere` du moteur indispensable.
 */
function creerCanevas(options: { retrait?: boolean } = {}): CanevasFactice {
  const cible = new EventTarget();
  const journal: string[] = [];
  let poses = 0;
  const element = {
    addEventListener(type: string, ecouteur: EventListener) {
      journal.push(`ajout:${type}`);
      poses += 1;
      cible.addEventListener(type, ecouteur);
    },
    removeEventListener(type: string, ecouteur: EventListener) {
      journal.push(`retrait:${type}`);
      if (options.retrait === false) return;
      poses -= 1;
      cible.removeEventListener(type, ecouteur);
    },
  } as unknown as HTMLCanvasElement;
  return { element, journal, poses: () => poses, perdreContexte: () => void cible.dispatchEvent(new Event(EVENEMENT_PERTE)) };
}

// --- Rendu factice --------------------------------------------------------------------------------------------------------------

/** Compteurs de `renderer.info.memory` aux trois étapes de M3D-5 : en service, après `dispose()`, après la perte du contexte. */
const MEMOIRE_EN_SERVICE: MemoireRendu = { geometries: 12, textures: 5 };
const MEMOIRE_APRES_DISPOSE: MemoireRendu = { geometries: 7, textures: 3 };
const MEMOIRE_CONTEXTE_PERDU: MemoireRendu = { geometries: 0, textures: 0 };

interface RenduFactice extends RenduWebGL {
  /** Appels reçus, dans l'ordre (« render » compris). */
  journal: string[];
  parametres: ParametresRendu | null;
  images: number;
  tailles: Array<{ largeur: number; hauteur: number }>;
  ratios: number[];
}

interface OptionsRendu {
  /** Canevas dont `forceContextLoss()` émet `webglcontextlost`, comme le vrai WEBGL_lose_context (D-3d-28). */
  canevas?: CanevasFactice;
  /** « tout de suite » (synchrone) ou « apres-attente » (au prochain tour de boucle d'événements). */
  emission?: "tout-de-suite" | "apres-attente" | "jamais";
  /** Contexte rendu par `getContext()` ; `null` : la fabrique doit abandonner. */
  contexte?: unknown;
}

function creerRendu(options: OptionsRendu = {}): { rendu: RenduFactice; fabrique: FabriqueRendu; attendreEmission: () => Promise<void> } {
  let memoire: MemoireRendu = MEMOIRE_EN_SERVICE;
  let differee: Promise<void> = Promise.resolve();
  const rendu: RenduFactice = {
    journal: [],
    parametres: null,
    images: 0,
    tailles: [],
    ratios: [],
    setSize(largeur, hauteur) {
      rendu.journal.push("setSize");
      rendu.tailles.push({ largeur, hauteur });
    },
    setPixelRatio(valeur) {
      rendu.journal.push("setPixelRatio");
      rendu.ratios.push(valeur);
    },
    setClearColor() {
      rendu.journal.push("setClearColor");
    },
    render() {
      rendu.journal.push("render");
      rendu.images += 1;
    },
    get info() {
      rendu.journal.push("info");
      return { memory: memoire };
    },
    getContext: () => ("contexte" in options ? options.contexte : {}),
    dispose() {
      rendu.journal.push("dispose");
      memoire = MEMOIRE_APRES_DISPOSE;
    },
    forceContextLoss() {
      rendu.journal.push("forceContextLoss");
      memoire = MEMOIRE_CONTEXTE_PERDU;
      const emettre = () => options.canevas?.perdreContexte();
      if (options.emission === "apres-attente") differee = new Promise<void>((resoudre) => setTimeout(() => (emettre(), resoudre()), 0));
      else if (options.emission !== "jamais") emettre();
    },
  };
  const fabrique: FabriqueRendu = (parametres) => {
    rendu.parametres = parametres;
    rendu.journal.push("fabrique");
    return rendu;
  };
  return { rendu, fabrique, attendreEmission: () => differee };
}

// --- Montage --------------------------------------------------------------------------------------------------------------------

interface Banc {
  moteur: Moteur;
  rendu: RenduFactice;
  canevas: CanevasFactice;
  echecs: Array<"contexte-perdu">;
  images: number;
  attendreEmission: () => Promise<void>;
}

function monter(options: OptionsRendu & { canevasSansRetrait?: boolean; moteur?: Partial<MoteurOptions> } = {}): Banc {
  const canevas = creerCanevas({ retrait: options.canevasSansRetrait === true ? false : true });
  const { rendu, fabrique, attendreEmission } = creerRendu({ ...options, canevas });
  const echecs: Array<"contexte-perdu"> = [];
  const banc: Banc = { moteur: null as unknown as Moteur, rendu, canevas, echecs, images: 0, attendreEmission };
  const moteur = creerMoteur(
    canevas.element,
    {
      theme: "sombre",
      mouvementReduit: false,
      onEchec: (raison) => echecs.push(raison),
      onImage: () => {
        banc.images += 1;
      },
      ...options.moteur,
    },
    fabrique,
  );
  assert.notEqual(moteur, null, "le rendu factice accepte le contexte : le moteur existe");
  banc.moteur = moteur as Moteur;
  return banc;
}

/** Détail d'une marque de performance, la dernière émise sous ce nom. */
function detailMarque(nom: string): Record<string, number> | null {
  const entrees = performance.getEntriesByName(nom, "mark");
  const derniere = entrees.at(-1) as { detail?: unknown } | undefined;
  return derniere === undefined ? null : ((derniere.detail ?? null) as Record<string, number> | null);
}

const nettoyerMarques = () => {
  performance.clearMarks(MARQUE_SCENE);
  performance.clearMarks(MARQUE_MEMOIRE);
};

// --- Création ------------------------------------------------------------------------------------------------------------------------

describe("moteur-3d : création (JP-12)", () => {
  it("le rendu est demandé avec antialias et failIfMajorPerformanceCaveat, sur le canevas donné", () => {
    const banc = monter();
    assert.deepEqual(banc.rendu.parametres, { canvas: banc.canevas.element, antialias: true, failIfMajorPerformanceCaveat: true });
    assert.deepEqual(banc.canevas.journal, [`ajout:${EVENEMENT_PERTE}`]);
    banc.moteur.liberer();
  });

  it("fabrique qui lève, qui rend null, ou contexte nul : aucun moteur, et le rendu entamé est rendu", () => {
    const canevas = creerCanevas();
    const options: MoteurOptions = { theme: "sombre", mouvementReduit: false, onEchec: () => assert.fail("aucun échec à la création") };
    assert.equal(
      creerMoteur(canevas.element, options, () => {
        throw new Error("contexte refusé");
      }),
      null,
    );
    assert.equal(creerMoteur(canevas.element, options, () => null), null);
    const { rendu, fabrique } = creerRendu({ contexte: null });
    assert.equal(creerMoteur(canevas.element, options, fabrique), null);
    assert.ok(rendu.journal.includes("dispose"), "un rendu sans contexte est libéré avant d'abandonner");
    assert.deepEqual(canevas.journal, [], "aucun écouteur posé quand il n'y a pas de moteur");
  });
});

// --- Rendu à la demande ------------------------------------------------------------------------------------------------------------

describe("moteur-3d : rendu à la demande (D-3d-17)", () => {
  it("afficher() construit le graphe, rend une image, marque « salle3d:scene » et replace les étiquettes", () => {
    nettoyerMarques();
    const banc = monter();
    assert.equal(banc.rendu.images, 0, "aucune image avant le premier plan");
    banc.moteur.afficher(plan());
    assert.equal(banc.rendu.images, 1);
    assert.equal(banc.images, 1, "onImage appelé après l'image");
    assert.ok(performance.getEntriesByName(MARQUE_SCENE, "mark").length >= 1);
    assert.equal(typeof detailMarque(MARQUE_SCENE)?.ms, "number");
    banc.moteur.liberer();
    nettoyerMarques();
  });

  it("renderFrame() (sonde de L30) rend une image de plus, sans nouveau plan", () => {
    const banc = monter();
    banc.moteur.afficher(plan());
    const avant = banc.rendu.images;
    banc.moteur.renderFrame();
    banc.moteur.renderFrame();
    assert.equal(banc.rendu.images, avant + 2);
    banc.moteur.liberer();
  });

  it("redimensionner() borne le rapport de pixels, pose la taille sans toucher au style, et redessine", () => {
    const banc = monter();
    banc.moteur.afficher(plan());
    const avant = banc.rendu.images;
    banc.moteur.redimensionner(1280, 720, 4);
    banc.moteur.redimensionner(800, 600, 0.1);
    assert.deepEqual(banc.rendu.tailles, [
      { largeur: 1280, hauteur: 720 },
      { largeur: 800, hauteur: 600 },
    ]);
    assert.deepEqual(banc.rendu.ratios, [RATIO_MAX, RATIO_MIN]);
    assert.equal(banc.rendu.images, avant + 2);
    banc.moteur.liberer();
  });

  it("projeter() rend des coordonnées d'écran (L29d) : le centre de la scène au milieu du cadre, un point derrière la caméra invisible", () => {
    const banc = monter();
    banc.moteur.afficher(plan());
    banc.moteur.redimensionner(1000, 500, 1);
    const centre = banc.moteur.projeter(point(0, 0, 0));
    assert.equal(centre.visible, true);
    assert.ok(Math.abs(centre.x - 500) < 1, `x ${centre.x}`);
    assert.ok(Math.abs(centre.y - 250) < 1, `y ${centre.y}`);
    const gauche = banc.moteur.projeter(point(-3, 0, 0));
    assert.ok(gauche.x < centre.x, "un point à gauche se projette à gauche");
    assert.equal(banc.moteur.projeter(point(0, 0, 500)).visible, false, "derrière la caméra : masqué");
    banc.moteur.liberer();
  });

  it("« Suivre l'action » : la caméra rejoint la cible, et le mouvement réduit l'y pose d'un coup (JP-13)", async () => {
    const cible = point(6, 0, 0);
    const banc = monter();
    banc.moteur.afficher(plan());
    banc.moteur.redimensionner(1000, 500, 1);
    const avant = banc.moteur.projeter(cible);
    assert.ok(Math.abs(avant.x - 500) > 50, `la cible n'est pas déjà au centre : x ${avant.x}`);
    banc.moteur.suivre(cible, 20);
    assert.ok(Math.abs(banc.moteur.projeter(cible).x - 500) > 50, "la translation commence au point de départ");
    // Hors navigateur, aucune image ne vient d'elle-même : la sonde en demande une, la translation avance avec l'horloge.
    await new Promise((suite) => setTimeout(suite, 40));
    banc.moteur.renderFrame();
    const apres = banc.moteur.projeter(cible);
    assert.ok(Math.abs(apres.x - 500) < 1, `la caméra regarde la cible : x ${apres.x}`);
    banc.moteur.liberer();

    const reduit = monter({ moteur: { mouvementReduit: true } });
    reduit.moteur.afficher(plan());
    reduit.moteur.redimensionner(1000, 500, 1);
    reduit.moteur.suivre(cible, 800);
    const arrivee = reduit.moteur.projeter(cible);
    assert.ok(Math.abs(arrivee.x - 500) < 1, `la cible est au centre tout de suite : x ${arrivee.x}`);
    reduit.moteur.liberer();
  });

  it("au plus 4 recalculs par seconde : une rafale de plans ne rend pas une image par plan", () => {
    const banc = monter();
    for (let i = 0; i < 40; i++) banc.moteur.afficher(plan({ rootId: `ses_${i}` }));
    assert.equal(banc.rendu.images, 1, "les plans suivants sont retardés, pas rendus");
    banc.moteur.liberer();
  });

  it("la période du halo est la même ici et dans le graphe (un cycle par 2 s)", () => {
    assert.equal(PERIODE_HALO_S, PERIODE_HALO_GRAPHE);
  });
});

// --- Perte de contexte et libération (D-3d-28) -----------------------------------------------------------------------------------

describe("moteur-3d : perte de contexte non demandée (D-3d-28)", () => {
  it("une perte émise AVANT liberer() appelle onEchec(« contexte-perdu ») une fois", () => {
    const banc = monter();
    banc.moteur.afficher(plan());
    banc.canevas.perdreContexte();
    banc.canevas.perdreContexte();
    assert.deepEqual(banc.echecs, ["contexte-perdu"]);
    banc.moteur.liberer();
    assert.deepEqual(banc.echecs, ["contexte-perdu"], "la libération qui suit n'ajoute rien");
  });

  it("après une perte, plus aucune image n'est rendue (le contexte n'existe plus)", () => {
    const banc = monter();
    banc.moteur.afficher(plan());
    const avant = banc.rendu.images;
    banc.canevas.perdreContexte();
    banc.moteur.renderFrame();
    banc.moteur.redimensionner(640, 480, 1);
    assert.equal(banc.rendu.images, avant);
    banc.moteur.liberer();

    // Premier plan reçu APRÈS la perte, limiteur au repos : sans la garde, il serait dessiné tout de suite.
    const neuf = monter();
    neuf.canevas.perdreContexte();
    neuf.moteur.afficher(plan());
    assert.equal(neuf.rendu.images, 0);
    neuf.moteur.liberer();
  });
});

describe("moteur-3d : liberer() (D-3d-28)", () => {
  for (const emission of ["tout-de-suite", "apres-attente"] as const) {
    for (const retrait of [true, false]) {
      const cas = `${emission}, retrait de l'écouteur ${retrait ? "effectif" : "sans effet (drapeau seul)"}`;
      it(`liberer() n'appelle JAMAIS onEchec : ${cas}`, async () => {
        const banc = monter({ emission, canevasSansRetrait: !retrait });
        banc.moteur.afficher(plan({ noeuds: [noeud("n1", "travaille")], anime: true }));
        banc.moteur.liberer();
        await banc.attendreEmission();
        assert.deepEqual(banc.echecs, [], "une libération volontaire ne bascule jamais en 2D");
        assert.ok(banc.canevas.journal.includes(`retrait:${EVENEMENT_PERTE}`), "l'écouteur du moteur est retiré");
        assert.equal(banc.canevas.poses(), retrait ? 0 : 1);
      });
    }
  }

  it("ordre de D-3d-28 : écouteur retiré, graphe libéré, dispose(), lecture des compteurs, forceContextLoss()", () => {
    const banc = monter({ emission: "tout-de-suite" });
    banc.moteur.afficher(plan({ noeuds: [noeud("n1", "travaille")], anime: true }));
    // Espion sur les géométries de three : le graphe les libère avant que le rendu ne soit jeté (M3D-5).
    const dispose = BufferGeometry.prototype.dispose;
    let geometriesLiberees = 0;
    BufferGeometry.prototype.dispose = function espion(this: BufferGeometry) {
      geometriesLiberees += 1;
      if (geometriesLiberees === 1) banc.rendu.journal.push("graphe");
      return dispose.call(this);
    };
    try {
      banc.moteur.liberer();
    } finally {
      BufferGeometry.prototype.dispose = dispose;
    }
    assert.ok(geometriesLiberees > 0, "le graphe a libéré ses géométries");
    const etapes = banc.rendu.journal.filter((appel) => appel === "graphe" || appel === "dispose" || appel === "info" || appel === "forceContextLoss");
    assert.deepEqual(etapes, ["graphe", "dispose", "info", "forceContextLoss"]);
    assert.equal(banc.canevas.journal.indexOf(`retrait:${EVENEMENT_PERTE}`), 1, "le retrait suit l'ajout, et rien d'autre ne touche aux écouteurs");
  });

  it("« salle3d:memoire » porte les compteurs lus APRÈS dispose() et AVANT forceContextLoss()", () => {
    nettoyerMarques();
    const banc = monter({ emission: "tout-de-suite" });
    banc.moteur.afficher(plan());
    assert.deepEqual(banc.moteur.info(), MEMOIRE_EN_SERVICE);
    banc.moteur.liberer();
    assert.deepEqual(detailMarque(MARQUE_MEMOIRE), MEMOIRE_APRES_DISPOSE);
    assert.notDeepEqual(MEMOIRE_APRES_DISPOSE, MEMOIRE_EN_SERVICE);
    assert.notDeepEqual(MEMOIRE_APRES_DISPOSE, MEMOIRE_CONTEXTE_PERDU);
    assert.deepEqual(banc.moteur.info(), MEMOIRE_CONTEXTE_PERDU, "après la perte du contexte, tout est libéré avec lui");
    nettoyerMarques();
  });

  it("second liberer() : sans effet (ni dispose, ni forceContextLoss, ni marque de plus)", () => {
    nettoyerMarques();
    const banc = monter({ emission: "tout-de-suite" });
    banc.moteur.afficher(plan());
    banc.moteur.liberer();
    const journal = [...banc.rendu.journal];
    const marques = performance.getEntriesByName(MARQUE_MEMOIRE, "mark").length;
    banc.moteur.liberer();
    banc.moteur.liberer();
    assert.deepEqual(banc.rendu.journal, journal);
    assert.equal(performance.getEntriesByName(MARQUE_MEMOIRE, "mark").length, marques);
    assert.deepEqual(banc.echecs, []);
    nettoyerMarques();
  });

  it("après liberer(), plus rien n'est dessiné (plan, sonde, redimensionnement, suivi)", () => {
    const banc = monter({ emission: "tout-de-suite" });
    banc.moteur.afficher(plan());
    banc.moteur.liberer();
    const images = banc.rendu.images;
    banc.moteur.afficher(plan({ rootId: "ses_apres" }));
    banc.moteur.renderFrame();
    banc.moteur.redimensionner(640, 480, 1);
    banc.moteur.suivre(point(1, 0, 1), 500);
    assert.equal(banc.rendu.images, images);
    assert.deepEqual(banc.echecs, []);
  });
});
