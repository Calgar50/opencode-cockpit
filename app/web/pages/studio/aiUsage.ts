// « Quelle IA sera utilisée ? » dans le Studio : prédiction calculée par le même résolveur que le chat et le proxy
// (server/shared/assistant-rules.ts), sur les agents et raccourcis d'opencode et le brouillon en cours.
import {
  type AgentLite,
  type CatalogLite,
  type CommandLite,
  DEFAULT_TIERS,
  MESSAGES,
  modelKey,
  modelName,
  parseModelKey,
  type Problem,
  problemMessage,
  resolveChatTurn,
  resolveCommandTurn,
  type Run,
  type RunSource,
  TIER_LABELS,
  type Tier,
  tierOfModel,
  type Turn,
  variantLabel,
} from "../../../server/shared/assistant-rules.ts";
import type { ModelInfo, OcAgent, OcCommand, TierView } from "../../lib/types.ts";
import { MODEL_RE, str } from "./shared.ts";

/** Liaison d'un agent ou d'un raccourci à un niveau d'IA (item_meta). */
export interface LevelBinding {
  /** Niveau lié ; null = aucun niveau (IA précise ou aucune) ; undefined = inconnu (liaison inchangée à l'enregistrement). */
  tier: Tier | null | undefined;
  setTier: (tier: Tier | null) => void;
  /** false en portée projet : seule l'IA est écrite dans le fichier, le niveau n'est pas mémorisé. */
  bindable: boolean;
}

/** Agents et raccourcis connus d'opencode (GET /agent, GET /command). null = pas encore chargés. */
export interface StudioAiData {
  agents: OcAgent[] | null;
  agentsError: unknown;
  commands: OcCommand[] | null;
  commandsError: unknown;
}

export interface UsageEnv {
  catalog: CatalogLite[];
  models: ModelInfo[];
  tiers: TierView[];
  chatDefaultTier: Tier;
  agents: AgentLite[];
}

export interface UsageLine {
  id: string;
  text: string;
  tone: "info" | "muted" | "warning" | "critical";
  problem?: Problem;
}

export type Perspective = { kind: "agent"; name: string } | { kind: "command" };

const AGENT_MODES = new Set(["primary", "subagent", "all"]);

export function agentLiteFromOc(agent: OcAgent): AgentLite {
  const lite: AgentLite = { name: agent.name, mode: agent.mode };
  if (agent.hidden) lite.hidden = true;
  if (agent.model) lite.model = { providerID: agent.model.providerID, modelID: agent.model.modelID };
  if (agent.variant) lite.variant = agent.variant;
  if (agent.permission) lite.permission = agent.permission;
  return lite;
}

/** Agent tel qu'il sera après enregistrement du brouillon (droits : ceux déjà appliqués par opencode). */
export function agentLiteFromDraft(name: string, frontmatter: Record<string, unknown>, saved?: AgentLite): AgentLite {
  const mode = str(frontmatter.mode);
  const lite: AgentLite = { name, mode: AGENT_MODES.has(mode) ? (mode as AgentLite["mode"]) : "all" };
  if (frontmatter.hidden === true) lite.hidden = true;
  const model = str(frontmatter.model);
  if (MODEL_RE.test(model)) lite.model = parseModelKey(model);
  const variant = str(frontmatter.variant);
  if (variant) lite.variant = variant;
  if (saved?.permission) lite.permission = saved.permission;
  return lite;
}

export function commandLiteFromDraft(name: string, frontmatter: Record<string, unknown>): CommandLite {
  const command: CommandLite = { name, source: "command" };
  const agent = str(frontmatter.agent);
  if (agent) command.agent = agent;
  const model = str(frontmatter.model);
  if (MODEL_RE.test(model)) command.model = model;
  const variant = str(frontmatter.variant);
  if (variant) command.fileVariant = variant;
  if (typeof frontmatter.subtask === "boolean") command.subtask = frontmatter.subtask;
  return command;
}

export function commandLiteFromOc(command: OcCommand): CommandLite {
  const lite: CommandLite = { name: command.name, source: command.source ?? "command" };
  if (command.agent) lite.agent = command.agent;
  if (command.model && MODEL_RE.test(command.model)) lite.model = command.model;
  if (typeof command.subtask === "boolean") lite.subtask = command.subtask;
  return lite;
}

/** Niveau dont ce modèle est l'IA résolue sur ce poste, sinon null. */
export function tierOf(model: string, env: Pick<UsageEnv, "models" | "tiers">): Tier | null {
  const info = env.models.find((m) => m.key === model);
  return info?.tier ?? tierOfModel(model, Object.fromEntries(env.tiers.map((t) => [t.id, { model: t.model }])));
}

/** « Claude Sonnet 5 (Équilibré) » ou « GPT-5.5 ». */
export function iaText(model: string, env: Pick<UsageEnv, "catalog" | "models" | "tiers">): string {
  const tier = tierOf(model, env);
  return `${modelName(model, env.catalog)}${tier ? ` (${TIER_LABELS[tier]})` : ""}`;
}

/** Niveau des nouvelles conversations et son IA résolue (ou prévue si le catalogue n'est pas chargé). */
export function chatLevel(env: Pick<UsageEnv, "tiers" | "chatDefaultTier">): { tier: Tier; view: TierView | undefined; model: string } {
  const view = env.tiers.find((t) => t.id === env.chatDefaultTier);
  const model = view?.model ?? view?.plannedModel ?? DEFAULT_TIERS[env.chatDefaultTier].candidates[0] ?? "";
  return { tier: env.chatDefaultTier, view, model };
}

/** « Équilibré par défaut : Claude Sonnet 5 » */
export function conversationLevelText(env: Pick<UsageEnv, "tiers" | "chatDefaultTier" | "catalog">): string {
  const { tier, view } = chatLevel(env);
  const label = TIER_LABELS[tier];
  if (!view?.model) return `${label} par défaut, aucune IA disponible`;
  return `${label} par défaut : ${view.modelName ?? modelName(view.model, env.catalog)}`;
}

/** Conversation de référence : Assistant général (build) sur le niveau par défaut. */
function chatContext(env: UsageEnv): { chatAgent: AgentLite; chatTurn: Turn } {
  const level = chatLevel(env);
  const build = env.agents.find((a) => a.name === "build" && a.mode !== "subagent");
  const chatAgent: AgentLite = build ?? { name: "build", mode: "primary" };
  const chatTurn = resolveChatTurn({
    agent: chatAgent,
    tierModel: parseModelKey(level.model),
    tierVariant: level.view?.variant ?? null,
    allowOverride: false,
    catalog: env.catalog,
  });
  return { chatAgent, chatTurn };
}

function isChatSource(source: RunSource): boolean {
  return source === "niveau" || source === "assistant" || source === "choix-avance";
}

function reflexionText(run: Run): string {
  if (!run.variant) return "";
  const label = variantLabel(run.variant, true);
  return `, ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

function runText(run: Run, perspective: Perspective, env: UsageEnv): string {
  const ia = iaText(run.model, env);
  const reflexion = reflexionText(run);
  switch (run.source) {
    case "raccourci":
      return `${ia}, imposée par ${perspective.kind === "command" ? "ce raccourci" : "le raccourci"}${reflexion}`;
    case "assistant-du-raccourci":
      return perspective.kind === "agent" && run.agent === perspective.name
        ? `${ia}, imposée par cet assistant${reflexion}`
        : `${ia}, imposée par l'agent « ${run.agent ?? ""} »${reflexion}`;
    case "assistant-delegue":
      return perspective.kind === "command" && run.agent
        ? `${ia}, imposée par l'assistant délégué « ${run.agent} »${reflexion}`
        : `${ia}, imposée par l'assistant délégué${reflexion}`;
    default:
      return `l'IA de la conversation${reflexion}`;
  }
}

/** Problèmes du résolveur en français ; `ignoreModel` écarte l'indisponibilité propre à la conversation de référence. */
function problemLines(turn: Turn, env: UsageEnv, prefix: string, ignoreModel: string | null): UsageLine[] {
  const names = { modelName: (model: string) => modelName(model, env.catalog) };
  return turn.problems
    .filter((p) => !(p.code === "ia-indisponible" && ignoreModel !== null && p.model === ignoreModel))
    .map((p, i) => ({ id: `${prefix}-${p.code}-${i}`, text: problemMessage(p, names), tone: p.blocking ? "critical" : "warning", problem: p }));
}

export interface CommandUsage {
  lines: UsageLine[];
  delegated: boolean;
  /** L'IA dépend de la conversation (assistant choisi ou niveau). */
  chatDerived: boolean;
}

/** « Raccourci /revue (délégué) : Claude Opus 5, imposée par l'assistant délégué, + reprise dans la conversation. » */
export function commandUsage(command: CommandLite, env: UsageEnv, perspective: Perspective): CommandUsage {
  const { chatAgent, chatTurn } = chatContext(env);
  const turn = resolveCommandTurn({ command, agents: env.agents, chatAgent, chatTurn, catalog: env.catalog });
  const delegue = turn.runs.find((r) => r.role === "delegue");
  const main = delegue ?? turn.runs.find((r) => r.role === "raccourci");
  const lines: UsageLine[] = [];
  if (main) {
    lines.push({
      id: `cmd-${command.name}`,
      tone: "info",
      text: `Raccourci /${command.name}${delegue ? " (délégué)" : ""} : ${runText(main, perspective, env)}${delegue ? ", + reprise dans la conversation" : ""}.`,
    });
  }
  lines.push(...problemLines(turn, env, `cmd-${command.name}`, modelKey(chatTurn.send.model)));
  return { lines, delegated: Boolean(delegue), chatDerived: main ? isChatSource(main.source) : false };
}

/** Lignes d'un agent : chat, délégation, puis chaque raccourci qui l'utilise. */
export function agentUsage(agent: AgentLite, disabled: boolean, env: UsageEnv, commands: CommandLite[]): UsageLine[] {
  if (disabled) return [{ id: "disabled", tone: "warning", text: "Désactivé : opencode ne charge pas cet agent." }];
  const lines: UsageLine[] = [];
  if (agent.mode === "subagent") {
    lines.push({ id: "chat", tone: "muted", text: "Dans le chat : absent de la liste des assistants (sous-agent)." });
  } else if (agent.hidden) {
    lines.push({ id: "chat", tone: "muted", text: "Dans le chat : absent de la liste des assistants (masqué)." });
  } else {
    const level = chatLevel(env);
    const turn = resolveChatTurn({
      agent,
      tierModel: parseModelKey(level.model),
      tierVariant: level.view?.variant ?? null,
      allowOverride: false,
      catalog: env.catalog,
    });
    const run = turn.runs[0];
    lines.push(
      run?.source === "assistant"
        ? { id: "chat", tone: "info", text: `Dans le chat : ${iaText(run.model, env)}, imposée par cet assistant${reflexionText(run)}.` }
        : { id: "chat", tone: "info", text: `Dans le chat : l'IA du niveau choisi dans la conversation (${conversationLevelText(env)}).` },
    );
    lines.push(...problemLines(turn, env, "chat", level.model));
  }
  if (agent.mode !== "primary") {
    if (agent.model) {
      // Sous-agent avec sa propre IA : elle est toujours utilisée, avec sa propre réflexion (task.ts:181-184, 209).
      const own = resolveChatTurn({ agent, tierModel: agent.model, tierVariant: null, allowOverride: false, catalog: env.catalog });
      const run = own.runs[0];
      lines.push({
        id: "task",
        tone: "info",
        text: `Par délégation : ${iaText(modelKey(agent.model), env)}, sa propre IA${run ? reflexionText(run) : ""}.`,
      });
      if (agent.mode === "subagent") lines.push(...problemLines(own, env, "task", null));
    } else {
      lines.push({ id: "task", tone: "info", text: "Par délégation : l'IA de l'agent qui délègue." });
    }
  }
  for (const command of commands) lines.push(...commandUsage(command, env, { kind: "agent", name: agent.name }).lines);
  return lines;
}

/** Note sous un raccourci dont l'IA dépend de la conversation. */
export function conversationNote(env: UsageEnv): string {
  return `IA de la conversation : celle de l'assistant choisi dans le chat, sinon le niveau de la conversation (${conversationLevelText(env)}).`;
}

export const DELEGATED_NOTE = MESSAGES.delegatedHelp;
