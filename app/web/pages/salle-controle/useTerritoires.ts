// Propriétaire : L31b.
// Données du zoom 1 de la salle de contrôle (spécification §5.8 l.993 ; plan d'exécution it3, fiche L31b, D-3d-13, D-3d-16,
// D-3d-17, M20) : lecture de GET /api/salle-controle/territoires, table des places gardée pendant la vue, plan 3D des
// territoires et marque « salle3d:plan » à chaque recalcul.
// - une lecture à l'ouverture, puis AU PLUS une toutes les 2 s : les faits reçus en direct (`activite.fait`) et le retour de la
//   page au premier plan demandent une lecture, qui attend son tour au lieu de s'ajouter (D-3d-17 : 4 recalculs par seconde au
//   plus ; M20 compte les marques) ;
// - une lecture impossible n'efface jamais la dernière liste connue : la liste reste la vérité (P7), et la page dit seulement
//   qu'elle est vide quand elle l'est vraiment ;
// - aucune boucle, aucune image demandée : `setTimeout` seulement (salle3d-animations.test.ts).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NeonTheme } from "../../../server/shared/neon-palette.ts";
import type { NeonMode } from "../../../server/shared/neon-scene.ts";
import type { Plan3d, TerritoiresResponse } from "../../../server/shared/salle3d-types.ts";
import { placer, planTerritoires } from "../../../server/shared/territoires.ts";
import { salle3dApi } from "../../lib/api-salle3d.ts";
import { useEvents } from "../../lib/events.ts";

/** Écart minimum entre deux lectures des territoires (D-3d-17 : au plus 4 recalculs par seconde, et ici bien moins). */
export const DELAI_LECTURE_MS = 2_000;

/** Marque de mesure d'un plan dessiné (D-3d-18, M20) : `detail` porte le zoom et le rendu. */
export const MARQUE_PLAN = "salle3d:plan";

/** Réponse neutre tant que la première lecture n'a pas abouti : aucun projet, statut non vérifié (jamais 0 par défaut). */
const REPONSE_VIDE: TerritoiresResponse = Object.freeze({ genereLe: 0, mode: "simple", projets: [], salle: null, statutVerifie: false });

/** Marque « salle3d:plan » ; une marque refusée n'empêche jamais l'affichage. */
export function marquerPlan(zoom: 1 | 2 | 3, rendu: "2d" | "3d"): void {
  try {
    performance.mark(MARQUE_PLAN, { detail: { zoom, rendu } });
  } catch {
    // Mesure seulement.
  }
}

export interface OptionsTerritoires {
  theme: NeonTheme;
  mode: NeonMode;
  /** Rendu de la vue, reporté dans la marque : la mesure compte les plans dessinés en 3D comme en 2D. */
  rendu: "2d" | "3d";
  /** Page au premier plan (`document.visibilityState`) : une page cachée ne relit rien. */
  visible: boolean;
  /** Zoom 1 montré : hors de là, le plan n'est pas dessiné (aucune marque) et les faits reçus ne déclenchent aucune lecture. */
  actif: boolean;
}

export interface EtatTerritoires {
  /** Dernière réponse connue ; null tant qu'aucune lecture n'a abouti. */
  reponse: TerritoiresResponse | null;
  plan: Plan3d;
}

export function useTerritoires({ theme, mode, rendu, visible, actif }: OptionsTerritoires): EtatTerritoires {
  const [reponse, setReponse] = useState<TerritoiresResponse | null>(null);
  /** Table des places des projets, gardée pendant toute la vue : un projet ne change jamais de plaque (D-3d-16). */
  const places = useRef<ReadonlyMap<string, number>>(new Map());
  const derniereLecture = useRef(0);
  const minuterie = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lecture = useRef<AbortController | null>(null);
  const monte = useRef(true);

  const lire = useCallback(() => {
    derniereLecture.current = Date.now();
    lecture.current?.abort();
    const controleur = new AbortController();
    lecture.current = controleur;
    salle3dApi.territoires(controleur.signal).then(
      (recue) => {
        if (controleur.signal.aborted || !monte.current) return;
        setReponse(recue);
      },
      (err: unknown) => {
        if (controleur.signal.aborted) return;
        // Lecture impossible : la dernière liste connue reste affichée, jamais remplacée par une liste vide inventée.
        console.warn("Salle de contrôle : lecture des territoires impossible", err);
      },
    );
  }, []);

  /** Demande une lecture : tout de suite si la dernière date d'au moins 2 s, sinon à l'échéance (une seule en attente). */
  const demander = useCallback(() => {
    if (minuterie.current !== null) return;
    const reste = DELAI_LECTURE_MS - (Date.now() - derniereLecture.current);
    if (reste <= 0) {
      lire();
      return;
    }
    minuterie.current = setTimeout(() => {
      minuterie.current = null;
      if (monte.current) lire();
    }, reste);
  }, [lire]);

  useEffect(() => {
    monte.current = true;
    return () => {
      monte.current = false;
      lecture.current?.abort();
      if (minuterie.current !== null) clearTimeout(minuterie.current);
      minuterie.current = null;
    };
  }, []);

  // Ouverture de la page, retour au premier plan et retour au zoom 1 : une lecture, soumise au même écart de 2 s. `actif` est ici
  // une raison de relire, jamais une condition : la première lecture sert aussi au fil d'Ariane des zooms 2 et 3.
  useEffect(() => {
    if (visible) demander();
  }, [visible, actif, demander]);

  // Faits reçus en direct : une lecture seulement quand le zoom 1 est montré et la page au premier plan (D-3d-17, M20 : le
  // compte des plans dessinés par seconde reste celui de la vue affichée).
  useEvents(
    useCallback(
      (evenement) => {
        if (actif && visible && evenement.kind === "cockpit" && evenement.type === "activite.fait") demander();
      },
      [actif, visible, demander],
    ),
  );

  const plan = useMemo(() => {
    const vue = reponse ?? REPONSE_VIDE;
    // `placer` garde les places déjà attribuées et range les projets nouveaux après les autres (D-3d-16).
    places.current = placer(
      vue.projets.map((territoire) => territoire.projet),
      places.current,
    );
    return planTerritoires(vue, places.current, { theme, mode });
  }, [reponse, theme, mode]);

  // Un plan neuf, ou le même plan dessiné dans l'autre rendu : une marque par dessin (M20, D-3d-18). Hors du zoom 1, le plan
  // n'est pas dessiné : aucune marque, pour que le compte par seconde reste celui de la vue montrée.
  useEffect(() => {
    if (actif) marquerPlan(1, rendu);
  }, [plan, rendu, actif]);

  return { reponse, plan };
}
