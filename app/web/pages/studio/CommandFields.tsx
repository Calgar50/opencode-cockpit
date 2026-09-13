// Champs d'une commande : description, agent, modèle, sous-tâche + aide sur la syntaxe du modèle.
import { useId } from "react";
import { Icon } from "../../components/Icon.tsx";
import { Field, ToggleRow, useAsync } from "../../components/ui.tsx";
import { oc } from "../../lib/api.ts";
import type { ModelInfo } from "../../lib/types.ts";
import { modelPatch, VariantField } from "./AgentFields.tsx";
import { type Draft, str } from "./shared.ts";
import { ModelSelect } from "./widgets.tsx";

const MODE_LABEL: Record<string, string> = { primary: "principal", subagent: "sous-agent", all: "tous modes" };

export function CommandFields({
  draft,
  models,
  setFm,
}: {
  draft: Draft;
  models: ModelInfo[];
  setFm: (patch: Record<string, unknown>) => void;
}) {
  const ids = { description: useId(), agent: useId(), model: useId() };
  const agents = useAsync(() => oc.agents(), []);
  const fm = draft.frontmatter;
  const agent = str(fm.agent);
  const list = (agents.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
  const known = !agent || list.some((a) => a.name === agent);

  return (
    <div className="stack">
      <Field label="Description" htmlFor={ids.description} hint="Affichée dans la liste des commandes du chat.">
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
          hint={agents.error ? "Liste des agents indisponible (opencode injoignable ?)." : "Vide : l'agent actif dans la conversation."}
        >
          <select id={ids.agent} className="select" value={agent} onChange={(e) => setFm({ agent: e.target.value || undefined })}>
            <option value="">Agent courant</option>
            {!known ? <option value={agent}>{agent} (introuvable)</option> : null}
            {list.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name} · {MODE_LABEL[a.mode] ?? a.mode}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Modèle" htmlFor={ids.model} hint="Vide : le modèle de l'agent ou de la conversation.">
          <ModelSelect id={ids.model} value={str(fm.model) || null} models={models} onChange={(key) => setFm(modelPatch(key, draft, models))} />
        </Field>
        <VariantField draft={draft} models={models} setFm={setFm} />
      </div>
      <div>
        <ToggleRow
          title="Exécuter en sous-tâche"
          description="La commande tourne dans une session enfant : la conversation principale ne reçoit que le résultat."
          checked={fm.subtask === true}
          onChange={(v) => setFm({ subtask: v ? true : undefined })}
        />
      </div>
    </div>
  );
}

export function CommandBodyHelp() {
  return (
    <div className="callout accent">
      <Icon name="question" size={18} />
      <div className="stack tight" style={{ minWidth: 0 }}>
        <strong>Syntaxe du modèle</strong>
        <ul>
          <li>
            <code>$ARGUMENTS</code> : tout le texte saisi après la commande (ex. <code>/revue le module de paiement</code>).
          </li>
          <li>
            <code>$1</code>, <code>$2</code>… : arguments séparés par des espaces.
          </li>
          <li>
            <code>!`commande`</code> : insère la sortie d'une commande shell (ex. <code>!`git diff --staged`</code>), exécutée dans le dossier
            du projet.
          </li>
          <li>
            <code>@fichier</code> : joint le contenu d'un fichier du projet (ex. <code>@src/index.ts</code>).
          </li>
        </ul>
      </div>
    </div>
  );
}
