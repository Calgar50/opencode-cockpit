// Propriétaire : L12a.
// Confirmation d'un choix automatique (spécification §4.11 l.776, §4.13, §5.5, §5.6 ; plan d'exécution, fiche L12a), réutilisée
// par le sélecteur (AutonomySelector) et par la carte de plan (PlanCard, L6c). Propriétés FIGÉES dans ../slots.ts : elles ne
// changent pas sans demande écrite à l'intégrateur.
// - « Autonome avec contrôle » : titre « Laisser l'IA travailler seule dans cette conversation ? », les cinq lignes du §4.13
//   ({dossier} et {x} remplis), plafonds modifiables et bornés, [Lancer en autonome] [Annuler]. La confirmation est demandée à
//   chaque activation ; le serveur en est juge (428 confirmation-requise), jamais ce composant.
// - « Modifications automatiques » : titre et trois lignes de sa première confirmation (§4.11), [Activer] [Annuler].
// - La variante sans IA de contrôle est LUE dans boot.settings.budget.autonomie.controleIa (jamais déduite) et sert aussi à
//   masquer le plafond de contrôles par IA, qui n'est alors jamais consulté.
// Modèle pur (lignes, icônes, bornes des plafonds, valeurs saisies) : server/shared/autonomy-menu.ts ; phrases :
// server/shared/autonomy-texts.ts (L9b), sans doublon ici. {dossier} est une donnée : React l'échappe à l'affichage. Aucune
// animation, aucun raccourci global : la fenêtre est celle de components/ui.tsx (Échap et focus rendu selon l'APG).
import { useId, useState } from "react";
import {
  buildAutonomyConfirm,
  capInput,
  capInputs,
  capsFromInputs,
  capsSignature,
  type CapKey,
  clampCaps,
} from "../../../../server/shared/autonomy-menu.ts";
import { useApp } from "../../../app/AppContext.tsx";
import { Icon } from "../../../components/Icon.tsx";
import { Button, Modal } from "../../../components/ui.tsx";
import type { AutonomyConfirmProps } from "../slots.ts";
import "./autonomy-selector.css";

export function AutonomyConfirm({ open, choix, directory, plafonds, busy = false, onConfirm, onCancel }: AutonomyConfirmProps) {
  const { boot, advanced } = useApp();
  const baseId = useId();
  const reglages = boot.settings.budget.autonomie;

  /** Plafonds proposés : ceux de la conversation, ramenés dans les bornes que le serveur applique. */
  const proposes = clampCaps(plafonds, reglages.plafondMaxUsd);
  /**
   * État des saisies, attaché aux plafonds proposés et à l'ouverture : la confirmation repart des plafonds du serveur à chaque
   * ouverture et quand ils changent vraiment, jamais sur un simple réaffichage du parent (la saisie en cours est gardée).
   */
  const cle = `${open ? 1 : 0}|${choix}|${capsSignature(proposes)}`;
  const [saisi, setSaisi] = useState<{ cle: string; valeurs: Record<CapKey, string> } | null>(null);
  const valeurs = saisi !== null && saisi.cle === cle ? saisi.valeurs : capInputs(proposes);
  const ecrire = (champ: CapKey, valeur: string) => setSaisi({ cle, valeurs: { ...valeurs, [champ]: valeur } });

  /** Plafonds envoyés : chaque champ lu et borné ; un champ vide ou illisible garde le plafond proposé. */
  const caps = capsFromInputs(valeurs, proposes, reglages.plafondMaxUsd);
  const modele = buildAutonomyConfirm({
    choix,
    dossier: directory,
    plafonds: caps,
    controleIa: reglages.controleIa,
    plafondMaxUsd: reglages.plafondMaxUsd,
    mode: advanced ? "avance" : "simple",
  });

  return (
    <Modal
      open={open}
      title={modele.titre}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>
            {modele.annuler}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => onConfirm(caps)}>
            {modele.valider}
          </Button>
        </>
      }
    >
      <ul className="autonomy-confirm-lines">
        {modele.lignes.map((ligne) => (
          <li key={ligne.texte} className="autonomy-confirm-line">
            <Icon name={ligne.icone} size={14} className="autonomy-confirm-icon" />
            <span>{ligne.texte}</span>
          </li>
        ))}
      </ul>
      {modele.champs.length > 0 ? (
        <div className="autonomy-confirm-caps">
          {modele.champs.map((champ) => (
            <div key={champ.cle} className="autonomy-confirm-cap">
              <label htmlFor={`${baseId}-${champ.cle}`} className="autonomy-confirm-cap-label">
                <span>{champ.libelle}</span>
                {champ.unite ? <span className="autonomy-confirm-unite">{champ.unite}</span> : null}
              </label>
              <input
                id={`${baseId}-${champ.cle}`}
                className="input autonomy-confirm-input"
                type="number"
                inputMode={champ.entier ? "numeric" : "decimal"}
                min={champ.min}
                max={champ.max}
                step={champ.pas}
                value={valeurs[champ.cle]}
                disabled={busy}
                onChange={(event) => ecrire(champ.cle, event.target.value)}
                onBlur={() => ecrire(champ.cle, capInput(champ.cle, caps[champ.cle]))}
              />
            </div>
          ))}
        </div>
      ) : null}
    </Modal>
  );
}
