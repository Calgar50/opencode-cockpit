// Rendu d'un échange : demande de l'utilisateur puis toutes les étapes de réponse de l'agent.
import { memo, useDeferredValue } from "react";
import { MESSAGES } from "../../../server/shared/assistant-rules.ts";
import { Icon } from "../../components/Icon.tsx";
import { Markdown } from "../../components/Markdown.tsx";
import { formatDuration, formatTokens, formatUsd } from "../../lib/format.ts";
import type { OcError, OcFilePart, OcPart, OcTextPart } from "../../lib/types.ts";
import { relativePath, ToolCard } from "./ToolCard.tsx";
import { type MessageEntry, type Turn, turnTotals } from "./transcript.ts";
import { isModelNotFound } from "./turn.ts";

function StreamingMarkdown({ text }: { text: string }) {
  const deferred = useDeferredValue(text);
  return <Markdown text={deferred} />;
}

export function describeError(error: OcError): { tone: "muted" | "critical"; text: string } {
  const detail = typeof error.data?.message === "string" ? error.data.message : "";
  switch (error.name) {
    case "MessageAbortedError":
      return { tone: "muted", text: "Réponse interrompue." };
    case "ProviderAuthError":
      return {
        tone: "critical",
        text: `Authentification refusée par le fournisseur : reconnectez GitHub Copilot (Paramètres › Connexion).${detail ? ` ${detail}` : ""}`,
      };
    case "ContextOverflowError":
      return { tone: "critical", text: "Contexte trop long pour ce modèle : compactez la conversation ou choisissez un modèle à plus grand contexte." };
    case "MessageOutputLengthError":
      return { tone: "critical", text: "Réponse coupée : la limite de sortie du modèle est atteinte." };
    default:
      if (isModelNotFound(error)) return { tone: "critical", text: `${MESSAGES.modelNotFoundTitle}. ${MESSAGES.modelNotFound}` };
      return { tone: "critical", text: detail || error.name };
  }
}

function UserBubble({ entry }: { entry: MessageEntry }) {
  const text = entry.parts
    .filter((p): p is OcTextPart => p.type === "text" && !p.synthetic)
    .map((p) => p.text)
    .join("\n")
    .trim();
  const files = entry.parts.filter((p): p is OcFilePart => p.type === "file");
  return (
    <div className="user-msg">
      {text}
      {files.length > 0 ? (
        <div className="attachments">
          {files.map((file) =>
            file.mime.startsWith("image/") && file.url.startsWith("data:image/") ? (
              <img key={file.id} src={file.url} alt={file.filename ?? "image jointe"} />
            ) : (
              <span key={file.id} className="chip">
                <Icon name="file" size={12} />
                {file.filename ?? "fichier"}
              </span>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

function PartView({ part, root, onOpenSession }: { part: OcPart; root: string; onOpenSession?: (id: string) => void }) {
  switch (part.type) {
    case "text":
      return part.synthetic || !part.text ? null : <StreamingMarkdown text={part.text} />;
    case "reasoning":
      return part.text.trim() ? (
        <details className="reasoning">
          <summary>
            <Icon name="brain" size={13} />
            {part.time?.end ? `Réflexion · ${formatDuration(part.time.end - part.time.start)}` : "Réflexion en cours…"}
          </summary>
          <StreamingMarkdown text={part.text} />
        </details>
      ) : null;
    case "tool":
      return <ToolCard part={part} root={root} {...(onOpenSession ? { onOpenSession } : {})} />;
    case "patch":
      return part.files.length > 0 ? (
        <div className="row wrap small muted">
          <Icon name="git" size={13} />
          Fichiers modifiés :
          {part.files.map((file) => (
            <code key={file}>{relativePath(file, root)}</code>
          ))}
        </div>
      ) : null;
    case "file":
      return (
        <span className="chip">
          <Icon name="file" size={12} />
          {part.filename ?? "fichier"}
        </span>
      );
    case "retry":
      return (
        <div className="callout warning small">
          <Icon name="refresh" size={14} />
          Nouvelle tentative n° {part.attempt} : {part.error?.data?.message ?? part.error?.name ?? "erreur temporaire"}
        </div>
      );
    case "compaction":
      return (
        <div className="row small muted">
          <Icon name="layers" size={13} />
          Contexte compacté{part.auto ? " automatiquement" : ""}
        </div>
      );
    case "subtask":
      return (
        <div className="callout accent small">
          <Icon name="users" size={14} />
          <span>
            Sous-tâche confiée à <strong>{part.agent}</strong> : {part.description}
          </span>
        </div>
      );
    default:
      return null;
  }
}

interface TurnViewProps {
  turn: Turn;
  root: string;
  modelName: (key: string) => string;
  onOpenSession?: (id: string) => void;
}

function TurnViewImpl({ turn, root, modelName, onOpenSession }: TurnViewProps) {
  const totals = turnTotals(turn);
  const agents = [...new Set(turn.replies.map((r) => r.info.agent))];
  const models = [...new Set(turn.replies.map((r) => `${r.info.providerID}/${r.info.modelID}`))];
  return (
    <article className="turn">
      {turn.user ? <UserBubble entry={turn.user} /> : null}
      {turn.replies.length > 0 ? (
        <div className="assistant">
          <div className="assistant-head">
            <span className="avatar">
              <Icon name="bot" size={15} />
            </span>
            <strong>{agents.join(", ")}</strong>
            <span className="muted small ellipsis">{models.map(modelName).join(", ")}</span>
            {totals.running ? (
              <span className="row small muted">
                <span className="dot accent pulse" />
                en cours
              </span>
            ) : null}
          </div>
          <div className="assistant-body">
            {turn.replies.map((reply) => {
              const error = reply.info.error ? describeError(reply.info.error) : null;
              return (
                <div key={reply.info.id} className="stack tight">
                  {reply.parts.map((part) => (
                    <PartView key={part.id} part={part} root={root} {...(onOpenSession ? { onOpenSession } : {})} />
                  ))}
                  {error ? (
                    <div className={error.tone === "critical" ? "callout critical" : "small muted"}>
                      {error.tone === "critical" ? <Icon name="alert" size={15} /> : null}
                      {error.text}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          {!totals.running ? (
            <div className="turn-footer" title="Coût et tokens de cet échange (toutes étapes)">
              <span>{formatUsd(totals.cost)}</span>
              <span>
                {formatTokens(totals.input + totals.cacheRead)} tokens en entrée
                {totals.cacheRead > 0 ? ` (dont ${formatTokens(totals.cacheRead)} en cache)` : ""}
              </span>
              <span>{formatTokens(totals.output)} en sortie</span>
              <span>
                {totals.steps} appel{totals.steps > 1 ? "s" : ""}
              </span>
              {totals.durationMs ? <span>{formatDuration(totals.durationMs)}</span> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

/** Rendu mémorisé : un échange n'est redessiné que si l'un de ses messages a changé. */
export const TurnView = memo(TurnViewImpl, (prev, next) => {
  if (prev.root !== next.root || prev.modelName !== next.modelName || prev.onOpenSession !== next.onOpenSession) return false;
  if (prev.turn.user !== next.turn.user || prev.turn.replies.length !== next.turn.replies.length) return false;
  return prev.turn.replies.every((reply, i) => reply === next.turn.replies[i]);
});
