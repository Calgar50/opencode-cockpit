// Propriétaire : L12c.
// Diagnostic de l'autonomie : interrupteur `COCKPIT_AUTONOMY`, porte I1 (`activationOuverte`), IA de contrôle
// (`budget.autonomie.controleIa`) et installation gardée de l'assistant de contrôle (spécification §3.11, §3.14, §4.12 ;
// décisions n° 8 et n° 13), dans la carte « Travail délégué et autonomie ». Données : GET /api/diagnostic/activite (route de T0,
// remplie par L1f et L11b) ; cette page n'écrit rien et ne déclenche aucune exécution : elle montre un état.
// Phrases : server/shared/autonomy-choice-texts.ts (raisons d'indisponibilité), autonomy-texts.ts (IA de contrôle coupée) et
// delegation-texts.ts (état d'installation, même phrase que la liste des outils internes : une seule façon de le dire). La liste
// complète des outils internes reste celle de DelegationDiagnostics (L1f) ; ce bloc ne reprend l'installation que de l'assistant
// de contrôle, et seulement quand elle n'est pas faite, parce qu'elle explique alors pourquoi les commandes attendent.
// Réponse d'un autre serveur (plus ancien ou plus récent) : un champ absent n'est pas deviné, sa ligne disparaît.
// Propriétés figées dans ../chat/slots.ts ; s'annonce par onPresence(true) quand il affiche quelque chose. Aucune animation.
import { useEffect, useId, useMemo } from "react";
import { libelleChoix, raisonIndisponible, TEXTES as TEXTES_CHOIX } from "../../../server/shared/autonomy-choice-texts.ts";
import { controleIaIndisponible, libellePar } from "../../../server/shared/autonomy-texts.ts";
import { CONTROL_AGENT_NAME } from "../../../server/shared/control-ai-output.ts";
import { etatAgentInterne } from "../../../server/shared/delegation-texts.ts";
import { useApp } from "../../app/AppContext.tsx";
import { Icon, type IconName } from "../../components/Icon.tsx";
import { formatTime } from "../../lib/format.ts";
import type { DiagnosticActiviteResponse, InternalAgentStatus } from "../../lib/types.ts";
import type { ActivityDiagnosticsProps } from "../chat/slots.ts";
import "../chat/autonomy/autonomy-journal.css";

/** Ligne du Diagnostic : nom, nom réservé montré en mode Avancé, état en mots, icône qui accompagne le mot. */
interface LigneAutonomie {
  cle: string;
  nom: string;
  code: string | null;
  etat: string;
  icone: IconName;
  ok: boolean;
}

const OUI: IconName = "check";
const NON: IconName = "ban";
const ATTENTE: IconName = "hourglass";

/** Les deux choix qui répondent sans vous, nommés par leur libellé exact (§4.13). */
const CHOIX_AUTOMATIQUES = `Disponibles : « ${libelleChoix("modifications")} » et « ${libelleChoix("autonome")} ».`;
/** IA de contrôle active et installée (§4.6) : ce qu'elle juge, sans promettre qu'elle ne se trompe jamais. */
const CONTROLE_ACTIF = "Active : les commandes que le cockpit ne connaît pas lui sont soumises, et chaque contrôle est facturé.";

/** État de l'assistant de contrôle du cockpit dans la réponse ; absent : état non suivi. */
function etatControle(agents: readonly InternalAgentStatus[]): InternalAgentStatus | null {
  return agents.find((agent) => agent.nom === CONTROL_AGENT_NAME) ?? null;
}

/**
 * Lignes du Diagnostic de l'autonomie. L'autonomie n'est ouverte que si l'interrupteur est à « on » ET si la porte I1 est
 * franchie : la cause affichée est celle qui s'applique, jamais une phrase inventée.
 */
export function lignesAutonomie(data: DiagnosticActiviteResponse, advanced: boolean): LigneAutonomie[] {
  const lignes: LigneAutonomie[] = [];
  const interrupteur = data.interrupteur;
  const ouverte = data.activationOuverte;
  if (typeof interrupteur === "boolean" || typeof ouverte === "boolean") {
    const coupee = interrupteur === false;
    const fermee = ouverte === false;
    lignes.push({
      cle: "autonomie",
      nom: TEXTES_CHOIX.partout.selecteur,
      code: advanced ? "COCKPIT_AUTONOMY" : null,
      etat: coupee ? raisonIndisponible("autonomie-coupee") : fermee ? raisonIndisponible("a-venir") : CHOIX_AUTOMATIQUES,
      icone: coupee ? NON : fermee ? ATTENTE : OUI,
      ok: !coupee && !fermee,
    });
  }
  if (typeof data.controleIa === "boolean") {
    const agents = Array.isArray(data.agentsInternes) ? data.agentsInternes : [];
    const agent = etatControle(agents);
    const installe = agent === null || agent.etat === "installe";
    const etat = data.controleIa
      ? installe
        ? CONTROLE_ACTIF
        : etatAgentInterne(agent, formatTime)
      : controleIaIndisponible("desactive");
    lignes.push({
      cle: "controle",
      nom: libellePar("ia-controle"),
      code: advanced ? CONTROL_AGENT_NAME : null,
      etat,
      icone: !data.controleIa ? NON : installe ? OUI : ATTENTE,
      ok: data.controleIa === true && installe,
    });
  }
  return lignes;
}

export function AutonomyDiagnostics({ data, onPresence }: ActivityDiagnosticsProps) {
  const { advanced } = useApp();
  const titleId = useId();
  const lignes = useMemo(() => lignesAutonomie(data, advanced), [data, advanced]);
  const present = lignes.length > 0;

  useEffect(() => onPresence(present), [present, onPresence]);

  if (!present) return null;
  return (
    <div className="autonomy-diagnostics">
      <h4 id={titleId}>{TEXTES_CHOIX.partout.selecteur}</h4>
      <ul className="autonomy-diagnostic-list" aria-labelledby={titleId}>
        {lignes.map((ligne) => (
          <li key={ligne.cle} className={`autonomy-diagnostic-item${ligne.ok ? "" : " attention"}`}>
            <Icon name={ligne.icone} size={14} />
            <span className="autonomy-diagnostic-name">
              {ligne.nom}
              {ligne.code === null ? null : <code>{ligne.code}</code>}
            </span>
            <span className="autonomy-diagnostic-state">{ligne.etat}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
