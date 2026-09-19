// agent-choice (1.1, T2 puis L5t ; spécification F-r, §3.13 l.422) : restoreChoices (ChatPage), isChatAgent et defaultAgentName
// (turn.ts). L'ancienne logique est recopiée ci-dessous telle quelle (chantier/1.1 à 6084ab2), ses appels d'état simulés dans
// l'ordre, puis comparée au module pur sur une table de cas qui couvre toutes les branches : résultat identique hors F-r ; dans
// les cas F-r (assistant caché ou interne par les choix enregistrés, l'assistant par défaut ou le dernier message), jamais repris.
// Transcription (L5t, §5.1, §5.7.3, JP-4, §2.2) : fonctions pures de turn.ts (repères non facturés, reprise, pied de tour, consigne
// reçue, textes d'IA bornés) et gardes lues dans les sources (textes d'IA jamais interprétés, renommages « Étape »).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { Turn as TranscriptTurn } from "../web/pages/chat/transcript.ts";
import {
  AI_TEXT_MAX,
  boundedAiText,
  delegatesWork,
  gapsText,
  isAutomaticUserMessage,
  isBilledReply,
  isUnbilledMarker,
  plannedOf,
  receivedInstruction,
  resumesAfterDelegation,
  shortcutLabel,
  turnCosts,
  turnFooterText,
  turnWindow,
} from "../web/pages/chat/turn.ts";
import { type ActivityState, emptyActivity, fromLedger, replayFacts } from "./shared/activity.ts";
import type { ActivityFact, ActivityResponse } from "./shared/activity-types.ts";
import {
  type ChoiceAgent,
  defaultAgentName,
  isChatAgent,
  isInternalAgentName,
  pickRestorableAgent,
  type RestorableAgent,
  type RestorableMessage,
  type RestorePatch,
} from "./shared/agent-choice.ts";
import type { ChoicesResponse } from "./shared/api-types.ts";
import { PERMISSION_PRESETS, type Tier } from "./shared/assistant-rules.ts";

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
/** « build » caché : l'assistant par défaut de repli ne peut pas être repris. */
const BUILD_CACHE: OldAgent[] = [
  { name: "build", mode: "primary", hidden: true },
  { name: "revue", mode: "primary" },
  { name: "cache", mode: "primary", hidden: true },
];
/** Aucun assistant sélectionnable qui ne soit caché. */
const TOUS_CACHES: OldAgent[] = [
  { name: "build", mode: "primary", hidden: true },
  { name: "cache", mode: "primary", hidden: true },
];
const AGENT_LISTS: OldAgent[][] = [[], AGENTS, BUILD_CACHE, TOUS_CACHES];
const TIERS: Array<{ id: Tier; model: string | null }> = [
  { id: "rapide", model: "github-copilot/gpt-rapide" },
  { id: "equilibre", model: "github-copilot/gpt-equilibre" },
  { id: "expert", model: null },
];
const MODELS = [{ key: "github-copilot/gpt-rapide" }, { key: "github-copilot/gpt-equilibre" }, { key: "github-copilot/claude-libre" }];

// « cockpit-controle » et « compaction » : internes par leur nom, absents de la liste des agents.
const CHOICE_AGENTS = ["", "build", "revue", "specialiste", "explorateur", "cache", "cockpit-classifier", "cockpit-controle", "compaction", "inconnu"];
const CHOICE_TIERS: Array<Tier | null> = [null, "expert", "rapide"];
const CHOICE_MODELS: Array<string | null> = [null, "github-copilot/gpt-equilibre", "github-copilot/claude-libre", "autre/hors-catalogue", ""];
const CHOICE_VARIANTS: Array<string | null> = [null, "high"];
const DEFAULT_AGENTS: Array<string | null> = [null, "revue", "explorateur", "inconnu", "cache", "cockpit-classifier"];

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
  [user("revue"), user("cache")],
  [user("build")],
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
    for (const agents of AGENT_LISTS) {
      for (const defaultAgent of DEFAULT_AGENTS) {
        for (const advanced of [false, true]) {
          // Les messages ne servent que sans choix enregistrés : une seule liste suffit sinon.
          for (const messages of choices ? [MESSAGE_LISTS[4] ?? []] : MESSAGE_LISTS) {
            for (const initial of INITIAL_STATES) {
              const label = JSON.stringify({ choices, agents: agents.map((a) => a.name + (a.hidden ? "*" : "")), defaultAgent, advanced, messages, initial });
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

/** Assistant que la réouverture ne doit jamais reprendre (F-r) : nom interne, ou agent caché de la liste. Écrit sans le module. */
function forbidden(name: string, agents: readonly OldAgent[]): boolean {
  return ["compaction", "title", "summary"].includes(name) || name.startsWith("cockpit-") || agents.some((a) => a.name === name && a.hidden === true);
}

/** Cas F-r : l'ancienne logique aurait repris un assistant caché ou interne (choix enregistré, défaut ou dernier message). */
function isFrCase(c: Case): boolean {
  if (c.choices) {
    const oldAgent = c.choices.agent || oldDefaultAgentName(c.defaultAgent, c.agents);
    return forbidden(oldAgent, c.agents);
  }
  const last = [...c.messages].reverse().find((m) => m.info?.role === "user")?.info?.agent;
  return !!last && forbidden(last, c.agents) && c.agents.some((a) => a.name === last && a.mode !== "subagent");
}

// --- Tests -----------------------------------------------------------------------------------------------------------------

describe("agent-choice : égalité avec l'ancienne logique hors F-r", () => {
  it("pickRestorableAgent rend, hors cas F-r, l'état final de l'ancien restoreChoices", () => {
    const branches = new Map<string, number>();
    let count = 0;
    let fr = 0;
    for (const c of cases()) {
      if (isFrCase(c)) {
        fr++;
        continue;
      }
      count++;
      branches.set(branchOf(c), (branches.get(branchOf(c)) ?? 0) + 1);
      assert.deepStrictEqual(applyPatch(c.initial, runNew(c)), runOld(c), c.label);
    }
    assert.ok(count > 5_000, `table trop petite (${count})`);
    assert.ok(fr > 1_000, `trop peu de cas F-r (${fr})`);
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

describe("agent-choice : jamais un assistant caché ou interne à la réouverture (F-r, §3.13 l.422)", () => {
  it("sur toute la table, la réouverture ne pose jamais un assistant caché ni interne, ni l'IA précise d'un assistant écarté", () => {
    let checked = 0;
    for (const c of cases()) {
      const patch = runNew(c);
      const final = applyPatch(c.initial, patch);
      // Assistant courant gardé tel quel (aucun assistant à reprendre) : seul cas où l'assistant final n'a pas été choisi ici.
      if (final.agent !== c.initial.agent) assert.equal(forbidden(final.agent, c.agents), false, `${c.label} → ${final.agent}`);
      if (patch.agent !== undefined) assert.equal(forbidden(patch.agent, c.agents), false, c.label);
      if (c.choices && c.choices.agent !== "" && forbidden(c.choices.agent, c.agents)) assert.equal(patch.override, null, c.label);
      checked++;
    }
    assert.ok(checked > 10_000, `table trop petite (${checked})`);
  });

  it("choix enregistrés sur un assistant caché ou interne : assistant par défaut, niveau et réflexion gardés", () => {
    const base = { messages: [], agents: AGENTS, defaultAgent: "revue", tiers: TIERS, chatDefaultTier: "equilibre" as const, advanced: true, models: MODELS };
    const choice = (agent: string, tier: Tier | null, model: string | null) => ({ agent, tier, model, variant: "high", createdAt: 1 });
    assert.deepStrictEqual(pickRestorableAgent({ ...base, choices: choice("cache", "expert", null) }), { agent: "revue", tier: "expert", variant: "high", override: null });
    assert.deepStrictEqual(pickRestorableAgent({ ...base, choices: choice("cockpit-classifier", null, "github-copilot/gpt-rapide") }), {
      agent: "revue",
      tier: "rapide",
      variant: "high",
      override: null,
    });
    // Agent interne inconnu de la liste (liste vide ou pas encore chargée) : refusé par son nom.
    for (const name of ["cockpit-controle", "compaction", "title", "summary"]) {
      assert.equal(isInternalAgentName(name), true, name);
      assert.equal(pickRestorableAgent({ ...base, agents: [], choices: choice(name, "expert", null) }).agent, "revue", name);
    }
    assert.equal(isInternalAgentName("cockpitier"), false);
    assert.equal(isInternalAgentName("revue"), false);
    // L'IA précise choisie pour l'assistant caché n'est pas reportée sur l'assistant par défaut.
    assert.deepStrictEqual(pickRestorableAgent({ ...base, choices: choice("cache", null, "github-copilot/claude-libre") }), {
      agent: "revue",
      tier: "equilibre",
      variant: undefined,
      override: null,
    });
  });

  it("assistant par défaut caché ou interne : build, puis le premier sélectionnable, sinon assistant inchangé", () => {
    const base = { messages: [], tiers: TIERS, chatDefaultTier: "equilibre" as const, advanced: false, models: MODELS };
    const choices = { agent: "", tier: "expert" as const, model: null, variant: null, createdAt: 1 };
    assert.equal(pickRestorableAgent({ ...base, agents: AGENTS, defaultAgent: "cache", choices }).agent, "build");
    assert.equal(pickRestorableAgent({ ...base, agents: AGENTS, defaultAgent: "cockpit-classifier", choices }).agent, "build");
    assert.equal(pickRestorableAgent({ ...base, agents: BUILD_CACHE, defaultAgent: null, choices }).agent, "revue");
    const none = pickRestorableAgent({ ...base, agents: TOUS_CACHES, defaultAgent: null, choices });
    assert.equal(Object.hasOwn(none, "agent"), false);
    assert.deepStrictEqual(none, { tier: "expert", variant: null, override: null });
  });

  it("sans choix enregistrés : dernier message d'un assistant caché, interne ou non sélectionnable → assistant inchangé", () => {
    const base = { choices: null, agents: AGENTS, defaultAgent: null, tiers: TIERS, chatDefaultTier: "equilibre" as const, advanced: false, models: MODELS };
    const unchanged = { tier: "equilibre", variant: undefined, override: null };
    assert.deepStrictEqual(pickRestorableAgent({ ...base, messages: [user("explorateur")] }), unchanged);
    assert.deepStrictEqual(pickRestorableAgent({ ...base, messages: [user("cache")] }), unchanged);
    assert.deepStrictEqual(pickRestorableAgent({ ...base, messages: [user("cockpit-classifier")] }), unchanged);
    assert.deepStrictEqual(pickRestorableAgent({ ...base, messages: [user("revue"), user("cache")] }), unchanged);
    assert.deepStrictEqual(pickRestorableAgent({ ...base, messages: [user("revue"), assistant("build")] }), { agent: "revue", ...unchanged });
  });
});

// Typage : un agent de GET /agent (OcAgent) est un RestorableAgent.
const _typeCheck: RestorableAgent[] = AGENTS;
void _typeCheck;

// --- Transcription (turn.ts, L5t) --------------------------------------------------------------------------------------------

type Reply = TranscriptTurn["replies"][number];
type UserEntry = NonNullable<TranscriptTurn["user"]>;

const ROOT = "ses_racine";
const CHILD = "ses_enfant";
const CONTROL = "ses_controle";
const char = (code: number) => String.fromCharCode(code);

let partSeq = 0;
const part = (messageID: string, fields: { type: string; [key: string]: unknown }) => ({ id: `prt_${++partSeq}`, sessionID: ROOT, messageID, ...fields });
const stepStart = (messageID: string) => part(messageID, { type: "step-start" });
const text = (messageID: string, value: string, synthetic = false) => part(messageID, { type: "text", text: value, ...(synthetic ? { synthetic } : {}) });
const taskPart = (messageID: string, child: string | null) =>
  part(messageID, {
    type: "tool",
    callID: "call_1",
    tool: "task",
    state: {
      status: "completed",
      input: { subagent_type: "explore", description: "Chercher", prompt: "Consigne écrite par l'IA" },
      output: "Résultat",
      title: "",
      metadata: child ? { sessionId: child } : {},
      time: { start: 1_150, end: 2_600 },
    },
  });

function userMessage(id: string, created: number, parts: unknown[], session = ROOT): UserEntry {
  const info = { id, sessionID: session, role: "user", time: { created }, agent: "build", model: { providerID: "github-copilot", modelID: "m" } };
  return { info, parts } as unknown as UserEntry;
}

function reply(id: string, created: number, completed: number | null, cost: number, parts: unknown[], extra: Record<string, unknown> = {}): Reply {
  const time = completed === null ? { created } : { created, completed };
  const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  const info = { id, sessionID: ROOT, role: "assistant", time, parentID: "msg_u1", modelID: "m", providerID: "github-copilot", mode: "build", agent: "build", cost, tokens, ...extra };
  return { info, parts } as unknown as Reply;
}

/** Demande qui délègue : msg_a1 (0,02 $) confie du travail à CHILD, msg_a2 (0,04 $) reprend ; fenêtre [1 000, 3 001). */
function delegatingTurn(): TranscriptTurn {
  return {
    key: "msg_u1",
    user: userMessage("msg_u1", 1_000, [text("msg_u1", "Analyse l'incident")]),
    replies: [
      reply("msg_a1", 1_100, 2_700, 0.02, [stepStart("msg_a1"), taskPart("msg_a1", CHILD)]),
      reply("msg_a2", 2_700, 3_000, 0.04, [stepStart("msg_a2"), text("msg_a2", "Synthèse")]),
    ],
  };
}

const fact = (sessionId: string, kind: ActivityFact["kind"], ref: string | null, data: ActivityFact["data"], at: number): ActivityFact => ({
  rootId: ROOT,
  sessionId,
  kind,
  ref,
  data,
  at,
});
const call = (sessionId: string, messageId: string, start: number, end: number, cout: number): ActivityFact[] => [
  fact(sessionId, "statut", messageId, { etat: "appel", messageId }, start),
  fact(sessionId, "statut", messageId, { etat: "appel-fini", messageId, cout, raison: null }, end),
];

/** Faits de la demande : racine, travail délégué (0,08 $, 2 appels), contrôle de sécurité (0,01 $), et un appel délégué plus tard. */
function delegatingFacts(options: { origine?: boolean; partial?: boolean } = {}): ActivityFact[] {
  return [
    ...(options.origine === false ? [] : [fact(ROOT, "origine", "msg_u1", { origine: "demande", cas: 1, messageId: "msg_u1" }, 1_050)]),
    fact(ROOT, "statut", null, { etat: "occupee" }, 1_060),
    ...call(ROOT, "msg_a1", 1_100, 2_700, 0.02),
    fact(CHILD, "statut", null, { etat: "creee", role: "delegation", parent: ROOT, agent: "explore", instance: "principale" }, 1_600),
    ...call(CHILD, "msg_c1", 1_700, 2_000, 0.05),
    ...call(CHILD, "msg_c2", 2_100, 2_400, 0.03),
    fact(CONTROL, "statut", null, { etat: "creee", role: "controle", parent: ROOT, agent: null, instance: "principale" }, 2_450),
    ...call(CONTROL, "msg_k1", 2_500, 2_600, 0.01),
    ...call(ROOT, "msg_a2", 2_700, 3_000, 0.04),
    // Demande suivante : jamais comptée dans celle-ci.
    ...call(CHILD, "msg_c3", 9_000, 9_500, 0.5),
    ...(options.partial ? [fact(ROOT, "affichage", null, { etat: "deroule-partiel" }, 9_600)] : []),
  ];
}

const withFacts = (facts: ActivityFact[], root = ROOT): ActivityState => replayFacts(emptyActivity(root), facts.map((f) => ({ ...f, rootId: root })));

describe("transcription : repères non facturés, reprise et message automatique (§5.1)", () => {
  it("une réponse sans step-start, terminée et sans erreur est un repère non facturé ; en cours ou en erreur, non", () => {
    const marker = reply("msg_r", 1_100, 2_700, 0, [taskPart("msg_r", CHILD)]);
    assert.equal(isBilledReply(marker), false);
    assert.equal(isUnbilledMarker(marker), true);
    assert.equal(isUnbilledMarker(reply("msg_r", 1_100, null, 0, [taskPart("msg_r", CHILD)])), false, "réponse en cours");
    assert.equal(isUnbilledMarker(reply("msg_r", 1_100, 1_200, 0, [], { error: { name: "ProviderAuthError" } })), false, "erreur");
    const billed = reply("msg_b", 1_100, 1_200, 0.01, [stepStart("msg_b"), text("msg_b", "ok")]);
    assert.equal(isBilledReply(billed), true);
    assert.equal(isUnbilledMarker(billed), false);
  });

  it("« Reprise dans la conversation » après une réponse qui délègue, jamais avant la première ni après une réponse sans délégation", () => {
    const replies = [
      reply("msg_a", 1, 2, 0, [stepStart("msg_a"), taskPart("msg_a", CHILD)]),
      reply("msg_b", 2, 3, 0, [stepStart("msg_b"), text("msg_b", "suite")]),
      reply("msg_c", 3, 4, 0, [stepStart("msg_c"), text("msg_c", "fin")]),
    ];
    assert.deepEqual(
      replies.map((_, i) => resumesAfterDelegation(replies, i)),
      [false, true, false],
    );
    assert.equal(delegatesWork(replies[0] as Reply), true);
    assert.equal(delegatesWork(replies[1] as Reply), false);
  });

  it("message utilisateur écrit par opencode seul (parties synthetic) : reprise ; un texte, un fichier ou un raccourci de vous : bulle", () => {
    const synthetic = text("msg_s", "Summarize the task tool output above and continue", true);
    assert.equal(isAutomaticUserMessage({ parts: [synthetic] }), true);
    assert.equal(isAutomaticUserMessage({ parts: [synthetic, text("msg_s", "Et vérifie les journaux")] }), false);
    assert.equal(isAutomaticUserMessage({ parts: [synthetic, part("msg_s", { type: "file", mime: "text/plain", url: "file:///a" })] }), false);
    assert.equal(isAutomaticUserMessage({ parts: [synthetic, part("msg_s", { type: "subtask", prompt: "p", description: "d", agent: "a" })] }), false);
    assert.equal(isAutomaticUserMessage({ parts: [] }), false, "message pas encore lu");
  });

  it("raccourci envoyé sans texte : « /commande · description » bornée, jamais une bulle vide", () => {
    assert.equal(shortcutLabel({ command: "revue-croisee", description: "Revue croisée des changements" }), "/revue-croisee · Revue croisée des changements");
    assert.equal(shortcutLabel({ command: "revue-croisee" }), "/revue-croisee");
    assert.equal(shortcutLabel({ description: "Relire" }), "Relire");
    assert.equal(shortcutLabel({}), "Raccourci");
    assert.equal(shortcutLabel({ command: "a b<script>", description: 7 }), "Raccourci", "nom de commande refusé, description non textuelle");
    assert.equal(shortcutLabel({ description: "x".repeat(500) }).length, 200);
  });
});

describe("transcription : pied de tour « {coût} dont {x} $ de travail délégué · {n} appels d'IA » (§5.1)", () => {
  it("fenêtre d'une demande : de son message à la fin de sa dernière réponse incluse ; aucune tant qu'une réponse est en cours", () => {
    assert.deepEqual(turnWindow(delegatingTurn()), { from: 1_000, to: 3_001 });
    const running = { ...delegatingTurn(), replies: [reply("msg_a1", 1_100, null, 0, [stepStart("msg_a1")])] };
    assert.equal(turnWindow(running), null);
    const failed = { ...delegatingTurn(), replies: [reply("msg_a1", 1_100, null, 0, [], { error: { name: "ProviderAuthError" } })] };
    assert.deepEqual(turnWindow(failed), { from: 1_000, to: 1_101 });
  });

  it("faits enregistrés dès la demande : travail délégué de la fenêtre, contrôles comptés dans le coût mais jamais délégués", () => {
    const costs = turnCosts(delegatingTurn(), withFacts(delegatingFacts()));
    assert.deepEqual(costs.delegated, { cost: 0.08, calls: 2 });
    assert.equal(costs.calls, 5, "2 réponses facturées, 2 appels délégués, 1 contrôle ; l'appel délégué de la demande suivante exclu");
    assert.ok(Math.abs(costs.cost - 0.15) < 1e-9, String(costs.cost));
    assert.equal(costs.delegatedUnknown, false);
    assert.equal(turnFooterText(costs), "0,15 $ dont 0,08 $ de travail délégué · 5 appels d'IA");
  });

  it("sans activité (tiroir, lecture en cours) : réponses seules, repère non compté, travail délégué signalé non compté", () => {
    const turn = delegatingTurn();
    const withMarker = { ...turn, replies: [reply("msg_r", 1_100, 2_700, 0, [taskPart("msg_r", CHILD)]), ...turn.replies.slice(1)] };
    const costs = turnCosts(withMarker, null);
    assert.deepEqual(costs, { cost: 0.04, calls: 1, delegated: null, delegatedUnknown: true });
    assert.equal(turnFooterText(costs), "0,04 $ · 1 appel d'IA · travail délégué non compté");
    const alone = { ...turn, replies: [reply("msg_b", 1_100, 1_200, 0.01, [stepStart("msg_b")])] };
    assert.equal(turnFooterText(turnCosts(alone, null)), "0,01 $ · 1 appel d'IA");
  });

  it("activité qui ne couvre pas la demande : autre conversation, Déroulé partiel, ou demande d'avant les faits → non comptée", () => {
    const turn = delegatingTurn();
    const unknown = { cost: 0.06, calls: 2, delegated: null, delegatedUnknown: true };
    assert.deepEqual(turnCosts(turn, withFacts(delegatingFacts(), "ses_autre")), unknown, "autre conversation");
    assert.deepEqual(turnCosts(turn, withFacts(delegatingFacts({ partial: true }))), unknown, "Déroulé partiel");
    assert.deepEqual(turnCosts(turn, withFacts(delegatingFacts({ origine: false }))), unknown, "demande sans fait « origine »");
    const running = { ...turn, replies: [...turn.replies.slice(0, 1), reply("msg_a2", 2_700, null, 0, [stepStart("msg_a2")])] };
    assert.equal(turnCosts(running, withFacts(delegatingFacts())).delegated, null, "demande en cours");
  });

  it("conversation reconstruite depuis le registre (avant la 1.1) : couverte en entier", () => {
    const activity: ActivityResponse = {
      runs: [],
      delegations: [],
      waits: [],
      decisions: [],
      requests: [],
      usageSpans: [
        { sessionId: ROOT, messageId: "msg_a1", start: 1_100, end: 2_700, cost: 0.02 },
        { sessionId: CHILD, messageId: "msg_c1", start: 1_700, end: 2_000, cost: 0.05 },
        { sessionId: ROOT, messageId: "msg_a2", start: 2_700, end: 3_000, cost: 0.04 },
      ],
    };
    const state = fromLedger(ROOT, activity, [
      { id: ROOT, parentId: null, purpose: "chat" },
      { id: CHILD, parentId: ROOT, purpose: "chat" },
    ]);
    assert.equal(state.source, "registre");
    assert.equal(turnFooterText(turnCosts(delegatingTurn(), state)), "0,11 $ dont 0,05 $ de travail délégué · 3 appels d'IA");
  });

  it("demande qui délègue sans aucun appel délégué (refusé, jamais démarré) : ni « dont », ni « non compté »", () => {
    const facts = delegatingFacts().filter((f) => f.sessionId === ROOT);
    assert.equal(turnFooterText(turnCosts(delegatingTurn(), withFacts(facts))), "0,06 $ · 2 appels d'IA");
  });
});

describe("transcription : textes d'IA et consigne reçue (JP-4)", () => {
  it("texte d'IA : séquences de terminal, caractères de commande et de sens d'écriture retirés ; fins de ligne et tabulations gardées", () => {
    const raw = `${char(27)}[31mrouge${char(27)}[0m${char(13)}\nligne${char(9)}fin${char(0)}${char(7)}${char(0x202e)}inverse${char(0x2066)}`;
    assert.deepEqual(boundedAiText(raw), { text: `rouge\nligne${char(9)}fininverse`, clipped: false });
    assert.deepEqual(boundedAiText(42), { text: "", clipped: false });
    assert.deepEqual(boundedAiText(null), { text: "", clipped: false });
    assert.equal(AI_TEXT_MAX, 20_000);
  });

  it("texte d'IA borné : coupé à la borne, signalé, jamais au milieu d'un caractère double", () => {
    assert.deepEqual(boundedAiText("abcdef", 4), { text: "abcd", clipped: true });
    const emoji = String.fromCodePoint(0x1f600);
    const clipped = boundedAiText(`abc${emoji}def`, 4);
    assert.deepEqual(clipped, { text: "abc", clipped: true });
    assert.equal(boundedAiText("x".repeat(AI_TEXT_MAX + 5)).text.length, AI_TEXT_MAX);
  });

  it("« Voir la consigne » : premier message utilisateur reçu, sans les ajouts d'opencode, jamais un message de l'assistant", () => {
    const messages = [
      { info: { role: "assistant" }, parts: [text("msg_x", "réponse")] },
      {
        info: { role: "user" },
        parts: [
          text("msg_c", "Consigne réellement reçue"),
          text("msg_c", "Called the Read tool with the following input", true),
          part("msg_c", { type: "file", mime: "text/plain", url: "file:///a" }),
          text("msg_c", "Seconde partie"),
        ],
      },
      { info: { role: "user" }, parts: [text("msg_d", "Message suivant")] },
    ];
    assert.deepEqual(receivedInstruction(messages), { text: "Consigne réellement reçue\n\nSeconde partie", clipped: false, added: 2 });
    assert.equal(receivedInstruction([{ info: { role: "assistant" }, parts: [] }]), null);
    const noisy = receivedInstruction([{ info: { role: "user" }, parts: [text("msg_e", `${char(27)}[1mgras${char(27)}[0m`)] }]);
    assert.equal(noisy?.text, "gras");
  });
});

describe("Déroulé : « Prévu / Réel » et écarts (§5.1, P12)", () => {
  const row = (fields: Partial<Parameters<typeof plannedOf>[0] & object>) => ({
    depth: 1,
    role: "delegation" as const,
    source: null,
    commande: null,
    sansSession: false,
    ...fields,
  });

  it("prévu : votre demande, raccourci, décidé par l'IA (avec ou sans session), contrôle ; inconnu sans fait qui le dise", () => {
    assert.deepEqual(plannedOf(row({ depth: 0, role: "conversation" })), { kind: "prevu", text: "votre demande" });
    assert.deepEqual(plannedOf(row({ source: "raccourci", commande: "revue-croisee" })), { kind: "prevu", text: "raccourci /revue-croisee" });
    assert.deepEqual(plannedOf(row({ source: "ia" })), { kind: "non-prevu", text: "non prévu : décidé par l'IA" });
    assert.deepEqual(plannedOf(row({ sansSession: true })), { kind: "non-prevu", text: "non prévu : décidé par l'IA" }, "appel task en attente");
    assert.deepEqual(plannedOf(row({ role: "controle" })), { kind: "controle", text: "contrôle du cockpit" });
    assert.deepEqual(plannedOf(row({})), { kind: "inconnu", text: "inconnu" }, "registre d'avant la 1.1 : jamais « décidé par l'IA »");
    assert.deepEqual(plannedOf(null), { kind: "inconnu", text: "inconnu" });
  });

  it("écarts : « Aucun écart » seulement si tout le prévu est connu", () => {
    const none = { nonPrevus: 0, inconnus: 0, jamais: 0, echecs: 0, arrets: 0 };
    assert.equal(gapsText(none), "Aucun écart avec le prévu.");
    assert.equal(gapsText({ ...none, inconnus: 3 }), "Prévu inconnu pour 3 délégations.");
    assert.equal(gapsText({ ...none, nonPrevus: 2, jamais: 1 }), "Écarts avec le prévu : 2 délégations décidées par l'IA · 1 délégation jamais démarrée.");
    assert.equal(gapsText({ ...none, echecs: 1, arrets: 2, inconnus: 1 }), "Écarts avec le prévu : 1 échec · 2 arrêts. Prévu inconnu pour 1 délégation.");
  });
});

describe("transcription et renommages : gardes lues dans les sources (L5t)", () => {
  const read = (...parts: string[]) => fs.readFileSync(path.join(APP_DIR, ...parts), "utf8");
  /** Source sans commentaires de ligne ni commentaires JSX (les commentaires peuvent citer un mot interdit). */
  const code = (source: string) => source.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

  it("textes d'IA jamais interprétés : ni HTML ni Markdown dans la carte de délégation ni dans « Voir la consigne »", () => {
    for (const file of [
      ["web", "pages", "chat", "activity", "DelegationCard.tsx"],
      ["web", "pages", "chat", "SubSessionDrawer.tsx"],
    ]) {
      const source = code(read(...file));
      assert.equal(/dangerouslySetInnerHTML|<Markdown\b|innerHTML/.test(source), false, file.join("/"));
    }
    const card = code(read("web", "pages", "chat", "activity", "DelegationCard.tsx"));
    assert.match(card, /boundedAiText\(value\)/, "AiText passe chaque texte par boundedAiText");
    for (const field of ["subagent_type", "description", "command"]) assert.match(card, new RegExp(`boundedAiText\\(input\\.${field}\\b`), field);
    // Seule forme permise : value={…} d'AiText, qui passe par boundedAiText.
    assert.equal(/(?<!value=)\{\s*(?:input|state|metadata)\.\w+\s*\}/.test(card), false, "aucun champ d'IA rendu sans boundedAiText");
  });

  it("transcription : partie task en carte de délégation, consigne du tiroir lue dans le message reçu", () => {
    const view = code(read("web", "pages", "chat", "MessageView.tsx"));
    assert.match(view, /part\.tool === "task" \? \(\s*<DelegationCard/);
    assert.match(view, /Reprise dans la conversation/);
    const drawer = code(read("web", "pages", "chat", "SubSessionDrawer.tsx"));
    assert.match(drawer, /receivedInstruction\(/);
    assert.equal(/input\.prompt|state\.input/.test(drawer), false, "jamais la seule consigne écrite par l'IA");
    assert.match(drawer, /conversationRoot=\{false\}/);
    assert.equal(/sous-agent|Session enfant/i.test(drawer), false, "vocabulaire du mode Simple (§2.3)");
  });

  it("renommages §2.2 et D1 : « 2 / 5 · Les droits », « Progression », « Actions maximum », « Sans confirmation (déconseillé) »", () => {
    const wizard = code(read("web", "pages", "assistants", "AssistantWizard.tsx"));
    assert.match(wizard, /\{step \+ 1\} \/ \{STEPS\.length\} · \{STEPS\[step\]\}/);
    assert.match(wizard, /aria-label="Progression"/);
    assert.equal(/Étapes?\s*\{|aria-label="Étapes"/.test(wizard), false);
    const fields = code(read("web", "pages", "studio", "AgentFields.tsx"));
    assert.match(fields, /label="Actions maximum"/);
    assert.equal(/Étapes maximum/i.test(fields), false);
    assert.equal(PERMISSION_PRESETS.autonome.label, "Sans confirmation (déconseillé)");
    const settings = code(read("web", "pages", "settings", "OpencodeTab.tsx"));
    assert.match(settings, /title: PERMISSION_PRESETS\.autonome\.label/);
    assert.equal(/title: "Autonome"/.test(settings), false);
  });

  it("Déroulé : textes de la spécification (§5.1, §5.4) et aucune animation", () => {
    const deroule = code(read("web", "pages", "chat", "activity", "Deroule.tsx"));
    for (const phrase of ["Temps d'attente non enregistré avant la 1.1", "Une seule IA a travaillé sur", "Aucune décision automatique pour", "Journal du contrôle"]) {
      assert.ok(deroule.includes(phrase), phrase);
    }
    const css = read("web", "pages", "chat", "activity", "deroule.css").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.equal(/animation|transition|@keyframes/.test(css), false);
    assert.match(css, /@media \(forced-colors: active\)/);
  });
});
