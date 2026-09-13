// Préférences par défaut du chat : assistant, dossier de travail et (mode Avancé) IA par défaut obsolète.
import { useId } from "react";
import { MESSAGES, TIER_LABELS } from "../../../server/shared/assistant-rules.ts";
import { useApp } from "../../app/AppContext.tsx";
import { Card, Field, useAsync } from "../../components/ui.tsx";
import { oc } from "../../lib/api.ts";
import { isInternalAgent } from "../studio/shared.ts";
import { ModelSelect } from "../studio/widgets.tsx";
import { SectionFooter, useDraft, useReportDirty, useSettingsSave } from "./common.tsx";

export function ChatTab({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const { boot } = useApp();
  const ids = { model: useId(), agent: useId(), directory: useId() };
  const { draft, setDraft, dirty, reset } = useDraft(boot.settings.chat);
  const { save, resetSection, saving, issues } = useSettingsSave();
  const agents = useAsync(() => oc.agents(), []);
  useReportDirty(dirty, onDirtyChange);

  // Mode Simple : seuls le dossier de travail (et le niveau, onglet Niveaux d'IA) se règlent ; l'IA par défaut y est ignorée.
  const advanced = boot.ui?.mode === "avance";
  const levelLabel = TIER_LABELS[boot.ai?.chatDefaultTier ?? "equilibre"];
  const primaryAgents = (agents.data ?? [])
    .filter((a) => a.mode !== "subagent" && !a.hidden && !isInternalAgent(a))
    .sort((a, b) => a.name.localeCompare(b.name));
  const agentKnown = !draft.defaultAgent || primaryAgents.some((a) => a.name === draft.defaultAgent);
  const directoryKnown = !draft.defaultDirectory || boot.projects.some((p) => p.directory === draft.defaultDirectory);
  const agentHint = !advanced
    ? MESSAGES.modeAvance
    : agents.error
      ? "Liste des agents indisponible : saisissez le nom de l'agent."
      : "Assistant proposé à chaque nouvelle conversation.";

  return (
    <Card title="Valeurs par défaut du chat" subtitle="Appliquées à l'ouverture du cockpit et aux nouvelles conversations.">
      <div className="settings-form">
        {advanced ? (
          <Field label="IA" htmlFor={ids.model} hint={`Vide : le niveau ${levelLabel}.`}>
            <ModelSelect
              id={ids.model}
              value={draft.defaultModel}
              models={boot.models}
              emptyLabel={`Niveau ${levelLabel}`}
              onChange={(value) => setDraft((d) => ({ ...d, defaultModel: value }))}
            />
          </Field>
        ) : null}

        <Field label="Assistant" htmlFor={ids.agent} hint={agentHint}>
          {agents.error ? (
            <input
              id={ids.agent}
              className="input mono"
              maxLength={64}
              value={draft.defaultAgent ?? ""}
              placeholder="build"
              disabled={!advanced}
              onChange={(e) => setDraft((d) => ({ ...d, defaultAgent: e.target.value.trim() || null }))}
              style={{ maxWidth: 320 }}
            />
          ) : (
            <select
              id={ids.agent}
              className="select"
              value={draft.defaultAgent ?? ""}
              disabled={!advanced}
              onChange={(e) => setDraft((d) => ({ ...d, defaultAgent: e.target.value || null }))}
            >
              <option value="">Assistant général</option>
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
          onReset={
            advanced
              ? async () => {
                  await resetSection("chat", "Préférences du chat réinitialisées");
                }
              : undefined
          }
        />
      </div>
    </Card>
  );
}
