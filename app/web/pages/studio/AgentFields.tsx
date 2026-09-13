// Champs d'un agent : description, mode, modèle, réglages et permissions.
import { useId } from "react";
import { Field, ToggleRow } from "../../components/ui.tsx";
import type { ModelInfo } from "../../lib/types.ts";
import { PermissionsEditor } from "./PermissionsEditor.tsx";
import { type Draft, HEX_RE, str, THEME_COLORS } from "./shared.ts";
import { ModelSelect, NumberInput } from "./widgets.tsx";

const COLOR_LABELS: Record<(typeof THEME_COLORS)[number], string> = {
  primary: "Principale",
  secondary: "Secondaire",
  accent: "Accent",
  success: "Succès",
  warning: "Avertissement",
  error: "Erreur",
  info: "Info",
};

export function VariantField({
  draft,
  models,
  setFm,
}: {
  draft: Draft;
  models: ModelInfo[];
  setFm: (patch: Record<string, unknown>) => void;
}) {
  const id = useId();
  const model = models.find((m) => m.key === draft.frontmatter.model);
  const variant = str(draft.frontmatter.variant);
  if (!model || model.variants.length === 0) return null;
  return (
    <Field label="Variante" htmlFor={id} hint="Niveau de raisonnement ou déclinaison proposée par le modèle.">
      <select id={id} className="select" value={variant} onChange={(e) => setFm({ variant: e.target.value || undefined })}>
        <option value="">Par défaut</option>
        {variant && !model.variants.includes(variant) ? <option value={variant}>{variant} (inconnue)</option> : null}
        {model.variants.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** Retire la variante si le nouveau modèle ne la propose pas. */
export function modelPatch(key: string | null, draft: Draft, models: ModelInfo[]): Record<string, unknown> {
  const patch: Record<string, unknown> = { model: key ?? undefined };
  const variant = str(draft.frontmatter.variant);
  if (variant) {
    const next = models.find((m) => m.key === key);
    if (!next || !next.variants.includes(variant)) patch.variant = undefined;
  }
  return patch;
}

export function AgentFields({
  draft,
  models,
  setFm,
}: {
  draft: Draft;
  models: ModelInfo[];
  setFm: (patch: Record<string, unknown>) => void;
}) {
  const ids = { description: useId(), mode: useId(), model: useId(), temperature: useId(), steps: useId(), color: useId() };
  const fm = draft.frontmatter;
  const description = str(fm.description);
  const color = str(fm.color);
  const colorMode = !color ? "" : (THEME_COLORS as readonly string[]).includes(color) ? color : "custom";
  const mode = str(fm.mode) || "all";

  return (
    <div className="stack">
      <Field
        label="Description"
        htmlFor={ids.description}
        hint="Obligatoire. Explique quand utiliser cet agent : opencode s'en sert pour choisir le bon sous-agent."
        error={!description.trim() ? "La description est obligatoire." : null}
      >
        <textarea
          id={ids.description}
          className="textarea"
          rows={2}
          maxLength={1024}
          value={description}
          onChange={(e) => setFm({ description: e.target.value })}
        />
      </Field>

      <div className="grid-2">
        <Field
          label="Mode"
          htmlFor={ids.mode}
          hint={
            mode === "primary"
              ? "Sélectionnable dans le chat (touche Tab)."
              : mode === "subagent"
                ? "Appelé par un autre agent ou avec @nom."
                : "Utilisable comme agent principal et comme sous-agent."
          }
        >
          <select id={ids.mode} className="select" value={mode} onChange={(e) => setFm({ mode: e.target.value })}>
            <option value="primary">Principal</option>
            <option value="subagent">Sous-agent</option>
            <option value="all">Les deux</option>
          </select>
        </Field>
        <Field label="Modèle" htmlFor={ids.model} hint="Vide : le modèle choisi dans le chat ou celui d'opencode.">
          <ModelSelect id={ids.model} value={str(fm.model) || null} models={models} onChange={(key) => setFm(modelPatch(key, draft, models))} />
        </Field>
        <VariantField draft={draft} models={models} setFm={setFm} />
        <Field label="Température" htmlFor={ids.temperature} hint="Optionnelle, de 0 (précis) à 2 (créatif).">
          <NumberInput
            id={ids.temperature}
            value={typeof fm.temperature === "number" ? fm.temperature : undefined}
            min={0}
            max={2}
            step={0.1}
            placeholder="Par défaut"
            onChange={(n) => setFm({ temperature: n })}
          />
        </Field>
        <Field label="Étapes maximum" htmlFor={ids.steps} hint="Optionnel : nombre d'itérations d'outils avant de rendre la main.">
          <NumberInput
            id={ids.steps}
            value={typeof fm.steps === "number" ? fm.steps : undefined}
            min={1}
            max={10_000}
            step={1}
            placeholder="Illimité"
            onChange={(n) => setFm({ steps: n })}
          />
        </Field>
        <Field label="Couleur" htmlFor={ids.color} error={colorMode === "custom" && !HEX_RE.test(color) ? "Format attendu : #rrggbb." : null}>
          <div className="color-field">
            <select
              id={ids.color}
              className="select"
              value={colorMode}
              onChange={(e) => {
                const next = e.target.value;
                setFm({ color: next === "custom" ? (HEX_RE.test(color) ? color : "#6e56cf") : next || undefined });
              }}
            >
              <option value="">Aucune</option>
              {THEME_COLORS.map((c) => (
                <option key={c} value={c}>
                  {COLOR_LABELS[c]}
                </option>
              ))}
              <option value="custom">Personnalisée</option>
            </select>
            {colorMode === "custom" ? (
              <>
                <input
                  type="color"
                  aria-label="Choisir la couleur"
                  value={HEX_RE.test(color) ? color.toLowerCase() : "#000000"}
                  onChange={(e) => setFm({ color: e.target.value })}
                />
                <input
                  className="input mono"
                  aria-label="Code hexadécimal"
                  value={color}
                  maxLength={7}
                  style={{ maxWidth: 110 }}
                  onChange={(e) => setFm({ color: e.target.value.trim() })}
                />
              </>
            ) : null}
          </div>
        </Field>
      </div>

      <div>
        <ToggleRow
          title="Masqué"
          description="N'apparaît pas dans l'autocomplétion @ (sous-agents uniquement) ; reste appelable par les autres agents."
          checked={fm.hidden === true}
          onChange={(v) => setFm({ hidden: v ? true : undefined })}
        />
        <ToggleRow
          title="Désactivé"
          description="L'agent n'est plus chargé par opencode, sans supprimer le fichier."
          checked={fm.disable === true}
          onChange={(v) => setFm({ disable: v ? true : undefined })}
        />
      </div>

      <h3 className="studio-section-title">Permissions</h3>
      <p className="small muted">
        « Hérité » reprend la règle de la configuration globale (Paramètres › opencode). Les autres choix s'appliquent uniquement à cet agent.
      </p>
      <PermissionsEditor value={fm.permission} onChange={(value) => setFm({ permission: value })} />
    </div>
  );
}
