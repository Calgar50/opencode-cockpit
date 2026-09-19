// Choix de l'assistant d'une conversation du chat, module pur partagé par l'interface (1.1, T2 puis L5t ; spécification F-r,
// §3.13 l.422, §2.2). restoreChoices (ChatPage, réouverture d'une conversation), isChatAgent et defaultAgentName (déplacés de
// web/pages/chat/turn.ts, qui les ré-exporte). L5t (F-r) : la réouverture ne choisit jamais un assistant caché ni un agent
// interne (cockpit-*, compaction, title, summary), ni par les choix enregistrés, ni par l'assistant par défaut, ni par le
// dernier message ; hors de ces cas, le résultat reste celui de l'ancienne logique (agent-choice.test.ts, table de cas).
import type { ChoicesResponse } from "./api-types.ts";
import type { Tier } from "./assistant-rules.ts";

/** Agents internes d'opencode (masqués, jamais choisis dans le chat), §3.14. */
const OPENCODE_INTERNAL_AGENTS: ReadonlySet<string> = new Set(["compaction", "title", "summary"]);
/** Préfixe des agents internes du cockpit (cockpit-classifier, cockpit-controle, et ceux à venir), §3.14. */
const COCKPIT_INTERNAL_PREFIX = "cockpit-";
/** Assistant de repli quand aucun autre ne peut être repris (même valeur que defaultAgentName). */
const FALLBACK_AGENT = "build";

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
  return FALLBACK_AGENT;
}

/** Nom d'un agent interne (opencode ou cockpit), connu ou non de GET /agent : jamais repris à la réouverture (F-r). */
export function isInternalAgentName(name: string): boolean {
  return OPENCODE_INTERNAL_AGENTS.has(name) || name.startsWith(COCKPIT_INTERNAL_PREFIX);
}

/**
 * Assistant que la réouverture ne reprend jamais (F-r) : nom interne, ou agent connu caché. Un nom inconnu de la liste (liste
 * pas encore chargée, assistant supprimé) n'est refusé que s'il est interne : l'ancienne logique le reprend et le chat le signale.
 */
function refusedOnRestore(name: string, agents: readonly ChoiceAgent[]): boolean {
  return isInternalAgentName(name) || agents.some((a) => a.name === name && a.hidden === true);
}

/** Assistant par défaut à la réouverture : defaultAgentName, sauf s'il est caché ou interne (build, puis le premier sélectionnable). */
function restorableDefault(configured: string | null | undefined, agents: readonly ChoiceAgent[]): string | null {
  const name = defaultAgentName(configured, agents);
  if (!refusedOnRestore(name, agents)) return name;
  if (!refusedOnRestore(FALLBACK_AGENT, agents)) return FALLBACK_AGENT;
  return agents.find((a) => isChatAgent(a) && !refusedOnRestore(a.name, agents))?.name ?? null;
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
 * antérieure à 0.2.0, l'assistant du dernier message utilisateur s'il est sélectionnable. F-r : un assistant caché ou interne
 * n'est jamais repris. Choix enregistrés sur un tel assistant : assistant par défaut (lui-même jamais caché ni interne), niveau et
 * réflexion gardés, jamais l'IA précise de l'assistant écarté. Dernier message d'un tel assistant : assistant inchangé.
 */
export function pickRestorableAgent(input: RestoreInput): RestorePatch {
  const { choices, agents } = input;
  if (choices) {
    const refused = choices.agent !== "" && refusedOnRestore(choices.agent, agents);
    const agent = choices.agent && !refused ? choices.agent : restorableDefault(input.defaultAgent, agents);
    const known = refused ? undefined : agents.find((a) => a.name === choices.agent);
    const levelOfModel = input.tiers.find((t) => t.model !== null && t.model === choices.model)?.id ?? null;
    const level = levelOfModel ?? choices.tier;
    const agentPatch = agent === null ? {} : { agent };
    if (level) return { ...agentPatch, tier: level, variant: choices.variant, override: null };
    if (input.advanced && choices.model && known && !known.model && input.models.some((m) => m.key === choices.model)) {
      // Mode Avancé : l'IA précise choisie pour un agent sans IA propre (niveau inchangé).
      return { ...agentPatch, variant: choices.variant, override: choices.model };
    }
    return { ...agentPatch, tier: input.chatDefaultTier, variant: undefined, override: null };
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
  const known = lastAgent && !refusedOnRestore(lastAgent, agents) ? agents.find((a) => a.name === lastAgent && isChatAgent(a)) : undefined;
  return { ...(known ? { agent: known.name } : {}), tier: input.chatDefaultTier, variant: undefined, override: null };
}
