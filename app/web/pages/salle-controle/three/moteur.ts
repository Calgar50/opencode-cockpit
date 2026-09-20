// Propriétaire : L29c.
// Moteur three de la salle de contrôle (itération 3 ; spécification §5.8 l.996-998, l.1009, §7.7 l.1170, JP-11, JP-13, M24, M25
// l.1293 ; plan it3 §6 « L29c », §4.1.3, D-3d-05, D-3d-17, D-3d-28 ; mesure MX-3D, M3D-1, M3D-2, M3D-5).
// `creerMoteur(canvas, options)` rend un `Moteur` (contrat figé de ../slots-3d.ts) : caméra perspective, rendu à la demande,
// boucle d'images seulement quand le plan s'anime, projection des étiquettes, translation de caméra en différé, libération
// complète. Chargé seulement par ../moteur-chargeur.ts (import dynamique) : three reste dans un morceau paresseux (D-3d-05, M24).
//
// Règles tenues ici :
// - **D-3d-05** : three s'importe par imports NOMMÉS STATIQUES, jamais par `import("three")` (MX-3D, M3D-3 : +30,8 % en gzip).
//   Le calcul de la caméra (../camera-3d.ts) et celui de la boucle (../boucle-3d.ts) vivent HORS de ce dossier, sans three : dans
//   three/, aucun fichier de la page ni aucun test ne pourrait les lire (three-import.test.ts).
// - **D-3d-17, rendu à la demande** : une image par changement de plan, 4 recalculs par seconde au plus (limiteur de
//   ../boucle-3d.ts ; le dernier plan reçu est reprogrammé, jamais perdu) ; `requestAnimationFrame` seulement ici et dans
//   ../fluidite.ts (salle3d-animations.test.ts), jamais `setInterval` ; la boucle ne tourne que si `graphe.animer()` rend vrai (ou
//   qu'une translation de caméra est en cours), sous `prefers-reduced-motion: no-preference` et la page visible ; elle s'arrête
//   dès que rien ne bouge.
// - **D-3d-28, libération volontaire ≠ perte de contexte** : `forceContextLoss()` émet `webglcontextlost`, et `dispose()` ne
//   retire que l'écouteur de three. `liberer()` pose donc le drapeau `libere` et retire SON écouteur AVANT, dans l'ordre :
//   drapeau, retrait de l'écouteur, arrêt de la boucle, `graphe.liberer()`, `renderer.dispose()`, lecture de
//   `renderer.info.memory`, `renderer.forceContextLoss()` (seul moyen de libérer les 7 objets internes de three, M3D-5), enfin la
//   marque `salle3d:memoire` avec les compteurs lus. L'écouteur ignore tout événement une fois le drapeau posé, même si son
//   retrait n'a pas pris effet : une fermeture, un changement de zoom ou un démontage ne fait JAMAIS basculer la page en 2D. Un
//   second `liberer()` ne fait rien.
// - **MX-3D, §9.3** : aucun `WebGLRenderer` ne doit être créé après un refus de `capacites()` (three écrirait un ou deux
//   `console.error`, et l'e2e exige zéro erreur de console) ; c'est la page (L31b) qui tient cette règle. Le `try` ci-dessous
//   reste pour l'imprévu : la fabrique rend alors `null`, et l'appelant passe en 2D avec « contexte-refuse ».
// - **P12** : rien n'est dessiné que le graphe (L29b) n'ait construit depuis le plan ; aucun texte, aucune heure, aucun coût.
import { PerspectiveCamera, Scene, Vector3, WebGLRenderer } from "three";
import { NEON_PALETTES, type NeonPalette } from "../../../../server/shared/neon-palette.ts";
import type { Plan3d, Plan3dCamera } from "../../../../server/shared/salle3d-types.ts";
import { creerLimiteur, doitAnimer } from "../boucle-3d.ts";
import { avancerSuivi, cadrer, creerSuivi, LOIN, positionCamera, PRES, REGLAGE_DEFAUT, type Suivi } from "../camera-3d.ts";
import type { Moteur, MoteurOptions } from "../slots-3d.ts";
import { creerGraphe, type Graphe } from "./graphe.ts";

/** Marque de performance d'une image rendue (compteur de l'e2e et de la sonde ; MX-3D, M3D-6 : une marque par image). */
export const MARQUE_SCENE = "salle3d:scene";
/** Marque de performance de la libération : compteurs de `renderer.info.memory` lus après `dispose()` (spéc. l.1170). */
export const MARQUE_MEMOIRE = "salle3d:memoire";

/** Événement de perte de contexte, écouté sur le canevas (D-3d-28). */
export const EVENEMENT_PERTE = "webglcontextlost";

/** Bornes du rapport de pixels : au-delà de 2, le coût de remplissage monte sans gain visible. */
export const RATIO_MIN = 0.5;
export const RATIO_MAX = 2;

/** Compteurs de mémoire du rendu (spéc. l.1170). */
export interface MemoireRendu {
  geometries: number;
  textures: number;
}

/** Paramètres passés à la fabrique de rendu : ceux de JP-12 (drapeau compris), rien de plus. */
export interface ParametresRendu {
  canvas: HTMLCanvasElement;
  antialias: boolean;
  failIfMajorPerformanceCaveat: boolean;
}

/**
 * Ce que le moteur demande au rendu : sous-ensemble de `WebGLRenderer`. Les tests en passent un factice (aucun DOM, aucun WebGL) ;
 * `new WebGLRenderer(...)` le satisfait sans adaptation.
 */
export interface RenduWebGL {
  setSize(largeur: number, hauteur: number, updateStyle?: boolean): void;
  setPixelRatio(valeur: number): void;
  setClearColor(couleur: string, alpha?: number): void;
  render(scene: Scene, camera: PerspectiveCamera): void;
  readonly info: { readonly memory: { readonly geometries: number; readonly textures: number } };
  /** Contexte WebGL2 obtenu ; nul ou absent : la 3D n'est pas possible et la fabrique rend `null`. */
  getContext(): unknown;
  dispose(): void;
  forceContextLoss(): void;
}

/** Fabrique du rendu : `null` ou exception (contexte refusé) → `creerMoteur` rend `null`. */
export type FabriqueRendu = (parametres: ParametresRendu) => RenduWebGL | null;

/** Contrat `CreerMoteur` de ../slots-3d.ts, plus le troisième paramètre FACULTATIF réservé aux tests. */
export type CreerMoteurTestable = (canvas: HTMLCanvasElement, options: MoteurOptions, fabriqueRendu?: FabriqueRendu) => Moteur | null;

/** Rendu réel : le seul endroit où un `WebGLRenderer` est construit (JP-12 : antialias, et refus des postes sans carte). */
const renduThree: FabriqueRendu = (parametres) => new WebGLRenderer(parametres);

/** Horloge du moteur : `performance.now()` est monotone et lue à chaque appel, jamais retenue au chargement (D-3d-18). */
const horloge = (): number => performance.now();

/** Page visible ; hors navigateur (tests Node), rien ne cache la page. */
function pageVisible(): boolean {
  return typeof document === "undefined" ? true : document.visibilityState === "visible";
}

/**
 * Demande d'image au navigateur. Hors navigateur (tests Node), il n'y en a pas : la boucle ne démarre pas, et le rendu à la
 * demande suffit. Seuls ce fichier et ../fluidite.ts peuvent citer `requestAnimationFrame` (D-3d-22).
 */
function demanderImage(rappel: (msNavigateur: number) => void): number | null {
  if (typeof requestAnimationFrame !== "function") return null;
  return requestAnimationFrame(rappel);
}

function annulerImage(jeton: number): void {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(jeton);
}

/** Marque de performance ; une marque refusée (API absente, tampon plein) n'empêche jamais le rendu. */
function marquer(nom: string, detail: object): void {
  try {
    performance.mark(nom, { detail });
  } catch {
    // Mesure seulement : sans marque, l'image reste la même.
  }
}

const borner = (valeur: number, min: number, max: number) => (Number.isFinite(valeur) ? Math.min(max, Math.max(min, valeur)) : min);

/** Compteurs de mémoire, recopiés en UNE lecture : `renderer.info.memory` est vivant, la marque en veut une photo. */
function lireMemoire(rendu: RenduWebGL): MemoireRendu {
  const { geometries, textures } = rendu.info.memory;
  return { geometries, textures };
}

/**
 * Moteur de la scène 3D. `fabriqueRendu` est réservé aux tests : par défaut, un `WebGLRenderer` demandé avec `antialias` et
 * `failIfMajorPerformanceCaveat` (JP-12). Rend `null` quand le contexte est refusé — l'appelant reste en 2D (« contexte-refuse »).
 */
export const creerMoteur: CreerMoteurTestable = (canvas, options, fabriqueRendu = renduThree) => {
  let rendu: RenduWebGL | null = null;
  try {
    rendu = fabriqueRendu({ canvas, antialias: true, failIfMajorPerformanceCaveat: true });
    // Contexte nul : rendu inutilisable ; on rend ce qui a pu être alloué avant d'abandonner.
    if (rendu !== null && rendu.getContext() == null) {
      rendu.dispose();
      rendu = null;
    }
  } catch {
    // Contexte WebGL refusé (JP-12) : aucune 3D sur ce poste.
    rendu = null;
  }
  return rendu === null ? null : moteurSurRendu(canvas, options, rendu);
};

function moteurSurRendu(canvas: HTMLCanvasElement, options: MoteurOptions, rendu: RenduWebGL): Moteur {
  const palette: NeonPalette = NEON_PALETTES[options.theme];
  const scene = new Scene();
  const camera = new PerspectiveCamera(REGLAGE_DEFAUT.fovDeg, 1, PRES, LOIN);
  const limiteur = creerLimiteur();
  const origine = horloge();
  /** Point réutilisé par `projeter` : une projection n'alloue rien (elle sert à 60 étiquettes par image, D-3d-19). */
  const projection = new Vector3();

  let graphe: Graphe | null = null;
  /** Réglage du dernier plan reçu ; sa cible est reprise par une translation (« Suivre l'action »). */
  let reglage: Plan3dCamera = REGLAGE_DEFAUT;
  let suivi: Suivi | null = null;
  let largeur = 1;
  let hauteur = 1;
  let anime = false;
  let libere = false;
  let perdu = false;
  /** Jeton de l'image demandée au navigateur ; null : aucune boucle en cours. */
  let jetonImage: number | null = null;
  /** Horodatage de l'image précédente de la boucle (horloge du navigateur) : durée passée à `onFrame`. */
  let precedente: number | null = null;
  /** Dernier plan reçu, en attente d'un recalcul retardé par le limiteur. */
  let planEnAttente: Plan3d | null = null;
  let minuterie: ReturnType<typeof setTimeout> | null = null;

  rendu.setClearColor(palette.fond, 1);

  // --- Caméra ------------------------------------------------------------------------------------------------------------------

  function appliquerCamera(): void {
    const aspect = largeur / hauteur;
    const vue = cadrer(reglage, aspect);
    const oeil = positionCamera(vue);
    camera.fov = vue.fovDeg;
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    camera.position.set(oeil.x, oeil.y, oeil.z);
    camera.lookAt(vue.cible.x, vue.cible.y, vue.cible.z);
    // `projeter` lit la matrice de la caméra sans attendre une image : elle est à jour dès maintenant.
    camera.updateMatrixWorld(true);
  }

  // --- Images -------------------------------------------------------------------------------------------------------------------

  /** Pose les valeurs de l'image à `maintenant` (caméra suivie, halo, défilement) et dit s'il reste quelque chose à animer. */
  function avancer(maintenant: number): boolean {
    let encore = false;
    if (suivi !== null) {
      const pas = avancerSuivi(suivi, maintenant);
      reglage = { ...reglage, cible: pas.cible };
      if (pas.fini) suivi = null;
      else encore = true;
      appliquerCamera();
    }
    if (graphe !== null && graphe.animer((maintenant - origine) / 1000, options.mouvementReduit)) encore = true;
    return encore;
  }

  /** Une image : rendu, marque `salle3d:scene`, puis replacement des étiquettes DOM (L29d). */
  function dessiner(): void {
    const debut = horloge();
    rendu.render(scene, camera);
    marquer(MARQUE_SCENE, { ms: horloge() - debut, anime });
    options.onImage?.();
  }

  /**
   * Image complète : valeurs de l'instant, rendu, surveillance (`ecartMs` n'est donné que depuis la boucle : JP-12 point 4, « la
   * surveillance est limitée aux images animées »), puis image suivante seulement si quelque chose bouge encore (D-3d-17).
   */
  function image(maintenant: number, ecartMs: number | null): void {
    anime = avancer(maintenant);
    dessiner();
    if (ecartMs !== null) options.onFrame?.(ecartMs, anime);
    if (doitAnimer({ anime, mouvementReduit: options.mouvementReduit, visible: pageVisible() })) demarrerBoucle();
    else arreterBoucle();
  }

  const surImage = (msNavigateur: number): void => {
    jetonImage = null;
    if (libere || perdu) return;
    const ecart = precedente === null ? 0 : Math.max(0, msNavigateur - precedente);
    precedente = msNavigateur;
    image(horloge(), ecart);
  };

  function demarrerBoucle(): void {
    if (jetonImage !== null || libere || perdu) return;
    jetonImage = demanderImage(surImage);
  }

  function arreterBoucle(): void {
    if (jetonImage !== null) annulerImage(jetonImage);
    jetonImage = null;
    precedente = null;
  }

  // --- Plans (rendu à la demande, 4 recalculs par seconde au plus) --------------------------------------------------------------

  function appliquerPlan(maintenant: number): void {
    const plan = planEnAttente;
    if (plan === null) return;
    planEnAttente = null;
    limiteur.marquer(maintenant);
    if (graphe === null) {
      graphe = creerGraphe(plan, palette);
      scene.add(graphe.racine);
    } else {
      graphe.maj(plan);
    }
    // Une translation en cours garde la main sur la cible : le plan ne la ramène pas en arrière.
    reglage = suivi === null ? plan.camera : { ...plan.camera, cible: reglage.cible };
    appliquerCamera();
    image(maintenant, null);
  }

  function programmerPlan(attenteMs: number): void {
    if (minuterie !== null) return;
    minuterie = setTimeout(() => {
      minuterie = null;
      if (libere || perdu || planEnAttente === null) return;
      appliquerPlan(horloge());
    }, attenteMs);
  }

  function annulerProgramme(): void {
    if (minuterie !== null) clearTimeout(minuterie);
    minuterie = null;
    planEnAttente = null;
  }

  // --- Perte de contexte (D-3d-28) ------------------------------------------------------------------------------------------------

  /**
   * Perte NON demandée : la page passe en 2D. Après `liberer()` (drapeau `libere`), l'événement émis par `forceContextLoss()` est
   * ignoré, même si le retrait de l'écouteur n'a pas pris effet : une libération volontaire ne bascule jamais en 2D. L'échec n'est
   * annoncé qu'une fois.
   */
  const surPerte = (): void => {
    if (libere || perdu) return;
    perdu = true;
    arreterBoucle();
    annulerProgramme();
    options.onEchec("contexte-perdu");
  };

  canvas.addEventListener(EVENEMENT_PERTE, surPerte);

  // --- Interface ------------------------------------------------------------------------------------------------------------------

  return {
    afficher(plan) {
      if (libere || perdu) return;
      planEnAttente = plan;
      const maintenant = horloge();
      const attente = limiteur.attente(maintenant);
      if (attente <= 0) appliquerPlan(maintenant);
      else programmerPlan(attente);
    },

    /** Sonde de fluidité (L30) : une image forcée, sans démarrer la boucle (la sonde demande ses images elle-même). */
    renderFrame() {
      if (libere || perdu) return;
      anime = avancer(horloge());
      dessiner();
    },

    suivre(cible, ms) {
      if (libere || perdu) return;
      const maintenant = horloge();
      // Mouvement réduit : la caméra se pose sur la cible sans translation (JP-13).
      suivi = creerSuivi(reglage.cible, cible, maintenant, options.mouvementReduit ? 0 : ms);
      if (suivi === null) {
        reglage = { ...reglage, cible };
        appliquerCamera();
      }
      image(maintenant, null);
    },

    projeter(p) {
      projection.set(p.x, p.y, p.z).project(camera);
      const { x, y, z } = projection;
      return { x: ((x + 1) / 2) * largeur, y: ((1 - y) / 2) * hauteur, visible: z <= 1 && x >= -1 && x <= 1 && y >= -1 && y <= 1 };
    },

    redimensionner(l, h, ratio) {
      if (libere || perdu) return;
      largeur = Math.max(1, Math.floor(Number.isFinite(l) ? l : 1));
      hauteur = Math.max(1, Math.floor(Number.isFinite(h) ? h : 1));
      rendu.setPixelRatio(borner(ratio, RATIO_MIN, RATIO_MAX));
      rendu.setSize(largeur, hauteur, false);
      appliquerCamera();
      if (graphe !== null) dessiner();
    },

    info: () => lireMemoire(rendu),

    /** Libération volontaire, dans l'ordre de D-3d-28 ; un second appel ne fait rien. */
    liberer() {
      if (libere) return;
      libere = true;
      canvas.removeEventListener(EVENEMENT_PERTE, surPerte);
      arreterBoucle();
      annulerProgramme();
      graphe?.liberer();
      graphe = null;
      rendu.dispose();
      const memoire = lireMemoire(rendu);
      rendu.forceContextLoss();
      marquer(MARQUE_MEMOIRE, memoire);
    },
  };
}
