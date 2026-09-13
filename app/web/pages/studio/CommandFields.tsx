// Champs d'une commande (raccourci /nom) : description, agent, IA, réflexion, travail délégué + aide sur la syntaxe du texte.
import { useId } from "react";
import { DEFAULT_TIERS } from "../../../server/shared/assistant-rules.ts";
import { useApp } from "../../app/AppContext.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Field, ToggleRow } from "../../components/ui.tsx";
import type { ModelInfo } from "../../lib/types.ts";
import type { LevelBinding, StudioAiData } from "./aiUsage.ts";
import { CommandAiPanel } from "./AiUsagePanel.tsx";
import { LevelField, VariantField } from "./LevelField.tsx";
import { type Draft, isInternalAgent, str } from "./shared.ts";

const MODE_LABEL: Record<string, string> = { primary: "principal", subagent: "sous-agent", all: "tous modes" };

export function CommandFields({
  draft,
  models,
  setFm,
  level,
  ai,
}: {
  draft: Draft;
  models: ModelInfo[];
  setFm: (patch: Record<string, unknown>) => void;
  level: LevelBinding;
  ai: StudioAiData;
}) {
  const ids = { description: useId(), agent: useId() };
  const { boot } = useApp();
  const fm = draft.frontmatter;
  const agent = str(fm.agent);
  const all = ai.agents ?? [];
  const selected = agent ? all.find((a) => a.name === agent) : undefined;
  const list = all.filter((a) => !isInternalAgent(a)).sort((a, b) => a.name.localeCompare(b.name));
  const known = !agent || selected !== undefined || ai.agents === null;
  const autoDelegated = selected?.mode === "subagent" && fm.subtask !== false;

  // IA qui exécutera le raccourci : la sienne, sinon celle de son agent, sinon celle du niveau par défaut de la conversation.
  const chatTier = boot.ai?.chatDefaultTier ?? "equilibre";
  const chatView = boot.ai?.tiers.find((t) => t.id === chatTier);
  const agentModel = selected?.model ? `${selected.model.providerID}/${selected.model.modelID}` : null;
  const taskModel = str(fm.model) || agentModel || chatView?.model || DEFAULT_TIERS[chatTier].candidates[0] || null;

  return (
    <div className="stack">
      <Field label="Description" htmlFor={ids.description} hint="Affichée dans la liste des raccourcis du chat.">
        <input
          id={ids.description}
          className="input"
          maxLength={1024}
          value={str(fm.description)}
          onChange={(e) => setFm({ description: e.target.value || undefined })}
        />
      </Field>
      <div className="grid-2">
        <Field
          label="Agent"
          htmlFor={ids.agent}
          hint={ai.agentsError ? "Liste des agents indisponible (opencode injoignable ?)." : "Vide : l'assistant sélectionné dans le chat."}
        >
          <select id={ids.agent} className="select" value={agent} onChange={(e) => setFm({ agent: e.target.value || undefined })}>
            <option value="">Assistant du chat</option>
            {!known ? <option value={agent}>{agent} (introuvable)</option> : null}
            {selected && isInternalAgent(selected) ? <option value={agent}>{agent} (agent interne)</option> : null}
            {agent && ai.agents === null ? <option value={agent}>{agent}</option> : null}
            {list.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name} · {MODE_LABEL[a.mode] ?? a.mode}
              </option>
            ))}
          </select>
        </Field>
        <LevelField
          label="IA"
          hint="Vide : l'IA de l'agent choisi ci-dessus, sinon celle du chat. Si cet agent est un sous-agent avec sa propre IA, c'est toujours la sienne."
          draft={draft}
          models={models}
          setFm={setFm}
          level={level}
        />
        <VariantField
          draft={draft}
          models={models}
          setFm={setFm}
          modelKey={taskModel}
          hint="Réflexion de ce raccourci. Appliquée par le cockpit quand le raccourci n'est pas délégué."
        />
      </div>
      <div>
        <ToggleRow
          title="Travail délégué"
          description={
            autoDelegated
              ? "Automatique : cet agent ne travaille qu'en délégation."
              : "Un agent travaille à part ; ensuite l'IA de la conversation reprend la main (un tour d'IA en plus)."
          }
          checked={autoDelegated || fm.subtask === true}
          disabled={autoDelegated}
          onChange={(v) => setFm({ subtask: v ? true : undefined })}
        />
      </div>
      <CommandAiPanel
        name={draft.name}
        frontmatter={fm}
        ai={ai}
        onRemoveVariant={() => setFm({ variant: undefined })}
        onRemoveModel={() => {
          setFm({ model: undefined });
          if (level.tier) level.setTier(null);
        }}
      />
    </div>
  );
}

export function CommandBodyHelp() {
  return (
    <div className="callout accent">
      <Icon name="question" size={18} />
      <div className="stack tight" style={{ minWidth: 0 }}>
        <strong>Syntaxe du texte</strong>
        <ul>
          <li>
            <code>$ARGUMENTS</code> : tout le texte saisi après la commande (ex. <code>/revue le module de paiement</code>).
          </li>
          <li>
            <code>$1</code>, <code>$2</code>… : arguments séparés par des espaces.
          </li>
          <li>
            <code>!`commande`</code> : insère la sortie d'une commande shell (ex. <code>!`git diff --staged`</code>), exécutée dans le dossier
            du projet. <strong>Attention : ces lignes s'exécutent à chaque lancement, sans vous demander.</strong>
          </li>
          <li>
            <code>@fichier</code> : joint le contenu d'un fichier du projet (ex. <code>@src/index.ts</code>).
          </li>
        </ul>
      </div>
    </div>
  );
}
