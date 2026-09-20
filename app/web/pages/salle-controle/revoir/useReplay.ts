// Propriétaire : L28c.
// Minuteries du lecteur « Revoir » (spécification §5.8 l.998 ; plan d'exécution it3, fiche L28c, D-3d-11) : l'état et toutes les
// transitions sont ceux du module pur server/shared/revoir.ts (L28a) ; ce crochet ne fait qu'y poser le temps du navigateur.
// - Lecture par setTimeout EN CHAÎNE : un minuteur par moment, de la durée rendue par delaiSuivant (écart réel divisé par la
//   vitesse, ou 1 s pour un écart de plus de 4 s). JAMAIS setInterval ni requestAnimationFrame (D-3d-22, salle3d-animations) :
//   le lecteur n'anime rien, il change de moment.
// - « Figer ici » (figer) met `lecture` à faux : le minuteur en cours est annulé par le nettoyage de l'effet, et aucun autre
//   n'est posé. Même chose au dernier moment (delaiSuivant rend null), au démontage et à la fermeture de la boîte.
// - Une autre liste de faits ou une autre demande rouvre le lecteur sur sa fenêtre (ouvrir).
// Aucune requête, aucune lecture de la conversation : ce fichier ne connaît que des faits déjà chargés.
import { useEffect, useMemo, useState } from "react";
import type { ActivityFact } from "../../../../server/shared/activity-types.ts";
import {
  aller,
  auDirect,
  choisirVitesse,
  delaiSuivant,
  type Demande,
  figer,
  lire,
  ouvrir,
  precedent,
  type ReplaySpeed,
  type ReplayState,
  suivant,
} from "../../../../server/shared/revoir.ts";

/** Commandes de la barre du lecteur (ReplayBarProps), posées sur les transitions pures de revoir.ts. */
export interface ReplayActions {
  lire(): void;
  figer(): void;
  precedent(): void;
  suivant(): void;
  aller(index: number): void;
  vitesse(v: ReplaySpeed): void;
  direct(): void;
}

export interface Replay {
  etat: ReplayState;
  /** Écart réel du moment courant au suivant quand il est raccourci à 1 s (étiquette), null sinon (D-3d-11). */
  raccourciMs: number | null;
  actions: ReplayActions;
}

export function useReplay(faits: readonly ActivityFact[], demande: Demande | null): Replay {
  const [etat, setEtat] = useState<ReplayState>(() => ouvrir(faits, demande));

  // Autres faits (chargement fini) ou autre demande choisie : lecteur rouvert sur la fenêtre, figé sur son dernier moment.
  useEffect(() => {
    setEtat(ouvrir(faits, demande));
  }, [faits, demande]);

  const delai = delaiSuivant(etat);
  const attente = etat.lecture ? (delai?.ms ?? null) : null;
  const { index } = etat;

  // Chaîne de minuteurs : un seul minuteur vivant à la fois ; le nettoyage l'annule avant le suivant, au figeage et au démontage.
  useEffect(() => {
    if (attente === null) return;
    const minuteur = globalThis.setTimeout(() => setEtat((precedente) => suivant(precedente)), Math.max(0, attente));
    return () => globalThis.clearTimeout(minuteur);
  }, [attente, index]);

  const actions = useMemo<ReplayActions>(
    () => ({
      lire: () => setEtat(lire),
      figer: () => setEtat(figer),
      precedent: () => setEtat(precedent),
      suivant: () => setEtat(suivant),
      aller: (cible: number) => setEtat((precedente) => aller(precedente, cible)),
      vitesse: (v: ReplaySpeed) => setEtat((precedente) => choisirVitesse(precedente, v)),
      direct: () => setEtat(auDirect),
    }),
    [],
  );

  return { etat, raccourciMs: delai?.raccourciMs ?? null, actions };
}
