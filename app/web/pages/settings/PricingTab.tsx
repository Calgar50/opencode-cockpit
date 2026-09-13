// Grille des tarifs par modèle et tarifs personnalisés.
import { useId, useMemo, useState } from "react";
import { useApp } from "../../app/AppContext.tsx";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toast.tsx";
import { Badge, Button, Card, EmptyState, Field, IconButton, Modal, Spinner, ToggleRow, useAsync, useConfirm } from "../../components/ui.tsx";
import { api, errorText } from "../../lib/api.ts";
import { formatTokens } from "../../lib/format.ts";
import type { ModelPrice, PriceRates } from "../../lib/types.ts";
import { isHttpsUrl, NumberInput } from "../studio/widgets.tsx";
import { fmtNumber, useSettingsSave } from "./common.tsx";

type Source = "override" | "table" | "catalog" | "none";

const SOURCE_BADGE: Record<Source, { label: string; tone: "accent" | "good" | "neutral" | "warning" }> = {
  override: { label: "Personnalisé", tone: "accent" },
  table: { label: "Grille GitHub", tone: "good" },
  catalog: { label: "Catalogue opencode", tone: "neutral" },
  none: { label: "Aucun tarif", tone: "warning" },
};

interface Row {
  key: string;
  name: string;
  price: ModelPrice | null;
  base: ModelPrice | null;
  source: Source;
}

interface EditState {
  key: string;
  name: string;
  hasOverride: boolean;
  baseHasTiers: boolean;
  tiers: ModelPrice["tiers"];
  input: number | undefined;
  cachedInput: number | undefined;
  cacheWrite: number | undefined;
  cacheWriteSeparate: boolean;
  output: number | undefined;
  note: string;
}

const rate = (value: number | null | undefined) => (value === null || value === undefined ? "—" : fmtNumber(value));

function validRate(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 10_000;
}

export function PricingTab() {
  const { boot, refresh } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const pricing = useAsync(() => api.pricing(), []);
  const { save, saving } = useSettingsSave();
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<EditState | null>(null);
  const [recomputing, setRecomputing] = useState(false);
  const searchId = useId();
  const ids = { input: useId(), cached: useId(), write: useId(), output: useId(), note: useId() };

  const overrides = boot.settings.pricing.overrides;

  const rows = useMemo<Row[]>(() => {
    const p = pricing.data;
    if (!p) return [];
    const catalog = new Map(p.catalog.map((c) => [c.key, c]));
    const keys = new Set([...Object.keys(p.table).map((id) => `github-copilot/${id}`), ...p.catalog.map((c) => c.key), ...Object.keys(overrides)]);
    return [...keys]
      .map((key) => {
        const slash = key.indexOf("/");
        const provider = key.slice(0, slash);
        const id = key.slice(slash + 1);
        const table = provider === "github-copilot" ? p.table[id] : undefined;
        const cat = catalog.get(key);
        const override = overrides[key];
        const base = table ?? cat?.price ?? null;
        const source: Source = override ? "override" : table ? "table" : cat?.price ? "catalog" : "none";
        return { key, name: cat?.name ?? id, price: override ?? base, base, source };
      })
      .sort((a, b) => a.key.localeCompare(b.key));
  }, [pricing.data, overrides]);

  const needle = search.trim().toLowerCase();
  const visible = needle ? rows.filter((r) => r.key.toLowerCase().includes(needle) || r.name.toLowerCase().includes(needle)) : rows;

  const recompute = async () => {
    setRecomputing(true);
    try {
      const { updated } = await api.recompute();
      toast.info("Coûts recalculés", `${fmtNumber(updated, 0)} appel${updated > 1 ? "s" : ""} du mois en cours mis à jour.`);
      await refresh();
    } catch (err) {
      toast.error("Recalcul impossible", err);
    } finally {
      setRecomputing(false);
    }
  };

  const writeOverrides = async (next: Record<string, ModelPrice>, title: string) => {
    const saved = await save({ pricing: { overrides: next } }, title);
    if (saved) {
      await recompute();
      pricing.reload();
    }
    return saved;
  };

  const openEditor = (row: Row) => {
    const current = overrides[row.key] ?? row.price;
    const rates: Partial<PriceRates> = current?.rates ?? {};
    setEditing({
      key: row.key,
      name: row.name,
      hasOverride: Boolean(overrides[row.key]),
      baseHasTiers: Boolean(row.base?.tiers?.length),
      tiers: overrides[row.key]?.tiers,
      input: rates.input,
      cachedInput: rates.cachedInput,
      cacheWrite: rates.cacheWrite ?? undefined,
      cacheWriteSeparate: rates.cacheWrite !== null && rates.cacheWrite !== undefined,
      output: rates.output,
      note: overrides[row.key]?.note ?? "",
    });
  };

  const editErrors = editing
    ? [
        !validRate(editing.input) ? "Prix d'entrée : nombre entre 0 et 10 000." : null,
        !validRate(editing.cachedInput) ? "Prix de lecture du cache : nombre entre 0 et 10 000." : null,
        editing.cacheWriteSeparate && !validRate(editing.cacheWrite) ? "Prix d'écriture du cache : nombre entre 0 et 10 000." : null,
        !validRate(editing.output) ? "Prix de sortie : nombre entre 0 et 10 000." : null,
        editing.note.length > 200 ? "Note : 200 caractères maximum." : null,
      ].filter((e): e is string => e !== null)
    : [];

  const submitEdit = async () => {
    if (!editing || editErrors.length > 0) return;
    const price: ModelPrice = {
      rates: {
        input: editing.input as number,
        cachedInput: editing.cachedInput as number,
        cacheWrite: editing.cacheWriteSeparate ? (editing.cacheWrite as number) : null,
        output: editing.output as number,
      },
      ...(editing.tiers?.length ? { tiers: editing.tiers } : {}),
      ...(editing.note.trim() ? { note: editing.note.trim() } : {}),
    };
    if (await writeOverrides({ ...overrides, [editing.key]: price }, "Tarif personnalisé enregistré")) setEditing(null);
  };

  const removeOverride = async (key: string) => {
    const ok = await confirm({
      title: "Retirer le tarif personnalisé ?",
      message: `${key} reprendra le tarif de la grille GitHub ou du catalogue opencode.`,
      confirmLabel: "Retirer",
      danger: true,
    });
    if (!ok) return;
    const next = { ...overrides };
    delete next[key];
    if (await writeOverrides(next, "Tarif personnalisé retiré")) setEditing(null);
  };

  const togglePreferTable = async (preferTable: boolean) => {
    const saved = await save(
      { pricing: { preferTable } },
      preferTable ? "Grille des tarifs imposée" : "Coût rapporté par GitHub utilisé",
    );
    if (saved) await recompute();
  };

  const p = pricing.data;

  return (
    <div className="stack loose">
      <Card
        title="Calcul des coûts"
        subtitle={
          p ? (
            <>
              Grille GitHub du {p.asOf} · 1 crédit = {fmtNumber(p.usdPerCredit, 2)} ${" "}
              {isHttpsUrl(p.sourceUrl) ? (
                <>
                  ·{" "}
                  <a href={p.sourceUrl} target="_blank" rel="noopener noreferrer">
                    source officielle
                  </a>
                </>
              ) : null}
            </>
          ) : undefined
        }
        actions={
          <Button size="sm" icon="refresh" loading={recomputing} onClick={() => void recompute()}>
            Recalculer le mois
          </Button>
        }
      >
        <ToggleRow
          title="Toujours appliquer la grille"
          description="Par défaut, le cockpit reprend le coût réellement facturé que GitHub transmet à opencode ; la grille ne sert que d'estimation de secours. Activez pour calculer tous les coûts avec la grille (et vos tarifs personnalisés)."
          checked={boot.settings.pricing.preferTable}
          disabled={saving}
          onChange={(v) => void togglePreferTable(v)}
        />
      </Card>

      <Card
        flush
        title="Tarifs par modèle"
        subtitle="Prix en dollars par million de tokens."
        actions={
          <div className="search-input" style={{ width: 240, maxWidth: "100%" }}>
            <Icon name="search" size={14} />
            <label htmlFor={searchId} className="visually-hidden">
              Rechercher un modèle
            </label>
            <input id={searchId} className="input sm" placeholder="Rechercher un modèle" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        }
      >
        {pricing.loading && !p ? (
          <div className="empty">
            <Spinner large />
          </div>
        ) : pricing.error ? (
          <div style={{ padding: 16 }}>
            <div className="callout critical" role="alert">
              <span className="spacer">{errorText(pricing.error)}</span>
              <Button size="sm" onClick={pricing.reload}>
                Réessayer
              </Button>
            </div>
          </div>
        ) : visible.length === 0 ? (
          <EmptyState icon="search" title={rows.length === 0 ? "Aucun modèle connu" : "Aucun modèle ne correspond"} />
        ) : (
          <div className="table-wrap">
            <table className="table pricing-table">
              <thead>
                <tr>
                  <th scope="col">Modèle</th>
                  <th scope="col" className="num">
                    Entrée
                  </th>
                  <th scope="col" className="num">
                    Cache lecture
                  </th>
                  <th scope="col" className="num">
                    Cache écriture
                  </th>
                  <th scope="col" className="num">
                    Sortie
                  </th>
                  <th scope="col">Long contexte</th>
                  <th scope="col">Source</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => {
                  const r = row.price?.rates;
                  const badge = SOURCE_BADGE[row.source];
                  return (
                    <tr key={row.key} className={row.source === "override" ? "overridden" : undefined}>
                      <td>
                        <div className="model-name">{row.name}</div>
                        <div className="model-key mono">{row.key}</div>
                        {row.price?.note ? <div className="tiny muted">{row.price.note}</div> : null}
                      </td>
                      <td className="num">{rate(r?.input)}</td>
                      <td className="num">{rate(r?.cachedInput)}</td>
                      <td className="num" title={r && r.cacheWrite === null ? "Non facturée à part (comptée au prix d'entrée)" : undefined}>
                        {rate(r?.cacheWrite)}
                      </td>
                      <td className="num">
                        <strong>{rate(r?.output)}</strong>
                      </td>
                      <td>
                        {row.price?.tiers?.length ? (
                          <div className="tiers">
                            {row.price.tiers.map((t) => (
                              <div key={t.aboveInputTokens} title="Au-delà de ce contexte d'entrée : prix d'entrée / prix de sortie">
                                &gt; {formatTokens(t.aboveInputTokens)} : {rate(t.rates.input)} / {rate(t.rates.output)}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        <Badge tone={badge.tone}>{badge.label}</Badge>
                      </td>
                      <td>
                        <span className="row" style={{ gap: 2, justifyContent: "flex-end" }}>
                          <IconButton icon="edit" size="sm" label={`Personnaliser le tarif de ${row.name}`} onClick={() => openEditor(row)} />
                          {row.source === "override" ? (
                            <IconButton icon="undo" size="sm" label={`Retirer le tarif personnalisé de ${row.name}`} onClick={() => void removeOverride(row.key)} />
                          ) : null}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={editing !== null}
        title={editing ? `Tarif de ${editing.name}` : ""}
        onClose={() => setEditing(null)}
        footer={
          editing ? (
            <>
              {editing.hasOverride ? (
                <Button variant="danger" icon="undo" style={{ marginRight: "auto" }} disabled={saving} onClick={() => void removeOverride(editing.key)}>
                  Retirer
                </Button>
              ) : null}
              <Button onClick={() => setEditing(null)}>Annuler</Button>
              <Button variant="primary" icon="check" loading={saving || recomputing} disabled={editErrors.length > 0} onClick={() => void submitEdit()}>
                Enregistrer
              </Button>
            </>
          ) : null
        }
      >
        {editing ? (
          <div className="stack">
            <p className="small muted">
              <span className="mono">{editing.key}</span> · dollars par million de tokens. Le coût du mois en cours est recalculé après
              l'enregistrement.
            </p>
            <div className="rates-grid">
              <Field label="Entrée" htmlFor={ids.input}>
                <NumberInput id={ids.input} value={editing.input} min={0} max={10_000} step="any" onChange={(n) => setEditing((e) => (e ? { ...e, input: n } : e))} />
              </Field>
              <Field label="Lecture du cache" htmlFor={ids.cached}>
                <NumberInput
                  id={ids.cached}
                  value={editing.cachedInput}
                  min={0}
                  max={10_000}
                  step="any"
                  onChange={(n) => setEditing((e) => (e ? { ...e, cachedInput: n } : e))}
                />
              </Field>
              <Field label="Écriture du cache" htmlFor={ids.write} hint={editing.cacheWriteSeparate ? undefined : "Comptée au prix d'entrée."}>
                <div className="stack tight">
                  <label className="row small">
                    <input
                      type="checkbox"
                      checked={editing.cacheWriteSeparate}
                      onChange={(ev) => setEditing((e) => (e ? { ...e, cacheWriteSeparate: ev.target.checked } : e))}
                    />
                    Facturée à part
                  </label>
                  {editing.cacheWriteSeparate ? (
                    <NumberInput
                      id={ids.write}
                      value={editing.cacheWrite}
                      min={0}
                      max={10_000}
                      step="any"
                      onChange={(n) => setEditing((e) => (e ? { ...e, cacheWrite: n } : e))}
                    />
                  ) : null}
                </div>
              </Field>
              <Field label="Sortie" htmlFor={ids.output}>
                <NumberInput id={ids.output} value={editing.output} min={0} max={10_000} step="any" onChange={(n) => setEditing((e) => (e ? { ...e, output: n } : e))} />
              </Field>
            </div>
            <Field label="Note" htmlFor={ids.note} hint="Optionnelle (ex. tarif négocié).">
              <input
                id={ids.note}
                className="input"
                maxLength={200}
                value={editing.note}
                onChange={(ev) => setEditing((e) => (e ? { ...e, note: ev.target.value } : e))}
              />
            </Field>
            {editing.baseHasTiers && !editing.tiers?.length ? (
              <div className="callout warning">
                <Icon name="alert" size={18} />
                <span>Les paliers long contexte de la grille ne sont pas repris : le tarif saisi s'appliquera quelle que soit la taille du contexte.</span>
              </div>
            ) : null}
            {editErrors.length > 0 ? (
              <ul className="field-error" style={{ margin: 0, paddingLeft: 18 }}>
                {editErrors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
