// Éditeur des permissions d'un agent : action simple par outil ou règles par motif.
import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon.tsx";
import { Button, IconButton, Segmented } from "../../components/ui.tsx";
import { isRecord } from "./shared.ts";

type Action = "allow" | "ask" | "deny";
type Choice = "inherit" | Action;

const ACTIONS: Action[] = ["allow", "ask", "deny"];
const ACTION_LABELS: Record<Action, string> = { allow: "Autoriser", ask: "Demander", deny: "Refuser" };

const PERMISSIONS: Array<{ key: string; label: string; hint: string; patterns: boolean }> = [
  { key: "edit", label: "Modifier des fichiers", hint: "Création, modification et suppression de fichiers.", patterns: true },
  { key: "bash", label: "Commandes shell", hint: "Exécution de commandes dans le terminal du conteneur.", patterns: true },
  { key: "webfetch", label: "Lire une page web", hint: "Téléchargement du contenu d'une URL.", patterns: false },
  { key: "websearch", label: "Recherche web", hint: "Recherche sur Internet.", patterns: false },
  { key: "task", label: "Lancer des sous-agents", hint: "Délégation à d'autres agents (motif = nom de l'agent).", patterns: true },
  {
    key: "external_directory",
    label: "Dossiers hors projet",
    hint: "Accès à des chemins en dehors du dossier du projet.",
    patterns: true,
  },
];

const MANAGED = new Set(PERMISSIONS.map((p) => p.key));

function isAction(value: unknown): value is Action {
  return value === "allow" || value === "ask" || value === "deny";
}

interface RuleRow {
  id: number;
  pattern: string;
  action: Action;
}

function PatternRules({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Record<string, unknown>;
  onChange: (value: Record<string, Action>) => void;
}) {
  const nextId = useRef(1);
  const toRows = (record: Record<string, unknown>): RuleRow[] =>
    Object.entries(record).map(([pattern, action]) => ({ id: nextId.current++, pattern, action: isAction(action) ? action : "ask" }));
  const [rows, setRows] = useState<RuleRow[]>(() => toRows(value));
  const emitted = useRef(JSON.stringify(value));

  useEffect(() => {
    const json = JSON.stringify(value);
    if (json !== emitted.current) {
      emitted.current = json;
      setRows(toRows(value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const update = (next: RuleRow[]) => {
    setRows(next);
    const record: Record<string, Action> = {};
    for (const row of next) if (row.pattern.trim()) record[row.pattern.trim()] = row.action;
    emitted.current = JSON.stringify(record);
    onChange(record);
  };

  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.pattern.trim(), (counts.get(row.pattern.trim()) ?? 0) + 1);

  return (
    <div className="perm-rules stack tight">
      <p className="small muted">
        Les règles sont évaluées dans l'ordre : <strong>la dernière règle qui correspond l'emporte</strong>. Placez le motif général{" "}
        <code>*</code> en premier, puis les exceptions.
      </p>
      {rows.map((row, index) => {
        const trimmed = row.pattern.trim();
        const problem = !trimmed ? "Motif vide : règle ignorée." : (counts.get(trimmed) ?? 0) > 1 ? "Motif en double : seule la dernière valeur est gardée." : null;
        return (
          <div key={row.id} className="perm-rule">
            <input
              className="input sm mono"
              value={row.pattern}
              aria-label={`${label} : motif ${index + 1}`}
              placeholder="git status*"
              onChange={(e) => update(rows.map((r) => (r.id === row.id ? { ...r, pattern: e.target.value } : r)))}
            />
            <select
              className="select sm"
              value={row.action}
              aria-label={`${label} : action du motif ${index + 1}`}
              onChange={(e) => update(rows.map((r) => (r.id === row.id ? { ...r, action: e.target.value as Action } : r)))}
            >
              {ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {ACTION_LABELS[a]}
                </option>
              ))}
            </select>
            <span className="row" style={{ gap: 2 }}>
              <IconButton
                icon="chevronDown"
                label="Monter"
                size="sm"
                className="flip-up"
                disabled={index === 0}
                onClick={() => {
                  const next = [...rows];
                  [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                  update(next);
                }}
              />
              <IconButton
                icon="chevronDown"
                label="Descendre"
                size="sm"
                disabled={index === rows.length - 1}
                onClick={() => {
                  const next = [...rows];
                  [next[index + 1], next[index]] = [next[index]!, next[index + 1]!];
                  update(next);
                }}
              />
              <IconButton icon="trash" label="Supprimer la règle" size="sm" onClick={() => update(rows.filter((r) => r.id !== row.id))} />
            </span>
            {problem ? <span className="field-error perm-rule-error">{problem}</span> : null}
          </div>
        );
      })}
      <div>
        <Button
          size="sm"
          icon="plus"
          onClick={() => update([...rows, { id: nextId.current++, pattern: rows.length === 0 ? "*" : "", action: "ask" }])}
        >
          Ajouter une règle
        </Button>
      </div>
    </div>
  );
}

export function PermissionsEditor({ value, onChange }: { value: unknown; onChange: (value: unknown) => void }) {
  if (typeof value === "string") {
    return (
      <div className="callout accent">
        <Icon name="shield" size={18} />
        <div className="stack tight">
          <span>
            Cet agent applique la même règle (<code>{value}</code>) à tous les outils.
          </span>
          <div>
            <Button size="sm" onClick={() => onChange({ "*": value })}>
              Personnaliser outil par outil
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const record = isRecord(value) ? value : {};
  const others = Object.keys(record).filter((k) => !MANAGED.has(k));

  const setKey = (key: string, rule: unknown) => {
    const next = { ...record };
    if (rule === undefined) delete next[key];
    else next[key] = rule;
    onChange(Object.keys(next).length > 0 ? next : undefined);
  };

  return (
    <div className="stack">
      {PERMISSIONS.map((perm) => {
        const rule = record[perm.key];
        const advanced = isRecord(rule);
        const choice: Choice = isAction(rule) ? rule : "inherit";
        return (
          <div key={perm.key} className="perm-row">
            <div className="perm-head">
              <div className="stack tight" style={{ gap: 0, minWidth: 0 }}>
                <strong className="small">
                  {perm.label} <span className="mono muted tiny">{perm.key}</span>
                </strong>
                <span className="tiny muted">{perm.hint}</span>
              </div>
              {advanced ? (
                <Button size="sm" variant="ghost" onClick={() => setKey(perm.key, isAction(rule["*"]) ? rule["*"] : "ask")}>
                  Règle simple
                </Button>
              ) : (
                <div className="row wrap" style={{ gap: 6, justifyContent: "flex-end" }}>
                  <Segmented<Choice>
                    label={perm.label}
                    value={choice}
                    options={[
                      { value: "inherit", label: "Hérité", title: "Utilise la règle de la configuration globale" },
                      { value: "allow", label: "Autoriser" },
                      { value: "ask", label: "Demander" },
                      { value: "deny", label: "Refuser" },
                    ]}
                    onChange={(next) => setKey(perm.key, next === "inherit" ? undefined : next)}
                  />
                  {perm.patterns ? (
                    <Button size="sm" variant="ghost" title="Règles par motif" onClick={() => setKey(perm.key, { "*": isAction(rule) ? rule : "ask" })}>
                      Motifs
                    </Button>
                  ) : null}
                </div>
              )}
            </div>
            {advanced ? <PatternRules label={perm.label} value={rule} onChange={(next) => setKey(perm.key, next)} /> : null}
          </div>
        );
      })}
      {others.length > 0 ? (
        <p className="small muted">
          Autres règles conservées telles quelles :{" "}
          {others.map((k) => (
            <code key={k} style={{ marginRight: 6 }}>
              {k}
            </code>
          ))}
        </p>
      ) : null}
    </div>
  );
}
