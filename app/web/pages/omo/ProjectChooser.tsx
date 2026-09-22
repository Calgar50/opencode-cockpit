// Propriétaire : L26a.
// Choix du projet préparé et résultat de son pré-contrôle (spécification §4.14.1 l.807-811 ; §3.15.2) :
// - la liste des projets préparés vient de GET /api/omo/status (L18c) : le cockpit n'en devine aucun ;
// - l'état git de chaque projet est dit avec la phrase de T3a, sans promesse de geste ;
// - le pré-contrôle part sur le projet choisi (GET /api/omo/precheck) ; un refus montre sa phrase et la liste MASQUÉE des
//   chemins trouvés, bornée par le serveur (20) et redite ici par le modèle pur ;
// - la salle s'ouvre ensuite par POST /api/omo/rooms, qui recontrôle le projet côté serveur : ce composant ne décide rien.
// Aucune animation.
import { useState } from "react";
import { TEXTES } from "../../../server/shared/omo-room-texts.ts";
import { type VuePrecontrole, vuePrecontrole } from "../../../server/shared/omo-activation-view.ts";
import type { OmoProjectGitState } from "../../../server/shared/omo-types.ts";
import { Icon } from "../../components/Icon.tsx";
import { Button, Card, Spinner } from "../../components/ui.tsx";
import { errorText } from "../../lib/api.ts";
import { estSalleCoupee, getOmoPrecheck, openOmoRoom, precheckRefuse } from "../../lib/api-omo.ts";

export interface ProjectChooserProps {
  /** Projets préparés lus dans GET /api/omo/status ; vide : rien à proposer. */
  projets: { chemin: string; git: OmoProjectGitState }[];
  /** La salle accepte d'ouvrir une conversation (état « prête »). */
  ouvrable: boolean;
  /** Une salle vient d'être ouverte sur ce projet. */
  onOuverte: (rootId: string, projet: string) => void;
}

export function ProjectChooser({ projets, ouvrable, onOuverte }: ProjectChooserProps) {
  const [choisi, setChoisi] = useState<string | null>(null);
  const [precontrole, setPrecontrole] = useState<VuePrecontrole | null>(null);
  const [occupe, setOccupe] = useState(false);
  const [echec, setEchec] = useState<string | null>(null);

  const controler = (projet: string) => {
    setChoisi(projet);
    setPrecontrole(null);
    setEchec(null);
    setOccupe(true);
    getOmoPrecheck(projet).then(
      (resultat) => {
        setOccupe(false);
        setPrecontrole(vuePrecontrole(resultat));
      },
      (err: unknown) => {
        setOccupe(false);
        const refuse = precheckRefuse(err);
        if (refuse !== null) setPrecontrole(vuePrecontrole(refuse));
        else if (!estSalleCoupee(err)) setEchec(errorText(err));
        else setEchec(TEXTES.avance.refus["salle-coupee"]);
      },
    );
  };

  const ouvrir = (projet: string) => {
    setOccupe(true);
    setEchec(null);
    openOmoRoom(projet).then(
      (salle) => {
        setOccupe(false);
        onOuverte(salle.rootId, salle.projet);
      },
      (err: unknown) => {
        setOccupe(false);
        const refuse = precheckRefuse(err);
        if (refuse !== null) setPrecontrole(vuePrecontrole(refuse));
        setEchec(errorText(err));
      },
    );
  };

  return (
    <Card title="Projet de la salle" subtitle="Les projets préparés pour la salle par l'installation, et eux seuls.">
      {projets.length === 0 ? (
        <p className="muted small">{TEXTES.avance.precontrole["non-prepare"]}</p>
      ) : (
        <ul className="omo-projets">
          {projets.map((projet) => (
            <li key={projet.chemin} className="omo-projet">
              <code className="omo-projet-chemin">{projet.chemin}</code>
              <span className="small muted">{TEXTES.avance.git[projet.git]}</span>
              <Button size="sm" onClick={() => controler(projet.chemin)} disabled={occupe}>
                Contrôler ce projet
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => ouvrir(projet.chemin)}
                disabled={occupe || !ouvrable || choisi !== projet.chemin || precontrole?.conforme !== true}
              >
                Ouvrir la salle ici
              </Button>
            </li>
          ))}
        </ul>
      )}
      {occupe ? <Spinner /> : null}
      {precontrole !== null && choisi !== null ? <Precontrole vue={precontrole} /> : null}
      {echec ? (
        <p className="field-error" role="alert">
          {echec}
        </p>
      ) : null}
    </Card>
  );
}

/** Résultat du pré-contrôle : verdict, phrase de la raison, liste masquée des chemins trouvés. */
function Precontrole({ vue }: { vue: VuePrecontrole }) {
  if (vue.conforme) {
    return (
      <p className="small" role="status">
        <Icon name="check" size={14} /> Projet contrôlé : <code>{vue.projet}</code>
      </p>
    );
  }
  return (
    <div role="status">
      <p className="field-error">{vue.phrase}</p>
      {vue.chemins.length > 0 ? (
        <>
          <p className="small muted">Chemins trouvés dans ce projet :</p>
          <ul className="omo-chemins">
            {vue.chemins.map((chemin) => (
              <li key={chemin}>
                <code>{chemin}</code>
              </li>
            ))}
          </ul>
          {vue.ecourtee ? <p className="small muted">Liste écourtée à {vue.chemins.length} chemins.</p> : null}
        </>
      ) : null}
    </div>
  );
}
