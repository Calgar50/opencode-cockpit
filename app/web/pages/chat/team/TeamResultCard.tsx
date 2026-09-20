// Propriétaire : L38b.
// Carte de résultat d'une équipe (C §9.6 ; spécification §6 l.1035) : titre, « Rédigé par l'étape … puis recopié ici par le
// cockpit, sans appel d'IA. », le résultat rendu par le composant Markdown existant (assaini par DOMPurify : aucun texte d'IA
// inséré en HTML brut), le résumé chiffré et « À vérifier par vous : … ». Mode « carte seule » (D-eq-14) ou injection refusée :
// [Ajouter à la conversation] (onAdd).
// EXPORTÉ et réutilisé par L38c (V3) dans la transcription : propriétés figées {run, texte, advanced, onAdd?}. Aucun texte écrit
// ici (team-texts.ts par team-view-model.ts) ; aucune animation ; aucune région aria-live propre.
import { useMemo } from "react";
import type { TeamRunView } from "../../../../server/shared/team-types.ts";
import { Icon } from "../../../components/Icon.tsx";
import { Markdown } from "../../../components/Markdown.tsx";
import { Button } from "../../../components/ui.tsx";
import { modeleResultat } from "./team-view-model.ts";
import "./team-cards.css";

export interface TeamResultCardProps {
  run: TeamRunView;
  /** Texte du résultat (extrait gardé par le cockpit, ou texte du message injecté relu par la transcription). */
  texte: string;
  advanced: boolean;
  /** Présent : [Ajouter à la conversation] (mode carte seule ou injection refusée) ; absent : rien à ajouter. */
  onAdd?: () => void;
}

export function TeamResultCard({ run, texte, advanced, onAdd }: TeamResultCardProps) {
  const modele = useMemo(() => modeleResultat(run, texte, advanced), [run, texte, advanced]);
  return (
    <section className="team-card team-result" aria-label={modele.titre}>
      <h3 className="team-card-title">
        <Icon name="check" className="team-icon" />
        <span>{modele.titre}</span>
      </h3>
      <p className="team-card-note">{modele.redige}</p>
      {modele.iaEquipe === null ? null : <p className="team-card-note">{modele.iaEquipe}</p>}
      {modele.texte === "" ? null : <Markdown text={modele.texte} className="team-result-text" />}
      <p className="team-card-note tabular">{modele.resume}</p>
      <p className="team-card-verifier">
        <Icon name="alert" className="team-icon" />
        <span>{modele.aVerifier}</span>
      </p>
      {onAdd === undefined ? null : (
        <div className="team-card-actions">
          <Button variant="primary" onClick={onAdd}>
            {modele.ajouter}
          </Button>
        </div>
      )}
    </section>
  );
}
