// Boucle d'images de la salle de contrôle 3D (itération 3, L29c ; spécification §5.8 l.995-997, JP-13 ; plan it3 §6 « L29c »,
// D-3d-17 : « rendu à la demande », « la boucle ne tourne que si quelque chose s'anime », « au plus 4 recalculs du plan par
// seconde », « halo pulsé : un cycle par 2 s »).
// Module PUR, placé HORS de three/ (three/moteur.ts et les tests le lisent ; dans three/, aucun fichier hors de ce dossier ne
// pourrait l'importer, three-import.test.ts). Aucun `requestAnimationFrame`, aucune minuterie, aucune horloge propre : l'instant
// est toujours donné en paramètre, et c'est le moteur qui demande les images. Aucun texte.

/** Halo « travaille » : un cycle par 2 s (spéc. l.996) ; même période que le graphe (three/graphe.ts, `PERIODE_HALO_S`). */
export const PERIODE_HALO_S = 2;

/** Recalculs du plan : 4 par seconde au plus (D-3d-17), soit 250 ms entre deux. */
export const RECALCULS_PAR_SECONDE = 4;
export const INTERVALLE_RECALCUL_MS = 1000 / RECALCULS_PAR_SECONDE;

/** Ce qui décide qu'une image suivante est demandée. */
export interface EtatBoucle {
  /** Quelque chose bouge encore : halo « travaille », faisceau ouvert, translation de caméra en cours. */
  anime: boolean;
  /** `prefers-reduced-motion: reduce` : aucune animation, jamais (JP-13, §5.8 l.1004). */
  mouvementReduit: boolean;
  /** Page visible : un onglet caché ne reçoit plus d'image (MX-3D, M3D-4), inutile d'en demander. */
  visible: boolean;
}

/**
 * Faut-il demander une image de plus ? Seulement si quelque chose s'anime, sous `prefers-reduced-motion: no-preference`, et la
 * page visible. Dès que la réponse est fausse, la boucle s'arrête : le reste du temps, une image n'est rendue qu'à la demande
 * (changement de plan, redimensionnement, sonde).
 */
export function doitAnimer({ anime, mouvementReduit, visible }: EtatBoucle): boolean {
  return anime && !mouvementReduit && visible;
}

/**
 * Phase du halo pulsé à l'instant `tSec` (secondes) : 0,5 au départ, 1 au sommet (t = 0,5 s), 0 au creux (t = 1,5 s), un cycle
 * par 2 s. Même formule que le graphe, qui l'applique aux opacités.
 */
export function phaseHalo(tSec: number): number {
  if (!Number.isFinite(tSec)) return 0.5;
  return 0.5 + 0.5 * Math.sin((2 * Math.PI * tSec) / PERIODE_HALO_S);
}

/**
 * Limiteur de recalculs : un plan arrive à chaque événement du direct, bien plus souvent que 4 fois par seconde. Le premier
 * passe tout de suite, les suivants attendent `intervalleMs` depuis le dernier passé ; `attente()` dit combien de temps, pour que
 * l'appelant reprogramme le dernier plan reçu au lieu de le perdre.
 */
export interface Limiteur {
  /** Temps (ms) à attendre avant le prochain recalcul : 0 s'il est permis tout de suite. */
  attente(maintenant: number): number;
  /** Note un recalcul fait à cet instant. */
  marquer(maintenant: number): void;
  /** `attente() === 0` : note le recalcul et rend vrai ; sinon rend faux sans rien noter. */
  autoriser(maintenant: number): boolean;
  /** Oublie le dernier recalcul : le prochain passe tout de suite. */
  reinitialiser(): void;
}

export function creerLimiteur(intervalleMs: number = INTERVALLE_RECALCUL_MS): Limiteur {
  const intervalle = Number.isFinite(intervalleMs) ? Math.max(0, intervalleMs) : INTERVALLE_RECALCUL_MS;
  let dernier: number | null = null;
  const attente = (maintenant: number): number => {
    if (dernier === null || !Number.isFinite(maintenant)) return 0;
    const ecoule = maintenant - dernier;
    // Horloge qui recule (heure changée, horloge injectée) : on repart du présent plutôt que d'attendre sans fin.
    if (ecoule < 0 || ecoule >= intervalle) return 0;
    return intervalle - ecoule;
  };
  return {
    attente,
    marquer(maintenant) {
      dernier = Number.isFinite(maintenant) ? maintenant : null;
    },
    autoriser(maintenant) {
      if (attente(maintenant) > 0) return false;
      dernier = Number.isFinite(maintenant) ? maintenant : null;
      return true;
    },
    reinitialiser() {
      dernier = null;
    },
  };
}
