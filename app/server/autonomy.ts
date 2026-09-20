// Propriétaire : L10a.
// Cycle d'une décision d'autonomie (spécification §4.3, §4.4, §4.5, §4.7, §4.10, §4.12 ; §6, lignes « Autorisé automatiquement »,
// « Ne lève jamais un refus » et « L'IA de contrôle ne peut pas autoriser une commande interdite » ; plan d'exécution, fiche L10a) :
// 1. RÉCEPTION. Dérivation `permission.asked` : la racine de la conversation est cherchée HORS de la file (`sessions.get`, sinon
//    `sessions.ensure`, 5 s) ; racine inconnue, enfant d'une autre instance ou session qui n'est pas de la conversation : la
//    demande est laissée à l'utilisateur. Une file par conversation, un examen à la fois, 45 s par décision (§3.10) : au-delà, la
//    demande reste à l'utilisateur.
// 2. PRÉ-CONDITIONS, dans l'ordre de `preconditionFailure()` (L9b) : interrupteur `COCKPIT_AUTONOMY`, demande en cours
//    (`ports.requests`), plafonds (`capReached`), port `activation`. Le port d'activation n'est interrogé que si les trois
//    premières tiennent. Échec : attente, avec la raison.
// 3. AIGUILLAGE, par `routePermission()` (L9b) : `edit` → faits de L10b + règles E1-E6 de L9a ; `bash` → faits de L8b + porte
//    S1-S7 de L8a, puis `ports.controlAi` pour un « à juger » (S7) ; `task` → `ports.delegationPolicy`, seulement en
//    « autonome » ; `skill` → automatique ; tout le reste (web, dossier hors projet, lecture, répétition, MCP, extension) →
//    attente. En « Modifications automatiques », seul `edit` peut être automatique.
// 4. RELAIS, dans la file des réponses du portillon : le choix est RELU (un resserrement pendant l'examen annule la décision),
//    le registre `emitted` est vérifié, puis `gate.relayOnce`. Ce module n'envoie JAMAIS « allow », « ask » ni « always » (P4), et
//    JAMAIS de refus : le refus Simple des délégations appartient à L1d, celui d'une délégation non conforme en Autonome à L10e.
//    404 au relais (demande déjà répondue, ou retirée par un rechargement d'opencode, mesure MX1 M14) : « Déjà répondu par
//    vous. », sans nouvel essai.
// 5. JOURNAL : une ligne `autonomy_decisions` (version `AUTONOMY_RULES_VERSION`, résumé de l'action masqué à 120 caractères,
//    jamais un texte de message), les événements `autonomie.examen` et `autonomie.decision`, UN fait `decision` par ligne
//    (`ports.facts`) et `work.markWait(…, « cockpit » | « controle »)` quand un « once » est parti.
// 6. RELECTURE de `GET /permission` pour l'arbre de la racine SEULEMENT (jamais les conversations des autres) : à la reconnexion
//    d'opencode (`opencode.connection`) et à l'ouverture d'une demande, quand un choix est relâché (autonomy-requests.ts).
// 7. `examining()` : vrai pendant un examen. C'est lui qui alimente `reloadBusy` de wiring-11, donc la garde de rechargement.
// Frontières de paquets : le retour à « Demander à chaque fois » (E5, plafonds), « Passé sans contrôle » et les redémarrages
// d'opencode appartiennent à L10c ; l'activation à L10d ; la délégation en Autonome à L10e ; l'IA de contrôle à L11b. Ce module
// consomme leurs ports, il ne les écrit pas.
// P5 : aucun appel facturé n'est lancé ici ; le seul appel facturé du cycle est celui de l'IA de contrôle, gardé par L11b
// (`canBill`, `beginBilled`, `guardRuns`). P6 : lectures seules (`GET /permission`, `GET /session/:id/message/:id`,
// `GET /session/:id` par `sessions.ensure`) ; aucune écriture de la configuration d'opencode, aucun redémarrage.
// Limites dites : un examen qui dépasse 45 s ne relaie plus rien, la demande reste à l'utilisateur (ligne de journal « attente ») ;
// le `workdir` d'un appel `bash` est lu dans la partie d'outil (flux, sinon message) — inconnu, la porte rend P02 ; les faits du
// disque valent au moment de la décision (TOCTOU décrit par L10b) ; deux demandes d'un même tour n'ont pas d'ordre garanti
// (mesure MX1, M12).
// neutralAutonomy reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan §2.2).
import { posix } from "node:path";
import { AutonomyRequestStore, bumpRequest, conversationCaps, type RequestDeltas, setPendingRescan } from "./autonomy-requests.ts";
import { emitCockpit } from "./cockpit-events.ts";
import type {
  AutonomyPort,
  Cockpit11,
  Cockpit11Module,
  ControlAiUnavailableCode,
  EventDerivation,
  OpencodeConnectionData,
} from "./contracts-11.ts";
import { collectEditFacts } from "./edit-facts.ts";
import { errorMessage } from "./log.ts";
import type { OcGlobalEvent } from "./opencode.ts";
import { redactSecrets } from "./redact.ts";
import { collectShellContext } from "./shell-facts.ts";
import { assertFact } from "./shared/activity-facts.ts";
import type { ActivityFact, DecisionFactData } from "./shared/activity-types.ts";
import {
  allowJudge,
  AUTONOMY_RULES_VERSION,
  capReached,
  classifyEdit,
  DELEGATION_AUTO_RULE,
  preconditionFailure,
  routePermission,
} from "./shared/autonomy-rules.ts";
import { type ControleIaIndisponible, controleIaIndisponible, decisionControleIa, phraseRegle, phraseRelais } from "./shared/autonomy-texts.ts";
import type { AutomaticChoice, AutonomyChoice, DecisionBy, DecisionVerdict, RelayOutcome, RepliedBy } from "./shared/autonomy-types.ts";
import { ID_RE } from "./shared/ids.ts";
import { classifyCommand, type ShellContext } from "./shared/shell-gate.ts";

export function neutralAutonomy(): AutonomyPort {
  return {
    examining: () => false,
  };
}

// --- Bornes ------------------------------------------------------------------------------------------------------------------------

/** Borne d'une décision (§3.10) : au-delà, plus rien n'est relayé et la demande reste à l'utilisateur. */
export const EXAM_MAX_MS = 45_000;
/** Recherche d'une session inconnue (sessions.ensure), HORS de la file (§4.3 étape 1). */
export const SESSION_LOOKUP_TIMEOUT_MS = 5_000;
/** Lectures du cycle (GET /permission, message d'un appel d'outil). */
export const AUTONOMY_READ_TIMEOUT_MS = 5_000;
/** Examens en attente au plus par conversation ; au-delà, la demande reste à l'utilisateur. */
export const EXAM_QUEUE_MAX = 200;
/** Demandes d'autorisation déjà prises en charge, gardées en mémoire : une relecture ne décide jamais deux fois. */
export const CLAIMED_MAX = 5_000;
/** Appels `bash` dont la partie d'outil a été vue dans le flux (workdir), gardés en mémoire. */
export const PARTS_MAX = 5_000;
/** Demandes lues au plus par relecture de GET /permission, et conversations relues à une reconnexion. */
export const RESCAN_MAX = 200;
/** Demandes autonomes dont les fichiers modifiés automatiquement sont gardés en mémoire (E5). */
export const FILES_REQUESTS_MAX = 200;
/** Résumé de l'action dans le Journal du contrôle (§4.12). */
export const RESUME_MAX = 120;
/** Raison écrite dans le Journal du contrôle : phrase d'un module de textes, bornée. */
export const RAISON_MAX = 500;
/** Longueur maximale d'un callID (même borne que le portillon). */
const CALL_ID_MAX_LENGTH = 512;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const idOf = (value: unknown): string | null => (typeof value === "string" && ID_RE.test(value) ? value : null);
const callIdOf = (value: unknown): string | null => (typeof value === "string" && value.length > 0 && value.length <= CALL_ID_MAX_LENGTH ? value : null);
const textOf = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const PERMISSION_RE = /^[a-z_]{1,32}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const enc = encodeURIComponent;

/** Map bornée : au-delà de la borne, l'entrée la plus ancienne est oubliée. */
class Bounded<V> {
  readonly #limit: number;
  readonly #map = new Map<string, V>();

  constructor(limit: number) {
    this.#limit = limit;
  }

  has(key: string): boolean {
    return this.#map.has(key);
  }

  get(key: string): V | undefined {
    return this.#map.get(key);
  }

  set(key: string, value: V): void {
    this.#map.delete(key);
    if (this.#map.size >= this.#limit) {
      const oldest = this.#map.keys().next().value;
      if (oldest !== undefined) this.#map.delete(oldest);
    }
    this.#map.set(key, value);
  }

  delete(key: string): void {
    this.#map.delete(key);
  }
}

/** Promesse bornée : undefined après `ms`. */
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    timer.unref();
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

// --- Demande d'autorisation lue dans le flux ou dans GET /permission ------------------------------------------------------------

/** Demande d'autorisation prise en charge par le cycle. */
export interface AskedPermission {
  permissionId: string;
  sessionId: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  /** null : demande posée hors d'un appel d'outil (doom_loop), ou champ illisible. */
  tool: { messageID: string; callID: string } | null;
  directory: string | null;
}

/** Lit une demande d'autorisation (propriétés de `permission.asked`, ou entrée de `GET /permission`) ; null si illisible. */
export function readAsked(raw: unknown, directory: string | null): AskedPermission | null {
  if (!isRecord(raw)) return null;
  const permissionId = idOf(raw.id);
  const sessionId = idOf(raw.sessionID);
  const permission = typeof raw.permission === "string" && PERMISSION_RE.test(raw.permission) ? raw.permission : null;
  if (permissionId === null || sessionId === null || permission === null) return null;
  const patterns = Array.isArray(raw.patterns) ? raw.patterns.filter((p): p is string => typeof p === "string" && p.length <= 4_096).slice(0, 256) : [];
  const rawTool = raw.tool;
  const messageID = isRecord(rawTool) ? idOf(rawTool.messageID) : null;
  const callID = isRecord(rawTool) ? callIdOf(rawTool.callID) : null;
  return {
    permissionId,
    sessionId,
    permission,
    patterns,
    metadata: isRecord(raw.metadata) ? raw.metadata : {},
    tool: messageID !== null && callID !== null ? { messageID, callID } : null,
    directory,
  };
}

/** Résumé de l'action pour le Journal (§4.12) : donnée technique masquée et bornée, jamais un texte de message. */
export function actionResume(asked: Pick<AskedPermission, "permission" | "patterns" | "metadata">): string {
  const meta = asked.metadata;
  const own = (key: string): unknown => (Object.hasOwn(meta, key) ? meta[key] : undefined);
  const raw =
    asked.permission === "bash"
      ? own("command")
      : asked.permission === "task"
        ? (own("subagent_type") ?? own("description"))
        : (own("filepath") ?? asked.patterns[0]);
  const text = typeof raw === "string" ? raw : (asked.patterns[0] ?? "");
  return redactSecrets(text).replace(/\s+/g, " ").trim().slice(0, RESUME_MAX);
}

// --- Décision -----------------------------------------------------------------------------------------------------------------------

/** Appel à l'IA de contrôle, pour la ligne du Journal (§4.12, colonne « Coût du contrôle »). */
interface IaInfo {
  model: string | null;
  cost: number | null;
  ms: number | null;
}

/**
 * Sort d'un examen, avant le relais : « auto » (un « once » peut partir), « attente » (la demande reste à l'utilisateur) ou
 * « refus » (décidé par la politique de délégation, L10e, qui l'a envoyé elle-même : ce module n'envoie jamais de refus).
 */
type Outcome =
  | { kind: "auto"; regle: string; par: DecisionBy; raison: string; ia?: IaInfo; files?: readonly string[]; delegation?: boolean }
  | { kind: "attente"; regle: string; par: DecisionBy; raison: string; ia?: IaInfo }
  | { kind: "refus"; regle: string; raison: string };

interface Job extends AskedPermission {
  rootId: string;
  askedAt: number;
  /** Heure limite de la décision (§3.10, 45 s). */
  deadline: number;
}

export interface AutonomyOptions {
  now?: () => number;
  /** Borne d'une décision (défaut EXAM_MAX_MS). */
  examMaxMs?: number;
  /** Travail lancé hors de l'appel de la dérivation (défaut : microtâche). */
  defer?: (fn: () => void) => void;
}

export interface AutonomyService {
  port: AutonomyPort;
  derivation: EventDerivation;
  /** Abonnement `opencode.connection` : relecture des demandes en attente des conversations qui ont une demande autonome. */
  onConnection(data: OpencodeConnectionData): void;
  /** Relecture de `GET /permission` pour l'arbre d'une racine (§4.3 étape 8). */
  rescan(rootId: string): void;
  /** Examens en cours (tests). */
  examining(): number;
}

export function createAutonomyService(c11: Cockpit11, options: AutonomyOptions = {}): AutonomyService {
  const now = options.now ?? Date.now;
  const examMaxMs = options.examMaxMs ?? EXAM_MAX_MS;
  const defer = options.defer ?? queueMicrotask;
  const store = new AutonomyRequestStore(c11.db);
  const log = c11.log;

  /**
   * Demandes prises en charge (en file, en examen ou décidées). Une relecture de `GET /permission` ne reprend une demande que si
   * elle est marquée « à revoir » : c'est le cas d'une demande mise en attente faute de demande autonome en cours
   * (« X-hors-demande »), pour qu'un passage à un choix automatique la relise (§4.3 étape 8). Une demande qu'aucun examen n'a
   * touchée (choix « Demander » ou « Plan d'abord », délégation hors Autonome) sort de la table : aucune ligne de journal n'a été
   * écrite, elle sera reprise telle quelle.
   */
  const claimed = new Bounded<{ retry: boolean }>(CLAIMED_MAX);
  /** `workdir` des appels `bash` vus dans le flux, par « session|callID » (null : absent de l'entrée de l'outil). */
  const parts = new Bounded<string | null>(PARTS_MAX);
  /** Fichiers distincts modifiés automatiquement, par demande autonome (E5 : ne compte qu'une fois un fichier touché deux fois). */
  const files = new Bounded<Set<string>>(FILES_REQUESTS_MAX);
  /** Une file par conversation : un examen à la fois, dans l'ordre d'arrivée. */
  const queues = new Map<string, { chain: Promise<void>; size: number }>();
  let running = 0;

  const mode = () => c11.settings.get().ui.mode;
  const controleIa = () => c11.settings.get().budget.autonomie.controleIa === true;
  const phrase = (regle: string): string => phraseRegle(regle, { mode: mode(), controleIa: controleIa() });

  // --- Journal, faits, événements -------------------------------------------------------------------------------------------------

  interface DecisionInput {
    job: Job;
    choix: AutonomyChoice;
    requestId: string | null;
    verdict: DecisionVerdict;
    regle: string;
    par: DecisionBy;
    raison: string;
    relais: RelayOutcome | null;
    ia: IaInfo | null;
  }

  /** Une ligne `autonomy_decisions`, UN fait « decision » et un événement `autonomie.decision` ; jamais un texte de message. */
  const record = (input: DecisionInput): void => {
    const { job } = input;
    const at = now();
    const raison = input.raison.slice(0, RAISON_MAX);
    try {
      c11.db
        .prepare(
          `INSERT INTO autonomy_decisions (request_id, root_id, session_id, permission_id, permission, resume, choix, regle,
             rules_version, verdict, par, raison, ia_model, ia_cost, ia_ms, relais, asked_at, decided_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.requestId,
          job.rootId,
          job.sessionId,
          job.permissionId,
          job.permission,
          actionResume(job),
          input.choix,
          input.regle,
          AUTONOMY_RULES_VERSION,
          input.verdict,
          input.par,
          raison,
          input.ia?.model ?? null,
          input.ia?.cost ?? null,
          input.ia?.ms ?? null,
          input.relais,
          job.askedAt,
          at,
        );
    } catch (err) {
      log.warn("autonomie : décision non journalisée", { rootId: job.rootId, permissionId: job.permissionId, error: errorMessage(err) });
      return;
    }
    const data: DecisionFactData = { verdict: input.verdict, regle: input.regle };
    try {
      const fact: ActivityFact = { rootId: job.rootId, sessionId: job.sessionId, kind: "decision", ref: job.permissionId, data, at };
      c11.ports.facts.append([assertFact(fact)]);
    } catch (err) {
      log.warn("autonomie : fait « decision » non écrit", { permissionId: job.permissionId, error: errorMessage(err) });
    }
    emitCockpit(c11.hub, "autonomie.decision", {
      rootId: job.rootId,
      sessionId: job.sessionId,
      permissionId: job.permissionId,
      verdict: input.verdict,
      regle: input.regle,
      raison,
      par: input.par,
    });
    log.info("autonomie : décision", {
      rootId: job.rootId,
      permissionId: job.permissionId,
      permission: job.permission,
      verdict: input.verdict,
      regle: input.regle,
      par: input.par,
      relais: input.relais,
    });
  };

  const count = (requestId: string | null, deltas: RequestDeltas): void => {
    if (requestId !== null) bumpRequest(c11, requestId, deltas);
  };

  /** Attente d'accord enregistrée après le relais d'un « once » (écrivain unique : ports.facts.work, L4b). */
  const markOnce = (job: Job, by: RepliedBy): void => {
    const target = job.permission === "task" ? textOf(job.metadata.subagent_type) : null;
    try {
      c11.ports.facts.work.markWait(
        {
          permissionId: job.permissionId,
          sessionId: job.sessionId,
          rootId: job.rootId,
          permission: job.permission,
          target: target !== null && NAME_RE.test(target) ? target : null,
        },
        "once",
        by,
      );
    } catch (err) {
      log.warn("autonomie : attente d'accord non enregistrée", { permissionId: job.permissionId, error: errorMessage(err) });
    }
  };

  // --- Faits d'une demande autonome ------------------------------------------------------------------------------------------------

  const spentOf = (requestId: string): number => {
    try {
      return c11.ports.requests.spent(requestId);
    } catch (err) {
      log.warn("autonomie : dépense de la demande illisible", { error: errorMessage(err) });
      return Number.NaN;
    }
  };

  /**
   * Fichiers déjà modifiés automatiquement par la demande (E5) : l'ensemble tenu en mémoire quand il est au moins aussi complet
   * que le compteur de la ligne, sinon le seul compteur (chaque fichier de cette demande compte alors comme nouveau, prudent).
   */
  const filesSoFar = (requestId: string | null, fichiers: number): ReadonlySet<string> | number => {
    if (requestId === null) return fichiers;
    const known = files.get(requestId);
    return known !== undefined && known.size >= fichiers ? known : fichiers;
  };

  const rememberFiles = (requestId: string | null, touched: readonly string[]): number => {
    if (requestId === null) return 0;
    const set = files.get(requestId) ?? new Set<string>();
    for (const file of touched) set.add(file);
    files.set(requestId, set);
    return set.size;
  };

  // --- Aiguillage ---------------------------------------------------------------------------------------------------------------

  /** `workdir` de l'appel `bash` : flux (partie d'outil), sinon message ; undefined = inconnu (la porte rend P02). */
  const workdirOf = async (job: Job): Promise<string | null | undefined> => {
    if (job.tool === null) return undefined;
    const key = `${job.sessionId}|${job.tool.callID}`;
    if (parts.has(key)) return parts.get(key);
    let message: unknown;
    try {
      message = await c11.client.request<unknown>("GET", `/session/${enc(job.sessionId)}/message/${enc(job.tool.messageID)}`, {
        query: { directory: job.directory },
        timeoutMs: AUTONOMY_READ_TIMEOUT_MS,
      });
    } catch (err) {
      log.warn("autonomie : appel `bash` illisible, dossier de travail inconnu", { permissionId: job.permissionId, error: errorMessage(err) });
      return undefined;
    }
    if (!isRecord(message) || !Array.isArray(message.parts)) return undefined;
    const part = message.parts.find(
      (p) => isRecord(p) && p.type === "tool" && p.tool === "bash" && p.callID === job.tool?.callID && isRecord(p.state) && p.state.status !== "pending",
    );
    const state = isRecord(part) && isRecord(part.state) ? part.state : null;
    if (state === null || !isRecord(state.input)) return undefined;
    return typeof state.input.workdir === "string" ? state.input.workdir : null;
  };

  /** Dossier de la conversation relatif à la racine du workspace (entrée de l'IA de contrôle, §4.6). */
  const relativeDir = (directory: string): string => {
    const rel = posix.relative(posix.resolve(c11.projects.opencodeRoot), posix.resolve(directory));
    return rel === "" || rel.startsWith("..") || posix.isAbsolute(rel) ? "" : rel;
  };

  const editOutcome = async (job: Job, directory: string, requestId: string | null, fichiersMax: number, fichiers: number): Promise<Outcome> => {
    const facts = await collectEditFacts(
      { permission: job.permission, patterns: job.patterns, metadata: job.metadata },
      directory,
      c11.projects,
      filesSoFar(requestId, fichiers),
    );
    const verdict = classifyEdit(facts, fichiersMax);
    if (verdict.verdict === "auto") {
      return { kind: "auto", regle: verdict.regle, par: "regles", raison: phrase(verdict.regle), files: facts.touchedFiles };
    }
    // E5 : la modification attend ; le retour à « Demander à chaque fois » est posé par L10c (plafonds).
    return { kind: "attente", regle: verdict.regle, par: "regles", raison: phrase(verdict.regle) };
  };

  const judgeOutcome = async (job: Job, directory: string, requestId: string | null, command: string): Promise<Outcome> => {
    const verdict = await c11.ports.controlAi.judge({
      rootId: job.rootId,
      sessionId: job.sessionId,
      requestId,
      command,
      head: command.trimStart().split(/[ \t]+/)[0] ?? "",
      relativeDir: relativeDir(directory),
      directory,
    });
    if (verdict.decision === "indisponible") {
      // L'IA n'a pas été consultée : rien n'est compté, la commande attend votre accord.
      return { kind: "attente", regle: "S7", par: "cockpit", raison: controleIaIndisponible(verdict.raison as ControleIaIndisponible) };
    }
    const ia: IaInfo = { model: verdict.model, cost: verdict.costUsd, ms: verdict.ms };
    count(requestId, { controles: 1 });
    const raison = decisionControleIa({ decision: verdict.decision, raison: verdict.raison });
    return verdict.decision === "autoriser"
      ? { kind: "auto", regle: "S7", par: "ia-controle", raison, ia }
      : { kind: "attente", regle: "S7", par: "ia-controle", raison, ia };
  };

  const bashOutcome = async (job: Job, directory: string, choix: AutomaticChoice, requestId: string | null): Promise<Outcome> => {
    const command = typeof job.metadata.command === "string" ? job.metadata.command : "";
    const workdir = await workdirOf(job);
    const facts = await collectShellContext(command, directory, c11.projects);
    // `workdir` inconnu : la porte lit `ctx.workdir` en `unknown` et rend P02 « workdir-inconnu ». Le contrat ne décrit que le
    // cas connu : la conversion est ici, une seule fois.
    const context: ShellContext = { ...facts, workdir: workdir === undefined ? (undefined as unknown as null) : workdir, allowJudge: allowJudge(choix, controleIa()) };
    const verdict = classifyCommand(command, context);
    if (verdict.verdict === "auto") return { kind: "auto", regle: verdict.regle, par: "regles", raison: phrase(verdict.regle) };
    // S1 à S6 décident avant toute consultation : l'IA de contrôle ne peut pas autoriser une commande interdite (§6).
    if (verdict.verdict === "attente") return { kind: "attente", regle: verdict.regle, par: "regles", raison: phrase(verdict.regle) };
    return judgeOutcome(job, directory, requestId, command);
  };

  const taskOutcome = async (job: Job, directory: string): Promise<Outcome> => {
    const policy = await c11.ports.delegationPolicy.decide({
      rootId: job.rootId,
      sessionId: job.sessionId,
      permissionId: job.permissionId,
      directory,
      mode: mode(),
    });
    const regle = policy.regle ?? "D1";
    if (policy.verdict === "auto") return { kind: "auto", regle: policy.regle ?? DELEGATION_AUTO_RULE, par: "regles", raison: phrase(policy.regle ?? DELEGATION_AUTO_RULE), delegation: true };
    // « refus » : la politique de délégation (L10e) a envoyé elle-même le refus Simple ; ce module n'en envoie jamais.
    if (policy.verdict === "refus") return { kind: "refus", regle, raison: phrase(regle) };
    return { kind: "attente", regle, par: "regles", raison: phrase(regle) };
  };

  // --- Examen -------------------------------------------------------------------------------------------------------------------

  /** Racine de la conversation suivie de l'instance principale ; null : demande laissée à l'utilisateur. */
  const rootOf = async (sessionId: string, directory: string | null): Promise<string | null> => {
    const known = c11.sessions.get(sessionId);
    const row =
      known && (known.parent_id === null || c11.sessions.get(known.parent_id))
        ? known
        : await bounded(c11.sessions.ensure(sessionId, directory ?? undefined).catch(() => undefined), SESSION_LOOKUP_TIMEOUT_MS);
    if (row === undefined || row.purpose !== "chat" || row.deleted_at !== null) return null;
    const root = c11.sessions.get(row.root_id);
    if (!root || root.parent_id !== null || root.root_id !== root.id || root.purpose !== "chat" || root.deleted_at !== null) return null;
    return root.instance === "principale" ? root.id : null;
  };

  const examine = async (job: Job): Promise<void> => {
    const choix = c11.ports.conversationAutonomy.choiceOf(job.rootId);
    const route = routePermission(choix, job.permission);
    // « Demander à chaque fois » et « Plan d'abord » : aucun examen. `task` hors Autonome : garde des délégations (L1d). Aucune
    // ligne de journal n'est écrite : la demande sort de la table des prises en charge, une relecture la reprendra telle quelle.
    if (route.route === "hors-autonomie" || route.route === "garde-delegation" || (choix !== "modifications" && choix !== "autonome")) {
      claimed.delete(job.permissionId);
      return;
    }
    const root = c11.sessions.get(job.rootId);
    const directory = root && root.directory !== "" ? root.directory : null;
    running++;
    emitCockpit(c11.hub, "autonomie.examen", { rootId: job.rootId, sessionId: job.sessionId, permissionId: job.permissionId });
    try {
      const request = c11.ports.requests.current(job.rootId);
      const requestId = request !== null && request.endedAt === null && request.fin === null ? request.id : null;
      const caps = request?.plafonds ?? conversationCaps(c11, job.rootId);
      const plafond =
        request === null || requestId === null
          ? null
          : capReached({ startedAt: request.startedAt, spentUsd: spentOf(request.id), auto: request.auto, fichiers: request.fichiers }, caps, now());
      const preconditions = { interrupteur: c11.env.autonomy === true, demandeEnCours: requestId !== null, plafond };
      const first = preconditionFailure({ ...preconditions, activation: null });
      if (first !== null) return await wait(job, choix, requestId, { kind: "attente", regle: first, par: "cockpit", raison: phrase(first) });
      // Activation revérifiée à chaque décision (§4.11) ; interrogée seulement si les trois premières pré-conditions tiennent.
      const verdict = await c11.ports.activation.check({ rootId: job.rootId, choix, agent: root?.agent ?? null, directory });
      if (!verdict.ok) {
        const second = preconditionFailure({ ...preconditions, activation: verdict.raison }) ?? "X-illisible";
        return await wait(job, choix, requestId, { kind: "attente", regle: second, par: "cockpit", raison: phrase(second) });
      }
      if (directory === null) {
        return await wait(job, choix, requestId, { kind: "attente", regle: "X-illisible", par: "cockpit", raison: phrase("X-illisible") });
      }
      let outcome: Outcome;
      switch (route.route) {
        case "edit":
          outcome = await editOutcome(job, directory, requestId, caps.fichiersMax, request?.fichiers ?? 0);
          break;
        case "bash":
          outcome = await bashOutcome(job, directory, choix, requestId);
          break;
        case "task":
          outcome = await taskOutcome(job, directory);
          break;
        case "auto":
          outcome = { kind: "auto", regle: route.regle, par: "regles", raison: phrase(route.regle) };
          break;
        default:
          outcome = { kind: "attente", regle: route.regle, par: "regles", raison: phrase(route.regle) };
      }
      if (outcome.kind === "auto") return await relay(job, choix, requestId, outcome);
      if (outcome.kind === "refus") {
        count(requestId, { refus: 1 });
        return record({ job, choix, requestId, verdict: "refus-auto", regle: outcome.regle, par: "cockpit", raison: outcome.raison, relais: null, ia: null });
      }
      return await wait(job, choix, requestId, outcome);
    } finally {
      running--;
    }
  };

  const wait = async (job: Job, choix: AutonomyChoice, requestId: string | null, outcome: Extract<Outcome, { kind: "attente" }>): Promise<void> => {
    // Attente faute de demande autonome en cours : une relecture la reprendra quand une demande s'ouvrira (§4.3 étape 8).
    if (outcome.regle === "X-hors-demande") claimed.set(job.permissionId, { retry: true });
    count(requestId, { attentes: 1 });
    record({
      job,
      choix,
      requestId,
      verdict: "attente",
      regle: outcome.regle,
      par: outcome.par,
      raison: outcome.raison,
      relais: null,
      ia: outcome.ia ?? null,
    });
  };

  /**
   * Relais d'un « once » (§4.3 étape 5) : choix RELU (un resserrement pendant l'examen annule la décision), borne des 45 s,
   * registre `emitted`, puis `gate.relayOnce`. Jamais « allow », « ask » ni « always » (P4) ; jamais un refus.
   * Lecture volontairement stricte : TOUT changement de choix pendant l'examen annule, pas seulement un resserrement (relâcher
   * pendant un examen est rare, et la décision suivante repart du choix en vigueur) — jamais plus permissif, jamais l'inverse.
   * Une décision annulée est journalisée « en attente » avec « X-illisible » : le choix d'autonomie de la décision ne s'applique
   * plus à cette action.
   */
  const relay = async (job: Job, choix: AutonomyChoice, requestId: string | null, outcome: Extract<Outcome, { kind: "auto" }>): Promise<void> => {
    const annule = (): Promise<void> =>
      wait(job, choix, requestId, { kind: "attente", regle: "X-illisible", par: "cockpit", raison: phrase("X-illisible"), ...(outcome.ia ? { ia: outcome.ia } : {}) });
    if (c11.ports.conversationAutonomy.choiceOf(job.rootId) !== choix) {
      log.info("autonomie : décision annulée, le choix a changé pendant l'examen", { rootId: job.rootId, permissionId: job.permissionId });
      return annule();
    }
    if (now() >= job.deadline) {
      log.warn("autonomie : décision abandonnée, examen trop long", { rootId: job.rootId, permissionId: job.permissionId });
      return annule();
    }
    if (c11.gate.emitted.has(job.permissionId)) {
      return wait(job, choix, requestId, {
        kind: "attente",
        regle: outcome.regle,
        par: outcome.par,
        raison: phraseRelais("deja-repondu") ?? outcome.raison,
        ...(outcome.ia ? { ia: outcome.ia } : {}),
      });
    }
    const by: RepliedBy = outcome.par === "ia-controle" ? "controle" : "cockpit";
    const relais = await c11.gate.relayOnce(job.permissionId, job.directory, by);
    if (relais !== "ok") {
      count(requestId, { attentes: 1 });
      return record({
        job,
        choix,
        requestId,
        verdict: "attente",
        regle: outcome.regle,
        par: outcome.par,
        raison: phraseRelais(relais) ?? outcome.raison,
        relais,
        ia: outcome.ia ?? null,
      });
    }
    markOnce(job, by);
    const deltas: RequestDeltas = { auto: 1 };
    if (outcome.delegation === true) deltas.delegations = 1;
    if (outcome.files !== undefined) deltas.fichiersTotal = rememberFiles(requestId, outcome.files);
    count(requestId, deltas);
    record({ job, choix, requestId, verdict: "auto", regle: outcome.regle, par: outcome.par, raison: outcome.raison, relais, ia: outcome.ia ?? null });
  };

  // --- Files par conversation ---------------------------------------------------------------------------------------------------

  const enqueue = (job: Job): void => {
    const queue = queues.get(job.rootId) ?? { chain: Promise.resolve(), size: 0 };
    if (queue.size >= EXAM_QUEUE_MAX) {
      claimed.delete(job.permissionId);
      log.warn("autonomie : file pleine, la demande attend votre accord", { rootId: job.rootId, permissionId: job.permissionId });
      return;
    }
    queues.set(job.rootId, queue);
    queue.size++;
    queue.chain = queue.chain
      .then(() => examine(job))
      .catch((err: unknown) => log.warn("autonomie : examen en échec, la demande attend votre accord", { permissionId: job.permissionId, error: errorMessage(err) }))
      .finally(() => {
        queue.size--;
        if (queue.size === 0 && queues.get(job.rootId) === queue) queues.delete(job.rootId);
      });
  };

  /** Prend en charge une demande : racine cherchée HORS de la file (§4.3 étape 1), puis mise en file. */
  const claim = (asked: AskedPermission): void => {
    const known = claimed.get(asked.permissionId);
    if (known !== undefined && !known.retry) return;
    claimed.set(asked.permissionId, { retry: false });
    defer(() => {
      void rootOf(asked.sessionId, asked.directory)
        .then((rootId) => {
          if (rootId === null) {
            // Racine inconnue, supprimée ou d'une autre instance : la demande est laissée à l'utilisateur (§4.3 étape 1).
            claimed.delete(asked.permissionId);
            return;
          }
          const at = now();
          enqueue({ ...asked, rootId, askedAt: at, deadline: at + examMaxMs });
        })
        .catch((err: unknown) => {
          claimed.delete(asked.permissionId);
          log.warn("autonomie : conversation d'une demande illisible", { permissionId: asked.permissionId, error: errorMessage(err) });
        });
    });
  };

  // --- Relecture de GET /permission (arbre de la racine seulement) ---------------------------------------------------------------

  const rescanNow = async (rootId: string): Promise<void> => {
    const root = c11.sessions.get(rootId);
    if (!root || root.instance !== "principale") return;
    const directory = root.directory === "" ? null : root.directory;
    const list = await c11.client.request<unknown>("GET", "/permission", { query: { directory }, timeoutMs: AUTONOMY_READ_TIMEOUT_MS });
    if (!Array.isArray(list)) throw new Error("liste des demandes d'autorisation illisible");
    for (const item of list.slice(0, RESCAN_MAX)) {
      const asked = readAsked(item, directory);
      const known = asked === null ? undefined : claimed.get(asked.permissionId);
      if (asked === null || (known !== undefined && !known.retry)) continue;
      // Jamais les conversations des autres : seules les sessions de CET arbre sont reprises.
      const sessionRoot = c11.sessions.get(asked.sessionId)?.root_id ?? null;
      if (sessionRoot !== rootId) continue;
      claim(asked);
    }
  };

  const rescan = (rootId: string): void => {
    if (!ID_RE.test(rootId)) return;
    defer(() => {
      void rescanNow(rootId).catch((err: unknown) =>
        log.warn("autonomie : demandes en attente non relues", { rootId, error: errorMessage(err) }),
      );
    });
  };

  // --- Dérivation ------------------------------------------------------------------------------------------------------------------

  const rememberPart = (p: Record<string, unknown>): void => {
    const part = isRecord(p.part) ? p.part : null;
    if (!part || part.type !== "tool" || part.tool !== "bash") return;
    const state = isRecord(part.state) ? part.state : null;
    // « pending » : l'entrée de l'appel n'est pas encore complète, elle ne dit rien du dossier de travail.
    if (!state || state.status === "pending" || !isRecord(state.input)) return;
    const sessionId = idOf(part.sessionID) ?? idOf(p.sessionID);
    const callId = callIdOf(part.callID);
    if (sessionId === null || callId === null) return;
    parts.set(`${sessionId}|${callId}`, typeof state.input.workdir === "string" ? state.input.workdir : null);
  };

  const derivation: EventDerivation = {
    name: "autonomy",
    onEvent(global: OcGlobalEvent): void {
      const event = isRecord(global) ? global.payload : null;
      if (!isRecord(event) || typeof event.type !== "string") return;
      const p = isRecord(event.properties) ? event.properties : null;
      if (p === null) return;
      switch (event.type) {
        case "permission.asked": {
          const asked = readAsked(p, textOf(global.directory));
          if (asked !== null) claim(asked);
          return;
        }
        case "message.part.updated":
          rememberPart(p);
          return;
        case "permission.replied": {
          // Répondue (par vous ou par le cockpit) : plus rien à décider ; une relecture ne la reprendra pas.
          const requestId = idOf(p.requestID);
          if (requestId !== null) claimed.set(requestId, { retry: false });
          return;
        }
        default:
          return;
      }
    },
  };

  const onConnection = (data: OpencodeConnectionData): void => {
    if (!isRecord(data) || data.connected !== true) return;
    let roots: string[];
    try {
      roots = store.openRoots(RESCAN_MAX);
    } catch (err) {
      log.warn("autonomie : demandes autonomes en cours illisibles", { error: errorMessage(err) });
      return;
    }
    for (const rootId of roots) rescan(rootId);
  };

  return {
    port: { examining: () => running > 0 },
    derivation,
    onConnection,
    rescan,
    examining: () => running,
  };
}

/** Module « autonomy » avec une horloge ou des bornes injectées (tests). Production : autonomyModule. */
export function autonomyModuleWith(options: AutonomyOptions = {}): Cockpit11Module {
  return {
    name: "autonomy",
    install(reg, c11) {
      const service = createAutonomyService(c11, options);
      c11.ports.autonomy = service.port;
      setPendingRescan(c11, service.rescan);
      reg.derivation(service.derivation);
      reg.hub("opencode.connection", (data) => service.onConnection(data));
    },
  };
}

export const autonomyModule: Cockpit11Module = autonomyModuleWith();
