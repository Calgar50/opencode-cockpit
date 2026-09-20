// Écran et bandeau de la reprise de l'amorçage (1.1, décision U4). Logique : server/shared/boot-recovery.ts ; textes :
// server/shared/boot-recovery-texts.ts (contrôlés par le test « textes »).
// Aucune animation (pas d'indicateur tournant : .spinner tourne sans fin), aucune minuterie d'affichage, annonce polie
// (role="status") et focus jamais pris : ni à l'apparition ni à la disparition du bandeau. Seule exception, le focus perdu :
// si « Réessayer » avait le focus quand le bandeau disparaît avec lui, le focus retomberait sur body (un lecteur d'écran
// perdrait sa position). Il est alors posé sur la zone d'annonce, qui reste à la même place (constat de la vérification de
// c630349).
import { useLayoutEffect, useRef } from "react";
import { type BootView, focusARattraper } from "../../server/shared/boot-recovery.ts";
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
 *
 * La zone est focalisable par programme seulement (tabIndex -1, hors de l'ordre de tabulation) : c'est là que revient un
 * focus perdu avec le bandeau, sans défilement ; la touche Tab suivante mène à l'élément qui suivait le bandeau.
 */
export function RecoveryBanner({ view, masque, onRetry }: { view: BootView<unknown>; masque: boolean; onRetry: () => void }) {
  const retry = masque ? null : view.retry;
  const bandeau = retry !== null;
  const zone = useRef<HTMLDivElement>(null);
  const focusDansLaZone = useRef(false);

  // Après le retrait du bandeau (DOM déjà à jour, avant l'affichage) : le bouton retiré a laissé le focus sur body.
  useLayoutEffect(() => {
    if (!bandeau && focusARattraper(focusDansLaZone.current, document.activeElement, document.body)) zone.current?.focus({ preventScroll: true });
  }, [bandeau]);

  return (
    <div
      ref={zone}
      tabIndex={-1}
      data-testid="reprise-amorcage"
      role="status"
      onFocus={() => {
        focusDansLaZone.current = true;
      }}
      onBlur={(e) => {
        // Focus parti ailleurs (Tab, clic) : plus rien à rattraper. Un élément retiré du DOM n'est pas un départ.
        if (e.target.isConnected && !zone.current?.contains(e.relatedTarget as Node | null)) focusDansLaZone.current = false;
      }}
    >
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
