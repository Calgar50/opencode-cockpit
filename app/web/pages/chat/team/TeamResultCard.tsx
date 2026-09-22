// Propriétaire : L38b.
// Carte de résultat d'une équipe (C §9.6 ; spécification §6 l.1035) : titre, « Rédigé par l'étape … puis recopié ici par le
// cockpit, sans appel d'IA. », le résultat rendu par le composant Markdown existant (assaini par DOMPurify : aucun texte d'IA
// inséré en HTML brut), le résumé chiffré et « À vérifier par vous : … ». Mode « carte seule » (D-eq-14) ou injection refusée :
// [Ajouter à la conversation] (onAdd).
// EXPORTÉ et réutilisé par L38c (V3) dans la transcription : propriétés figées {run, texte, advanced, onAdd?}. Aucun texte écrit
// ici (team-texts.ts par team-view-model.ts) ; aucune animation ; aucune région aria-live propre.
// 5b (L42c) : le livrable d'une relecture porte un « Journal de relecture » et ses notes d'honnêteté. Le modèle les DÉCOUPE du
// résultat (il ne les réécrit jamais) : le journal est rendu REPLIÉ, dans un <details> fermé, et les notes restent visibles sous
// le résultat — « Non relue après la dernière correction. », « Relecture non conclue après {n} tours : … ».
// 5b (L42c) : le livrable d'un aiguillage où AUCUN spécialiste ne convenait porte sa phrase et, quand le bloc nomme un repli,
// « Pour une explication générale, envoyez votre demande à « {assistant} ». ». Les deux phrases restent dans le résultat rendu
// ci-dessous ; la carte n'ajoute que [Envoyer à cet assistant], qui PRÉREMPLIT le composeur et N'ENVOIE RIEN.
// 5b (L44f) : [Seconde lecture (≈ {x} $)] SOUS la carte, par le bouton de L44e avec `cible="equipe"` (variante de texte du §4.3,
// D-5-06, D-5-22) — aucun texte, aucun montant et aucun envoi ne sont écrits ici. La carte ne décide que du QUAND :
//   - équipes fermées dans le mode courant (U1, D-5-24) : rien n'est proposé, et la SEULE valeur qui les ouvre en Simple est
//     `ouvertesEnSimple` de GET /api/teams, comme pour le lanceur et les cartes — aucune constante propre ;
//   - une équipe travaille ou attend dans cette conversation : le proxy refuserait l'envoi (409 `equipe-en-cours`, D-eq-16), le
//     bouton est donc MASQUÉ, pas seulement éteint — proposer un montant pour un envoi impossible serait malhonnête (P3).
import { useEffect, useMemo, useState } from "react";
import type { TeamRunView } from "../../../../server/shared/team-types.ts";
import { Icon } from "../../../components/Icon.tsx";
import { Markdown } from "../../../components/Markdown.tsx";
import { Button } from "../../../components/ui.tsx";
import { teamsApi } from "../../../lib/api-teams.ts";
import { errorText } from "../../../lib/api.ts";
import { SecondReadingButton } from "../methods/SecondReadingButton.tsx";
import { boundedAiText } from "../turn.ts";
import { type ComposeurPrerempli, EVENEMENT_COMPOSEUR, modeleResultat, verrouDe } from "./team-view-model.ts";
import { useTeamRuns } from "./useTeamRuns.ts";
import "./team-cards.css";
import "./team-choice.css";

/** Titre d'équipe relayé au plus, comme les cartes : il est écrit par vous, et le message de seconde lecture le reprend. */
const TITRE_MAX = 120;

/**
 * Équipes ouvertes dans le mode courant (U1, D-5-24). En Avancé elles le sont toujours : aucune lecture n'est faite. Une
 * lecture impossible laisse les équipes FERMÉES, jamais supposées ouvertes (même règle que TeamRunCards et le lanceur).
 */
function useEquipesOuvertes(advanced: boolean): boolean {
  const [ouvertesEnSimple, setOuvertesEnSimple] = useState(false);
  useEffect(() => {
    if (advanced) return undefined;
    const controller = new AbortController();
    teamsApi.list(controller.signal).then(
      (reponse) => setOuvertesEnSimple(reponse.ouvertesEnSimple === true),
      (err: unknown) => {
        if (!controller.signal.aborted) console.warn("équipes : ouverture en mode Simple illisible", errorText(err));
      },
    );
    return () => controller.abort();
  }, [advanced]);
  return advanced || ouvertesEnSimple;
}

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
  // L44f : lancements DÉJÀ chargés par la carte (une seule requête par racine, partagée) ; le même `verrouDe` que le verrou de
  // la saisie dit qu'une équipe travaille ou attend dans cette conversation — une seule règle pour les deux.
  const { runs } = useTeamRuns(run.rootId);
  const secondeLectureProposee = useEquipesOuvertes(advanced) && verrouDe(runs) === null;
  /**
   * [Envoyer à cet assistant] : la demande à recopier et l'assistant de repli sont PUBLIÉS pour la page du chat, qui remplit la
   * saisie et choisit l'assistant. RIEN n'est envoyé ici — aucune requête, aucun coût, et le focus n'est pas déplacé.
   */
  const preremplir = (assistant: string) => {
    const detail: ComposeurPrerempli = { assistant, rootId: run.rootId, runId: run.id, demandeMessageId: run.requestMessageId };
    window.dispatchEvent(new CustomEvent(EVENEMENT_COMPOSEUR, { detail }));
  };
  // Repli d'un aiguillage « aucun ne convient » : le bouton n'existe QUE si le livrable nomme l'assistant (P3).
  const repli = modele.aucun !== null && modele.aucun.assistant !== null && modele.aucun.envoyer !== null ? { assistant: modele.aucun.assistant, envoyer: modele.aucun.envoyer } : null;
  return (
    <section className="team-card team-result" aria-label={modele.titre}>
      <h3 className="team-card-title">
        <Icon name="check" className="team-icon" />
        <span>{modele.titre}</span>
      </h3>
      <p className="team-card-note">{modele.redige}</p>
      {modele.iaEquipe === null ? null : <p className="team-card-note">{modele.iaEquipe}</p>}
      {modele.texte === "" ? null : <Markdown text={modele.texte} className="team-result-text" />}
      {modele.notes.map((note) => (
        <p key={note} className="team-card-note">
          {note}
        </p>
      ))}
      {modele.journal === null ? null : (
        <details className="team-journal">
          <summary className="team-journal-titre">{modele.journal.titre}</summary>
          <Markdown text={modele.journal.texte} className="team-result-text" />
        </details>
      )}
      {repli === null ? null : (
        <div className="team-card-actions team-aucun-actions">
          <Button size="sm" onClick={() => preremplir(repli.assistant)}>
            {repli.envoyer}
          </Button>
        </div>
      )}
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
      {/* L44f : EN DERNIER, sous le résultat et sous « À vérifier par vous » — la seconde lecture relit ce qui précède. */}
      {secondeLectureProposee ? (
        <SecondReadingButton
          sessionId={run.rootId}
          cle={`equipe-${run.id}`}
          cible="equipe"
          assistant={boundedAiText(run.titre, TITRE_MAX).text}
          terminee
          repere={false}
          estSecondeLecture={false}
        />
      ) : null}
    </section>
  );
}
