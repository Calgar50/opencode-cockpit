// Paramètres › Niveaux d'IA (§9.6) : IA résolue de chaque niveau, niveau par défaut, « Qui utilise quel niveau ? »,
// mises à jour groupées et, en mode Avancé, éditeur des listes de candidats.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  DEFAULT_TIERS,
  MESSAGES,
  modelName,
  perRequestText,
  RESERVED_HELP,
  resolveTier,
  TIER_IDS,
  TIER_LABELS,
  TIER_STATUS_LABELS,
  toCatalogLite,
  variantOptionLabel,
} from "../../../server/shared/assistant-rules.ts";
import { useApp } from "../../app/AppContext.tsx";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toast.tsx";
import { Badge, Button, Card, Field, Spinner, type Tone, useAsync, useConfirm } from "../../components/ui.tsx";
import { ApiError, api, errorText } from "../../lib/api.ts";
import { cockpitEvent, useEvents } from "../../lib/events.ts";
import { navigate, openAssistants } from "../../lib/router.ts";
import type { AiView, Tier, TierDef, TierDefs, TierView, UpdateItem, UsageRow, UsageRowState, ValidationIssue } from "../../lib/types.ts";
import { useRealign } from "../assistants/realign.tsx";
import { TIER_STATUS_TONE } from "../assistants/TierCards.tsx";
import { SectionFooter, useDraft, useReportDirty } from "./common.tsx";

const STATE_TONE: Readonly<Record<UsageRowState, Tone>> = {
  "a-jour": "good",
  "mise-a-jour": "accent",
  "modifie-hors-cockpit": "warning",
  "a-ranger": "warning",
  introuvable: "critical",
  aucun: "neutral",
};

function defsOf(tiers: readonly TierView[]): TierDefs {
  const pick = (id: Tier): TierDef => {
    const view = tiers.find((t) => t.id === id);
    return view ? { candidates: [...view.candidates], variant: view.configuredVariant } : { candidates: [...DEFAULT_TIERS[id].candidates], variant: DEFAULT_TIERS[id].variant };
  };
  return { rapide: pick("rapide"), equilibre: pick("equilibre"), expert: pick("expert") };
}

function countText(n: number, one: string, many: string): string {
  return `${n} ${n > 1 ? many : one}`;
}

export function TiersTab({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const { boot, advanced, applySettings, refresh } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const defaultTierId = useId();
  const ai = useAsync(() => api.ai(), []);
  const reloadRef = useRef(ai.reload);
  reloadRef.current = ai.reload;
  const timer = useRef<number | undefined>(undefined);
  const realign = useRealign(() => reloadRef.current());
  const [savingField, setSavingField] = useState<"tier" | "override" | "reset" | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  useReportDirty(editorDirty, onDirtyChange);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEvents((event) => {
    if (cockpitEvent(event, "ai.changed", "studio.changed", "opencode.config.changed", "settings.updated")) {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => reloadRef.current(), 400);
    }
  });

  const saveAi = async (field: "tier" | "override", patch: { chatDefaultTier?: Tier; allowModelOverride?: boolean }, title: string) => {
    setSavingField(field);
    try {
      const saved = await api.saveSettings({ ai: patch });
      applySettings(saved);
      ai.setData((v) => (v ? { ...v, chatDefaultTier: saved.ai.chatDefaultTier, allowModelOverride: saved.ai.allowModelOverride } : v));
      toast.success(title);
    } catch (err) {
      toast.error("Enregistrement impossible", err);
    } finally {
      setSavingField(null);
    }
  };

  const resetToRecommendation = async () => {
    const ok = await confirm({
      title: "Revenir à la recommandation ?",
      message:
        "Les niveaux reprendront les IA recommandées par le cockpit. Aucun fichier n'est modifié : les éléments concernés apparaîtront dans « Mise à jour disponible ».",
      confirmLabel: "Revenir à la recommandation",
    });
    if (!ok) return;
    setSavingField("reset");
    try {
      const res = await api.putTiers(null);
      ai.setData(res.ai);
      toast.success(
        "Recommandation rétablie",
        res.impacted.length > 0 ? `${countText(res.impacted.length, "élément peut", "éléments peuvent")} passer à la nouvelle IA.` : undefined,
      );
      void refresh();
    } catch (err) {
      toast.error("Changement impossible", err);
    } finally {
      setSavingField(null);
    }
  };

  const withRow = async (key: string, action: () => Promise<void>) => {
    setRowBusy(key);
    try {
      await action();
    } finally {
      setRowBusy(null);
    }
  };

  const realignRow = async (row: UsageRow, update: UpdateItem | undefined) => {
    if (row.kind === "builtin") return;
    if (update) {
      await realign.run([update]);
      return;
    }
    const ok = await confirm({
      title: `Réaligner « ${row.label} » ?`,
      message: `Son fichier reprendra l'IA et la réflexion du niveau ${row.tier ? TIER_LABELS[row.tier] : "choisi"}.`,
      confirmLabel: "Réaligner",
    });
    if (ok) await realign.apply([{ kind: row.kind, name: row.name }]);
  };

  const keepPrecise = async (row: UsageRow) => {
    const kind = row.kind;
    if (kind === "builtin") return;
    await withRow(`${kind}/${row.name}`, async () => {
      try {
        await api.keepModel(kind, row.name);
        toast.success("IA précise conservée", `« ${row.label} » ne suit plus les niveaux.`);
        reloadRef.current();
      } catch (err) {
        toast.error("Enregistrement impossible", err);
      }
    });
  };

  const removeRow = async (row: UsageRow) => {
    const kind = row.kind;
    if (kind === "builtin") return;
    await withRow(`${kind}/${row.name}`, async () => {
      try {
        await api.deleteAssistantMeta(row.name, kind);
        toast.success("Retiré de la liste", `« ${row.label} » n'apparaît plus.`);
        reloadRef.current();
      } catch (err) {
        toast.error("Retrait impossible", err);
      }
    });
  };

  const chooseLevel = (row: UsageRow) => {
    if (advanced && row.kind !== "builtin") navigate("studio", row.kind, row.name);
    else openAssistants();
  };

  if (ai.loading && !ai.data) {
    return (
      <Card>
        <Spinner />
      </Card>
    );
  }
  if (!ai.data) {
    return (
      <div className="callout critical" role="alert">
        <Icon name="alert" size={18} />
        <span className="spacer">{ai.error ? errorText(ai.error) : "Niveaux d'IA indisponibles."}</span>
        <Button size="sm" icon="refresh" onClick={ai.reload}>
          Réessayer
        </Button>
      </div>
    );
  }

  const view = ai.data;

  return (
    <div className="stack loose">
      <Card
        title="Niveaux d'IA"
        subtitle="Chaque assistant utilise un niveau. Le cockpit choisit l'IA correspondante sur votre compte Copilot."
        actions={
          advanced && view.source === "personnalise" ? (
            <Button size="sm" variant="ghost" icon="undo" loading={savingField === "reset"} onClick={() => void resetToRecommendation()}>
              Revenir à la recommandation
            </Button>
          ) : null
        }
      >
        <div className="settings-form">
          <p className="small secondary">Source : {view.sourceText}</p>
          <div className="tier-table">
            {view.tiers.map((tier) => (
              <div key={tier.id} className="tier-row">
                <div className="tier-row-level">
                  <strong>{TIER_LABELS[tier.id]}</strong>
                  <span className="small muted">{tier.help}</span>
                </div>
                <div className="tier-row-model">
                  {tier.modelName ?? tier.plannedName ?? "—"}
                  {tier.variant ? <span className="small muted"> · {tier.variantLabel}</span> : null}
                </div>
                <div className="tier-row-status">
                  <Badge tone={TIER_STATUS_TONE[tier.status]} title={tier.statusHelp ?? undefined}>
                    {tier.statusLabel}
                  </Badge>
                </div>
                <div className="tier-row-cost small tabular">{tier.estimateText ?? "—"}</div>
                {tier.fallbackText || (tier.status !== "ok" && tier.statusHelp) ? (
                  <div className="tier-row-note small">{tier.fallbackText ?? tier.statusHelp}</div>
                ) : null}
                {advanced && tier.warnings.length > 0 ? (
                  <ul className="tier-row-warnings tiny muted">
                    {tier.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
          </div>

          <Field label="Niveau de l'Assistant général et des nouvelles conversations" htmlFor={defaultTierId}>
            <select
              id={defaultTierId}
              className="select"
              style={{ maxWidth: 360 }}
              value={view.chatDefaultTier}
              disabled={savingField === "tier"}
              onChange={(e) => void saveAi("tier", { chatDefaultTier: e.target.value as Tier }, "Niveau par défaut enregistré")}
            >
              {TIER_IDS.map((id) => {
                const tier = view.tiers.find((t) => t.id === id);
                return (
                  <option key={id} value={id}>
                    {TIER_LABELS[id]}
                    {tier?.modelName ? ` · ${tier.modelName}` : ""}
                  </option>
                );
              })}
            </select>
          </Field>

          {advanced ? (
            <label className="check-row">
              <input
                type="checkbox"
                checked={view.allowModelOverride}
                disabled={savingField === "override"}
                onChange={(e) =>
                  void saveAi(
                    "override",
                    { allowModelOverride: e.target.checked },
                    e.target.checked ? "Changement d'IA pour un message autorisé" : "Changement d'IA pour un message désactivé",
                  )
                }
              />
              <span className="stack tight" style={{ gap: 2 }}>
                <span>Autoriser à changer l'IA d'un assistant pour un message (mode Avancé, déconseillé)</span>
                <span className="small muted">L'IA choisie remplace celle de l'assistant pour ce seul message ; la réflexion de l'assistant ne s'applique plus.</span>
              </span>
            </label>
          ) : null}
        </div>
      </Card>

      {TIER_IDS.map((id) => {
        const items = view.updates.filter((u) => u.tier === id);
        if (items.length === 0) return null;
        return (
          <div key={id} className="callout warning" style={{ alignItems: "center" }}>
            <Icon name="alert" size={18} />
            <span className="spacer">
              {countText(items.length, "élément peut", "éléments peuvent")} passer à la nouvelle IA du niveau {TIER_LABELS[id]}.
            </span>
            <Button size="sm" variant="primary" icon="refresh" disabled={realign.busy} onClick={() => void realign.run(items)}>
              Mettre à jour
            </Button>
          </div>
        );
      })}

      <Card title="Qui utilise quel niveau ?" flush>
        {view.usage.length === 0 ? (
          <p className="small muted" style={{ padding: "0 16px 16px" }}>
            Aucun élément pour l'instant.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Élément</th>
                  <th>Type</th>
                  <th>Niveau / IA</th>
                  <th>État</th>
                  <th>
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.usage.map((row) => {
                  const key = `${row.kind}/${row.name}`;
                  const update = row.kind === "builtin" ? undefined : view.updates.find((u) => u.kind === row.kind && u.name === row.name);
                  const busy = rowBusy === key || realign.busy;
                  return (
                    <tr key={key}>
                      <td>{row.label}</td>
                      <td className="small secondary">{row.typeLabel}</td>
                      <td>{row.levelText}</td>
                      <td>{row.state === "aucun" ? <span className="muted">—</span> : <Badge tone={STATE_TONE[row.state]}>{row.stateText}</Badge>}</td>
                      <td>
                        <div className="state-actions">
                          {row.state === "mise-a-jour" && update ? (
                            <Button size="sm" disabled={busy} onClick={() => void realign.run([update])}>
                              Mettre à jour
                            </Button>
                          ) : null}
                          {row.state === "modifie-hors-cockpit" ? (
                            <>
                              {/* Sans niveau (IA précise), il n'y a rien à réaligner : seule « Garder cette IA précise » s'applique. */}
                              {row.tier !== null || update ? (
                                <Button size="sm" disabled={busy} onClick={() => void realignRow(row, update)}>
                                  Réaligner
                                </Button>
                              ) : null}
                              <Button size="sm" variant="ghost" disabled={busy} loading={rowBusy === key} onClick={() => void keepPrecise(row)}>
                                Garder cette IA précise
                              </Button>
                            </>
                          ) : null}
                          {row.state === "a-ranger" && (advanced || row.completable) ? (
                            <Button size="sm" onClick={() => chooseLevel(row)}>
                              Choisir un niveau
                            </Button>
                          ) : null}
                          {row.state === "a-ranger" && !advanced && !row.completable ? (
                            <span className="small muted">Réglable en mode Avancé (Paramètres › Affichage)</span>
                          ) : null}
                          {row.state === "introuvable" ? (
                            <Button size="sm" variant="ghost" loading={rowBusy === key} onClick={() => void removeRow(row)}>
                              Retirer de la liste
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {advanced ? (
        <TierEditor
          view={view}
          onDirtyChange={setEditorDirty}
          onSaved={(next) => {
            ai.setData(next);
            void refresh();
          }}
        />
      ) : null}
    </div>
  );
}

/** Éditeur des candidats de chaque niveau (mode Avancé). N'écrit aucun fichier : seules les définitions changent. */
function TierEditor({ view, onSaved, onDirtyChange }: { view: AiView; onSaved: (ai: AiView) => void; onDirtyChange: (dirty: boolean) => void }) {
  const { boot } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const source = useMemo(() => defsOf(view.tiers), [view.tiers]);
  const { draft, setDraft, dirty, reset } = useDraft<TierDefs>(source);
  const [saving, setSaving] = useState(false);
  const [issues, setIssues] = useState<ValidationIssue[] | null>(null);
  const catalog = useMemo(() => toCatalogLite(boot.models), [boot.models]);
  const allowed = boot.allowedProviders ?? ["github-copilot"];
  const catalogueReady = boot.models.length > 0;

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const impactedBy = (id: Tier, def: TierDef) => {
    const model = resolveTier(def, catalog, allowed).model;
    return view.usage.filter((row) => row.kind !== "builtin" && row.tier === id && row.model !== null && model !== null && row.model !== model);
  };

  const save = async () => {
    const changed = TIER_IDS.filter((id) => JSON.stringify(draft[id]) !== JSON.stringify(source[id]));
    if (changed.length === 0) return;
    const unavailable = changed.some((id) => resolveTier(draft[id], catalog, allowed).status === "indisponible");
    const first = changed[0] as Tier;
    const ok = await confirm({
      title: changed.length === 1 ? `Changer l'IA du niveau « ${TIER_LABELS[first]} » ?` : `Changer l'IA de ${changed.length} niveaux ?`,
      message: (
        <div className="stack tight">
          {changed.map((id) => {
            const before = view.tiers.find((t) => t.id === id);
            const res = resolveTier(draft[id], catalog, allowed);
            const cost = res.model ? boot.models.find((m) => m.key === res.model)?.taskCost?.M : undefined;
            const impacted = impactedBy(id, draft[id]);
            return (
              <p key={id} className="secondary">
                {TIER_LABELS[id]} : {before?.modelName ?? "aucune IA"} → {res.model ? modelName(res.model, catalog) : "aucune IA disponible sur ce poste"}
                {cost !== undefined ? ` (${perRequestText(cost)})` : ""}.
                {impacted.length > 0 ? ` ${countText(impacted.length, "élément passera", "éléments passeront")} en « Mise à jour disponible ».` : ""}
              </p>
            );
          })}
          <p className="small muted">Aucun fichier n'est modifié maintenant : vous choisirez quand mettre à jour les éléments concernés.</p>
          {unavailable ? <p className="field-error">Aucune IA de ces candidats n'est disponible sur ce poste.</p> : null}
        </div>
      ),
      confirmLabel: "Enregistrer les niveaux",
      danger: unavailable,
    });
    if (!ok) return;
    setSaving(true);
    setIssues(null);
    try {
      const res = await api.putTiers(draft);
      onSaved(res.ai);
      toast.success(
        "Niveaux enregistrés",
        res.impacted.length > 0 ? `${countText(res.impacted.length, "élément peut", "éléments peuvent")} passer à la nouvelle IA.` : undefined,
      );
    } catch (err) {
      if (err instanceof ApiError && err.code === "validation") setIssues(err.issues.length > 0 ? err.issues : [{ path: "", message: err.message }]);
      else toast.error("Enregistrement impossible", err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Modifier les niveaux (mode Avancé)" subtitle="L'ordre compte : la première IA disponible sur le compte de chaque collègue est utilisée.">
      <div className="settings-form">
        {!catalogueReady ? (
          <div className="callout warning">
            <Icon name="alert" size={18} />
            <span>{MESSAGES.catalogueIndisponible}</span>
          </div>
        ) : null}
        {TIER_IDS.map((id) => (
          <TierDefEditor
            key={id}
            id={id}
            def={draft[id]}
            changed={JSON.stringify(draft[id]) !== JSON.stringify(source[id])}
            disabled={!catalogueReady || saving}
            impacted={impactedBy(id, draft[id])}
            onChange={(def) => setDraft((d) => ({ ...d, [id]: def }))}
          />
        ))}
        <SectionFooter
          dirty={dirty}
          saving={saving}
          issues={issues}
          disabled={!catalogueReady}
          saveLabel="Enregistrer les niveaux"
          onCancel={() => {
            reset();
            setIssues(null);
          }}
          onSave={() => void save()}
        />
      </div>
    </Card>
  );
}

function TierDefEditor({
  id,
  def,
  changed,
  disabled,
  impacted,
  onChange,
}: {
  id: Tier;
  def: TierDef;
  changed: boolean;
  disabled: boolean;
  impacted: UsageRow[];
  onChange: (def: TierDef) => void;
}) {
  const { boot, modelByKey } = useApp();
  const addId = useId();
  const variantId = useId();
  const catalog = useMemo(() => toCatalogLite(boot.models), [boot.models]);
  const allowed = boot.allowedProviders ?? ["github-copilot"];
  const resolution = resolveTier(def, catalog, allowed);

  const available = boot.models
    .filter((m) => allowed.includes(m.providerID) && m.toolcall !== false && m.status !== "deprecated" && !def.candidates.includes(m.key))
    .sort((a, b) => (a.taskCost?.M ?? Number.POSITIVE_INFINITY) - (b.taskCost?.M ?? Number.POSITIVE_INFINITY) || a.name.localeCompare(b.name));
  const variants = [...new Set(def.candidates.flatMap((key) => modelByKey(key)?.variants ?? []))];
  if (def.variant && !variants.includes(def.variant)) variants.push(def.variant);
  const hasReserved = def.candidates.some((key) => modelByKey(key)?.reserved);

  const setCandidates = (candidates: string[]) => onChange({ ...def, candidates });
  const move = (index: number, delta: number) => {
    const next = [...def.candidates];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target] as string, next[index] as string];
    setCandidates(next);
  };

  return (
    <div className="tier-editor">
      <div className="row between wrap">
        <strong>{TIER_LABELS[id]}</strong>
        <span className="row small wrap" style={{ gap: 6 }}>
          IA retenue sur ce poste : {resolution.model ? modelName(resolution.model, catalog) : "aucune"}
          <Badge tone={TIER_STATUS_TONE[resolution.status]}>{TIER_STATUS_LABELS[resolution.status]}</Badge>
        </span>
      </div>
      <ol className="tier-candidates">
        {def.candidates.map((key, index) => {
          const model = modelByKey(key);
          return (
            <li key={key} className="tier-candidate">
              <span className="tier-candidate-rank">{index + 1}</span>
              <span className="spacer" style={{ minWidth: 0 }}>
                {model?.name ?? key}{" "}
                {!model ? <Badge tone="warning">absente de ce compte</Badge> : null}
                {model?.reserved ? (
                  <Badge tone="critical" title={RESERVED_HELP}>
                    Réservé (très cher)
                  </Badge>
                ) : null}
              </span>
              <span className="small muted tabular">{model?.taskCost ? perRequestText(model.taskCost.M) : ""}</span>
              <span className="row" style={{ gap: 2 }}>
                <Button size="sm" variant="ghost" aria-label={`Monter ${model?.name ?? key}`} title="Monter" disabled={disabled || index === 0} onClick={() => move(index, -1)}>
                  ↑
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Descendre ${model?.name ?? key}`}
                  title="Descendre"
                  disabled={disabled || index === def.candidates.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon="x"
                  aria-label={`Retirer ${model?.name ?? key}`}
                  title="Retirer"
                  disabled={disabled || def.candidates.length <= 1}
                  onClick={() => setCandidates(def.candidates.filter((c) => c !== key))}
                />
              </span>
            </li>
          );
        })}
      </ol>
      <div className="grid-2">
        <Field label="Ajouter une IA de secours" htmlFor={addId} hint={hasReserved ? RESERVED_HELP : "4 IA au plus, de la préférée à la dernière solution."}>
          <select
            id={addId}
            className="select"
            value=""
            disabled={disabled || def.candidates.length >= 4}
            onChange={(e) => e.target.value && setCandidates([...def.candidates, e.target.value])}
          >
            <option value="">Choisir une IA…</option>
            <optgroup label="IA GitHub Copilot">
              {available
                .filter((m) => !m.reserved)
                .map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.name}
                    {m.taskCost ? ` · ${perRequestText(m.taskCost.M)}` : ""}
                  </option>
                ))}
            </optgroup>
            {available.some((m) => m.reserved) ? (
              <optgroup label="Réservé (très cher)">
                {available
                  .filter((m) => m.reserved)
                  .map((m) => (
                    <option key={m.key} value={m.key}>
                      {m.name}
                      {m.taskCost ? ` · ${perRequestText(m.taskCost.M)}` : ""}
                    </option>
                  ))}
              </optgroup>
            ) : null}
          </select>
        </Field>
        <Field label="Réflexion" htmlFor={variantId} hint="Retirée automatiquement si l'IA retenue ne la propose pas.">
          <select id={variantId} className="select" value={def.variant ?? ""} disabled={disabled} onChange={(e) => onChange({ ...def, variant: e.target.value || null })}>
            <option value="">{variantOptionLabel(null, true)}</option>
            {variants.map((v) => (
              <option key={v} value={v}>
                {variantOptionLabel(v, true)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {resolution.warnings.length > 0 ? (
        <ul className="tier-row-warnings tiny muted">
          {resolution.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
      {changed && impacted.length > 0 ? (
        <p className="small tier-note-warning">
          {countText(impacted.length, "élément passera", "éléments passeront")} en « Mise à jour disponible » : {impacted.map((r) => r.label).join(", ")}.
        </p>
      ) : null}
    </div>
  );
}
