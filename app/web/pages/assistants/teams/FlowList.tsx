// Propriétaire : L40a.
// Liste d'un déroulé (spécification §5.5, §5.6 ; C §9.10) : la VÉRITÉ pour le lecteur d'écran. Le déroulé est un `<figure>` dont
// le `<figcaption>` porte le libellé CHIFFRÉ (« Avis indépendants · 4 étapes »), suivi d'une liste ordonnée des lignes rendues par
// le serveur (`liste`, flowAsList de L36b) : elle décrit tout le déroulé, dans l'ordre, sans rien qui vienne du schéma.
// Le schéma décoratif (FlowSchema, aria-hidden) est placé DANS la même figure : sous 900 px, teams.css le cache et laisse la liste
// seule (§5.6) ; au-dessus, la liste reste dans l'arbre d'accessibilité, hors de l'écran (règles de .visually-hidden).
// Aucun texte écrit ici : le libellé est composé par teams-tab-model.ts, les lignes viennent du serveur.
import type { ReactNode } from "react";

export interface FlowListProps {
  /** Lignes du déroulé rendues par le serveur, dans l'ordre (TeamView.liste, TeamExampleView.liste). */
  liste: readonly string[];
  /** Libellé chiffré de la figure (libelleSchema de teams-tab-model.ts). */
  libelle: string;
  /** Schéma décoratif rendu dans la figure ; absent : la liste seule. */
  schema?: ReactNode;
  /** Liste toujours visible (aperçu, installation), au lieu d'être réservée au lecteur d'écran au-dessus de 900 px. */
  toujoursVisible?: boolean;
}

export function FlowList({ liste, libelle, schema, toujoursVisible = false }: FlowListProps) {
  return (
    <figure className="tm-figure">
      {schema}
      <figcaption className="tm-figure-legende">{libelle}</figcaption>
      <ol className={`tm-figure-liste${toujoursVisible ? " visible" : ""}`}>
        {liste.map((ligne, rang) => (
          <li key={`${rang}-${ligne}`}>{ligne}</li>
        ))}
      </ol>
    </figure>
  );
}
