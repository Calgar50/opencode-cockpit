// Classement automatique des conversations : mode, modèle, délais et catégories.
import { type CSSProperties, useId, useMemo } from "react";
import { useApp } from "../../app/AppContext.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Button, Card, Field, IconButton, Segmented, useConfirm } from "../../components/ui.tsx";
import type { Category, Settings } from "../../lib/types.ts";
import { HEX_RE } from "../studio/shared.ts";
import { ModelSelect, NumberInput } from "../studio/widgets.tsx";
import { SectionFooter, useDraft, useReportDirty, useSettingsSave } from "./common.tsx";

type Classifier = Settings["classifier"];

interface CategoryRow extends Category {
  uid: number;
  keywordsText: string;
  isNew: boolean;
}

type ClassifierDraft = Omit<Classifier, "categories"> & { categories: CategoryRow[] };

const ID_RE = /^[a-z0-9-]{1,32}$/;
const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#4a3aa7", "#e34948", "#008300"];
let uidSeq = 1;

function parseKeywords(text: string): string[] {
  return [...new Set(text.split(",").map((k) => k.trim()).filter(Boolean))];
}

const toDraft = (s: Classifier): ClassifierDraft => ({
  ...s,
  categories: s.categories.map((c) => ({ ...c, uid: uidSeq++, keywordsText: c.keywords.join(", "), isNew: false })),
});

const toSource = (d: ClassifierDraft): Classifier => ({
  mode: d.mode,
  model: d.model,
  idleMinutes: d.idleMinutes,
  reclassifyAfterPrompts: d.reclassifyAfterPrompts,
  categories: d.categories.map((c) => ({
    id: c.id,
    label: c.label,
    emoji: c.emoji,
    color: c.color,
    description: c.description,
    keywords: parseKeywords(c.keywordsText),
  })),
});

function rowErrors(row: CategoryRow, all: CategoryRow[]): string[] {
  const errors: string[] = [];
  if (!ID_RE.test(row.id)) errors.push("Identifiant : minuscules, chiffres et tirets (32 max).");
  else if (all.filter((c) => c.id === row.id).length > 1) errors.push("Identifiant déjà utilisé.");
  if (!row.label.trim()) errors.push("Libellé obligatoire.");
  if (row.label.trim().length > 40) errors.push("Libellé : 40 caractères maximum.");
  if (row.emoji.length > 16) errors.push("Emoji : 16 caractères maximum.");
  if (!HEX_RE.test(row.color)) errors.push("Couleur invalide.");
  if (row.description.length > 300) errors.push("Description : 300 caractères maximum.");
  const keywords = parseKeywords(row.keywordsText);
  if (keywords.length > 80) errors.push("80 mots-clés maximum.");
  const bad = keywords.filter((k) => k.length < 2 || k.length > 40);
  if (bad.length > 0) errors.push(`Mots-clés de 2 à 40 caractères : ${bad.slice(0, 3).join(", ")}.`);
  return errors;
}

const MODE_HELP: Record<Classifier["mode"], string> = {
  llm: "Une IA économique lit un résumé de la conversation et choisit la catégorie, des mots-clés et un résumé (environ 0,001 $ par conversation). En cas d'échec, l'heuristique prend le relais.",
  heuristic: "Classement gratuit par mots-clés, sans appel de modèle. Moins précis, sans résumé.",
  off: "Aucun classement par modèle ni reclassement : au premier archivage, une catégorie gratuite par mots-clés est posée (« Autre » faute d'indice), puis se corrige à la main.",
};

export function ClassifierTab({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const { boot } = useApp();
  const confirm = useConfirm();
  const ids = { model: useId(), idle: useId(), prompts: useId() };
  const { draft, setDraft, dirty, reset } = useDraft<Classifier, ClassifierDraft>(boot.settings.classifier, { toDraft, toSource });
  const { save, resetSection, saving, issues } = useSettingsSave();
  useReportDirty(dirty, onDirtyChange);

  const errors = useMemo(() => new Map(draft.categories.map((row) => [row.uid, rowErrors(row, draft.categories)])), [draft.categories]);
  const invalidCount = [...errors.values()].filter((e) => e.length > 0).length;
  const hasOther = draft.categories.some((c) => c.id === "other");

  const updateRow = (uid: number, patch: Partial<CategoryRow>) =>
    setDraft((d) => ({ ...d, categories: d.categories.map((c) => (c.uid === uid ? { ...c, ...patch } : c)) }));

  const move = (index: number, delta: number) =>
    setDraft((d) => {
      const next = [...d.categories];
      const target = index + delta;
      if (target < 0 || target >= next.length) return d;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return { ...d, categories: next };
    });

  const addRow = () =>
    setDraft((d) => {
      const taken = new Set(d.categories.map((c) => c.id));
      let id = "nouvelle";
      for (let i = 2; taken.has(id); i++) id = `nouvelle-${i}`;
      const row: CategoryRow = {
        uid: uidSeq++,
        id,
        label: "Nouvelle catégorie",
        emoji: "📁",
        color: PALETTE[d.categories.length % PALETTE.length] ?? "#2a78d6",
        description: "",
        keywords: [],
        keywordsText: "",
        isNew: true,
      };
      const otherIndex = d.categories.findIndex((c) => c.id === "other");
      const next = [...d.categories];
      next.splice(otherIndex >= 0 ? otherIndex : next.length, 0, row);
      return { ...d, categories: next };
    });

  const removeRow = async (row: CategoryRow) => {
    if (!row.isNew) {
      const ok = await confirm({
        title: `Supprimer « ${row.label} » ?`,
        message: "Les conversations déjà rangées dans cette catégorie gardent son identifiant ; reclassez-les depuis les Archives si besoin. Effectif à l'enregistrement.",
        confirmLabel: "Supprimer",
        danger: true,
      });
      if (!ok) return;
    }
    setDraft((d) => ({ ...d, categories: d.categories.filter((c) => c.uid !== row.uid) }));
  };

  return (
    <Card title="Classement des conversations" subtitle="Chaque conversation terminée est rangée dans une catégorie, visible dans les Archives et les Coûts.">
      <div className="settings-form">
        <div className="stack tight">
          <span className="field-label">Mode</span>
          <div>
            <Segmented<Classifier["mode"]>
              label="Mode de classement"
              value={draft.mode}
              options={[
                { value: "llm", label: "IA" },
                { value: "heuristic", label: "Heuristique" },
                { value: "off", label: "Désactivé" },
              ]}
              onChange={(mode) => setDraft((d) => ({ ...d, mode }))}
            />
          </div>
          <span className="field-hint">{MODE_HELP[draft.mode]}</span>
        </div>

        <div className="grid-3">
          <Field
            label="IA de classement"
            htmlFor={ids.model}
            hint={draft.mode === "llm" ? "Automatique : une IA économique (GPT-5 mini en priorité)." : "Utilisée seulement en mode IA."}
          >
            <ModelSelect
              id={ids.model}
              value={draft.model}
              models={boot.models.filter((m) => (boot.allowedProviders ?? ["github-copilot"]).includes(m.providerID))}
              emptyLabel="Automatique : une IA économique (GPT-5 mini en priorité)"
              disabled={draft.mode !== "llm"}
              onChange={(model) => setDraft((d) => ({ ...d, model }))}
            />
          </Field>
          <Field label="Délai d'inactivité" htmlFor={ids.idle} hint="Minutes sans activité avant de classer la conversation.">
            <div className="input-suffix">
              <NumberInput
                id={ids.idle}
                value={draft.idleMinutes}
                min={0}
                max={1440}
                step={1}
                disabled={draft.mode === "off"}
                onChange={(n) => n !== undefined && setDraft((d) => ({ ...d, idleMinutes: n }))}
              />
              <span className="small muted">min</span>
            </div>
          </Field>
          <Field label="Reclasser après" htmlFor={ids.prompts} hint="Nouveaux messages avant de relancer le classement.">
            <div className="input-suffix">
              <NumberInput
                id={ids.prompts}
                value={draft.reclassifyAfterPrompts}
                min={1}
                max={100}
                step={1}
                disabled={draft.mode === "off"}
                onChange={(n) => n !== undefined && setDraft((d) => ({ ...d, reclassifyAfterPrompts: Math.round(n) }))}
              />
              <span className="small muted">messages</span>
            </div>
          </Field>
        </div>

        <h3 className="settings-subtitle">Catégories ({draft.categories.length}/30)</h3>
        <p className="small muted">
          La description guide le modèle ; les mots-clés (séparés par des virgules) servent au classement heuristique. L'identifiant d'une catégorie
          existante est figé car les conversations y font référence. La catégorie « other » est obligatoire.
        </p>
        {!hasOther ? (
          <div className="callout critical">La catégorie « other » est obligatoire.</div>
        ) : null}

        <div className="cat-list">
          {draft.categories.map((row, index) => {
            const rowErr = errors.get(row.uid) ?? [];
            const isOther = row.id === "other" && !row.isNew;
            return (
              <div key={row.uid} className="cat-row" style={{ "--cat-color": HEX_RE.test(row.color) ? row.color : undefined } as CSSProperties}>
                <div className="field cat-emoji">
                  <label htmlFor={`cat-emoji-${row.uid}`}>Emoji</label>
                  <input id={`cat-emoji-${row.uid}`} className="input" value={row.emoji} maxLength={16} onChange={(e) => updateRow(row.uid, { emoji: e.target.value })} />
                </div>
                <div className="field cat-label">
                  <label htmlFor={`cat-label-${row.uid}`}>Libellé</label>
                  <input id={`cat-label-${row.uid}`} className="input" value={row.label} maxLength={40} onChange={(e) => updateRow(row.uid, { label: e.target.value })} />
                </div>
                <div className="field cat-id">
                  <label htmlFor={`cat-id-${row.uid}`}>Identifiant</label>
                  <input
                    id={`cat-id-${row.uid}`}
                    className="input mono"
                    value={row.id}
                    maxLength={32}
                    readOnly={!row.isNew}
                    title={row.isNew ? undefined : "Identifiant figé : utilisé par les conversations déjà classées."}
                    onChange={(e) => updateRow(row.uid, { id: e.target.value.toLowerCase() })}
                  />
                </div>
                <div className="field cat-color">
                  <label htmlFor={`cat-color-${row.uid}`}>Couleur</label>
                  <input
                    id={`cat-color-${row.uid}`}
                    type="color"
                    className="color-input"
                    value={HEX_RE.test(row.color) ? row.color.toLowerCase() : "#000000"}
                    onChange={(e) => updateRow(row.uid, { color: e.target.value })}
                  />
                </div>
                <div className="cat-actions">
                  <IconButton icon="chevronDown" className="flip-up" size="sm" label={`Monter ${row.label}`} disabled={index === 0} onClick={() => move(index, -1)} />
                  <IconButton icon="chevronDown" size="sm" label={`Descendre ${row.label}`} disabled={index === draft.categories.length - 1} onClick={() => move(index, 1)} />
                  <IconButton
                    icon="trash"
                    size="sm"
                    label={isOther ? "La catégorie « other » ne peut pas être supprimée" : `Supprimer ${row.label}`}
                    disabled={isOther}
                    onClick={() => void removeRow(row)}
                  />
                </div>
                <div className="field cat-desc">
                  <label htmlFor={`cat-desc-${row.uid}`}>Description</label>
                  <input
                    id={`cat-desc-${row.uid}`}
                    className="input"
                    value={row.description}
                    maxLength={300}
                    onChange={(e) => updateRow(row.uid, { description: e.target.value })}
                  />
                </div>
                <div className="field cat-keywords">
                  <label htmlFor={`cat-kw-${row.uid}`}>Mots-clés</label>
                  <input
                    id={`cat-kw-${row.uid}`}
                    className="input"
                    value={row.keywordsText}
                    placeholder="bug, erreur, crash"
                    onChange={(e) => updateRow(row.uid, { keywordsText: e.target.value })}
                  />
                </div>
                {rowErr.length > 0 ? (
                  <span className="field-error" style={{ gridColumn: "1 / -1" }} role="alert">
                    {rowErr.join(" ")}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
        <div>
          <Button icon="plus" onClick={addRow} disabled={draft.categories.length >= 30}>
            Ajouter une catégorie
          </Button>
        </div>

        {invalidCount > 0 ? (
          <div className="callout warning">
            <Icon name="alert" size={18} />
            <span>
              {invalidCount} catégorie{invalidCount > 1 ? "s" : ""} à corriger avant d'enregistrer.
            </span>
          </div>
        ) : null}

        <SectionFooter
          dirty={dirty}
          saving={saving}
          issues={issues}
          disabled={invalidCount > 0 || !hasOther}
          onCancel={reset}
          onSave={() => void save({ classifier: toSource(draft) }, "Classement enregistré")}
          onReset={async () => {
            await resetSection("classifier", "Classement réinitialisé");
          }}
        />
      </div>
    </Card>
  );
}
