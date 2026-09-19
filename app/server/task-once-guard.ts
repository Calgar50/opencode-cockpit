// Propriétaire : L1d.
// Garde du `task once`, refus Simple et détails de délégation (spécification §3.14, §3.9, §6 l.1038, l.1048, l.1050, décision
// n° 4 ; plan d'exécution, fiche L1d, question Q5) :
// - crochet beforeOnceRelay : « Autoriser une fois » d'une délégation (`task`), dans la file des réponses, après la vérification 1.0
//   (checkOnce). Refus 409 delegation-refusee {message} pour les 7 cas du §3.14 (guardRefusal), rien n'est relayé et rien n'est
//   répondu à opencode : la demande d'autorisation reste en attente. En mode Simple hors « Autonome avec contrôle », 409 avec l'avis
//   Simple (la délégation y est refusée d'office, décision n° 4). Vérification impossible : 503, rien n'est relayé. Les autres
//   permissions passent (null) ;
// - dérivation du refus Simple (mode Simple ET choix de la racine différent de « autonome », lu par ports.conversationAutonomy) :
//   sur permission.asked d'un `task`, refus avec message à l'IA par gate.rejectWhenAlone (retenu tant qu'une autre demande de la
//   même conversation attend : votre autre demande n'est jamais annulée, F-c), puis work.markWait(…, « cockpit ») et fait « reponse »
//   {reponse: reject, par: cockpit}. Un refus resté « retenu » à la borne de 45 s est réarmé à la réponse suivante de la même
//   conversation. Aucune attente réseau dans onEvent : le travail part hors de l'appel (microtâche), borné ;
// - collectDelegationFacts (port, réutilisé par L10e pour D1-D7, §4.7) et inspectDelegation : faits d'une délégation en attente ;
// - details(rootId, permissionId) et GET /api/conversations/:rootId/delegations/:permissionId (routes-delegations.ts).
// M9 (un refus avec message laisse-t-il l'Assistant général continuer seul, sans boucle, sur une IA Copilot ?) : recette facturée EN
// ATTENTE (non autorisée). Repli prévu : REPLI_ATTENTE_SIMPLE (réglage interne, désactivé).
// P4 : aucune réponse « allow », « ask » ni « always » ; ce module n'envoie jamais de « once » ; seul le refus Simple envoie un
// « reject », par le portillon (P9, inscrit au registre avant l'envoi). P6 : lectures seulement (GET /permission, GET
// /session/:id/message/:id, GET /agent par le cache de lookup, GET /session/:id par sessions.ensure).
// Écarts assumés : « privée d'une équipe » attend les équipes (itération 4) ; un task_id qui désigne la racine ou la conversation
// qui délègue elle-même est refusé (reprise impossible sans casser le tour en cours) ; catalogue non chargé : IA refusée (P1).
// Limites (dites) : un refus Simple retenu par le portillon (45 s au plus) part même si le mode ou le choix change pendant la
// retenue ; le registre des réponses émises garantit qu'une seule réponse part (un « once » de l'autonomie ou de vous, inscrit
// avant, l'emporte). Réarmé après la borne, il est revérifié. Une demande posée pendant une coupure du flux ou avant un redémarrage
// du cockpit n'est pas refusée d'office : elle attend l'utilisateur, et son « once » reste gardé par ce crochet. Les @jetons sont
// vérifiés au moment du « once » (métadonnées du disque, liens suivis) : un fichier créé entre cette vérification et le lancement
// du sous-agent (par exemple par une autre action autorisée du même tour) serait lu (TOCTOU, fenêtre courte).
// neutralTaskGuard reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan §2.2).
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  type Cockpit11,
  type Cockpit11Module,
  type DelegationRequestRef,
  type EventDerivation,
  type HookSignatures,
  PortUnavailableError,
  type TaskGuardPort,
  type WaitUpsert,
} from "./contracts-11.ts";
import { errorMessage } from "./log.ts";
import type { OcLookupSnapshot, OcAgentInfo } from "./oc-lookup.ts";
import { OpencodeError, type OpencodeClient } from "./opencode.ts";
import { registerDelegationRoutes } from "./routes-delegations.ts";
import { CONFIRM_HEADER } from "./security.ts";
import type { SessionRow } from "./sessions.ts";
import { assertFact } from "./shared/activity-facts.ts";
import type { ActivityFact, DelegationDetailsView, DelegationRefusalCode, ReponseFactData, RuleActionLite } from "./shared/activity-types.ts";
import {
  catalogEntry,
  evaluate,
  modelKey,
  modelName,
  providerOf,
  type Rule,
  type Run,
  TASK_SIZES,
  type TaskSize,
  type UiMode,
} from "./shared/assistant-rules.ts";
import type { AutonomyChoice, DelegationFacts } from "./shared/autonomy-types.ts";
import { avisSimple, messageRefusSimple, refusDelegation, verificationImpossible } from "./shared/delegation-texts.ts";
import { ID_RE, SESSION_ID_RE } from "./shared/ids.ts";

export function neutralTaskGuard(): TaskGuardPort {
  return {
    details: async () => null,
    collectDelegationFacts: async () => {
      throw new PortUnavailableError("taskGuard");
    },
  };
}

// --- Réglages et bornes -----------------------------------------------------------------------------------------------------------

/**
 * Repli de la mesure M9 (recette facturée en attente) : si l'IA ne continue pas seule après le refus Simple, « refus Simple → attente
 * simplifiée » : plus aucun refus d'office en mode Simple, la délégation attend votre accord et la garde du « once » s'y applique
 * comme en Avancé. Réglage interne, désactivé ; basculé seulement par une décision écrite après la recette M9.
 */
export const REPLI_ATTENTE_SIMPLE = false;

/** Délai de chaque lecture à opencode par la garde (sous la libération d'office de la file des réponses, 30 s). */
export const GUARD_REQUEST_TIMEOUT_MS = 5_000;
/** Recherche d'une session inconnue (sessions.ensure) : 5 s au plus (§3.10 point 2). */
export const SESSION_LOOKUP_TIMEOUT_MS = 5_000;
/** Refus Simple en cours au plus ; au-delà, la demande reste à l'utilisateur (rien n'est autorisé). */
export const SIMPLE_JOBS_MAX = 64;
/** Refus Simple restés « retenus » à la borne et réarmés à la réponse suivante, au plus. */
export const SIMPLE_RETAINED_MAX = 200;
/** Consigne lue au plus (caractères) ; au-delà : illisible, refusée. */
export const PROMPT_SCAN_MAX = 100_000;
/** Références @ vérifiées au plus dans une consigne ; au-delà : illisible, refusée. */
export const PROMPT_REFS_MAX = 64;
const PATTERNS_MAX = 50;
const CALL_ID_MAX_LENGTH = 512;
const PROMPT_MAX_LENGTH = 1_000_000;

// --- Cibles internes --------------------------------------------------------------------------------------------------------------

/** Assistants natifs d'opencode réservés à son fonctionnement (§3.14) : jamais délégables. */
export const INTERNAL_NATIVE_TARGETS: readonly string[] = ["compaction", "title", "summary"];

/** Cible interne (§3.14) : agents du cockpit (`cockpit-*`, dont cockpit-classifier et cockpit-controle) et natifs réservés. */
export function isInternalTarget(name: string): boolean {
  return name.startsWith("cockpit-") || INTERNAL_NATIVE_TARGETS.includes(name);
}

// --- Consigne --------------------------------------------------------------------------------------------------------------------

/** Même motif que FILE_REFERENCE de http.ts (FILE_REGEX d'opencode 1.18.30) ; task-once-guard.test.ts compare les deux sources. */
export const FILE_REFERENCE = /(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/g;

/**
 * Risque trouvé dans la consigne d'une délégation (DelegationFacts.promptRisk) : « illisible » (absente, trop longue, trop de
 * références), « commande » (!`…`), « url », « arobase-fichier » (@jeton qui résout un fichier ou dossier existant, ou invérifiable :
 * ~, hors du workspace) ; puis, pour D3 seulement (§4.7, délégation automatique de L10e) : « tilde », « parent » (..),
 * « chemin-absolu ». Le premier trouvé, dans cet ordre.
 */
export type PromptRiskCode = "illisible" | "commande" | "url" | "arobase-fichier" | "tilde" | "parent" | "chemin-absolu";

/** Risques qui font refuser la garde du « once » (§3.14) ; les autres ne comptent que pour D3 (L10e). */
export const GUARD_PROMPT_RISKS: ReadonlySet<string> = new Set<PromptRiskCode>(["illisible", "commande", "url", "arobase-fichier"]);

const COMMAND_RE = /!\s*`/;
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.[a-z0-9-]+\./i;
const TILDE_RE = /(?:^|[^\w~])~/;
const PARENT_RE = /(?:^|[\s"'`(=:/\\])\.\.(?=[/\\\s"'`)]|$)/;
const ABSOLUTE_RE = /(?:^|[\s"'`(=])(?:\/(?![/\s])|[A-Za-z]:[\\/])/;

/** Référence @ : true = fichier ou dossier existant, false = rien à ce chemin, null = invérifiable (compte comme existante). */
export type RefResolver = (ref: string) => Promise<boolean | null>;

/** Premier risque de la consigne (voir PromptRiskCode), null si aucun. */
export async function promptRiskOf(prompt: unknown, resolve: RefResolver): Promise<PromptRiskCode | null> {
  if (typeof prompt !== "string" || prompt.length > PROMPT_SCAN_MAX) return "illisible";
  if (COMMAND_RE.test(prompt)) return "commande";
  if (URL_RE.test(prompt)) return "url";
  const refs = new Set<string>();
  for (const match of prompt.matchAll(FILE_REFERENCE)) {
    const ref = match[1] ?? "";
    if (ref !== "") refs.add(ref);
    if (refs.size > PROMPT_REFS_MAX) return "illisible";
  }
  for (const ref of refs) if ((await resolve(ref)) !== false) return "arobase-fichier";
  if (TILDE_RE.test(prompt)) return "tilde";
  if (PARENT_RE.test(prompt)) return "parent";
  if (ABSOLUTE_RE.test(prompt)) return "chemin-absolu";
  return null;
}

/**
 * Résolution d'un @jeton comme opencode (session/prompt.ts, resolvePromptParts) : ~ = dossier personnel d'opencode (invérifiable),
 * chemin absolu tel quel, sinon depuis le dossier git du répertoire (projects.opencodeWorktree, « / » hors dépôt). Seul un chemin du
 * workspace monté est regardé sur le disque (lecture de ses métadonnées, jamais de son contenu) ; tout autre chemin est invérifiable.
 */
export function workspaceRefResolver(projects: Cockpit11["projects"], directory: string | null): RefResolver {
  let worktree: Promise<string | null> | null = null;
  return async (ref) => {
    if (ref.startsWith("~")) return null;
    worktree ??= projects.opencodeWorktree(directory ?? projects.opencodeRoot).catch(() => null);
    const base = await worktree;
    if (base === null) return null;
    const target = ref.startsWith("/") ? path.posix.normalize(ref) : path.posix.resolve(base, ref);
    const local = projects.toLocalPath(target);
    if (local === null) return null;
    try {
      await fs.stat(local);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ENOTDIR" ? false : null;
    }
  };
}

// --- « Après votre accord » (§6 l.1048) ------------------------------------------------------------------------------------------

/**
 * Sort d'une délégation vers `target` d'après les règles effectives de l'assistant qui délègue (F-a : la dernière règle `task`
 * correspondante l'emporte, défaut « ask ») : « apres-accord » (demande d'autorisation), « sans-confirmation » (allow), « refusee »
 * (deny, opencode refuse sans demander). Même évaluation que opencode (parité testée).
 */
export type DelegationAccord = "apres-accord" | "sans-confirmation" | "refusee";

export function delegationAccord(callerRules: readonly Rule[], target: string): DelegationAccord {
  const action = evaluate(callerRules, "task", target);
  return action === "allow" ? "sans-confirmation" : action === "deny" ? "refusee" : "apres-accord";
}

/** Permissions comparées dans la carte détaillée du mode Avancé. */
export const COMPARED_PERMISSIONS: readonly string[] = ["read", "edit", "bash", "webfetch", "websearch", "task", "external_directory"];

/**
 * Droits comparés de l'appelant et de la cible (règles effectives de GET /agent, sans le plancher de la conversation, qui ne pose que
 * des refus) : pour `task`, l'appelant est évalué sur le nom de la cible (delegationAccord) ; la cible reçoit les refus d'un enfant
 * (F-f : todowrite et task refusés, sauf règle propre de l'assistant).
 */
export function comparedRights(
  callerRules: readonly Rule[] | null,
  targetRules: readonly Rule[] | null,
  targetName: string | null,
): DelegationDetailsView["droits"] {
  const childRules =
    targetRules === null
      ? null
      : [
          ...targetRules,
          ...["todowrite", "task"]
            .filter((permission) => !targetRules.some((rule) => rule.permission === permission))
            .map((permission): Rule => ({ permission, pattern: "*", action: "deny" })),
        ];
  return COMPARED_PERMISSIONS.map((permission) => ({
    permission,
    appelant: callerRules === null ? null : (evaluate(callerRules, permission, permission === "task" && targetName !== null ? targetName : "*") as RuleActionLite),
    cible: childRules === null ? null : (evaluate(childRules, permission, "*") as RuleActionLite),
  }));
}

// --- Lectures (entrées externes, vérifiées) ---------------------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const nameOf = (value: unknown): string | null => (typeof value === "string" && NAME_RE.test(value) ? value : null);

/** Demande d'autorisation lue dans GET /permission. */
export interface TaskPermission {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  /** null : sans appel d'outil, ou champ illisible (rien n'est vérifiable). */
  tool: { messageID: string; callID: string } | null;
}

function toTaskPermission(item: Record<string, unknown>): TaskPermission {
  const { id, sessionID, permission } = item;
  if (typeof id !== "string" || !ID_RE.test(id) || typeof sessionID !== "string" || !ID_RE.test(sessionID)) {
    throw new Error("demande d'autorisation illisible");
  }
  if (typeof permission !== "string" || !/^[a-z_]{1,32}$/.test(permission)) throw new Error("demande d'autorisation illisible");
  const patterns = Array.isArray(item.patterns)
    ? item.patterns.filter((p): p is string => typeof p === "string" && p.length <= 1_000).slice(0, PATTERNS_MAX)
    : [];
  const rawTool = item.tool;
  const tool =
    isRecord(rawTool) &&
    typeof rawTool.messageID === "string" &&
    ID_RE.test(rawTool.messageID) &&
    typeof rawTool.callID === "string" &&
    rawTool.callID.length > 0 &&
    rawTool.callID.length <= CALL_ID_MAX_LENGTH
      ? { messageID: rawTool.messageID, callID: rawTool.callID }
      : null;
  return { id, sessionID, permission, patterns, metadata: isRecord(item.metadata) ? item.metadata : {}, tool };
}

/** Demande `id` encore en attente dans le dossier, null si absente ; erreur si opencode ne répond pas ou répond autre chose. */
export async function readPermission(client: Pick<OpencodeClient, "request">, directory: string | null, id: string): Promise<TaskPermission | null> {
  const list = await client.request<unknown>("GET", "/permission", { query: { directory }, timeoutMs: GUARD_REQUEST_TIMEOUT_MS });
  if (!Array.isArray(list)) throw new Error("liste des demandes d'autorisation illisible");
  const item = list.find((entry) => isRecord(entry) && entry.id === id);
  return isRecord(item) ? toTaskPermission(item) : null;
}

interface ToolCall {
  /** IA du message qui délègue (celle de l'enfant si la cible n'en fixe pas, task.ts:196-215). */
  model: { providerID: string; modelID: string; variant: string | null } | null;
  /** Assistant du message qui délègue. */
  agent: string | null;
  /** state.input de la partie `task` (prompt, subagent_type, task_id…), null si illisible. */
  input: Record<string, unknown> | null;
}

/** Message qui a posé la demande et sa partie `task` ; null si le message n'existe plus (404) ; erreur sinon. */
async function readToolCall(client: Pick<OpencodeClient, "request">, request: TaskPermission, directory: string | null): Promise<ToolCall | null> {
  if (request.tool === null) return null;
  let message: unknown;
  try {
    message = await client.request<unknown>(
      "GET",
      `/session/${encodeURIComponent(request.sessionID)}/message/${encodeURIComponent(request.tool.messageID)}`,
      { query: { directory }, timeoutMs: GUARD_REQUEST_TIMEOUT_MS },
    );
  } catch (err) {
    if (err instanceof OpencodeError && err.status === 404) return null;
    throw err;
  }
  if (!isRecord(message) || !isRecord(message.info) || !Array.isArray(message.parts)) throw new Error("message de la demande illisible");
  const info = message.info;
  const providerID = typeof info.providerID === "string" && info.providerID.length > 0 && info.providerID.length <= 100 ? info.providerID : null;
  const modelID = typeof info.modelID === "string" && info.modelID.length > 0 && info.modelID.length <= 200 ? info.modelID : null;
  const variant = typeof info.variant === "string" && info.variant.length > 0 && info.variant.length <= 64 ? info.variant : null;
  const callID = request.tool.callID;
  const part = message.parts.find((p) => isRecord(p) && p.type === "tool" && p.callID === callID && p.tool === "task");
  const state = isRecord(part) && isRecord(part.state) ? part.state : null;
  return {
    model: info.role === "assistant" && providerID !== null && modelID !== null ? { providerID, modelID, variant } : null,
    agent: nameOf(info.agent),
    input: state && isRecord(state.input) ? state.input : null,
  };
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

/** Session suivie avec sa lignée (comme sessions.ensure), sinon recherchée chez opencode, 5 s au plus ; undefined si introuvable. */
async function knownSession(c11: Pick<Cockpit11, "sessions">, id: string, directory: string | null): Promise<SessionRow | undefined> {
  const row = c11.sessions.get(id);
  if (row && (row.parent_id === null || c11.sessions.get(row.parent_id))) return row;
  return bounded(
    c11.sessions.ensure(id, directory ?? undefined).catch(() => undefined),
    SESSION_LOOKUP_TIMEOUT_MS,
  );
}

/** Racine de la conversation d'une session (null si introuvable). */
export async function rootOfSession(c11: Pick<Cockpit11, "sessions">, sessionId: string, directory: string | null): Promise<string | null> {
  if (!ID_RE.test(sessionId)) return null;
  return (await knownSession(c11, sessionId, directory))?.root_id ?? null;
}

// --- Demande en cours : début, dépense, délégations lancées -----------------------------------------------------------------------

/**
 * Début de la demande en cours d'une conversation (« un message envoyé et tout ce qu'il déclenche ») : demande d'autonomie en cours
 * (ports.requests, L10a), sinon dernier envoi du proxy à la racine (ligne chat_turns écrite AVANT le relais : message, raccourci ou
 * résumé), comme la surveillance des délégations (L1e). Un message que le cockpit n'a pas relayé (ligne prompts du flux, message
 * synthétique d'opencode) n'ouvre jamais une nouvelle demande : il remettrait les compteurs à zéro. 0 si aucun envoi : tout
 * l'historique compte, un plafond plus strict, jamais plus lâche.
 */
export function demandStart(c11: Pick<Cockpit11, "db" | "ports">, rootId: string): number {
  const current = c11.ports.requests.current(rootId);
  if (current !== null && current.endedAt === null) return current.startedAt;
  const row = c11.db.prepare("SELECT MAX(created_at) AS t FROM chat_turns WHERE session_id = ?").get(rootId) as { t: number | null } | undefined;
  return typeof row?.t === "number" && Number.isFinite(row.t) ? row.t : 0;
}

/** États d'une délégation lancée (comptée au plafond par demande). */
export const LAUNCHED_DELEGATION_STATES: readonly string[] = ["autorisee", "travaille", "terminee", "arretee"];

/** Délégations lancées dans la conversation depuis `since` (table delegations, lecture seule : ports.facts.work en est l'écrivain). */
export function launchedDelegations(db: DatabaseSync, rootId: string, since: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM delegations WHERE root_id = ? AND created_at >= ? AND state IN (${LAUNCHED_DELEGATION_STATES.map(() => "?").join(", ")})`,
    )
    .get(rootId, since, ...LAUNCHED_DELEGATION_STATES) as { n: number };
  return row.n;
}

interface AgentMeta {
  title: string | null;
  size: TaskSize;
}

/** Titre d'assistant et taille de demande (item_meta, lecture seule) ; taille M par défaut (§4.7, D7). */
function agentMeta(db: DatabaseSync, name: string): AgentMeta {
  const row = db.prepare("SELECT title, task_size FROM item_meta WHERE kind = 'agents' AND name = ?").get(name) as
    | { title: unknown; task_size: unknown }
    | undefined;
  const size = (TASK_SIZES as readonly unknown[]).includes(row?.task_size) ? (row?.task_size as TaskSize) : "M";
  return { title: typeof row?.title === "string" && row.title !== "" ? row.title : null, size };
}

// --- Inspection d'une délégation ---------------------------------------------------------------------------------------------------

/** Faits d'une délégation en attente et ce qu'il faut pour les refus et la carte détaillée. */
export interface DelegationInspection {
  ref: DelegationRequestRef;
  /** Demande `task` encore en attente de cette conversation ; null : demande morte (répondue, retirée, autre conversation). */
  request: TaskPermission | null;
  targetName: string | null;
  target: OcAgentInfo | null;
  caller: OcAgentInfo | null;
  /** IA de l'enfant (« fournisseur/IA ») : celle de la cible, sinon celle du message qui délègue ; null si illisible. */
  model: string | null;
  /** Code du garde-fou budgétaire quand il refuse. */
  budgetCode: "budget-exhausted" | "expensive-model" | null;
  spentUsd: number;
  /** Plafonds par demande du travail délégué (réglages budget.delegation). */
  caps: { delegationsMax: number; plafondUsd: number };
  facts: DelegationFacts;
}

export interface InspectOptions {
  /** Demande déjà lue (crochet, route des détails) ; absente : lue dans GET /permission. */
  request?: TaskPermission | null;
  /** x-cockpit-confirm: 1 d'un humain : le garde-fou budgétaire est confirmé (jamais par l'autonomie, P5). */
  confirmed?: boolean;
}

/**
 * Relève les faits d'une délégation (`task`) en attente de la conversation `ref.rootId` : cible (GET /agent), task_id, consigne lue
 * dans la partie d'outil, IA (cible, sinon message qui délègue) autorisée et au catalogue, garde-fou budgétaire, délégations lancées et
 * dépense depuis le début de la demande. `remainingUsd` : le plus petit reste des plafonds de coût qui s'appliquent (budget.delegation,
 * puis plafond de la demande d'autonomie en cours) ; `estimateUsd` : coût de la taille de la cible (M par défaut) sur son IA, Infinity
 * si inconnu (D7 ne passe jamais). Lève si opencode ne répond pas.
 */
export async function inspectDelegation(c11: Cockpit11, ref: DelegationRequestRef, options: InspectOptions = {}): Promise<DelegationInspection> {
  const read = options.request !== undefined ? options.request : await readPermission(c11.client, ref.directory, ref.permissionId);
  const request = read !== null && read.id === ref.permissionId && read.permission === "task" && read.sessionID === ref.sessionId ? read : null;
  const call = request ? await readToolCall(c11.client, request, ref.directory) : null;
  const input = call?.input ?? null;
  const targetName = nameOf(input?.subagent_type) ?? nameOf(request?.metadata.subagent_type) ?? nameOf(request?.patterns[0]);

  const snapshot: OcLookupSnapshot = await c11.lookup.get(ref.directory);
  const target = targetName === null ? null : (snapshot.agents.find((agent) => agent.name === targetName) ?? null);
  const callerName = call?.agent ?? c11.sessions.get(ref.sessionId)?.agent ?? null;
  const caller = callerName === null ? null : (snapshot.agents.find((agent) => agent.name === callerName) ?? null);

  const model = target?.model ? modelKey(target.model) : call?.model ? modelKey(call.model) : null;
  const variant = target?.model ? (target.variant ?? null) : (call?.model?.variant ?? null);
  const lite = c11.catalog.lite();
  const modelAllowed = model !== null && c11.env.allowedProviders.includes(providerOf(model)) && catalogEntry(lite, model) !== undefined;

  const meta = targetName === null ? null : agentMeta(c11.db, targetName);
  const size: TaskSize = meta?.size ?? "M";
  let budgetCode: DelegationInspection["budgetCode"] = null;
  if (model !== null) {
    const run: Run = { role: "delegue", model, variant, source: "assistant-delegue", ...(targetName === null ? {} : { agent: targetName }) };
    const refusal = c11.ledger.guardRuns([run], options.confirmed === true, {
      command: null,
      modelName: (key) => modelName(key, lite),
      tierOfModel: (key) => c11.tiers.tierOfModel(key),
      size,
    });
    if (refusal !== null) budgetCode = refusal.code === "budget-exhausted" ? "budget-exhausted" : "expensive-model";
  }

  const taskId = input !== null && typeof input.task_id === "string" && input.task_id !== "" ? input.task_id : null;
  const taskIdInTree = taskId === null ? null : await taskIdInConversation(c11, taskId, ref);
  const promptRisk = request === null ? "illisible" : await promptRiskOf(input?.prompt, workspaceRefResolver(c11.projects, ref.directory));

  const start = demandStart(c11, ref.rootId);
  const spentUsd = c11.ledger.spentSince(ref.rootId, start);
  const delegationsSoFar = launchedDelegations(c11.db, ref.rootId, start);
  const { maxPerRequest, maxUsdPerRequest } = c11.settings.get().budget.delegation;
  let remainingUsd = maxUsdPerRequest - spentUsd;
  const current = c11.ports.requests.current(ref.rootId);
  if (current !== null && current.endedAt === null) remainingUsd = Math.min(remainingUsd, current.plafonds.plafondUsd - c11.ports.requests.spent(current.id));
  const cost = model === null ? null : c11.tiers.taskCost(model);
  const estimate = cost ? cost[size] : null;

  return {
    ref,
    request,
    targetName,
    target,
    caller,
    model,
    budgetCode,
    spentUsd,
    caps: { delegationsMax: maxPerRequest, plafondUsd: maxUsdPerRequest },
    facts: {
      target: target === null ? null : { name: target.name, mode: target.mode, internal: isInternalTarget(target.name) },
      taskIdInTree,
      promptRisk,
      modelAllowed,
      guardAccepts: model !== null && budgetCode === null,
      delegationsSoFar,
      estimateUsd: typeof estimate === "number" && Number.isFinite(estimate) && estimate >= 0 ? estimate : Number.POSITIVE_INFINITY,
      remainingUsd,
    },
  };
}

/**
 * task_id dans l'arbre (D2) : une session de travail délégué de cette conversation (usage « chat », non supprimée), ni la racine
 * (parent_id null) ni la session qui délègue elle-même (reprise impossible sans casser le tour en cours).
 */
async function taskIdInConversation(c11: Cockpit11, taskId: string, ref: DelegationRequestRef): Promise<boolean> {
  if (!ID_RE.test(taskId) || taskId === ref.sessionId) return false;
  const row = await knownSession(c11, taskId, ref.directory);
  return row !== undefined && row.root_id === ref.rootId && row.parent_id !== null && row.purpose === "chat" && row.deleted_at === null;
}

/**
 * Refus de la garde du « task once » (§3.14), dans l'ordre de la spécification, null si aucun : demande morte ; cible inconnue,
 * principale ou interne ; task_id hors de l'arbre ; consigne à risque (GUARD_PROMPT_RISKS) ; IA hors fournisseurs autorisés ou hors
 * catalogue ; garde-fou budgétaire ; plafond par demande atteint (nombre, coût).
 */
export function guardRefusal(inspection: Pick<DelegationInspection, "request" | "facts" | "caps">): DelegationRefusalCode | null {
  const { request, facts, caps } = inspection;
  if (request === null) return "demande-morte";
  if (facts.target === null || facts.target.mode === "primary" || facts.target.internal) return "cible-refusee";
  if (facts.taskIdInTree === false) return "task-id-hors-arbre";
  if (facts.promptRisk !== null && GUARD_PROMPT_RISKS.has(facts.promptRisk)) return "consigne-refusee";
  if (!facts.modelAllowed) return "ia-refusee";
  if (!facts.guardAccepts) return "budget-refuse";
  if (facts.delegationsSoFar >= caps.delegationsMax || facts.remainingUsd <= 0) return "plafond-atteint";
  return null;
}

/** Phrase d'un refus de la garde pour cette inspection. */
export function refusalMessage(code: DelegationRefusalCode, inspection: Pick<DelegationInspection, "budgetCode" | "spentUsd" | "caps" | "facts">): string {
  return refusDelegation(code, {
    budget: inspection.budgetCode,
    plafond: {
      delegations: inspection.facts.delegationsSoFar,
      delegationsMax: inspection.caps.delegationsMax,
      depenseUsd: inspection.spentUsd,
      plafondUsd: inspection.caps.plafondUsd,
    },
  });
}

/** Refus Simple (décision n° 4) : mode Simple, choix de la racine différent de « autonome », repli M9 désactivé. */
export function simpleRefusalApplies(mode: UiMode, choice: AutonomyChoice, repli: boolean): boolean {
  return !repli && mode === "simple" && choice !== "autonome";
}

const roundUsd = (usd: number) => Math.round(usd * 10_000) / 10_000;

/** Carte détaillée du mode Avancé (DelegationDetailsView). */
export function detailsView(c11: Pick<Cockpit11, "db">, inspection: DelegationInspection): DelegationDetailsView {
  const { ref, target, facts } = inspection;
  const title = target === null ? null : agentMeta(c11.db, target.name).title;
  return {
    rootId: ref.rootId,
    permissionId: ref.permissionId,
    sessionId: ref.sessionId,
    cible: target === null ? null : { nom: target.name, titre: title ?? target.name, mode: target.mode, interne: isInternalTarget(target.name) },
    ia: { model: inspection.model, disponible: facts.modelAllowed },
    estimationUsd: Number.isFinite(facts.estimateUsd) ? roundUsd(facts.estimateUsd) : null,
    droits: comparedRights(inspection.caller?.permission ?? null, target?.permission ?? null, inspection.targetName),
    compteurs: {
      delegations: facts.delegationsSoFar,
      delegationsMax: inspection.caps.delegationsMax,
      depenseUsd: roundUsd(inspection.spentUsd),
      plafondUsd: inspection.caps.plafondUsd,
    },
    refus: guardRefusal(inspection),
  };
}

/** collectDelegationFacts : la demande n'est plus en attente dans cette conversation (répondue, retirée, autre conversation). */
export class DelegationGoneError extends Error {
  override name = "DelegationGoneError";

  constructor() {
    super("délégation : demande d'autorisation plus en attente dans cette conversation");
  }
}

// --- Module --------------------------------------------------------------------------------------------------------------------

export interface TaskGuardOptions {
  /** Repli M9 (défaut REPLI_ATTENTE_SIMPLE) : aucun refus Simple, la délégation attend votre accord. */
  repliAttenteSimple?: boolean;
  now?: () => number;
}

interface SimpleJob {
  permissionId: string;
  sessionId: string;
  directory: string | null;
  target: string | null;
}

export interface TaskGuard {
  port: TaskGuardPort;
  hook: HookSignatures["beforeOnceRelay"];
  derivation: EventDerivation;
  /** Refus Simple en cours et refus retenus à la borne (tests, Diagnostic). */
  simpleState(): { running: string[]; retained: string[] };
}

export function createTaskGuard(c11: Cockpit11, options: TaskGuardOptions = {}): TaskGuard {
  const repli = options.repliAttenteSimple ?? REPLI_ATTENTE_SIMPLE;
  const now = options.now ?? Date.now;
  const simpleApplies = (rootId: string): boolean =>
    simpleRefusalApplies(c11.settings.get().ui.mode, c11.ports.conversationAutonomy.choiceOf(rootId), repli);

  // --- Port --------------------------------------------------------------------------------------------------------------------

  const port: TaskGuardPort = {
    async details(rootId, permissionId) {
      if (!SESSION_ID_RE.test(rootId) || !ID_RE.test(permissionId)) return null;
      const root = c11.sessions.get(rootId);
      if (!root || root.parent_id !== null || root.root_id !== root.id || root.deleted_at !== null || root.purpose === "classifier") return null;
      const directory = root.directory === "" ? null : root.directory;
      const request = await readPermission(c11.client, directory, permissionId);
      if (request === null || request.permission !== "task") return null;
      if ((await rootOfSession(c11, request.sessionID, directory)) !== rootId) return null;
      const inspection = await inspectDelegation(c11, { rootId, sessionId: request.sessionID, permissionId, directory }, { request });
      return detailsView(c11, inspection);
    },
    async collectDelegationFacts(ref) {
      if (!SESSION_ID_RE.test(ref.rootId) || !ID_RE.test(ref.sessionId) || !ID_RE.test(ref.permissionId)) throw new DelegationGoneError();
      if ((await rootOfSession(c11, ref.sessionId, ref.directory)) !== ref.rootId) throw new DelegationGoneError();
      const inspection = await inspectDelegation(c11, ref);
      if (inspection.request === null) throw new DelegationGoneError();
      return inspection.facts;
    },
  };

  // --- Crochet beforeOnceRelay ---------------------------------------------------------------------------------------------------

  const unverifiable = (ctx: Parameters<TaskGuard["hook"]>[0], requestId: string, err: unknown): Response => {
    c11.log.warn("travail délégué non vérifiable : « once » non relayé", { requestId, error: errorMessage(err) });
    return ctx.c.json({ error: "verification-impossible", message: verificationImpossible() }, 503);
  };

  const hook: TaskGuard["hook"] = async (ctx, requestId) => {
    let request: TaskPermission | null;
    try {
      request = await readPermission(c11.client, ctx.directory, requestId);
    } catch (err) {
      return unverifiable(ctx, requestId, err);
    }
    // Autre permission : la garde ne s'applique qu'aux délégations.
    if (request !== null && request.permission !== "task") return null;
    if (request === null) {
      c11.log.info("délégation refusée par la garde", { requestId, refus: "demande-morte" });
      return ctx.c.json({ error: "delegation-refusee", message: refusDelegation("demande-morte") }, 409);
    }
    const rootId = await rootOfSession(c11, request.sessionID, ctx.directory);
    if (rootId === null) return unverifiable(ctx, requestId, new Error("conversation de la demande inconnue"));
    if (simpleApplies(rootId)) {
      c11.log.info("délégation refusée : mode Simple", { requestId, rootId });
      return ctx.c.json({ error: "delegation-refusee", message: avisSimple() }, 409);
    }
    let inspection: DelegationInspection;
    try {
      inspection = await inspectDelegation(
        c11,
        { rootId, sessionId: request.sessionID, permissionId: requestId, directory: ctx.directory },
        { request, confirmed: ctx.c.req.header(CONFIRM_HEADER) === "1" },
      );
    } catch (err) {
      return unverifiable(ctx, requestId, err);
    }
    const code = guardRefusal(inspection);
    if (code === null) return null;
    c11.log.info("délégation refusée par la garde", { requestId, rootId, refus: code });
    return ctx.c.json({ error: "delegation-refusee", message: refusalMessage(code, inspection) }, 409);
  };

  // --- Refus Simple (dérivation) --------------------------------------------------------------------------------------------------

  const running = new Set<string>();
  const retained = new Map<string, SimpleJob>();

  const record = (job: SimpleJob, rootId: string): void => {
    const wait: WaitUpsert = { permissionId: job.permissionId, sessionId: job.sessionId, rootId, permission: "task", target: job.target };
    try {
      c11.ports.facts.work.markWait(wait, "reject", "cockpit");
    } catch (err) {
      c11.log.warn("refus Simple : attente d'accord non enregistrée", { permissionId: job.permissionId, error: errorMessage(err) });
    }
    const data: ReponseFactData = { reponse: "reject", par: "cockpit" };
    const fact: ActivityFact = { rootId, sessionId: job.sessionId, kind: "reponse", ref: job.permissionId, data, at: now() };
    try {
      c11.ports.facts.append([assertFact(fact)]);
    } catch (err) {
      c11.log.warn("refus Simple : fait non enregistré", { permissionId: job.permissionId, error: errorMessage(err) });
    }
  };

  const refuseInSimple = async (job: SimpleJob): Promise<void> => {
    const rootId = await rootOfSession(c11, job.sessionId, job.directory);
    if (rootId === null) {
      c11.log.warn("refus Simple non envoyé : conversation de la demande inconnue", { permissionId: job.permissionId });
      return;
    }
    if (!simpleApplies(rootId)) return;
    const outcome = await c11.gate.rejectWhenAlone(job.permissionId, job.sessionId, job.directory, messageRefusSimple(), "cockpit");
    if (outcome === "retenu") {
      // Une autre demande attend encore à la borne : réarmé à la prochaine réponse de cette conversation.
      retained.delete(job.permissionId);
      if (retained.size >= SIMPLE_RETAINED_MAX) retained.delete(retained.keys().next().value as string);
      retained.set(job.permissionId, job);
      return;
    }
    if (outcome === "ok") {
      c11.log.info("délégation refusée : mode Simple (l'IA continue seule)", { permissionId: job.permissionId, rootId });
      record(job, rootId);
    } else if (outcome === "echec") {
      c11.log.warn("refus Simple non relayé", { permissionId: job.permissionId });
    }
  };

  const start = (job: SimpleJob): void => {
    retained.delete(job.permissionId);
    if (running.has(job.permissionId)) return;
    if (running.size >= SIMPLE_JOBS_MAX) {
      c11.log.warn("refus Simple non lancé : trop de délégations en cours de refus, la demande attend l'utilisateur", { permissionId: job.permissionId });
      return;
    }
    running.add(job.permissionId);
    // Hors de l'appel : aucune requête ne part pendant onEvent, ni dans la file du processeur.
    queueMicrotask(() => {
      refuseInSimple(job)
        .catch((err: unknown) => c11.log.warn("refus Simple en échec", { permissionId: job.permissionId, error: errorMessage(err) }))
        .finally(() => running.delete(job.permissionId));
    });
  };

  const derivation: EventDerivation = {
    name: "taskGuard",
    onEvent(global) {
      const event = global.payload;
      const properties = isRecord(event?.properties) ? event.properties : {};
      switch (event?.type) {
        case "permission.asked": {
          if (properties.permission !== "task" || repli || c11.settings.get().ui.mode !== "simple") return;
          const permissionId = typeof properties.id === "string" && ID_RE.test(properties.id) ? properties.id : null;
          const sessionId = typeof properties.sessionID === "string" && ID_RE.test(properties.sessionID) ? properties.sessionID : null;
          if (permissionId === null || sessionId === null) return;
          const metadata = isRecord(properties.metadata) ? properties.metadata : {};
          start({ permissionId, sessionId, directory: typeof global.directory === "string" ? global.directory : null, target: nameOf(metadata.subagent_type) });
          return;
        }
        case "permission.replied": {
          const requestId = properties.requestID;
          if (typeof requestId === "string") retained.delete(requestId);
          const sessionId = properties.sessionID;
          if (typeof sessionId !== "string") return;
          for (const job of [...retained.values()]) if (job.sessionId === sessionId) start(job);
          return;
        }
        case "server.instance.disposed":
        case "global.disposed": {
          // Mesure M14 : les demandes en attente de l'instance disparaissent sans permission.replied.
          const directory = event.type === "server.instance.disposed" && typeof properties.directory === "string" ? properties.directory : null;
          for (const [id, job] of [...retained]) if (directory === null || job.directory === null || job.directory === directory) retained.delete(id);
          return;
        }
        default:
          return;
      }
    },
  };

  return {
    port,
    hook,
    derivation,
    simpleState: () => ({ running: [...running], retained: [...retained.keys()] }),
  };
}

/** Module taskGuard avec options (tests : repli M9). Production : taskGuardModule. */
export function taskGuardModuleWith(options: TaskGuardOptions = {}): Cockpit11Module {
  return {
    name: "taskGuard",
    install(reg, c11) {
      const guard = createTaskGuard(c11, options);
      c11.ports.taskGuard = guard.port;
      reg.hook("beforeOnceRelay", guard.hook);
      reg.derivation(guard.derivation);
      reg.routes("delegations", (app) => registerDelegationRoutes(app, c11));
    },
  };
}

export const taskGuardModule: Cockpit11Module = taskGuardModuleWith();
