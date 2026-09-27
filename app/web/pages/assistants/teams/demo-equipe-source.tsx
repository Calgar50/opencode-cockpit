// Propriétaire : L49 ; sorti de TeamDemo.tsx par GF5 (grande fusion, plan it5 §8.6 GF5 point 3, §2.8 ligne DemoPlayer).
// Démonstration d'équipe enregistrée, LUE ICI UNE SEULE FOIS pour ses deux lecteurs : le lecteur pas à pas de l'onglet Équipes
// (TeamDemo.tsx, démonstration passée) et, depuis GF5, le CHOIX du lecteur complet de « Revoir » (DemoPlayer.tsx, entrée « Comment
// se déroule une équipe », seulement si l'appelant la rend visible, U1). Deux modules plutôt qu'un import croisé : TeamDemo importe
// DemoPlayer, qui importe ce module ; aucun cycle.
// - AUCUNE IA appelée, AUCUNE requête : tout vient de `demo-equipe.json`, livré avec l'interface. Ce module n'importe ni le client de
//   l'API (web/lib/api*.ts), ni le proxy, ni fetch : seulement des modèles PURS (team-view-model.ts, deroule-model.ts) et les textes
//   de la construction (demo-equipe.test.ts et demo-p1.test.ts le vérifient par un examen statique des imports).
// - Données FICTIVES : la ligne « Déroulé enregistré avec des données fictives. » le dit, sous la bande, à chaque moment.
// - Accessibilité : l'état de chaque étape est dit par son MOT à côté de son icône, jamais par la couleur seule ; les barres du
//   Déroulé sont décoratives (leur durée est écrite à côté).
import { useId } from "react";
import { factProblem } from "../../../../server/shared/activity-facts.ts";
import type { ActivityFact } from "../../../../server/shared/activity-types.ts";
import { TEXTES } from "../../../../server/shared/construction-texts.ts";
import type { TeamRunView } from "../../../../server/shared/team-types.ts";
import { Icon } from "../../../components/Icon.tsx";
import { formatDuration } from "../../../lib/format.ts";
import { buildTeamDeroule, coutCellule } from "../../chat/team/deroule-model.ts";
import { buildTeamRunCard, etapeResultat, modeleResultat } from "../../chat/team/team-view-model.ts";
import fichier from "./demo-equipe.json" with { type: "json" };
import "../../chat/activity/deroule.css";
import "../../chat/team/team-cards.css";
import "../../chat/team/team-deroule.css";

/** Un moment enregistré : les faits qu'il ajoute et la vue du lancement à cet instant (gen-demo-equipe.ts). */
export interface DemoMoment {
  at: number;
  faits: ActivityFact[];
  run: TeamRunView;
}

const T = TEXTES.partout.demonstration;

/** Moments lus dans la fixture ; un moment sans vue de lancement est écarté, jamais montré à moitié. */
export const MOMENTS_EQUIPE: readonly DemoMoment[] = (fichier.moments as readonly unknown[]).filter((moment): moment is DemoMoment => {
  const lu = moment as Partial<DemoMoment>;
  return typeof lu?.at === "number" && Array.isArray(lu.faits) && typeof lu.run?.id === "string";
});

/** Faits de la démonstration ; un fait refusé par la garde des faits (texte, secret) est écarté, jamais montré. */
export const FAITS_EQUIPE: readonly ActivityFact[] = MOMENTS_EQUIPE.flatMap((moment) => moment.faits).filter((fait) => factProblem(fait) === null);
/** Heures des moments : celles que le générateur a posées, croissantes. */
export const INSTANTS_EQUIPE: readonly number[] = MOMENTS_EQUIPE.map((moment) => moment.at);

/**
 * Moment enregistré montré à l'instant `at` du lecteur complet : le dernier dont l'heure est atteinte, le premier avant eux ;
 * `null` (aucun instant) : le dernier moment, comme la bande en direct.
 */
export function momentEquipeAu(at: number | null): DemoMoment | null {
  if (MOMENTS_EQUIPE.length === 0) return null;
  if (at === null) return MOMENTS_EQUIPE.at(-1) ?? null;
  let retenu: DemoMoment | null = MOMENTS_EQUIPE[0] ?? null;
  for (const moment of MOMENTS_EQUIPE) if (moment.at <= at) retenu = moment;
  return retenu;
}

/** Carte d'exécution de l'itération 4, en lecture seule : aucun bouton, rien à arrêter ni à relancer dans un enregistrement. */
function DemoCarte({ run, advanced }: { run: TeamRunView; advanced: boolean }) {
  const modele = buildTeamRunCard(run, advanced);
  // La démonstration montre le résultat même quand le lancement l'a déjà déposé dans la conversation : la carte de résultat de
  // l'itération 4 ne se rend qu'avant le dépôt (un seul exemplaire), et l'enregistrement va jusqu'au dépôt. GF4 (A27, §6.2 a) :
  // c'est l'EXTRAIT de la dernière étape, jamais découpé (genre « extrait »), pas le message déposé.
  const resultat = modele.resultat ?? (run.state === "terminee" ? modeleResultat(run, etapeResultat(run)?.extrait ?? "", advanced, "extrait") : null);
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

/** Contenu propre d'un moment de la démonstration, dessiné sous la bande : la phrase des données fictives, la carte, le Déroulé. */
export function ContenuDemoEquipe({ moment, advanced }: { moment: DemoMoment | null; advanced: boolean }) {
  if (moment === null) return null;
  return (
    <div className="stack">
      <p className="tiny muted">{T.phrase}</p>
      <DemoCarte run={moment.run} advanced={advanced} />
      <DemoDeroule run={moment.run} advanced={advanced} at={moment.at} />
    </div>
  );
}
