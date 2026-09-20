// Mode HTTP local vu par l'interface : bandeau permanent (I6) et explications (K2-4), partagés par la coquille, la fenêtre des
// règles et la page Diagnostic, pour que le texte soit le même partout.
import type { ReactNode } from "react";
import type { LocalAccessNotice } from "../../server/shared/local-access-notice.ts";
import { Icon } from "../components/Icon.tsx";
import { Button } from "../components/ui.tsx";
import { formatDateTime } from "../lib/format.ts";

/** Ce qui circule en clair, qui peut le lire, comment se connecter et comment revenir en HTTPS (plan §3.1). */
export const LOCAL_HTTP_EXPLANATIONS: ReadonlyArray<{ label: string; hint: ReactNode }> = [
  {
    label: "Ce qui circule en clair sur ce PC",
    hint: "Le cookie qui vous garde connecté et tout le contenu des pages : vos conversations, le code affiché, et le code de connexion GitHub quand il s'affiche.",
  },
  {
    label: "Qui peut le lire",
    hint: (
      <>
        Les outils de sécurité installés sur ce poste quand ils examinent le trafic ; un programme lancé en administrateur sur ce PC ;
        toute personne qui peut piloter Docker Desktop ici. Cette dernière peut de toute façon lire le jeton dans le conteneur, en HTTPS
        comme en HTTP.
      </>
    ),
  },
  {
    label: "Connexion",
    hint: (
      <>
        Ouvrez toujours le cockpit avec <code>.\cockpit.ps1 open</code> : il vérifie le cockpit avant d'ouvrir le lien. Ne saisissez
        jamais le jeton dans une page ; l'écran de connexion ne le demande pas.
      </>
    ),
  },
  {
    label: "Revenir en HTTPS",
    hint: (
      <>
        <code>.\install.ps1 -Https</code>, seulement si Edge l'autorise : vérifiez d'abord <code>.\cockpit.ps1 diag</code>. Le jeton est
        alors remplacé et une reconnexion est demandée.
      </>
    ),
  },
];

/**
 * Bandeau permanent du mode HTTP local (I6) : pas de bouton de fermeture, pas de préférence, hors notice de version.
 * `detailsId` : le bouton Détails déplie un panneau de la même fenêtre (aria-expanded) au lieu de changer de page.
 */
export function LocalHttpBanner({
  notice,
  onDetails,
  detailsId,
  detailsOpen = false,
}: {
  notice: LocalAccessNotice;
  onDetails?: () => void;
  detailsId?: string;
  detailsOpen?: boolean;
}) {
  return (
    <div className="banner warning" role="status" data-testid="local-http-banner">
      <Icon name="shield" />
      <span className="spacer">
        <strong>Connexion locale non chiffrée</strong>{" "}
        {notice.kind === "http-choisi"
          ? `(choix d'installation du ${formatDateTime(Date.parse(notice.confirmedAt))}).`
          : "(mode HTTP choisi à l'installation)."}
        {onDetails ? " Aucune action requise au quotidien." : ""}
      </span>
      {onDetails ? (
        <Button
          size="sm"
          onClick={onDetails}
          aria-controls={detailsId}
          aria-expanded={detailsId === undefined ? undefined : detailsOpen}
        >
          Détails
        </Button>
      ) : null}
    </div>
  );
}

/** Panneau déplié par le bandeau quand la page Diagnostic n'est pas accessible (fenêtre des règles ouverte). */
export function LocalHttpDetails({ id }: { id: string }) {
  return (
    <dl id={id} className="local-http-details" data-testid="local-http-details">
      {LOCAL_HTTP_EXPLANATIONS.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.hint}</dd>
        </div>
      ))}
    </dl>
  );
}
