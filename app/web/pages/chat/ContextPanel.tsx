// Panneau latéral : coût de la conversation, classement, plan, fichiers modifiés, sous-agents.
import { useState } from "react";
import { DiffView } from "../../components/DiffView.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Badge, Button, CategoryChip, IconButton, Modal, useAsync } from "../../components/ui.tsx";
import { api } from "../../lib/api.ts";
import { formatCredits, formatTokens, formatUsd, relativeTime } from "../../lib/format.ts";
import { routeHref } from "../../lib/router.ts";
import type { Category, Conversation, FileDiff, OcSession, Todo } from "../../lib/types.ts";
import { TodoItems } from "./ToolCard.tsx";

const CLASSIFIED_BY: Record<string, string> = { llm: "par IA", heuristic: "automatique", manual: "manuel", none: "non classée" };

export function ContextPanel({
  sessionId,
  conversation,
  categoryById,
  todos,
  diff,
  childSessions,
  usageTick,
  onOpenSession,
  onClassify,
  onClose,
}: {
  sessionId: string | null;
  conversation: Conversation | null;
  categoryById: (id: string | null | undefined) => Category | undefined;
  todos: Todo[];
  diff: FileDiff[];
  childSessions: OcSession[];
  usageTick: number;
  onOpenSession: (id: string) => void;
  onClassify: () => Promise<void>;
  onClose: () => void;
}) {
  const usage = useAsync(() => (sessionId ? api.sessionUsage(sessionId) : Promise.resolve(null)), [sessionId, usageTick]);
  const [openDiff, setOpenDiff] = useState<FileDiff | null>(null);
  const [classifying, setClassifying] = useState(false);

  if (!sessionId) return null;
  const u = usage.data;

  return (
    <aside className="chat-aside" aria-label="Contexte de la conversation">
      <div className="row between">
        <strong>Contexte</strong>
        <IconButton icon="x" label="Masquer le panneau" size="sm" onClick={onClose} />
      </div>

      <section className="aside-section">
        <h4>Coût de la conversation</h4>
        <div className="stack tight">
          <div className="row" style={{ alignItems: "baseline" }}>
            <span style={{ fontSize: 24, fontWeight: 650 }}>{formatUsd(u?.cost ?? 0)}</span>
            <span className="small muted">{formatCredits(u?.cost ?? 0)}</span>
          </div>
          <dl className="kv">
            <dt>Appels de modèle</dt>
            <dd>{u?.calls ?? 0}</dd>
            <dt>Tokens en entrée</dt>
            <dd>{formatTokens((u?.tokens.input ?? 0) + (u?.tokens.cacheRead ?? 0) + (u?.tokens.cacheWrite ?? 0))}</dd>
            <dt>dont lus en cache</dt>
            <dd>{formatTokens(u?.tokens.cacheRead ?? 0)}</dd>
            <dt>Tokens en sortie</dt>
            <dd>{formatTokens((u?.tokens.output ?? 0) + (u?.tokens.reasoning ?? 0))}</dd>
          </dl>
          {u && u.byModel.length > 1 ? (
            <dl className="kv">
              {u.byModel.map((m) => (
                <div key={`${m.providerID}/${m.modelID}`} style={{ display: "contents" }}>
                  <dt className="ellipsis">{m.modelID}</dt>
                  <dd>{formatUsd(m.cost)}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <span className="tiny muted">Sous-agents inclus. Coût facturé rapporté par GitHub quand il est disponible.</span>
        </div>
      </section>

      <section className="aside-section">
        <h4>Classement</h4>
        {conversation ? (
          <div className="stack tight">
            <div className="row wrap">
              <CategoryChip category={categoryById(conversation.category)} fallback={conversation.category} />
              <span className="tiny muted">{CLASSIFIED_BY[conversation.classifiedBy] ?? conversation.classifiedBy}</span>
            </div>
            {conversation.tags.length > 0 ? (
              <div className="row wrap" style={{ gap: 4 }}>
                {conversation.tags.map((tag) => (
                  <Badge key={tag}>{tag}</Badge>
                ))}
              </div>
            ) : null}
            {conversation.summary ? <p className="small secondary">{conversation.summary}</p> : null}
            <div className="row wrap">
              <Button
                size="sm"
                icon="sparkle"
                loading={classifying}
                onClick={async () => {
                  setClassifying(true);
                  try {
                    await onClassify();
                  } finally {
                    setClassifying(false);
                  }
                }}
              >
                Reclasser
              </Button>
              <a className="btn ghost sm" href={routeHref("archives", conversation.sessionId)}>
                <Icon name="archive" size={14} />
                Archives
              </a>
            </div>
          </div>
        ) : (
          <div className="stack tight">
            <p className="small muted">La conversation sera archivée et classée automatiquement dès qu'elle sera inactive.</p>
            <div>
              <Button
                size="sm"
                icon="sparkle"
                loading={classifying}
                onClick={async () => {
                  setClassifying(true);
                  try {
                    await onClassify();
                  } finally {
                    setClassifying(false);
                  }
                }}
              >
                Classer maintenant
              </Button>
            </div>
          </div>
        )}
      </section>

      {todos.length > 0 ? (
        <section className="aside-section">
          <h4>Plan de l'agent</h4>
          <TodoItems todos={todos} />
        </section>
      ) : null}

      {diff.length > 0 ? (
        <section className="aside-section">
          <h4>Fichiers modifiés ({diff.length})</h4>
          <div className="list">
            {diff.map((file, i) => (
              <button key={`${file.file ?? i}`} type="button" className="list-item" style={{ padding: "6px 4px" }} onClick={() => setOpenDiff(file)}>
                <Icon name="file" size={13} />
                <span className="ellipsis small mono">{file.file ?? "fichier"}</span>
                <span className="spacer" />
                <span className="tiny nowrap">
                  <span className="status-ok">+{file.additions}</span> <span className="status-error">−{file.deletions}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {childSessions.length > 0 ? (
        <section className="aside-section">
          <h4>Sous-agents ({childSessions.length})</h4>
          <div className="list">
            {childSessions.map((child) => (
              <button key={child.id} type="button" className="list-item" style={{ padding: "6px 4px" }} onClick={() => onOpenSession(child.id)}>
                <Icon name="users" size={13} />
                <span className="ellipsis small">{child.title || child.id}</span>
                <span className="spacer" />
                <span className="tiny muted nowrap">{relativeTime(child.time.updated)}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <Modal open={openDiff !== null} title={openDiff?.file ?? "Différences"} onClose={() => setOpenDiff(null)} wide>
        {openDiff?.patch ? <DiffView patch={openDiff.patch} maxLines={1_000} /> : <p className="muted">Aucun détail disponible pour ce fichier.</p>}
      </Modal>
    </aside>
  );
}
