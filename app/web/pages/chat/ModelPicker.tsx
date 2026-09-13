// Sélecteur « Autre IA… » (mode Avancé) : IA autorisées, coût par demande et repères « cher » / « Réservé ».
import { useEffect, useMemo, useRef, useState } from "react";
import { perRequestText, RESERVED_HELP, TIER_LABELS } from "../../../server/shared/assistant-rules.ts";
import { Icon } from "../../components/Icon.tsx";
import { Badge } from "../../components/ui.tsx";
import { formatPricePerM, formatTokens } from "../../lib/format.ts";
import type { ModelInfo } from "../../lib/types.ts";

const byCost = (a: ModelInfo, b: ModelInfo) => {
  const ca = a.taskCost?.M ?? Number.POSITIVE_INFINITY;
  const cb = b.taskCost?.M ?? Number.POSITIVE_INFINITY;
  return ca === cb ? a.name.localeCompare(b.name) : ca - cb;
};

export function ModelPicker({
  models,
  value,
  onChange,
  disabled,
  label,
  title = "Choisir une IA précise",
}: {
  models: ModelInfo[];
  value: string | null;
  onChange: (key: string) => void;
  disabled?: boolean;
  /** Texte du bouton (défaut : nom de l'IA choisie). */
  label?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = models.find((m) => m.key === value);
  const groups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const map = new Map<string, ModelInfo[]>();
    for (const model of models) {
      if (needle && !`${model.name} ${model.key}`.toLowerCase().includes(needle)) continue;
      const list = map.get(model.providerName) ?? [];
      list.push(model);
      map.set(model.providerName, list);
    }
    return [...map.entries()].map(([provider, list]) => [provider, list.toSorted(byCost)] as const);
  }, [models, search]);

  return (
    <div className="picker" ref={root}>
      <button
        type="button"
        className="btn ghost sm"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        title={title}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="sparkle" size={14} />
        <span className="ellipsis">{label ?? current?.name ?? value ?? "Autre IA…"}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      {open ? (
        <div className="popover" role="listbox" aria-label="IA disponibles">
          <div style={{ padding: 4 }}>
            <input
              className="input sm"
              autoFocus
              placeholder="Rechercher une IA"
              aria-label="Rechercher une IA"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {groups.length === 0 ? <div className="popover-group">Aucune IA</div> : null}
          {groups.map(([provider, list]) => (
            <div key={provider}>
              <div className="popover-group">{provider}</div>
              {list.map((model) => (
                <button
                  key={model.key}
                  type="button"
                  role="option"
                  className="popover-item"
                  aria-selected={model.key === value}
                  onClick={() => {
                    onChange(model.key);
                    setOpen(false);
                    setSearch("");
                  }}
                >
                  <div className="model-row">
                    <span className="row" style={{ gap: 6, minWidth: 0 }}>
                      <span className="ellipsis">{model.name}</span>
                      {model.tier ? <Badge tone="accent">{TIER_LABELS[model.tier]}</Badge> : null}
                      {model.reserved ? (
                        <Badge tone="warning" title={RESERVED_HELP}>
                          Réservé (très cher)
                        </Badge>
                      ) : model.expensive ? (
                        <Badge tone="warning">cher</Badge>
                      ) : null}
                      {model.status === "deprecated" ? <Badge tone="critical">en fin de vie</Badge> : null}
                    </span>
                    <span
                      className="prices"
                      title={model.price ? `Prix par million de jetons : ${formatPricePerM(model.price.rates.input)} → ${formatPricePerM(model.price.rates.output)}` : undefined}
                    >
                      {model.taskCost ? perRequestText(model.taskCost.M) : "prix inconnu"}
                    </span>
                    <span className="tiny muted">
                      {model.contextLimit ? `${formatTokens(model.contextLimit)} de mémoire` : ""}
                      {model.variants.length > 0 ? " · réflexion réglable" : ""}
                      {model.attachment ? " · images" : ""}
                      {model.toolcall === false ? " · ne sait pas utiliser les outils" : ""}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
