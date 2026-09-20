// Propriétaire : L40a.
// Schéma LU d'un déroulé (spécification §5.3, §5.5, §5.6 ; C §9.10) : une colonne HTML par cellule de chaque ligne rendue par le
// serveur (`layout`, layoutFlow de L36b), connecteurs en SVG. Le schéma est DÉCORATIF : il porte aria-hidden, et chaque connecteur
// le porte aussi, explicitement. La vérité pour le lecteur d'écran est la liste de FlowList, qui décrit le même déroulé.
// Le genre de chaque ligne est dit par un MOT (MOTS_LIGNE, textes de T4t) et par une FORME (classe .tm-kind-*, bordure et coins) :
// jamais par la couleur seule (§2.3, §5.5). Sous 900 px, teams.css cache le schéma et laisse la liste seule (§5.6).
// Clé d'une ligne : le bloc ET le genre. Un bloc d'avis donne DEUX lignes du même bloc (les avis, puis la synthèse) ; le bloc seul
// les confondrait, et l'état de la première pourrait être repris par la seconde à la relecture de la liste.
// Aucune animation, aucun texte écrit ici.
import type { FlowRow } from "../../../../server/shared/team-types.ts";
import { MOTS_LIGNE } from "./teams-tab-model.ts";

/** Connecteur entre deux lignes : trait et pointe vers le bas (« reçoit le résultat de »), purement décoratif. */
function Connecteur() {
  return (
    <svg className="tm-connecteur" viewBox="0 0 24 20" width="24" height="20" aria-hidden="true" focusable="false" role="presentation">
      <path className="tm-connecteur-trait" d="M12 0v14M7 10l5 5 5-5" />
    </svg>
  );
}

export interface FlowSchemaProps {
  /** Disposition rendue par le serveur (TeamView.layout, TeamExampleView.layout). */
  layout: readonly FlowRow[];
  /** Mini-schéma des cartes de la galerie : mêmes formes, en plus petit. */
  mini?: boolean;
}

export function FlowSchema({ layout, mini = false }: FlowSchemaProps) {
  return (
    <div className={`tm-schema${mini ? " mini" : ""}`} aria-hidden="true">
      {layout.map((ligne, index) => (
        <div key={`${ligne.bloc}-${ligne.kind}`} className="tm-schema-bloc">
          {index > 0 ? <Connecteur /> : null}
          <p className={`tm-schema-mot tm-kind-${ligne.kind}`}>{MOTS_LIGNE[ligne.kind]}</p>
          <div className="tm-schema-colonnes">
            {ligne.cellules.map((cellule, rang) => (
              <div key={cellule.stepId ?? `${ligne.bloc}-${rang}`} className={`tm-schema-cellule tm-kind-${ligne.kind}`}>
                <span className="tm-schema-titre">{cellule.titre}</span>
                {cellule.sousTitre ? <span className="tm-schema-sous-titre">{cellule.sousTitre}</span> : null}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
