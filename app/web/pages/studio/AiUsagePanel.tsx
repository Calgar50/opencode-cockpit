// Panneau « Quelle IA sera utilisée ? » d'un agent ou d'un raccourci, et avertissements du raccourci (§5.2).
import { type ReactNode, useMemo } from "react";
import { toCatalogLite } from "../../../server/shared/assistant-rules.ts";
import { useApp } from "../../app/AppContext.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Button } from "../../components/ui.tsx";
import {
  agentLiteFromDraft,
  agentLiteFromOc,
  agentUsage,
  commandLiteFromDraft,
  commandLiteFromOc,
  commandUsage,
  conversationNote,
  DELEGATED_NOTE,
  type StudioAiData,
  type UsageEnv,
  type UsageLine,
} from "./aiUsage.ts";

const AGENTS_UNAVAILABLE = "Liste des agents indisponible (opencode injoignable ?) : l'IA ne peut pas être prédite.";

function useUsageEnv(ai: StudioAiData): UsageEnv {
  const { boot } = useApp();
  const catalog = useMemo(() => toCatalogLite(boot.models), [boot.models]);
  const agents = useMemo(() => (ai.agents ?? []).map(agentLiteFromOc), [ai.agents]);
  const tiers = boot.ai?.tiers;
  const chatDefaultTier = boot.ai?.chatDefaultTier ?? "equilibre";
  return useMemo(
    () => ({ catalog, models: boot.models, tiers: tiers ?? [], chatDefaultTier, agents }),
    [catalog, boot.models, tiers, chatDefaultTier, agents],
  );
}

function UsagePanel({
  lines,
  notes = [],
  status,
  renderAction,
}: {
  lines: UsageLine[];
  notes?: string[];
  status?: string | null;
  renderAction?: (line: UsageLine) => ReactNode;
}) {
  return (
    <div className="callout accent ai-usage">
      <Icon name="question" size={18} />
      <div className="stack tight" style={{ minWidth: 0 }}>
        <strong>Quelle IA sera utilisée ?</strong>
        {lines.length > 0 ? (
          <ul className="ai-usage-list">
            {lines.map((line) => (
              <li key={line.id} className={`ai-usage-line ${line.tone}`}>
                {line.tone === "warning" || line.tone === "critical" ? <Icon name="alert" size={14} /> : null}
                <span className="spacer">{line.text}</span>
                {renderAction?.(line)}
              </li>
            ))}
          </ul>
        ) : null}
        {notes.map((note) => (
          <span key={note} className="small muted">
            {note}
          </span>
        ))}
        {status ? <span className="small muted">{status}</span> : null}
      </div>
    </div>
  );
}

/** Agent : dans le chat, par délégation et dans chaque raccourci qui le désigne. */
export function AgentAiPanel({ name, frontmatter, ai }: { name: string; frontmatter: Record<string, unknown>; ai: StudioAiData }) {
  const base = useUsageEnv(ai);
  const agentName = name || "nouvel-agent";
  const saved = base.agents.find((a) => a.name === agentName);
  const agent = agentLiteFromDraft(agentName, frontmatter, saved);
  const env: UsageEnv = { ...base, agents: [...base.agents.filter((a) => a.name !== agentName), agent] };
  const commands = (ai.commands ?? []).filter((c) => c.agent === agentName && (c.source ?? "command") === "command").map(commandLiteFromOc);
  const lines = agentUsage(agent, frontmatter.disable === true, env, commands);
  const status =
    ai.commands === null && !ai.commandsError
      ? "Chargement des raccourcis…"
      : ai.commandsError
        ? "Liste des raccourcis indisponible (opencode injoignable ?)."
        : null;
  return <UsagePanel lines={lines} status={status} />;
}

/** Raccourci : IA du raccourci ou du travail délégué, avec « La retirer » et « Retirer l'IA du raccourci ». */
export function CommandAiPanel({
  name,
  frontmatter,
  ai,
  onRemoveVariant,
  onRemoveModel,
}: {
  name: string;
  frontmatter: Record<string, unknown>;
  ai: StudioAiData;
  onRemoveVariant: () => void;
  onRemoveModel: () => void;
}) {
  const env = useUsageEnv(ai);
  const command = commandLiteFromDraft(name || "nom", frontmatter);
  if (command.agent && ai.agents === null) {
    return <UsagePanel lines={[]} status={ai.agentsError ? AGENTS_UNAVAILABLE : "Chargement des agents…"} />;
  }
  const usage = commandUsage(command, env, { kind: "command" });
  const notes: string[] = [];
  if (usage.chatDerived) notes.push(conversationNote(env));
  if (usage.delegated) notes.push(DELEGATED_NOTE);
  return (
    <UsagePanel
      lines={usage.lines}
      notes={notes}
      renderAction={(line) =>
        line.problem?.code === "reflexion-deleguee-ignoree" ? (
          <Button size="sm" onClick={onRemoveVariant}>
            La retirer
          </Button>
        ) : line.problem?.code === "ia-du-raccourci-ignoree" ? (
          <Button size="sm" onClick={onRemoveModel}>
            Retirer l'IA du raccourci
          </Button>
        ) : null
      }
    />
  );
}
