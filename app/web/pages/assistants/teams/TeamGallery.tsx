// Propriétaire : L40a.
// Galerie des exemples d'équipe (spécification §5.3 l.896, §5.4 ; C §9.10) : une carte par exemple, avec son mini-schéma, sa
// phrase, « ≈ X $ en général » (estimation lue par POST /api/teams/preview, jamais écrite ici), « Lecture seule », [Aperçu] et
// [Installer]. La galerie n'est montée que lorsque les équipes sont ouvertes : en mode Simple fermé (U1), le modèle la laisse
// nulle, donc aucun chemin ne mène à l'installation.
// [Aperçu] ouvre le déroulé complet (liste visible et schéma) sans rien envoyer ; [Installer] passe la main à TeamInstallDialog.
// Aucun texte écrit ici : tout vient du modèle pur (teams-tab-model.ts), donc de team-texts.ts.
// <c5:demonstration-equipe-doc>
// Itération 5 (fiche L49, spéc. §5.3 l.896) : [Voir une démonstration] s'ajoute à côté du titre de la galerie, quand l'appelant
// passe `onDemonstration`. Son libellé vient de construction-texts.ts. Aucune constante propre au mode Simple n'est ajoutée :
// la galerie n'existe que si l'onglet la monte, donc si les équipes sont ouvertes dans le mode courant (U1, D-5-24).
// </c5:demonstration-equipe-doc>
import { useState } from "react";
import { Modal } from "../../../components/ui.tsx";
import { FlowList } from "./FlowList.tsx";
import { FlowSchema } from "./FlowSchema.tsx";
import type { ExempleCardModel, GalerieModel } from "./teams-tab-model.ts";
// <c5:demonstration-equipe-import>
import { TEXTES as TEXTES_CONSTRUCTION } from "../../../../server/shared/construction-texts.ts";
// </c5:demonstration-equipe-import>

export interface TeamGalleryProps {
  galerie: GalerieModel;
  /** [Installer] : l'exemple passe à la boîte d'installation. */
  onInstaller: (id: string) => void;
  // <c5:demonstration-equipe-propriete>
  /**
   * [Voir une démonstration] (spéc. §5.3 l.896) : absent, le bouton n'est pas montré. La galerie n'est montée que lorsque les
   * équipes sont ouvertes dans le mode courant (U1, D-5-24) : aucune constante propre n'est lue ici.
   */
  onDemonstration?: () => void;
  // </c5:demonstration-equipe-propriete>
}

// <c5:demonstration-equipe-signature>
// Itération 5 (L49) : `onDemonstration` s'ajoute aux propriétés reçues ; le reste de la galerie est celui de l'itération 4.
export function TeamGallery({ galerie, onInstaller, onDemonstration }: TeamGalleryProps) {
  // </c5:demonstration-equipe-signature>
  const [apercu, setApercu] = useState<ExempleCardModel | null>(null);
  return (
    <section className="stack">
      <h2 className="tm-galerie-titre">{galerie.titre}</h2>
      {/* <c5:demonstration-equipe-bouton> */}
      {/* [Voir une démonstration] (spéc. §5.3 l.896) : sous le titre de la galerie, et seulement si l'appelant le demande. */}
      {onDemonstration ? (
        <div className="row wrap">
          <button type="button" className="btn" onClick={onDemonstration}>
            {TEXTES_CONSTRUCTION.partout.demonstration.voir}
          </button>
        </div>
      ) : null}
      {/* </c5:demonstration-equipe-bouton> */}
      <div className="tm-galerie">
        {galerie.exemples.map((exemple) => (
          <article key={exemple.id} className="card tm-exemple">
            <div className="stack tight">
              <h3 className="tm-exemple-titre">{exemple.titre}</h3>
              <p className="secondary tm-exemple-phrase">{exemple.description}</p>
              <p className="row wrap tiny secondary tm-exemple-meta">
                {exemple.cout ? <span className="tm-exemple-cout">{exemple.cout}</span> : null}
                <span className="badge tm-exemple-lecture">{exemple.lectureSeule}</span>
              </p>
            </div>
            <FlowList
              liste={exemple.liste}
              libelle={exemple.libelleSchema}
              schema={<FlowSchema layout={exemple.layout} mini />}
            />
            <div className="row wrap tm-exemple-actions">
              <button type="button" className="btn" onClick={() => setApercu(exemple)}>
                {exemple.libelleApercu}
              </button>
              <button
                type="button"
                className="btn primary"
                aria-disabled={!exemple.installable}
                onClick={() => {
                  if (exemple.installable) onInstaller(exemple.id);
                }}
              >
                {exemple.libelleInstaller}
              </button>
            </div>
          </article>
        ))}
      </div>
      <Modal open={apercu !== null} wide title={apercu?.titre ?? ""} onClose={() => setApercu(null)}>
        {apercu ? (
          <div className="stack">
            <p className="secondary">{apercu.description}</p>
            <FlowList liste={apercu.liste} libelle={apercu.libelleSchema} schema={<FlowSchema layout={apercu.layout} />} toujoursVisible />
          </div>
        ) : null}
      </Modal>
    </section>
  );
}
