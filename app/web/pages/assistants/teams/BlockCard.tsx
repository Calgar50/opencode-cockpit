// Propriétaire : L40b.
// Carte d'un bloc dans l'éditeur guidé (spécification §5.3 l.894-902, §5.5 ; C §9.11) : le titre du bloc (« Bloc 2 · Des avis
// indépendants »), sa phrase d'honnêteté, les boutons [Monter] [Descendre] [Supprimer] [Dupliquer], les formulaires de ses
// étapes et, pour un bloc d'avis, [Ajouter un avis]. Un bloc « pause » n'a qu'un champ : ce que vous voulez vérifier.
// Les problèmes de l'aperçu qui portent sur le BLOC (et non sur une étape) sont rendus ici ; ceux d'une étape sont rendus par
// StepForm, sur l'étape concernée.
// Un bouton impossible reste focalisable (aria-disabled) et ne fait rien : la liste des commandes ne change pas de taille d'un
// bloc à l'autre. Aucun texte écrit ici : tout vient du modèle pur (server/shared/flow-edit.ts). Aucune animation.
// L42d (5b) : une carte de RELECTURE porte en plus « Nombre de tours au maximum » (1 · 2, avec « Un tour = … ») et
// « Me laisser vérifier le premier jet avant la relecture » ; une carte d'AIGUILLAGE porte « Spécialistes à consulter au plus »
// (1 · 2) et le groupe « Spécialistes » avec [Ajouter un spécialiste] ; [Retirer ce spécialiste] est rendu par StepForm, sur le
// spécialiste concerné, tant qu'il en reste plus de 2.
import { Fragment, useId } from "react";
import type { BlockCardModel, StepPatch } from "../../../../server/shared/flow-edit.ts";
import { Icon } from "../../../components/Icon.tsx";
import { StepForm } from "./StepForm.tsx";

export interface BlockCardProps {
  bloc: BlockCardModel;
  onMonter: () => void;
  onDescendre: () => void;
  onSupprimer: () => void;
  onDupliquer: () => void;
  onAjouterAvis: () => void;
  onRetirerAvis: (stepId: string) => void;
  onPatchEtape: (stepId: string, patch: StepPatch) => void;
  onPause: (message: string) => void;
  // <c5:props-l42d>
  /** [Ajouter un spécialiste] ; appelé seulement quand `bloc.specialistes.ajouter` n'est pas nul. */
  onAjouterSpecialiste: () => void;
  /** [Retirer ce spécialiste] ; appelé seulement quand l'étape porte un libellé de retrait. */
  onRetirerSpecialiste: (stepId: string) => void;
  /** « Nombre de tours au maximum » (1 · 2). */
  onTours: (tours: 1 | 2) => void;
  /** « Me laisser vérifier le premier jet avant la relecture ». */
  onPauseAvantRelecture: (valeur: boolean) => void;
  /** « Spécialistes à consulter au plus » (1 · 2). */
  onChoixMax: (choixMax: 1 | 2) => void;
  /** Méthodes retenues par une étape. */
  onMethodesEtape: (stepId: string, methodes: readonly string[]) => void;
  /** Étapes dont une étape reçoit le résultat (mode Avancé). */
  onRecoitEtapes: (stepId: string, etapes: readonly string[]) => void;
  // </c5:props-l42d>
}

// <c5:nombres-l42d>
/**
 * Choix d'un nombre par boutons radio (« Nombre de tours au maximum », « Spécialistes à consulter au plus ») : les valeurs
 * viennent du modèle, jamais d'un nombre écrit ici. Le groupe porte son libellé, l'aide est rendue à côté par l'appelant.
 */
function ChoixNombre({
  libelle,
  valeur,
  choix,
  nom,
  onChoisir,
}: {
  libelle: string;
  valeur: number;
  choix: readonly number[];
  nom: string;
  onChoisir: (valeur: 1 | 2) => void;
}) {
  return (
    <fieldset className="tm-ed-nombre">
      <legend>{libelle}</legend>
      <div className="row wrap">
        {choix.map((option) => (
          <label key={option} className="tm-ed-nombre-choix">
            <input type="radio" name={nom} checked={option === valeur} onChange={() => onChoisir(option as 1 | 2)} />
            <span>{option}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
// </c5:nombres-l42d>

/** Bouton de commande d'un bloc : désactivé, il garde le focus et sa place, et ne déclenche rien. */
function Commande({ libelle, possible, onClick }: { libelle: string; possible: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="btn sm"
      aria-disabled={!possible}
      onClick={() => {
        if (possible) onClick();
      }}
    >
      {libelle}
    </button>
  );
}

export function BlockCard(props: BlockCardProps) {
  const { bloc } = props;
  const pauseId = useId();
  return (
    <section className={`card tm-ed-bloc tm-ed-bloc-${bloc.type}`} aria-label={bloc.titre}>
      <div className="row wrap between tm-ed-bloc-entete">
        <h3 className="tm-ed-bloc-titre">{bloc.titre}</h3>
        <div className="row wrap tm-ed-bloc-actions">
          <Commande libelle={bloc.monter.libelle} possible={bloc.monter.possible} onClick={props.onMonter} />
          <Commande libelle={bloc.descendre.libelle} possible={bloc.descendre.possible} onClick={props.onDescendre} />
          <Commande libelle={bloc.dupliquer.libelle} possible={bloc.dupliquer.possible} onClick={props.onDupliquer} />
          <button type="button" className="btn sm danger" onClick={props.onSupprimer}>
            {bloc.supprimer}
          </button>
        </div>
      </div>

      {bloc.aide ? <p className="secondary small tm-ed-bloc-aide">{bloc.aide}</p> : null}

      {bloc.problemes.length > 0 ? (
        <ul className="stack tight tm-ed-problemes">
          {bloc.problemes.map((probleme) => (
            <li key={probleme.code} className={`tm-ed-probleme${probleme.bloquant ? " bloquant" : ""}`}>
              <Icon name="alert" size={15} />
              <span>{probleme.texte}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {bloc.pause ? (
        <div className="field">
          <label htmlFor={pauseId}>{bloc.pause.libelle}</label>
          <input
            id={pauseId}
            type="text"
            maxLength={bloc.pause.max}
            placeholder={bloc.pause.exemple}
            value={bloc.pause.valeur}
            onChange={(event) => props.onPause(event.target.value)}
          />
        </div>
      ) : null}

      {/* <c5:reglages-l42d> */}
      {bloc.tours === null ? null : (
        <div className="stack tight tm-ed-bloc-reglage">
          <ChoixNombre libelle={bloc.tours.libelle} valeur={bloc.tours.valeur} choix={bloc.tours.choix} nom={`${pauseId}-tours`} onChoisir={props.onTours} />
          <p className="secondary small tm-ed-bloc-reglage-aide">{bloc.tours.aide}</p>
        </div>
      )}

      {bloc.pauseAvantRelecture === null ? null : (
        <label className="tm-ed-bloc-case">
          <input type="checkbox" checked={bloc.pauseAvantRelecture.valeur} onChange={(event) => props.onPauseAvantRelecture(event.target.checked)} />
          <span>{bloc.pauseAvantRelecture.libelle}</span>
        </label>
      )}

      {bloc.choixMax === null ? null : (
        <div className="stack tight tm-ed-bloc-reglage">
          <ChoixNombre
            libelle={bloc.choixMax.libelle}
            valeur={bloc.choixMax.valeur}
            choix={bloc.choixMax.choix}
            nom={`${pauseId}-choix`}
            onChoisir={props.onChoixMax}
          />
        </div>
      )}

      {/* </c5:reglages-l42d> */}

      {bloc.etapes.map((etape, rang) => (
        <Fragment key={etape.stepId}>
          {/* c5 (L42d) : « Spécialistes » titre le GROUPE, donc juste avant le premier d'entre eux (après l'aiguilleur). */}
          {bloc.specialistes !== null && etape.role === "specialiste" && bloc.etapes[rang - 1]?.role !== "specialiste" ? (
            <h4 className="tm-ed-role">{bloc.specialistes.libelle}</h4>
          ) : null}
          <StepForm
            etape={etape}
            onPatch={(patch) => props.onPatchEtape(etape.stepId, patch)}
            /* c5 (L42d) : un spécialiste se retire par son opération propre, un avis par la sienne. */
            onRetirer={() => (etape.role === "specialiste" ? props.onRetirerSpecialiste(etape.stepId) : props.onRetirerAvis(etape.stepId))}
            onMethodes={(methodes) => props.onMethodesEtape(etape.stepId, methodes)}
            onRecoitEtapes={(etapes) => props.onRecoitEtapes(etape.stepId, etapes)}
          />
        </Fragment>
      ))}

      {bloc.ajouterAvis === null ? null : (
        <div className="row wrap tm-ed-bloc-ajout">
          <button type="button" className="btn sm" onClick={props.onAjouterAvis}>
            <Icon name="plus" size={14} />
            {bloc.ajouterAvis}
          </button>
        </div>
      )}

      {/* <c5:ajout-specialiste-l42d> */}
      {bloc.specialistes?.ajouter == null ? null : (
        <div className="row wrap tm-ed-bloc-ajout">
          <button type="button" className="btn sm" onClick={props.onAjouterSpecialiste}>
            <Icon name="plus" size={14} />
            {bloc.specialistes.ajouter}
          </button>
        </div>
      )}
      {/* </c5:ajout-specialiste-l42d> */}
    </section>
  );
}
