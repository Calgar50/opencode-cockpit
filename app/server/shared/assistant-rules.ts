// Règles partagées entre le serveur et l'interface : module PUR (aucun import « node: », aucun accès à process).
//
// - Quelle IA opencode 1.18.30 utilise et facture vraiment : message, raccourci (/commande), travail délégué
//   et reprise qui suit (résolveur, conception 0.2.0 §5).
// - Droits effectifs d'un agent : portage exact de Wildcard.match et de Permission.evaluate, lignes
//   « Ce qu'il peut faire ».
// - Fichier d'agent d'un assistant, niveaux d'IA, estimations et textes français communs.
//
// Le bundle web l'importe par chemin relatif : toute dépendance ajoutée ici doit rester pure (pricing.ts l'est).
// Toute mise à jour d'opencode impose de relire les citations « fichier:ligne » et de relancer core.test.ts.
import { COPILOT_PRICES, computeCost, type ModelPrice, roundUsd } from "../pricing.ts";

export type { ModelPrice } from "../pricing.ts";

// --- Types de base ----------------------------------------------------------------------

export const TIER_IDS = ["rapide", "equilibre", "expert"] as const;
export type Tier = (typeof TIER_IDS)[number];

export const TASK_SIZES = ["S", "M", "L"] as const;
export type TaskSize = (typeof TASK_SIZES)[number];

export type Action = "allow" | "ask" | "deny";

export interface ModelRef {
  providerID: string;
  modelID: string;
}

/** Règle opencode telle que renvoyée par GET /agent (permission, motif, action). */
export interface Rule {
  permission: string;
  pattern: string;
  action: Action;
}

export interface AgentLite {
  name: string;
  mode: "primary" | "subagent" | "all";
  hidden?: boolean;
  model?: ModelRef;
  variant?: string;
  /** Règles effectives (GET /agent) ; absentes = inconnues. */
  permission?: Rule[];
}

export interface CommandLite {
  name: string;
  agent?: string;
  /** Forme « fournisseur/modèle » (prompt.ts:1540). */
  model?: string;
  /** « variant: » lu dans le fichier de la commande : opencode l'ignore, le cockpit l'injecte (§5.2). */
  fileVariant?: string;
  subtask?: boolean;
  source?: "command" | "mcp" | "skill";
}

/** Modèle du catalogue opencode (GET /config/providers), réduit à ce dont le résolveur a besoin. */
export interface CatalogLite {
  key: string;
  providerID: string;
  /** Nom affiché (facultatif). */
  name?: string;
  variants: string[];
  toolcall: boolean;
  status: string;
  contextLimit: number | null;
}

export type RunRole = "message" | "raccourci" | "delegue" | "reprise";
export type RunSource = "assistant" | "niveau" | "raccourci" | "assistant-du-raccourci" | "assistant-delegue" | "choix-avance";

/** Un appel de modèle facturé. */
export interface Run {
  role: RunRole;
  /** « fournisseur/modèle ». */
  model: string;
  variant: string | null;
  source: RunSource;
  /** Agent qui exécute cet appel. */
  agent?: string;
}

export type ProblemCode =
  | "assistant-ia-indisponible"
  | "ia-indisponible"
  | "fiche-refusee"
  | "agent-du-raccourci-introuvable"
  | "changement-ia-refuse"
  | "reflexion-inconnue"
  | "reflexion-assistant-ignoree"
  | "reflexion-deleguee-ignoree"
  | "ia-du-raccourci-ignoree";

export interface Problem {
  code: ProblemCode;
  /** true : rien ne doit être envoyé. */
  blocking: boolean;
  model?: string;
  agent?: string;
  command?: string;
  variant?: string;
}

export interface TurnLock {
  kind: "assistant" | "raccourci" | "assistant-delegue";
  name: string;
}

export interface Turn {
  /** Ce que le client envoie : modèle (objet) et réflexion. Pour /command, le modèle part en « fournisseur/modèle ». */
  send: { model: ModelRef; variant?: string };
  runs: Run[];
  lock: TurnLock | null;
  problems: Problem[];
}

/** En-tête qui autorise (mode Avancé + réglage) l'envoi d'une autre IA que celle d'un assistant, pour un message. */
export const MODEL_OVERRIDE_HEADER = "x-cockpit-model-override";

export const DEFAULT_ALLOWED_PROVIDERS: readonly string[] = Object.freeze(["github-copilot"]);

/** true si la liste est exactement la valeur livrée (sinon : bandeau rouge « Mode test »). */
export function isDefaultProviders(list: readonly string[]): boolean {
  return list.length === 1 && list[0] === "github-copilot";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isAction(v: unknown): v is Action {
  return v === "allow" || v === "ask" || v === "deny";
}

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

// --- Identifiants de modèles ------------------------------------------------------------

export function modelKey(ref: ModelRef): string {
  return `${ref.providerID}/${ref.modelID}`;
}

/** Portage de Provider.parseModel (provider.ts:2058-2064) : coupe au premier « / ». */
export function parseModelKey(model: string): ModelRef {
  const [providerID = "", ...rest] = model.split("/");
  return { providerID, modelID: rest.join("/") };
}

export function providerOf(model: string): string {
  return parseModelKey(model).providerID;
}

export function sameModel(a: ModelRef | undefined, b: ModelRef | undefined): boolean {
  return Boolean(a && b && a.providerID === b.providerID && a.modelID === b.modelID);
}

export function catalogEntry(catalog: readonly CatalogLite[], model: string): CatalogLite | undefined {
  return catalog.find((m) => m.key === model);
}

/** Nom affiché d'un modèle : nom du catalogue, sinon l'identifiant sans le fournisseur. */
export function modelName(model: string, catalog: readonly CatalogLite[] = []): string {
  return catalogEntry(catalog, model)?.name ?? (parseModelKey(model).modelID || model);
}

const loaded = (catalog: readonly CatalogLite[]) => catalog.length > 0;

/** true/false : réflexion proposée ou non ; null : modèle absent d'un catalogue chargé. Catalogue non chargé : true. */
function variantOffered(catalog: readonly CatalogLite[], model: ModelRef, variant: string): boolean | null {
  if (!loaded(catalog)) return true;
  const entry = catalogEntry(catalog, modelKey(model));
  return entry ? entry.variants.includes(variant) : null;
}

// --- Droits : portage exact d'opencode --------------------------------------------------

/**
 * Portage exact de Wildcard.match (packages/core/src/util/wildcard.ts @ v1.18.30).
 * `*` = n'importe quelle suite, `?` = un caractère, un motif terminé par « *» précédé d'une espace
 * accepte aussi l'absence d'arguments. Sensible à la casse sauf sous win32 (opencode tourne sous Linux).
 */
export function wildcardMatch(input: string, pattern: string, caseInsensitive = false): boolean {
  const normalized = input.replaceAll("\\", "/");
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");

  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?";

  return new RegExp("^" + escaped + "$", caseInsensitive ? "si" : "s").test(normalized);
}

/** Permission.evaluate (permission/index.ts:28-37) : la dernière règle qui correspond l'emporte, sinon « ask ». */
export function evaluate(rules: readonly Rule[], permission: string, input: string): Action {
  return rules.findLast((rule) => wildcardMatch(permission, rule.permission) && wildcardMatch(input, rule.pattern))?.action ?? "ask";
}

/** Chemins d'opencode dans son image Docker (utilisateur node), pour reproduire ses règles par défaut. */
export interface OpencodePaths {
  home: string;
  /** Global.Path.data (core/global.ts). */
  data: string;
  /** Global.Path.tmp = os.tmpdir()/opencode (core/global.ts). */
  tmp: string;
  /** Dossiers des fiches (skill.dirs()), autorisés hors du dossier de travail. */
  skillDirs: readonly string[];
}

export const OPENCODE_PATHS: Readonly<OpencodePaths> = Object.freeze({
  home: "/home/node",
  data: "/home/node/.local/share/opencode",
  tmp: "/tmp/opencode",
  skillDirs: Object.freeze([]) as readonly string[],
});

/** Truncate.GLOB (tool/truncate.ts:17) : sorties d'outils tronquées. */
export function truncateGlob(paths: Pick<OpencodePaths, "data"> = OPENCODE_PATHS): string {
  return `${paths.data}/tool-output/*`;
}

function expandHome(pattern: string, home: string): string {
  // permission/index.ts expand()
  if (pattern.startsWith("~/")) return home + pattern.slice(1);
  if (pattern === "~") return home;
  if (pattern.startsWith("$HOME/")) return home + pattern.slice(5);
  if (pattern.startsWith("$HOME")) return home + pattern.slice(5);
  return pattern;
}

/**
 * Permission.fromConfig (permission/index.ts:186-198) : l'ordre des clés est conservé ; une action seule vaut
 * `{ "*": action }` (core/v1/config/permission.ts). Les valeurs invalides sont ignorées.
 */
export function rulesFromConfig(permission: unknown, home: string = OPENCODE_PATHS.home): Rule[] {
  const input = typeof permission === "string" ? { "*": permission } : permission;
  if (!isPlainObject(input)) return [];
  const rules: Rule[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      if (isAction(value)) rules.push({ permission: key, pattern: "*", action: value });
      continue;
    }
    if (!isPlainObject(value)) continue;
    for (const [pattern, action] of Object.entries(value)) {
      if (isAction(action)) rules.push({ permission: key, pattern: expandHome(pattern, home), action });
    }
  }
  return rules;
}

/** Règles par défaut de tout agent (agent/agent.ts:108-136). */
export function opencodeDefaultPermission(paths: OpencodePaths = OPENCODE_PATHS): Record<string, Action | Record<string, Action>> {
  const whitelisted = [truncateGlob(paths), `${paths.tmp}/*`, ...paths.skillDirs.map((dir) => `${dir.replace(/\/+$/, "")}/*`)];
  return {
    "*": "allow",
    doom_loop: "ask",
    external_directory: { "*": "ask", ...Object.fromEntries(whitelisted.map((dir) => [dir, "allow" as const])) },
    question: "deny",
    plan_enter: "deny",
    plan_exit: "deny",
    read: { "*": "allow", "*.env": "ask", "*.env.*": "ask", "*.env.example": "allow" },
  };
}

/**
 * Règles effectives d'un agent personnalisé : défauts, puis configuration globale, puis agent
 * (agent/agent.ts:119-138, 293), puis Truncate.GLOB réautorisé sauf refus explicite (296-310).
 */
export function effectiveAgentRules(globalPermission: unknown, agentPermission: unknown, paths: OpencodePaths = OPENCODE_PATHS): Rule[] {
  return withTruncateAllowed(
    [
      ...rulesFromConfig(opencodeDefaultPermission(paths), paths.home),
      ...rulesFromConfig(globalPermission ?? {}, paths.home),
      ...rulesFromConfig(agentPermission ?? {}, paths.home),
    ],
    paths,
  );
}

function withTruncateAllowed(rules: Rule[], paths: OpencodePaths): Rule[] {
  const glob = truncateGlob(paths);
  const explicit = rules.some((r) => r.permission === "external_directory" && r.action === "deny" && r.pattern === glob);
  return explicit ? rules : [...rules, { permission: "external_directory", pattern: glob, action: "allow" }];
}

/**
 * Règles propres des assistants intégrés (agent/agent.ts:141-178), placées AVANT la configuration globale : le refus
 * de modification du Conseiller (plan) ne tient donc que si la configuration ne le réautorise pas, et il n'a aucune
 * règle de commande. Le motif d'édition relatif au worktree n'est pas reproduit (il dépend du dossier).
 */
export function builtinAgentPermission(name: "build" | "plan", paths: OpencodePaths = OPENCODE_PATHS): Record<string, unknown> {
  if (name === "build") return { question: "allow", plan_enter: "allow" };
  return {
    question: "allow",
    plan_exit: "allow",
    task: { general: "deny" },
    external_directory: { [`${paths.data.replace(/\/+$/, "")}/plans/*`]: "allow" },
    edit: { "*": "deny", ".opencode/plans/*.md": "allow" },
  };
}

/**
 * Règles effectives d'un assistant intégré quand GET /agent ne répond pas, dans l'ordre d'opencode : défauts, règles
 * propres, configuration globale, section agent.<nom>.permission (agent/agent.ts:293), puis Truncate.
 */
export function effectiveBuiltinRules(
  name: "build" | "plan",
  globalPermission: unknown,
  agentConfigPermission: unknown = {},
  paths: OpencodePaths = OPENCODE_PATHS,
): Rule[] {
  return withTruncateAllowed(
    [
      ...rulesFromConfig(opencodeDefaultPermission(paths), paths.home),
      ...rulesFromConfig(builtinAgentPermission(name, paths), paths.home),
      ...rulesFromConfig(globalPermission ?? {}, paths.home),
      ...rulesFromConfig(agentConfigPermission ?? {}, paths.home),
    ],
    paths,
  );
}

// --- Réflexion (variantes) --------------------------------------------------------------

const VARIANT_LABELS: Readonly<Record<string, string>> = {
  minimal: "Réflexion minimale",
  none: "Sans réflexion",
  low: "Réflexion légère",
  medium: "Réflexion normale",
  high: "Réflexion poussée",
  xhigh: "Réflexion maximale",
  max: "Réflexion maximale",
};

const VARIANT_SHORT: Readonly<Record<string, string>> = {
  minimal: "minimale",
  none: "aucune",
  low: "légère",
  medium: "normale",
  high: "poussée",
  xhigh: "maximale",
  max: "maximale",
};

/** Libellé d'une réflexion (§3). Le nom brut d'un réglage inconnu n'apparaît qu'en mode Avancé. */
export function variantLabel(v: string | null | undefined, advanced = false): string {
  if (!v) return "Réflexion standard";
  const label = own(VARIANT_LABELS, v);
  if (label) return label;
  return advanced ? `Réglage particulier (${v})` : "Réglage particulier";
}

/** Option du sélecteur du chat : « Réflexion : standard », « Réflexion : poussée »… */
export function variantOptionLabel(v: string | null | undefined, advanced = false): string {
  if (!v) return "Réflexion : standard";
  const short = own(VARIANT_SHORT, v);
  if (short) return `Réflexion : ${short}`;
  return advanced ? `Réflexion : réglage particulier (${v})` : "Réflexion : réglage particulier";
}

export const VARIANT_HELP = "Plus de réflexion = réponses plus lentes et plus chères.";

// --- Résolution de l'IA (opencode 1.18.30) ----------------------------------------------

/** `(agent.mode === "subagent" && cmd.subtask !== false) || cmd.subtask === true` (prompt.ts:1439). */
export function isSubtask(agent: Pick<AgentLite, "mode">, command: Pick<CommandLite, "subtask">): boolean {
  return (agent.mode === "subagent" && command.subtask !== false) || command.subtask === true;
}

/** Réflexion propre de l'agent, appliquée seulement sur son propre modèle et si elle existe (prompt.ts:647-654). */
function agentOwnVariant(agent: AgentLite, model: ModelRef, catalog: readonly CatalogLite[]): string | undefined {
  if (!agent.model || !agent.variant || !sameModel(agent.model, model)) return undefined;
  return variantOffered(catalog, model, agent.variant) === true ? agent.variant : undefined;
}

function sendOf(model: ModelRef, variant: string | undefined): Turn["send"] {
  const copy = { providerID: model.providerID, modelID: model.modelID };
  return variant ? { model: copy, variant } : { model: copy };
}

export interface ChatTurnInput {
  /** Agent choisi dans le chat (repli déjà appliqué s'il est inconnu). */
  agent: AgentLite;
  /** IA résolue du niveau de la conversation. */
  tierModel: ModelRef;
  /** Réflexion choisie pour le niveau (null : standard). */
  tierVariant: string | null;
  /** IA choisie à la main (« Autre IA… », mode Avancé). */
  override?: ModelRef & { variant?: string };
  /** mode Avancé ET ai.allowModelOverride (ET, côté proxy, en-tête x-cockpit-model-override: 1). */
  allowOverride: boolean;
  /** Catalogue ; vide = non chargé (disponibilité et réflexions non vérifiées). */
  catalog: CatalogLite[];
}

/**
 * Message (`prompt_async`), règle R1 : `model = input.model ?? agent.model ?? session` (prompt.ts:646) ;
 * réflexion = `input.variant`, sinon celle de l'agent si le modèle est le sien et qu'elle existe (647-654).
 * Le cockpit envoie toujours un modèle : c'est donc lui qui décide ici de l'IA de l'assistant.
 */
export function resolveChatTurn(i: ChatTurnInput): Turn {
  const { agent, catalog } = i;
  const problems: Problem[] = [];

  const checked = (model: ModelRef, variant: string | null | undefined): string | undefined => {
    if (!variant) return undefined;
    const offered = variantOffered(catalog, model, variant);
    if (offered === true) return variant;
    // Une réflexion inconnue est ignorée sans erreur par opencode (session/llm/request.ts:80-91) : on ne l'envoie pas.
    if (offered === false) problems.push({ code: "reflexion-inconnue", blocking: false, model: modelKey(model), variant });
    return undefined;
  };

  const finish = (model: ModelRef, variant: string | undefined, source: RunSource, lock: TurnLock | null): Turn => {
    const key = modelKey(model);
    if (loaded(catalog) && !catalogEntry(catalog, key)) {
      problems.push(
        source === "assistant"
          ? { code: "assistant-ia-indisponible", blocking: true, model: key, agent: agent.name }
          : { code: "ia-indisponible", blocking: true, model: key },
      );
    }
    return {
      send: sendOf(model, variant),
      runs: [{ role: "message", model: key, variant: variant ?? null, source, agent: agent.name }],
      lock,
      problems,
    };
  };

  if (agent.model) {
    const differs = i.override !== undefined && !sameModel(i.override, agent.model);
    if (differs && i.override && i.allowOverride) {
      if (agent.variant) problems.push({ code: "reflexion-assistant-ignoree", blocking: false, agent: agent.name });
      return finish(i.override, checked(i.override, i.override.variant), "choix-avance", null);
    }
    if (differs && i.override) problems.push({ code: "changement-ia-refuse", blocking: false, agent: agent.name, model: modelKey(i.override) });
    const ownVariant = !differs && i.override?.variant && i.allowOverride ? i.override.variant : agent.variant;
    return finish(agent.model, checked(agent.model, ownVariant), "assistant", { kind: "assistant", name: agent.name });
  }
  if (i.override) return finish(i.override, checked(i.override, i.override.variant), "choix-avance", null);
  return finish(i.tierModel, checked(i.tierModel, i.tierVariant), "niveau", null);
}

export interface CommandTurnInput {
  command: CommandLite;
  /** Agents connus (GET /agent). */
  agents: AgentLite[];
  /** Agent du chat (celui envoyé dans le corps). */
  chatAgent: AgentLite;
  /** Tour du chat résolu par resolveChatTurn (IA et réflexion de la conversation). */
  chatTurn: Turn;
  catalog: CatalogLite[];
}

/**
 * Raccourci (`command`), règles R2, R3, R5 :
 * - agent = `cmd.agent ?? input.agent` (prompt.ts:1370) ;
 * - IA = `cmd.model` > IA de l'agent du raccourci > IA du corps > session (prompt.ts:1411-1419) ;
 * - délégué si `(agent.mode === "subagent" && cmd.subtask !== false) || cmd.subtask === true` (prompt.ts:1439) :
 *   le sous-agent garde sa propre IA (task.ts:181-184), hérite de la réflexion seulement sans IA propre (task.ts:209),
 *   puis un tour de reprise tourne sur l'agent et l'IA du message parent (prompt.ts:432-446) ;
 * - la « variant: » d'un fichier de commande est ignorée par opencode (command/index.ts:22-32, 90-103) : le cockpit
 *   la place dans le corps quand le raccourci n'est pas délégué.
 * Le corps envoyé porte toujours `agent = chatAgent` et `model = "fournisseur/modèle"` de la conversation.
 */
export function resolveCommandTurn(i: CommandTurnInput): Turn {
  const { command: cmd, chatAgent, chatTurn, catalog } = i;
  const chat = chatTurn.send;
  const chatSource: RunSource = chatTurn.runs.find((r) => r.role === "message")?.source ?? "niveau";
  const problems: Problem[] = [];
  const byName = (name: string) => i.agents.find((a) => a.name === name) ?? (chatAgent.name === name ? chatAgent : undefined);

  // Toute fiche est aussi /nom, sans contrôle de permission.skill (command/index.ts:134-152) : le cockpit l'applique.
  if (cmd.source === "skill" && chatAgent.permission && evaluate(chatAgent.permission, "skill", cmd.name) === "deny") {
    problems.push({ code: "fiche-refusee", blocking: true, agent: chatAgent.name, command: cmd.name });
  }

  const agent = cmd.agent !== undefined ? byName(cmd.agent) : chatAgent;
  if (!agent) {
    // opencode : « Agent not found » (prompt.ts:1423-1429).
    problems.push({ code: "agent-du-raccourci-introuvable", blocking: true, command: cmd.name, agent: cmd.agent ?? "" });
    return { send: sendOf(chat.model, chat.variant), runs: [], lock: chatTurn.lock, problems };
  }

  let taskModel: ModelRef;
  let taskSource: RunSource;
  if (cmd.model) {
    taskModel = parseModelKey(cmd.model);
    taskSource = "raccourci";
  } else if (cmd.agent !== undefined && agent.model) {
    taskModel = agent.model;
    taskSource = "assistant-du-raccourci";
  } else {
    taskModel = chat.model;
    taskSource = chatSource;
  }
  const ownsModel = taskSource === "raccourci" || taskSource === "assistant-du-raccourci";
  const taskIsChat = sameModel(taskModel, chat.model);
  const runs: Run[] = [];
  let bodyVariant: string | undefined;
  let lock: TurnLock | null = ownsModel ? { kind: "raccourci", name: cmd.name } : chatTurn.lock;

  if (!isSubtask(agent, cmd)) {
    if (cmd.fileVariant) {
      const offered = variantOffered(catalog, taskModel, cmd.fileVariant);
      if (offered === true) bodyVariant = cmd.fileVariant;
      else if (offered === false) {
        problems.push({ code: "reflexion-inconnue", blocking: false, command: cmd.name, model: modelKey(taskModel), variant: cmd.fileVariant });
      }
    }
    if (bodyVariant === undefined && taskIsChat) bodyVariant = chat.variant;
    // prompt({ model: taskModel, agent, variant: input.variant }) (prompt.ts:1466-1473) puis R1 (647-654).
    const effective = bodyVariant ?? agentOwnVariant(agent, taskModel, catalog);
    runs.push({ role: "raccourci", model: modelKey(taskModel), variant: effective ?? null, source: taskSource, agent: agent.name });
  } else {
    if (cmd.fileVariant) problems.push({ code: "reflexion-deleguee-ignoree", blocking: false, command: cmd.name, variant: cmd.fileVariant });
    if (agent.model) {
      if (cmd.model && !sameModel(parseModelKey(cmd.model), agent.model)) {
        problems.push({ code: "ia-du-raccourci-ignoree", blocking: false, command: cmd.name, agent: agent.name, model: modelKey(agent.model) });
      }
      // La réflexion envoyée n'atteint que la reprise, sur l'IA de la conversation.
      bodyVariant = chat.variant;
      runs.push({
        role: "delegue",
        model: modelKey(agent.model),
        variant: agentOwnVariant(agent, agent.model, catalog) ?? null,
        source: "assistant-delegue",
        agent: agent.name,
      });
      lock = { kind: "assistant-delegue", name: agent.name };
    } else {
      // Pas de réflexion vers une autre IA : elle serait héritée par le travail délégué (task.ts:179, 209).
      bodyVariant = taskIsChat ? chat.variant : undefined;
      const parent = bodyVariant ?? agentOwnVariant(chatAgent, chat.model, catalog);
      runs.push({
        role: "delegue",
        model: modelKey(taskModel),
        variant: parent && variantOffered(catalog, taskModel, parent) === true ? parent : null,
        source: taskSource,
        agent: agent.name,
      });
    }
    // Message parent : agent et IA du corps (prompt.ts:1453-1473) ; la reprise reprend les deux (432-446).
    const reprise = bodyVariant ?? agentOwnVariant(chatAgent, chat.model, catalog);
    runs.push({ role: "reprise", model: modelKey(chat.model), variant: reprise ?? null, source: chatSource, agent: chatAgent.name });
  }

  if (loaded(catalog)) {
    const loadedModels = new Set(runs.map((r) => r.model));
    // opencode charge l'IA du raccourci avant tout appel, même quand l'assistant délégué impose la sienne
    // (prompt.ts:1421 puis 267) : absente du compte, la demande échouerait après l'envoi.
    if (cmd.model) loadedModels.add(modelKey(parseModelKey(cmd.model)));
    for (const key of loadedModels) {
      if (!catalogEntry(catalog, key)) problems.push({ code: "ia-indisponible", blocking: true, model: key, command: cmd.name });
    }
  }
  return { send: sendOf(chat.model, bodyVariant), runs, lock, problems };
}

/** Modèles facturés par un tour, sans doublon. */
export function billedModels(turn: Turn): string[] {
  return [...new Set(turn.runs.map((r) => r.model))];
}

export function hasBlockingProblem(turn: Pick<Turn, "problems">): boolean {
  return turn.problems.some((p) => p.blocking);
}

// --- Messages ----------------------------------------------------------------------------

export const MESSAGES = Object.freeze({
  fournisseurRefuse: "Seules les IA GitHub Copilot sont autorisées dans ce cockpit.",
  modeAvance: "Action réservée au mode Avancé (Paramètres › Affichage).",
  sessionsBusy: "Attendez la fin des réponses en cours.",
  rejectedByOpencode: "La configuration n'a pas été acceptée : rien n'a été modifié.",
  opencodeInjoignable:
    "Le moteur de l'assistant ne répond pas. Réessayez dans une minute ; si cela continue, ouvrez la page Diagnostic.",
  iaAbsenteDuCompte: "Cette IA n'est pas disponible sur votre compte Copilot.",
  catalogueIndisponible:
    "Liste des IA indisponible : impossible de vérifier cette IA. Reconnectez GitHub Copilot puis réessayez.",
  lockTooltip: "Cet assistant utilise toujours cette IA. Pour la changer, modifiez l'assistant (page Assistants).",
  modelNotFoundTitle: "L'IA demandée n'est pas disponible",
  modelNotFound:
    "Copilot ne propose pas l'IA utilisée par cette demande. Ouvrez Paramètres › Niveaux d'IA ou choisissez un autre assistant.",
  agentMissingTitle: "Assistant introuvable",
  delegatedHelp: "Après le travail délégué, l'IA de la conversation reprend la main pour résumer le résultat et peut poursuivre.",
  testProviderBanner: "Mode test : un fournisseur autre que GitHub Copilot est autorisé.",
  confidentialityBanner:
    "Avant d'envoyer : aucune donnée client, aucun mot de passe, aucune clé. Relisez toujours la réponse : l'IA peut se tromper.",
  catalogueReview: "Exemple à relire avec votre équipe",
  estimateFootnote: "Estimation, pas une facture : le coût réel apparaîtra dans la page Coûts.",
});

/** « « {nom} » n'existe plus : la conversation continue avec l'Assistant général. » */
export function agentMissingMessage(name: string, fallbackTitle = "l'Assistant général"): string {
  return `« ${name} » n'existe plus : la conversation continue avec ${fallbackTitle}.`;
}

/** Toast après le renvoi automatique d'un 409 assistant-model-changed. */
export function assistantModelChangedMessage(modelDisplayName: string): string {
  return `L'IA de cet assistant a changé : ${modelDisplayName} est utilisée.`;
}

export interface ProblemNames {
  agentTitle?: (name: string) => string;
  modelName?: (model: string) => string;
}

/** Texte français d'un problème du résolveur (mêmes textes côté proxy et interface). */
export function problemMessage(p: Problem, names: ProblemNames = {}): string {
  const title = (n: string | undefined) => (n ? (names.agentTitle?.(n) ?? n) : "");
  const model = (m: string | undefined) => (m ? (names.modelName?.(m) ?? (parseModelKey(m).modelID || m)) : "");
  switch (p.code) {
    case "assistant-ia-indisponible":
      return `L'IA de cet assistant (« ${model(p.model)} ») n'est plus disponible sur votre compte Copilot. Rien n'a été envoyé.`;
    case "ia-indisponible":
      return `L'IA « ${model(p.model)} » n'est pas disponible sur votre compte Copilot. Rien n'a été envoyé ni facturé.`;
    case "fiche-refusee":
      return `L'assistant « ${title(p.agent)} » n'a pas accès à la fiche « ${p.command ?? ""} ». Choisissez l'assistant qui l'utilise ou l'Assistant général.`;
    case "agent-du-raccourci-introuvable":
      return `Le raccourci /${p.command ?? ""} utilise l'assistant « ${title(p.agent)} », qui n'existe plus.`;
    case "changement-ia-refuse":
      return MESSAGES.lockTooltip;
    case "reflexion-inconnue":
      return `La réflexion « ${p.variant ?? ""} » n'est pas proposée par ${model(p.model)} : elle est ignorée.`;
    case "reflexion-assistant-ignoree":
      return "La réflexion de l'assistant ne s'applique pas à une autre IA.";
    case "reflexion-deleguee-ignoree":
      return "La réflexion d'un travail délégué est ignorée : réglez-la sur l'assistant délégué.";
    case "ia-du-raccourci-ignoree":
      return `Cette IA ne sera pas utilisée : l'assistant délégué « ${title(p.agent)} » impose ${model(p.model)}.`;
  }
}

// --- Niveaux d'IA ------------------------------------------------------------------------

export interface TierDef {
  /** Candidats « fournisseur/modèle », dans l'ordre de préférence (1 à 4). */
  candidates: readonly string[];
  variant: string | null;
}

export type TierDefs = Record<Tier, TierDef>;

const freezeTier = (candidates: string[]): TierDef => Object.freeze({ candidates: Object.freeze(candidates), variant: null });

/** Recommandation livrée avec le cockpit (décision utilisateur, §6). Clés présentes dans COPILOT_PRICES. */
export const DEFAULT_TIERS: Readonly<TierDefs> = Object.freeze({
  rapide: freezeTier(["github-copilot/gpt-5.4-mini", "github-copilot/gpt-5-mini", "github-copilot/claude-haiku-4.5"]),
  equilibre: freezeTier(["github-copilot/claude-sonnet-5", "github-copilot/gpt-5.3-codex", "github-copilot/claude-sonnet-4.6"]),
  expert: freezeTier(["github-copilot/claude-opus-5", "github-copilot/claude-opus-4.8", "github-copilot/gpt-5.6-sol"]),
});

export const TIER_LABELS: Readonly<Record<Tier, string>> = Object.freeze({ rapide: "Rapide", equilibre: "Équilibré", expert: "Expert" });

export const TIER_HELP: Readonly<Record<Tier, string>> = Object.freeze({
  rapide: "Questions simples, explications, résumés.",
  equilibre: "Relecture de scripts, requêtes, runbooks, changements courants. Choix par défaut.",
  expert: "Cas difficiles : changement majeur, incident complexe. IA chère : confirmation quand le budget est entamé.",
});

export type TierStatus = "ok" | "secours" | "indisponible" | "non-verifie";

export const TIER_STATUS_LABELS: Readonly<Record<TierStatus, string>> = Object.freeze({
  ok: "Disponible",
  secours: "IA de secours",
  indisponible: "Indisponible",
  "non-verifie": "Non vérifié",
});

export const TIER_STATUS_HELP: Readonly<Record<TierStatus, string | null>> = Object.freeze({
  ok: null,
  secours: null,
  indisponible: "Aucune des IA prévues n'est proposée par votre abonnement Copilot.",
  "non-verifie": "Liste des IA Copilot indisponible pour le moment.",
});

export interface TierResolution {
  model: string | null;
  status: TierStatus;
  variant: string | null;
  warnings: string[];
}

/** Prix de sortie (USD / M jetons) à partir duquel un modèle est « Réservé (très cher) ». */
export const RESERVED_OUTPUT_PRICE = 30;
export const RESERVED_HELP = "Ce modèle coûte jusqu'à 50 $ par million de jetons produits : une enquête peut dépasser 2 $.";

/** Modèle Copilot à prix promotionnel temporaire (note de COPILOT_PRICES). */
export function isPromoModel(model: string): boolean {
  const { providerID, modelID } = parseModelKey(model);
  return providerID === "github-copilot" && Boolean(own(COPILOT_PRICES, modelID)?.note);
}

/** Jamais proposé par défaut : prix promotionnel ou sortie ≥ 30 $/M (groupe « Réservé » du mode Avancé). */
export function isReservedModel(model: string, price: ModelPrice | null): boolean {
  return isPromoModel(model) || (price?.rates.output ?? 0) >= RESERVED_OUTPUT_PRICE;
}

/** Définitions en vigueur : réglage personnalisé, sinon la recommandation livrée. */
export function effectiveTiers(custom: TierDefs | null | undefined): TierDefs {
  return custom ?? DEFAULT_TIERS;
}

/**
 * Premier candidat présent au catalogue, d'un fournisseur autorisé, capable d'utiliser les outils et pas en fin de vie
 * (status « deprecated »), conception §6. Un modèle à prix promotionnel n'est jamais dans la recommandation livrée,
 * mais un candidat choisi dans le groupe « Réservé » du mode Avancé est utilisé. Catalogue non chargé : « non-verifie »
 * avec le premier candidat autorisé (non vérifié). La réflexion est retirée, avec un avertissement, si l'IA retenue ne
 * la propose pas.
 */
export function resolveTier(def: TierDef, catalog: readonly CatalogLite[], allowed: readonly string[]): TierResolution {
  const warnings: string[] = [];
  const name = (candidate: string) => modelName(candidate, catalog);
  if (!loaded(catalog)) {
    const first = def.candidates.find((c) => allowed.includes(providerOf(c))) ?? null;
    return { model: first, status: "non-verifie", variant: first ? def.variant : null, warnings: [TIER_STATUS_HELP["non-verifie"] ?? ""] };
  }
  for (const [index, candidate] of def.candidates.entries()) {
    if (!allowed.includes(providerOf(candidate))) {
      warnings.push(`${name(candidate)} : fournisseur non autorisé dans ce cockpit.`);
      continue;
    }
    const entry = catalogEntry(catalog, candidate);
    if (!entry) {
      warnings.push(`${name(candidate)} n'est pas proposée par votre abonnement Copilot.`);
      continue;
    }
    if (!entry.toolcall) {
      warnings.push(`${name(candidate)} ne sait pas utiliser les outils : ignorée.`);
      continue;
    }
    if (entry.status === "deprecated") {
      warnings.push(`${name(candidate)} est en fin de vie : ignorée.`);
      continue;
    }
    let variant = def.variant;
    if (variant && !entry.variants.includes(variant)) {
      warnings.push(`${name(candidate)} ne propose pas la ${variantLabel(variant, true).toLowerCase()} : réflexion standard utilisée.`);
      variant = null;
    }
    return { model: candidate, status: index === 0 ? "ok" : "secours", variant, warnings };
  }
  return { model: null, status: "indisponible", variant: null, warnings };
}

/**
 * Niveau de la conversation « Indisponible » : l'IA prévue qui sert de repli a été écartée par resolveTier (absente,
 * sans outils, en fin de vie ou d'un fournisseur non autorisé). Chaque appel sur l'IA du niveau devient bloquant au
 * lieu de partir en silence sur ce candidat.
 */
export function withTierAvailability(turn: Turn, status: TierStatus | null | undefined): Turn {
  if (status !== "indisponible") return turn;
  const problems = [...turn.problems];
  for (const run of turn.runs) {
    if (run.source !== "niveau") continue;
    if (problems.some((p) => p.code === "ia-indisponible" && p.model === run.model)) continue;
    problems.push({ code: "ia-indisponible", blocking: true, model: run.model });
  }
  return problems.length === turn.problems.length ? turn : { ...turn, problems };
}

/** Niveau dont l'IA résolue est ce modèle (premier trouvé dans l'ordre Rapide, Équilibré, Expert). */
export function tierOfModel(model: string, resolved: Readonly<Partial<Record<Tier, Pick<TierResolution, "model">>>>): Tier | null {
  return TIER_IDS.find((id) => resolved[id]?.model === model) ?? null;
}

/** « {prévue} n'est pas proposée par votre abonnement : {secours} est utilisée. » */
export function fallbackText(plannedName: string, usedName: string): string {
  return `${plannedName} n'est pas proposée par votre abonnement : ${usedName} est utilisée.`;
}

// --- Estimations -------------------------------------------------------------------------

/** Profils d'une demande (conception, recherche « banking » §2.1) : nouvelle entrée comptée en écriture de cache. */
export interface TaskProfile {
  calls: number;
  newInput: number;
  cachedInput: number;
  output: number;
}

export const TASK_PROFILES: Readonly<Record<TaskSize, Readonly<TaskProfile>>> = Object.freeze({
  S: Object.freeze({ calls: 2, newInput: 13_500, cachedInput: 13_200, output: 2_400 }),
  M: Object.freeze({ calls: 5, newInput: 39_000, cachedInput: 108_000, output: 6_000 }),
  L: Object.freeze({ calls: 15, newInput: 85_000, cachedInput: 791_000, output: 18_000 }),
});

/** Nombre maximum d'actions (steps) selon la taille des demandes. */
export const TASK_STEPS: Readonly<Record<TaskSize, number>> = Object.freeze({ S: 20, M: 40, L: 80 });

export const TASK_SIZE_LABELS: Readonly<Record<TaskSize, string>> = Object.freeze({
  S: "Courte question",
  M: "Un fichier ou un document",
  L: "Plusieurs fichiers",
});

export const TASK_SIZE_HINT = "Sert à estimer le coût et à fixer le nombre maximum d'actions.";

/**
 * Coût estimé d'une demande : computeCost appliqué à un appel moyen du profil (le palier de prix dépend du contexte
 * d'un appel), multiplié par le nombre d'appels.
 */
export function estimateTaskCost(price: ModelPrice, size: TaskSize): number {
  const p = TASK_PROFILES[size];
  const perCall = computeCost(
    { input: 0, cacheWrite: p.newInput / p.calls, cacheRead: p.cachedInput / p.calls, output: p.output / p.calls, reasoning: 0 },
    price,
  );
  return roundUsd(perCall * p.calls);
}

export function taskCosts(price: ModelPrice | null): { S: number; M: number; L: number } | null {
  if (!price) return null;
  return { S: estimateTaskCost(price, "S"), M: estimateTaskCost(price, "M"), L: estimateTaskCost(price, "L") };
}

/** Nombre d'échantillons observés à partir duquel la moyenne réelle remplace le profil. */
export const OBSERVED_MIN_SAMPLES = 5;

export interface Estimate {
  usd: number;
  source: "observed" | "profile";
  samples: number;
  size: TaskSize;
}

/** Moyenne observée (≥ 5 demandes) sinon profil S/M/L ; null sans prix ni observation. */
export function chooseEstimate(observed: { avgUsd: number | null; samples: number } | null, price: ModelPrice | null, size: TaskSize): Estimate | null {
  if (observed && observed.avgUsd !== null && observed.samples >= OBSERVED_MIN_SAMPLES) {
    return { usd: roundUsd(observed.avgUsd), source: "observed", samples: observed.samples, size };
  }
  if (!price) return null;
  return { usd: estimateTaskCost(price, size), source: "profile", samples: observed?.samples ?? 0, size };
}

/** « 0,18 $ » ; montant entier ≥ 1 sans décimales (« 150 $ ») ; très petit montant « < 0,01 $ ». */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) return "—";
  if (usd > 0 && usd < 0.005) return "< 0,01 $";
  const cents = Math.round(usd * 100) / 100;
  if (cents >= 1 && Number.isInteger(cents)) return `${cents} $`;
  return `${cents.toFixed(2).replace(".", ",")} $`;
}

/** « ≈ 0,18 $ par demande » */
export function perRequestText(usd: number): string {
  return `≈ ${formatUsd(usd)} par demande`;
}

/** « ≈ 0,18 $ » ou « ≈ 0,18–0,40 $ » */
export function rangeText(min: number, max: number): string {
  if (formatUsd(min) === formatUsd(max)) return `≈ ${formatUsd(max)}`;
  return `≈ ${formatUsd(min).replace(/ \$$/, "")}–${formatUsd(max)}`;
}

/** « ≈ 0,18 $ par demande » ; `detailed` ajoute « (estimation) » ou « (moyenne de vos 12 dernières demandes) ». */
export function estimateText(e: Estimate, detailed = false): string {
  const base = perRequestText(e.usd);
  if (!detailed) return base;
  return e.source === "observed" ? `${base} (moyenne de vos ${e.samples} dernières demandes)` : `${base} (estimation)`;
}

/** « 20 demandes ≈ 3,60 $, soit 2 % de votre budget mensuel (150 $) » */
export function budgetShareText(usd: number, monthlyBudgetUsd: number, count = 20): string {
  const total = usd * count;
  const share = monthlyBudgetUsd > 0 ? `, soit ${Math.round((total / monthlyBudgetUsd) * 100)} % de votre budget mensuel (${formatUsd(monthlyBudgetUsd)})` : "";
  return `${count} demandes ≈ ${formatUsd(total)}${share}`;
}

/** Note « IA chère » (carte d'identité, aperçu) quand le prix de sortie dépasse le seuil du garde-fou. */
export function expensiveGuardNote(fromPercent: number): string {
  return `IA chère : une confirmation vous sera demandée à partir de ${Math.round(fromPercent)} % du budget du mois.`;
}

export const BUDGET_CONFIRM_TITLE = "Confirmer une demande coûteuse";
export const BUDGET_CONFIRM_SEND = "Envoyer quand même";
export const BUDGET_CONFIRM_CANCEL = "Annuler";

/** Texte de confirmation du garde-fou budgétaire (§9.2). */
export function budgetConfirmMessage(i: {
  atLimit: boolean;
  percent: number;
  spentUsd: number;
  budgetUsd: number;
  modelName: string;
  tier: Tier | null;
  usd: number | null;
  command: string | null;
}): { title: string; message: string } {
  if (i.atLimit) {
    return {
      title: BUDGET_CONFIRM_TITLE,
      message: `Budget du mois atteint (${formatUsd(i.spentUsd)} sur ${formatUsd(i.budgetUsd)}). Cette demande reste facturée sur votre compte GitHub Copilot. Envoyer quand même ?`,
    };
  }
  const level = i.tier ? ` (niveau ${TIER_LABELS[i.tier]})` : "";
  const cost = i.usd !== null ? ` : environ ${formatUsd(i.usd)}` : "";
  const via = i.command ? `, via le raccourci /${i.command}` : "";
  return {
    title: BUDGET_CONFIRM_TITLE,
    message: `${Math.round(i.percent)} % du budget du mois est consommé. Cette demande utilise ${i.modelName}${level}${cost}${via}. Envoyer quand même ?`,
  };
}

// --- Assistants : brouillon et droits ----------------------------------------------------

export const USE_CASES = ["analyser", "relire", "rediger", "expliquer", "autre"] as const;
export type UseCase = (typeof USE_CASES)[number];

export const RIGHTS_PROFILES = ["lecture", "propose"] as const;
export type RightsProfile = (typeof RIGHTS_PROFILES)[number];
export type RightsLabel = RightsProfile | "personnalise";

export const REFLECTIONS = ["standard", "poussee"] as const;
export type Reflection = (typeof REFLECTIONS)[number];

/** Icônes proposées (noms présents dans web/components/Icon.tsx). */
export const ASSISTANT_ICONS = ["search", "eye", "edit", "book", "sparkle", "shield", "terminal", "alert", "file", "wrench", "list", "chat"] as const;
export type AssistantIcon = (typeof ASSISTANT_ICONS)[number];

export const USE_CASE_INFO: Readonly<Record<UseCase, { label: string; hint: string; color: string; icon: AssistantIcon }>> = Object.freeze({
  analyser: { label: "Analyser", hint: "un incident, une alerte, des journaux", color: "#e5484d", icon: "search" },
  relire: { label: "Relire", hint: "un script, une requête SQL, du code d'infrastructure", color: "#12a594", icon: "eye" },
  rediger: { label: "Rédiger", hint: "un runbook, un postmortem, une communication", color: "#978365", icon: "edit" },
  expliquer: { label: "Expliquer", hint: "du code existant, une documentation", color: "#ffb224", icon: "book" },
  autre: { label: "Autre", hint: "", color: "#8b8d98", icon: "sparkle" },
});

export const RIGHTS_INFO: Readonly<Record<RightsLabel, { label: string; help: string }>> = Object.freeze({
  lecture: {
    label: "Lecture seule",
    help: "Il lit les fichiers du projet et vous répond. Il ne modifie rien et ne lance aucune commande.",
  },
  propose: {
    label: "Propose, vous validez",
    help: "Il peut préparer des modifications et des commandes, mais vous demande avant chacune.",
  },
  personnalise: { label: "Personnalisé", help: "Droits réglés à la main dans le Studio : vérifiez ce qu'il peut faire." },
});

/**
 * Assistants intégrés d'opencode, tels qu'affichés quand leurs règles effectives sont inconnues. opencode 1.18.30
 * n'impose pas la lecture seule au Conseiller (plan) : la configuration globale passe après son refus de modification
 * et il n'a aucune règle de commande (agent/agent.ts:156-178). Voir builtinAssistantInfo.
 */
export const BUILTIN_ASSISTANTS: Readonly<Record<"build" | "plan", { title: string; help: string }>> = Object.freeze({
  build: {
    title: "Assistant général",
    help: "Pour les demandes qui ne correspondent à aucun assistant. Demande avant de modifier ou d'exécuter.",
  },
  plan: { title: "Conseiller", help: "Réfléchit et propose un plan. Ses droits suivent vos réglages : vérifiez ce qu'il peut faire." },
});

/** Conseiller dont les règles effectives refusent toute modification et toute commande. */
export const PLAN_READ_ONLY: Readonly<{ title: string; help: string }> = Object.freeze({
  title: "Conseiller (lecture seule)",
  help: "Réfléchit et propose un plan, sans rien modifier.",
});

/** true si ces règles refusent la modification de fichiers et les commandes (entrées d'exemple de la carte d'identité). */
export function isReadOnlyRules(rules: readonly Rule[]): boolean {
  return evaluate(rules, "edit", RIGHT_SAMPLES.edit) === "deny" && evaluate(rules, "bash", RIGHT_SAMPLES.bash) === "deny";
}

/** Titre et aide d'un assistant intégré : « lecture seule » seulement quand ses règles effectives le garantissent. */
export function builtinAssistantInfo(name: "build" | "plan", rules?: readonly Rule[] | null): { title: string; help: string } {
  return name === "plan" && rules && isReadOnlyRules(rules) ? PLAN_READ_ONLY : BUILTIN_ASSISTANTS[name];
}

export const DRAFT_LIMITS = Object.freeze({
  titleMin: 3,
  titleMax: 80,
  descriptionMin: 10,
  descriptionMax: 500,
  instructionsMin: 20,
  instructionsMax: 20_000,
  fichesMax: 10,
  examplesMax: 3,
  exampleMax: 200,
});

/** Brouillon d'assistant (assistant, création, « Modifier », « Compléter »). Le schéma zod strict vit côté serveur. */
export interface AssistantDraft {
  title: string;
  description: string;
  useCase: UseCase;
  rights: RightsProfile;
  web: boolean;
  tier: Tier | null;
  /** IA précise « fournisseur/modèle » : seulement si tier === null, en mode Avancé, fournisseur autorisé. */
  model?: string | null;
  reflection: Reflection;
  taskSize: TaskSize;
  instructions: string;
  fiches: string[];
  examples: string[];
  icon: AssistantIcon;
  /** Nom technique imposé (sinon dérivé du titre). */
  name?: string;
}

/** Nom technique opencode (identique à studio-schema.ts NAME_RE). */
export const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Nom de fiche : comme NAME_RE, mais jamais uniquement des chiffres (une clé numérique serait réordonnée avant « * »). */
export const FICHE_NAME_RE = /^(?![0-9]+$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ASSISTANT_NAME_MAX = 48;

/** Motifs de lecture des fichiers de clés, en minuscules et majuscules (§7.1). Pas de clé « * » : le défaut .env reste « ask ». */
export const KEY_FILE_READ_RULES: Readonly<Record<string, Action>> = Object.freeze({
  "*.env": "ask",
  "*.env.*": "ask",
  "*.env.example": "allow",
  "*.pfx": "deny",
  "*.PFX": "deny",
  "*.p12": "deny",
  "*.P12": "deny",
  "*.key": "deny",
  "*.KEY": "deny",
  "*.jks": "deny",
  "*.JKS": "deny",
  "*.keystore": "deny",
  "*.kdbx": "deny",
  "*privkey*": "deny",
  "*-key.pem": "deny",
  "*_key.pem": "deny",
  "*id_rsa*": "deny",
  "*id_ecdsa*": "deny",
  "*id_ed25519*": "deny",
  "*kubeconfig*": "deny",
  "*.kube/config": "deny",
});

function checkFiches(fiches: readonly string[]): string[] {
  const out: string[] = [];
  for (const fiche of fiches) {
    if (!FICHE_NAME_RE.test(fiche) || fiche.length > 64) throw new RangeError(`Nom de fiche invalide : ${fiche.slice(0, 64)}`);
    if (!out.includes(fiche)) out.push(fiche);
  }
  return out;
}

/** Bloc `permission` d'un profil de droits (§7.2). `task` toujours refusé ; external_directory et question non définis. */
export function assistantPermission(rights: RightsProfile, web: boolean, fiches: readonly string[]): Record<string, unknown> {
  const list = checkFiches(fiches);
  const internet: Action = web ? "ask" : "deny";
  return {
    edit: rights === "lecture" ? "deny" : "ask",
    bash: rights === "lecture" ? "deny" : { "*": "ask" },
    task: "deny",
    webfetch: internet,
    websearch: internet,
    skill: list.length > 0 ? { "*": "deny", ...Object.fromEntries(list.map((f) => [f, "allow"])) } : "deny",
    read: { ...KEY_FILE_READ_RULES },
  };
}

/** Profil de droits d'un bloc `permission` de fichier : « personnalise » s'il ne correspond exactement à aucun profil. */
export function detectRights(permission: unknown): { rights: RightsLabel; web: boolean; fiches: string[] } {
  const p = isPlainObject(permission) ? permission : null;
  const web = p?.webfetch === "ask";
  const skill = p?.skill;
  const fiches = isPlainObject(skill) ? Object.entries(skill).filter(([k, v]) => k !== "*" && v === "allow").map(([k]) => k) : [];
  if (!p || !fiches.every((f) => FICHE_NAME_RE.test(f) && f.length <= 64)) return { rights: "personnalise", web, fiches };
  const actual = JSON.stringify(p);
  const match = RIGHTS_PROFILES.find((profile) => JSON.stringify(assistantPermission(profile, web, fiches)) === actual);
  return { rights: match ?? "personnalise", web, fiches };
}

// --- « Ce qu'il peut faire » -------------------------------------------------------------

/** Entrées d'exemple évaluées pour la carte d'identité (§9.4). */
export const RIGHT_SAMPLES = Object.freeze({
  read: "exemple.ps1",
  edit: "scripts/exemple.ps1",
  bash: "Get-ChildItem",
  webfetch: "https://exemple.com",
  websearch: "exemple",
  task: "general",
  externalDirectory: "/tmp/x",
  keyFile: "certificat.pfx",
  env: ".env",
});

export type RightLineKind = "oui" | "non" | "demande" | "info";

export interface RightLine {
  id: string;
  kind: RightLineKind;
  text: string;
  /** Afficher en rouge. */
  danger: boolean;
  permission: string | null;
  action: Action | null;
}

export const RIGHT_LINE_SYMBOLS: Readonly<Record<RightLineKind, string>> = Object.freeze({ oui: "✓", non: "✗", demande: "?", info: "·" });

const KIND_OF: Record<Action, RightLineKind> = { allow: "oui", ask: "demande", deny: "non" };
const RANK: Record<Action, number> = { deny: 0, ask: 1, allow: 2 };

interface LineSpec {
  id: string;
  permission: string;
  action: Action;
  texts: Record<Action, string | null>;
  dangerOnAllow: boolean;
}

/**
 * Lignes ✓ / ✗ / ? calculées avec evaluate() sur des entrées d'exemple fixes. Toute autorisation sans demande sur
 * les fichiers, les commandes, la délégation, les dossiers extérieurs, Internet, les fichiers de clés ou .env est
 * signalée en rouge. `fiches` : fiches listées sur la carte (une ligne seulement si l'une n'est pas autorisée).
 */
export function rightLines(rules: readonly Rule[], fiches: readonly string[] = [], steps?: number | null): RightLine[] {
  const web = [evaluate(rules, "webfetch", RIGHT_SAMPLES.webfetch), evaluate(rules, "websearch", RIGHT_SAMPLES.websearch)].sort(
    (a, b) => RANK[b] - RANK[a],
  )[0] as Action;
  const specs: LineSpec[] = [
    {
      id: "lecture",
      permission: "read",
      action: evaluate(rules, "read", RIGHT_SAMPLES.read),
      texts: {
        allow: "Lit les fichiers du dossier de travail",
        ask: "Demande avant de lire un fichier du dossier de travail",
        deny: "Ne lit aucun fichier du dossier de travail",
      },
      dangerOnAllow: false,
    },
    {
      id: "modification",
      permission: "edit",
      action: evaluate(rules, "edit", RIGHT_SAMPLES.edit),
      texts: { allow: "Modifie des fichiers sans demander", ask: "Demande avant de modifier un fichier", deny: "Ne modifie aucun fichier" },
      dangerOnAllow: true,
    },
    {
      id: "commande",
      permission: "bash",
      action: evaluate(rules, "bash", RIGHT_SAMPLES.bash),
      texts: { allow: "Lance des commandes sans demander", ask: "Demande avant de lancer une commande", deny: "Ne lance aucune commande" },
      dangerOnAllow: true,
    },
    {
      id: "internet",
      permission: "webfetch",
      action: web,
      texts: { allow: "Consulte Internet sans demander", ask: "Demande avant de consulter Internet", deny: "N'accède pas à Internet" },
      dangerOnAllow: true,
    },
    {
      id: "delegation",
      permission: "task",
      action: evaluate(rules, "task", RIGHT_SAMPLES.task),
      texts: {
        allow: "Délègue le travail à un autre assistant sans demander",
        ask: "Demande avant de déléguer le travail à un autre assistant",
        deny: "Ne délègue pas le travail à un autre assistant",
      },
      dangerOnAllow: true,
    },
    {
      id: "hors-dossier",
      permission: "external_directory",
      action: evaluate(rules, "external_directory", RIGHT_SAMPLES.externalDirectory),
      // « ask » est le défaut d'opencode : pas de ligne.
      texts: {
        allow: "Ouvre des fichiers hors du dossier de travail sans demander",
        ask: null,
        deny: "N'ouvre aucun fichier hors du dossier de travail",
      },
      dangerOnAllow: true,
    },
    {
      id: "fichiers-cles",
      permission: "read",
      action: evaluate(rules, "read", RIGHT_SAMPLES.keyFile),
      texts: {
        allow: "Peut ouvrir les fichiers de clés (.pfx, .key, .jks…)",
        ask: "Demande avant d'ouvrir un fichier de clés (.pfx, .key, .jks…)",
        deny: "N'ouvre jamais les fichiers de clés (.pfx, .key, .jks…)",
      },
      dangerOnAllow: true,
    },
    {
      id: "env",
      permission: "read",
      action: evaluate(rules, "read", RIGHT_SAMPLES.env),
      texts: { allow: "Lit les fichiers .env sans demander", ask: "Demande avant de lire un fichier .env", deny: "N'ouvre jamais les fichiers .env" },
      dangerOnAllow: true,
    },
  ];
  const lines: RightLine[] = [];
  for (const spec of specs) {
    const text = spec.texts[spec.action];
    if (text === null) continue;
    lines.push({ id: spec.id, kind: KIND_OF[spec.action], text, danger: spec.action === "allow" && spec.dangerOnAllow, permission: spec.permission, action: spec.action });
  }
  for (const fiche of fiches) {
    const action = evaluate(rules, "skill", fiche);
    if (action === "allow") continue;
    lines.push({
      id: `fiche:${fiche}`,
      kind: KIND_OF[action],
      text: action === "ask" ? `Demande avant d'ouvrir la fiche « ${fiche} »` : `Ne peut pas ouvrir la fiche « ${fiche} »`,
      danger: false,
      permission: "skill",
      action,
    });
  }
  if (typeof steps === "number" && steps > 0) {
    lines.push({ id: "actions", kind: "info", text: `Vous rend la main après ${steps} actions au maximum`, danger: false, permission: null, action: null });
  }
  return lines;
}

// --- Fichier d'agent d'un assistant ------------------------------------------------------

export const COMMON_RULES_VERSION = 1;
export const COMMON_RULES_START = `<!-- cockpit:regles-communes v${COMMON_RULES_VERSION} -->`;
export const COMMON_RULES_END = "<!-- /cockpit:regles-communes -->";
const COMMON_RULES_HEADER = "## Règles communes (ajoutées par le cockpit)";
const COMMON_RULES_LINES = [
  "- Si ce qu'on te donne contient une donnée client, un mot de passe, une clé ou un jeton, signale-le en premier et ne le recopie pas.",
  "- N'invente ni commande, ni option, ni nom de serveur. Écris « À VÉRIFIER » quand tu n'es pas sûr.",
  "- Tu ne remplaces ni la relecture par un collègue ni le CAB : ne donne jamais de « feu vert ».",
];
export const COMMON_RULES_BLOCK = [COMMON_RULES_START, COMMON_RULES_HEADER, ...COMMON_RULES_LINES, COMMON_RULES_END].join("\n");
export const COMMON_RULES_NOTE = "Les règles communes (données sensibles, « À VÉRIFIER », pas de feu vert) sont ajoutées automatiquement.";

const COMMON_BLOCK_RE = /<!-- cockpit:regles-communes v\d+ -->[\s\S]*?<!-- \/cockpit:regles-communes -->/g;
const COMMON_OWNED_LINES = new Set([COMMON_RULES_END, COMMON_RULES_HEADER, ...COMMON_RULES_LINES]);

/** Consignes sans le bloc de règles communes (toutes versions), marqueurs orphelins compris. */
export function stripCommonRules(body: string): string {
  return body
    .replace(/\r\n/g, "\n")
    .replace(COMMON_BLOCK_RE, "")
    .split("\n")
    .filter((line) => !COMMON_OWNED_LINES.has(line.trim()) && !/^<!-- cockpit:regles-communes v\d+ -->$/.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Phrase ajoutée aux consignes pour chaque fiche cochée. */
export function ficheSentence(fiche: string): string {
  return `Consulte la fiche « ${fiche} » avant de répondre.`;
}

/** Corps du fichier : consignes, phrases des fiches manquantes, puis un seul bloc de règles communes. */
export function assistantBody(instructions: string, fiches: readonly string[]): string {
  let text = stripCommonRules(instructions);
  const missing = checkFiches(fiches).map(ficheSentence).filter((sentence) => !text.includes(sentence));
  if (missing.length > 0) text = text ? `${text}\n\n${missing.join("\n")}` : missing.join("\n");
  return `${text}\n\n${COMMON_RULES_BLOCK}\n`;
}

/** Portage de fsutil.slugify (minuscules, sans accents, tirets), avec « assistant » comme repli. */
export function slugifyName(input: string, max = ASSISTANT_NAME_MAX): string {
  return (
    input
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/g, "") || "assistant"
  );
}

/** `base`, sinon `base-2`, `base-3`… (64 caractères au plus). */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, 64 - suffix.length).replace(/-+$/g, "")}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

export interface AssistantFile {
  name: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Fichier d'agent (portée globale) d'un assistant (§7.1-7.2). Uniquement des clés connues d'opencode, dans cet ordre :
 * description, mode, model, variant?, steps, color, permission. `ctx.model`/`ctx.variant` sont l'IA déjà résolue
 * par le serveur (niveau ou IA précise vérifiée). `existingNames` sert au suffixe -2, -3 quand `d.name` est absent.
 */
export function buildAssistantFile(d: AssistantDraft, ctx: { model: string; variant: string | null; existingNames?: Iterable<string> }): AssistantFile {
  if (d.name !== undefined && (!NAME_RE.test(d.name) || d.name.length > 64)) throw new RangeError("Nom d'assistant invalide.");
  const fiches = checkFiches(d.fiches);
  const name = d.name ?? uniqueName(slugifyName(d.title), ctx.existingNames ?? []);
  const frontmatter: Record<string, unknown> = {
    description: d.description.trim(),
    mode: "primary",
    model: ctx.model,
    ...(ctx.variant ? { variant: ctx.variant } : {}),
    steps: TASK_STEPS[d.taskSize],
    color: USE_CASE_INFO[d.useCase].color,
    permission: assistantPermission(d.rights, d.web, fiches),
  };
  return { name, frontmatter, body: assistantBody(d.instructions, fiches) };
}

/**
 * Réflexion à écrire pour un brouillon : « poussee » = `high` si l'IA la propose ; « standard » = réflexion du niveau
 * si l'IA la propose, sinon aucune. `offered` null = catalogue non chargé (non vérifié).
 */
export function draftVariant(reflection: Reflection, tierVariant: string | null, offered: readonly string[] | null): string | null {
  const ok = (v: string) => offered === null || offered.includes(v);
  if (reflection === "poussee") return ok("high") ? "high" : null;
  return tierVariant && ok(tierVariant) ? tierVariant : null;
}

/** Clés d'agent connues d'opencode (core/v1/config/agent.ts:44-61) ; les autres partent chez le fournisseur (62-66). */
export const OPENCODE_AGENT_KEYS: ReadonlySet<string> = new Set([
  "name",
  "model",
  "variant",
  "prompt",
  "description",
  "temperature",
  "top_p",
  "mode",
  "hidden",
  "color",
  "steps",
  "maxSteps",
  "options",
  "permission",
  "disable",
  "tools",
]);

/** Clés inconnues d'opencode, hors celles déjà présentes dans le fichier sur disque (tolérées). */
export function unknownAgentKeys(frontmatter: Record<string, unknown>, previous?: Record<string, unknown> | null): string[] {
  return Object.keys(frontmatter).filter((key) => !OPENCODE_AGENT_KEYS.has(key) && !(previous && Object.hasOwn(previous, key)));
}

export function unknownAgentKeyMessage(key: string): string {
  return `Réglage inconnu « ${key} » : opencode l'enverrait tel quel à l'IA. Retirez-le.`;
}

// --- Modes, règles d'or et paramètres ----------------------------------------------------

/** Version des règles d'utilisation : l'augmenter réaffiche la fenêtre bloquante. */
export const RULES_VERSION = 1;

export const RULES_TITLE_FIRST = "Avant de commencer";
export const RULES_TITLE_CHANGED = "Les règles d'utilisation ont changé";
export const RULES_CHECKBOX = "J'ai lu ces règles et je les appliquerai.";
export const RULES_BUTTON = "Commencer";

/** Les 6 règles d'or (plancher de conformité, jamais modifiable depuis l'interface). */
export const GOLDEN_RULES: readonly string[] = Object.freeze([
  "Tout ce que vous écrivez ou joignez (texte, fichiers, sorties de commandes) est envoyé à GitHub Copilot, un service extérieur à la banque.",
  "Jamais de données clients : nom, numéro de compte, IBAN, numéro de carte, numéro client, adresse, e-mail, téléphone, montant rattaché à un client. Remplacez-les par des repères : CLIENT_1, IBAN_1, SERVEUR_A.",
  "Jamais de secrets : mots de passe, clés privées, jetons, chaînes de connexion, fichiers .pfx, .p12, .key, .jks, .env, kubeconfig, sorties de terraform plan non nettoyées.",
  "L'IA n'agit jamais sur la production. Elle propose ; vous vérifiez ; vous exécutez, selon la procédure habituelle.",
  "L'IA ne remplace ni la relecture par un collègue (principe des quatre yeux), ni le CAB.",
  "L'IA peut se tromper avec assurance : commandes ou options inventées, dates mal calculées, versions dépassées, failles récentes inconnues. Testez toujours hors production.",
]);

export const UI_MODES = ["simple", "avance"] as const;
export type UiMode = (typeof UI_MODES)[number];

/** Chemins de paramètres modifiables en mode Simple (§8) ; « x.* » = toute la section. */
export const SIMPLE_SETTINGS_PATHS: readonly string[] = Object.freeze([
  "budget.monthlyUsd",
  "budget.alertThresholds",
  "ui.*",
  "ai.chatDefaultTier",
  "chat.defaultDirectory",
]);

export function isSimpleSettingsPath(path: string): boolean {
  return SIMPLE_SETTINGS_PATHS.some((allowed) => {
    if (allowed.endsWith(".*")) {
      const section = allowed.slice(0, -2);
      return path === section || path.startsWith(`${section}.`);
    }
    return path === allowed || path.startsWith(`${allowed}.`);
  });
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

/** Réglages remplacés en bloc par la fusion des paramètres (settings.ts mergeSettings) : jamais fusionnés clé par clé. */
export const SETTINGS_REPLACED_PATHS: ReadonlySet<string> = new Set(["pricing.overrides", "classifier.categories", "budget.alertThresholds", "ai.tiers"]);

/**
 * Chemins « a.b.c » réellement modifiés par un correctif (objets parcourus ; tableaux et valeurs simples = feuilles).
 * Un réglage remplacé en bloc est une feuille : l'envoyer partiel ou vide efface les clés absentes.
 */
export function changedSettingsPaths(current: unknown, patch: unknown, at = ""): string[] {
  if (patch === undefined) return [];
  if (at && SETTINGS_REPLACED_PATHS.has(at)) return deepEqual(current, patch) ? [] : [at];
  if (isPlainObject(patch)) {
    const base = isPlainObject(current) ? current : {};
    return Object.entries(patch).flatMap(([key, value]) =>
      changedSettingsPaths(Object.hasOwn(base, key) ? base[key] : undefined, value, at ? `${at}.${key}` : key),
    );
  }
  return deepEqual(current, patch) ? [] : [at || "(racine)"];
}

/** Chemins modifiés hors de la liste du mode Simple : non vide = 403 mode-avance en mode Simple. */
export function settingsPathsOutsideSimple(current: unknown, patch: unknown): string[] {
  return changedSettingsPaths(current, patch).filter((path) => !isSimpleSettingsPath(path));
}

// --- Catalogue et profils de droits globaux ----------------------------------------------

/** Catalogue réduit depuis des modèles d'API (ModelInfo côté interface, CatalogModel côté serveur). */
export function toCatalogLite(
  models: ReadonlyArray<{
    key: string;
    providerID: string;
    name?: string;
    variants: readonly string[];
    toolcall?: boolean;
    status?: string;
    contextLimit: number | null;
  }>,
): CatalogLite[] {
  return models.map((m) => ({
    key: m.key,
    providerID: m.providerID,
    ...(m.name !== undefined ? { name: m.name } : {}),
    variants: [...m.variants],
    toolcall: m.toolcall !== false,
    status: m.status ?? "active",
    contextLimit: m.contextLimit,
  }));
}

export const PERMISSION_PRESET_IDS = ["prudent", "equilibre", "autonome"] as const;
export type PermissionPresetId = (typeof PERMISSION_PRESET_IDS)[number];

/** Permission globale de chaque profil. « prudent » = docker/opencode/opencode.default.jsonc (configuration livrée). */
export const PERMISSION_PRESETS: Readonly<Record<PermissionPresetId, { label: string; permission: Readonly<Record<string, unknown>> }>> = Object.freeze({
  prudent: { label: "Prudent", permission: { edit: "ask", bash: { "*": "ask", pwd: "allow" }, task: "ask", webfetch: "ask", websearch: "ask" } },
  equilibre: { label: "Équilibré", permission: { edit: "allow", bash: "ask", task: "ask", webfetch: "ask", websearch: "ask" } },
  autonome: { label: "Autonome", permission: { edit: "allow", bash: "allow", task: "allow", webfetch: "allow", websearch: "allow" } },
});

/** Copie modifiable de la permission d'un profil (à écrire dans la configuration globale). */
export function presetPermission(id: PermissionPresetId): Record<string, unknown> {
  return structuredClone(PERMISSION_PRESETS[id].permission) as Record<string, unknown>;
}

/** Profil identique (ordre des clés ignoré) à une permission globale, sinon null (« Personnalisé »). */
export function detectPermissionPreset(permission: unknown): PermissionPresetId | null {
  return PERMISSION_PRESET_IDS.find((id) => deepEqual(PERMISSION_PRESETS[id].permission, permission)) ?? null;
}

export const SECURITY_TEXTS = Object.freeze({
  prudent:
    "Profil de droits : Prudent. L'assistant demande avant de modifier un fichier, lancer une commande, consulter le web ou déléguer.",
  provider: "Fournisseur d'IA : GitHub Copilot uniquement.",
  restorePrudent: "Revenir au profil Prudent",
});

/** « Profil de droits : {profil}. Il a été modifié en mode Avancé. » */
export function modifiedProfileText(presetLabel: string): string {
  return `Profil de droits : ${presetLabel}. Il a été modifié en mode Avancé.`;
}

// --- Affichage d'un tour (puces du compositeur) ------------------------------------------

export interface TurnDisplayContext {
  catalog: readonly CatalogLite[];
  /** Titre affiché d'un agent (« Assistant général », titre d'un assistant, sinon son nom). */
  agentTitle: (name: string) => string;
  /** Niveau dont l'IA résolue est ce modèle, sinon null. */
  tierOfModel: (model: string) => Tier | null;
  /** Prix effectif (surcharges > grille > catalogue), null si inconnu. */
  priceOf: (model: string) => ModelPrice | null;
  /** Taille de demande utilisée pour l'estimation (celle de l'assistant, sinon M). */
  size: TaskSize;
  /** Nom du raccourci (sans « / ») ou null. */
  command: string | null;
  /** Niveau de la conversation et sa résolution, pour la mention « IA de secours ». */
  chatTier: { id: Tier; status: TierStatus; plannedModel: string | null } | null;
}

export interface RunView extends Run {
  modelName: string;
  roleLabel: string;
  tier: Tier | null;
  variantLabel: string;
  /** Estimation de cet appel (profil) ; null sans prix. */
  usd: number | null;
}

export interface TurnDisplay {
  /** « IA : Claude Sonnet 5 · Équilibré (fixée par l'assistant) », ou la ligne du travail délégué. */
  chip: string;
  chipTooltip: string | null;
  locked: boolean;
  delegated: boolean;
  fallbackBadge: string | null;
  fallbackText: string | null;
  delegatedHelp: string | null;
  estimate: { min: number; max: number } | null;
  /** « ≈ 0,18 $ par demande » ou « ≈ 0,18–0,40 $ ». */
  estimateText: string | null;
  runs: RunView[];
  problems: Array<Problem & { message: string }>;
}

const ROLE_LABELS: Record<RunRole, string> = {
  message: "Message",
  raccourci: "Raccourci",
  delegue: "Travail délégué",
  reprise: "Reprise dans la conversation (l'IA résume et peut poursuivre)",
};

/** Textes français d'un tour résolu (utilisés par POST /api/chat/resolve). */
export function describeTurn(turn: Turn, ctx: TurnDisplayContext): TurnDisplay {
  const name = (model: string) => modelName(model, ctx.catalog);
  const costOf = (model: string, size: TaskSize) => {
    const price = ctx.priceOf(model);
    return price ? estimateTaskCost(price, size) : null;
  };
  const runs: RunView[] = turn.runs.map((run) => ({
    ...run,
    modelName: name(run.model),
    roleLabel:
      run.role === "raccourci" && ctx.command
        ? `Raccourci /${ctx.command}`
        : run.role === "delegue" && run.agent
          ? `Travail délégué à « ${ctx.agentTitle(run.agent)} »`
          : ROLE_LABELS[run.role],
    tier: ctx.tierOfModel(run.model),
    variantLabel: variantLabel(run.variant),
    usd: costOf(run.model, ctx.size),
  }));
  const problems = turn.problems.map((p) => ({ ...p, message: problemMessage(p, { agentTitle: ctx.agentTitle, modelName: name }) }));
  const delegue = runs.find((r) => r.role === "delegue");
  const reprise = runs.find((r) => r.role === "reprise");
  const main = runs.find((r) => r.role === "message" || r.role === "raccourci");

  let estimate: { min: number; max: number } | null = null;
  if (delegue && reprise) {
    const low = costOf(reprise.model, "S");
    if (delegue.usd !== null && reprise.usd !== null && low !== null) {
      estimate = { min: roundUsd(delegue.usd + Math.min(low, reprise.usd)), max: roundUsd(delegue.usd + reprise.usd) };
    }
  } else if (main && main.usd !== null) {
    estimate = { min: main.usd, max: main.usd };
  }

  if (delegue && reprise) {
    const who = delegue.agent ? ctx.agentTitle(delegue.agent) : "";
    const cost = estimate ? ` · ${rangeText(estimate.min, estimate.max)}` : "";
    return {
      chip: `Travail délégué à « ${who} » (IA ${delegue.modelName}) + reprise dans la conversation (IA ${reprise.modelName})${cost}`,
      chipTooltip: null,
      locked: turn.lock !== null,
      delegated: true,
      fallbackBadge: null,
      fallbackText: null,
      delegatedHelp: MESSAGES.delegatedHelp,
      estimate,
      estimateText: estimate ? rangeText(estimate.min, estimate.max) : null,
      runs,
      problems,
    };
  }

  let chip = "";
  let fallbackBadge: string | null = null;
  let fallback: string | null = null;
  if (main) {
    const level = main.tier ? ` · ${TIER_LABELS[main.tier]}` : "";
    const why =
      turn.lock?.kind === "assistant"
        ? " (fixée par l'assistant)"
        : turn.lock?.kind === "raccourci" && ctx.command
          ? ` (imposée par le raccourci /${ctx.command})`
          : main.source === "choix-avance"
            ? " (choix avancé)"
            : "";
    chip = `IA : ${main.modelName}${level}${why}`;
    if (main.source === "niveau" && ctx.chatTier?.status === "secours" && ctx.chatTier.plannedModel) {
      fallbackBadge = TIER_STATUS_LABELS.secours;
      fallback = fallbackText(name(ctx.chatTier.plannedModel), main.modelName);
    }
  }
  return {
    chip,
    chipTooltip: turn.lock?.kind === "assistant" ? MESSAGES.lockTooltip : null,
    locked: turn.lock !== null,
    delegated: false,
    fallbackBadge,
    fallbackText: fallback,
    delegatedHelp: null,
    estimate,
    estimateText: estimate ? perRequestText(estimate.max) : null,
    runs,
    problems,
  };
}
