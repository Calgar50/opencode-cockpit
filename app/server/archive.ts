// Archives des conversations : résumé exploitable, index plein texte, export Markdown rangé par catégorie.
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { stringify } from "yaml";
import { params } from "./db.ts";
import { assertInside, safeSegment, slugify, writeFileAtomic } from "./fsutil.ts";
import { type ClassificationResult, classifyHeuristic } from "./heuristic.ts";
import type { Ledger } from "./ledger.ts";
import type { Logger } from "./log.ts";
import { type OcMessageWithParts, type OcPart, type OcSession, type OpencodeClient, OpencodeError } from "./opencode.ts";
import { redactSecrets } from "./redact.ts";
import type { SessionTracker } from "./sessions.ts";
import type { Category, SettingsStore } from "./settings.ts";

export interface ConversationDigest {
  sessionId: string;
  directory: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  prompts: string[];
  answers: string[];
  tools: Record<string, number>;
  files: string[];
  commands: string[];
  models: string[];
  additions: number;
  deletions: number;
  messageCount: number;
  promptCount: number;
  transcript: string;
}

interface ConversationRow {
  session_id: string;
  directory: string;
  title: string;
  title_manual: number;
  category: string;
  tags: string;
  summary: string;
  classified_by: string;
  confidence: number | null;
  classified_at: number | null;
  prompts_at_classification: number;
  created_at: number;
  updated_at: number;
  prompt_count: number;
  message_count: number;
  cost: number;
  models: string;
  tools: string;
  files: string;
  additions: number;
  deletions: number;
  archive_path: string | null;
  pinned: number;
  deleted_in_opencode: number;
  snippet?: string;
}

export interface Conversation {
  sessionId: string;
  directory: string;
  project: string;
  title: string;
  titleManual: boolean;
  category: string;
  tags: string[];
  summary: string;
  classifiedBy: string;
  confidence: number | null;
  classifiedAt: number | null;
  promptsAtClassification: number;
  createdAt: number;
  updatedAt: number;
  promptCount: number;
  messageCount: number;
  cost: number;
  models: string[];
  tools: Record<string, number>;
  files: string[];
  additions: number;
  deletions: number;
  archivePath: string | null;
  pinned: boolean;
  deletedInOpencode: boolean;
  snippet?: string;
}

export interface ArchiveQuery {
  q?: string;
  category?: string;
  project?: string;
  from?: number;
  to?: number;
  pinned?: boolean;
  limit: number;
  offset: number;
}

const MAX_TRANSCRIPT = 200_000;
const EDIT_TOOLS = new Set(["edit", "write", "patch", "apply_patch", "multiedit"]);
/** Marqueurs de surlignage des extraits de recherche (jamais du HTML). */
export const SNIPPET_OPEN = "\u0002";
export const SNIPPET_CLOSE = "\u0003";

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const parseJson = <T>(text: string, fallback: T): T => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

export function relativeToWorkspace(file: string, workspaceDir: string): string {
  if (!file) return file;
  const norm = file.replace(/\\/g, "/");
  const root = workspaceDir.replace(/\\/g, "/").replace(/\/+$/, "");
  return norm.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? norm.slice(root.length + 1) : norm;
}

/** Titre générique posé par opencode avant (ou faute de) génération d'un vrai titre. */
export function isDefaultTitle(title: string): boolean {
  return !title.trim() || /^(new session|nouvelle session|child session)(\s|$|[-:])/i.test(title.trim());
}

export function projectOf(directory: string, workspaceDir: string): string {
  const rel = relativeToWorkspace(directory, workspaceDir);
  if (!rel || rel === directory.replace(/\\/g, "/")) {
    return directory.replace(/\\/g, "/").replace(/\/+$/, "") === workspaceDir.replace(/\\/g, "/").replace(/\/+$/, "")
      ? "(racine)"
      : path.basename(directory);
  }
  return rel.split("/")[0] ?? rel;
}

export function describeTool(part: OcPart, workspaceDir: string): { name: string; label: string; file?: string; command?: string } {
  const name = str(part.tool) || "outil";
  const state = (part.state ?? {}) as { input?: Record<string, unknown>; title?: string };
  const input = state.input ?? {};
  const rawFile = str(input.filePath) || str(input.path);
  const file = rawFile ? relativeToWorkspace(rawFile, workspaceDir) : undefined;
  switch (name) {
    case "bash":
      return { name, label: str(input.command), command: str(input.command) };
    case "read":
    case "edit":
    case "write":
    case "list":
    case "multiedit":
      return { name, label: file ?? "", ...(file ? { file } : {}) };
    case "grep":
    case "glob":
      return { name, label: `${str(input.pattern)}${file ? ` (${file})` : ""}` };
    case "webfetch":
      return { name, label: str(input.url) };
    case "task":
      return { name, label: [str(input.subagent_type), str(input.description)].filter(Boolean).join(" — ") };
    case "skill":
      return { name, label: str(input.name) };
    default:
      return { name, label: str(state.title) };
  }
}

export function buildDigest(session: OcSession, messages: OcMessageWithParts[], workspaceDir: string): ConversationDigest {
  const prompts: string[] = [];
  const answers: string[] = [];
  const tools: Record<string, number> = {};
  const files = new Set<string>();
  const commands: string[] = [];
  const models = new Set<string>();
  const lines: string[] = [];
  let promptCount = 0;

  for (const { info, parts } of messages) {
    const when = `${new Date(info.time.created).toISOString().replace("T", " ").slice(0, 16)} UTC`;
    const text = redactSecrets(
      parts
        .filter((p) => p.type === "text" && !p.synthetic)
        .map((p) => str(p.text))
        .join("\n")
        .trim(),
    );
    if (info.role === "user") {
      const attachments = parts.filter((p) => p.type === "file").map((p) => str(p.filename) || "fichier");
      if (!text && attachments.length === 0) continue;
      promptCount++;
      prompts.push(text);
      lines.push(`## 🧑 Vous · ${when}`, "", text || "_(pièce jointe)_", "");
      if (attachments.length > 0) lines.push(`📎 ${attachments.join(", ")}`, "");
      continue;
    }
    models.add(`${info.providerID}/${info.modelID}`);
    const toolLines: string[] = [];
    for (const part of parts) {
      if (part.type === "tool") {
        const d = describeTool(part, workspaceDir);
        tools[d.name] = (tools[d.name] ?? 0) + 1;
        if (EDIT_TOOLS.has(d.name) && d.file) files.add(d.file);
        if (d.command) commands.push(redactSecrets(d.command.slice(0, 300)));
        toolLines.push(`> 🔧 \`${d.name}\` ${redactSecrets(d.label).replace(/\s+/g, " ").slice(0, 200)}`);
      } else if (part.type === "patch" && Array.isArray(part.files)) {
        for (const f of part.files) if (typeof f === "string") files.add(relativeToWorkspace(f, workspaceDir));
      }
    }
    if (!text && toolLines.length === 0) continue;
    if (text) answers.push(text);
    lines.push(`## 🤖 ${info.agent} · ${info.providerID}/${info.modelID} · ${when}`, "");
    if (toolLines.length > 0) lines.push(...toolLines, "");
    if (text) lines.push(text, "");
  }

  let transcript = lines.join("\n");
  if (transcript.length > MAX_TRANSCRIPT) transcript = `${transcript.slice(0, MAX_TRANSCRIPT)}\n\n_(transcription tronquée)_\n`;
  return {
    sessionId: session.id,
    directory: session.directory,
    title: session.title,
    createdAt: session.time.created,
    updatedAt: session.time.updated,
    prompts,
    answers,
    tools,
    files: [...files],
    commands,
    models: [...models],
    additions: session.summary?.additions ?? 0,
    deletions: session.summary?.deletions ?? 0,
    messageCount: messages.length,
    promptCount,
    transcript,
  };
}

/** Requête FTS5 sûre : chaque mot devient un préfixe entre guillemets (aucune syntaxe FTS injectable). */
export function ftsQuery(input: string): string | null {
  const terms = input
    .split(/\s+/)
    .map((t) => t.replace(/["*^():]/g, "").trim())
    .filter((t) => t.length > 0)
    .slice(0, 12);
  return terms.length > 0 ? terms.map((t) => `"${t}"*`).join(" ") : null;
}

export interface ArchiveDeps {
  db: DatabaseSync;
  client: OpencodeClient;
  settings: SettingsStore;
  ledger: Ledger;
  sessions: SessionTracker;
  archiveDir: string;
  opencodeWorkspaceDir: string;
  log: Logger;
}

export class ArchiveService {
  readonly #d: ArchiveDeps;

  constructor(deps: ArchiveDeps) {
    this.#d = deps;
  }

  #row(sessionId: string): ConversationRow | undefined {
    return this.#d.db.prepare("SELECT * FROM conversations WHERE session_id = ?").get(sessionId) as ConversationRow | undefined;
  }

  #toConversation(row: ConversationRow): Conversation {
    return {
      sessionId: row.session_id,
      directory: row.directory,
      project: projectOf(row.directory, this.#d.opencodeWorkspaceDir),
      title: row.title,
      titleManual: row.title_manual === 1,
      category: row.category,
      tags: parseJson<string[]>(row.tags, []),
      summary: row.summary,
      classifiedBy: row.classified_by,
      confidence: row.confidence,
      classifiedAt: row.classified_at,
      promptsAtClassification: row.prompts_at_classification,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      promptCount: row.prompt_count,
      messageCount: row.message_count,
      cost: row.cost,
      models: parseJson<string[]>(row.models, []),
      tools: parseJson<Record<string, number>>(row.tools, {}),
      files: parseJson<string[]>(row.files, []),
      additions: row.additions,
      deletions: row.deletions,
      archivePath: row.archive_path,
      pinned: row.pinned === 1,
      deletedInOpencode: row.deleted_in_opencode === 1,
      ...(row.snippet !== undefined ? { snippet: row.snippet } : {}),
    };
  }

  get(sessionId: string): Conversation | null {
    const row = this.#row(sessionId);
    return row ? this.#toConversation(row) : null;
  }

  transcript(sessionId: string): string {
    const row = this.#d.db.prepare("SELECT transcript FROM conversations_fts WHERE session_id = ?").get(sessionId) as
      | { transcript: string }
      | undefined;
    return row?.transcript ?? "";
  }

  categories(): Category[] {
    return this.#d.settings.get().classifier.categories;
  }

  /** Relit la session dans opencode, met à jour l'archive (et la classe par heuristique la première fois). */
  async refresh(sessionId: string): Promise<{ conversation: Conversation; digest: ConversationDigest } | null> {
    const known = this.#d.sessions.get(sessionId);
    const directory = known?.directory || undefined;
    let info: OcSession;
    let messages: OcMessageWithParts[];
    try {
      info = await this.#d.client.request<OcSession>("GET", `/session/${encodeURIComponent(sessionId)}`, {
        ...(directory ? { directory } : {}),
        timeoutMs: 15_000,
      });
      messages = await this.#d.client.request<OcMessageWithParts[]>("GET", `/session/${encodeURIComponent(sessionId)}/message`, {
        directory: info.directory,
        timeoutMs: 60_000,
      });
    } catch (err) {
      if (err instanceof OpencodeError && err.status === 404) {
        this.markDeletedInOpencode(sessionId);
        return null;
      }
      throw err;
    }
    if (info.parentID) return null;

    const digest = buildDigest(info, messages, this.#d.opencodeWorkspaceDir);
    if (digest.promptCount === 0) return null;
    const cost = this.#d.ledger.sessionUsage(sessionId).cost;
    const existing = this.#row(sessionId);
    const now = Date.now();

    if (!existing) {
      const h = classifyHeuristic(digest, this.categories());
      this.#d.db
        .prepare(
          `INSERT INTO conversations (session_id, directory, title, category, tags, summary, classified_by, confidence, classified_at,
             prompts_at_classification, created_at, updated_at, prompt_count, message_count, cost, models, tools, files, additions, deletions)
           VALUES (:session_id, :directory, :title, :category, :tags, :summary, 'heuristic', :confidence, :classified_at,
             :prompt_count, :created_at, :updated_at, :prompt_count, :message_count, :cost, :models, :tools, :files, :additions, :deletions)`,
        )
        .run(
          params({
            session_id: sessionId,
            directory: info.directory,
            title: info.title,
            category: h.category,
            tags: JSON.stringify(h.tags),
            summary: h.summary,
            confidence: h.confidence,
            classified_at: now,
            prompt_count: digest.promptCount,
            created_at: info.time.created,
            updated_at: info.time.updated,
            message_count: digest.messageCount,
            cost,
            models: JSON.stringify(digest.models),
            tools: JSON.stringify(digest.tools),
            files: JSON.stringify(digest.files),
            additions: digest.additions,
            deletions: digest.deletions,
          }),
        );
    } else {
      this.#d.db
        .prepare(
          `UPDATE conversations SET directory = :directory, title = CASE WHEN title_manual = 1 THEN title ELSE :title END,
             updated_at = :updated_at, prompt_count = :prompt_count, message_count = :message_count, cost = :cost, models = :models,
             tools = :tools, files = :files, additions = :additions, deletions = :deletions, deleted_in_opencode = 0
           WHERE session_id = :session_id`,
        )
        .run(
          params({
            session_id: sessionId,
            directory: info.directory,
            title: isDefaultTitle(info.title) && !isDefaultTitle(existing.title) ? existing.title : info.title,
            updated_at: info.time.updated,
            prompt_count: digest.promptCount,
            message_count: digest.messageCount,
            cost,
            models: JSON.stringify(digest.models),
            tools: JSON.stringify(digest.tools),
            files: JSON.stringify(digest.files),
            additions: digest.additions,
            deletions: digest.deletions,
          }),
        );
    }
    this.#index(sessionId, digest.transcript);
    await this.#writeMarkdown(sessionId);
    return { conversation: this.get(sessionId) as Conversation, digest };
  }

  #index(sessionId: string, transcript?: string): void {
    const row = this.#row(sessionId);
    if (!row) return;
    const text = transcript ?? this.transcript(sessionId);
    this.#d.db.prepare("DELETE FROM conversations_fts WHERE session_id = ?").run(sessionId);
    this.#d.db
      .prepare("INSERT INTO conversations_fts (session_id, title, summary, tags, transcript) VALUES (?, ?, ?, ?, ?)")
      .run(sessionId, row.title, row.summary, parseJson<string[]>(row.tags, []).join(" "), text);
  }

  applyClassification(sessionId: string, result: ClassificationResult): Conversation | null {
    const row = this.#row(sessionId);
    if (!row) return null;
    const known = new Set(this.categories().map((c) => c.id));
    const category = known.has(result.category) ? result.category : "other";
    this.#d.db
      .prepare(
        `UPDATE conversations SET category = ?, tags = ?, summary = ?, classified_by = ?, confidence = ?, classified_at = ?,
           prompts_at_classification = prompt_count WHERE session_id = ?`,
      )
      .run(category, JSON.stringify(result.tags.slice(0, 8)), result.summary.slice(0, 600), result.by, result.confidence, Date.now(), sessionId);
    if (result.title && row.title_manual === 0 && isDefaultTitle(row.title)) {
      this.#d.db.prepare("UPDATE conversations SET title = ? WHERE session_id = ?").run(result.title, sessionId);
    }
    this.#index(sessionId);
    void this.#writeMarkdown(sessionId).catch((err: Error) =>
      this.#d.log.warn("export Markdown impossible", { sessionId, error: err.message }),
    );
    return this.get(sessionId);
  }

  async update(
    sessionId: string,
    patch: { category?: string; tags?: string[]; title?: string; summary?: string; pinned?: boolean },
  ): Promise<Conversation | null> {
    const row = this.#row(sessionId);
    if (!row) return null;
    const known = new Set(this.categories().map((c) => c.id));
    if (patch.category !== undefined && !known.has(patch.category)) throw new RangeError("Catégorie inconnue.");
    const next = {
      category: patch.category ?? row.category,
      tags: patch.tags ? JSON.stringify(patch.tags) : row.tags,
      title: patch.title ?? row.title,
      title_manual: patch.title !== undefined ? 1 : row.title_manual,
      summary: patch.summary ?? row.summary,
      pinned: patch.pinned === undefined ? row.pinned : patch.pinned ? 1 : 0,
      classified_by: patch.category !== undefined || patch.tags !== undefined ? "manual" : row.classified_by,
    };
    this.#d.db
      .prepare(
        `UPDATE conversations SET category = :category, tags = :tags, title = :title, title_manual = :title_manual, summary = :summary,
           pinned = :pinned, classified_by = :classified_by WHERE session_id = :session_id`,
      )
      .run(params({ ...next, session_id: sessionId }));
    this.#index(sessionId);
    await this.#writeMarkdown(sessionId);
    return this.get(sessionId);
  }

  /** Reprend le titre définitif d'opencode si l'utilisateur ne l'a pas modifié. Renvoie true si l'archive a changé. */
  async syncTitle(sessionId: string, title: string): Promise<boolean> {
    const row = this.#row(sessionId);
    if (!row || row.title_manual === 1 || isDefaultTitle(title) || row.title === title) return false;
    this.#d.db.prepare("UPDATE conversations SET title = ? WHERE session_id = ?").run(title, sessionId);
    this.#index(sessionId);
    await this.#writeMarkdown(sessionId);
    return true;
  }

  markDeletedInOpencode(sessionId: string): void {
    this.#d.db.prepare("UPDATE conversations SET deleted_in_opencode = 1 WHERE session_id = ?").run(sessionId);
  }

  async remove(sessionId: string): Promise<boolean> {
    const row = this.#row(sessionId);
    if (!row) return false;
    if (row.archive_path) await this.#removeFile(row.archive_path);
    this.#d.db.prepare("DELETE FROM conversations_fts WHERE session_id = ?").run(sessionId);
    this.#d.db.prepare("DELETE FROM conversations WHERE session_id = ?").run(sessionId);
    return true;
  }

  list(query: ArchiveQuery): { items: Conversation[]; total: number } {
    const where: string[] = [];
    const values: Record<string, string | number> = {};
    if (query.category) {
      where.push("c.category = :category");
      values.category = query.category;
    }
    if (query.from !== undefined) {
      where.push("c.updated_at >= :from");
      values.from = query.from;
    }
    if (query.to !== undefined) {
      where.push("c.updated_at < :to");
      values.to = query.to;
    }
    if (query.pinned) where.push("c.pinned = 1");
    const fts = query.q ? ftsQuery(query.q) : null;
    let rows: ConversationRow[];
    if (fts) {
      values.q = fts;
      values.snip_open = SNIPPET_OPEN;
      values.snip_close = SNIPPET_CLOSE;
      const filter = where.length ? `AND ${where.join(" AND ")}` : "";
      rows = this.#d.db
        .prepare(
          `SELECT c.*, snippet(conversations_fts, 4, :snip_open, :snip_close, '…', 16) AS snippet
           FROM conversations_fts JOIN conversations c ON c.session_id = conversations_fts.session_id
           WHERE conversations_fts MATCH :q ${filter}
           ORDER BY c.pinned DESC, bm25(conversations_fts, 0, 8, 4, 4, 1) LIMIT 500`,
        )
        .all(values) as unknown as ConversationRow[];
    } else {
      rows = this.#d.db
        .prepare(
          `SELECT c.* FROM conversations c ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
           ORDER BY c.pinned DESC, c.updated_at DESC LIMIT 2000`,
        )
        .all(values) as unknown as ConversationRow[];
    }
    let items = rows.map((r) => this.#toConversation(r));
    if (query.project) items = items.filter((c) => c.project === query.project);
    return { items: items.slice(query.offset, query.offset + query.limit), total: items.length };
  }

  stats(): Array<{ category: string; conversations: number; cost: number; lastAt: number | null }> {
    return this.#d.db
      .prepare(
        "SELECT category, COUNT(*) AS conversations, COALESCE(SUM(cost), 0) AS cost, MAX(updated_at) AS lastAt FROM conversations GROUP BY category",
      )
      .all() as Array<{ category: string; conversations: number; cost: number; lastAt: number | null }>;
  }

  projects(): string[] {
    const rows = this.#d.db.prepare("SELECT DISTINCT directory FROM conversations").all() as Array<{ directory: string }>;
    return [...new Set(rows.map((r) => projectOf(r.directory, this.#d.opencodeWorkspaceDir)))].sort();
  }

  markdown(sessionId: string): string | null {
    const conv = this.get(sessionId);
    if (!conv) return null;
    const category = this.categories().find((c) => c.id === conv.category);
    const header = stringify(
      {
        titre: conv.title,
        categorie: category ? category.label : conv.category,
        tags: conv.tags,
        projet: conv.project,
        session: conv.sessionId,
        creee: new Date(conv.createdAt).toISOString(),
        modifiee: new Date(conv.updatedAt).toISOString(),
        prompts: conv.promptCount,
        cout_usd: Math.round(conv.cost * 10_000) / 10_000,
        modeles: conv.models,
        classement: conv.classifiedBy,
      },
      { lineWidth: 0 },
    );
    const toolSummary = Object.entries(conv.tools)
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => `${name} ×${n}`)
      .join(", ");
    return [
      "---",
      header.trimEnd(),
      "---",
      "",
      `# ${category?.emoji ?? ""} ${conv.title}`.replace("#  ", "# "),
      "",
      conv.summary ? `> ${conv.summary.replace(/\n/g, "\n> ")}` : "",
      "",
      conv.files.length > 0 ? `**Fichiers modifiés** : ${conv.files.map((f) => `\`${f}\``).join(", ")}` : "",
      toolSummary ? `**Outils** : ${toolSummary}` : "",
      "",
      "---",
      "",
      this.transcript(sessionId),
    ]
      .filter((line, i, all) => !(line === "" && all[i - 1] === ""))
      .join("\n");
  }

  async #writeMarkdown(sessionId: string): Promise<void> {
    const conv = this.get(sessionId);
    const content = this.markdown(sessionId);
    if (!conv || content === null) return;
    const category = this.categories().find((c) => c.id === conv.category);
    const created = new Date(conv.createdAt).toISOString();
    const relative = path.join(
      safeSegment(category?.label ?? conv.category, 40),
      created.slice(0, 7),
      `${created.slice(0, 10)}_${slugify(conv.title, 50)}_${conv.sessionId.slice(-8)}.md`,
    );
    const target = await assertInside(this.#d.archiveDir, path.join(this.#d.archiveDir, relative));
    await writeFileAtomic(target, content);
    const previous = this.#row(sessionId)?.archive_path;
    if (previous && previous !== relative) await this.#removeFile(previous);
    this.#d.db.prepare("UPDATE conversations SET archive_path = ? WHERE session_id = ?").run(relative, sessionId);
  }

  async #removeFile(relative: string): Promise<void> {
    try {
      const target = await assertInside(this.#d.archiveDir, path.join(this.#d.archiveDir, relative));
      await fs.rm(target, { force: true });
    } catch (err) {
      this.#d.log.warn("suppression d'export impossible", { relative, error: (err as Error).message });
    }
  }
}
