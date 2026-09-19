// Propriétaire : L5b.
// Bandeau « Qui travaille ? » (spécification §5.1, §5.4, §5.6), rendu par ActivityRegion quand un second acteur, une attente de
// votre accord ou une demande automatique existe. Déplié pendant le travail, replié en fin de demande (chaque début ou fin rend la
// main au dépliage automatique) ; replié, une seule ligne : l'acteur à suivre et « +2 » pour les autres (à 400 px, c'est aussi
// l'état par défaut pendant le travail). Une demande qui attend votre réponse ne le replie pas en mode Avancé : une ligne par acteur,
// [Répondre] sur la ligne qui attend (§5.1 ; clôture de l'itération 1). En mode Simple seulement (repliPourLaDemande), il se replie
// tant qu'elle attend : sa ligne porte [Répondre], et la carte de la demande garde la place. [Répondre] ne déplace le focus qu'au
// clic (ChatPage). Phrase d'accueil au premier bandeau.
// Composant interne : ses propriétés restent libres pour son propriétaire.
import { useEffect, useId, useState, useSyncExternalStore } from "react";
import {
  libelleEnPlus,
  libelleEtatActeur,
  libelleRepondre,
  nomActeur,
  TEXTES,
} from "../../../../server/shared/activity-texts.ts";
import type { LiveRow } from "../../../../server/shared/activity.ts";
import { Icon } from "../../../components/Icon.tsx";
import { Button } from "../../../components/ui.tsx";
import { mainRow } from "../../../lib/useActivity.ts";
import { ActorList } from "./ActorList.tsx";

export interface WhoIsWorkingProps {
  rows: readonly LiveRow[];
  advanced: boolean;
  /** L'arbre travaille (ou attend votre accord). */
  working: boolean;
  /** Mode Simple, une demande attend votre réponse (replierPendantLaDemande) : replié par défaut, [Répondre] sur sa ligne. */
  repliPourLaDemande: boolean;
  /** « Déroulé partiel ». */
  partial: boolean;
  /** Premier bandeau : phrase d'accueil (§5.4). */
  welcome: boolean;
  details: ReadonlyMap<string, string>;
  onReply: (permissionId: string) => void;
  onOpenSession: (sessionId: string) => void;
}

/** §5.6 : bandeau sur une ligne. */
const NARROW_QUERY = "(max-width: 400px)";

function subscribeNarrow(listener: () => void): () => void {
  const media = window.matchMedia(NARROW_QUERY);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

const isNarrow = () => window.matchMedia(NARROW_QUERY).matches;

export function WhoIsWorking({ rows, advanced, working, repliPourLaDemande, partial, welcome, details, onReply, onOpenSession }: WhoIsWorkingProps) {
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrow, isNarrow);
  /** Choix de l'utilisateur (null : automatique), oublié à chaque début ou fin de demande, et (Simple) quand une demande attend ou est réglée. */
  const [manual, setManual] = useState<boolean | null>(null);
  useEffect(() => setManual(null), [working, repliPourLaDemande]);
  const expanded = manual ?? (working && !narrow && !repliPourLaDemande);
  const listId = useId();
  const { partout } = TEXTES;
  const main = mainRow(rows);
  const others = Math.max(0, rows.length - 1);
  const enPlus = libelleEnPlus(others);
  const mainName = main === null ? "" : nomActeur(main);
  const mainPermission = main?.permissionId ?? null;
  const mainDetail = main?.outilCallId ? (details.get(main.outilCallId) ?? null) : null;

  return (
    <section className={`who-banner${working ? " working" : ""}${expanded ? " expanded" : ""}`} aria-label={partout.titre}>
      <div className="who-head">
        <button
          type="button"
          className="who-toggle"
          aria-expanded={expanded}
          aria-controls={listId}
          title={expanded ? partout.replier : partout.afficher}
          onClick={() => setManual(!expanded)}
        >
          <Icon name="users" className="who-icon" />
          <strong className="who-title">{partout.titre}</strong>
          {!expanded && main !== null ? (
            <span className="who-summary ellipsis">
              {mainName} · {libelleEtatActeur(main, mainDetail, advanced)}
            </span>
          ) : null}
          {!expanded && others > 0 ? (
            <span className="who-more">
              <span aria-hidden="true">{enPlus.court}</span>
              <span className="visually-hidden">{enPlus.accessible}</span>
            </span>
          ) : null}
        </button>
        {!expanded && mainPermission !== null ? (
          <Button size="sm" variant="primary" aria-label={libelleRepondre(mainName)} onClick={() => onReply(mainPermission)}>
            {partout.repondre}
          </Button>
        ) : null}
      </div>
      {welcome ? <p className="who-welcome small">{partout.accueil}</p> : null}
      <div id={listId} className="who-body" hidden={!expanded}>
        <ActorList rows={rows} advanced={advanced} details={details} onReply={onReply} onOpenSession={onOpenSession} />
        {partial ? <p className="who-partial tiny muted">{partout.partiel}</p> : null}
      </div>
    </section>
  );
}
