// Propriétaire : L1f.
// Diagnostic du travail délégué (spécification §3.14 « Diagnostic », §3.11 « état Diagnostic visible »), dans la carte « Travail
// délégué et autonomie » : bandeaux relevés par le serveur (diagnostics-11.ts : subagent_depth > 1, sous-agents en arrière-plan,
// extensions de la configuration ou de oc-config/plugin(s)/, agents `task: allow`) et état d'installation des agents internes
// (agentsInternes, L1g). Chaque bandeau n'existe que si son relevé l'a constaté : aucune phrase ne dit « aucun » (un relevé
// impossible est journalisé par le serveur). Noms rendus en TEXTE par React (échappés), déjà bornés par le serveur. En mode Simple,
// ni « agent » ni « sous-agent » : textes de delegation-texts.ts, contrôlés par le test « textes ».
// InternalAgentsStatus est exporté pour AutonomyDiagnostics (L12c, « installation des agents internes ») : une seule façon de dire
// cet état. Propriétés figées dans ../chat/slots.ts ; s'annonce par onPresence(true) quand il affiche quelque chose.
import { useEffect, useId } from "react";
import {
  bandeauDiagnostic,
  etatAgentInterne,
  libelleAgentInterne,
  nomAgentInterne,
  titreAgentsInternes,
  titreDiagnostic,
} from "../../../server/shared/delegation-texts.ts";
import { useApp } from "../../app/AppContext.tsx";
import { Icon, type IconName } from "../../components/Icon.tsx";
import { formatTime } from "../../lib/format.ts";
import type { DelegationBanner, InternalAgentState, InternalAgentStatus } from "../../lib/types.ts";
import type { ActivityDiagnosticsProps } from "../chat/slots.ts";
import "../chat/delegation/delegation.css";

/** Icône de chaque état (le mot reste le texte accessible, l'icône est décorative). */
const STATE_ICONS: Readonly<Record<InternalAgentState, IconName>> = {
  installe: "check",
  "en-attente": "hourglass",
  echec: "alert",
  "non-suivi": "minus",
};

export function DelegationDiagnostics({ data, onPresence }: ActivityDiagnosticsProps) {
  const { advanced } = useApp();
  const titleId = useId();
  // Réponse d'un autre serveur (plus ancien ou plus récent) : champs absents lus comme vides, bandeaux inconnus sautés.
  const banners = (Array.isArray(data.delegation) ? data.delegation : [])
    .map((banner: DelegationBanner) => ({ code: banner.code, texte: bandeauDiagnostic(banner, advanced) }))
    .filter((banner): banner is { code: DelegationBanner["code"]; texte: string } => banner.texte !== null);
  const agents = Array.isArray(data.agentsInternes) ? data.agentsInternes : [];
  const present = banners.length > 0 || agents.length > 0;

  useEffect(() => onPresence(present), [present, onPresence]);

  if (!present) return null;
  return (
    <div className="delegation-diagnostics">
      {banners.length > 0 ? (
        <div>
          <h4 id={titleId}>{titreDiagnostic(advanced)}</h4>
          <ul className="delegation-banners" aria-labelledby={titleId}>
            {banners.map((banner) => (
              <li key={banner.code} className="callout warning small">
                <Icon name="alert" size={14} />
                <span>{banner.texte}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <InternalAgentsStatus agents={agents} advanced={advanced} />
    </div>
  );
}

/**
 * État d'installation des agents internes du cockpit (§3.11 : installés au repos, reprise 30 s → 5 min) : nom (libellé en mode
 * Simple, libellé et nom réservé en mode Avancé), état en mots, heure du prochain essai. Rien sans agent.
 */
export function InternalAgentsStatus({ agents, advanced }: { agents: readonly InternalAgentStatus[]; advanced: boolean }) {
  const titleId = useId();
  if (agents.length === 0) return null;
  return (
    <div>
      <h4 id={titleId}>{titreAgentsInternes(advanced)}</h4>
      <ul className="delegation-internal-list" aria-labelledby={titleId}>
        {agents.map((agent) => {
          const icon = Object.hasOwn(STATE_ICONS, agent.etat) ? STATE_ICONS[agent.etat] : "minus";
          const known = libelleAgentInterne(agent.nom) !== null;
          return (
            <li key={agent.nom} className={`delegation-internal-item ${agent.etat}`}>
              <Icon name={icon} size={14} />
              <span className="delegation-internal-name">
                {nomAgentInterne(agent.nom, advanced)}
                {advanced && known ? <code>{agent.nom}</code> : null}
              </span>
              <span className="delegation-internal-state">{etatAgentInterne(agent, formatTime)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
