// Propriétaire : L49.
// Démonstration d'équipe enregistrée (spécification §5.3 l.896, §5.4 l.909, §5.9 l.1013-1017, §6 l.1064, JP-9 ; D-5-15) :
// le déroulé « Avis indépendants » joué à l'avance par l'exécuteur de l'itération 4 sur le faux opencode
// (server/test-support/gen-demo-equipe.ts) est rejoué moment par moment dans le lecteur de l'itération 1 (DemoPlayer, propriété
// `demo`), qui dessine la bande néon ; sous la bande, ce composant dessine la carte d'exécution et le Déroulé de l'itération 4.
// - AUCUNE IA appelée, AUCUNE requête : tout vient de `demo-equipe.json`, livré avec l'interface. Ce module n'importe ni le
//   client de l'API (web/lib/api*.ts), ni le proxy, ni fetch : seulement des modèles PURS (team-view-model.ts, deroule-model.ts)
//   et les textes de la construction (demo-equipe.test.ts le vérifie par un examen statique des imports).
// - Données FICTIVES : l'équipe, ses étapes, ses assistants et leurs réponses sont inventés, et les heures sont celles des
//   moments, pas celles d'un enregistrement réel. La ligne « Déroulé enregistré avec des données fictives. » le dit.
// - Pas à pas : le curseur, [Moment précédent] et [Moment suivant] du lecteur, en « Moment n / N » — jamais le mot « étape »,
//   réservé aux étapes de l'équipe. AUCUNE lecture automatique, aucune animation : le mouvement réduit ne change rien ici.
// - Mode Simple : ce composant n'est monté que par l'onglet Équipes, qui suit `ouvertesEnSimple` (U1, D-5-24). Il ne lit
//   lui-même AUCUN réglage.
// - Accessibilité : la boîte, le curseur et le tableau sont ceux du lecteur ; l'état de chaque étape est dit par son MOT à côté
//   de son icône, jamais par la couleur seule, et les barres du Déroulé sont décoratives (leur durée est écrite à côté).
import { useId } from "react";
import { factProblem } from "../../../../server/shared/activity-facts.ts";
import type { ActivityFact } from "../../../../server/shared/activity-types.ts";
import { TEXTES } from "../../../../server/shared/construction-texts.ts";
import type { TeamRunView } from "../../../../server/shared/team-types.ts";
import { Icon } from "../../../components/Icon.tsx";
import { formatDuration } from "../../../lib/format.ts";
import { DemoPlayer } from "../../chat/activity/DemoPlayer.tsx";
import { buildTeamDeroule, coutCellule } from "../../chat/team/deroule-model.ts";
import { buildTeamRunCard, etapeResultat, modeleResultat } from "../../chat/team/team-view-model.ts";
import fichier from "./demo-equipe.json" with { type: "json" };
import "../../chat/activity/deroule.css";
import "../../chat/team/team-cards.css";
import "../../chat/team/team-deroule.css";

/** Un moment enregistré : les faits qu'il ajoute et la vue du lancement à cet instant (gen-demo-equipe.ts). */
interface DemoMoment {
  at: number;
  faits: ActivityFact[];
  run: TeamRunView;
}

const T = TEXTES.partout.demonstration;

/** Moments lus dans la fixture ; un moment sans vue de lancement est écarté, jamais montré à moitié. */
const MOMENTS: readonly DemoMoment[] = (fichier.moments as readonly unknown[]).filter((moment): moment is DemoMoment => {
  const lu = moment as Partial<DemoMoment>;
  return typeof lu?.at === "number" && Array.isArray(lu.faits) && typeof lu.run?.id === "string";
});

/** Faits de la démonstration ; un fait refusé par la garde des faits (texte, secret) est écarté, jamais montré. */
const FAITS: readonly ActivityFact[] = MOMENTS.flatMap((moment) => moment.faits).filter((fait) => factProblem(fait) === null);
/** Heures des moments : celles que le générateur a posées, croissantes. */
const INSTANTS: readonly number[] = MOMENTS.map((moment) => moment.at);

/** Carte d'exécution de l'itération 4, en lecture seule : aucun bouton, rien à arrêter ni à relancer dans un enregistrement. */
function DemoCarte({ run, advanced }: { run: TeamRunView; advanced: boolean }) {
  const modele = buildTeamRunCard(run, advanced);
  // La démonstration montre le résultat même quand le lancement l'a déjà déposé dans la conversation : la carte de résultat de
  // l'itération 4 ne se rend qu'avant le dépôt (un seul exemplaire), et l'enregistrement va jusqu'au dépôt.
  const resultat = modele.resultat ?? (run.state === "terminee" ? modeleResultat(run, etapeResultat(run)?.extrait ?? "", advanced) : null);
  return (
    <article className="team-card">
      <div className="team-card-head">
        <span className="team-card-title">{modele.entete}</span>
        <span className="team-card-state">
          <Icon name={modele.etatIcone} size={14} className="team-icon" />
          {modele.etatMot}
        </span>
      </div>
      <ol className="team-steps">
        {modele.lignes.map((ligne) => (
          <li key={ligne.cle} className="team-step">
            <div className="team-step-main">
              <span className="team-step-state">
                <Icon name={ligne.icone} size={14} className="team-icon" />
                {ligne.mot}
              </span>
              <span className="ellipsis">{ligne.titre}</span>
            </div>
            {ligne.detail === "" ? null : <div className="team-step-detail">{ligne.detail}</div>}
            {ligne.cause === null ? null : <div className="team-step-note">{ligne.cause}</div>}
          </li>
        ))}
      </ol>
      {modele.message === null ? null : <p className="team-card-message">{modele.message}</p>}
      {modele.pause === null ? null : <p className="team-card-message">{modele.pause.message}</p>}
      {resultat === null ? null : (
        <div className="stack tight">
          <p className="team-card-title">{resultat.titre}</p>
          <p className="team-card-note">{resultat.redige}</p>
          <p className="team-result-text">{resultat.texte}</p>
          <p className="team-card-verifier">{resultat.aVerifier}</p>
        </div>
      )}
    </article>
  );
}

/**
 * Déroulé « Prévu / Réel » de l'itération 4, réduit à ce qu'un enregistrement peut montrer : une ligne par étape, son état dit
 * par son mot, sa durée et son coût écrits à côté. Les barres sont décoratives (aria-hidden) : la vérité est le texte.
 */
function DemoDeroule({ run, advanced, at }: { run: TeamRunView; advanced: boolean; at: number }) {
  const legendeId = useId();
  const modele = buildTeamDeroule(run, advanced, at);
  return (
    <figure className="deroule-figure" aria-labelledby={legendeId}>
      <figcaption id={legendeId} className="tiny muted">
        {`${modele.titre} · ${modele.bilan}`}
      </figcaption>
      <ol className="deroule-rows">
        {modele.lignes.map((ligne) => (
          <li key={ligne.cle} className="deroule-row">
            <div className="deroule-who">
              <span className="deroule-name ellipsis">{ligne.titre}</span>
              <span className="deroule-state nowrap">
                <Icon name={ligne.icone} size={12} />
                {ligne.reel}
              </span>
              <span className="tiny muted nowrap tabular">
                {ligne.durationMs === null ? coutCellule(ligne.cost) : `${formatDuration(ligne.durationMs)} · ${coutCellule(ligne.cost)}`}
              </span>
            </div>
            <div className="deroule-track" aria-hidden="true">
              {ligne.bars.map((barre, index) => (
                <span key={`${barre.kind}-${index}`} className={`deroule-bar deroule-bar--${barre.kind}`} style={{ left: `${barre.left}%`, width: `${barre.width}%` }} />
              ))}
            </div>
          </li>
        ))}
      </ol>
    </figure>
  );
}

export interface TeamDemoProps {
  /** Mode de l'utilisateur, passé au lecteur et aux modèles de l'itération 4. */
  advanced: boolean;
  onClose: () => void;
}

/** Démonstration d'équipe : le lecteur de l'itération 1, nourri par la fixture, avec la carte et le Déroulé sous la bande. */
export function TeamDemo({ advanced, onClose }: TeamDemoProps) {
  return (
    <DemoPlayer
      advanced={advanced}
      onClose={onClose}
      demo={{
        titre: T.titre,
        faits: FAITS,
        moments: INSTANTS,
        rendre: ({ rang }) => {
          const moment = MOMENTS[Math.min(Math.max(rang, 0), MOMENTS.length - 1)];
          if (!moment) return null;
          return (
            <div className="stack">
              <p className="tiny muted">{T.phrase}</p>
              <DemoCarte run={moment.run} advanced={advanced} />
              <DemoDeroule run={moment.run} advanced={advanced} at={moment.at} />
            </div>
          );
        },
      }}
    />
  );
}
