// Portillon des accords (spécification 1.1 §3.8, P9) : vérification avant de relayer une réponse d'autorisation, file commune
// aux réponses et aux arrêts, nettoyage des demandes restées en attente après un arrêt. Extrait de createApp (http.ts) à
// comportement constant (L1a) : une seule instance, empruntée par le proxy puis par toute réponse envoyée par le serveur.
// Registre des réponses émises : chaque réponse (« once » ou « reject ») est inscrite AVANT son envoi à opencode.
// relayOnce et rejectWhenAlone arrivent avec L1b.
import type { EmittedReply, OnceVerdict, PendingPermission, PermissionGate, PermissionGateDeps, PermissionTool } from "./contracts-11.ts";
import { errorMessage } from "./log.ts";
import { OpencodeError } from "./opencode.ts";
import { ID_RE } from "./shared/ids.ts";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Borne du registre des réponses émises : les plus anciennes sortent en premier. */
export const EMITTED_MAX = 2_000;

/** Registre borné des réponses émises, par identifiant de demande (la dernière inscription l'emporte). */
export function emittedRegistry(max = EMITTED_MAX): PermissionGate["emitted"] & { entries(): EmittedReply[] } {
  const entries = new Map<string, EmittedReply>();
  return {
    record(entry) {
      entries.delete(entry.requestId);
      entries.set(entry.requestId, { ...entry });
      while (entries.size > max) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    has: (requestId) => entries.has(requestId),
    entries: () => [...entries.values()].map((entry) => ({ ...entry })),
  };
}

/** Portillon des accords : proxy, puis autonomie et garde des délégations (P9). */
export function createPermissionGate(deps: PermissionGateDeps): PermissionGate {
  const { client, log } = deps;
  const emitted = emittedRegistry();

  const PERMISSION_LOOKUP_TIMEOUT_MS = 5_000;
  /** Bornes du nettoyage après un arrêt : profondeur de sous-agents, sessions suivies, appels à opencode, refus envoyés. */
  const CLEANUP_MAX_DEPTH = 8;
  const CLEANUP_MAX_SESSIONS = 200;
  const CLEANUP_MAX_CHILDREN_CALLS = 50;
  const CLEANUP_MAX_REJECTS = 100;
  const CALL_ID_MAX_LENGTH = 512;

  const permissionTool = (value: unknown): PendingPermission["tool"] => {
    if (value === undefined || value === null) return null;
    if (!isRecord(value)) return "invalid";
    const { messageID, callID } = value;
    return typeof messageID === "string" && ID_RE.test(messageID) && typeof callID === "string" && callID.length > 0 && callID.length <= CALL_ID_MAX_LENGTH
      ? { messageID, callID }
      : "invalid";
  };

  /** Demandes en attente (GET /permission, même dossier) ; erreur si opencode ne répond pas ou répond autre chose qu'une liste. */
  const pendingPermissions = async (directory: string | null): Promise<PendingPermission[]> => {
    const list = await client.request<unknown>("GET", "/permission", { query: { directory }, timeoutMs: PERMISSION_LOOKUP_TIMEOUT_MS });
    if (!Array.isArray(list)) throw new Error("liste des demandes d'autorisation illisible");
    return list.flatMap((item) =>
      isRecord(item) && typeof item.id === "string" && typeof item.sessionID === "string"
        ? [{ id: item.id, sessionID: item.sessionID, tool: permissionTool(item.tool) }]
        : [],
    );
  };

  /** Conversations qui travaillent (busy ou retry) : GET /session/status ne liste que les sessions qui ne sont pas au repos. */
  const workingSessions = async (directory: string | null): Promise<Set<string>> => {
    const statuses = await client.request<unknown>("GET", "/session/status", { query: { directory }, timeoutMs: PERMISSION_LOOKUP_TIMEOUT_MS });
    if (!isRecord(statuses)) throw new Error("états des conversations illisibles");
    return new Set(Object.entries(statuses).filter(([, s]) => isRecord(s) && (s.type === "busy" || s.type === "retry")).map(([id]) => id));
  };

  /**
   * L'appel d'outil qui a posé la demande est-il encore en cours ? Son message (GET /session/:id/message/:messageID) ne porte
   * pas d'erreur et sa partie « tool » (même callID) est « running ». Après un arrêt, opencode 1.18.30 passe cette partie en
   * « error » (« Tool execution aborted », metadata.interrupted, processor.ts:591-605) mais garde la demande en attente
   * jusqu'à une réponse ou un redémarrage, même quand un nouveau message fait retravailler la conversation.
   * Message introuvable (404) : false. opencode injoignable ou réponse illisible : erreur.
   */
  const toolCallRunning = async (sessionID: string, tool: PermissionTool, directory: string | null): Promise<boolean> => {
    if (!ID_RE.test(sessionID)) throw new Error("identifiant de conversation de la demande illisible");
    let message: unknown;
    try {
      message = await client.request<unknown>("GET", `/session/${encodeURIComponent(sessionID)}/message/${encodeURIComponent(tool.messageID)}`, {
        query: { directory },
        timeoutMs: PERMISSION_LOOKUP_TIMEOUT_MS,
      });
    } catch (err) {
      if (err instanceof OpencodeError && err.status === 404) return false;
      throw err;
    }
    if (!isRecord(message) || !isRecord(message.info) || !Array.isArray(message.parts)) throw new Error("message de la demande illisible");
    if (message.info.error !== undefined && message.info.error !== null) return false;
    const part = message.parts.find((p) => isRecord(p) && p.type === "tool" && p.callID === tool.callID);
    return isRecord(part) && isRecord(part.state) && part.state.status === "running";
  };

  /**
   * File d'attente commune au « once » (vérification puis relais) et à l'arrêt (relais puis liste des demandes du nettoyage).
   * Sans elle, un arrêt relayé entre la vérification et le relais d'un « once » laisserait ce « once » arriver après
   * l'arrêt (sous-agent détaché, facturé, résultat perdu), et le nettoyage ne le verrait pas.
   */
  let replyGateTail: Promise<void> = Promise.resolve();
  const REPLY_GATE_MAX_HOLD_MS = 30_000;
  /** Attend son tour ; renvoie la fonction qui libère la place (sans effet au second appel). */
  const acquireReplyGate = async (): Promise<() => void> => {
    const previous = replyGateTail;
    let resolveTail: () => void = () => undefined;
    replyGateTail = new Promise<void>((resolve) => {
      resolveTail = () => resolve();
    });
    await previous;
    // Borne : un relais qu'opencode laisse sans réponse ne bloque pas indéfiniment les réponses et les arrêts suivants.
    const timer = setTimeout(() => {
      log.warn("file d'attente des réponses libérée : relais sans réponse d'opencode", { holdMs: REPLY_GATE_MAX_HOLD_MS });
      resolveTail();
    }, REPLY_GATE_MAX_HOLD_MS);
    timer.unref();
    return () => {
      clearTimeout(timer);
      resolveTail();
    };
  };

  /**
   * « once » n'est relayé que si la demande est encore en attente, que sa conversation travaille ET que l'appel d'outil qui
   * l'a posée est toujours en cours. Après un arrêt, un « once » tardif a lancé un sous-agent détaché, facturé, dont le
   * résultat a été perdu (la conversation ne reprend pas). `orphan` : demande d'une conversation au repos, à refuser pour
   * qu'elle ne revienne pas. Vérification impossible : 503, rien n'est relayé. Ne lève jamais.
   */
  const checkOnceReply = async (requestId: string, directory: string | null): Promise<OnceVerdict> => {
    try {
      const [pending, working] = await Promise.all([pendingPermissions(directory), workingSessions(directory)]);
      const request = pending.find((p) => p.id === requestId) ?? null;
      if (request === null) return { ok: false, status: 409, request, orphan: false };
      if (!working.has(request.sessionID)) return { ok: false, status: 409, request, orphan: true };
      if (request.tool === null) return { ok: true };
      if (request.tool === "invalid") throw new Error("appel d'outil de la demande illisible");
      // Conversation qui retravaille (nouveau message) : la demande doit venir d'un appel encore en cours.
      if (await toolCallRunning(request.sessionID, request.tool, directory)) return { ok: true };
      return { ok: false, status: 409, request, orphan: false };
    } catch (err) {
      log.warn("demande d'autorisation non vérifiable : réponse non relayée", { requestId, error: errorMessage(err) });
      return { ok: false, status: 503, request: null, orphan: false };
    }
  };

  /**
   * « Refuser » d'une demande orpheline (appel d'outil qui n'est plus en cours) alors que sa conversation retravaille :
   * opencode refuserait aussi toutes les demandes en attente de cette conversation (permission/index.ts:129-138), donc celles
   * de la réponse en cours, qui échouerait sans explication. Vérification impossible : false (le refus n'autorise rien).
   */
  const isOrphanOfWorkingSession = async (requestId: string, directory: string | null): Promise<boolean> => {
    try {
      const [pending, working] = await Promise.all([pendingPermissions(directory), workingSessions(directory)]);
      const request = pending.find((p) => p.id === requestId);
      if (!request || !working.has(request.sessionID) || request.tool === null || request.tool === "invalid") return false;
      return !(await toolCallRunning(request.sessionID, request.tool, directory));
    } catch (err) {
      log.warn("refus relayé sans vérification : opencode ne répond pas", { requestId, error: errorMessage(err) });
      return false;
    }
  };

  /** Descendants d'une conversation d'après le suivi du cockpit (table sessions, lue par root_id indexé), bornés. */
  const trackedDescendants = (sessionId: string, tree: Set<string>): void => {
    const known = deps.db.prepare("SELECT root_id FROM sessions WHERE id = ?").get(sessionId) as { root_id: string } | undefined;
    const rows = deps.db
      .prepare("SELECT id, parent_id FROM sessions WHERE root_id = ? AND parent_id IS NOT NULL LIMIT ?")
      .all(known?.root_id ?? sessionId, CLEANUP_MAX_SESSIONS * 10) as Array<{ id: string; parent_id: string }>;
    const childrenOf = new Map<string, string[]>();
    for (const row of rows) {
      const list = childrenOf.get(row.parent_id);
      if (list) list.push(row.id);
      else childrenOf.set(row.parent_id, [row.id]);
    }
    let frontier = [sessionId];
    for (let depth = 0; depth < CLEANUP_MAX_DEPTH && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const child of childrenOf.get(id) ?? []) {
          if (tree.has(child) || tree.size >= CLEANUP_MAX_SESSIONS) continue;
          tree.add(child);
          next.push(child);
        }
      }
      frontier = next;
    }
  };

  /** Complète avec GET /session/:id/children (sous-agent pas encore enregistré par le cockpit), borné. */
  const opencodeDescendants = async (sessionId: string, directory: string | null, tree: Set<string>): Promise<void> => {
    const visited = new Set<string>();
    let frontier = [sessionId];
    let calls = 0;
    for (let depth = 0; depth < CLEANUP_MAX_DEPTH && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        if (visited.has(id)) continue;
        if (calls >= CLEANUP_MAX_CHILDREN_CALLS || tree.size >= CLEANUP_MAX_SESSIONS) return;
        visited.add(id);
        calls++;
        let children: unknown;
        try {
          children = await client.request<unknown>("GET", `/session/${encodeURIComponent(id)}/children`, {
            query: { directory },
            timeoutMs: PERMISSION_LOOKUP_TIMEOUT_MS,
          });
        } catch (err) {
          log.warn("arrêt : sous-agents d'une conversation illisibles", { sessionId: id, error: errorMessage(err) });
          continue;
        }
        if (!Array.isArray(children)) continue;
        for (const child of children) {
          const childId = isRecord(child) && typeof child.id === "string" && ID_RE.test(child.id) ? child.id : null;
          if (childId === null || visited.has(childId)) continue;
          tree.add(childId);
          next.push(childId);
        }
      }
      frontier = next;
    }
  };

  /**
   * Refuse (« reject ») des demandes orphelines. opencode 1.18.30 applique un refus à TOUTES les demandes en attente de la
   * même conversation (permission/index.ts:129-138) : l'état des conversations est relu juste avant l'envoi, et celles qui
   * travaillent de nouveau sont laissées de côté (la demande d'une nouvelle réponse échouerait sinon). États illisibles :
   * rien n'est envoyé. Au mieux : les erreurs sont journalisées.
   */
  const rejectOrphans = async (requests: PendingPermission[], directory: string | null, context: Record<string, unknown>): Promise<void> => {
    const candidates = requests.filter((p) => ID_RE.test(p.id));
    if (candidates.length === 0) return;
    let working: Set<string>;
    try {
      working = await workingSessions(directory);
    } catch (err) {
      log.warn("demandes d'autorisation orphelines non refusées : états des conversations illisibles", { ...context, error: errorMessage(err) });
      return;
    }
    let rejected = 0;
    let skipped = 0;
    for (const request of candidates) {
      if (working.has(request.sessionID)) {
        skipped++;
        continue;
      }
      try {
        // P9 : inscrite au registre avant l'envoi.
        emitted.record({ requestId: request.id, reply: "reject", by: "cockpit", at: Date.now() });
        await client.request("POST", `/permission/${encodeURIComponent(request.id)}/reply`, {
          query: { directory },
          body: { reply: "reject" },
          timeoutMs: PERMISSION_LOOKUP_TIMEOUT_MS,
        });
        rejected++;
      } catch (err) {
        log.warn("demande d'autorisation orpheline non refusée", { ...context, requestId: request.id, error: errorMessage(err) });
      }
    }
    log.info("demandes d'autorisation orphelines refusées", { ...context, rejected, skipped, pending: candidates.length });
  };

  /**
   * Après un arrêt réussi : refuse (« reject ») les demandes d'autorisation restées en attente dans la conversation arrêtée
   * et dans ses sous-agents, pour qu'aucun « once » tardif ne lance un travail détaché. `releaseGate` libère la file
   * d'attente des réponses dès la liste lue. Au mieux : les erreurs sont journalisées et la réponse de l'arrêt ne change pas.
   */
  const rejectAbortedPermissions = async (sessionId: string, directory: string | null, releaseGate: () => void): Promise<void> => {
    let pending: PendingPermission[];
    try {
      pending = await pendingPermissions(directory);
    } finally {
      // Liste lue : un « once » qui attendait son tour verra la conversation arrêtée.
      releaseGate();
    }
    if (pending.length === 0) return;
    const tree = new Set([sessionId]);
    trackedDescendants(sessionId, tree);
    if (pending.some((p) => !tree.has(p.sessionID))) await opencodeDescendants(sessionId, directory, tree);
    const stale = pending.filter((p) => tree.has(p.sessionID)).slice(0, CLEANUP_MAX_REJECTS);
    await rejectOrphans(stale, directory, { cause: "arrêt", sessionId });
  };

  return {
    acquire: acquireReplyGate,
    pending: pendingPermissions,
    working: workingSessions,
    checkOnce: checkOnceReply,
    isOrphanOfWorkingSession,
    rejectOrphans,
    rejectAborted: rejectAbortedPermissions,
    relayOnce: () => Promise.reject(new Error("portillon : relayOnce non disponible avant L1b")),
    rejectWhenAlone: () => Promise.reject(new Error("portillon : rejectWhenAlone non disponible avant L1b")),
    emitted: { record: (entry) => emitted.record(entry), has: (requestId) => emitted.has(requestId) },
  };
}
