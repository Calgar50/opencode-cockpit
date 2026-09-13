// Liste des conversations du projet courant, groupées par ancienneté.
import { useMemo, useState } from "react";
import { Icon } from "../../components/Icon.tsx";
import { Badge, Button, Spinner } from "../../components/ui.tsx";
import { formatUsd, relativeTime } from "../../lib/format.ts";
import { routeHref } from "../../lib/router.ts";
import type { Category, Conversation, OcSession, OcSessionStatus, ProjectInfo } from "../../lib/types.ts";

const DAY = 86_400_000;

function groupLabel(ts: number, now: Date): string {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= startOfToday) return "Aujourd'hui";
  if (ts >= startOfToday - DAY) return "Hier";
  if (ts >= startOfToday - 7 * DAY) return "7 derniers jours";
  if (ts >= startOfToday - 30 * DAY) return "30 derniers jours";
  return "Plus ancien";
}

export function SessionSidebar({
  projects,
  directory,
  onDirectoryChange,
  sessions,
  loading,
  activeId,
  statuses,
  conversations,
  categoryById,
  pendingBySession,
  onNew,
}: {
  projects: ProjectInfo[];
  directory: string;
  onDirectoryChange: (directory: string) => void;
  sessions: OcSession[];
  loading: boolean;
  activeId: string | null;
  statuses: Record<string, OcSessionStatus>;
  conversations: ReadonlyMap<string, Conversation>;
  categoryById: (id: string | null | undefined) => Category | undefined;
  pendingBySession: ReadonlyMap<string, number>;
  onNew: () => void;
}) {
  const [filter, setFilter] = useState("");

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const now = new Date();
    const result: Array<{ label: string; items: OcSession[] }> = [];
    for (const session of sessions) {
      if (needle && !(session.title ?? "").toLowerCase().includes(needle)) continue;
      const label = groupLabel(session.time.updated, now);
      const group = result.find((g) => g.label === label);
      if (group) group.items.push(session);
      else result.push({ label, items: [session] });
    }
    return result;
  }, [sessions, filter]);

  return (
    <aside className="chat-sidebar" aria-label="Conversations">
      <select className="select sm" value={directory} aria-label="Projet" title="Projet" onChange={(e) => onDirectoryChange(e.target.value)}>
        {projects.map((p) => (
          <option key={p.directory} value={p.directory}>
            {p.isRoot ? "Tout le workspace" : p.name}
          </option>
        ))}
      </select>
      <Button variant="primary" icon="plus" onClick={onNew}>
        Nouvelle conversation
      </Button>
      <div className="search-input">
        <Icon name="search" size={14} />
        <input className="input sm" placeholder="Filtrer les conversations" aria-label="Filtrer" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <nav className="sessions">
        {loading ? (
          <div className="empty">
            <Spinner />
          </div>
        ) : null}
        {!loading && sessions.length === 0 ? <p className="small muted" style={{ padding: 12 }}>Aucune conversation dans ce projet.</p> : null}
        {groups.map((group) => (
          <div key={group.label}>
            <div className="session-group">{group.label}</div>
            {group.items.map((session) => {
              const category = categoryById(conversations.get(session.id)?.category);
              const status = statuses[session.id];
              const pending = pendingBySession.get(session.id) ?? 0;
              const running = status?.type === "busy" || status?.type === "retry";
              return (
                <a key={session.id} href={routeHref("chat", session.id)} className={`session-item${session.id === activeId ? " active" : ""}`}>
                  <span className="title ellipsis">{session.title || "Sans titre"}</span>
                  <span className="meta">
                    {category ? (
                      <span title={category.label} aria-label={category.label}>
                        {category.emoji}
                      </span>
                    ) : null}
                    <span className="nowrap">{relativeTime(session.time.updated)}</span>
                    {session.cost ? <span className="nowrap">· {formatUsd(session.cost)}</span> : null}
                    <span className="spacer" />
                    {pending > 0 ? <Badge tone="warning">à valider</Badge> : null}
                    {running ? <span className="dot accent pulse" title="Réponse en cours" /> : null}
                  </span>
                </a>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}
