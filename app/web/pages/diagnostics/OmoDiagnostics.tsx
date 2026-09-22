// Propriétaire : L26b.
// Écran « Diagnostic OMO » (spécification §4.12 l.784, §4.10 l.759, §5.4 l.915, §3.15.2 l.521, §7.6 l.1159) : image chargée et
// son manifeste, dernier démarrage et son pré-contrôle, liste blanche de sortie, projets préparés et état de leur `.git`,
// `.git` NON PROTÉGÉS du dossier de travail, présence de l'authentification de la salle, état de la salle, « Sorties refusées
// (24 h) », battement du cockpit et emplacement du tableau « sans demande ».
// ALIMENTÉ PAR PROPRIÉTÉS : ce composant ne fait AUCUN appel réseau et n'importe pas `web/lib/api-omo.ts` (L26a, même vague,
// plan §2.9) ; `getOmoStatus()` est branché dans DiagnosticsPage.tsx par l'intégrateur au train de V2. Il ne touche ni à la bande
// néon ni à `neon.css` (D-2b-45 : L25b, vague 4). Aucune animation (web-animations.test.ts).
// Calculs et phrases : omo-diagnostics.ts, qui ne rend que des phrases de server/shared/omo-room-texts.ts.
// A16 (4) du 22/09 : quand la salle attend, la raison est écrite ici, avec la liste masquée des chemins, lisible sans interaction
// (aucun survol, aucun repli) donc au clavier comme à la souris. Aucun secret : l'authentification n'est dite que présente ou
// absente, et les chemins restent relatifs à `/workspace`.
import { useId } from "react";
import { TEXTES } from "../../../server/shared/omo-room-texts.ts";
import type { OmoStatusResponse } from "../../../server/shared/omo-types.ts";
import { Icon } from "../../components/Icon.tsx";
import { Card } from "../../components/ui.tsx";
import { formatDateTime, formatDuration, formatInt } from "../../lib/format.ts";
import { type LigneOmo, lignesDiagnosticOmo, lignesPrecontrole, raisonsAttente, salleInstallee, type TonOmo } from "./omo-diagnostics.ts";
import "./diagnostics.css";

const T = TEXTES.avance;

const TITRE = "Salle Oh My OpenAgent";
const SOUS_TITRE = "État de la salle sur ce PC, tel que le cockpit le lit. Rien n'est lancé depuis cette page.";
const TITRE_ATTENTE = "Pourquoi la salle attend";
const TITRE_PRECONTROLE = "Pré-contrôle du dernier démarrage";
const CHEMINS_RELATIFS = "Chemins du dossier de travail.";

const TON_LIBELLE: Readonly<Record<TonOmo, string>> = { good: "OK", warning: "Attention", critical: "Problème", neutral: "Information" };

/** Pastille d'état : le mot est porté par `aria-label`, jamais la couleur seule (§5.5). */
function Pastille({ ton }: { ton: TonOmo }) {
  return <span className={`dot${ton === "neutral" ? "" : ` ${ton}`}`} role="img" aria-label={TON_LIBELLE[ton]} />;
}

/** Liste masquée de chemins, relatifs au dossier de travail : toujours affichée, donc lisible au clavier comme à la souris. */
function Chemins({ chemins }: { chemins: readonly string[] }) {
  if (chemins.length === 0) return null;
  return (
    <ul className="tiny mono" aria-label={CHEMINS_RELATIFS}>
      {chemins.map((chemin) => (
        <li key={chemin}>{chemin}</li>
      ))}
    </ul>
  );
}

/** Une ligne du Diagnostic : libellé, valeur, précision, puis les chemins qui la justifient. */
function LigneDiagnostic({ ligne }: { ligne: LigneOmo }) {
  return (
    <div className="diag-line">
      <Pastille ton={ligne.ton} />
      <div style={{ minWidth: 0 }}>
        <div className="diag-line-head">
          <span className="label">{ligne.label}</span>
          {ligne.valeur === "" ? null : <span className="value">{ligne.valeur}</span>}
        </div>
        {ligne.indice === "" ? null : <p className={`hint${ligne.ton === "critical" ? " critical" : ""}`}>{ligne.indice}</p>}
        <Chemins chemins={ligne.chemins} />
      </div>
    </div>
  );
}

export interface OmoDiagnosticsProps {
  /** État lu par GET /api/omo/status (T3a) : ce composant ne le demande jamais lui-même. */
  statut: OmoStatusResponse;
}

/**
 * Carte « Salle Oh My OpenAgent » du Diagnostic. Sans image chargée, elle ne montre que l'état vide du §5.4 : rien d'autre n'est
 * affirmé, parce que rien d'autre n'est installé sur ce poste (P3).
 */
export function OmoDiagnostics({ statut }: OmoDiagnosticsProps) {
  const baseId = useId();
  const attenteId = `${baseId}-attente`;
  const precontroleId = `${baseId}-precontrole`;
  const sortiesId = `${baseId}-sorties`;

  if (!salleInstallee(statut)) {
    return (
      <Card title={TITRE}>
        <p className="small muted">{T.nonInstallee}</p>
      </Card>
    );
  }

  const lignes = lignesDiagnosticOmo(statut, { dateHeure: formatDateTime, duree: formatDuration });
  const attentes = raisonsAttente(statut);
  const precontrole = lignesPrecontrole(statut);
  const sorties = statut.sortiesRefusees24h;

  return (
    <Card title={TITRE} subtitle={SOUS_TITRE}>
      <div className="diag-lines">
        {lignes.map((ligne) => (
          <LigneDiagnostic key={ligne.cle} ligne={ligne} />
        ))}
      </div>

      {attentes.length > 0 ? (
        <section aria-labelledby={attenteId} style={{ marginTop: 14 }}>
          <h4 id={attenteId} className="small">
            {TITRE_ATTENTE}
          </h4>
          <ul className="stack tight">
            {attentes.map((attente) => (
              <li key={attente.cle} className="small">
                <span className="row" style={{ gap: 6 }}>
                  <Icon name="alert" size={14} />
                  <span>{attente.phrase}</span>
                </span>
                <Chemins chemins={attente.chemins} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {precontrole.length > 0 ? (
        <section aria-labelledby={precontroleId} style={{ marginTop: 14 }}>
          <h4 id={precontroleId} className="small">
            {TITRE_PRECONTROLE}
          </h4>
          <div className="diag-lines">
            {precontrole.map((projet) => (
              <LigneDiagnostic
                key={projet.projet}
                ligne={{
                  cle: projet.projet,
                  label: projet.projet,
                  valeur: projet.verdict === "conforme" ? "conforme" : "refusé",
                  indice: projet.phrase,
                  ton: projet.verdict === "conforme" ? "good" : "critical",
                  chemins: projet.chemins,
                }}
              />
            ))}
          </div>
        </section>
      ) : null}

      {sorties.length > 0 ? (
        <section aria-labelledby={sortiesId} style={{ marginTop: 14 }}>
          <h4 id={sortiesId} className="small">
            {T.sortiesRefusees.titre}
          </h4>
          <div className="table-wrap">
            <table className="table">
              <caption className="visually-hidden">{T.sortiesRefusees.titre}</caption>
              <thead>
                <tr>
                  <th scope="col">Hôte</th>
                  <th scope="col" className="num">
                    Refus
                  </th>
                  <th scope="col">Dernier</th>
                </tr>
              </thead>
              <tbody>
                {sorties.map((sortie) => (
                  <tr key={sortie.hote}>
                    <th scope="row" className="mono small">
                      {sortie.hote}
                    </th>
                    <td className="num tabular">{formatInt(sortie.nombre)}</td>
                    <td className="nowrap">{formatDateTime(sortie.dernier)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </Card>
  );
}
