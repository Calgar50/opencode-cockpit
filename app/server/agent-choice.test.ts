// agent-choice (1.1, T2 ; spécification F-r) : extraction à comportement constant de restoreChoices (ChatPage), isChatAgent et
// defaultAgentName (turn.ts). L'ancienne logique est recopiée ci-dessous telle quelle (chantier/1.1 à 6084ab2), ses appels
// d'état simulés dans l'ordre, puis comparée au module pur sur une table de cas qui couvre toutes les branches.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  type ChoiceAgent,
  defaultAgentName,
  isChatAgent,
  pickRestorableAgent,
  type RestorableAgent,
  type RestorableMessage,
  type RestorePatch,
} from "./shared/agent-choice.ts";
import type { ChoicesResponse } from "./shared/api-types.ts";
import type { Tier } from "./shared/assistant-rules.ts";

const APP_DIR = path.join(import.meta.dirname, "..");

// --- Ancienne logique (recopiée telle quelle) --------------------------------------------------------------------------------

type OldAgent = { name: string; mode: "subagent" | "primary" | "all"; hidden?: boolean; model?: { modelID: string; providerID: string } };

function oldIsChatAgent(agent: Pick<OldAgent, "mode">): boolean {
  return agent.mode !== "subagent";
}

function oldDefaultAgentName(configured: string | null | undefined, agents: OldAgent[]): string {
  if (configured && (agents.length === 0 || agents.some((a) => a.name === configured && oldIsChatAgent(a)))) return configured;
  return "build";
}

interface ChatState {
  agent: string;
  tier: Tier;
  variant: string | null | undefined;
  override: string | null;
}

interface OldContext {
  agents: OldAgent[];
  boot: {
    settings: { chat: { defaultAgent: string | null } };
    ai: { tiers: Array<{ id: Tier; model: string | null }>; chatDefaultTier: Tier };
    models: Array<{ key: string }>;
  };
  advanced: boolean;
}

/** restoreChoices de ChatPage (après la lecture de GET /api/chat/choices et la garde de session), setters simulés. */
function oldRestoreChoices(initial: ChatState, ctx: OldContext, choices: ChoicesResponse, messages: RestorableMessage[]): ChatState {
  const state = { ...initial };
  const setAgent = (value: string) => void (state.agent = value);
  const setTier = (value: Tier) => void (state.tier = value);
  const setVariant = (value: string | null | undefined) => void (state.variant = value);
  const setOverride = (value: string | null) => void (state.override = value);
  const agentsRef = { current: ctx.agents };
  const { boot, advanced } = ctx;
  setOverride(null);
  if (choices) {
    const chosen = choices;
    setAgent(chosen.agent || oldDefaultAgentName(boot.settings.chat.defaultAgent, agentsRef.current));
    const known = agentsRef.current.find((a) => a.name === chosen.agent);
    const levelOfModel = boot.ai.tiers.find((t) => t.model !== null && t.model === chosen.model)?.id ?? null;
    const level = levelOfModel ?? chosen.tier;
    if (level) {
      setTier(level);
      setVariant(chosen.variant);
    } else if (advanced && chosen.model && known && !known.model && boot.models.some((m) => m.key === chosen.model)) {
      // Mode Avancé : l'IA précise choisie pour un agent sans IA propre.
      setOverride(chosen.model);
      setVariant(chosen.variant);
    } else {
      setTier(boot.ai.chatDefaultTier);
      setVariant(undefined);
    }
    return state;
  }
  // Conversation antérieure à 0.2.0 : seul l'assistant du dernier message est repris.
  let lastAgent: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i]?.info as { role: string; agent: string } | undefined;
    if (info?.role === "user") {
      lastAgent = info.agent;
      break;
    }
  }
  const known = lastAgent ? agentsRef.current.find((a) => a.name === lastAgent && oldIsChatAgent(a)) : undefined;
  if (known) setAgent(known.name);
  setTier(boot.ai.chatDefaultTier);
  setVariant(undefined);
  return state;
}

/** Application du résultat du module pur, comme dans ChatPage. */
function applyPatch(initial: ChatState, patch: RestorePatch): ChatState {
  const state = { ...initial };
  state.override = patch.override;
  if (patch.agent !== undefined) state.agent = patch.agent;
  if (patch.tier !== undefined) state.tier = patch.tier;
  state.variant = patch.variant;
  return state;
}

// --- Table de cas ----------------------------------------------------------------------------------------------------------

const MODEL = { providerID: "github-copilot", modelID: "claude-propre" };
const AGENTS: OldAgent[] = [
  { name: "build", mode: "primary" },
  { name: "revue", mode: "primary" },
  { name: "specialiste", mode: "all", model: MODEL },
  { name: "explorateur", mode: "subagent" },
  { name: "cache", mode: "primary", hidden: true },
  { name: "cockpit-classifier", mode: "primary", hidden: true },
];
const TIERS: Array<{ id: Tier; model: string | null }> = [
  { id: "rapide", model: "github-copilot/gpt-rapide" },
  { id: "equilibre", model: "github-copilot/gpt-equilibre" },
  { id: "expert", model: null },
];
const MODELS = [{ key: "github-copilot/gpt-rapide" }, { key: "github-copilot/gpt-equilibre" }, { key: "github-copilot/claude-libre" }];

const CHOICE_AGENTS = ["", "build", "revue", "specialiste", "explorateur", "cache", "inconnu"];
const CHOICE_TIERS: Array<Tier | null> = [null, "expert", "rapide"];
const CHOICE_MODELS: Array<string | null> = [null, "github-copilot/gpt-equilibre", "github-copilot/claude-libre", "autre/hors-catalogue", ""];
const CHOICE_VARIANTS: Array<string | null> = [null, "high"];

const user = (agent: string): RestorableMessage => ({ info: { role: "user", agent } });
const assistant = (agent: string): RestorableMessage => ({ info: { role: "assistant", agent } });
const MESSAGE_LISTS: RestorableMessage[][] = [
  [],
  [assistant("revue")],
  [user("revue")],
  [user("revue"), assistant("build")],
  [user("revue"), user("specialiste")],
  [user("specialiste"), assistant("revue"), {}],
  [user("explorateur")],
  [user("cache")],
  [user("cockpit-classifier")],
  [user("inconnu")],
  [user("")],
  [user("build"), { info: null }],
];

const INITIAL_STATES: ChatState[] = [
  { agent: "courant", tier: "equilibre", variant: "xhigh", override: "github-copilot/claude-libre" },
  { agent: "build", tier: "rapide", variant: undefined, override: null },
];

interface Case {
  label: string;
  initial: ChatState;
  agents: OldAgent[];
  defaultAgent: string | null;
  advanced: boolean;
  choices: ChoicesResponse;
  messages: RestorableMessage[];
}

function* cases(): Generator<Case> {
  const choiceList: ChoicesResponse[] = [null];
  for (const agent of CHOICE_AGENTS) {
    for (const tier of CHOICE_TIERS) {
      for (const model of CHOICE_MODELS) {
        for (const variant of CHOICE_VARIANTS) choiceList.push({ agent, tier, model, variant, createdAt: 1 });
      }
    }
  }
  for (const choices of choiceList) {
    for (const agents of [[], AGENTS]) {
      for (const defaultAgent of [null, "revue", "explorateur", "inconnu"]) {
        for (const advanced of [false, true]) {
          // Les messages ne servent que sans choix enregistrés : une seule liste suffit sinon.
          for (const messages of choices ? [MESSAGE_LISTS[4] ?? []] : MESSAGE_LISTS) {
            for (const initial of INITIAL_STATES) {
              const label = JSON.stringify({ choices, agents: agents.length, defaultAgent, advanced, messages, initial });
              yield { label, initial, agents, defaultAgent, advanced, choices, messages };
            }
          }
        }
      }
    }
  }
}

function runNew(c: Case): RestorePatch {
  return pickRestorableAgent({
    choices: c.choices,
    messages: c.messages,
    agents: c.agents,
    defaultAgent: c.defaultAgent,
    tiers: TIERS,
    chatDefaultTier: "equilibre",
    advanced: c.advanced,
    models: MODELS,
  });
}

function runOld(c: Case): ChatState {
  const ctx: OldContext = {
    agents: c.agents,
    boot: { settings: { chat: { defaultAgent: c.defaultAgent } }, ai: { tiers: TIERS, chatDefaultTier: "equilibre" }, models: MODELS },
    advanced: c.advanced,
  };
  return oldRestoreChoices(c.initial, ctx, c.choices, c.messages);
}

/** Branche empruntée par l'ancienne logique (couverture de la table). */
function branchOf(c: Case): string {
  if (!c.choices) {
    const last = [...c.messages].reverse().find((m) => m.info?.role === "user")?.info?.agent;
    return last && c.agents.some((a) => a.name === last && a.mode !== "subagent") ? "ancienne-reprise" : "ancienne-sans-assistant";
  }
  const chosen = c.choices;
  if (TIERS.some((t) => t.model !== null && t.model === chosen.model)) return "niveau-par-ia";
  if (chosen.tier) return "niveau-enregistre";
  const known = c.agents.find((a) => a.name === chosen.agent);
  if (c.advanced && chosen.model && known && !known.model && MODELS.some((m) => m.key === chosen.model)) return "ia-precise";
  return "niveau-par-defaut";
}

// --- Tests -----------------------------------------------------------------------------------------------------------------

describe("agent-choice : égalité avec l'ancienne logique (F-r)", () => {
  it("pickRestorableAgent rend, sur toute la table, l'état final de l'ancien restoreChoices", () => {
    const branches = new Map<string, number>();
    let count = 0;
    for (const c of cases()) {
      count++;
      branches.set(branchOf(c), (branches.get(branchOf(c)) ?? 0) + 1);
      assert.deepStrictEqual(applyPatch(c.initial, runNew(c)), runOld(c), c.label);
    }
    assert.ok(count > 5_000, `table trop petite (${count})`);
    for (const branch of ["niveau-par-ia", "niveau-enregistre", "ia-precise", "niveau-par-defaut", "ancienne-reprise", "ancienne-sans-assistant"]) {
      assert.ok((branches.get(branch) ?? 0) > 0, `branche jamais parcourue : ${branch}`);
    }
  });

  it("la branche « IA précise » garde le niveau courant et pose l'IA du choix", () => {
    const initial: ChatState = { agent: "courant", tier: "rapide", variant: undefined, override: null };
    const patch = pickRestorableAgent({
      choices: { agent: "revue", tier: null, model: "github-copilot/claude-libre", variant: "high", createdAt: 1 },
      messages: [],
      agents: AGENTS,
      defaultAgent: null,
      tiers: TIERS,
      chatDefaultTier: "equilibre",
      advanced: true,
      models: MODELS,
    });
    assert.deepStrictEqual(patch, { agent: "revue", variant: "high", override: "github-copilot/claude-libre" });
    assert.equal(Object.hasOwn(patch, "tier"), false);
    assert.deepStrictEqual(applyPatch(initial, patch), { agent: "revue", tier: "rapide", variant: "high", override: "github-copilot/claude-libre" });
  });

  it("sans choix enregistrés : assistant inchangé si le dernier message utilisateur n'est pas sélectionnable", () => {
    const base = { choices: null, agents: AGENTS, defaultAgent: null, tiers: TIERS, chatDefaultTier: "equilibre" as const, advanced: false, models: MODELS };
    assert.deepStrictEqual(pickRestorableAgent({ ...base, messages: [user("explorateur")] }), { tier: "equilibre", variant: undefined, override: null });
    assert.deepStrictEqual(pickRestorableAgent({ ...base, messages: [user("revue"), assistant("build")] }), {
      agent: "revue",
      tier: "equilibre",
      variant: undefined,
      override: null,
    });
    // F-r : comportement 1.0.4 gardé par T2 (un assistant caché est encore repris) ; L5t le change avec ce test.
    assert.equal(pickRestorableAgent({ ...base, messages: [user("cache")] }).agent, "cache");
  });

  it("isChatAgent et defaultAgentName : mêmes réponses que les fonctions de turn.ts", () => {
    const modes = ["primary", "subagent", "all"] as const;
    for (const mode of modes) assert.equal(isChatAgent({ mode }), oldIsChatAgent({ mode }), mode);
    const lists: OldAgent[][] = [[], AGENTS, AGENTS.filter((a) => a.name !== "build"), [{ name: "revue", mode: "subagent" }]];
    for (const agents of lists) {
      for (const configured of [null, undefined, "", "build", "revue", "specialiste", "explorateur", "cache", "inconnu"]) {
        const minimal: ChoiceAgent[] = agents.map((a) => ({ name: a.name, mode: a.mode, hidden: a.hidden }));
        assert.equal(defaultAgentName(configured, minimal), oldDefaultAgentName(configured, agents), `${configured} / ${agents.length}`);
      }
    }
  });

  it("turn.ts ré-exporte le module pur et ChatPage restaure par pickRestorableAgent", () => {
    const turn = fs.readFileSync(path.join(APP_DIR, "web", "pages", "chat", "turn.ts"), "utf8");
    assert.match(turn, /import \{ defaultAgentName, isChatAgent \} from "\.\.\/\.\.\/\.\.\/server\/shared\/agent-choice\.ts";/);
    assert.match(turn, /export \{ defaultAgentName, isChatAgent \};/);
    assert.equal(/function (?:isChatAgent|defaultAgentName)\b/.test(turn), false, "turn.ts ne redéfinit pas les fonctions déplacées");
    const chat = fs.readFileSync(path.join(APP_DIR, "web", "pages", "ChatPage.tsx"), "utf8");
    assert.match(chat, /pickRestorableAgent\(\{/);
    assert.equal(/lastAgent/.test(chat), false, "ChatPage ne garde pas de copie de l'ancienne logique");
  });
});

// Typage : un agent de GET /agent (OcAgent) est un RestorableAgent.
const _typeCheck: RestorableAgent[] = AGENTS;
void _typeCheck;
