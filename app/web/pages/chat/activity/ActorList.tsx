// Propriétaire : L5b.
// Liste des acteurs d'une conversation (la vérité de l'affichage, spécification §5.1, §5.7.4), rendue par WhoIsWorking : une ligne
// par acteur (icône et mot, jamais la couleur seule), état et détail, durée, coût ; [Répondre] sur une attente de votre accord
// (le focus ne bouge qu'à ce clic) ; [Voir le travail] ouvre une conversation déléguée dans le tiroir de lecture (jamais le
// « Contrôle de sécurité », session interne du cockpit : opensWork). Textes d'IA
// (titre, nom d'assistant, chemin) affichés en texte, donc échappés. Composant interne : ses propriétés restent libres pour son
// propriétaire.
import {
  libelleDuree,
  libelleEtatActeur,
  libelleRaccourci,
  libelleRepondre,
  libelleVoir,
  nomActeur,
  TEXTES,
} from "../../../../server/shared/activity-texts.ts";
import type { LiveRow } from "../../../../server/shared/activity.ts";
import { Icon, type IconName } from "../../../components/Icon.tsx";
import { Button } from "../../../components/ui.tsx";
import { formatDuration, formatUsd } from "../../../lib/format.ts";
import type { ActorState } from "../../../lib/types.ts";
import { opensWork, treeWorking } from "../../../lib/useActivity.ts";

export interface ActorListProps {
  rows: readonly LiveRow[];
  advanced: boolean;
  /** Détail en cours (chemin, motif) par appel d'outil (useActivity). */
  details: ReadonlyMap<string, string>;
  onReply: (permissionId: string) => void;
  onOpenSession: (sessionId: string) => void;
}

const ICONS: Readonly<Record<ActorState, IconName>> = {
  "pas-commence": "circle",
  "prepare-delegation": "users",
  travaille: "pulse",
  redige: "edit",
  "attend-delegation": "hourglass",
  "attente-accord": "lock",
  controle: "shield",
  "attend-verification": "pause",
  "nouvelle-tentative": "refresh",
  termine: "checkCircle",
  echec: "alert",
  arrete: "stop",
  "jamais-demarre": "ban",
  "non-choisi": "minus",
};

/** Mode Avancé : titre de la conversation déléguée, raccourci, reprise, lancement détaché. */
function ActorExtra({ row }: { row: LiveRow }) {
  const parts = [
    row.title,
    row.commande === null ? "" : libelleRaccourci(row.commande),
    row.reprise ? TEXTES.avance.reprise : "",
    row.detache ? TEXTES.avance.detache : "",
  ].filter((part) => part !== "");
  if (parts.length === 0) return null;
  return (
    <div className="actor-extra tiny muted">
      {parts.map((part) => (
        <span key={part} className="ellipsis">
          {part}
        </span>
      ))}
    </div>
  );
}

function ActorRow({ row, advanced, details, onReply, onOpenSession }: Omit<ActorListProps, "rows"> & { row: LiveRow }) {
  const nom = nomActeur(row);
  const detail = row.outilCallId === null ? null : (details.get(row.outilCallId) ?? null);
  const permissionId = row.permissionId;
  return (
    <li className={`actor-row depth-${Math.min(row.depth, 3)} state-${row.state}`}>
      <Icon name={ICONS[row.state]} className="actor-icon" />
      <div className="actor-main">
        <div className="actor-line">
          <span className="actor-name">{nom}</span>
          <span className="actor-state">{libelleEtatActeur(row, detail, advanced)}</span>
        </div>
        {advanced ? <ActorExtra row={row} /> : null}
      </div>
      <span className="actor-time tabular small muted">{row.durationMs === null ? null : libelleDuree(formatDuration(row.durationMs), treeWorking([row]))}</span>
      <span className="actor-cost tabular small">{row.calls > 0 || row.cost > 0 ? formatUsd(row.cost) : null}</span>
      <span className="actor-actions">
        {permissionId !== null ? (
          <Button size="sm" variant="primary" aria-label={libelleRepondre(nom)} onClick={() => onReply(permissionId)}>
            {TEXTES.partout.repondre}
          </Button>
        ) : null}
        {opensWork(row) ? (
          <Button size="sm" variant="ghost" aria-label={libelleVoir(nom)} onClick={() => onOpenSession(row.sessionId)}>
            {TEXTES.partout.voir}
          </Button>
        ) : null}
      </span>
    </li>
  );
}

export function ActorList({ rows, advanced, details, onReply, onOpenSession }: ActorListProps) {
  return (
    <ul className="actor-list">
      {rows.map((row) => (
        <ActorRow key={row.key} row={row} advanced={advanced} details={details} onReply={onReply} onOpenSession={onOpenSession} />
      ))}
    </ul>
  );
}
