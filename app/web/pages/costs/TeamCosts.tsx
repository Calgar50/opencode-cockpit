// Coûts « par équipe » de la page Coûts (itération 5, L46b ; plan d'exécution it5 §4.3, D-5-10 ; spécification §7.9 l.1204).
// Deux sections sur le mois choisi en haut de la page : le tableau « Par équipe » (Équipe · Lancements · Coût · Moyenne par
// lancement · Estimé en général) et « Lancements d'équipe les plus coûteux », avec [Ouvrir la conversation].
//
// Tout vient de GET /api/usage/equipes (L46a, api-construction.ts) : aucun calcul de coût ici, aucune limite recopiée. Les
// montants passent par formatUsd, comme le reste de la page.
//
// Textes d'IA (titre d'équipe, titre d'étape, nom d'assistant, IA, extrait) : rendus en texte par React, donc échappés, jamais
// en HTML ni en Markdown, et passés par boundedAiText (séquences de terminal et caractères cachés retirés, longueur bornée).
// Les libellés d'état et les aides de ce module sont partagés avec la fiche d'Archives (ArchiveTeams.tsx).
import { useEffect, useRef, useState } from "react";
import { TEXTES } from "../../../server/shared/construction-texts.ts";
import { remplir } from "../../../server/shared/neon-texts.ts";
import { Icon } from "../../components/Icon.tsx";
import { Badge, Card, Spinner, type Tone, useAsync } from "../../components/ui.tsx";
import { getTeamCosts } from "../../lib/api-construction.ts";
import { errorText } from "../../lib/api.ts";
import { cockpitEvent, useEvents } from "../../lib/events.ts";
import { formatDateTime, formatInt, formatUsd } from "../../lib/format.ts";
import { routeHref } from "../../lib/router.ts";
import { boundedAiText } from "../chat/turn.ts";
import "./team-costs.css";

const T = TEXTES.partout.couts;

/** Longueur affichée au plus d'un libellé enregistré au lancement (titre d'équipe, titre d'étape, assistant, IA). */
export const TEAM_LABEL_SHOWN = 200;

/** Délai avant de relire les coûts après un événement, comme le reste de la page Coûts. */
const RELOAD_MS = 1_500;

/**
 * Libellé et ton d'un état de lancement ou d'étape. Les codes sont ceux enregistrés par l'itération 4 (`team_runs.state`,
 * `team_run_steps.state`, db.ts) ; un code inconnu est rendu tel quel plutôt que traduit à tort : l'archive dit ce qui est
 * enregistré, jamais davantage.
 */
const ETATS: Record<string, { libelle: string; tone: Tone }> = {
  preparation: { libelle: "Préparation", tone: "neutral" },
  prevue: { libelle: "Prévue", tone: "neutral" },
  "en-cours": { libelle: "En cours", tone: "accent" },
  "attente-verification": { libelle: "En attente de votre vérification", tone: "warning" },
  "attente-choix": { libelle: "En attente de votre choix", tone: "warning" },
  "attente-budget": { libelle: "En attente pour le budget", tone: "warning" },
  terminee: { libelle: "Terminée", tone: "good" },
  arretee: { libelle: "Arrêtée", tone: "warning" },
  interrompue: { libelle: "Interrompue", tone: "warning" },
  ignoree: { libelle: "Ignorée", tone: "neutral" },
  echec: { libelle: "Échec", tone: "critical" },
  plafond: { libelle: "Plafond atteint", tone: "critical" },
};

/** Texte d'un état, pour la ligne d'étape du §4.3 (« … · {etat} · … »). */
export function libelleEtat(etat: string): string {
  return ETATS[etat]?.libelle ?? texteBorne(etat);
}

/** Puce d'état d'un lancement : le mot, jamais la couleur seule (spécification §5.5). */
export function EtatBadge({ etat }: { etat: string }) {
  const connu = ETATS[etat];
  return <Badge tone={connu?.tone ?? "neutral"}>{connu?.libelle ?? texteBorne(etat)}</Badge>;
}

/** Texte venu de la base (donc, à l'origine, d'une IA) : caractères cachés retirés et longueur bornée avant affichage. */
export function texteBorne(valeur: string, max = TEAM_LABEL_SHOWN): string {
  return boundedAiText(valeur, max).text.trim();
}

/** Montant d'un estimé ou d'un plafond non enregistré : dit, jamais deviné. */
export const SANS_VALEUR = "—";

export function montantOuTiret(valeur: number | null): string {
  return valeur === null ? SANS_VALEUR : formatUsd(valeur);
}

/**
 * Sections « Par équipe » et « Lancements d'équipe les plus coûteux » du mois affiché par la page Coûts.
 * Les lignes sont relues après un changement de coût, comme le résumé de la page.
 */
export function TeamCosts({ month }: { month: string }) {
  const [tick, setTick] = useState(0);
  const couts = useAsync(() => getTeamCosts(month), [month, tick]);
  const timer = useRef<number | undefined>(undefined);
  useEvents((event) => {
    if (!cockpitEvent(event, "usage.updated", "stream.reconnected")) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setTick((n) => n + 1), RELOAD_MS);
  });
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const data = couts.data;
  if (!data) {
    return (
      <Card title={T.parEquipe} flush>
        <p className="small muted team-costs-note">
          {couts.error ? `${T.parEquipe} : ${errorText(couts.error)}` : <Spinner label="Lecture des coûts par équipe" />}
        </p>
      </Card>
    );
  }

  if (data.parEquipe.length === 0) {
    return (
      <Card title={T.parEquipe} flush>
        <p className="small muted team-costs-note">{T.vide}</p>
      </Card>
    );
  }

  return (
    <>
      <Card title={T.parEquipe} flush>
        <div className="table-wrap team-table-wrap">
          <table className="table">
            <caption className="visually-hidden">{T.parEquipe}</caption>
            <thead>
              <tr>
                <th scope="col">{T.colonnes.equipe}</th>
                <th scope="col" className="num">
                  {T.colonnes.lancements}
                </th>
                <th scope="col" className="num">
                  {T.colonnes.cout}
                </th>
                <th scope="col" className="num">
                  {T.colonnes.moyenne}
                </th>
                <th scope="col" className="num">
                  {T.colonnes.estime}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.parEquipe.map((ligne) => (
                <tr key={ligne.teamId ?? `titre:${ligne.titre}`}>
                  <th scope="row">
                    <span className="team-title">
                      <strong className="ellipsis">{texteBorne(ligne.titre)}</strong>
                      {/* Le titre enregistré vaut déjà « Équipe supprimée » quand rien n'a été gardé (L46a) : pas deux fois. */}
                      {ligne.teamId === null && texteBorne(ligne.titre) !== T.equipeSupprimee ? (
                        <Badge tone="warning">{T.equipeSupprimee}</Badge>
                      ) : null}
                    </span>
                  </th>
                  <td className="num">{formatInt(ligne.lancements)}</td>
                  <td className="num">
                    <strong>{formatUsd(ligne.cout)}</strong>
                  </td>
                  <td className="num">{formatUsd(ligne.moyenne)}</td>
                  <td className="num">{montantOuTiret(ligne.estimeTypique)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {data.lancements.length > 0 ? (
        <Card title={T.plusCouteux} flush>
          <div className="table-wrap team-table-wrap">
            <table className="table">
              <caption className="visually-hidden">{T.plusCouteux}</caption>
              <thead>
                <tr>
                  <th scope="col">{T.colonnes.equipe}</th>
                  <th scope="col">État</th>
                  <th scope="col" className="num">
                    {T.colonnes.cout}
                  </th>
                  <th scope="col">Début</th>
                  <th scope="col">
                    <span className="visually-hidden">{T.ouvrir}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.lancements.map((run) => (
                  <tr key={run.runId}>
                    <th scope="row">
                      <div className="ellipsis">{texteBorne(run.titre)}</div>
                    </th>
                    <td>
                      <EtatBadge etat={run.etat} />
                    </td>
                    <td className="num">
                      <strong>{formatUsd(run.cout)}</strong>
                    </td>
                    <td className="small muted nowrap">{formatDateTime(run.debut)}</td>
                    <td>
                      {/* La conversation se rouvre par les Archives, d'où [Ouvrir dans le chat] reste à portée quand la
                          session existe encore dans opencode ; une conversation retirée des archives y est dite introuvable,
                          plutôt qu'un chat vide. */}
                      <a className="btn ghost sm nowrap" href={routeHref("archives", run.rootId)}>
                        <Icon name="archive" size={14} />
                        {T.ouvrir}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </>
  );
}

/** Ligne d'étape du §4.3 : « Étape « {titre} » · {assistant} · {ia} · {etat} · {cout} », montée par la fiche d'Archives. */
export function ligneEtape(etape: { titre: string; agent: string; ia: string; etat: string; cout: number }): string {
  return remplir(TEXTES.partout.archives.etape, {
    titre: texteBorne(etape.titre),
    assistant: texteBorne(etape.agent),
    ia: texteBorne(etape.ia),
    etat: libelleEtat(etape.etat),
    cout: formatUsd(etape.cout),
  });
}

/** Libellé « tour {n} » d'une étape rejouée (relecture) ; null quand un seul tour est enregistré. */
export function libelleTour(tour: number | null): string | null {
  return tour === null ? null : remplir(TEXTES.partout.execution.relecture.tour, { n: tour });
}
