// Tour du chat côté interface : résolution (serveur, avec repli local sur le même module pur que le proxy),
// choix de l'assistant et lignes du menu « / ». 1.1 (L5t) : fonctions pures de la transcription (repères non facturés, reprise,
// pied de tour, consigne reçue, textes d'IA bornés) et du « Prévu / Réel » du Déroulé, testées sous Node par agent-choice.test.ts.
import { useEffect, useState } from "react";
import { type ActivityState, activityStatus, type LiveRow, totals } from "../../../server/shared/activity.ts";
import { defaultAgentName, isChatAgent } from "../../../server/shared/agent-choice.ts";
import {
  builtinAssistantInfo,
  DEFAULT_TIERS,
  describeTurn,
  formatUsd,
  hasBlockingProblem,
  modelKey,
  modelName,
  parseModelKey,
  type Rule,
  resolveChatTurn,
  resolveCommandTurn,
  TIER_LABELS,
  toCatalogLite,
  withTierAvailability,
} from "../../../server/shared/assistant-rules.ts";
import { api } from "../../lib/api.ts";
import { formatUsd as formatCost, plural } from "../../lib/format.ts";
import type {
  AgentLite,
  Bootstrap,
  CommandLite,
  ModelInfo,
  OcAgent,
  OcCommand,
  OcError,
  ResolveRequest,
  ResolveResponse,
  TaskSize,
  Tier,
  Turn,
} from "../../lib/types.ts";
import type { Turn as TranscriptTurn } from "./transcript.ts";

export interface ResolveContext {
  boot: Pick<Bootstrap, "models" | "ai" | "ui" | "settings">;
  agents: OcAgent[];
  commands: OcCommand[];
  titleOf: (name: string) => string;
  sizeOf: (name: string) => TaskSize;
}

// 1.1 (T2) : isChatAgent et defaultAgentName vivent dans server/shared/agent-choice.ts (module pur testé), ré-exportés ici.
export { defaultAgentName, isChatAgent };

/** Titre d'un assistant intégré ; `permission` (règles de GET /agent) : « lecture seule » seulement si elles la garantissent. */
export function builtinTitle(name: string, permission?: readonly Rule[] | null): string | null {
  return name === "build" || name === "plan" ? builtinAssistantInfo(name, permission).title : null;
}

export function builtinHelp(name: string, permission?: readonly Rule[] | null): string | null {
  return name === "build" || name === "plan" ? builtinAssistantInfo(name, permission).help : null;
}

export function toAgentLite(agent: OcAgent): AgentLite {
  return {
    name: agent.name,
    mode: agent.mode,
    hidden: agent.hidden,
    ...(agent.model ? { model: { providerID: agent.model.providerID, modelID: agent.model.modelID } } : {}),
    ...(agent.variant ? { variant: agent.variant } : {}),
    ...(agent.permission ? { permission: agent.permission } : {}),
  };
}

export function toCommandLite(command: OcCommand): CommandLite {
  return {
    name: command.name,
    ...(command.agent ? { agent: command.agent } : {}),
    ...(command.model ? { model: command.model } : {}),
    ...(command.subtask !== undefined ? { subtask: command.subtask } : {}),
    ...(command.source ? { source: command.source } : {}),
  };
}

function modelInfo(models: readonly ModelInfo[], key: string): ModelInfo | undefined {
  return models.find((m) => m.key === key);
}

function tierOfModelIn(boot: ResolveContext["boot"]) {
  return (model: string): Tier | null => modelInfo(boot.models, model)?.tier ?? boot.ai.tiers.find((t) => t.model === model)?.id ?? null;
}

/**
 * Même calcul que POST /api/chat/resolve, sur les données de l'interface (agents de GET /agent, catalogue de l'amorçage).
 * Sert d'affichage immédiat et de repli si le serveur ne peut pas résoudre ; le proxy reste l'autorité à l'envoi.
 */
export function localResolve(req: ResolveRequest, ctx: ResolveContext): ResolveResponse {
  const { boot } = ctx;
  const catalog = toCatalogLite(boot.models);
  const chatAgents = ctx.agents.filter(isChatAgent);
  const found = chatAgents.find((a) => a.name === req.agent);
  const fallbackName = defaultAgentName(boot.settings.chat.defaultAgent, ctx.agents);
  const info = found ?? chatAgents.find((a) => a.name === fallbackName);
  // Liste d'agents pas encore chargée : on garde le nom demandé, sans IA propre connue.
  const agent: AgentLite = info ? toAgentLite(info) : { name: ctx.agents.length === 0 ? req.agent : fallbackName, mode: "primary" };
  const agentMissing = !found && ctx.agents.length > 0 ? req.agent : null;

  const tier = req.tier ?? boot.ai.chatDefaultTier;
  const view = boot.ai.tiers.find((t) => t.id === tier);
  const tierKey = view?.model ?? view?.plannedModel ?? view?.candidates[0] ?? DEFAULT_TIERS[tier].candidates[0] ?? "";
  const tierVariant = req.variant !== undefined ? req.variant : (view?.variant ?? null);
  const advanced = boot.ui.mode === "avance";
  const allowOverride = advanced && boot.ai.allowModelOverride;
  const override = advanced ? req.override : undefined;
  const chatTurn = resolveChatTurn({
    agent,
    tierModel: parseModelKey(tierKey),
    tierVariant,
    ...(override ? { override } : {}),
    allowOverride,
    catalog,
  });

  const command = req.command ? ctx.commands.find((c) => c.name === req.command) : undefined;
  const resolved: Turn = command
    ? resolveCommandTurn({ command: toCommandLite(command), agents: ctx.agents.map(toAgentLite), chatAgent: agent, chatTurn, catalog })
    : chatTurn;
  // Même règle que POST /api/chat/resolve : niveau « Indisponible », rien ne part sur l'IA prévue.
  const turn = withTierAvailability(resolved, view?.status);
  const tierOfModel = tierOfModelIn(boot);
  const display = describeTurn(turn, {
    catalog,
    agentTitle: ctx.titleOf,
    tierOfModel,
    priceOf: (model) => modelInfo(boot.models, model)?.price ?? null,
    size: ctx.sizeOf(agent.name),
    command: command ? command.name : null,
    chatTier: agent.model ? null : { id: tier, status: view?.status ?? "non-verifie", plannedModel: view?.plannedModel ?? null },
  });
  return {
    ...turn,
    agent: agent.name,
    agentTitle: ctx.titleOf(agent.name),
    agentMissing,
    tier: agent.model ? tierOfModel(modelKey(agent.model)) : tier,
    tierStatus: agent.model ? null : (view?.status ?? null),
    command: command ? command.name : null,
    delegated: display.delegated,
    bodyModel: modelKey(turn.send.model),
    display,
  };
}

/** Clé stable d'une demande de résolution (dépendance des effets). */
export function resolveKey(req: ResolveRequest | null): string {
  return req ? JSON.stringify(req) : "";
}

/** Résolution par le serveur, différée (250 ms) et annulée dès que la demande change. */
export function useServerResolve(req: ResolveRequest | null, tick: number): { data: ResolveResponse | null; error: unknown } {
  const key = resolveKey(req);
  const [state, setState] = useState<{ key: string; data: ResolveResponse | null; error: unknown }>({ key: "", data: null, error: null });
  useEffect(() => {
    if (!key) return;
    const request = JSON.parse(key) as ResolveRequest;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api.resolveChat(request, controller.signal).then(
        (data) => setState({ key, data, error: null }),
        (error: unknown) => {
          if ((error as Error | null)?.name !== "AbortError") setState({ key, data: null, error });
        },
      );
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [key, tick]);
  return state.key === key && key ? { data: state.data, error: state.error } : { data: null, error: null };
}

export interface CommandOption {
  name: string;
  label: string;
  hint: string;
}

/**
 * Lignes du menu « / » : « /revue-change · Relire un changement · Expert · ≈ 0,45 $ ».
 * Mode Simple : raccourcis seulement (les fiches sont consultées automatiquement par l'assistant).
 */
export function commandOptions(i: {
  commands: OcCommand[];
  agents: OcAgent[];
  chatTurn: Turn;
  chatAgent: string;
  boot: Pick<Bootstrap, "models" | "ai">;
  simple: boolean;
  sizeOf: (name: string) => TaskSize;
}): CommandOption[] {
  const catalog = toCatalogLite(i.boot.models);
  const agents = i.agents.map(toAgentLite);
  const chatAgent = agents.find((a) => a.name === i.chatAgent) ?? { name: i.chatAgent, mode: "primary" as const };
  const tierOf = (model: string): Tier | null => modelInfo(i.boot.models, model)?.tier ?? i.boot.ai.tiers.find((t) => t.model === model)?.id ?? null;
  return i.commands
    .filter((c) => !i.simple || c.source === undefined || c.source === "command")
    .map((c) => {
      const turn = resolveCommandTurn({ command: toCommandLite(c), agents, chatAgent, chatTurn: i.chatTurn, catalog });
      const main = turn.runs.find((r) => r.role === "raccourci" || r.role === "delegue");
      const parts: string[] = [];
      if (c.description) parts.push(c.description);
      if (main) {
        const tier = tierOf(main.model);
        parts.push(tier ? TIER_LABELS[tier] : modelName(main.model, catalog));
        const size = i.sizeOf(main.agent ?? i.chatAgent);
        let total: number | null = 0;
        for (const run of turn.runs) {
          const cost = modelInfo(i.boot.models, run.model)?.taskCost?.[size];
          total = cost === undefined || total === null ? null : total + cost;
        }
        if (total !== null && turn.runs.length > 0) parts.push(`≈ ${formatUsd(total)}`);
      }
      if (hasBlockingProblem(turn)) parts.push("indisponible avec cet assistant");
      return { name: c.name, label: `/${c.name}`, hint: parts.join(" · ") };
    });
}

/** Erreur de session « Model not found » (IA absente du compte Copilot, prompt.ts:594-612). */
export function isModelNotFound(error: Pick<OcError, "name" | "data"> | null | undefined): boolean {
  if (!error) return false;
  const message = typeof error.data?.message === "string" ? error.data.message : "";
  return /^Model not found/i.test(message) || /ModelNotFound/.test(error.name ?? "");
}

// --- Transcription (1.1, L5t ; spécification §5.1, §5.7.3 et JP-4) ----------------------------------------------------------------

/** Longueur montrée au plus d'un texte d'IA (consigne, résultat, erreur) ; le reste est coupé et signalé. */
export const AI_TEXT_MAX = 20_000;

const char = (code: number): string => String.fromCharCode(code);
/** Séquences de terminal (couleurs) d'une sortie d'outil. */
const ANSI_SEQUENCES = new RegExp(`${char(27)}\\[[0-9;?]*[A-Za-z]`, "g");
/**
 * Caractères de commande (tabulation et fin de ligne gardées, retour chariot retiré) et contrôles de sens d'écriture, qui
 * pourraient faire lire un texte d'IA autrement qu'il n'est écrit.
 */
const HIDDEN_CHARACTERS = new RegExp(`[${char(0)}-${char(8)}${char(11)}-${char(31)}${char(127)}${char(0x202a)}-${char(0x202e)}${char(0x2066)}-${char(0x2069)}]`, "g");

/**
 * Texte d'IA à montrer tel quel (consigne, résultat, erreur, titre) : rendu en texte par React, donc échappé, jamais interprété comme
 * du HTML ni du Markdown ; séquences de terminal et caractères cachés retirés ; longueur bornée à `max` (`clipped` : coupé).
 */
export function boundedAiText(value: unknown, max = AI_TEXT_MAX): { text: string; clipped: boolean } {
  const clean = (typeof value === "string" ? value : "").replace(ANSI_SEQUENCES, "").replace(HIDDEN_CHARACTERS, "");
  if (clean.length <= max) return { text: clean, clipped: false };
  // Jamais une moitié de caractère double (émoji) en fin de coupe.
  const high = clean.charCodeAt(max - 1);
  return { text: clean.slice(0, high >= 0xd800 && high <= 0xdbff ? max - 1 : max), clipped: true };
}

/** Nom d'assistant délégué affiché au plus (valeur venue d'opencode). */
const DELEGATED_NAME_MAX = 64;

/**
 * Nom d'un travail délégué en mode Simple (tiroir de lecture, panneau latéral) : l'assistant qui travaille, comme la liste des
 * acteurs, sinon « Travail délégué ». Jamais le titre d'opencode, « {description} (@{assistant} subagent) » en 1.18.30 : mots
 * interdits en Simple (§2.3). Le mode Avancé garde ce titre.
 */
export function delegatedWorkName(info: { readonly agent?: unknown } | null | undefined): string {
  return boundedAiText(info?.agent, DELEGATED_NAME_MAX).text.trim() || "Travail délégué";
}

/** Partie de message d'opencode, forme minimale lue par la transcription. */
interface PartShape {
  readonly type: string;
  readonly tool?: unknown;
  readonly synthetic?: unknown;
  readonly text?: unknown;
}

interface MessageShape {
  readonly parts: readonly PartShape[];
}

interface ReplyShape extends MessageShape {
  readonly info: { readonly time: { readonly created: number; readonly completed?: number }; readonly error?: unknown };
}

/** Réponse facturée : elle porte une partie step-start (un appel d'IA commencé). Même règle que le réducteur d'activité (L4c). */
export function isBilledReply(reply: MessageShape): boolean {
  return reply.parts.some((part) => part.type === "step-start");
}

/**
 * Repère non facturé (§5.1) : réponse terminée, sans erreur et sans appel d'IA (aucune partie step-start), par exemple le message
 * qui porte le travail délégué d'un raccourci. Une réponse en cours n'est pas encore un repère.
 */
export function isUnbilledMarker(reply: ReplyShape): boolean {
  return typeof reply.info.time.completed === "number" && !reply.info.error && !isBilledReply(reply);
}

/** Réponse qui confie du travail : une partie d'outil `task`. */
export function delegatesWork(reply: MessageShape): boolean {
  return reply.parts.some((part) => part.type === "tool" && part.tool === "task");
}

/**
 * Message utilisateur écrit par opencode, sans rien de vous : parties texte toutes ajoutées (synthetic), ni fichier joint ni
 * raccourci. La conversation reprend d'elle-même (par exemple après le travail délégué d'un raccourci) : la transcription montre
 * « Reprise dans la conversation » à la place d'une bulle vide.
 */
export function isAutomaticUserMessage(message: MessageShape): boolean {
  const texts = message.parts.filter((part) => part.type === "text");
  const yours = message.parts.some((part) => part.type === "file" || part.type === "subtask");
  return texts.length > 0 && texts.every((part) => part.synthetic === true) && !yours;
}

/** Longueur montrée au plus de la description d'un raccourci. */
const SHORTCUT_DESCRIPTION_MAX = 200;

/**
 * Raccourci envoyé par vous (partie subtask d'un message utilisateur, sans texte) : « /revue-croisee · description », au lieu d'une
 * bulle vide ; texte borné, rendu en texte.
 */
export function shortcutLabel(part: { readonly command?: unknown; readonly description?: unknown }): string {
  const command = typeof part.command === "string" && /^[\w.-]{1,64}$/.test(part.command) ? `/${part.command}` : "";
  const description = boundedAiText(part.description, SHORTCUT_DESCRIPTION_MAX).text.trim();
  return [command, description].filter(Boolean).join(" · ") || "Raccourci";
}

/** « Reprise dans la conversation » avant la réponse `index` d'une demande : la réponse précédente a confié du travail. */
export function resumesAfterDelegation(replies: readonly MessageShape[], index: number): boolean {
  const previous = index > 0 ? replies[index - 1] : undefined;
  return previous !== undefined && delegatesWork(previous);
}

/**
 * Fenêtre d'une demande terminée, pour les totaux du réducteur d'activité : de son message (sinon de sa première réponse) jusqu'à
 * la fin de sa dernière réponse, incluse ; null tant qu'une réponse est en cours.
 */
export function turnWindow(turn: TranscriptTurn): { from: number; to: number } | null {
  const from = turn.user?.info.time.created ?? turn.replies[0]?.info.time.created;
  let end: number | null = null;
  for (const reply of turn.replies) {
    const done = reply.info.time.completed ?? (reply.info.error ? reply.info.time.created : null);
    if (done === null) return null;
    end = Math.max(end ?? done, done);
  }
  return from === undefined || end === null ? null : { from, to: end + 1 };
}

/** Coûts d'une demande pour son pied de tour (§5.1). */
export interface TurnCosts {
  /** Réponses de la conversation, plus le travail délégué et les contrôles de sécurité quand ils sont connus. */
  cost: number;
  /** Appels d'IA : réponses facturées (jamais un repère), plus ceux du travail délégué et des contrôles quand ils sont connus. */
  calls: number;
  /** Travail délégué (jamais un contrôle de sécurité) ; null : aucun, ou pas connu ici. */
  delegated: { cost: number; calls: number } | null;
  /** La demande a confié du travail dont le coût n'est pas connu ici. */
  delegatedUnknown: boolean;
}

/** Messages utilisateur dont l'origine est enregistrée (fait « origine »), par liste de faits. */
const ORIGINS = new WeakMap<ActivityState["facts"], ReadonlySet<string>>();

function recordedOrigins(activity: ActivityState): ReadonlySet<string> {
  let origins = ORIGINS.get(activity.facts);
  if (!origins) {
    origins = new Set(activity.facts.filter((fact) => fact.kind === "origine" && fact.ref !== null).map((fact) => fact.ref as string));
    ORIGINS.set(activity.facts, origins);
  }
  return origins;
}

/**
 * L'activité couvre la demande : même conversation, Déroulé entier (jamais partiel), et reconstruction complète (registre,
 * messages) ou faits enregistrés dès le message de la demande (fait « origine »). Une demande d'avant les faits d'une conversation
 * commencée avant la 1.1 n'est donc jamais comptée à moitié.
 */
function coversTurn(activity: ActivityState, turn: TranscriptTurn): boolean {
  const session = turn.user?.info.sessionID ?? turn.replies[0]?.info.sessionID;
  if (session !== activity.rootId || activityStatus(activity).partial) return false;
  if (activity.source !== "faits") return true;
  const messageId = turn.user?.info.id;
  return messageId !== undefined && recordedOrigins(activity).has(messageId);
}

/**
 * Coûts d'une demande terminée : ses réponses d'après la transcription d'opencode, plus le travail délégué et les contrôles de
 * sécurité lus dans l'activité de la conversation (réducteur L4c : appels commencés dans la fenêtre de la demande), seulement si
 * elle couvre la demande. `activity` null : tiroir d'un travail délégué, ou activité pas encore lue.
 */
export function turnCosts(turn: TranscriptTurn, activity: ActivityState | null): TurnCosts {
  let cost = 0;
  let calls = 0;
  for (const reply of turn.replies) {
    if (Number.isFinite(reply.info.cost)) cost += reply.info.cost;
    if (isBilledReply(reply)) calls++;
  }
  const window = turnWindow(turn);
  if (activity === null || window === null || !coversTurn(activity, turn)) {
    return { cost, calls, delegated: null, delegatedUnknown: turn.replies.some(delegatesWork) };
  }
  const sum = totals(activity, window);
  return {
    cost: cost + sum.delegatedCost + sum.controlCost,
    calls: calls + sum.delegatedCalls + sum.controlCalls,
    delegated: sum.delegatedCalls > 0 ? { cost: sum.delegatedCost, calls: sum.delegatedCalls } : null,
    delegatedUnknown: false,
  };
}

/** Pied de tour (§5.1) : « {coût} dont {x} $ de travail délégué · {n} appels d'IA », et le travail délégué non compté ici. */
export function turnFooterText(costs: TurnCosts): string {
  const cost = formatCost(costs.cost);
  const head = costs.delegated ? `${cost} dont ${formatCost(costs.delegated.cost)} de travail délégué` : cost;
  const parts = [head, plural(costs.calls, "appel d'IA", "appels d'IA")];
  if (costs.delegatedUnknown) parts.push("travail délégué non compté");
  return parts.join(" · ");
}

/** « Prévu » d'une ligne du Déroulé : lancé par votre demande, décidé par l'IA, contrôle du cockpit, ou inconnu faute de fait. */
export interface Planned {
  kind: "prevu" | "non-prevu" | "controle" | "inconnu";
  text: string;
}

const PLANNED_UNKNOWN: Planned = Object.freeze({ kind: "inconnu", text: "inconnu" });

/**
 * « Prévu » (§5.1) d'une ligne du Déroulé : ce que votre demande a lancé (la conversation, un raccourci), ce que l'IA a décidé
 * seule (un appel task écrit par l'IA, avec ou sans session), ou « inconnu » sans fait qui le dise (registre d'avant la 1.1, session
 * venue d'ailleurs) : une origine inconnue est dite inconnue (P12). `row` null : ligne sans acteur connu.
 */
export function plannedOf(row: Pick<LiveRow, "depth" | "role" | "source" | "commande" | "sansSession"> | null): Planned {
  if (row === null) return PLANNED_UNKNOWN;
  if (row.depth === 0) return { kind: "prevu", text: "votre demande" };
  if (row.role === "controle") return { kind: "controle", text: "contrôle du cockpit" };
  if (row.role === "etape") return { kind: "prevu", text: "étape prévue par l'équipe" };
  if (row.source === "raccourci") return { kind: "prevu", text: row.commande ? `raccourci /${row.commande}` : "raccourci" };
  if (row.source === "ia" || row.sansSession) return { kind: "non-prevu", text: "non prévu : décidé par l'IA" };
  return PLANNED_UNKNOWN;
}

/**
 * Écarts avec le prévu (§5.1) : délégations décidées par l'IA, jamais démarrées, échecs et arrêts. Un prévu inconnu n'est jamais
 * compté comme conforme : « Aucun écart avec le prévu. » n'est dit que si tout le prévu est connu.
 */
export function gapsText(counts: { nonPrevus: number; inconnus: number; jamais: number; echecs: number; arrets: number }): string {
  const parts = [
    counts.nonPrevus > 0 ? plural(counts.nonPrevus, "délégation décidée par l'IA", "délégations décidées par l'IA") : null,
    counts.jamais > 0 ? plural(counts.jamais, "délégation jamais démarrée", "délégations jamais démarrées") : null,
    counts.echecs > 0 ? plural(counts.echecs, "échec", "échecs") : null,
    counts.arrets > 0 ? plural(counts.arrets, "arrêt", "arrêts") : null,
  ].filter((part): part is string => part !== null);
  const unknown = counts.inconnus > 0 ? `Prévu inconnu pour ${plural(counts.inconnus, "délégation", "délégations")}.` : null;
  if (parts.length > 0) return [`Écarts avec le prévu : ${parts.join(" · ")}.`, unknown].filter(Boolean).join(" ");
  return unknown ?? "Aucun écart avec le prévu.";
}

/** Consigne reçue par une conversation déléguée (« Voir la consigne »). */
export interface ReceivedInstruction {
  /** Texte reçu, sans les parties ajoutées par opencode, borné (textes d'IA). */
  text: string;
  clipped: boolean;
  /** Parties ajoutées au message : textes ajoutés par opencode (synthetic) et fichiers joints. */
  added: number;
}

/**
 * « Voir la consigne » (§5.7.3, JP-4) : premier message utilisateur de la conversation déléguée, tel qu'il a été reçu, jamais la
 * seule consigne demandée par l'IA (`state.input.prompt` de la partie task). `messages` dans l'ordre de la transcription ; null :
 * aucun message utilisateur lu.
 */
export function receivedInstruction(messages: ReadonlyArray<MessageShape & { info: { role: string } }>): ReceivedInstruction | null {
  const first = messages.find((message) => message.info.role === "user");
  if (!first) return null;
  const own = first.parts.filter((part) => part.type === "text" && part.synthetic !== true);
  const added = first.parts.filter((part) => (part.type === "text" && part.synthetic === true) || part.type === "file").length;
  const { text, clipped } = boundedAiText(own.map((part) => (typeof part.text === "string" ? part.text : "")).join("\n\n").trim());
  return { text, clipped, added };
}
