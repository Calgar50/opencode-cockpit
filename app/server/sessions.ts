// Suivi local des sessions opencode : parenté (sous-agents) et session racine.
// 1.1, Salle OMO (L18a) : une session appartient à UNE instance (colonne `instance`, migration 5). L'instance est posée à
// l'insertion et jamais réécrite ; un identifiant déjà suivi par l'autre instance est REFUSÉ, journalisé et annoncé
// (onInstanceConflict, lu par les détections de la salle). Chaque instance interroge opencode avec SON client (useClient).
import type { DatabaseSync } from "node:sqlite";
import { params } from "./db.ts";
import { errorMessage, type Logger } from "./log.ts";
import type { OcSession, OpencodeClient } from "./opencode.ts";
import type { SessionInstance } from "./shared/activity-types.ts";
import { CLASSIFIER_TITLE } from "./shared/session-purpose.ts";

/** chat : conversations ; classifier : classement ; equipe / controle (1.1) : étapes d'équipe et contrôles de sécurité. */
export type SessionPurpose = "chat" | "classifier" | "equipe" | "controle";

/**
 * Bornes de l'arbre d'une conversation : mêmes valeurs que le nettoyage après un arrêt de la 1.0 (CLEANUP_MAX_DEPTH et
 * CLEANUP_MAX_SESSIONS de http.ts, trackedDescendants). Les lignes lues sont bornées à `limit` × 10.
 */
export const TREE_MAX_DEPTH = 8;
export const TREE_MAX_SESSIONS = 200;
/** Borne haute du paramètre `limit` de descendants() : au plus 100 000 lignes lues. */
const TREE_LIMIT_CEILING = 10_000;
/** Empreinte d'un plancher vérifié (SHA-256 en hexadécimal, éventuellement préfixée de son genre) : courte, sans espace. */
const PLANCHER_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export interface SessionRow {
  id: string;
  parent_id: string | null;
  root_id: string;
  directory: string;
  project_id: string | null;
  title: string;
  purpose: SessionPurpose;
  /** 1.1 : agent de la session tel qu'opencode le rapporte (null s'il ne l'a pas fourni). */
  agent: string | null;
  /** 1.1 : plancher de règles de session posé et vérifié par le cockpit (empreinte), null sinon. */
  plancher: string | null;
  /** 1.1 (migration 5) : instance opencode qui sert la session ; « principale » hors de la Salle OMO. */
  instance: SessionInstance;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

/** Usages dont une session enfant hérite et qu'une mise à jour ne remplace jamais. */
const STICKY_PURPOSES: readonly SessionPurpose[] = ["classifier", "equipe", "controle"];

/**
 * Conflit d'identifiant entre instances (1.1, P11) : une session déjà suivie par une instance a été présentée par l'autre.
 * Rien n'est écrit ; le conflit est annoncé aux abonnés (détections de la Salle OMO, §4.14.5).
 */
export interface SessionInstanceConflict {
  sessionId: string;
  /** Instance enregistrée à l'insertion, gardée. */
  enregistree: SessionInstance;
  /** Instance dont l'écriture est refusée. */
  refusee: SessionInstance;
}

export interface SessionTrackerOptions {
  /** Journal du refus d'un conflit d'instance ; absent : rien n'est journalisé (tests d'unité). */
  log?: Pick<Logger, "warn">;
}

/**
 * Usage propre d'une session (sans l'héritage du parent). Le titre ne vaut que s'il est exactement CLASSIFIER_TITLE, pour une
 * racine, et quand `byTitle` est vrai (session encore inconnue, voir upsert) : les sessions de classement sont des racines créées
 * par le serveur (classifier.ts), alors que le titre d'une conversation est écrit par l'IA de titre d'opencode d'après le premier
 * message (session/prompt.ts, ensureTitle) et celui d'un enfant de délégation reprend la description écrite par l'IA
 * (tool/task.ts:160). Aucun préfixe n'est donc lu, et un enfant n'est jamais classé par son seul titre.
 */
export function purposeOf(info: Pick<OcSession, "title" | "metadata">, parentId: string | null | undefined, byTitle = true): SessionPurpose {
  const cockpit = info.metadata?.cockpit;
  if (cockpit === "classifier" || (byTitle && !parentId && info.title === CLASSIFIER_TITLE)) return "classifier";
  // metadata.cockpit n'est posé que par le serveur du cockpit : le proxy le refuse dans les créations de session.
  if (cockpit === "equipe" || cockpit === "controle") return cockpit;
  return "chat";
}

export class SessionTracker {
  readonly #db: DatabaseSync;
  /** Client par instance ; celui du constructeur sert toute instance dont aucun client propre n'a été posé (1.0.x). */
  readonly #clients = new Map<SessionInstance, OpencodeClient>();
  readonly #log: Pick<Logger, "warn"> | undefined;
  readonly #conflicts = new Set<(conflit: SessionInstanceConflict) => void>();

  constructor(db: DatabaseSync, client: OpencodeClient, options: SessionTrackerOptions = {}) {
    this.#db = db;
    this.#clients.set("principale", client);
    this.#log = options.log;
  }

  /**
   * Pose le client d'une instance. `instance-runtime.ts` (L18a) pose celui de la Salle OMO au moment où l'instance est
   * construite : une session de la salle n'est alors JAMAIS demandée à l'instance principale, et inversement.
   */
  useClient(instance: SessionInstance, client: OpencodeClient): void {
    this.#clients.set(instance, client);
  }

  /** Client d'une instance ; repli sur celui de l'instance principale tant qu'aucun client propre n'a été posé. */
  #clientOf(instance: SessionInstance): OpencodeClient {
    return this.#clients.get(instance) ?? (this.#clients.get("principale") as OpencodeClient);
  }

  /**
   * S'abonne aux conflits d'identifiant entre instances (L23c). Rend le désabonnement. Un abonné qui lève n'empêche pas les
   * autres d'être appelés.
   */
  onInstanceConflict(listener: (conflit: SessionInstanceConflict) => void): () => void {
    this.#conflicts.add(listener);
    return () => {
      this.#conflicts.delete(listener);
    };
  }

  #refuseConflit(conflit: SessionInstanceConflict): void {
    this.#log?.warn("session refusée : identifiant déjà suivi par l'autre instance", { ...conflit });
    for (const listener of this.#conflicts) {
      try {
        listener({ ...conflit });
      } catch (err) {
        this.#log?.warn("conflit d'instance : abonné en échec", { sessionId: conflit.sessionId, error: errorMessage(err) });
      }
    }
  }

  get(id: string): SessionRow | undefined {
    return this.#db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  }

  /** Instance d'une session suivie ; null si le cockpit ne la suit pas (routage par instance, P11). */
  instanceOf(id: string): SessionInstance | null {
    const row = this.#db.prepare("SELECT instance FROM sessions WHERE id = ?").get(id) as { instance: SessionInstance } | undefined;
    return row?.instance ?? null;
  }

  isHidden(id: string | undefined): boolean {
    if (!id) return false;
    const row = this.get(id);
    if (!row) return false;
    if (row.purpose === "classifier") return true;
    return row.root_id !== row.id && this.get(row.root_id)?.purpose === "classifier";
  }

  /**
   * Enregistre ou met à jour une session. `opts.instance` n'est écrite qu'à l'INSERTION : l'instance d'une session déjà connue
   * n'est jamais changée par un second upsert, quel que soit l'appelant (une session ne change pas d'opencode). Sans option :
   * « principale », exactement comme en 1.0.x (valeur d'office de la colonne, migration 5).
   *
   * 1.1 (L18a) : quand `opts.instance` est donnée et qu'elle n'est pas celle de la session déjà suivie, RIEN n'est écrit — pas
   * même le titre ou la parenté — le refus est journalisé et annoncé (onInstanceConflict) ; la ligne enregistrée est rendue
   * telle quelle. Un événement de la salle ne touche donc jamais une racine de l'instance principale, même à identifiant égal.
   */
  upsert(info: OcSession, forcedPurpose?: SessionPurpose, opts?: { instance?: SessionInstance }): SessionRow {
    const parent = info.parentID ? this.get(info.parentID) : undefined;
    const rootId = info.parentID ? (parent?.root_id ?? info.parentID) : info.id;
    const inherited = parent && STICKY_PURPOSES.includes(parent.purpose) ? parent.purpose : null;
    const previous = this.get(info.id);
    const demandee = opts?.instance;
    if (previous && demandee !== undefined && previous.instance !== demandee) {
      this.#refuseConflit({ sessionId: info.id, enregistree: previous.instance, refusee: demandee });
      return previous;
    }
    // Session déjà suivie : jamais reclassée par son titre, que l'IA de titre d'opencode peut réécrire (P12). Seuls l'usage forcé
    // par le serveur (classifier.ts, control-ai.ts), metadata.cockpit et l'héritage la font changer d'usage.
    const purpose = forcedPurpose ?? inherited ?? purposeOf(info, info.parentID, previous === undefined);
    this.#db
      .prepare(
        // `instance` est absente du DO UPDATE SET : posée à l'insertion, jamais réécrite ensuite.
        `INSERT INTO sessions (id, parent_id, root_id, directory, project_id, title, purpose, agent, instance, created_at, updated_at)
         VALUES (:id, :parent_id, :root_id, :directory, :project_id, :title, :purpose, :agent, :instance, :created_at, :updated_at)
         ON CONFLICT(id) DO UPDATE SET
           parent_id = excluded.parent_id, root_id = excluded.root_id, directory = excluded.directory,
           project_id = excluded.project_id, title = excluded.title,
           purpose = CASE WHEN sessions.purpose IN ('classifier', 'equipe', 'controle') THEN sessions.purpose ELSE excluded.purpose END,
           agent = COALESCE(excluded.agent, sessions.agent),
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
          agent: typeof info.agent === "string" && info.agent ? info.agent : null,
          instance: opts?.instance ?? "principale",
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

  /** Racine enregistrée d'une session ; null si le cockpit ne la suit pas. */
  rootOf(id: string): string | null {
    const row = this.#db.prepare("SELECT root_id FROM sessions WHERE id = ?").get(id) as { root_id: string } | undefined;
    return row?.root_id ?? null;
  }

  /**
   * Descendants suivis d'une session (racine ou session de l'arbre), dans l'ordre de parcours en largeur : arbre unique d'une
   * conversation. Même requête et mêmes bornes que trackedDescendants de la 1.0 : lignes de la racine lues par root_id indexé
   * (au plus `limit` × 10), profondeur TREE_MAX_DEPTH, au plus `limit` sessions en comptant celle de départ (absente du résultat).
   * Session inconnue : lue comme sa propre racine.
   */
  descendants(id: string, limit: number = TREE_MAX_SESSIONS): string[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > TREE_LIMIT_CEILING) throw new RangeError("borne de l'arbre invalide");
    const childrenOf = this.#childrenByParent(this.rootOf(id) ?? id, limit * 10);
    const tree = new Set([id]);
    let frontier = [id];
    for (let depth = 0; depth < TREE_MAX_DEPTH && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const parent of frontier) {
        for (const child of childrenOf.get(parent) ?? []) {
          if (tree.has(child) || tree.size >= limit) continue;
          tree.add(child);
          next.push(child);
        }
      }
      frontier = next;
    }
    return [...tree].slice(1);
  }

  /** Enfants suivis par parent, lus sous une racine (index idx_sessions_root), au plus `maxRows` lignes. */
  #childrenByParent(rootId: string, maxRows: number): Map<string, string[]> {
    const rows = this.#db
      .prepare("SELECT id, parent_id FROM sessions WHERE root_id = ? AND parent_id IS NOT NULL LIMIT ?")
      .all(rootId, maxRows) as Array<{ id: string; parent_id: string }>;
    const childrenOf = new Map<string, string[]>();
    for (const row of rows) {
      const list = childrenOf.get(row.parent_id);
      if (list) list.push(row.id);
      else childrenOf.set(row.parent_id, [row.id]);
    }
    return childrenOf;
  }

  /**
   * Pose l'empreinte du plancher vérifié d'une session, ou la retire (null). Écrit par le serveur seul, après vérification de
   * l'écho d'opencode. false si la session n'est pas suivie.
   */
  setPlancher(id: string, hash: string | null): boolean {
    if (hash !== null && !PLANCHER_RE.test(hash)) throw new RangeError("empreinte de plancher invalide");
    return Number(this.#db.prepare("UPDATE sessions SET plancher = ? WHERE id = ?").run(hash, id).changes) > 0;
  }

  /**
   * Garantit que la session (et sa lignée) est connue, quitte à interroger opencode. `instance` sert à l'insertion des sessions
   * découvertes ici et se transmet à la lignée ; sans elle, « principale », exactement comme en 1.0.x. `depth` garde sa place et
   * son rôle (garde-fou de la remontée des parents).
   *
   * 1.1 (L18a) : la recherche passe par le client de `instance` (useClient) — l'usage d'une session de la salle est donc relevé
   * sur le serveur de la salle. Une session déjà suivie par l'AUTRE instance est rendue telle quelle, sans aucune requête :
   * aucune lecture ni écriture croisée.
   */
  async ensure(id: string, directory?: string, depth = 0, instance: SessionInstance = "principale"): Promise<SessionRow | undefined> {
    const known = this.get(id);
    if (known && known.instance !== instance) return known;
    if (known && (known.parent_id === null || this.get(known.parent_id))) return known;
    if (depth > 8) return known;
    let info: OcSession;
    try {
      info = await this.#clientOf(instance).request<OcSession>("GET", `/session/${encodeURIComponent(id)}`, {
        ...(directory ? { directory } : {}),
        timeoutMs: 10_000,
      });
    } catch {
      return known;
    }
    if (info.parentID && !this.get(info.parentID)) await this.ensure(info.parentID, info.directory, depth + 1, instance);
    return this.upsert(info, undefined, { instance });
  }
}
