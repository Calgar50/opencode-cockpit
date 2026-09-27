// Fluidité de la salle de contrôle : crochet de la page (plan it3, fiche L30 ; spécification §5.8 l.1003-1008, JP-12 ; D-3d-17,
// D-3d-18, D-3d-25, D-3d-27). AUCUN TEXTE : l'état porte des raisons (FluidityReason), que la page met en phrases par
// messageFluidite (salle3d-texts.ts, T3d-b, fusionné au train de V0). Aucune animation, aucune boucle, aucune minuterie, aucune
// demande d'image : la sonde et la surveillance vivent dans fluidite.ts, les images viennent du moteur (Scene3d : onReady, onFrame).
//
// Déroulé (ControleFluidite, testable sous Node avec des dépendances factices, server/fluidite-sonde.test.ts) :
// - ouverture : verdictCapacites (accessibilité, préférence du poste, contexte webgl2, moteur de rendu). 2D : raison donnée tout
//   de suite. 3D : sonde en cours ; la page monte la scène 3D et remet sa poignée par pret(poignee) ; 90 images forcées ; sonde
//   ratée → 2D « sonde-lente », rendu en erreur → 2D « webgl-absent » ;
// - pendant la 3D, image(ms, anime) nourrit la surveillance : proposition après 5 s de temps animé lent (proposition = true,
//   retirée si la fluidité revient) ; [Passer en 2D] → passer2d() : préférence 2D gardée pour ce poste, verdict « preference-2d » ;
//   [Rester en 3D] → rester3d() : proposition retirée, surveillance suspendue jusqu'à [Réessayer] ; sans réponse, bascule
//   automatique à 10 s (2D « saccades », préférence du poste inchangée : seul un choix de la personne est gardé, pour que
//   « vous l'avez choisi sur ce poste » reste vrai) ;
// - [Réessayer] → reessayer() : préférence remise à auto (D-3d-25), capacités relues, nouvelle sonde. C'est un GESTE de la
//   personne : l'état est reposé même quand il est identique (`poser(..., force)`), pour que la page — qui compare le verdict par
//   référence — remonte sa scène après un échec survenu avant la première image. Une bascule n'est jamais marquée deux fois ;
// - chaque passage en 2D pose la marque « salle3d:bascule » (fluidite.ts, D-3d-18).
// La position du différé n'est pas gardée ici : la page la garde quand l'affichage passe en 2D (L31b).
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  type CapacitesNavigateur,
  type FluidityReason,
  type FluidityVerdict,
  type Preference,
  type PreferenceChoix,
  verdictCapacites,
  verdictSonde,
} from "../../../server/shared/fluidity.ts";
import { capacites, creerSurveillance, enregistrerPreference, marquerBascule, preferenceLocale, sonder, type Surveillance } from "./fluidite.ts";

export interface EtatFluidite {
  verdict: FluidityVerdict;
  /** Verdict « 3d » encore soumis à la sonde : la page monte la scène 3D et remet sa poignée par pret(). */
  sondeEnCours: boolean;
  /** Bascule en 2D proposée (surveillance : 5 s de temps animé lent). */
  proposition: boolean;
}

/** Ce que la sonde demande à la scène 3D (Scene3dHandle.renderFrame, slots-3d.ts). */
export interface PoigneeSonde {
  renderFrame(): void;
}

/** Dépendances du contrôleur ; celles du navigateur par défaut, remplacées dans les tests. */
export interface DependancesFluidite {
  capacites(): CapacitesNavigateur;
  preference(): Preference;
  enregistrer(choix: PreferenceChoix, raison: FluidityReason | null): void;
  sonder(renderFrame: () => void): Promise<number[]>;
  surveillance(): Surveillance;
  marquer(raison: FluidityReason): void;
}

const DEPENDANCES_NAVIGATEUR: DependancesFluidite = {
  capacites: () => capacites(),
  preference: () => preferenceLocale(),
  enregistrer: (choix, raison) => {
    enregistrerPreference(choix, raison);
  },
  sonder: (renderFrame) => sonder(renderFrame),
  surveillance: () => creerSurveillance(),
  marquer: marquerBascule,
};

export interface ActionsFluidite {
  /** Poignée de la scène 3D montée (onReady), null quand elle est démontée : lance la sonde attendue. */
  pret(poignee: PoigneeSonde | null): void;
  /** Image rendue en 3D (onFrame) : durée (ms) et animation. */
  image(ms: number, anime: boolean): void;
  /** [Réessayer] : préférence remise à auto, capacités relues, nouvelle sonde. */
  reessayer(): void;
  /** [Passer en 2D] : préférence 2D gardée pour ce poste. */
  passer2d(): void;
  /** [Rester en 3D] : proposition retirée, surveillance suspendue jusqu'à reessayer(). */
  rester3d(): void;
}

export interface ControleFluidite extends ActionsFluidite {
  etat(): EtatFluidite;
  abonner(ecouteur: () => void): () => void;
  /** Montage : marque le verdict d'ouverture s'il est 2D (une fois). */
  ouvrir(): void;
  /** Démontage : sonde en cours abandonnée, plus aucun rendu demandé à la poignée. */
  fermer(): void;
}

export type Fluidite = EtatFluidite & ActionsFluidite;

const deuxD = (raison: FluidityReason): EtatFluidite => ({ verdict: { mode: "2d", raison }, sondeEnCours: false, proposition: false });

const memeVerdict = (a: FluidityVerdict, b: FluidityVerdict) => a.mode === b.mode && (a.mode === "3d" || (b.mode === "2d" && a.raison === b.raison));

/** Contrôleur de la fluidité d'une vue (état, sonde, surveillance, préférence) ; aucun texte. */
export function creerControleFluidite(dependances: Partial<DependancesFluidite> = {}): ControleFluidite {
  const d: DependancesFluidite = { ...DEPENDANCES_NAVIGATEUR, ...dependances };
  const ecouteurs = new Set<() => void>();
  const surveillance = d.surveillance();
  let poignee: PoigneeSonde | null = null;
  /** Change à chaque abandon (fermeture, réessai, passage en 2D, poignée changée) : une sonde d'une autre génération est ignorée. */
  let generation = 0;
  /** Génération de la sonde lancée, -1 si aucune. */
  let sondeLancee = -1;
  let surveillanceActive = true;
  let ouvertureMarquee = false;

  const verdictOuverture = (preference: PreferenceChoix): EtatFluidite => {
    const verdict = verdictCapacites({ ...d.capacites(), preference });
    return { verdict, sondeEnCours: verdict.mode === "3d", proposition: false };
  };

  let etat = verdictOuverture(d.preference().choix);

  const abandonner = () => {
    generation += 1;
    sondeLancee = -1;
  };

  /**
   * Pose un état. `force` : transition VOULUE par la personne ([Réessayer]) dont l'état calculé peut être identique à l'état
   * courant — l'état est alors remplacé quand même, pour que la page, qui compare le verdict par RÉFÉRENCE, voie le geste et
   * remonte sa scène. Sans cela, [Réessayer] reste sans effet après un échec de la scène survenu AVANT la première image
   * (`sondeEnCours` encore vrai, aucune poignée) : l'état recalculé est identique point par point, la garde d'égalité sort, et la
   * page reste en 2D jusqu'au rechargement.
   */
  const poser = (suivant: EtatFluidite, force = false) => {
    const avant = etat;
    const identique =
      memeVerdict(avant.verdict, suivant.verdict) && avant.sondeEnCours === suivant.sondeEnCours && avant.proposition === suivant.proposition;
    if (identique && !force) return;
    etat = suivant;
    if (suivant.verdict.mode === "2d") {
      // La scène 3D est démontée en 2D : sa poignée ne sert plus.
      poignee = null;
      // Une bascule déjà comptée ne l'est pas deux fois (D-3d-18) : [Réessayer] sur une cause inchangée (accessibilité) ne marque
      // rien de plus, même si l'état est reposé pour la page.
      if (!identique) d.marquer(suivant.verdict.raison);
    }
    for (const ecouteur of [...ecouteurs]) ecouteur();
  };

  const lancerSonde = () => {
    if (!etat.sondeEnCours || poignee === null) return;
    const lancee = generation;
    const cible = poignee;
    sondeLancee = lancee;
    d.sonder(() => {
      if (lancee === generation) cible.renderFrame();
    }).then(
      (mesures) => {
        if (lancee !== generation) return;
        sondeLancee = -1;
        if (!verdictSonde(mesures).ok) return poser(deuxD("sonde-lente"));
        surveillance.reinitialiser();
        poser({ verdict: { mode: "3d" }, sondeEnCours: false, proposition: false });
      },
      () => {
        if (lancee !== generation) return;
        sondeLancee = -1;
        poser(deuxD("webgl-absent"));
      },
    );
  };

  return {
    etat: () => etat,
    abonner(ecouteur) {
      ecouteurs.add(ecouteur);
      return () => {
        ecouteurs.delete(ecouteur);
      };
    },
    ouvrir() {
      if (ouvertureMarquee) return;
      ouvertureMarquee = true;
      if (etat.verdict.mode === "2d") d.marquer(etat.verdict.raison);
    },
    fermer() {
      abandonner();
      poignee = null;
    },
    pret(suivante) {
      if (suivante === poignee) return;
      if (sondeLancee === generation) abandonner();
      poignee = suivante;
      lancerSonde();
    },
    image(ms, anime) {
      if (etat.verdict.mode !== "3d" || etat.sondeEnCours || !surveillanceActive) return;
      if (surveillance.image(ms, anime) === "basculer") return poser(deuxD("saccades"));
      const proposition = surveillance.etat().periode?.proposee === true;
      if (proposition !== etat.proposition) poser({ ...etat, proposition });
    },
    reessayer() {
      d.enregistrer("auto", null);
      abandonner();
      surveillanceActive = true;
      // Préférence prise à auto sans la relire : un stockage qui refuse l'écriture ne bloque pas [Réessayer].
      // `force` : geste de la personne, donc transition TOUJOURS observable, même quand le verdict recalculé est le même.
      poser(verdictOuverture("auto"), true);
      lancerSonde();
    },
    passer2d() {
      if (etat.verdict.mode !== "3d") return;
      d.enregistrer("2d", etat.proposition ? "saccades" : "preference-2d");
      abandonner();
      poser(deuxD("preference-2d"));
    },
    rester3d() {
      if (etat.sondeEnCours) return;
      surveillanceActive = false;
      poser({ ...etat, proposition: false });
    },
  };
}

/** Fluidité de la vue : verdict, sonde en cours, proposition, et les actions de la page. */
export function useFluidite(dependances?: Partial<DependancesFluidite>): Fluidite {
  const [controle] = useState(() => creerControleFluidite(dependances));
  const etat = useSyncExternalStore(controle.abonner, controle.etat, controle.etat);
  useEffect(() => {
    controle.ouvrir();
    return () => controle.fermer();
  }, [controle]);
  return useMemo(
    () => ({
      ...etat,
      pret: controle.pret,
      image: controle.image,
      reessayer: controle.reessayer,
      passer2d: controle.passer2d,
      rester3d: controle.rester3d,
    }),
    [etat, controle],
  );
}
