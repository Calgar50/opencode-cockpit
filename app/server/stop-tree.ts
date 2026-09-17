// Propriétaire : L1c.
// Arrêt unique de l'arbre d'une conversation (spécification §3.12, §3.9, §6 « Arrêter » ; plan d'exécution, fiche L1c) : port
// stopTree, crochet abort du proxy, routes « conversations » (routes-conversations.ts), fait statut {cause}, événement
// conversation.arretee. Même séquence pour « Arrêter », les plafonds et « Passé sans contrôle » :
//   1. marquer la demande d'autonomie (ports.requests.interrupt) ; aucune table d'équipe avant l'itération 4 (I14) ;
//   2. dans la file des réponses, refuser TOUTES les demandes d'autorisation en attente de l'arbre (SQLite + /children, borné) ;
//   3. arrêter la racine puis chaque descendant occupé, sessions de contrôle et d'étape comprises (un arrêt de racine ne les arrête
//      pas, oc/session/run-state.ts:77-86) ; la file des réponses est rendue ensuite ;
//   4. sonder /session/status toutes les 500 ms pendant 10 s au plus, ré-arrêter une fois, sinon journaliser « arrêt non confirmé » ;
//   5. tout « once » tardif est refusé : nettoyage 1.0 (rejectAborted) des demandes restées en attente dans l'arbre, puis
//      vérification existante du proxy (checkOnce) ;
//   6. délégations en cours marquées « arretee » (ports.facts.work, écrivain unique), fait statut {cause}, conversation.arretee.
//      Aucun résultat partiel n'est injecté dans la conversation.
// Échéances : les étapes 2 et 3 tiennent la file des réponses, que le portillon libère d'office après 30 s ; au-delà, un « once »
// vérifié pourrait passer au milieu de l'arrêt. Leurs appels s'arrêtent donc à STOP_PHASE_BUDGET_MS, sauf l'arrêt de la racine,
// toujours tenté ; ce qui reste occupé est repris par la sonde (étape 4).
// P6 : aucune écriture de configuration, aucun redémarrage ni libération d'instance. Routes d'opencode appelées : GET /permission,
// POST /permission/:id/reply (« reject » seulement), POST /session/:id/abort, GET /session/status, GET /session/:id/children,
// GET /session/:id/message/:id (vérification du portillon).
// Ne jamais appeler run() en tenant la file des réponses (gate.acquire) : l'arrêt la prend lui-même.
// neutralStopTree reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan §2.2).
import type { DatabaseSync } from "node:sqlite";
import { emitCockpit } from "./cockpit-events.ts";
import {
  type Cockpit11Module,
  type Cockpit11Ports,
  type PendingPermission,
  type PermissionGate,
  PortUnavailableError,
  type StopTreePort,
} from "./contracts-11.ts";
import type { EventHub } from "./hub.ts";
import { errorMessage, type Logger } from "./log.ts";
import { type OpencodeClient, OpencodeError } from "./opencode.ts";
import { registerConversationRoutes } from "./routes-conversations.ts";
import { type SessionRow, type SessionTracker, TREE_MAX_DEPTH, TREE_MAX_SESSIONS } from "./sessions.ts";
import { assertFact } from "./shared/activity-facts.ts";
import type { ActivityFact, DelegationState, StatutCause } from "./shared/activity-types.ts";
import type { RepliedBy, RequestEnd } from "./shared/autonomy-types.ts";
import type { StopCause, StopResult } from "./shared/cockpit-event-types.ts";
import { ID_RE } from "./shared/ids.ts";

export function neutralStopTree(): StopTreePort {
  return {
    run() {
      return Promise.reject(new PortUnavailableError("stopTree"));
    },
  };
}

/** Étape 4 : sonde toutes les 500 ms… */
export const STOP_PROBE_INTERVAL_MS = 500;
/** … pendant 10 s au plus, puis un seul nouvel arrêt et une dernière sonde. */
export const STOP_PROBE_WINDOW_MS = 10_000;
/** Délai de chaque appel à opencode pendant l'arrêt. */
export const STOP_REQUEST_TIMEOUT_MS = 5_000;
/**
 * Échéance des appels d'une phase (refus et arrêts dans la file, nouvel arrêt) : sous la libération d'office de la file des
 * réponses (30 s, permission-gate.ts). L'arrêt de la racine est tenté même après l'échéance.
 */
export const STOP_PHASE_BUDGET_MS = 20_000;
/** Étape 2 : refus envoyés au plus (même borne que le nettoyage 1.0). */
export const STOP_MAX_REJECTS = 100;
/** Appels GET /session/:id/children au plus, pour tout un arrêt. */
export const STOP_MAX_CHILDREN_CALLS = 50;
/** Délégations en cours marquées au plus. */
export const STOP_MAX_DELEGATIONS = 200;

/**
 * Étape 1 : fin écrite sur la demande d'autonomie de la racine. null : RequestEnd n'a pas de valeur pour cette cause (délégations
 * lancées sans demande, équipes de l'itération 4) ; la demande n'est pas marquée plutôt que marquée d'une fin fausse (P3). Valeurs
 * à compléter au contrat (autonomy-types.ts) avant L1e et les équipes.
 */
export const REQUEST_END_OF_STOP: { readonly [C in StopCause]: RequestEnd | null } = {
  vous: "vous",
  "plafond-cout": "plafond-cout",
  "non-controle": "non-controle",
  rechargement: "rechargement",
  "plafond-delegations": null,
  equipe: null,
};

/** Étape 6 : `data.cause` du fait statut ; « Arrêter » donne « arret ». */
export const STATUT_CAUSE_OF_STOP: { readonly [C in StopCause]: StatutCause } = {
  vous: "arret",
  "plafond-cout": "plafond",
  "plafond-delegations": "plafond",
  "non-controle": "non-controle",
  rechargement: "interrompue",
  equipe: "arret",
};

/** Étape 6 : délégations en cours (enfant autorisé ou au travail) ; les autres états sont écrits par la dérivation des faits (L4b). */
export const RUNNING_DELEGATION_STATES: readonly DelegationState[] = ["autorisee", "travaille"];

/** Racine inconnue au moment de l'arrêt : la route répond 404, le crochet du proxy relaie l'arrêt comme en 1.0. */
export class StopRootUnknownError extends Error {
  override name = "StopRootUnknownError";

  constructor() {
    super("arrêt de l'arbre : conversation racine inconnue du cockpit");
  }
}

export interface StopTreeDeps {
  client: Pick<OpencodeClient, "request">;
  sessions: Pick<SessionTracker, "get" | "descendants">;
  gate: Pick<PermissionGate, "acquire" | "pending" | "working" | "rejectAborted" | "emitted">;
  /** Lecture seule de la table delegations (ports.facts.work en est l'écrivain unique). */
  db: DatabaseSync;
  log: Logger;
  hub: Pick<EventHub, "cockpit">;
  /** Ports en vigueur, lus au moment de l'appel (jamais en copie). */
  ports: () => Pick<Cockpit11Ports, "requests" | "facts">;
}

export interface StopTreeOptions {
  probeIntervalMs?: number;
  probeWindowMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const enc = encodeURIComponent;

/**
 * Racine qu'« Arrêter » arrête en entier : conversation suivie par le cockpit, sans parent, servie par l'instance principale, hors
 * classement (session cachée). Sinon null : le proxy relaie l'arrêt comme en 1.0 et la route répond 404.
 */
export function stoppableRoot(sessions: Pick<SessionTracker, "get">, id: string): SessionRow | null {
  if (!ID_RE.test(id)) return null;
  const row = sessions.get(id);
  if (!row || row.parent_id !== null || row.root_id !== row.id) return null;
  return row.purpose !== "classifier" && row.instance === "principale" ? row : null;
}

interface DelegationRow {
  parent_session_id: string;
  call_id: string;
  agent: string;
  child_session_id: string | null;
  permission_id: string | null;
}

/** Port stopTree : un seul arrêt à la fois par racine (un second appel pendant l'arrêt rend le même résultat). */
export function createStopTree(deps: StopTreeDeps, options: StopTreeOptions = {}): StopTreePort {
  const { client, sessions, gate, log } = deps;
  const interval = options.probeIntervalMs ?? STOP_PROBE_INTERVAL_MS;
  const window = options.probeWindowMs ?? STOP_PROBE_WINDOW_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const running = new Map<string, Promise<StopResult>>();

  const stop = async (rootId: string, cause: StopCause): Promise<StopResult> => {
    const startedAt = now();
    const root = stoppableRoot(sessions, rootId);
    if (!root) throw new StopRootUnknownError();
    const rootDirectory = root.directory || null;
    /** Dossiers des instances à interroger : celui de la racine, et ceux des sous-sessions trouvées par /children. */
    const directories = new Set<string | null>([rootDirectory]);
    const foundDirectory = new Map<string, string>();
    /** Sous-sessions pas encore suivies par le cockpit, trouvées par GET /session/:id/children. */
    const found: string[] = [];
    /** Sessions cherchées par /children sans être trouvées dans l'arbre (autres conversations du dossier) : jamais recherchées deux fois. */
    const outsideTree = new Set<string>();
    let childrenBudget = STOP_MAX_CHILDREN_CALLS;
    const aborted: string[] = [];
    /** Échéance de la phase en cours (voir STOP_PHASE_BUDGET_MS). */
    let deadline = startedAt + STOP_PHASE_BUDGET_MS;
    let skipped = 0;
    /** Délai d'un appel de la phase en cours ; null : échéance passée, l'appel est sauté (au mieux). */
    const callTimeout = (): number | null => {
      const left = deadline - now();
      if (left > 0) return Math.min(STOP_REQUEST_TIMEOUT_MS, left);
      skipped++;
      return null;
    };

    /** Arbre de la racine, dans l'ordre : racine, sous-sessions suivies (parcours en largeur), puis trouvées par /children. */
    const tree = (): string[] => {
      const members = new Set<string>([rootId, ...sessions.descendants(rootId)]);
      for (const id of found) if (members.size < TREE_MAX_SESSIONS) members.add(id);
      return [...members];
    };
    const directoryOf = (id: string): string | null => sessions.get(id)?.directory || foundDirectory.get(id) || rootDirectory;

    /**
     * Complète l'arbre par GET /session/:id/children depuis la racine, borné, jusqu'à trouver les sessions `wanted` qui n'y sont
     * pas encore ; au mieux. Celles qui restent introuvables ne sont plus recherchées.
     */
    const complete = async (wanted: readonly string[]): Promise<void> => {
      const missing = () => {
        const members = new Set(tree());
        return wanted.filter((id) => !members.has(id) && !outsideTree.has(id));
      };
      const sought = missing();
      if (sought.length === 0) return;
      try {
        await walk(sought);
      } finally {
        for (const id of missing()) outsideTree.add(id);
      }
    };
    const walk = async (wanted: readonly string[]): Promise<void> => {
      const visited = new Set<string>();
      let frontier = [rootId];
      for (let depth = 0; depth < TREE_MAX_DEPTH && frontier.length > 0; depth++) {
        const next: string[] = [];
        for (const id of frontier) {
          if (visited.has(id)) continue;
          if (childrenBudget <= 0 || found.length >= TREE_MAX_SESSIONS) return;
          const timeoutMs = callTimeout();
          if (timeoutMs === null) return;
          visited.add(id);
          childrenBudget--;
          let children: unknown;
          try {
            children = await client.request<unknown>("GET", `/session/${enc(id)}/children`, { query: { directory: directoryOf(id) }, timeoutMs });
          } catch (err) {
            log.warn("arrêt : sous-sessions d'une conversation illisibles", { rootId, sessionId: id, error: errorMessage(err) });
            continue;
          }
          if (!Array.isArray(children)) continue;
          for (const child of children) {
            const childId = isRecord(child) && typeof child.id === "string" && ID_RE.test(child.id) ? child.id : null;
            if (childId === null || visited.has(childId)) continue;
            if (!found.includes(childId)) found.push(childId);
            if (isRecord(child) && typeof child.directory === "string" && child.directory !== "") {
              foundDirectory.set(childId, child.directory);
              directories.add(child.directory);
            }
            next.push(childId);
          }
        }
        const members = new Set(tree());
        if (wanted.every((id) => members.has(id))) return;
        frontier = next;
      }
    };

    /** Sessions de l'arbre qui travaillent (busy ou retry), racine d'abord ; null si l'état d'une instance est illisible. */
    const busyInTree = async (): Promise<string[] | null> => {
      const working = new Set<string>();
      let readable = true;
      for (const directory of [...directories]) {
        try {
          for (const id of await gate.working(directory)) working.add(id);
        } catch (err) {
          readable = false;
          log.warn("arrêt : états des conversations illisibles", { rootId, error: errorMessage(err) });
        }
      }
      let members = tree();
      const outside = [...working].filter((id) => !members.includes(id));
      if (outside.length > 0 && childrenBudget > 0) {
        await complete(outside);
        members = tree();
      }
      return readable ? members.filter((id) => working.has(id)) : null;
    };

    /** POST /session/:id/abort ; `always` : tenté même après l'échéance de la phase (racine). */
    const abortSession = async (id: string, always = false): Promise<boolean> => {
      const timeoutMs = always ? STOP_REQUEST_TIMEOUT_MS : callTimeout();
      if (timeoutMs === null) return false;
      try {
        await client.request("POST", `/session/${enc(id)}/abort`, { query: { directory: directoryOf(id) }, timeoutMs });
        if (!aborted.includes(id)) aborted.push(id);
        return true;
      } catch (err) {
        log.warn("arrêt : conversation non arrêtée", { rootId, sessionId: id, error: errorMessage(err) });
        return false;
      }
    };

    // --- 1. Demande d'autonomie (aucune table d'équipe avant l'itération 4, I14) ------------------------------------------------
    const fin = REQUEST_END_OF_STOP[cause];
    if (fin !== null) {
      try {
        deps.ports().requests.interrupt(rootId, fin);
      } catch (err) {
        log.warn("arrêt : demande d'autonomie non marquée", { rootId, cause, error: errorMessage(err) });
      }
    }

    // --- 2 et 3. Dans la file des réponses : refus de toutes les demandes de l'arbre, puis arrêts --------------------------------
    // La file est tenue jusqu'aux arrêts : un « once » qui attendait son tour voit ensuite une conversation au repos (refusé).
    let rejected = 0;
    const release = await gate.acquire();
    try {
      // Échéance comptée depuis la prise de la file : c'est elle que le portillon libère d'office.
      deadline = now() + STOP_PHASE_BUDGET_MS;
      const pending: Array<PendingPermission & { directory: string | null }> = [];
      for (const directory of [...directories]) {
        try {
          for (const request of await gate.pending(directory)) pending.push({ ...request, directory });
        } catch (err) {
          log.warn("arrêt : demandes d'autorisation de l'arbre illisibles", { rootId, error: errorMessage(err) });
        }
      }
      let members = tree();
      const outside = pending.map((p) => p.sessionID).filter((id) => !members.includes(id));
      if (outside.length > 0) {
        await complete(outside);
        members = tree();
      }
      const refusedSessions = new Set<string>();
      for (const request of pending.filter((p) => members.includes(p.sessionID) && ID_RE.test(p.id)).slice(0, STOP_MAX_REJECTS)) {
        const timeoutMs = callTimeout();
        if (timeoutMs === null) break;
        // P9 : inscrite au registre avant l'envoi. Sans message : le tour de la session s'arrête (RejectedError).
        gate.emitted.record({ requestId: request.id, reply: "reject", by: "cockpit", at: now() });
        try {
          await client.request("POST", `/permission/${enc(request.id)}/reply`, { query: { directory: request.directory }, body: { reply: "reject" }, timeoutMs });
          rejected++;
          refusedSessions.add(request.sessionID);
        } catch (err) {
          // F-c : refuser une demande refuse aussi les autres demandes de la même session (404 pour les suivantes).
          if (err instanceof OpencodeError && err.status === 404 && refusedSessions.has(request.sessionID)) {
            rejected++;
            continue;
          }
          log.warn("arrêt : demande d'autorisation non refusée", { rootId, requestId: request.id, error: errorMessage(err) });
        }
      }

      await abortSession(rootId, true);
      for (const id of (await busyInTree()) ?? tree()) {
        if (id !== rootId) await abortSession(id);
      }
      if (skipped > 0) log.warn("arrêt : appels sautés, échéance de la file des réponses atteinte", { rootId, skipped });
    } finally {
      release();
    }

    // --- 4. Sonde : toutes les 500 ms pendant 10 s au plus, un seul nouvel arrêt, sinon « arrêt non confirmé » -------------------
    const probeStart = now();
    deadline = probeStart + window;
    let busy = await busyInTree();
    while ((busy === null || busy.length > 0) && now() - probeStart < window) {
      await sleep(interval);
      busy = await busyInTree();
    }
    let unconfirmed: string[] = [];
    if (busy === null || busy.length > 0) {
      deadline = now() + STOP_PHASE_BUDGET_MS;
      const targets = busy ?? [...new Set([rootId, ...aborted])];
      for (const id of targets) await abortSession(id, id === rootId);
      await sleep(interval);
      unconfirmed = (await busyInTree()) ?? targets;
      if (unconfirmed.length > 0) log.warn("arrêt non confirmé", { rootId, cause, sessions: unconfirmed });
    }

    // --- 5. « once » tardif : demandes restées en attente dans l'arbre refusées (nettoyage 1.0, sessions au repos seulement) ------
    for (const directory of [...directories]) {
      let releaseCleanup: (() => void) | undefined;
      try {
        releaseCleanup = await gate.acquire();
        await gate.rejectAborted(rootId, directory, releaseCleanup);
      } catch (err) {
        log.warn("arrêt : demandes d'autorisation restées en attente non vérifiées", { rootId, error: errorMessage(err) });
      } finally {
        releaseCleanup?.();
      }
    }

    // --- 6. Délégations en cours, fait statut {cause}, conversation.arretee ------------------------------------------------------
    const stillBusy = new Set(unconfirmed);
    const by: RepliedBy = cause === "vous" ? "vous" : "cockpit";
    const ports = deps.ports();
    let rows: DelegationRow[] = [];
    try {
      rows = deps.db
        .prepare(
          `SELECT parent_session_id, call_id, agent, child_session_id, permission_id FROM delegations
           WHERE root_id = ? AND state IN (${RUNNING_DELEGATION_STATES.map(() => "?").join(", ")}) ORDER BY id LIMIT ?`,
        )
        .all(rootId, ...RUNNING_DELEGATION_STATES, STOP_MAX_DELEGATIONS) as unknown as DelegationRow[];
    } catch (err) {
      log.warn("arrêt : délégations en cours illisibles", { rootId, error: errorMessage(err) });
    }
    for (const row of rows) {
      // Sous-session encore occupée : la délégation n'est pas dite arrêtée.
      if (row.child_session_id !== null && stillBusy.has(row.child_session_id)) continue;
      try {
        ports.facts.work.markDelegation(
          {
            rootId,
            parentSessionId: row.parent_session_id,
            callId: row.call_id,
            agent: row.agent,
            childSessionId: row.child_session_id,
            permissionId: row.permission_id,
          },
          "arretee",
          by,
        );
      } catch (err) {
        log.warn("arrêt : délégation non marquée", { rootId, callId: row.call_id, error: errorMessage(err) });
      }
    }
    const fact: ActivityFact = {
      rootId,
      sessionId: rootId,
      kind: "statut",
      ref: null,
      data: { cause: STATUT_CAUSE_OF_STOP[cause], motif: cause, nonConfirmees: unconfirmed.length },
      at: now(),
    };
    try {
      ports.facts.append([assertFact(fact)]);
    } catch (err) {
      log.warn("arrêt : fait d'activité non écrit", { rootId, error: errorMessage(err) });
    }
    const result: StopResult = { rootId, rejected, aborted: [...aborted], unconfirmed: [...unconfirmed], durationMs: Math.max(0, now() - startedAt) };
    emitCockpit(deps.hub, "conversation.arretee", { rootId, cause, unconfirmed: [...unconfirmed] });
    log.info("arrêt de l'arbre", { rootId, cause, rejected, aborted: aborted.length, unconfirmed: unconfirmed.length, durationMs: result.durationMs });
    return result;
  };

  return {
    run(rootId, cause) {
      const current = running.get(rootId);
      if (current !== undefined) return current;
      const promise = stop(rootId, cause).finally(() => running.delete(rootId));
      running.set(rootId, promise);
      return promise;
    },
  };
}

export const stopTreeModule: Cockpit11Module = {
  name: "stopTree",
  install(reg, c11) {
    const isStoppableRoot = (id: string): boolean => stoppableRoot(c11.sessions, id) !== null;
    c11.ports.stopTree = createStopTree({
      client: c11.client,
      sessions: c11.sessions,
      gate: c11.gate,
      db: c11.db,
      log: c11.log,
      hub: c11.hub,
      ports: () => c11.ports,
    });
    // « Arrêter » du navigateur par le proxy : racine suivie → arrêt de tout l'arbre (200 StopResult) ; sinon relais 1.0.
    reg.hook("abort", async (ctx, sessionId) => {
      if (!isStoppableRoot(sessionId)) return null;
      try {
        return ctx.c.json(await c11.ports.stopTree.run(sessionId, "vous"));
      } catch (err) {
        // Racine disparue entre la vérification et l'arrêt : relais 1.0.
        if (err instanceof StopRootUnknownError) return null;
        throw err;
      }
    });
    reg.routes("conversations", (app) => registerConversationRoutes(app, c11, isStoppableRoot));
  },
};
