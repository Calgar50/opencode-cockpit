// Propriétaire : L38b.
// Bloc de pause d'une carte d'équipe (C §9.5) : message de la pause, « Résumé transmis (modifiable) » (zone préremplie du résultat
// transmis, 24 000 caractères), « Précision pour la suite (facultatif) », « Rien n'est facturé pendant la pause. », puis
// [Continuer l'équipe (≈ {suite} $ de plus, {auPlus} $ au plus)] et [Arrêter l'équipe]. Pauses de budget, de modification
// d'assistant et de redémarrage du cockpit avec leurs textes ; PAUSE DE FRAÎCHEUR (genre `changement`, D-eq-17) : la phrase de la
// raison et [Continuer l'équipe] (le serveur refait le contrôle et la carte reste en pause avec la raison à jour s'il échoue
// encore), [Arrêter l'équipe].
// Une pause de budget confirme le garde-fou budgétaire (x-cockpit-confirm: 1). Textes et boutons : team-view-model.ts (T4t).
// 5b (L42c) : PAUSE DE CHOIX d'un aiguillage — titre, phrase de proposition avec la raison de l'aiguilleur (masquée, texte rendu
// par React donc échappé), cases à cocher (les proposées cochées ; RIEN de coché quand le choix est illisible, et la carte le
// dit), « {n} au maximum. », puis [Continuer avec {n} spécialiste(s) (≈ {x} $)] — le coût de la SUITE —, [Aucun ne convient] et
// [Arrêter l'équipe]. [Aucun ne convient] répond au serveur ; le lancement se termine alors, et c'est la carte de RÉSULTAT qui
// porte la suite du chemin « aucun » (les deux phrases du livrable et [Envoyer à cet assistant]), seul endroit où l'assistant
// de repli parvient à l'interface.
// Le focus n'est jamais pris : aucun autoFocus, aucun appel à .focus() ; le bloc porte l'identifiant `teamPauseElementId(runId)`
// pour qu'un renvoi (le [Répondre] du bandeau) y mène sur un clic de l'utilisateur.
import { useId, useMemo, useState } from "react";
import { basculer } from "../../../../server/shared/team-choice-view.ts";
import { Icon } from "../../../components/Icon.tsx";
import { Button } from "../../../components/ui.tsx";
import { modeleChoix, type TeamChoixEntree, type TeamPauseModel } from "./team-view-model.ts";
// <c5:reprise-redemarrage>
import type { TeamRepriseModel } from "./team-view-model.ts";
// </c5:reprise-redemarrage>
import "./team-choice.css";

export interface TeamPauseCardProps {
  pause: TeamPauseModel;
  /** Identifiant du bloc, cible d'un renvoi depuis le bandeau (teamPauseElementId). */
  blocId: string;
  /** Appel en cours : les deux boutons attendent. */
  occupe: boolean;
  /** `correction` : résumé transmis modifié ; `precision` : précision pour la suite ; `choix`/`aucun` : réponse d'un aiguillage. */
  onContinue: (corps: { precision?: string; correction?: string; choix?: string[]; aucun?: true }, confirme: boolean) => void;
  onStop: () => void;
  // <c5:reprise-redemarrage>
  /** Clôture 5b (D-5b-1) : [Refaire l'estimation de la suite] d'une pause reprise après un redémarrage du cockpit. */
  onReprendre: () => void;
  // </c5:reprise-redemarrage>
}

// <c5:reprise-redemarrage>
/** Note d'une pause reprise après un redémarrage : ce qui s'est passé et ce qu'il reste à faire (D-5b-1), en texte seul. */
function NoteReprise({ reprise, id }: { reprise: TeamRepriseModel; id: string }) {
  return (
    <p id={id} className="team-card-note team-choice-illisible">
      <Icon name="alert" className="team-icon" />
      <span>{reprise.note}</span>
    </p>
  );
}
// </c5:reprise-redemarrage>

/** Cases de la carte de choix : une case par spécialiste, le MOT du titre à côté (jamais la couleur seule). */
function ChoixCases({
  entree,
  occupe,
  gratuite,
  onContinue,
  onStop,
  onAucun,
  // <c5:reprise-redemarrage>
  reprise,
  onReprendre,
  // </c5:reprise-redemarrage>
}: {
  entree: TeamChoixEntree;
  occupe: boolean;
  /** « Rien n'est facturé pendant la pause. » : écrite AVANT les boutons, jamais sous eux. */
  gratuite: string | null;
  onContinue: (choix: string[]) => void;
  onStop: () => void;
  onAucun: () => void;
  // <c5:reprise-redemarrage>
  /** Pause reprise après un redémarrage (D-5b-1) : vos spécialistes attendent la nouvelle estimation ; « aucun » non, s'il ne lance rien. */
  reprise: TeamRepriseModel | null;
  onReprendre: () => void;
  // </c5:reprise-redemarrage>
}) {
  const baseId = useId();
  const [selection, setSelection] = useState<string[] | null>(null);
  const vue = useMemo(() => modeleChoix(entree, selection), [entree, selection]);
  const retenus = vue.cases.filter((c) => c.coche).map((c) => c.stepId);
  // <c5:reprise-redemarrage>
  // Le choix reste le vôtre (spéc. l.772) : la carte revient après la nouvelle estimation, et rien n'est coché à votre place.
  const continuerActif = reprise === null && vue.continuerActif;
  const aucunActif = reprise === null || reprise.aucunLibre;
  const noteId = `${baseId}-reprise`;
  // </c5:reprise-redemarrage>
  return (
    <div className="team-choice">
      <p className="team-pause-title">{vue.titre}</p>
      {vue.proposition === null ? null : <p className="team-card-note">{vue.proposition}</p>}
      {/* <c5:reprise-redemarrage> */}
      {reprise === null ? null : <NoteReprise reprise={reprise} id={noteId} />}
      {/* </c5:reprise-redemarrage> */}
      {vue.illisible === null ? null : (
        <p className="team-card-note team-choice-illisible">
          <Icon name="alert" className="team-icon" />
          <span>{vue.illisible}</span>
        </p>
      )}
      <ul className="team-choice-list">
        {vue.cases.map((option) => (
          <li key={option.stepId} className="team-choice-item">
            <input
              type="checkbox"
              id={`${baseId}-${option.stepId}`}
              checked={option.coche}
              disabled={occupe}
              onChange={() => setSelection(basculer(entree.options, retenus, option.stepId, vue.choixMax))}
            />
            <label htmlFor={`${baseId}-${option.stepId}`}>{option.titre}</label>
          </li>
        ))}
      </ul>
      <p className="team-card-note">{vue.maximum}</p>
      {gratuite === null ? null : <p className="team-card-note">{gratuite}</p>}
      <div className="team-card-actions">
        {/* <c5:reprise-redemarrage> */}
        {reprise === null || reprise.bouton === null ? null : (
          <Button variant="primary" disabled={occupe} onClick={onReprendre}>
            {reprise.bouton}
          </Button>
        )}
        <Button
          variant={reprise === null ? "primary" : "default"}
          disabled={occupe}
          aria-disabled={!continuerActif}
          aria-describedby={reprise === null ? undefined : noteId}
          title={reprise?.raison ?? undefined}
          onClick={() => (continuerActif ? onContinue(retenus) : undefined)}
        >
          {vue.continuer}
        </Button>
        <Button
          disabled={occupe}
          aria-disabled={!aucunActif}
          aria-describedby={aucunActif ? undefined : noteId}
          title={aucunActif ? undefined : reprise?.raison}
          onClick={() => (aucunActif ? onAucun() : undefined)}
        >
          {vue.aucunConvient}
        </Button>
        {/* </c5:reprise-redemarrage> */}
        <Button variant="danger" disabled={occupe} onClick={onStop}>
          {vue.arreter}
        </Button>
      </div>
    </div>
  );
}

// <c5:reprise-redemarrage>
export function TeamPauseCard({ pause, blocId, occupe, onContinue, onStop, onReprendre }: TeamPauseCardProps) {
  // </c5:reprise-redemarrage>
  const baseId = useId();
  const [resume, setResume] = useState<string | null>(null);
  const [precision, setPrecision] = useState("");
  const resumeCourant = resume ?? pause.resume?.texte ?? "";

  const continuer = () => {
    const corps: { precision?: string; correction?: string } = {};
    if (pause.precision !== null && precision.trim() !== "") corps.precision = precision.trim();
    if (pause.resume !== null && resumeCourant !== pause.resume.texte) corps.correction = resumeCourant;
    onContinue(corps, pause.confirme);
  };

  return (
    <div className="team-pause" id={blocId}>
      {pause.choix === null ? <p className="team-pause-title">{pause.titre}</p> : null}
      {pause.message === "" ? null : <p className="team-card-note">{pause.message}</p>}
      {/* <c5:reprise-redemarrage> */}
      {pause.choix !== null || pause.reprise === null ? null : <NoteReprise reprise={pause.reprise} id={`${baseId}-reprise`} />}
      {/* </c5:reprise-redemarrage> */}
      {pause.choix === null ? null : (
        <ChoixCases
          entree={pause.choix}
          occupe={occupe}
          gratuite={pause.gratuite}
          onContinue={(choix) => onContinue({ choix }, false)}
          onStop={onStop}
          onAucun={() => onContinue({ aucun: true }, false)}
          // <c5:reprise-redemarrage>
          reprise={pause.reprise}
          onReprendre={onReprendre}
          // </c5:reprise-redemarrage>
        />
      )}
      {pause.resume === null ? null : (
        <div className="team-pause-field">
          <p className="team-card-note">{pause.resume.entete}</p>
          <label htmlFor={`${baseId}-resume`}>{pause.resume.libelle}</label>
          <textarea
            id={`${baseId}-resume`}
            className="team-pause-textarea"
            rows={6}
            maxLength={pause.resume.max}
            value={resumeCourant}
            onChange={(event) => setResume(event.target.value)}
          />
        </div>
      )}
      {pause.precision === null ? null : (
        <div className="team-pause-field">
          <label htmlFor={`${baseId}-precision`}>{pause.precision.libelle}</label>
          <textarea
            id={`${baseId}-precision`}
            className="team-pause-textarea"
            rows={2}
            maxLength={pause.precision.max}
            value={precision}
            aria-describedby={`${baseId}-aide`}
            onChange={(event) => setPrecision(event.target.value)}
          />
          <p id={`${baseId}-aide`} className="team-card-note">
            {pause.precision.aide}
          </p>
        </div>
      )}
      {pause.gratuite === null || pause.choix !== null ? null : <p className="team-card-note">{pause.gratuite}</p>}
      {pause.boutons.length === 0 ? null : (
        <div className="team-card-actions">
          {pause.boutons.map((bouton) => (
            <Button
              key={bouton.action}
              variant={bouton.allure === "danger" ? "danger" : bouton.allure === "primary" ? "primary" : "default"}
              disabled={occupe || bouton.desactive}
              title={bouton.raison ?? undefined}
              // <c5:reprise-redemarrage>
              onClick={bouton.action === "arreter" ? onStop : bouton.action === "relancer" ? onReprendre : continuer}
              // </c5:reprise-redemarrage>
            >
              {bouton.libelle}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
