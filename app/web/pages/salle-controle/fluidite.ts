// Fluidité de la salle de contrôle, côté navigateur (spécification §5.8 l.1003-1008, JP-12 ; plan it3, fiche L30, D-3d-18,
// D-3d-22, D-3d-25) : adaptateur mince du module pur server/shared/fluidity.ts.
// - capacites() : réglages d'accessibilité (matchMedia) et contexte webgl2 d'un canevas jetable, demandé avec
//   failIfMajorPerformanceCaveat: true puis relâché par WEBGL_lose_context ; nom du moteur de rendu par WEBGL_debug_renderer_info
//   s'il existe. Refusé avec ce drapeau, le contexte est redemandé sans lui (second canevas jetable, relâché aussi) : obtenu, le
//   poste dessine sans carte graphique (« rendu-logiciel ») ; refusé encore, la 3D n'existe pas dans ce navigateur (« webgl-absent ») ;
// - sonder() : sonde forcée de 90 images, bornée à 90 appels à `raf` ; l'horloge (`performance.now`) est lue à chaque appel, jamais
//   retenue au chargement du module, pour que l'horloge du « moteur simulé » de l'e2e s'applique (D-3d-18) ; une seule lecture
//   par image, plus une au départ ;
// - creerSurveillance() : surveiller() avec son état ;
// - preferenceLocale() et enregistrerPreference() : localStorage toujours en try/catch (D-3d-25) ;
// - marquerBascule() : marque de performance « salle3d:bascule » avec {detail: {raison}}, à chaque passage en 2D (D-3d-18).
// Seul fichier de l'interface, avec three/moteur.ts, qui demande des images au navigateur (D-3d-22) : la sonde s'arrête d'elle-même
// après 90 images, et aucune minuterie répétée n'existe ici. Aucun texte affiché.
import {
  type ActionSurveillance,
  type CapacitesNavigateur,
  ecrirePreference,
  type EtatSurveillance,
  FLUIDITE,
  type FluidityReason,
  lirePreference,
  PREFERENCE_CLE,
  type Preference,
  type PreferenceChoix,
  SURVEILLANCE_INITIALE,
  surveiller,
} from "../../../server/shared/fluidity.ts";

/** Nom de la marque de performance d'un passage en 2D (D-3d-18). */
export const MARQUE_BASCULE = "salle3d:bascule";

/** Longueur gardée du nom du moteur de rendu (chaîne donnée par le pilote). */
export const MOTEUR_MAX = 256;

/** Sous-ensemble du contexte webgl2 lu par capacites(). */
export interface ContexteEssai {
  getExtension(nom: "WEBGL_lose_context"): { loseContext(): void } | null;
  getExtension(nom: "WEBGL_debug_renderer_info"): { readonly UNMASKED_RENDERER_WEBGL: number } | null;
  getParameter(parametre: number): unknown;
}

/** Canevas jetable (HTMLCanvasElement dans le navigateur). */
export interface CanevasEssai {
  getContext(type: "webgl2", options?: WebGLContextAttributes): ContexteEssai | null;
}

/** Ce que capacites() interroge ; remplacé dans les tests. */
export interface EnvironnementCapacites {
  /** `matchMedia(requete).matches`. */
  media(requete: string): boolean;
  canevas(): CanevasEssai;
}

function environnementNavigateur(): EnvironnementCapacites {
  return {
    media: (requete) => window.matchMedia(requete).matches,
    canevas: () => document.createElement("canvas"),
  };
}

/** Requêtes média des deux réglages d'accessibilité (écrites sans espace : ce sont des codes, pas des textes). */
export const REQUETE_MOUVEMENT_REDUIT = "(prefers-reduced-motion:reduce)";
export const REQUETE_COULEURS_FORCEES = "(forced-colors:active)";

function mediaActif(environnement: EnvironnementCapacites, requete: string): boolean {
  try {
    return environnement.media(requete);
  } catch {
    return false;
  }
}

/** Un essai de contexte webgl2 sur un canevas jetable ; le contexte obtenu est toujours relâché. */
function essayerContexte(environnement: EnvironnementCapacites, failIfMajorPerformanceCaveat: boolean): { obtenu: boolean; moteur: string | null } {
  let contexte: ContexteEssai | null;
  try {
    contexte = environnement.canevas().getContext("webgl2", { failIfMajorPerformanceCaveat });
  } catch {
    contexte = null;
  }
  if (contexte === null) return { obtenu: false, moteur: null };
  let moteur: string | null = null;
  try {
    const info = contexte.getExtension("WEBGL_debug_renderer_info");
    const nom = info === null ? null : contexte.getParameter(info.UNMASKED_RENDERER_WEBGL);
    moteur = typeof nom === "string" ? nom.slice(0, MOTEUR_MAX) : null;
  } catch {
    moteur = null;
  }
  try {
    contexte.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    // Contexte déjà perdu : rien à relâcher.
  }
  return { obtenu: true, moteur };
}

/** Capacités du poste pour verdictCapacites (préférence exceptée : preferenceLocale). */
export function capacites(environnement: EnvironnementCapacites = environnementNavigateur()): CapacitesNavigateur {
  const mouvementReduit = mediaActif(environnement, REQUETE_MOUVEMENT_REDUIT);
  const couleursForcees = mediaActif(environnement, REQUETE_COULEURS_FORCEES);
  const avecDrapeau = essayerContexte(environnement, true);
  if (avecDrapeau.obtenu) return { mouvementReduit, couleursForcees, webgl2: true, contexteRefuse: false, moteur: avecDrapeau.moteur };
  const sansDrapeau = essayerContexte(environnement, false);
  return { mouvementReduit, couleursForcees, webgl2: sansDrapeau.obtenu, contexteRefuse: true, moteur: sansDrapeau.moteur };
}

/**
 * Sonde forcée : `renderFrame` est appelée à chacune des 90 images demandées par `raf`, puis la durée de l'image est mesurée
 * (heure après le rendu, moins celle de l'image précédente ; départ = heure de l'appel). Exactement 90 appels à `raf` et 90
 * mesures ; une erreur de `renderFrame` ou de `raf` rejette la promesse et arrête la sonde.
 */
export function sonder(
  renderFrame: () => void,
  raf: (rappel: FrameRequestCallback) => number = requestAnimationFrame,
  now: () => number = () => performance.now(),
): Promise<number[]> {
  const total = FLUIDITE.sonde.images;
  return new Promise((resolve, reject) => {
    const mesures: number[] = [];
    let precedente = now();
    const image = (): void => {
      try {
        renderFrame();
        const instant = now();
        mesures.push(instant - precedente);
        precedente = instant;
        if (mesures.length < total) raf(image);
        else resolve(mesures);
      } catch (erreur) {
        reject(erreur);
      }
    };
    raf(image);
  });
}

export interface Surveillance {
  /** Une image rendue en 3D : durée (ms) et animation ; rend l'action à mener. */
  image(ms: number, anime: boolean): ActionSurveillance;
  etat(): EtatSurveillance;
  reinitialiser(): void;
}

/** Surveillance des images animées (surveiller), horloge lue à chaque image animée. */
export function creerSurveillance(now: () => number = () => performance.now()): Surveillance {
  let etat = SURVEILLANCE_INITIALE;
  return {
    image(ms, anime) {
      if (!anime) return "rien";
      const suite = surveiller(etat, { ms, anime, now: now() });
      etat = suite.etat;
      return suite.action;
    },
    etat: () => etat,
    reinitialiser() {
      etat = SURVEILLANCE_INITIALE;
    },
  };
}

/** Stockage du poste (window.localStorage dans le navigateur). */
export type StockagePoste = Pick<Storage, "getItem" | "setItem">;

const stockageNavigateur = (): StockagePoste => window.localStorage;

/** Préférence gardée pour ce poste ; stockage indisponible ou valeur illisible : auto. */
export function preferenceLocale(stockage: () => StockagePoste = stockageNavigateur): Preference {
  try {
    return lirePreference(stockage().getItem(PREFERENCE_CLE));
  } catch {
    return lirePreference(null);
  }
}

/** Écrit la préférence du poste ; rend false si le stockage est indisponible (navigation privée, quota), sans lever. */
export function enregistrerPreference(
  choix: PreferenceChoix,
  raison: FluidityReason | null,
  le: number = Date.now(),
  stockage: () => StockagePoste = stockageNavigateur,
): boolean {
  try {
    stockage().setItem(PREFERENCE_CLE, ecrirePreference(choix, raison, le));
    return true;
  } catch {
    // Stockage indisponible : préférence non mémorisée, l'affichage suit quand même le choix.
    return false;
  }
}

/** Marque « salle3d:bascule » d'un passage en 2D (compteur de l'e2e, D-3d-18) ; une marque refusée n'empêche jamais la 2D. */
export function marquerBascule(raison: FluidityReason): void {
  try {
    performance.mark(MARQUE_BASCULE, { detail: { raison } });
  } catch {
    // Mesure seulement : sans marque, l'affichage 2D reste le même.
  }
}
