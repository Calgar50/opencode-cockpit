// Portillon des accords (spécification 1.1 §3.8, P9) : vérification avant de relayer une réponse d'autorisation, file commune
// aux réponses et aux arrêts, nettoyage des demandes restées en attente après un arrêt. Extrait de createApp (http.ts) à
// comportement constant (L1a) : une seule instance, empruntée par le proxy puis par toute réponse envoyée par le serveur.
// Registre des réponses émises : chaque réponse (« once » ou « reject ») est inscrite AVANT son envoi à opencode.
// L1b : relayOnce et rejectWhenAlone (réponses des services), refus retenus réévalués par la dérivation « gate », arbre d'une
// conversation lu par sessions.descendants (un seul calcul, même borne que la 1.0).
// 1.1, Salle OMO (L18a, D-2b-20) : UN PORTILLON PAR INSTANCE. Celui de la salle est un second objet, sur le client de la salle,
// avec son propre registre des réponses émises (base de la détection 1 : une réponse d'autorisation qui n'est pas la nôtre) et
// ses propres refus retenus. Sa dérivation est inscrite avec `instances: ["omo"]`, donc branchée au seul processeur de la salle.
// Le câblage n'installe que le portillon de l'instance principale (c11.gate) : celui-ci installe ensuite celui de la salle, ce
// qui évite d'éditer wiring-11.ts.
// <gf5:d11>
// GF5 (D11, décision A31 a ; mesures/D11-permission.md §6.2 à §6.4) : chaque portillon porte la TABLE DES ATTENTES de son instance
// (pending-table.ts), installée par le module « pending ». pendingPermissions lit GET /permission ; si la lecture réussit, la table
// est resynchronisée ; si opencode répond EXACTEMENT le défaut de sa liste (400, demande en attente sans argument facultatif), la
// table est rendue à sa place, seulement si elle est fiable ET cohérente avec l'erreur (contrôle fort de l'entrée citée) ; sinon
// ListeBloqueeError (phrase dédiée, jamais « opencode ne répond pas »). Toute autre erreur : levée comme avant.
// INVARIANT DE SÛRETÉ : la table ne donne que l'EXISTENCE d'une demande. checkOnce relit TOUJOURS en direct l'état des
// conversations (GET /session/status) et l'appel d'outil (GET /session/:id/message/:mid) ; la garde du « task once » relit l'appel
// `task` (readToolCall). Rien de cela ne vient de la table.
// </gf5:d11>
import type {
  Cockpit11,
  EmittedReply,
  EventDerivation,
  OnceVerdict,
  PendingPermission,
  PermissionGate,
  PermissionGateDeps,
  PermissionTool,
  Registrar,
  RepliListe,
} from "./contracts-11.ts";
import { errorMessage } from "./log.ts";
import { OpencodeError } from "./opencode.ts";
// <gf5:d11>
import {
  cleDossier,
  createPendingTable,
  type DemandeEnAttente,
  defautDansCorps,
  ListeBloqueeError,
  METADONNEES_FACULTATIVES,
  premiereIllisible,
  type TableDesAttentes,
} from "./pending-table.ts";
import { outilDeCle } from "./shared/attentes-texts.ts";
// </gf5:d11>
import type { SessionInstance } from "./shared/activity-types.ts";
import type { RelayOutcome, RepliedBy } from "./shared/autonomy-types.ts";
import { ID_RE } from "./shared/ids.ts";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Conversation d'un message.part.updated qui annonce la fin d'un appel d'outil (partie « tool » en « completed » ou « error ») ;
 * null pour tout autre événement de partie (texte, appel en préparation ou en cours, forme illisible).
 */
export function finishedToolSession(properties: unknown): string | null {
  if (!isRecord(properties) || !isRecord(properties.part)) return null;
  const { part } = properties;
  if (part.type !== "tool" || !isRecord(part.state) || (part.state.status !== "completed" && part.state.status !== "error")) return null;
  const sessionID = typeof part.sessionID === "string" ? part.sessionID : properties.sessionID;
  return typeof sessionID === "string" && ID_RE.test(sessionID) ? sessionID : null;
}

/**
 * Conversation dont les refus retenus sont à réévaluer : permission.replied, ou fin d'un appel d'outil (finishedToolSession : il ne
 * posera plus de demande). Préparation et exécution d'un appel (« pending », « running ») ne réveillent rien : elles ne peuvent
 * que retenir. null : rien à réévaluer.
 */
function wakingSession(type: string | undefined, properties: unknown): string | null {
  if (type === "message.part.updated") return finishedToolSession(properties);
  if (type !== "permission.replied" || !isRecord(properties)) return null;
  return typeof properties.sessionID === "string" ? properties.sessionID : null;
}

/** Borne du registre des réponses émises : les plus anciennes sortent en premier. */
export const EMITTED_MAX = 2_000;

/**
 * Borne d'un refus retenu (spécification §3.10 : décision 45 s ; au-delà : attente). À la borne, une dernière évaluation a lieu ;
 * si une autre demande attend encore, rien n'est envoyé et la demande reste à l'utilisateur.
 */
export const REJECT_HOLD_MAX_MS = 45_000;

/** Longueur maximale du message d'un refus du cockpit : même borne que le corps accepté par le proxy (parsePermissionReply). */
export const REJECT_MESSAGE_MAX = 2_000;

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

/** Dépendances du portillon, plus l'instance qu'il sert (1.1) ; absente : « principale », exactement comme en 1.0.x. */
export interface PermissionGateInstanceDeps extends PermissionGateDeps {
  instance?: SessionInstance;
  // <gf5:d11>
  /** Table des attentes remplacée (tests) ; absente : une table neuve, propre à ce portillon. */
  table?: TableDesAttentes;
  // </gf5:d11>
}

/** Portillon des accords : proxy, puis autonomie et garde des délégations (P9). */
export function createPermissionGate(deps: PermissionGateInstanceDeps): PermissionGate & { readonly attentes: TableDesAttentes } {
  const { client, log } = deps;
  const instance: SessionInstance = deps.instance ?? "principale";
  const emitted = emittedRegistry();
  // <gf5:d11>
  const table = deps.table ?? createPendingTable({ instance });
  /** Racine d'opencode (clé null de la table), posée à l'installation du module « pending » ; null avant. */
  let racine: string | null = null;
  /** Dossiers dont le repli sur la table est déjà écrit au journal : un épisode dure jusqu'à la prochaine lecture réussie. */
  const episodes = new Set<string | null>();
  // </gf5:d11>

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

  // <gf5:d11>
  const textes = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

  /** Demande de la liste d'opencode, telle que le portillon la rend (ce qu'elle porte compris, D11 §6.2). */
  const deLaListe = (item: Record<string, unknown>, id: string, sessionID: string): PendingPermission => ({
    id,
    sessionID,
    tool: permissionTool(item.tool),
    permission: typeof item.permission === "string" ? item.permission : "",
    patterns: textes(item.patterns),
    metadata: isRecord(item.metadata) ? item.metadata : {},
    always: textes(item.always),
  });

  /** Demande de la table (déjà validée et bornée par pending-table.ts). */
  const deLaTable = (demande: DemandeEnAttente): PendingPermission => ({
    id: demande.id,
    sessionID: demande.sessionID,
    tool: demande.tool,
    permission: demande.permission,
    patterns: [...demande.patterns],
    metadata: demande.metadata,
    always: [...demande.always],
  });

  /**
   * Repli sur la table (D11 §6.2, réserves du sceptique) : seulement sur la signature EXACTE du défaut ; table FIABLE ; indice cité
   * présent dans la table ; CONTRÔLE FORT de l'entrée citée (permission de METADONNEES_FACULTATIVES, sans la clé citée) ; aucune
   * entrée précédente qu'opencode aurait citée avant elle. Sinon « bloquee » : rien n'est deviné. Autre erreur : null.
   */
  const repliListe = (directory: string | null, status: number, corps: unknown): RepliListe => {
    const defaut = defautDansCorps(status, corps);
    if (defaut === null) return null;
    const bloquee = { repli: "bloquee", outil: outilDeCle(defaut.cle) } as const;
    const etat = table.etat(directory);
    if (!etat.fiable) return bloquee;
    // Indice hors de la table : la demande qu'opencode cite n'y est pas, la table est incomplète.
    if (defaut.indice >= etat.demandes.length) return bloquee;
    const entree = etat.demandes[defaut.indice] as DemandeEnAttente;
    const facultatives = Object.hasOwn(METADONNEES_FACULTATIVES, entree.permission) ? METADONNEES_FACULTATIVES[entree.permission] : undefined;
    if (facultatives === undefined || !facultatives.includes(defaut.cle) || Object.hasOwn(entree.metadata, defaut.cle)) return bloquee;
    // opencode cite la PREMIÈRE demande illisible : une entrée précédente illisible dirait une table dans un autre ordre.
    const prevue = premiereIllisible(etat.demandes.slice(0, defaut.indice));
    if (prevue !== null) return bloquee;
    const cle = cleDossier(directory, racine);
    if (!episodes.has(cle)) {
      episodes.add(cle);
      log.warn("liste d'opencode illisible (demande sans argument facultatif en attente), état tiré du flux", {
        instance,
        outil: bloquee.outil,
        cle: defaut.cle,
        demandes: etat.demandes.length,
      });
    }
    return { repli: "table", demandes: etat.demandes };
  };

  /**
   * Demandes en attente (GET /permission, même dossier). Lecture réussie : table resynchronisée (les événements reçus pendant la
   * lecture y sont rejoués). Défaut exact de la liste : la table si repliListe l'accepte, sinon ListeBloqueeError. Toute autre
   * erreur : levée comme avant (opencode ne répond pas, réponse illisible).
   */
  const pendingPermissions = async (directory: string | null): Promise<PendingPermission[]> => {
    const lecture = table.debutLecture(directory);
    let list: unknown;
    try {
      list = await client.request<unknown>("GET", "/permission", { query: { directory }, timeoutMs: PERMISSION_LOOKUP_TIMEOUT_MS });
    } catch (err) {
      table.abandonLecture(lecture);
      if (err instanceof OpencodeError) {
        const repli = repliListe(directory, err.status, err.body);
        if (repli?.repli === "table") return repli.demandes.map(deLaTable);
        if (repli?.repli === "bloquee") throw new ListeBloqueeError(repli.outil);
      }
      throw err;
    }
    if (!Array.isArray(list)) {
      table.abandonLecture(lecture);
      throw new Error("liste des demandes d'autorisation illisible");
    }
    table.finLecture(lecture, list);
    episodes.delete(cleDossier(directory, racine));
    return list.flatMap((item) =>
      isRecord(item) && typeof item.id === "string" && typeof item.sessionID === "string" ? [deLaListe(item, item.id, item.sessionID)] : [],
    );
  };
  // </gf5:d11>

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
   * Appels d'outil voisins (callID) encore en préparation ou en cours (« pending », « running ») dans le message qui a posé la
   * demande, sans l'appel lui-même : chacun peut encore poser sa demande. Sur opencode 1.18.30 réel, la demande d'un voisin arrive
   * après celle de la délégation (répétition générale de l'itération 1 : edit 5 à 7 ms après, le temps de lire le fichier et de
   * calculer le diff ; bash environ 100 ms après, au premier appel d'un opencode neuf). Message introuvable (404) ou arrêté (erreur
   * du message) : aucun. opencode injoignable ou réponse illisible : erreur.
   */
  const busySiblingCalls = async (sessionID: string, tool: PermissionTool, directory: string | null): Promise<string[]> => {
    if (!ID_RE.test(sessionID)) throw new Error("identifiant de conversation de la demande illisible");
    let message: unknown;
    try {
      message = await client.request<unknown>("GET", `/session/${encodeURIComponent(sessionID)}/message/${encodeURIComponent(tool.messageID)}`, {
        query: { directory },
        timeoutMs: PERMISSION_LOOKUP_TIMEOUT_MS,
      });
    } catch (err) {
      if (err instanceof OpencodeError && err.status === 404) return [];
      throw err;
    }
    if (!isRecord(message) || !isRecord(message.info) || !Array.isArray(message.parts)) throw new Error("message de la demande illisible");
    if (message.info.error !== undefined && message.info.error !== null) return [];
    return message.parts.flatMap((p) =>
      isRecord(p) &&
      p.type === "tool" &&
      typeof p.callID === "string" &&
      p.callID !== tool.callID &&
      isRecord(p.state) &&
      (p.state.status === "pending" || p.state.status === "running")
        ? [p.callID]
        : [],
    );
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
      // <gf5:d11>
      if (err instanceof ListeBloqueeError) {
        log.warn("demande d'autorisation non vérifiable : liste d'opencode bloquée par une demande en attente, table des attentes non fiable", {
          requestId,
          outil: err.outil,
        });
        return { ok: false, status: 503, request: null, orphan: false, bloquee: err.outil };
      }
      // </gf5:d11>
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

  /**
   * Descendants d'une conversation d'après le suivi du cockpit : arbre unique (sessions.descendants, L2b), même requête et mêmes
   * bornes que la 1.0 (profondeur 8, CLEANUP_MAX_SESSIONS sessions en comptant celle de départ, lignes lues × 10).
   */
  const trackedDescendants = (sessionId: string, tree: Set<string>): void => {
    for (const id of deps.sessions.descendants(sessionId, CLEANUP_MAX_SESSIONS)) tree.add(id);
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

  /**
   * Envoi d'une réponse déjà inscrite au registre. 404 (PermissionNotFoundError : demande déjà répondue, ou retirée sans
   * événement par un rechargement d'opencode, mesure MX1 M14) : « deja-repondu ». Autre erreur : « echec ». Jamais de nouvel
   * essai : la réponse a pu être prise en compte, et une seconde réponse n'est jamais envoyée.
   */
  const sendReply = async (requestId: string, directory: string | null, body: { reply: "once" | "reject"; message?: string }): Promise<RelayOutcome> => {
    try {
      await client.request("POST", `/permission/${encodeURIComponent(requestId)}/reply`, { query: { directory }, body, timeoutMs: PERMISSION_LOOKUP_TIMEOUT_MS });
      return "ok";
    } catch (err) {
      if (err instanceof OpencodeError && err.status === 404) return "deja-repondu";
      log.warn("réponse d'autorisation du cockpit non relayée", { requestId, reply: body.reply, error: errorMessage(err) });
      return "echec";
    }
  };

  /** Condition d'un service relue avant un « once » : une condition qui lève vaut « ne tient plus » (fermé en cas de doute). */
  const conditionHolds = (condition: () => boolean): boolean => {
    try {
      return condition() === true;
    } catch (err) {
      log.warn("condition du service illisible : « once » non relayé", { error: errorMessage(err) });
      return false;
    }
  };

  /**
   * « once » envoyé par un service (autonomie, garde des délégations) : file → vérification « once » → inscription au registre →
   * relais, la file gardée jusqu'à la réponse d'opencode (aucun arrêt ne s'intercale, comme pour le proxy). Réponse déjà inscrite
   * (navigateur, autre service) : « deja-repondu », sans rien envoyer. Demande qui n'est plus active : « expiree », sans « once ».
   * Vérification impossible : « echec ». Ne lève jamais. Jamais appelé en tenant une place de la file (attente jusqu'à sa borne).
   * `stillAllowed` (Salle OMO, train de V5 de la 2 ter ; constat de L27b, G7 [competence-course]) : condition du service, relue
   * au plus près de l'envoi, APRÈS la file et la vérification. Le répondeur de la salle décide avant de prendre la file ; un arrêt
   * hors-contrôle qui clôt la demande pendant cette attente l'emporte : fausse, ou en erreur (fermé en cas de doute) →
   * « expiree », rien n'est inscrit ni envoyé.
   */
  const relayOnce = async (requestId: string, directory: string | null, by: RepliedBy, stillAllowed?: () => boolean): Promise<RelayOutcome> => {
    if (!ID_RE.test(requestId)) {
      log.warn("« once » du cockpit non relayé : identifiant de demande illisible", { by });
      return "echec";
    }
    const release = await acquireReplyGate();
    try {
      if (emitted.has(requestId)) return "deja-repondu";
      const verdict = await checkOnceReply(requestId, directory);
      // Un refus du navigateur ne passe pas par la file : inscrit pendant la vérification (demande retirée ou non), il l'emporte.
      if (emitted.has(requestId)) return "deja-repondu";
      if (!verdict.ok) {
        if (verdict.status === 503) return "echec";
        log.info("demande d'autorisation qui n'est plus active : « once » du cockpit non relayé", { requestId, by, found: verdict.request !== null });
        return "expiree";
      }
      if (stillAllowed !== undefined && !conditionHolds(stillAllowed)) {
        log.info("« once » du cockpit non relayé : la condition du service ne tient plus (demande close pendant l'attente)", { requestId, by });
        return "expiree";
      }
      // P9 : inscrite au registre avant l'envoi.
      emitted.record({ requestId, reply: "once", by, at: Date.now() });
      return await sendReply(requestId, directory, { reply: "once" });
    } finally {
      release();
    }
  };

  /**
   * Appels d'outil voisins en préparation ou en cours de la demande visée par un refus (busySiblingCalls) ; demande posée hors d'un
   * appel d'outil : aucun. Champ `tool` illisible ou message illisible : « echec », rien n'est envoyé (jamais un refus qui pourrait
   * emporter une demande que l'utilisateur n'a pas encore vue).
   */
  const siblingCallsOf = async (request: PendingPermission, directory: string | null): Promise<string[] | "echec"> => {
    if (request.tool === null) return [];
    if (request.tool === "invalid") {
      log.warn("refus du cockpit non relayé : appel d'outil de la demande illisible", { requestId: request.id });
      return "echec";
    }
    try {
      return await busySiblingCalls(request.sessionID, request.tool, directory);
    } catch (err) {
      log.warn("refus du cockpit non relayé : appels d'outil voisins illisibles", { requestId: request.id, error: errorMessage(err) });
      return "echec";
    }
  };

  /** Refus retenu en cours (rejectWhenAlone), réveillé par la dérivation « gate ». */
  interface HeldReject {
    requestId: string;
    sessionId: string;
    by: RepliedBy;
    /** Sort partagé : un autre refus retenu de la même conversation a été envoyé et a emporté celui-ci (F-c). */
    settled: RelayOutcome | null;
    wake: () => void;
  }
  const held = new Set<HeldReject>();

  /**
   * Une évaluation d'un refus retenu, dans la file des réponses. opencode 1.18.30 applique un refus à TOUTES les demandes en
   * attente de la conversation (F-c, mesure MX1 M12 : le tour s'arrête même avec un message) : tant qu'une autre demande attend,
   * rien n'est envoyé (« retenu »). Seules les autres demandes que ce portillon refuse de toute façon (refus retenus, pas encore
   * inscrits) ne retiennent pas : un seul refus part, inscrit pour chacune, et leur sort est celui de cet envoi.
   * Retient aussi tant qu'un appel d'outil voisin du même message est en préparation ou en cours sans demande en attente
   * (busySiblingCalls, lu APRÈS GET /permission) : sa demande arriverait après la lecture et serait refusée avec ce refus (mesure
   * de la répétition générale de l'itération 1). La fin d'un appel d'outil de la conversation réveille l'évaluation (dérivation).
   * Limite : un appel d'outil que l'IA n'a pas encore commencé à écrire à la lecture du message, et dont la demande arriverait
   * avant le refus (un aller-retour sur la boucle locale), serait refusé avec lui (aucune réponse « seulement celle-ci » n'existe
   * dans opencode).
   */
  const evaluateReject = async (waiter: HeldReject, directory: string | null, message: string): Promise<RelayOutcome | "retenu"> => {
    const release = await acquireReplyGate();
    try {
      if (waiter.settled !== null) return waiter.settled;
      const { requestId, sessionId } = waiter;
      if (emitted.has(requestId)) return "deja-repondu";
      let pending: PendingPermission[];
      try {
        pending = await pendingPermissions(directory);
      } catch (err) {
        log.warn("refus du cockpit non relayé : demandes en attente illisibles", { requestId, error: errorMessage(err) });
        return "echec";
      }
      // Un refus du navigateur ne passe pas par la file : inscrit pendant la lecture (demande retirée ou non), il l'emporte.
      if (emitted.has(requestId)) return "deja-repondu";
      const request = pending.find((p) => p.id === requestId);
      if (!request) return "expiree";
      if (request.sessionID !== sessionId) {
        log.warn("refus du cockpit non relayé : la demande n'appartient pas à cette conversation", { requestId, sessionId });
        return "echec";
      }
      const busyCalls = await siblingCallsOf(request, directory);
      if (busyCalls === "echec") return "echec";
      // Même règle qu'après GET /permission : un refus du navigateur inscrit pendant cette lecture l'emporte.
      if (emitted.has(requestId)) return "deja-repondu";
      const partners = new Map<string, HeldReject>();
      for (const other of held) {
        if (other !== waiter && other.sessionId === sessionId && other.settled === null) partners.set(other.requestId, other);
      }
      const siblings = pending.filter((p) => p.sessionID === sessionId && p.id !== requestId);
      // Aucune attente entre ces contrôles et l'inscription : rien ne peut s'inscrire entre-temps.
      if (siblings.some((p) => !partners.has(p.id) || emitted.has(p.id))) return "retenu";
      // Appel voisin en préparation ou en cours dont la demande n'est pas (encore) listée : il peut demander avant l'arrivée du refus.
      const asked = new Set(siblings.flatMap((p) => (p.tool !== null && p.tool !== "invalid" ? [p.tool.callID] : [])));
      if (busyCalls.some((callID) => !asked.has(callID))) return "retenu";
      const cascade = siblings.flatMap((p) => partners.get(p.id) ?? []);
      // P9 : inscrits au registre avant l'envoi, la demande visée et celles que le même refus emporte.
      const at = Date.now();
      emitted.record({ requestId, reply: "reject", by: waiter.by, at });
      for (const partner of cascade) emitted.record({ requestId: partner.requestId, reply: "reject", by: partner.by, at });
      const outcome = await sendReply(requestId, directory, message === "" ? { reply: "reject" } : { reply: "reject", message });
      for (const partner of cascade) {
        partner.settled = outcome;
        partner.wake();
      }
      return outcome;
    } finally {
      release();
    }
  };

  /**
   * Refus envoyé par le cockpit (refus Simple d'une délégation, interdit absolu de la Salle OMO), retenu tant qu'une autre demande
   * de la même conversation attend (F-c) ou qu'un appel d'outil voisin du même message peut encore en poser une. Réévalué quand la
   * dérivation « gate » voit permission.replied ou la fin d'un appel d'outil de cette conversation, ou le rechargement d'opencode
   * (demandes retirées sans événement, M14), borné à REJECT_HOLD_MAX_MS (dernière évaluation à la borne).
   * Rend le sort de l'envoi, ou « retenu » si une autre demande attend encore à la borne (rien n'est envoyé : la demande reste à
   * l'utilisateur). Message vide : refus sans message. Ne lève jamais. Jamais appelé en tenant une place de la file.
   */
  const rejectWhenAlone = async (requestId: string, sessionId: string, directory: string | null, message: string, by: RepliedBy): Promise<RelayOutcome | "retenu"> => {
    if (!ID_RE.test(requestId) || !ID_RE.test(sessionId)) {
      log.warn("refus du cockpit non relayé : identifiant illisible", { by });
      return "echec";
    }
    if (typeof message !== "string" || message.length > REJECT_MESSAGE_MAX) {
      log.warn("refus du cockpit non relayé : message illisible ou trop long", { requestId, by });
      return "echec";
    }
    let woken = false;
    let resume: () => void = () => undefined;
    let expired = false;
    const waiter: HeldReject = {
      requestId,
      sessionId,
      by,
      settled: null,
      wake: () => {
        woken = true;
        resume();
      },
    };
    const timer = setTimeout(() => {
      expired = true;
      waiter.wake();
    }, REJECT_HOLD_MAX_MS);
    timer.unref();
    // Inscrit avant la première évaluation : un événement arrivé pendant celle-ci provoque une nouvelle évaluation.
    held.add(waiter);
    try {
      for (;;) {
        woken = false;
        const outcome = await evaluateReject(waiter, directory, message);
        if (outcome !== "retenu") return outcome;
        if (expired) {
          log.info("refus du cockpit retenu jusqu'à la borne : rien n'est envoyé, la demande attend l'utilisateur", { requestId, sessionId, holdMs: REJECT_HOLD_MAX_MS });
          return "retenu";
        }
        if (!woken) {
          await new Promise<void>((resolve) => {
            resume = resolve;
          });
        }
        resume = () => undefined;
      }
    } finally {
      clearTimeout(timer);
      held.delete(waiter);
    }
  };

  /**
   * Dérivation « gate » (STEP_ORDER, avant toutes les autres) : réveille les refus retenus. Synchrone, sans appel réseau : la
   * nouvelle évaluation part dans la file des réponses.
   */
  const derivation: EventDerivation = {
    name: "gate",
    // Champ ABSENT pour l'instance principale : l'inscription garde sa forme 1.0.x/it1.
    ...(instance === "principale" ? {} : { instances: [instance] }),
    onEvent(event, origin) {
      // Origine du processeur : absente = instance principale. Le portillon d'une instance ne réveille que SES refus retenus.
      if ((origin?.instance ?? "principale") !== instance) return;
      if (held.size === 0) return;
      const type = event.payload?.type;
      if (type === "server.instance.disposed" || type === "global.disposed") {
        // Mesure MX1 M14 : les demandes en attente disparaissent sans permission.replied.
        for (const waiter of held) waiter.wake();
        return;
      }
      const sessionID = wakingSession(type, event.payload?.properties);
      if (sessionID === null) return;
      for (const waiter of held) if (waiter.sessionId === sessionID) waiter.wake();
    },
  };

  // <gf5:d11>
  /**
   * Suppression d'une conversation (proxy DELETE /session/:id) : refus PRÉALABLE de ses demandes en attente et de celles de ses
   * sous-conversations (arbre suivi, complété par /children), dans la file des réponses. Contrairement au nettoyage d'un arrêt, une
   * conversation qui travaille encore est refusée aussi : elle va disparaître, et sa demande orpheline bloquerait sinon la liste
   * de tout le dossier (mesure D11 : ni l'arrêt ni DELETE /session ne la retirent). Liste illisible : rien n'est refusé, « ok: false ».
   */
  const rejectBeforeDelete = async (
    sessionId: string,
    directory: string | null,
  ): Promise<{ ok: true; rejected: number } | { ok: false; bloquee: ReturnType<typeof outilDeCle> | null }> => {
    if (!ID_RE.test(sessionId)) return { ok: true, rejected: 0 };
    const release = await acquireReplyGate();
    try {
      let pending: PendingPermission[];
      try {
        pending = await pendingPermissions(directory);
      } catch (err) {
        log.warn("suppression : demandes d'autorisation en attente illisibles, rien n'est refusé", { sessionId, error: errorMessage(err) });
        return { ok: false, bloquee: err instanceof ListeBloqueeError ? err.outil : null };
      }
      if (pending.length === 0) return { ok: true, rejected: 0 };
      const tree = new Set([sessionId]);
      trackedDescendants(sessionId, tree);
      if (pending.some((p) => !tree.has(p.sessionID))) await opencodeDescendants(sessionId, directory, tree);
      let rejected = 0;
      for (const request of pending.filter((p) => tree.has(p.sessionID) && ID_RE.test(p.id)).slice(0, CLEANUP_MAX_REJECTS)) {
        // P9 : inscrite au registre avant l'envoi.
        emitted.record({ requestId: request.id, reply: "reject", by: "cockpit", at: Date.now() });
        try {
          await client.request("POST", `/permission/${encodeURIComponent(request.id)}/reply`, {
            query: { directory },
            body: { reply: "reject" },
            timeoutMs: PERMISSION_LOOKUP_TIMEOUT_MS,
          });
          rejected++;
        } catch (err) {
          // F-c : un refus emporte les autres demandes de la même conversation (404 ensuite) : sans conséquence ici.
          if (!(err instanceof OpencodeError && err.status === 404)) {
            log.warn("suppression : demande d'autorisation non refusée", { sessionId, requestId: request.id, error: errorMessage(err) });
          }
        }
      }
      log.info("suppression : demandes d'autorisation de la conversation refusées avant la suppression", { sessionId, rejected });
      return { ok: true, rejected };
    } finally {
      release();
    }
  };

  /**
   * Installation du module « pending » : dérivation « pending » de la table de CETTE instance, coupure du flux (opencode.connection
   * pour l'instance principale, omo.connection pour la salle), racine d'opencode, relecture proactive par pendingPermissions pour un
   * dossier permis seulement (jamais un dossier %XX ou hors du dossier de travail, A22). Puis la table de la salle.
   */
  const installPending = (reg: Registrar, c11: Cockpit11): void => {
    racine = c11.projects.opencodeRoot;
    table.poserRacine(racine);
    const permis = (dir: string): boolean => {
      if (instance === "principale") return c11.projects.isAllowedDirectory(dir);
      return c11.instances?.of(instance)?.isAllowedDirectory(dir) ?? false;
    };
    table.poserRelecture(async (dir) => {
      if (dir !== null && !permis(dir)) return;
      await pendingPermissions(dir);
    });
    reg.derivation(table.derivation);
    if (instance === "principale") {
      reg.hub("opencode.connection", () => table.surConnexion());
      c11.instances?.omo?.gate.installPending?.(reg, c11);
    } else {
      reg.hub("omo.connection", () => table.surConnexion(), { instances: [instance] });
    }
  };
  // </gf5:d11>

  return {
    acquire: acquireReplyGate,
    pending: pendingPermissions,
    working: workingSessions,
    checkOnce: checkOnceReply,
    isOrphanOfWorkingSession,
    rejectOrphans,
    rejectAborted: rejectAbortedPermissions,
    relayOnce,
    rejectWhenAlone,
    emitted: { record: (entry) => emitted.record(entry), has: (requestId) => emitted.has(requestId) },
    install(reg, c11) {
      reg.derivation(derivation);
      // D-2b-20 : le câblage n'installe que le portillon de l'instance principale (module « gate » → c11.gate). Celui de la
      // salle, construit par instance-runtime.ts, inscrit donc sa dérivation ici, juste après. Salle coupée : rien.
      if (instance === "principale") c11.instances?.omo?.gate.install?.(reg, c11);
    },
    // <gf5:d11>
    installPending,
    repliListe,
    rejectBeforeDelete,
    attentes: table,
    // </gf5:d11>
  };
}
