// Propriétaire : L38b.
// Bloc de pause d'une carte d'équipe (C §9.5) : message de la pause, « Résumé transmis (modifiable) » (zone préremplie du résultat
// transmis, 24 000 caractères), « Précision pour la suite (facultatif) », « Rien n'est facturé pendant la pause. », puis
// [Continuer l'équipe (≈ {suite} $ de plus, {auPlus} $ au plus)] et [Arrêter l'équipe]. Pauses de budget, de modification
// d'assistant et de redémarrage du cockpit avec leurs textes ; PAUSE DE FRAÎCHEUR (genre `changement`, D-eq-17) : la phrase de la
// raison et [Continuer l'équipe] (le serveur refait le contrôle et la carte reste en pause avec la raison à jour s'il échoue
// encore), [Arrêter l'équipe].
// Une pause de budget confirme le garde-fou budgétaire (x-cockpit-confirm: 1). Textes et boutons : team-view-model.ts (T4t).
import { useId, useState } from "react";
import { Button } from "../../../components/ui.tsx";
import type { TeamPauseModel } from "./team-view-model.ts";

export interface TeamPauseCardProps {
  pause: TeamPauseModel;
  /** Appel en cours : les deux boutons attendent. */
  occupe: boolean;
  /** `correction` : résumé transmis modifié ; `precision` : précision pour la suite. */
  onContinue: (corps: { precision?: string; correction?: string }, confirme: boolean) => void;
  onStop: () => void;
}

export function TeamPauseCard({ pause, occupe, onContinue, onStop }: TeamPauseCardProps) {
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
    <div className="team-pause">
      <p className="team-pause-title">{pause.titre}</p>
      {pause.message === "" ? null : <p className="team-card-note">{pause.message}</p>}
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
      {pause.gratuite === null ? null : <p className="team-card-note">{pause.gratuite}</p>}
      <div className="team-card-actions">
        {pause.boutons.map((bouton) => (
          <Button
            key={bouton.action}
            variant={bouton.allure === "danger" ? "danger" : bouton.allure === "primary" ? "primary" : "default"}
            disabled={occupe || bouton.desactive}
            title={bouton.raison ?? undefined}
            onClick={bouton.action === "arreter" ? onStop : continuer}
          >
            {bouton.libelle}
          </Button>
        ))}
      </div>
    </div>
  );
}
