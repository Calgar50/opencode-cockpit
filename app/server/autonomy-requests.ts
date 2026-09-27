// Propriétaire : L10a.
// Demandes autonomes (table `autonomy_requests`, migration 4 ; spécification §4.3, §4.8.1, §4.10, §4.12 ; plan d'exécution,
// fiche L10a) : « une demande » est un envoi facturé et tout ce qu'il déclenche.
// - crochet `beforeBilledSend` (rang `requests`, après `activation`) : sur `prompt_async`, `command` et `summarize` d'une
//   conversation suivie, la demande en cours est close, puis une nouvelle est ouverte quand le choix de la racine est automatique
//   (« modifications » ou « autonome »). Un choix qui n'est pas automatique n'ouvre rien : le cycle d'autonomie voit alors
//   « X-hors-demande » et tout attend l'utilisateur ;
// - raccourci : un raccourci dont le gabarit contient « !` » lance des commandes sans aucune demande d'autorisation (§4.10) ;
//   en choix automatique il est refusé, 409 `raccourci-refuse-autonomie` (phrase `raccourciRefuse()` de L9b), rien n'est envoyé ;
// - compteurs par demande (actions automatiques, attentes, refus, contrôles par IA, fichiers, délégations, début) et dépense par
//   `ledger.spentSince(racine, début)` (L2b) ; événement `autonomie.demande` à l'ouverture, à chaque changement de compteur et à
//   la fin ;
// - `interrupt(rootId, fin)` : fin d'une demande décidée ailleurs (plafonds, arrêt, redémarrage d'opencode : L10c).
// Réserve mesurée (MX1 §5, reportée par le plan §3.5) : `usage.updated` peut partir à chaque `message.updated` portant
// `time.completed`, et l'appel qui donne son titre à une conversation n'est porté par aucun message : `spentSince` sous-estime la
// dépense d'un petit appel par conversation. Les plafonds sont inchangés ; la confirmation d'« Autonome » le dit (L9b).
// P4, P5, P6 : ce module n'envoie aucune réponse d'autorisation, ne lance aucun appel facturé et ne lit qu'en lecture seule
// (`GET /command` pour le gabarit d'un raccourci) ; il n'écrit jamais la configuration d'opencode.
// neutralRequests reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan §2.2).
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { emitCockpit } from "./cockpit-events.ts";
import type { Cockpit11, Cockpit11Module, HookSignatures, RequestsPort } from "./contracts-11.ts";
import { ConversationAutonomyStore } from "./conversation-autonomy.ts";
import { errorMessage } from "./log.ts";
import type { OpencodeClient } from "./opencode.ts";
import { raccourciRefuse } from "./shared/autonomy-texts.ts";
import type { AutonomyCaps, AutonomyChoice, AutonomyErrorBody, AutonomyRequestView, RequestEnd } from "./shared/autonomy-types.ts";
import { SESSION_ID_RE } from "./shared/ids.ts";

export function neutralRequests(): RequestsPort {
  return {
    current: () => null,
    spent: () => 0,
    interrupt: () => undefined,
  };
}

// --- Bornes ----------------------------------------------------------------------------------------------------------------------

/** Lecture du gabarit d'un raccourci (`GET /command`) : même borne que les autres lectures des services 1.1. */
export const COMMAND_LOOKUP_TIMEOUT_MS = 5_000;
/** Raccourcis lus au plus dans `GET /command` (le cockpit n'en propose jamais autant). */
export const COMMANDS_MAX = 1_000;
/** Gabarit lu au plus (caractères) ; au-delà : illisible, donc refusé en choix automatique. */
export const TEMPLATE_SCAN_MAX = 200_000;

/** Routes du proxy qui envoient un appel facturé (http.ts) : chacune ouvre une demande. */
const SEND_ROUTE = /^\/session\/([^/]+)\/(prompt_async|command|summarize)$/;

/** « !` » d'un raccourci (opencode exécute `!`commande`` à l'envoi, §4.10) : un blanc entre les deux ne change rien. */
const SHELL_LINE_RE = /!\s*`/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Choix qui répondent sans vous (§4.1) : eux seuls ouvrent une demande autonome. */
export function isAutomaticChoice(choix: AutonomyChoice): boolean {
  return choix === "modifications" || choix === "autonome";
}

// --- Plafonds en vigueur ----------------------------------------------------------------------------------------------------------

const CAP_KEYS = ["plafondUsd", "actionsMax", "delegationsMax", "dureeMinutes", "fichiersMax", "controlesIaMax"] as const satisfies ReadonlyArray<keyof AutonomyCaps>;

/**
 * Plafonds d'une conversation au moment de l'envoi : réglages (budget.autonomie), puis ceux posés sur la racine ; le plafond de
 * coût jamais au-delà de `plafondMaxUsd` (arrêt plus tôt, jamais plus tard). Même lecture que la vue de L6a, vérifiée contre
 * `GET /api/conversations/:rootId/autonomie` par autonomy-requests.test.ts.
 */
export function conversationCaps(c11: Pick<Cockpit11, "db" | "settings">, rootId: string): AutonomyCaps {
  const settings = c11.settings.get().budget.autonomie;
  const stored = new ConversationAutonomyStore(c11.db).read(rootId)?.plafonds ?? {};
  const caps: AutonomyCaps = {
    plafondUsd: settings.plafondUsd,
    actionsMax: settings.actionsMax,
    delegationsMax: settings.delegationsMax,
    dureeMinutes: settings.dureeMinutes,
    fichiersMax: settings.fichiersMax,
    controlesIaMax: settings.controlesIaMax,
  };
  for (const key of CAP_KEYS) {
    const value = stored[key];
    if (typeof value === "number" && Number.isFinite(value)) caps[key] = value;
  }
  caps.plafondUsd = Math.min(caps.plafondUsd, settings.plafondMaxUsd);
  return caps;
}

// --- Magasin (table autonomy_requests) --------------------------------------------------------------------------------------------

/** Compteurs d'une demande qui s'additionnent (`fichiers` est un total, jamais un incrément : ce sont des fichiers DISTINCTS). */
export interface RequestDeltas {
  auto?: number;
  attentes?: number;
  refus?: number;
  controles?: number;
  delegations?: number;
  /** Nombre de fichiers distincts modifiés automatiquement depuis le début de la demande ; seul un total plus grand est écrit. */
  fichiersTotal?: number;
}

interface RequestRow {
  id: string;
  root_id: string;
  choix: string;
  plafonds: string;
  started_at: number;
  ended_at: number | null;
  spent: number;
  auto: number;
  attentes: number;
  refus: number;
  controles: number;
  fichiers: number;
  delegations: number;
  fin: string | null;
}

const CHOICES: ReadonlySet<string> = new Set<AutonomyChoice>(["demander", "modifications", "plan", "autonome"]);

/** Accès à `autonomy_requests` : ce paquet en est le seul écrivain (routes-activity.ts la lit). */
export class AutonomyRequestStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** Demande en cours d'une conversation (ligne sans `ended_at`), la plus récente ; null si aucune. */
  current(rootId: string): RequestRow | null {
    const row = this.#db
      .prepare("SELECT * FROM autonomy_requests WHERE root_id = ? AND ended_at IS NULL ORDER BY started_at DESC, rowid DESC LIMIT 1")
      .get(rootId) as RequestRow | undefined;
    return row ?? null;
  }

  byId(id: string): RequestRow | null {
    const row = this.#db.prepare("SELECT * FROM autonomy_requests WHERE id = ?").get(id) as RequestRow | undefined;
    return row ?? null;
  }

  /** Conversations qui ont une demande autonome en cours, les plus récentes d'abord (relecture à la reconnexion d'opencode). */
  openRoots(limit: number): string[] {
    const rows = this.#db
      .prepare("SELECT DISTINCT root_id FROM autonomy_requests WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT ?")
      .all(limit) as Array<{ root_id: string }>;
    return rows.map((row) => row.root_id);
  }

  /** Ouvre une demande ; l'appelant a déjà clos la précédente. */
  open(value: { id: string; rootId: string; choix: AutonomyChoice; plafonds: AutonomyCaps; startedAt: number }): RequestRow {
    this.#db
      .prepare("INSERT INTO autonomy_requests (id, root_id, prompt_message_id, choix, plafonds, started_at) VALUES (?, ?, NULL, ?, ?, ?)")
      .run(value.id, value.rootId, value.choix, JSON.stringify(value.plafonds), value.startedAt);
    const row = this.byId(value.id);
    if (row === null) throw new Error("demande autonome : ligne non relue après l'ouverture");
    return row;
  }

  /** Close la demande en cours d'une conversation ; rend la ligne close, null si aucune n'était ouverte. */
  close(rootId: string, fin: RequestEnd, at: number, spent: number): RequestRow | null {
    const rows = this.#db
      .prepare("UPDATE autonomy_requests SET ended_at = ?, fin = ?, spent = ? WHERE root_id = ? AND ended_at IS NULL RETURNING id")
      .all(at, fin, spent, rootId) as Array<{ id: string }>;
    const last = rows.at(-1);
    return last === undefined ? null : this.byId(last.id);
  }

  /** Ajoute aux compteurs d'une demande encore ouverte ; rend la ligne relue, null si la demande est close ou inconnue. */
  bump(id: string, deltas: RequestDeltas, spent: number): RequestRow | null {
    const changed = this.#db
      .prepare(
        `UPDATE autonomy_requests SET auto = auto + ?, attentes = attentes + ?, refus = refus + ?, controles = controles + ?,
           delegations = delegations + ?, fichiers = MAX(fichiers, ?), spent = ?
         WHERE id = ? AND ended_at IS NULL RETURNING id`,
      )
      .all(
        deltas.auto ?? 0,
        deltas.attentes ?? 0,
        deltas.refus ?? 0,
        deltas.controles ?? 0,
        deltas.delegations ?? 0,
        deltas.fichiersTotal ?? 0,
        spent,
        id,
      ) as Array<{ id: string }>;
    return changed.length === 0 ? null : this.byId(id);
  }
}

/** Vue d'une ligne de `autonomy_requests` ; `plafonds` illisibles : ceux des réglages (jamais de plafond inventé). */
export function requestView(row: RequestRow, caps: AutonomyCaps, spent: number): AutonomyRequestView {
  let stored: AutonomyCaps = caps;
  try {
    const parsed: unknown = JSON.parse(row.plafonds);
    if (isRecord(parsed)) {
      const read = { ...caps };
      for (const key of CAP_KEYS) {
        const value = parsed[key];
        if (typeof value === "number" && Number.isFinite(value)) read[key] = value;
      }
      stored = read;
    }
  } catch {
    stored = caps;
  }
  return {
    id: row.id,
    rootId: row.root_id,
    choix: CHOICES.has(row.choix) ? (row.choix as AutonomyChoice) : "demander",
    plafonds: stored,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    spent,
    auto: row.auto,
    attentes: row.attentes,
    refus: row.refus,
    controles: row.controles,
    fichiers: row.fichiers,
    delegations: row.delegations,
    fin: (row.fin as RequestEnd | null) ?? null,
  };
}

// --- Relecture des demandes en attente (posée par le module « autonomy ») -----------------------------------------------------------

/**
 * Relecture de `GET /permission` pour l'arbre d'une racine, posée par le cycle d'autonomie (autonomy.ts) quand il est installé.
 * Une demande qui s'ouvre réveille ainsi les demandes d'autorisation déjà en attente de cette conversation (§4.3 étape 8) ; le
 * relâchement du choix vers « Modifications automatiques » ou « Autonome avec contrôle » aussi (conversation-autonomy.ts, L6a).
 * Sans le module « autonomy », il n'y a rien à réveiller. Une clé par câblage : rien n'est partagé entre deux cockpits.
 */
const RESCANNERS = new WeakMap<object, (rootId: string) => void>();

/** Pose la relecture d'une racine (autonomy.ts, à l'installation). */
export function setPendingRescan(c11: object, rescan: (rootId: string) => void): void {
  RESCANNERS.set(c11, rescan);
}

/** Demande la relecture des demandes en attente d'une racine ; sans effet si le cycle d'autonomie n'est pas installé. */
export function requestPendingRescan(c11: object, rootId: string): void {
  RESCANNERS.get(c11)?.(rootId);
}

/**
 * Compteurs de la demande en cours, posés par ce module à son installation et écrits par le cycle d'autonomie (autonomy.ts, même
 * paquet L10a) : une décision automatique, une attente, un refus, un contrôle par IA, un fichier. Sans le module « requests »,
 * rien n'est compté (les tests qui ne le déclarent pas gardent le port neutre).
 */
const COUNTERS = new WeakMap<object, (id: string, deltas: RequestDeltas) => void>();

/** Pose l'écriture des compteurs (autonomy-requests, à l'installation). */
export function setRequestCounters(c11: object, bump: (id: string, deltas: RequestDeltas) => void): void {
  COUNTERS.set(c11, bump);
}

/** Ajoute aux compteurs de la demande `id` ; sans effet si le module « requests » n'est pas installé ou si la demande est close. */
export function bumpRequest(c11: object, id: string, deltas: RequestDeltas): void {
  COUNTERS.get(c11)?.(id, deltas);
}

// --- Gabarit d'un raccourci ---------------------------------------------------------------------------------------------------------

/** Vrai si le gabarit d'un raccourci lance une commande sans demande (« !` », §4.10) ; illisible ou trop long : vrai (prudent). */
export function templateRunsShell(template: unknown): boolean {
  if (typeof template !== "string") return true;
  if (template.length > TEMPLATE_SCAN_MAX) return true;
  return SHELL_LINE_RE.test(template);
}

/**
 * Gabarit du raccourci `name` dans `directory` (`GET /command`, lecture seule). Rend le texte du gabarit, ou null si le raccourci
 * n'existe pas chez opencode (il répondra lui-même). Lève si opencode ne répond pas ou répond autre chose qu'une liste.
 */
export async function readCommandTemplate(client: Pick<OpencodeClient, "request">, directory: string | null, name: string): Promise<unknown> {
  const list = await client.request<unknown>("GET", "/command", { query: { directory }, timeoutMs: COMMAND_LOOKUP_TIMEOUT_MS });
  if (!Array.isArray(list)) throw new Error("liste des raccourcis illisible");
  const found = list.slice(0, COMMANDS_MAX).find((entry) => isRecord(entry) && entry.name === name);
  return isRecord(found) ? found.template : null;
}

// --- Service et port -------------------------------------------------------------------------------------------------------------

export interface AutonomyRequestsOptions {
  now?: () => number;
}

export interface AutonomyRequests {
  port: RequestsPort;
  hook: HookSignatures["beforeBilledSend"];
  store: AutonomyRequestStore;
  /** Ajoute aux compteurs de la demande `id` et publie `autonomie.demande` ; sans effet si la demande est close (tests, L10a). */
  bump(id: string, deltas: RequestDeltas): void;
}

export function createAutonomyRequests(c11: Cockpit11, options: AutonomyRequestsOptions = {}): AutonomyRequests {
  const now = options.now ?? Date.now;
  const store = new AutonomyRequestStore(c11.db);

  /** Dépense de l'arbre depuis le début de la demande (MX1 §5 : l'appel du titre n'est porté par aucun message). */
  const spentSince = (rootId: string, since: number): number => {
    try {
      // <gf3:plafond-autonomie> début : sans les étapes d'une équipe lancée pendant que la demande est ouverte (spéc. §4.11
      // l.772 : jamais tranchées par l'autonomie) ; leur coût relève du plafond de l'équipe. Grande fusion, GF3.
      return c11.ledger.spentSinceSansEtapes(rootId, since);
      // </gf3:plafond-autonomie> fin
    } catch (err) {
      c11.log.warn("demande autonome : dépense illisible", { rootId, error: errorMessage(err) });
      return 0;
    }
  };

  const viewOf = (row: RequestRow): AutonomyRequestView =>
    requestView(row, conversationCaps(c11, row.root_id), row.ended_at === null ? spentSince(row.root_id, row.started_at) : row.spent);

  const announce = (row: RequestRow, view: AutonomyRequestView): void => {
    emitCockpit(c11.hub, "autonomie.demande", {
      rootId: row.root_id,
      requestId: row.id,
      compteurs: {
        auto: view.auto,
        attentes: view.attentes,
        refus: view.refus,
        controles: view.controles,
        fichiers: view.fichiers,
        delegations: view.delegations,
      },
      spent: view.spent,
      ...(view.fin === null ? {} : { fin: view.fin }),
    });
  };

  /** Close la demande en cours d'une racine, avec sa fin ; rend vrai si une demande était ouverte. */
  const end = (rootId: string, fin: RequestEnd): boolean => {
    const open = store.current(rootId);
    if (open === null) return false;
    const spent = spentSince(rootId, open.started_at);
    const closed = store.close(rootId, fin, now(), spent);
    if (closed === null) return false;
    c11.log.info("demande autonome close", { rootId, requestId: closed.id, fin });
    announce(closed, viewOf(closed));
    return true;
  };

  const bump = (id: string, deltas: RequestDeltas): void => {
    const before = store.byId(id);
    if (before === null || before.ended_at !== null) return;
    const row = store.bump(id, deltas, spentSince(before.root_id, before.started_at));
    if (row === null) return;
    announce(row, viewOf(row));
  };

  // --- Crochet beforeBilledSend ------------------------------------------------------------------------------------------------

  /** Racine de conversation suivie de l'instance principale, pour la session visée par l'envoi ; null sinon. */
  const rootOf = (sessionId: string): string | null => {
    if (!SESSION_ID_RE.test(sessionId)) return null;
    const rootId = c11.sessions.rootOf(sessionId);
    if (rootId === null) return null;
    const root = c11.sessions.get(rootId);
    if (!root || root.parent_id !== null || root.root_id !== root.id || root.purpose !== "chat" || root.deleted_at !== null) return null;
    return root.instance === "principale" ? rootId : null;
  };

  const refuseShortcut = (ctx: Parameters<HookSignatures["beforeBilledSend"]>[0]): Response => {
    const body: AutonomyErrorBody = { error: "raccourci-refuse-autonomie", message: raccourciRefuse() };
    return ctx.c.json(body, 409);
  };

  /**
   * Raccourci refusé en choix automatique (§4.10) : son gabarit contient « !` ». Rend la réponse 409, ou null quand l'envoi peut
   * continuer. Gabarit illisible (opencode muet, liste inattendue) : refusé aussi, rien n'est envoyé.
   */
  const shortcutRefusal = async (ctx: Parameters<HookSignatures["beforeBilledSend"]>[0]): Promise<Response | null> => {
    const name = ctx.body.command;
    if (typeof name !== "string" || name === "") return null;
    let template: unknown;
    try {
      template = await readCommandTemplate(c11.client, ctx.directory, name);
    } catch (err) {
      c11.log.warn("raccourci refusé en choix automatique : gabarit illisible", { error: errorMessage(err) });
      return refuseShortcut(ctx);
    }
    // Raccourci inconnu d'opencode : il répondra lui-même, rien à examiner ici.
    if (template === null || template === undefined) return null;
    if (!templateRunsShell(template)) return null;
    c11.log.info("raccourci refusé en choix automatique : il lance des commandes sans demande", { command: name });
    return refuseShortcut(ctx);
  };

  const hook: HookSignatures["beforeBilledSend"] = async (ctx) => {
    const match = SEND_ROUTE.exec(ctx.sub);
    const sessionId = match?.[1];
    if (sessionId === undefined) return null;
    const rootId = rootOf(sessionId);
    if (rootId === null) return null;
    const choix = c11.ports.conversationAutonomy.choiceOf(rootId);
    if (!isAutomaticChoice(choix)) {
      // Choix qui vous demande : aucune demande autonome ne s'ouvre, et celle qui courait est terminée.
      end(rootId, "terminee");
      return null;
    }
    if (match?.[2] === "command") {
      const refusal = await shortcutRefusal(ctx);
      // Refusé : la demande en cours n'est pas touchée (rien n'a été envoyé).
      if (refusal !== null) return refusal;
    }
    end(rootId, "terminee");
    const row = store.open({ id: randomUUID(), rootId, choix, plafonds: conversationCaps(c11, rootId), startedAt: now() });
    c11.log.info("demande autonome ouverte", { rootId, requestId: row.id, choix });
    announce(row, viewOf(row));
    // Demandes d'autorisation déjà en attente de cette conversation (§4.3 étape 8) : relues par le cycle, s'il est installé.
    requestPendingRescan(c11, rootId);
    return null;
  };

  // --- Port --------------------------------------------------------------------------------------------------------------------

  const port: RequestsPort = {
    current(rootId) {
      if (!SESSION_ID_RE.test(rootId)) return null;
      const row = store.current(rootId);
      return row === null ? null : viewOf(row);
    },
    spent(requestId) {
      const row = store.byId(requestId);
      if (row === null) return 0;
      return row.ended_at === null ? spentSince(row.root_id, row.started_at) : row.spent;
    },
    interrupt(rootId, fin) {
      if (!SESSION_ID_RE.test(rootId)) return;
      end(rootId, fin);
    },
  };

  return { port, hook, store, bump };
}

/** Module « requests » avec une horloge injectée (tests). Production : requestsModule. */
export function requestsModuleWith(options: AutonomyRequestsOptions = {}): Cockpit11Module {
  return {
    name: "requests",
    install(reg, c11) {
      const requests = createAutonomyRequests(c11, options);
      c11.ports.requests = requests.port;
      setRequestCounters(c11, requests.bump);
      reg.hook("beforeBilledSend", requests.hook);
    },
  };
}

export const requestsModule: Cockpit11Module = requestsModuleWith();
