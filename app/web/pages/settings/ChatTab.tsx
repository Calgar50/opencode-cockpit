// Préférences par défaut du chat : modèle, agent et dossier de travail.
import { useId } from "react";
import { useApp } from "../../app/AppContext.tsx";
import { Card, Field, useAsync } from "../../components/ui.tsx";
import { oc } from "../../lib/api.ts";
import { ModelSelect } from "../studio/widgets.tsx";
import { SectionFooter, useDraft, useReportDirty, useSettingsSave } from "./common.tsx";

export function ChatTab({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const { boot } = useApp();
  const ids = { model: useId(), agent: useId(), directory: useId() };
  const { draft, setDraft, dirty, reset } = useDraft(boot.settings.chat);
  const { save, resetSection, saving, issues } = useSettingsSave();
  const agents = useAsync(() => oc.agents(), []);
  useReportDirty(dirty, onDirtyChange);

  const primaryAgents = (agents.data ?? []).filter((a) => a.mode !== "subagent" && !a.hidden).sort((a, b) => a.name.localeCompare(b.name));
  const agentKnown = !draft.defaultAgent || primaryAgents.some((a) => a.name === draft.defaultAgent);
  const directoryKnown = !draft.defaultDirectory || boot.projects.some((p) => p.directory === draft.defaultDirectory);

  return (
    <Card title="Valeurs par défaut du chat" subtitle="Appliquées à l'ouverture du cockpit et aux nouvelles conversations.">
      <div className="settings-form">
        <Field label="Modèle" htmlFor={ids.model} hint="Vide : le modèle par défaut défini dans la configuration d'opencode.">
          <ModelSelect
            id={ids.model}
            value={draft.defaultModel}
            models={boot.models}
            emptyLabel="Modèle par défaut d'opencode"
            onChange={(value) => setDraft((d) => ({ ...d, defaultModel: value }))}
          />
        </Field>

        <Field
          label="Agent"
          htmlFor={ids.agent}
          hint={agents.error ? "Liste des agents indisponible : saisissez le nom de l'agent." : "Agents principaux uniquement (les sous-agents s'appellent avec @)."}
        >
          {agents.error ? (
            <input
              id={ids.agent}
              className="input mono"
              maxLength={64}
              value={draft.defaultAgent ?? ""}
              placeholder="build"
              onChange={(e) => setDraft((d) => ({ ...d, defaultAgent: e.target.value.trim() || null }))}
              style={{ maxWidth: 320 }}
            />
          ) : (
            <select
              id={ids.agent}
              className="select"
              value={draft.defaultAgent ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, defaultAgent: e.target.value || null }))}
            >
              <option value="">Agent par défaut d'opencode</option>
              {!agentKnown && draft.defaultAgent ? <option value={draft.defaultAgent}>{draft.defaultAgent} (introuvable)</option> : null}
              {primaryAgents.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                  {a.description ? ` · ${a.description.slice(0, 70)}` : ""}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field label="Dossier de travail" htmlFor={ids.directory} hint="Projet sélectionné à l'ouverture du chat (si aucun autre n'a été mémorisé par le navigateur).">
          <select
            id={ids.directory}
            className="select"
            value={draft.defaultDirectory ?? ""}
            onChange={(e) => setDraft((d) => ({ ...d, defaultDirectory: e.target.value || null }))}
          >
            <option value="">Premier projet disponible</option>
            {!directoryKnown && draft.defaultDirectory ? <option value={draft.defaultDirectory}>{draft.defaultDirectory} (introuvable)</option> : null}
            {boot.projects.map((p) => (
              <option key={p.directory} value={p.directory}>
                {p.isRoot ? `${p.name} (racine du workspace)` : p.name}
              </option>
            ))}
          </select>
        </Field>

        <SectionFooter
          dirty={dirty}
          saving={saving}
          issues={issues}
          onCancel={reset}
          onSave={() => void save({ chat: draft }, "Préférences du chat enregistrées")}
          onReset={async () => {
            await resetSection("chat", "Préférences du chat réinitialisées");
          }}
        />
      </div>
    </Card>
  );
}
