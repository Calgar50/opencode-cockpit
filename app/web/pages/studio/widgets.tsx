// Petits composants de formulaire partagés par le Studio et les Paramètres.
import { type KeyboardEvent, type ReactNode, useEffect, useId, useState } from "react";
import { perRequestText } from "../../../server/shared/assistant-rules.ts";
import { Icon } from "../../components/Icon.tsx";
import type { ModelInfo, ValidationIssue } from "../../lib/types.ts";
import { groupModels } from "./shared.ts";

/**
 * Liste déroulante des modèles, groupés par fournisseur ; conserve une valeur inconnue du catalogue.
 * `showCost` : coût estimé d'une demande (taille M), tri du moins cher au plus cher, mention « réservé (très cher) ».
 */
export function ModelSelect({
  id,
  value,
  onChange,
  models,
  emptyLabel = "Modèle par défaut",
  disabled,
  ariaLabel,
  showCost = false,
}: {
  id?: string;
  value: string | null;
  onChange: (value: string | null) => void;
  models: ModelInfo[];
  emptyLabel?: string;
  disabled?: boolean;
  ariaLabel?: string;
  showCost?: boolean;
}) {
  const groups = groupModels(models);
  if (showCost) {
    for (const g of groups) {
      g.models.sort((a, b) => (a.taskCost?.M ?? Number.POSITIVE_INFINITY) - (b.taskCost?.M ?? Number.POSITIVE_INFINITY) || a.name.localeCompare(b.name));
    }
  }
  const known = value ? models.some((m) => m.key === value) : true;
  return (
    <select
      id={id}
      className="select"
      value={value ?? ""}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">{emptyLabel}</option>
      {!known && value ? <option value={value}>{value} (absent du catalogue)</option> : null}
      {groups.map((g) => (
        <optgroup key={g.providerID} label={g.label}>
          {g.models.map((m) => (
            <option key={m.key} value={m.key}>
              {m.name}
              {showCost && m.taskCost ? ` · ${perRequestText(m.taskCost.M)}` : ""}
              {showCost && m.reserved ? " · réservé (très cher)" : m.expensive ? " · cher" : ""}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/** Champ numérique tolérant la saisie en cours ; `undefined` quand le champ est vide. */
export function NumberInput({
  id,
  value,
  onChange,
  min,
  max,
  step,
  placeholder,
  disabled,
  ariaLabel,
  className = "input",
}: {
  id?: string;
  value: number | undefined | null;
  onChange: (value: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number | "any";
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  const [text, setText] = useState(value === undefined || value === null ? "" : String(value));
  useEffect(() => {
    const current = text.trim() === "" ? undefined : Number(text.replace(",", "."));
    if (current !== (value ?? undefined)) setText(value === undefined || value === null ? "" : String(value));
    // Synchronisation uniquement quand la valeur change de l'extérieur.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      id={id}
      className={className}
      type="number"
      inputMode="decimal"
      value={text}
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        if (raw.trim() === "") onChange(undefined);
        else {
          const n = Number(raw.replace(",", "."));
          if (Number.isFinite(n)) onChange(n);
        }
      }}
    />
  );
}

export function IssuesCallout({
  title,
  issues,
  tone = "critical",
  children,
}: {
  title: string;
  issues: ValidationIssue[];
  tone?: "critical" | "warning";
  children?: ReactNode;
}) {
  return (
    <div className={`callout ${tone}`} role="alert">
      <Icon name="alert" size={18} />
      <div className="stack tight" style={{ minWidth: 0 }}>
        <strong>{title}</strong>
        {issues.length > 0 ? (
          <ul>
            {issues.map((issue, i) => (
              <li key={i}>
                {issue.path ? <span className="mono small">{issue.path}</span> : null}
                {issue.path ? " : " : null}
                {issue.message}
              </li>
            ))}
          </ul>
        ) : null}
        {children}
      </div>
    </div>
  );
}

/** Liste de valeurs éditables sous forme de puces (ajout par Entrée ou bouton). */
export function TokenListEditor({
  values,
  onChange,
  label,
  placeholder,
  validate,
  mono = false,
  addLabel = "Ajouter",
  renderToken,
}: {
  values: string[];
  onChange: (values: string[]) => void;
  label: string;
  placeholder?: string;
  validate?: (value: string) => string | null;
  mono?: boolean;
  addLabel?: string;
  renderToken?: (value: string) => ReactNode;
}) {
  const inputId = useId();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    const value = text.trim();
    if (!value) return;
    const problem = validate?.(value) ?? (values.includes(value) ? "Valeur déjà présente." : null);
    if (problem) {
      setError(problem);
      return;
    }
    onChange([...values, value]);
    setText("");
    setError(null);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      add();
    }
  };
  return (
    <div className="stack tight">
      <div className="row wrap" role="list" aria-label={label}>
        {values.length === 0 ? <span className="small muted">Aucune valeur.</span> : null}
        {values.map((value) => (
          <span key={value} className={`chip${mono ? " mono" : ""}`} role="listitem">
            {renderToken ? renderToken(value) : value}
            <button
              type="button"
              className="token-remove"
              aria-label={`Retirer ${value}`}
              title="Retirer"
              onClick={() => onChange(values.filter((v) => v !== value))}
            >
              <Icon name="x" size={12} />
            </button>
          </span>
        ))}
      </div>
      <div className="row">
        <label htmlFor={inputId} className="visually-hidden">
          {label}
        </label>
        <input
          id={inputId}
          className={`input sm${mono ? " mono" : ""}`}
          value={text}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={onKey}
          style={{ maxWidth: 260 }}
        />
        <button type="button" className="btn sm" onClick={add} disabled={!text.trim()}>
          <Icon name="plus" size={14} />
          {addLabel}
        </button>
      </div>
      {error ? <span className="field-error">{error}</span> : null}
    </div>
  );
}

/** Indicateur « modifications non enregistrées ». */
export function DirtyBadge({ dirty }: { dirty: boolean }) {
  if (!dirty) return null;
  return (
    <span className="badge warning" role="status">
      <span className="dot warning" aria-hidden />
      Non enregistré
    </span>
  );
}

export function isHttpsUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}
