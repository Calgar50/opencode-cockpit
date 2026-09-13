// Affichage d'un appel d'outil opencode (commande, lecture, modification, sous-agent…).
import { memo, type ReactNode, useState } from "react";
import { countDiff, DiffView } from "../../components/DiffView.tsx";
import { Icon, type IconName } from "../../components/Icon.tsx";
import { Markdown } from "../../components/Markdown.tsx";
import { Button, Spinner } from "../../components/ui.tsx";
import { formatDuration } from "../../lib/format.ts";
import type { OcToolPart, Todo } from "../../lib/types.ts";

const TOOLS: Record<string, { icon: IconName; label: string }> = {
  bash: { icon: "terminal", label: "Commande" },
  read: { icon: "eye", label: "Lecture" },
  write: { icon: "file", label: "Écriture" },
  edit: { icon: "edit", label: "Modification" },
  multiedit: { icon: "edit", label: "Modifications" },
  patch: { icon: "edit", label: "Patch" },
  apply_patch: { icon: "edit", label: "Patch" },
  grep: { icon: "search", label: "Recherche" },
  glob: { icon: "folder", label: "Fichiers" },
  list: { icon: "list", label: "Dossier" },
  webfetch: { icon: "globe", label: "Page web" },
  websearch: { icon: "globe", label: "Recherche web" },
  task: { icon: "users", label: "Sous-agent" },
  todowrite: { icon: "list", label: "Plan" },
  todoread: { icon: "list", label: "Plan" },
  skill: { icon: "book", label: "Skill" },
  question: { icon: "question", label: "Question" },
  lsp: { icon: "brain", label: "Analyse" },
};

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");
const MAX_OUTPUT = 20_000;

const str = (value: unknown): string => (typeof value === "string" ? value : "");

export function relativePath(file: string, root: string): string {
  const norm = file.replace(/\\/g, "/");
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  return base && norm.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? norm.slice(base.length + 1) : norm;
}

function clip(text: string): { text: string; clipped: boolean } {
  const clean = text.replace(ANSI, "");
  return clean.length > MAX_OUTPUT ? { text: clean.slice(0, MAX_OUTPUT), clipped: true } : { text: clean, clipped: false };
}

function describe(part: OcToolPart, root: string): string {
  const input = part.state.input ?? {};
  const file = str(input.filePath) || str(input.path);
  switch (part.tool) {
    case "bash":
      return str(input.description) || str(input.command);
    case "read":
    case "write":
    case "edit":
    case "multiedit":
    case "list":
      return file ? relativePath(file, root) : "";
    case "grep":
    case "glob":
      return str(input.pattern);
    case "webfetch":
      return str(input.url);
    case "websearch":
      return str(input.query);
    case "task":
      return [str(input.subagent_type), str(input.description)].filter(Boolean).join(" — ");
    case "skill":
      return str(input.name);
    default:
      return part.state.status === "completed" || part.state.status === "running" ? str(part.state.title) : "";
  }
}

function TodoItems({ todos }: { todos: Todo[] }) {
  return (
    <ul className="todo-list">
      {todos.map((todo, i) => (
        <li key={i} className={todo.status}>
          <Icon
            name={todo.status === "completed" ? "check" : todo.status === "in_progress" ? "clock" : "chevronRight"}
            size={14}
            className={todo.status === "completed" ? "status-ok" : ""}
          />
          <span>{todo.content}</span>
        </li>
      ))}
    </ul>
  );
}

export { TodoItems };

function ToolCardImpl({ part, root, onOpenSession }: { part: OcToolPart; root: string; onOpenSession?: (id: string) => void }) {
  const state = part.state;
  const [open, setOpen] = useState(state.status === "error");
  const meta = TOOLS[part.tool] ?? { icon: "wrench" as IconName, label: part.tool };
  const input = state.input ?? {};
  const metadata = ("metadata" in state ? state.metadata : undefined) ?? {};
  const diff = str(metadata.diff);
  const stats = diff ? countDiff(diff) : null;
  const duration = state.status === "completed" || state.status === "error" ? state.time.end - state.time.start : null;
  const output = state.status === "completed" ? state.output : str(metadata.output);
  const childSession = str(metadata.sessionId);

  let body: ReactNode = null;
  if (open) {
    const out = clip(output);
    switch (part.tool) {
      case "bash":
        body = (
          <pre className="terminal">
            <span className="prompt">$ </span>
            {str(input.command)}
            {out.text ? `\n${out.text}` : ""}
            {out.clipped ? "\n… (sortie tronquée)" : ""}
          </pre>
        );
        break;
      case "edit":
      case "multiedit":
      case "patch":
      case "apply_patch":
      case "write":
        body = diff ? (
          <DiffView patch={diff} />
        ) : part.tool === "write" && str(input.content) ? (
          <pre className="plain">{clip(str(input.content)).text}</pre>
        ) : out.text ? (
          <pre className="plain">{out.text}</pre>
        ) : null;
        break;
      case "task":
        body = (
          <>
            {str(input.prompt) ? (
              <details>
                <summary className="small muted">Consigne transmise au sous-agent</summary>
                <Markdown text={str(input.prompt)} />
              </details>
            ) : null}
            {out.text ? <Markdown text={out.text} /> : null}
            {childSession && onOpenSession ? (
              <div>
                <Button size="sm" icon="users" onClick={() => onOpenSession(childSession)}>
                  Voir le travail du sous-agent
                </Button>
              </div>
            ) : null}
          </>
        );
        break;
      case "todowrite":
      case "todoread":
        body = Array.isArray(input.todos) ? <TodoItems todos={input.todos as Todo[]} /> : null;
        break;
      default:
        body = (
          <>
            {Object.keys(input).length > 0 && !["read", "grep", "glob", "list"].includes(part.tool) ? (
              <pre className="plain">{JSON.stringify(input, null, 2)}</pre>
            ) : null}
            {out.text ? (
              <pre className="plain">
                {out.text}
                {out.clipped ? "\n… (sortie tronquée)" : ""}
              </pre>
            ) : null}
          </>
        );
    }
  }

  return (
    <div className={`tool-card${state.status === "error" ? " error" : ""}`}>
      <button type="button" className="tool-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} className="muted" />
        <Icon name={meta.icon} size={15} />
        <span className="tool-name">{meta.label}</span>
        <span className="tool-label ellipsis">{describe(part, root)}</span>
        <span className="spacer" />
        {stats ? (
          <span className="tiny nowrap">
            <span className="status-ok">+{stats.additions}</span> <span className="status-error">−{stats.deletions}</span>
          </span>
        ) : null}
        {duration !== null ? <span className="tiny muted nowrap">{formatDuration(duration)}</span> : null}
        {state.status === "pending" || state.status === "running" ? (
          <Spinner label="En cours" />
        ) : state.status === "error" ? (
          <Icon name="alert" size={15} className="status-error" title="Échec" />
        ) : (
          <Icon name="check" size={15} className="status-ok" title="Terminé" />
        )}
      </button>
      {open ? (
        <div className="tool-body">
          {state.status === "error" ? <div className="callout critical">{state.error}</div> : null}
          {body}
        </div>
      ) : null}
    </div>
  );
}

export const ToolCard = memo(ToolCardImpl);
