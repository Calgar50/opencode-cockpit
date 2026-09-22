// Propriétaire : L26a (déplacé depuis L26b par D-2b-45).
// Bandeau PERMANENT d'une conversation de la Salle OMO (spécification §4.12 l.784, §5.5, §5.6, JP-10) :
// « Salle OMO · extension active · actions non contrôlées avant exécution · {x} $ sur {montant} $ » [Arrêter] [Journal].
// - toute la décision (texte, montants, présence du bandeau, annonce) est dans le modèle pur shared/omo-activation-view.ts :
//   ce composant ne fait que la rendre, sans texte ni condition à lui ;
// - [Arrêter] appelle stopOmo (POST /api/omo/rooms/:rootId/stop, D-2b-30), jamais l'arrêt de l'instance principale ;
// - annonces POLIES par l'annonceur de la page (L5b) : une seule région aria-live pour tout le cockpit, au plus une annonce
//   toutes les 2 s, coupée par ui.activityAnnouncements. Ce composant ne crée aucune région ;
// - aucune animation ; l'enceinte de la bande néon arrive avec L25b (vague 4), rien n'est dessiné ici.
import { useEffect, useRef, useState } from "react";
import { annonceBandeau, type VueBandeau, vueBandeau } from "../../../server/shared/omo-activation-view.ts";
import { useApp } from "../../app/AppContext.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Button } from "../../components/ui.tsx";
import { useAnnouncer } from "../../lib/announcer.ts";
import { errorText } from "../../lib/api.ts";
import { stopOmo } from "../../lib/api-omo.ts";
import "./omo-banner.css";

export interface OmoBannerProps {
  rootId: string;
  /**
   * Dépense de la demande en cours, en dollars ; null : pas encore connue. Le compteur de la salle arrive avec la surveillance
   * après coup de `usage.updated` (L22c, L23b) : tant qu'il n'est pas branché, le bandeau dit « — », jamais 0,00 (P3).
   */
  depenseUsd: number | null;
  /** Montant d'arrêt saisi à l'activation, tel quel ; null : aucune demande confirmée. */
  plafondSaisi: string | null;
  demandeActive: boolean;
  /** Ouvre le Journal du contrôle (L26b) ; absent : le bouton n'est pas rendu. */
  onOpenJournal?: () => void;
  /** Prévient la page qu'un arrêt a abouti (relecture de l'état de la salle). */
  onStopped?: () => void;
}

export function OmoBanner({ rootId, depenseUsd, plafondSaisi, demandeActive, onOpenJournal, onStopped }: OmoBannerProps) {
  const { ui } = useApp();
  const say = useAnnouncer(ui.activityAnnouncements);
  const [arretEnCours, setArretEnCours] = useState(false);
  const [echec, setEchec] = useState<string | null>(null);
  /** Dernier bandeau rendu : les annonces disent les TRANSITIONS, jamais ce qu'une première lecture révèle. */
  const precedent = useRef<VueBandeau | null>(null);

  const vue = vueBandeau({ depenseUsd, plafondSaisi, demandeActive });

  useEffect(() => {
    const phrase = annonceBandeau(precedent.current, vue);
    precedent.current = vue;
    if (phrase !== null) say(phrase);
  });

  if (vue === null) return null;

  const arreter = () => {
    setArretEnCours(true);
    setEchec(null);
    stopOmo(rootId).then(
      () => {
        setArretEnCours(false);
        onStopped?.();
      },
      (err: unknown) => {
        setArretEnCours(false);
        setEchec(errorText(err));
      },
    );
  };

  return (
    <div className="omo-banner">
      <p className="omo-banner-resume">
        <Icon name="shield" size={14} />
        <span>{vue.texte}</span>
      </p>
      <div className="omo-banner-actions">
        <Button size="sm" variant="danger" icon="stop" loading={arretEnCours} onClick={arreter}>
          {vue.arreter}
        </Button>
        {onOpenJournal ? (
          <Button size="sm" variant="ghost" icon="list" onClick={onOpenJournal}>
            {vue.journal}
          </Button>
        ) : null}
      </div>
      {echec ? (
        <p className="field-error" role="alert">
          {echec}
        </p>
      ) : null}
    </div>
  );
}
