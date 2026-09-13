// Tour du chat côté interface : résolution (serveur, avec repli local sur le même module pur que le proxy),
// choix de l'assistant et lignes du menu « / ».
import { useEffect, useState } from "react";
import {
  BUILTIN_ASSISTANTS,
  DEFAULT_TIERS,
  describeTurn,
  formatUsd,
  hasBlockingProblem,
  modelKey,
  modelName,
  parseModelKey,
  resolveChatTurn,
  resolveCommandTurn,
  TIER_LABELS,
  toCatalogLite,
} from "../../../server/shared/assistant-rules.ts";
import { api } from "../../lib/api.ts";
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

export interface ResolveContext {
  boot: Pick<Bootstrap, "models" | "ai" | "ui" | "settings">;
  agents: OcAgent[];
  commands: OcCommand[];
  titleOf: (name: string) => string;
  sizeOf: (name: string) => TaskSize;
}

/** Agent sélectionnable dans le chat (même règle que le serveur : tout sauf les sous-agents). */
export function isChatAgent(agent: Pick<OcAgent, "mode">): boolean {
  return agent.mode !== "subagent";
}

/** Agent des nouvelles conversations : chat.defaultAgent s'il existe, sinon build. */
export function defaultAgentName(configured: string | null | undefined, agents: OcAgent[]): string {
  if (configured && (agents.length === 0 || agents.some((a) => a.name === configured && isChatAgent(a)))) return configured;
  return "build";
}

export function builtinTitle(name: string): string | null {
  return name === "build" || name === "plan" ? BUILTIN_ASSISTANTS[name].title : null;
}

export function builtinHelp(name: string): string | null {
  return name === "build" || name === "plan" ? BUILTIN_ASSISTANTS[name].help : null;
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
  const turn: Turn = command
    ? resolveCommandTurn({ command: toCommandLite(command), agents: ctx.agents.map(toAgentLite), chatAgent: agent, chatTurn, catalog })
    : chatTurn;
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
