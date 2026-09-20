// Propriétaire : L40b.
// Formulaire d'une étape dans l'éditeur guidé (spécification §5.3 l.894-902, §5.5 ; C §9.11) : titre, assistant par groupes
// (indisponibles DÉSACTIVÉS avec leur raison, jamais retirés en silence), taille habituelle, consigne facultative, « Ce que
// l'étape reçoit » (en lecture : il vient de la place du bloc, C §5.1) et, en mode AVANCÉ seulement, « IA de l'étape » avec
// « ≈ X $ » par niveau (D-eq-12). En mode Simple, le modèle laisse `ia` nul : aucun chemin de l'interface ne peut donc choisir
// l'IA d'une étape, ni une simultanéité, ni une Réflexion.
// Les problèmes de l'aperçu (POST /api/teams/preview) sont rendus SUR l'étape concernée, chacun avec son icône et son texte.
// Aucun texte écrit ici : tout vient du modèle pur (server/shared/flow-edit.ts), donc de team-texts.ts (T4t). Aucune animation.
import { useId } from "react";
import type { StepPatch } from "../../../../server/shared/flow-edit.ts";
import type { AssistantOption, StepFormModel } from "../../../../server/shared/flow-edit.ts";
import type { TaskSize, Tier } from "../../../../server/shared/assistant-rules.ts";
import { Icon } from "../../../components/Icon.tsx";

export interface StepFormProps {
  etape: StepFormModel;
  /** Modification d'un champ ; `niveau` n'est passé qu'en mode Avancé (le modèle ne rend `ia` que là). */
  onPatch: (patch: StepPatch) => void;
  /** [Retirer cet avis] ; appelé seulement quand `etape.retirer` n'est pas nul. */
  onRetirer: () => void;
}

/** Une option d'assistant ; une option désactivée garde son libellé, suivi de sa raison. */
function OptionAssistant({ option }: { option: AssistantOption }) {
  return (
    <option value={option.nom} disabled={option.desactivee}>
      {option.raison === null ? option.libelle : `${option.libelle} — ${option.raison}`}
    </option>
  );
}

export function StepForm({ etape, onPatch, onRetirer }: StepFormProps) {
  const base = useId();
  const id = (champ: string) => `${base}-${champ}`;
  return (
    <div className="stack tm-ed-etape">
      <div className="tm-ed-champs">
        <div className="field">
          <label htmlFor={id("titre")}>{etape.titre.libelle}</label>
          <input
            id={id("titre")}
            type="text"
            maxLength={etape.titre.max}
            value={etape.titre.valeur}
            onChange={(event) => onPatch({ titre: event.target.value })}
          />
          <span className="field-hint">{etape.titre.aide}</span>
        </div>

        <div className="field">
          <label htmlFor={id("assistant")}>{etape.assistant.libelle}</label>
          <select id={id("assistant")} value={etape.assistant.valeur} onChange={(event) => onPatch({ assistant: event.target.value })}>
            <option value="" />
            {etape.assistant.groupes.map((groupe) => (
              <optgroup key={groupe.titre} label={groupe.titre}>
                {groupe.options.map((option) => (
                  <OptionAssistant key={option.nom} option={option} />
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor={id("taille")}>{etape.taille.libelle}</label>
          <select
            id={id("taille")}
            value={etape.taille.valeur}
            onChange={(event) => onPatch({ taille: event.target.value as TaskSize })}
          >
            {etape.taille.choix.map((choix) => (
              <option key={choix.valeur} value={choix.valeur}>
                {choix.libelle}
              </option>
            ))}
          </select>
        </div>

        {etape.ia ? (
          <div className="field">
            <label htmlFor={id("ia")}>{etape.ia.libelle}</label>
            <select
              id={id("ia")}
              value={etape.ia.valeur ?? ""}
              onChange={(event) => onPatch({ niveau: event.target.value === "" ? null : (event.target.value as Tier) })}
            >
              {etape.ia.choix.map((choix) => (
                <option key={choix.valeur ?? ""} value={choix.valeur ?? ""} disabled={choix.desactive}>
                  {choix.libelle}
                </option>
              ))}
            </select>
            <span className="field-hint">{etape.ia.aide}</span>
          </div>
        ) : null}
      </div>

      <div className="field">
        <label htmlFor={id("consigne")}>{etape.consigne.libelle}</label>
        <textarea
          id={id("consigne")}
          rows={3}
          maxLength={etape.consigne.max}
          value={etape.consigne.valeur}
          onChange={(event) => onPatch({ consigne: event.target.value })}
        />
        <span className="field-hint">{etape.consigne.aide}</span>
      </div>
      <p className="secondary small tm-ed-limite">{etape.consigne.limite}</p>

      <p className="secondary small tm-ed-recoit">
        <span className="tm-ed-recoit-libelle">{etape.recoit.libelle}</span>
        <span>{etape.recoit.texte}</span>
      </p>

      {etape.problemes.length > 0 ? (
        <ul className="stack tight tm-ed-problemes">
          {etape.problemes.map((probleme) => (
            <li key={probleme.code} className={`tm-ed-probleme${probleme.bloquant ? " bloquant" : ""}`}>
              <Icon name="alert" size={15} />
              <span>{probleme.texte}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {etape.retirer === null ? null : (
        <div className="row wrap tm-ed-etape-actions">
          <button type="button" className="btn sm" onClick={onRetirer}>
            {etape.retirer}
          </button>
        </div>
      )}
    </div>
  );
}
