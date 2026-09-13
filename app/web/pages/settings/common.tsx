// Outils partagés des onglets de paramètres : brouillon local, enregistrement, pied de section.
import { useCallback, useEffect, useState } from "react";
import { useApp } from "../../app/AppContext.tsx";
import { useToast } from "../../components/Toast.tsx";
import { Button, useConfirm } from "../../components/ui.tsx";
import { ApiError, api } from "../../lib/api.ts";
import type { Settings, ValidationIssue } from "../../lib/types.ts";
import { DirtyBadge, IssuesCallout } from "../studio/widgets.tsx";

export interface DraftState<D> {
  draft: D;
  setDraft: (value: D | ((previous: D) => D)) => void;
  dirty: boolean;
  /** Rétablit la valeur source (abandon des modifications). */
  reset: () => void;
}

/**
 * Brouillon d'une section : suit la source tant qu'il n'est pas modifié,
 * pour refléter les changements venus d'un autre onglet.
 */
export function useDraft<S, D = S>(source: S, map?: { toDraft: (s: S) => D; toSource: (d: D) => S }): DraftState<D> {
  const toDraft = map?.toDraft ?? ((s: S) => JSON.parse(JSON.stringify(s)) as D);
  const toSource = map?.toSource ?? ((d: D) => d as unknown as S);
  const sourceJson = JSON.stringify(source);
  const [baseline, setBaseline] = useState(sourceJson);
  const [draft, setDraft] = useState<D>(() => toDraft(source));
  const dirty = JSON.stringify(toSource(draft)) !== baseline;

  useEffect(() => {
    if (sourceJson === baseline) return;
    if (!dirty || JSON.stringify(toSource(draft)) === sourceJson) {
      setDraft(toDraft(JSON.parse(sourceJson) as S));
      setBaseline(sourceJson);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceJson]);

  const reset = () => {
    setDraft(toDraft(JSON.parse(sourceJson) as S));
    setBaseline(sourceJson);
  };

  return { draft, setDraft, dirty, reset };
}

/** Enregistre un correctif de paramètres et met à jour l'état global. */
export function useSettingsSave() {
  const { patchBoot, refresh } = useApp();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [issues, setIssues] = useState<ValidationIssue[] | null>(null);

  const apply = useCallback(
    (settings: Settings, refreshBoot: boolean) => {
      patchBoot((b) => ({ ...b, settings }));
      if (refreshBoot) void refresh().catch(() => undefined);
    },
    [patchBoot, refresh],
  );

  const save = async (patch: unknown, title: string, options: { message?: string; refreshBoot?: boolean } = {}): Promise<Settings | null> => {
    setSaving(true);
    setIssues(null);
    try {
      const saved = await api.saveSettings(patch);
      apply(saved, options.refreshBoot ?? false);
      toast.success(title, options.message);
      return saved;
    } catch (err) {
      if (err instanceof ApiError && err.code === "validation") setIssues(err.issues.length > 0 ? err.issues : [{ path: "", message: err.message }]);
      else toast.error("Enregistrement impossible", err);
      return null;
    } finally {
      setSaving(false);
    }
  };

  const resetSection = async (section: keyof Settings, title: string, refreshBoot = false): Promise<Settings | null> => {
    setSaving(true);
    setIssues(null);
    try {
      const saved = await api.resetSettings(section);
      apply(saved, refreshBoot);
      toast.success(title);
      return saved;
    } catch (err) {
      toast.error("Réinitialisation impossible", err);
      return null;
    } finally {
      setSaving(false);
    }
  };

  return { save, resetSection, saving, issues, setIssues };
}

/** Rapporte l'état « modifié » d'un onglet à la page (garde avant changement d'onglet). */
export function useReportDirty(dirty: boolean, onDirtyChange: (dirty: boolean) => void) {
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
}

export function SectionFooter({
  dirty,
  saving,
  issues,
  onSave,
  onCancel,
  onReset,
  resetLabel = "Valeurs par défaut",
  saveLabel = "Enregistrer",
  disabled,
}: {
  dirty: boolean;
  saving: boolean;
  issues: ValidationIssue[] | null;
  onSave: () => void;
  onCancel: () => void;
  onReset?: () => Promise<void> | void;
  resetLabel?: string;
  saveLabel?: string;
  disabled?: boolean;
}) {
  const confirm = useConfirm();
  return (
    <div className="stack tight">
      {issues && issues.length > 0 ? <IssuesCallout title="Paramètres refusés" issues={issues} /> : null}
      <div className="settings-footer">
        {onReset ? (
          <Button
            variant="ghost"
            icon="undo"
            disabled={saving}
            onClick={async () => {
              const ok = await confirm({
                title: "Revenir aux valeurs par défaut ?",
                message: "Tous les réglages de cette section seront remplacés par les valeurs d'origine.",
                confirmLabel: "Réinitialiser",
                danger: true,
              });
              if (ok) await onReset();
            }}
          >
            {resetLabel}
          </Button>
        ) : null}
        <span className="spacer" />
        <DirtyBadge dirty={dirty} />
        <Button disabled={!dirty || saving} onClick={onCancel}>
          Annuler
        </Button>
        <Button variant="primary" icon="check" loading={saving} disabled={!dirty || disabled} onClick={onSave}>
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}

export const fmtNumber = (value: number, digits = 3) => new Intl.NumberFormat("fr-FR", { maximumFractionDigits: digits }).format(value);
