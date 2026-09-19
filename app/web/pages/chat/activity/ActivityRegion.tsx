// Propriétaire : L5b.
// « Qui travaille ? » : liste des acteurs, bandeau et bande néon 2D (NeonBand, L5c) d'une conversation, entre l'en-tête et le
// fil (spécification §5.1, §5.4, §5.5, §5.7.4). Propriétés figées dans ../slots.ts.
// - useActivity : relecture à l'ouverture et à la reconnexion, au plus 4 rendus par seconde ;
// - onTreeWorking : l'arbre travaille (racine, travail délégué, contrôles, attente de votre accord) → « Arrêter » reste visible ;
// - bande néon au-dessus de la liste des acteurs, qui reste la vérité. Une demande qui attend votre réponse ne replie rien en mode
//   Avancé (clôture de l'itération 1 : la carte montre l'attente de votre accord et la préparation, sans clic) ; en mode Simple,
//   bande et liste se replient sur leur ligne de tête tant qu'elle attend (replierPendantLaDemande) ;
// - annonces des transitions par l'annonceur de la page (une région aria-live, au plus une annonce toutes les 2 s), coupées par
//   `ui.activityAnnouncements` ;
// - premier bandeau : phrase d'accueil, puis `ui.seenOnboarding` écrit par l'API des réglages (PUT /api/settings) ;
// - [Voir une démonstration] de la bande : DemoPlayer (L5d), démonstration enregistrée, sans aucune requête.
import { useCallback, useEffect, useRef, useState } from "react";
import { phrasesAnnonces, TEXTES } from "../../../../server/shared/activity-texts.ts";
import type { ActivityAnnouncement } from "../../../../server/shared/activity.ts";
import { ID_RE } from "../../../../server/shared/ids.ts";
import { useApp } from "../../../app/AppContext.tsx";
import { useAnnouncer } from "../../../lib/announcer.ts";
import { formatDuration } from "../../../lib/format.ts";
import type { ActivityFact } from "../../../lib/types.ts";
import { bannerVisible, demandeEnAttente, onboardingToSave, replierPendantLaDemande, useActivity } from "../../../lib/useActivity.ts";
import type { ActivityRegionProps } from "../slots.ts";
import { DemoPlayer } from "./DemoPlayer.tsx";
import { NeonBand } from "./NeonBand.tsx";
import { WhoIsWorking } from "./WhoIsWorking.tsx";
import "./activity.css";

export function ActivityRegion(props: ActivityRegionProps) {
  // Le réducteur n'accepte qu'un identifiant de conversation opencode : sinon, rien à montrer.
  if (!ID_RE.test(props.rootId)) return null;
  return <Region {...props} />;
}

function Region({ rootId, directory, advanced, onTreeWorking, onOpenSession, onReply }: ActivityRegionProps) {
  const { ui, saveUi } = useApp();
  const say = useAnnouncer(ui.activityAnnouncements);
  const onAnnounce = useCallback((items: readonly ActivityAnnouncement[]) => say(phrasesAnnonces(items, formatDuration)), [say]);
  const activity = useActivity(rootId, directory, onAnnounce);
  const { working, loaded } = activity;

  useEffect(() => onTreeWorking(working), [working, onTreeWorking]);

  const visible = loaded && bannerVisible(activity.state, activity.rows, activity.status);
  // Une demande attend votre réponse (ligne avec [Répondre]).
  // - Mode Simple : la carte des agents et « Qui travaille ? » se replient (NeonBand, WhoIsWorking), la région garde ses deux lignes
  //   de tête (.attente, activity.css) et la place va à la carte de la demande.
  // - Mode Avancé : jamais de repli pour une demande ; quand la hauteur manque, la carte de la demande cède plus vite que la région,
  //   jusqu'à son titre et ses boutons (.demande, chat.css) ; ensuite la région se borne et défile, en gardant sa première ligne.
  const repliPourLaDemande = replierPendantLaDemande(advanced, activity.rows);
  let classe = "activity-region";
  if (repliPourLaDemande) classe = "activity-region attente";
  else if (demandeEnAttente(activity.rows)) classe = "activity-region demande";

  // Premier bandeau (§5.4) : la phrase reste pendant cette visite ; « vu » est écrit une seule fois, par l'API des réglages.
  const [welcome, setWelcome] = useState(false);
  const noted = useRef(false);
  useEffect(() => {
    const seenOnboarding = onboardingToSave(visible, ui.seenOnboarding);
    if (seenOnboarding === null || noted.current) return;
    noted.current = true;
    setWelcome(true);
    saveUi({ seenOnboarding }).catch((err: unknown) => {
      // Non enregistré : la phrase reviendra au prochain premier bandeau, rien d'autre ne change.
      console.warn("« Qui travaille ? » : accueil non enregistré", err);
    });
  }, [visible, saveUi, ui.seenOnboarding]);

  // Démonstration (L5d) : rappels stables, sinon la boîte de dialogue reprendrait le focus à chaque rendu.
  const [demonstration, setDemonstration] = useState(false);
  const ouvrirDemonstration = useCallback(() => setDemonstration(true), []);
  const fermerDemonstration = useCallback(() => setDemonstration(false), []);

  return (
    <div className={classe}>
      {/* Faits lus seulement (jamais modifiés) : le même tableau tant que rien ne change, pour la mémoïsation de la bande. Le dossier
          sert à relire les textes du zoom 3 dans la bonne instance d'opencode (train it1 V3, demande de L5c). */}
      <NeonBand
        rootId={rootId}
        facts={activity.state.facts as ActivityFact[]}
        advanced={advanced}
        directory={directory}
        onDemonstration={ouvrirDemonstration}
        repliPourLaDemande={repliPourLaDemande}
      />
      {demonstration ? <DemoPlayer advanced={advanced} onClose={fermerDemonstration} /> : null}
      {visible ? (
        <WhoIsWorking
          rows={activity.rows}
          advanced={advanced}
          working={working}
          repliPourLaDemande={repliPourLaDemande}
          partial={activity.partial}
          welcome={welcome}
          details={activity.details}
          onReply={onReply}
          onOpenSession={onOpenSession}
        />
      ) : null}
      {activity.failed ? (
        <p className="activity-failed small muted">
          <span>{TEXTES.partout.lectureImpossible}</span>
          <button type="button" className="btn sm ghost" onClick={activity.reload}>
            {TEXTES.partout.reessayer}
          </button>
        </p>
      ) : null}
    </div>
  );
}
