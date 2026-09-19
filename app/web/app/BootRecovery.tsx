// Écran et bandeau de la reprise de l'amorçage (1.1, décision U4). Logique : server/shared/boot-recovery.ts ; textes :
// server/shared/boot-recovery-texts.ts (contrôlés par le test « textes »).
// Aucune animation (pas d'indicateur tournant : .spinner tourne sans fin), aucune minuterie d'affichage, annonce polie
// (role="status") et focus jamais déplacé : ni à l'apparition ni à la disparition du bandeau.
import type { BootView } from "../../server/shared/boot-recovery.ts";
import { nextAttemptText, TEXTES } from "../../server/shared/boot-recovery-texts.ts";
import { Icon } from "../components/Icon.tsx";
import { Button } from "../components/ui.tsx";

const T = TEXTES.partout;

/** Écran « Le cockpit ne répond pas » : seulement tant que l'interface n'a jamais été chargée ; la reprise continue seule. */
export function BootErrorScreen({ view, onRetry }: { view: BootView<unknown>; onRetry: () => void }) {
  return (
    <div className="empty" style={{ height: "100%" }}>
      <Icon name="alert" size={32} />
      <h3>{T.titre}</h3>
      <p>{view.error}</p>
      <p className="small muted" role="status">
        {view.retry ? nextAttemptText(view.retry.delayMs) : null}
      </p>
      <Button variant="primary" icon="refresh" onClick={onRetry}>
        {T.reessayer}
      </Button>
    </div>
  );
}

/**
 * Zone d'annonce de la reprise, toujours présente dans l'interface chargée (une zone role="status" doit exister avant son
 * texte pour être lue) : bandeau non bloquant pendant une reprise, puis « Le cockpit répond de nouveau » pour les lecteurs
 * d'écran seulement. `masque` : la bannière « Connexion au cockpit perdue » est affichée (elle dit de recharger la page) ;
 * la reprise continue, sans second bandeau.
 */
export function RecoveryBanner({ view, masque, onRetry }: { view: BootView<unknown>; masque: boolean; onRetry: () => void }) {
  const retry = masque ? null : view.retry;
  return (
    <div data-testid="reprise-amorcage" role="status">
      {retry ? (
        <div className="banner warning">
          <Icon name="alert" />
          <span className="spacer">
            {T.bandeau} {nextAttemptText(retry.delayMs)}
          </span>
          <Button size="sm" icon="refresh" onClick={onRetry}>
            {T.reessayer}
          </Button>
        </div>
      ) : view.recovered ? (
        <span className="visually-hidden">{T.retabli}</span>
      ) : null}
    </div>
  );
}
