// Propriétaire : L26a.
// Écran d'activation « Lancer cette demande comme Oh My OpenAgent ? » (spécification §4.14.6 l.854-868, §4.8.2 l.722, l.729-730 ;
// JS-12 ; phrases réécrites de D-2b-38) :
// - toutes les phrases viennent de T3a (shared/omo-room-texts.ts), assemblées par le modèle pur shared/omo-activation-view.ts :
//   aucune phrase n'est écrite ni réécrite ici, variante Prometheus comprise ;
// - champ « Arrêt automatique à : [    ] $ » : vide la première fois, prérempli du dernier montant ensuite, borne affichée ;
//   `aria-invalid` sur le champ et erreur `role="alert"` près de lui ; un montant refusé ne lance rien ;
// - le montant part en CHAÎNE saisie : le serveur reste seul juge (omo-cap.ts), le navigateur ne fait qu'annoncer tôt ;
// - boutons [Lancer comme Oh My OpenAgent] [Annuler] [Ce que l'extension fait sans demande] ;
// - aucune animation.
import { useId, useState } from "react";
import { type VueActivation, vueActivation } from "../../../server/shared/omo-activation-view.ts";
import type { OmoActivationView } from "../../../server/shared/omo-types.ts";
import { Button, Modal } from "../../components/ui.tsx";
import { SansDemandeTable } from "./SansDemandeTable.tsx";

export interface OmoActivationDialogProps {
  open: boolean;
  /** Vue rendue par le port d'activation (T3a) : projet, dernier montant, borne, conditions du §4.14.2. */
  vue: OmoActivationView;
  /** Date d'audit de l'extension (image.auditeLe) ; chaîne vide quand elle n'est pas connue. */
  dateAudit: string;
  /** Message de refus rendu par le serveur (409), déjà en français ; null quand il n'y en a pas. */
  refusServeur: string | null;
  /** Valeurs de gabarit des phrases de conditions que seule la page connaît ({liste} des historiques git non protégés). */
  valeurs?: Readonly<Record<string, string>>;
  onClose: () => void;
  /** Lance la demande avec le montant saisi, tel quel. */
  onLancer: (plafondUsd: string) => void;
  occupe?: boolean;
}

export function OmoActivationDialog(props: OmoActivationDialogProps) {
  const { open, vue, dateAudit, refusServeur, onClose, onLancer, occupe = false, valeurs } = props;
  const [saisie, setSaisie] = useState<string | null>(null);
  const [tentee, setTentee] = useState(false);
  const [sansDemande, setSansDemande] = useState(false);
  const champId = useId();
  const aideId = useId();

  const rendu = vueActivation({ vue, saisie, tentee, dateAudit, ...(valeurs === undefined ? {} : { valeurs }) });

  const lancer = () => {
    setTentee(true);
    if (rendu.lancerPossible) onLancer(rendu.champ.valeur);
  };

  return (
    <Modal
      open={open}
      title={rendu.titre}
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={() => setSansDemande((ouvert) => !ouvert)} aria-expanded={sansDemande}>
            {rendu.boutons.sansDemande}
          </Button>
          <span className="spacer" />
          <Button onClick={onClose}>{rendu.boutons.annuler}</Button>
          <Button variant="primary" icon="bolt" loading={occupe} onClick={lancer}>
            {rendu.boutons.lancer}
          </Button>
        </>
      }
    >
      <div className="stack">
        <ul className="omo-activation-phrases">
          {rendu.phrases.map((phrase) => (
            <li key={phrase}>{phrase}</li>
          ))}
        </ul>
        <ChampPlafond rendu={rendu} champId={champId} aideId={aideId} onChange={setSaisie} />
        {rendu.conditions.length > 0 ? (
          <ul className="omo-raisons">
            {rendu.conditions.map((condition) => (
              <li key={condition.code} className="omo-raison">
                {condition.phrase}
              </li>
            ))}
          </ul>
        ) : null}
        {refusServeur ? (
          <p className="field-error" role="alert">
            {refusServeur}
          </p>
        ) : null}
        {sansDemande ? <SansDemandeTable dateAudit={dateAudit} plafondSaisi={rendu.champ.valeur} /> : null}
      </div>
    </Modal>
  );
}

/** Champ « Arrêt automatique à : [    ] $ », sa borne, son aide et son erreur annoncée. */
function ChampPlafond({
  rendu,
  champId,
  aideId,
  onChange,
}: {
  rendu: VueActivation;
  champId: string;
  aideId: string;
  onChange: (valeur: string) => void;
}) {
  const { champ, erreur } = rendu;
  return (
    <div className="field">
      <label htmlFor={champId}>{champ.libelle}</label>
      <div className="omo-champ-ligne">
        <input
          id={champId}
          className="input"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={champ.valeur}
          aria-invalid={champ.invalide}
          aria-describedby={aideId}
          onChange={(e) => onChange(e.target.value)}
        />
        <span>{champ.unite}</span>
        <span className="omo-champ-borne">{champ.borne}</span>
      </div>
      <span className="field-hint" id={aideId}>
        {champ.aide}
      </span>
      {erreur ? (
        <p className="field-error" role="alert">
          {erreur.phrase}
        </p>
      ) : null}
    </div>
  );
}
