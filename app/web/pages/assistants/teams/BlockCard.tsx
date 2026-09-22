// Propriétaire : L40b.
// Carte d'un bloc dans l'éditeur guidé (spécification §5.3 l.894-902, §5.5 ; C §9.11) : le titre du bloc (« Bloc 2 · Des avis
// indépendants »), sa phrase d'honnêteté, les boutons [Monter] [Descendre] [Supprimer] [Dupliquer], les formulaires de ses
// étapes et, pour un bloc d'avis, [Ajouter un avis]. Un bloc « pause » n'a qu'un champ : ce que vous voulez vérifier.
// Les problèmes de l'aperçu qui portent sur le BLOC (et non sur une étape) sont rendus ici ; ceux d'une étape sont rendus par
// StepForm, sur l'étape concernée.
// Un bouton impossible reste focalisable (aria-disabled) et ne fait rien : la liste des commandes ne change pas de taille d'un
// bloc à l'autre. Aucun texte écrit ici : tout vient du modèle pur (server/shared/flow-edit.ts). Aucune animation.
import { useId } from "react";
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
}

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

      {bloc.etapes.map((etape) => (
        <StepForm
          key={etape.stepId}
          etape={etape}
          onPatch={(patch) => props.onPatchEtape(etape.stepId, patch)}
          onRetirer={() => props.onRetirerAvis(etape.stepId)}
        />
      ))}

      {bloc.ajouterAvis === null ? null : (
        <div className="row wrap tm-ed-bloc-ajout">
          <button type="button" className="btn sm" onClick={props.onAjouterAvis}>
            <Icon name="plus" size={14} />
            {bloc.ajouterAvis}
          </button>
        </div>
      )}
    </section>
  );
}
