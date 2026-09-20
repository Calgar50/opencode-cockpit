// Propriétaire : L5t.
// Carte d'un travail délégué dans la transcription (spécification §5.1, §2.3, §3.14) : une partie `task` d'une réponse. Qui, état
// (mot et icône, jamais la couleur seule), durée, raccourci ou reprise ; consigne écrite et résultat rendus en TEXTE (textes
// d'IA : jamais du HTML ni du Markdown, React les échappe ; séquences de terminal et caractères cachés retirés, longueur bornée par
// boundedAiText) ; [Voir le travail délégué] ouvre la conversation déléguée dans le tiroir de lecture, où « Voir la consigne »
// montre la consigne réellement reçue (JP-4). Composant interne : ses propriétés restent libres pour son propriétaire. Aucune
// animation (web-animations.test.ts) : « travaille » est un mot, pas une roue qui tourne.
import { useId, useState } from "react";
import { Icon, type IconName } from "../../../components/Icon.tsx";
import { Button } from "../../../components/ui.tsx";
import { formatDuration } from "../../../lib/format.ts";
import type { OcToolPart } from "../../../lib/types.ts";
import { boundedAiText } from "../turn.ts";
import "./deroule.css";

export interface DelegationCardProps {
  /** Partie `task` (outil de délégation d'opencode). */
  part: OcToolPart;
  advanced: boolean;
  onOpenSession?: ((sessionId: string) => void) | undefined;
}

/** Nom d'assistant affiché au plus (entrée écrite par l'IA). */
const NAME_MAX = 64;
/** Description affichée au plus (entrée écrite par l'IA). */
const DESCRIPTION_MAX = 200;

type CardState = "pas-commence" | "travaille" | "termine" | "echec" | "arrete" | "jamais-demarre";

/** Libellés des états (§2.3) : le mot sert de texte accessible, l'icône l'accompagne. */
const STATES: Readonly<Record<CardState, { label: string; icon: IconName }>> = {
  "pas-commence": { label: "pas encore commencé", icon: "circle" },
  travaille: { label: "travaille", icon: "pulse" },
  termine: { label: "terminé", icon: "check" },
  echec: { label: "échec", icon: "alert" },
  arrete: { label: "arrêté", icon: "stop" },
  "jamais-demarre": { label: "jamais démarré", icon: "minus" },
};

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * État du travail délégué d'après sa partie `task` : sans conversation déléguée, il n'a pas commencé (écriture de l'appel, attente
 * de votre accord) ou n'a jamais démarré (refusé, arrêté avant) ; une interruption est un arrêt, jamais un échec.
 */
function cardState(part: OcToolPart, child: string): CardState {
  const state = part.state;
  switch (state.status) {
    case "pending":
      return "pas-commence";
    case "running":
      return child ? "travaille" : "pas-commence";
    case "completed":
      return "termine";
    default:
      if (state.metadata?.interrupted === true) return "arrete";
      return child ? "echec" : "jamais-demarre";
  }
}

/** Texte d'IA en lecture seule : texte brut échappé par React, retours à la ligne gardés par le style. */
function AiText({ label, value }: { label: string; value: unknown }) {
  const { text, clipped } = boundedAiText(value);
  if (!text.trim()) return null;
  return (
    <div className="delegation-text">
      <div className="tiny muted">{label}</div>
      <p className="delegation-text-body">
        {text}
        {clipped ? "\n… (texte coupé)" : ""}
      </p>
    </div>
  );
}

export function DelegationCard({ part, advanced, onOpenSession }: DelegationCardProps) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const state = part.state;
  const input = state.input ?? {};
  const metadata = ("metadata" in state ? state.metadata : undefined) ?? {};
  const child = str(metadata.sessionId);
  const status = cardState(part, child);
  const meta = STATES[status];
  const agent = boundedAiText(input.subagent_type, NAME_MAX).text;
  const description = boundedAiText(input.description, DESCRIPTION_MAX).text;
  const command = boundedAiText(input.command, NAME_MAX).text;
  const reprise = str(input.task_id) !== "";
  const duration = state.status === "completed" || state.status === "error" ? Math.max(0, state.time.end - state.time.start) : null;

  return (
    <div className={`delegation-card delegation-card--${status}`}>
      <button type="button" className="delegation-head" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((v) => !v)}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} className="muted" />
        <Icon name="users" size={15} />
        <span className="delegation-title nowrap">
          Travail délégué{agent ? " à " : ""}
          {agent ? <strong>{agent}</strong> : null}
        </span>
        <span className="delegation-desc ellipsis">{description}</span>
        <span className="spacer" />
        {duration !== null ? <span className="tiny muted nowrap">{formatDuration(duration)}</span> : null}
        <span className="delegation-state nowrap">
          <Icon name={meta.icon} size={13} />
          {meta.label}
        </span>
      </button>
      {command || reprise ? (
        <div className="delegation-notes tiny muted">
          {command ? <span>Lancé par le raccourci /{command}</span> : null}
          {reprise ? <span>Reprise d'un travail délégué déjà commencé</span> : null}
        </div>
      ) : null}
      {open ? (
        <div className="delegation-body" id={bodyId}>
          <AiText label={command ? "Consigne du raccourci" : "Consigne écrite par l'IA"} value={input.prompt} />
          {state.status === "completed" ? <AiText label="Résultat rendu" value={state.output} /> : null}
          {state.status === "error" ? <AiText label="Erreur" value={state.error} /> : null}
          {advanced && child ? <div className="tiny muted mono">{child}</div> : null}
          {child && onOpenSession ? (
            <div>
              <Button size="sm" icon="users" onClick={() => onOpenSession(child)}>
                Voir le travail délégué
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
