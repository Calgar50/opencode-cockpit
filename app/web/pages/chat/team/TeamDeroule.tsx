// Propriétaire : L38c.
// « Prévu / Réel » de chaque équipe de la conversation, en tête du Déroulé (panneau de contexte et Archives) : barres par étape,
// pause hachurée « vérification » (spécification §5.1 l.878-883, §5.5 ; C §9.14). Propriétés figées dans ./slots.ts.
// Toute la logique est dans ./deroule-model.ts (pur, testé par server/web-team-deroule.test.ts, D-eq-24) : ce composant lit les
// lancements par useTeamRuns(rootId) (L38b : UN seul chargement et UN seul abonnement par racine, partagés avec les cartes et la
// transcription) et les dessine. AUCUNE requête à opencode (A4) : tout vient de GET /api/team-runs, c'est-à-dire de la base du
// cockpit ; les Archives montrent donc le même déroulé qu'en direct, même quand opencode ne connaît plus les conversations.
// Barres : « génération » et « attente de vous » réutilisent les classes de activity/deroule.css (it1), qui portent déjà leur bloc
// `forced-colors` ; la barre de pause est la classe neuve de ./team-deroule.css. La hachure ne dit jamais l'état à elle seule : le
// mot est écrit dans la barre (« vous », « vérification »), l'état en toutes lettres sur la ligne, et le tableau donne les mêmes
// valeurs sans aucune couleur. Aucune animation ; aucune région aria-live propre.
// 5b (L42c) : une ligne par tour réellement fait d'une relecture (« tour {n} »), « ×{n} » sur le bloc, le verdict en MOT et
// icône, « Non relue après la dernière correction. », les spécialistes écartés en « Non choisi » (icône `minus`, sans barre ni
// coût) et, EN GRAS, l'écart entre le prévu et le réel. Tout est calculé par ./deroule-model.ts (pur).
import { useId, useState } from "react";
import { TEXTES } from "../../../../server/shared/team-texts.ts";
import { Icon } from "../../../components/Icon.tsx";
import { Button } from "../../../components/ui.tsx";
import { formatDuration, formatTime } from "../../../lib/format.ts";
import type { TeamDerouleProps } from "./slots.ts";
import { buildTeamDeroules, coutCellule, type TeamBarKind, type TeamDerouleModel, type TeamDerouleRow } from "./deroule-model.ts";
import { useTeamRuns } from "./useTeamRuns.ts";
import "../activity/deroule.css";
import "./team-deroule.css";

/**
 * Libellés de structure du Déroulé, repris tels quels de activity/Deroule.tsx (it1) : ce sont les en-têtes de la même
 * chronologie, pas des phrases d'équipe (celles-là viennent toutes de server/shared/team-texts.ts par deroule-model.ts).
 */
const COLONNES = { qui: "Qui", prevu: "Prévu", reel: "Réel", debut: "Début", duree: "Durée", cout: "Coût" };
const TABLEAU = "Tableau";
const AUCUNE_PERIODE = "aucune période enregistrée";
/** Titre de la partie « équipes » du Déroulé : le mot de T4t, jamais un autre. */
const TITRE_SECTION = TEXTES.partout.onglet.titre;

/** Mot écrit DANS la barre et dans la légende (§5.1 : hachure + « vous », hachure + « vérification »). */
const BAR_MOT: Readonly<Record<TeamBarKind, string>> = { generation: "", "attente-vous": "vous", verification: "vérification" };
/** Légende des barres, comme celle du Déroulé de l'it1 : « génération », « attente de vous », « pause pour vérifier ». */
const BAR_TEXTE: Readonly<Record<TeamBarKind, string>> = {
  generation: "génération",
  "attente-vous": "attente de vous",
  verification: "pause pour vérifier",
};

const PREVU_OUI = "✓";
const PREVU_NON = "—";
const prevuTexte = (prevu: boolean) => (prevu ? PREVU_OUI : PREVU_NON);
const debutTexte = (row: TeamDerouleRow) => (row.start === null ? PREVU_NON : formatTime(row.start));
const dureeTexte = (row: TeamDerouleRow) => (row.durationMs === null ? PREVU_NON : formatDuration(row.durationMs));

/** Lecture d'une ligne pour le lecteur d'écran : périodes, puis prévu et réel (les barres elles-mêmes sont décoratives). */
function ligneLue(row: TeamDerouleRow): string {
  const periodes = row.bars.length > 0 ? row.bars.map((bar) => `${BAR_TEXTE[bar.kind]} ${formatDuration(bar.durationMs)}`).join(", ") : AUCUNE_PERIODE;
  return `${periodes}, ${COLONNES.prevu.toLowerCase()} : ${prevuTexte(row.prevu)}, ${COLONNES.reel.toLowerCase()} : ${row.reel}`;
}

/** Barres d'un lancement : `<figure>` à libellé chiffré ; le texte de chaque barre est dit à côté, jamais par la couleur. */
function TeamDerouleBars({ modele }: { modele: TeamDerouleModel }) {
  const captionId = useId();
  return (
    <figure className="deroule-figure" aria-labelledby={captionId}>
      <figcaption id={captionId} className="visually-hidden">
        {`${modele.titre} · ${modele.bilan}`}
      </figcaption>
      <ol className="deroule-rows">
        {modele.lignes.map((row) => (
          <li key={row.cle} className="deroule-row">
            <div className="deroule-who">
              <span className="deroule-name ellipsis">{row.titre}</span>
              <span className="team-deroule-prevu nowrap">
                {`${COLONNES.prevu} ${prevuTexte(row.prevu)}`}
                {row.tentative === null ? "" : ` · ${row.tentative}`}
                {row.tour === null ? "" : ` · ${row.tour}`}
              </span>
              {row.repetition === null ? null : <span className="team-deroule-repetition tabular nowrap">{row.repetition}</span>}
              <span className="deroule-state nowrap">
                <Icon name={row.icone} size={12} />
                {row.reel}
              </span>
              {row.verdict === null ? null : (
                <span className="deroule-state nowrap">
                  <Icon name={row.verdict.icone} size={12} />
                  {row.verdict.mot}
                </span>
              )}
            </div>
            {row.detail === "" ? null : <div className="tiny muted ellipsis">{row.detail}</div>}
            <div className="deroule-track" aria-hidden="true">
              {row.bars.map((bar, index) => (
                <span
                  key={`${bar.kind}-${index}`}
                  className={`deroule-bar deroule-bar--${bar.kind}`}
                  style={{ left: `${bar.left}%`, width: `${bar.width}%` }}
                  title={`${BAR_TEXTE[bar.kind]} · ${formatDuration(bar.durationMs)}`}
                >
                  {BAR_MOT[bar.kind] === "" ? null : BAR_MOT[bar.kind]}
                </span>
              ))}
            </div>
            <span className="visually-hidden">{ligneLue(row)}</span>
          </li>
        ))}
      </ol>
      <ul className="deroule-legend tiny muted" aria-hidden="true">
        {(Object.keys(BAR_TEXTE) as TeamBarKind[]).map((kind) => (
          <li key={kind}>
            <span className={`deroule-swatch deroule-bar--${kind}`} />
            {BAR_TEXTE[kind]}
          </li>
        ))}
      </ul>
    </figure>
  );
}

/** Tableau d'un lancement (§5.5 : `<table>` pour la chronologie) : qui, prévu, réel, début, durée, coût. */
function TeamDerouleTable({ modele }: { modele: TeamDerouleModel }) {
  return (
    <div className="table-wrap">
      <table className="table deroule-table">
        <caption className="visually-hidden">{`${modele.titre} · ${modele.bilan}`}</caption>
        <thead>
          <tr>
            <th scope="col">{COLONNES.qui}</th>
            <th scope="col">{COLONNES.prevu}</th>
            <th scope="col">{COLONNES.reel}</th>
            <th scope="col">{COLONNES.debut}</th>
            <th scope="col" className="num">
              {COLONNES.duree}
            </th>
            <th scope="col" className="num">
              {COLONNES.cout}
            </th>
          </tr>
        </thead>
        <tbody>
          {modele.lignes.map((row) => (
            <tr key={row.cle}>
              <th scope="row" className="deroule-cell-who">
                {row.titre}
              </th>
              <td>{row.tour === null ? prevuTexte(row.prevu) : `${prevuTexte(row.prevu)} · ${row.tour}`}</td>
              <td>{[row.reel, row.tentative, row.verdict?.mot].filter((part) => typeof part === "string" && part !== "").join(" · ")}</td>
              <td className="nowrap">{debutTexte(row)}</td>
              <td className="num nowrap">{dureeTexte(row)}</td>
              <td className="num nowrap">{coutCellule(row.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TeamDeroule({ rootId, placement, advanced }: TeamDerouleProps) {
  const { runs } = useTeamRuns(rootId);
  const [table, setTable] = useState(false);
  const titleId = useId();
  // `now` figé pour tout le rendu : les durées en cours d'une même passe sont comparables entre elles.
  const modeles = buildTeamDeroules(runs, advanced, Date.now());
  if (modeles.length === 0) return null;
  const Heading = placement === "archives" ? "h4" : "h5";
  return (
    <section className="team-deroule" aria-labelledby={titleId}>
      <div className="team-deroule-head">
        <Heading id={titleId} className="team-deroule-title">
          {TITRE_SECTION}
        </Heading>
        <span className="spacer" />
        <Button className="team-deroule-toggle" variant="ghost" size="sm" icon="list" aria-pressed={table} onClick={() => setTable((v) => !v)}>
          {TABLEAU}
        </Button>
      </div>
      {modeles.map((modele) => (
        <div key={modele.runId} className="team-deroule-run">
          <div className="team-deroule-head">
            <span className="deroule-name ellipsis">{modele.titre}</span>
            <span className="team-deroule-state nowrap">
              <Icon name={modele.etatIcone} size={12} />
              {modele.etatMot}
            </span>
          </div>
          <p className="tiny muted tabular team-deroule-bilan">{modele.bilan}</p>
          {modele.ecarts.map((ecart) => (
            <p key={ecart} className="tiny team-deroule-ecart">
              <strong>{ecart}</strong>
            </p>
          ))}
          {modele.notes.map((note) => (
            <p key={note} className="tiny muted team-deroule-note">
              {note}
            </p>
          ))}
          {table ? <TeamDerouleTable modele={modele} /> : <TeamDerouleBars modele={modele} />}
        </div>
      ))}
    </section>
  );
}
