// Propriétaire : L40a.
// Carte d'une équipe installée (spécification §5.4 ; C §9.10) : la ligne « {titre} · {forme} · {n} étapes · ≈ {typique} $ ·
// Dernier lancement : {date}, {cout} $ », l'état éventuel dit par son MOT (« À compléter », « Réglée en mode Avancé ») avec son
// aide, le déroulé lu (FlowList + FlowSchema) et les boutons [Utiliser dans le chat] [Modifier] [Dupliquer] [Supprimer].
// En lecture seule (mode Simple fermé, U1), le modèle ne rend AUCUN bouton : la carte se consulte seulement.
// Un bouton indisponible reste focalisable (aria-disabled) et renvoie à la phrase de sa raison (aria-describedby), comme la carte
// de plan de l'itération 1. Aucun texte écrit ici : tout vient du modèle pur (teams-tab-model.ts), donc de team-texts.ts.
import { useId } from "react";
import { Icon } from "../../../components/Icon.tsx";
import { FlowList } from "./FlowList.tsx";
import { FlowSchema } from "./FlowSchema.tsx";
import type { TeamActionId, TeamCardModel } from "./teams-tab-model.ts";

/** Allure de chaque bouton : le lancement en premier choix, la suppression en retrait. */
const VARIANTS: Readonly<Record<TeamActionId, string>> = {
  utiliser: "btn primary",
  modifier: "btn",
  dupliquer: "btn",
  supprimer: "btn danger",
};

export interface TeamCardProps {
  carte: TeamCardModel;
  onAction: (action: TeamActionId) => void;
}

export function TeamCard({ carte, onAction }: TeamCardProps) {
  const aideId = useId();
  return (
    <section className="card tm-carte">
      <div className="stack tight">
        <div className="row wrap">
          <h3 className="tm-carte-titre">{carte.titre}</h3>
          {carte.etat ? (
            <span className={`badge tm-etat tm-etat-${carte.etat.code}`}>
              <Icon name={carte.etat.code === "a-completer" ? "alert" : "settings"} size={13} />
              {carte.etat.mot}
            </span>
          ) : null}
        </div>
        <p className="secondary small tm-carte-ligne">{carte.ligne}</p>
        {carte.description ? <p className="secondary tm-carte-description">{carte.description}</p> : null}
        {carte.etat ? (
          <p id={aideId} className="secondary small tm-carte-aide">
            {carte.etat.aide}
          </p>
        ) : null}
      </div>
      <FlowList liste={carte.liste} libelle={carte.libelleSchema} schema={<FlowSchema layout={carte.layout} />} />
      {carte.actions.length > 0 ? (
        <div className="row wrap tm-carte-actions">
          {carte.actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className={VARIANTS[action.id]}
              aria-disabled={action.desactive}
              aria-describedby={action.raison === null ? undefined : aideId}
              onClick={() => {
                if (!action.desactive) onAction(action.id);
              }}
            >
              {action.libelle}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
