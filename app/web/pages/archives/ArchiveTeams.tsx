// Fiche d'Archives : « Équipes lancées dans cette conversation » (itération 5, L46b ; plan d'exécution it5 §4.3, D-5-10 ;
// spécification §7.9 l.1204 ; C §9.14 ; conception A §7.7).
//
// Tout vient de GET /api/archives/:rootId/equipes (L46a) : par lancement, son titre, son état, son coût, son estimé et son
// plafond, puis ses étapes, écrites avec la ligne fixe du §4.3. Les extraits de résultat arrivent DÉJÀ masqués et coupés par le
// serveur (redactSecrets puis ARCHIVE_EXCERPT_MAX) ; ils sont montrés REPLIÉS, jamais dépliés d'office, et rendus en texte par
// React — ni HTML, ni Markdown, ni innerHTML. Comme tout texte venu d'une IA, ils passent aussi par boundedAiText.
//
// L'export Markdown des archives ne reçoit aucun extrait (D-5-10) : ils ne se voient que dans cette interface.
//
// Quand la conversation a été supprimée d'opencode et qu'aucune étape ne garde plus d'extrait, la section le dit avec la phrase
// exacte des textes : les coûts, eux, restent enregistrés.
import { ARCHIVE_EXCERPT_MAX } from "../../../server/shared/construction-constants.ts";
import { TEXTES } from "../../../server/shared/construction-texts.ts";
import { Card, Spinner, useAsync } from "../../components/ui.tsx";
import { getArchiveTeams } from "../../lib/api-construction.ts";
import { ApiError, errorText } from "../../lib/api.ts";
import { formatUsd } from "../../lib/format.ts";
import type { ArchiveTeamRun, ArchiveTeamStep } from "../../lib/types.ts";
import { EtatBadge, libelleTour, ligneEtape, montantOuTiret, texteBorne } from "../costs/TeamCosts.tsx";
import "../costs/team-costs.css";

const T = TEXTES.partout.archives;

/**
 * Section « Équipes lancées dans cette conversation ». Rien n'est rendu quand la conversation n'a lancé aucune équipe : la
 * grande majorité des fiches d'archives n'en ont pas.
 * `supprimeeDansOpencode` vient de la conversation archivée (`deletedInOpencode`) : sans lui, la phrase de suppression
 * affirmerait une cause qui n'est pas vérifiée.
 */
export function ArchiveTeams({ rootId, supprimeeDansOpencode }: { rootId: string; supprimeeDansOpencode: boolean }) {
  const equipes = useAsync(() => getArchiveTeams(rootId), [rootId]);
  const data = equipes.data;

  if (!data) {
    // Route absente ou conversation inconnue du cockpit : il n'y a rien à montrer, pas une panne à annoncer.
    if (equipes.error instanceof ApiError && equipes.error.status === 404) return null;
    if (equipes.error) {
      return (
        <Card className="archive-teams" title={T.titre} flush>
          <p className="small muted team-costs-note">{errorText(equipes.error)}</p>
        </Card>
      );
    }
    return null;
  }
  if (data.lancements.length === 0) return null;

  // « Détail des étapes indisponible… » : la conversation n'existe plus dans opencode ET la purge a vidé tous les extraits.
  const aucunExtrait = data.lancements.every((run) => run.etapes.every((etape) => etape.extrait === null));
  const detailPerdu = supprimeeDansOpencode && aucunExtrait;

  return (
    <Card className="archive-teams" title={T.titre} flush>
      <div className="archive-teams-body">
        {equipes.loading ? <Spinner label="Lecture des équipes de la conversation" /> : null}
        {detailPerdu ? (
          <p className="small muted team-costs-note" style={{ padding: 0 }}>
            {T.detailIndisponible}
          </p>
        ) : null}
        {data.lancements.map((run) => (
          <TeamRunCard key={run.runId} run={run} />
        ))}
      </div>
    </Card>
  );
}

/** Un lancement : son titre, son état, ses montants, puis ses étapes dans l'ordre enregistré. */
function TeamRunCard({ run }: { run: ArchiveTeamRun }) {
  const cause = run.cause === null ? null : texteBorne(run.cause);
  return (
    <section className="team-run">
      <div className="team-run-head">
        <h4 className="ellipsis">{texteBorne(run.titre)}</h4>
        <EtatBadge etat={run.etat} />
      </div>
      <dl className="team-run-facts small">
        <div>
          <dt>Coût</dt>
          <dd>
            <strong>{formatUsd(run.cout)}</strong>
          </dd>
        </div>
        <div>
          <dt>Estimé</dt>
          <dd>{montantOuTiret(run.estimeTypique)}</dd>
        </div>
        <div>
          <dt>Plafond</dt>
          <dd>{montantOuTiret(run.plafond)}</dd>
        </div>
        {cause ? (
          <div>
            <dt>Arrêt</dt>
            <dd>{cause}</dd>
          </div>
        ) : null}
      </dl>
      {run.etapes.length > 0 ? (
        <ul className="team-steps">
          {run.etapes.map((etape, index) => (
            <TeamStepItem key={`${run.runId}/${index}`} etape={etape} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** Une étape : la ligne fixe du §4.3, le tour quand l'étape est revenue, puis l'extrait replié s'il en reste un. */
function TeamStepItem({ etape }: { etape: ArchiveTeamStep }) {
  const tour = libelleTour(etape.tour);
  const verdict = etape.verdict === null ? null : texteBorne(etape.verdict);
  const choix = etape.choix === null ? null : texteBorne(etape.choix);
  // Le serveur a déjà masqué puis coupé l'extrait à cette borne ; boundedAiText ne fait ici que retirer les caractères cachés.
  const extrait = etape.extrait === null ? null : texteBorne(etape.extrait, ARCHIVE_EXCERPT_MAX);
  return (
    <li className="team-step">
      <p className="team-step-line small">
        {ligneEtape(etape)}
        {tour ? ` · ${tour}` : ""}
      </p>
      {verdict ? <p className="team-step-line tiny muted">{`Relecture : ${verdict}`}</p> : null}
      {choix ? <p className="team-step-line tiny muted">{`Choix : ${choix}`}</p> : null}
      {extrait ? (
        <details className="team-excerpt">
          <summary>{T.extrait}</summary>
          <p className="team-excerpt-text">{extrait}</p>
        </details>
      ) : null}
    </li>
  );
}
