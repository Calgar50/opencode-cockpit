// Suivi local des sessions opencode : parenté (sous-agents) et session racine.
import type { DatabaseSync } from "node:sqlite";
import { params } from "./db.ts";
import type { OcSession, OpencodeClient } from "./opencode.ts";

export type SessionPurpose = "chat" | "classifier";

export interface SessionRow {
  id: string;
  parent_id: string | null;
  root_id: string;
  directory: string;
  project_id: string | null;
  title: string;
  purpose: SessionPurpose;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export const CLASSIFIER_TITLE_PREFIX = "[cockpit] ";

export function purposeOf(info: Pick<OcSession, "title" | "metadata">): SessionPurpose {
  if (info.metadata?.cockpit === "classifier" || info.title.startsWith(CLASSIFIER_TITLE_PREFIX)) return "classifier";
  return "chat";
}

export class SessionTracker {
  readonly #db: DatabaseSync;
  readonly #client: OpencodeClient;

  constructor(db: DatabaseSync, client: OpencodeClient) {
    this.#db = db;
    this.#client = client;
  }

  get(id: string): SessionRow | undefined {
    return this.#db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  }

  isHidden(id: string | undefined): boolean {
    if (!id) return false;
    const row = this.get(id);
    if (!row) return false;
    if (row.purpose === "classifier") return true;
    return row.root_id !== row.id && this.get(row.root_id)?.purpose === "classifier";
  }

  upsert(info: OcSession, forcedPurpose?: SessionPurpose): SessionRow {
    const parent = info.parentID ? this.get(info.parentID) : undefined;
    const rootId = info.parentID ? (parent?.root_id ?? info.parentID) : info.id;
    const purpose = forcedPurpose ?? (parent?.purpose === "classifier" ? "classifier" : purposeOf(info));
    const previous = this.get(info.id);
    this.#db
      .prepare(
        `INSERT INTO sessions (id, parent_id, root_id, directory, project_id, title, purpose, created_at, updated_at)
         VALUES (:id, :parent_id, :root_id, :directory, :project_id, :title, :purpose, :created_at, :updated_at)
         ON CONFLICT(id) DO UPDATE SET
           parent_id = excluded.parent_id, root_id = excluded.root_id, directory = excluded.directory,
           project_id = excluded.project_id, title = excluded.title,
           purpose = CASE WHEN sessions.purpose = 'classifier' THEN 'classifier' ELSE excluded.purpose END,
           updated_at = MAX(sessions.updated_at, excluded.updated_at)`,
      )
      .run(
        params({
          id: info.id,
          parent_id: info.parentID,
          root_id: rootId,
          directory: info.directory ?? "",
          project_id: info.projectID,
          title: info.title ?? "",
          purpose,
          created_at: info.time?.created ?? Date.now(),
          updated_at: info.time?.updated ?? Date.now(),
        }),
      );
    // Descendants enregistrés avant que leurs ancêtres soient connus : rattachement à la vraie racine.
    if (rootId !== info.id) this.#reparent(info.id, rootId);
    if (previous && previous.root_id !== rootId && previous.root_id !== info.id) this.#reparent(previous.root_id, rootId);
    return this.get(info.id) as SessionRow;
  }

  #reparent(oldRoot: string, newRoot: string): void {
    this.#db.prepare("UPDATE sessions SET root_id = ? WHERE root_id = ?").run(newRoot, oldRoot);
    this.#db.prepare("UPDATE usage SET root_id = ? WHERE root_id = ?").run(newRoot, oldRoot);
    this.#db.prepare("UPDATE prompts SET root_id = ? WHERE root_id = ?").run(newRoot, oldRoot);
  }

  markDeleted(id: string): void {
    this.#db.prepare("UPDATE sessions SET deleted_at = ? WHERE id = ?").run(Date.now(), id);
  }

  /** Garantit que la session (et sa lignée) est connue, quitte à interroger opencode. */
  async ensure(id: string, directory?: string, depth = 0): Promise<SessionRow | undefined> {
    const known = this.get(id);
    if (known && (known.parent_id === null || this.get(known.parent_id))) return known;
    if (depth > 8) return known;
    let info: OcSession;
    try {
      info = await this.#client.request<OcSession>("GET", `/session/${encodeURIComponent(id)}`, {
        ...(directory ? { directory } : {}),
        timeoutMs: 10_000,
      });
    } catch {
      return known;
    }
    if (info.parentID && !this.get(info.parentID)) await this.ensure(info.parentID, info.directory, depth + 1);
    return this.upsert(info);
  }
}
