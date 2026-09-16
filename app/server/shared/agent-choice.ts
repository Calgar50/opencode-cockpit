// Choix de l'assistant d'une conversation du chat, module pur partagé par l'interface (1.1, T2 ; spécification F-r, §2.2).
// Extraction à comportement constant : restoreChoices (ChatPage, réouverture d'une conversation), isChatAgent et
// defaultAgentName (déplacés de web/pages/chat/turn.ts, qui les ré-exporte). agent-choice.test.ts compare ce module à
// l'ancienne logique recopiée sur une table de cas. Suite : L5t (F-r : jamais un assistant caché ou interne).
import type { ChoicesResponse } from "./api-types.ts";
import type { Tier } from "./assistant-rules.ts";

/** Forme minimale d'un agent de GET /agent pour le choix de l'assistant. */
export interface ChoiceAgent {
  name: string;
  /** « primary », « subagent » ou « all ». */
  mode: string;
  hidden?: boolean | undefined;
}

/** Agent sélectionnable dans le chat (même règle que le serveur : tout sauf les sous-agents). */
export function isChatAgent(agent: Pick<ChoiceAgent, "mode">): boolean {
  return agent.mode !== "subagent";
}

/** Agent des nouvelles conversations : chat.defaultAgent s'il existe, sinon build. */
export function defaultAgentName(configured: string | null | undefined, agents: readonly ChoiceAgent[]): string {
  if (configured && (agents.length === 0 || agents.some((a) => a.name === configured && isChatAgent(a)))) return configured;
  return "build";
}

/** Agent connu, avec la présence d'une IA propre (branche du mode Avancé). */
export interface RestorableAgent extends ChoiceAgent {
  model?: { providerID: string; modelID: string } | null | undefined;
}

/** Message de la conversation : seul le rôle et l'assistant du message utilisateur servent. */
export interface RestorableMessage {
  info?: { role: string; agent?: string | undefined } | null | undefined;
}

export interface RestoreInput {
  /** Derniers choix enregistrés par le cockpit (GET /api/chat/choices/:id) ; null : aucun, ou lecture impossible. */
  choices: ChoicesResponse;
  /** Messages de la conversation, dans l'ordre (repli des conversations antérieures à 0.2.0). */
  messages: readonly RestorableMessage[];
  agents: readonly RestorableAgent[];
  /** chat.defaultAgent. */
  defaultAgent: string | null | undefined;
  /** Niveaux de l'amorçage (IA résolue de chaque niveau). */
  tiers: ReadonlyArray<{ id: Tier; model: string | null }>;
  chatDefaultTier: Tier;
  advanced: boolean;
  /** Catalogue de l'amorçage (clés « fournisseur/IA »). */
  models: ReadonlyArray<{ key: string }>;
}

/**
 * Choix à appliquer à la réouverture. `agent` et `tier` absents : valeur courante inchangée. `variant` et `override` sont
 * toujours appliqués (`variant` undefined : réflexion du niveau ; null : standard).
 */
export interface RestorePatch {
  agent?: string;
  tier?: Tier;
  variant: string | null | undefined;
  override: string | null;
}

/**
 * Réouverture d'une conversation : derniers choix enregistrés (jamais l'IA d'un raccourci), sinon, pour une conversation
 * antérieure à 0.2.0, l'assistant du dernier message utilisateur s'il est sélectionnable. Même résultat que l'ancien
 * restoreChoices de ChatPage (F-r : l'agent n'est pas encore filtré sur hidden ni sur les agents internes).
 */
export function pickRestorableAgent(input: RestoreInput): RestorePatch {
  const { choices, agents } = input;
  if (choices) {
    const agent = choices.agent || defaultAgentName(input.defaultAgent, agents);
    const known = agents.find((a) => a.name === choices.agent);
    const levelOfModel = input.tiers.find((t) => t.model !== null && t.model === choices.model)?.id ?? null;
    const level = levelOfModel ?? choices.tier;
    if (level) return { agent, tier: level, variant: choices.variant, override: null };
    if (input.advanced && choices.model && known && !known.model && input.models.some((m) => m.key === choices.model)) {
      // Mode Avancé : l'IA précise choisie pour un agent sans IA propre (niveau inchangé).
      return { agent, variant: choices.variant, override: choices.model };
    }
    return { agent, tier: input.chatDefaultTier, variant: undefined, override: null };
  }
  // Conversation antérieure à 0.2.0 : seul l'assistant du dernier message utilisateur est repris.
  let lastAgent: string | null = null;
  for (let i = input.messages.length - 1; i >= 0; i--) {
    const info = input.messages[i]?.info;
    if (info?.role === "user") {
      lastAgent = info.agent ?? null;
      break;
    }
  }
  const known = lastAgent ? agents.find((a) => a.name === lastAgent && isChatAgent(a)) : undefined;
  return { ...(known ? { agent: known.name } : {}), tier: input.chatDefaultTier, variant: undefined, override: null };
}
