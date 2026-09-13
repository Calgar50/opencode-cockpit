// Sélecteur de modèle avec prix, contexte et repères « cher » / « gratuit ».
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/Icon.tsx";
import { Badge } from "../../components/ui.tsx";
import { formatPricePerM, formatTokens } from "../../lib/format.ts";
import type { ModelInfo } from "../../lib/types.ts";

export function ModelPicker({
  models,
  value,
  onChange,
  disabled,
}: {
  models: ModelInfo[];
  value: string | null;
  onChange: (key: string) => void;
  disabled?: boolean;
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
    return [...map.entries()].map(([provider, list]) => [provider, list.sort((a, b) => a.name.localeCompare(b.name))] as const);
  }, [models, search]);

  return (
    <div className="picker" ref={root}>
      <button
        type="button"
        className="btn ghost sm"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        title="Choisir le modèle"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="sparkle" size={14} />
        <span className="ellipsis">{current?.name ?? value ?? "Modèle"}</span>
        {current?.price ? <span className="tiny muted">{formatPricePerM(current.price.rates.output)}</span> : null}
        <Icon name="chevronDown" size={12} />
      </button>
      {open ? (
        <div className="popover" role="listbox" aria-label="Modèles disponibles">
          <div style={{ padding: 4 }}>
            <input
              className="input sm"
              autoFocus
              placeholder="Rechercher un modèle"
              aria-label="Rechercher un modèle"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {groups.length === 0 ? <div className="popover-group">Aucun modèle</div> : null}
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
                      {model.expensive ? <Badge tone="warning">cher</Badge> : null}
                      {model.price && model.price.rates.output === 0 && model.price.rates.input === 0 ? <Badge tone="good">gratuit</Badge> : null}
                    </span>
                    <span className="prices">
                      {model.price ? `${formatPricePerM(model.price.rates.input)} → ${formatPricePerM(model.price.rates.output)}` : "prix inconnu"}
                    </span>
                    <span className="tiny muted">
                      {model.contextLimit ? `${formatTokens(model.contextLimit)} de contexte` : ""}
                      {model.reasoning ? " · raisonnement" : ""}
                      {model.attachment ? " · images" : ""}
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
