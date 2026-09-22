// Propriétaire : L43.
// EMPLACEMENT du schéma modifiable (spécification §5.3 l.903, §5.5, §5.6 ; C §8.2, §9.12 ; plan d'exécution it5, fiches L42d et
// L43). Ce fichier est un SQUELETTE posé par L42d : il occupe la place que L43 remplira, et n'implémente AUCUNE opération de
// schéma — ni glisser, ni « Ajouter après », ni « Transformer en… », ni « Reçoit le résultat de… », ni [Voir le JSON], ni refus.
// Tant que L43 n'est pas livré, la vue « Schéma modifiable » rend le déroulé tel qu'il est LU (FlowSchema, décoratif) avec sa
// liste (FlowList, vérité du lecteur d'écran) et la phrase du §4.3 qui dit à quoi sert cette vue. Modifier le déroulé passe donc
// encore par « Étapes », qui reste le chemin complet : rien n'est annoncé ici que le cockpit ne sache faire (P3).
// Mode AVANCÉ seulement : c'est TeamEditor qui ne propose la bascule qu'en Avancé, et qui rend la phrase des écrans étroits
// (« Le schéma modifiable demande un écran plus large : utilisez les étapes. ») à la place de cette vue sous 900 px.
// Aucun texte écrit ici : les phrases viennent du modèle pur (server/shared/flow-edit.ts, donc construction-texts.ts) et le
// libellé chiffré de teams-tab-model.ts. Aucune animation.
import type { FlowRow } from "../../../../server/shared/team-types.ts";
import { FlowList } from "./FlowList.tsx";
import { FlowSchema } from "./FlowSchema.tsx";

export interface SchemaEditorProps {
  /** Disposition du déroulé (layoutFlow de L36b), la même que celle des étapes. */
  layout: readonly FlowRow[];
  /** Lignes du déroulé (flowAsList de L36b) : la vérité pour le lecteur d'écran. */
  liste: readonly string[];
  /** Libellé chiffré de la figure (libelleSchema de teams-tab-model.ts). */
  libelle: string;
  /** « Même équipe, deux façons de la modifier. Le schéma n'accepte que ce que le cockpit sait exécuter. » (§4.3). */
  phrase: string;
}

export function SchemaEditor({ layout, liste, libelle, phrase }: SchemaEditorProps) {
  return (
    <div className="stack tm-ed-schema-editeur">
      <p className="secondary small">{phrase}</p>
      <FlowList liste={liste} libelle={libelle} schema={<FlowSchema layout={layout} />} toujoursVisible />
    </div>
  );
}
