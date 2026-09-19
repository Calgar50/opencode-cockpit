// Carte des assistants (1.1, itération 4, L39a ; spécification §3.7 l.298, §5.2 l.887-892, §5.4 l.911, §6 l.1048, F-a l.157, F-i
// l.165 ; conception C §7.4, §9.9) : module PUR (ni « node: » ni process), calculé côté serveur par GET /api/agent-map (L39b) et
// relu par l'interface. La carte montre ce que les règles permettent, jamais ce qui s'est passé.
//
// - Délégation (`delegue`) : même filtre que le registre d'opencode 1.18.30 (tool/registry.ts:265-278, conception C R2-R3) : la
//   cible n'est pas primaire et evaluate(règles de l'appelant, "task", cible) ne rend pas « deny » (dernière règle correspondante,
//   F-a) ; `hidden` est GARDÉ (opencode ne le filtre pas). « allow » → sans confirmation, « ask » → demandée. En mode Simple, le
//   cockpit refuse une délégation demandée (décision n° 4) : l'arête porte alors refuseEnSimple et appliquePar « cockpit ».
// - Profondeur (F-i, C R5-R6) : un sous-agent (mode « subagent ») ne tourne que délégué ; il ne délègue à son tour que si
//   subagent_depth > 1 et que ses règles nomment `task` (sinon opencode ajoute `task: deny` à sa session). Note « profondeur-un »
//   quand aucune cible ne peut déléguer plus loin ; sinon « profondeur-plus », en Avancé seulement (§5.2 l.891 : aucune mention de
//   profondeur en Simple).
// - Agents internes exclus partout : liste du Studio (INTERNAL_AGENTS, passée en entrée : studio.ts n'est pas importé ici), agents
//   internes d'opencode (compaction, title, summary) et préfixe cockpit- (isInternalAgentName, §3.14).
// - CODES SEULEMENT : aucune phrase n'est écrite ici. Les phrases sont dans agent-map-texts.ts (T4t), dont les clés recopient les
//   listes fermées ci-dessous (croisement de V0 ; ces listes font foi). Les lignes de droits sont celles de rightLines (assistant-rules).
import { isInternalAgentName } from "./agent-choice.ts";
import { evaluate, isSubtask, type RightLine, rightLines, type Rule, type Tier, type UiMode, wildcardMatch } from "./assistant-rules.ts";

// --- Genres et listes fermées de codes -------------------------------------------------------------------------------------------

export const MAP_NODE_KINDS = ["vous", "assistant", "integre", "agent-studio", "sous-agent", "raccourci", "fiche", "equipe"] as const;
export type MapNodeKind = (typeof MAP_NODE_KINDS)[number];

export const MAP_EDGE_KINDS = ["delegue", "lance", "consulte", "etape", "utilise"] as const;
export type MapEdgeKind = (typeof MAP_EDGE_KINDS)[number];

/** Phrase de chaque arête (agent-map-texts.ts). Un raccourci qui n'est pas une sous-tâche fait répondre son assistant : `utilise`. */
export const MAP_EDGE_CODES = [
  "delegue-sans-confirmation",
  "delegue-apres-accord",
  "delegue-refuse-en-simple",
  "raccourci-sans-confirmation",
  "consulte-fiche",
  "etape-imposee",
  "utilise",
] as const;
export type MapEdgeCode = (typeof MAP_EDGE_CODES)[number];

/** Notes sous la carte, dans cet ordre ; `profondeur-plus` en Avancé seulement. */
export const MAP_NOTE_CODES = ["profondeur-un", "profondeur-plus", "ia-du-delegant", "aucun-assistant", "aucun-lien", "regles-pas-historique"] as const;
export type MapNoteCode = (typeof MAP_NOTE_CODES)[number];

/** `ia-indisponible` : IA propre absente du catalogue ; `droits-larges` : « allow » sur modification, commande ou dossier externe. */
export const MAP_WARNING_CODES = ["ia-indisponible", "droits-larges"] as const;
export type MapWarningCode = (typeof MAP_WARNING_CODES)[number];

/** Refus de la route de la carte ; `salle-coupee` est rendu par L39o avec le texte de la salle. */
export const AGENT_MAP_ERROR_CODES = ["invalid", "forbidden-directory", "mode-avance", "salle-coupee"] as const;
export type AgentMapErrorCode = (typeof AGENT_MAP_ERROR_CODES)[number];

// --- Entrée --------------------------------------------------------------------------------------------------------------------

/** IA propre d'un agent ou d'un raccourci, résolue par le serveur : nom affichable, niveau s'il y en a un, présence au catalogue. */
export interface MapIaInput {
  label: string;
  niveau: Tier | null;
  disponible: boolean;
}

/** Agent de GET /agent (dossier de la conversation), avec ce que le cockpit en sait. */
export interface MapAgentInput {
  name: string;
  mode: "primary" | "subagent" | "all";
  hidden?: boolean | undefined;
  /** Règles effectives (GET /agent : défauts, configuration globale, agent), dans l'ordre d'opencode. */
  rules: readonly Rule[];
  /** Assistant du cockpit (catalogue ou créé), assistant intégré d'opencode, ou agent du Studio. */
  origine: "assistant" | "integre" | "studio";
  /** Titre affiché (assistant du cockpit, assistant intégré) ; absent : le nom. */
  titre?: string | null | undefined;
  /** IA propre ; absente : celle de la conversation (agent du chat) ou de l'assistant qui délègue (sous-agent). */
  ia?: MapIaInput | null | undefined;
  /** Nombre maximum d'actions (`steps`), repris dans les droits. */
  steps?: number | null | undefined;
}

/** Commande de GET /command ; seules les commandes (`source` absente ou « command ») sont des raccourcis. */
export interface MapCommandInput {
  name: string;
  agent?: string | undefined;
  subtask?: boolean | undefined;
  source?: "command" | "mcp" | "skill" | undefined;
  titre?: string | null | undefined;
  /** IA facturée résolue par le serveur ; absente : celle de la conversation. */
  ia?: MapIaInput | null | undefined;
}

export interface MapTeamInput {
  id: string;
  titre: string;
  etapes: ReadonlyArray<{ assistant: string; niveau: Tier | null }>;
}

export interface AgentMapInput {
  agents: readonly MapAgentInput[];
  commands: readonly MapCommandInput[];
  /** Noms des fiches (même source que le Studio). */
  fiches: readonly string[];
  /** Équipes installées. */
  equipes: readonly MapTeamInput[];
  /** subagent_depth effectif (absent de la configuration = 1). */
  subagentDepth: number;
  mode: UiMode;
  /** INTERNAL_AGENTS du Studio (studio.ts), passés par le service. */
  internes: readonly string[];
}

// --- Résultat ------------------------------------------------------------------------------------------------------------------

export type MapIaHeritee = "conversation" | "delegant";

export interface MapNode {
  /** `vous`, `agent:<nom>`, `raccourci:<nom>`, `fiche:<nom>`, `equipe:<id>` (mapNodeId). */
  id: string;
  kind: MapNodeKind;
  name: string;
  /** Titre fourni par le serveur ; null : le nom, ou le libellé du genre (« Vous »), écrit par l'interface. */
  title: string | null;
  /** `heritee` non nul : `label` et `niveau` sont nuls, la phrase vient des textes (ia-du-delegant pour « delegant »). */
  ia: { label: string | null; niveau: Tier | null; heritee: MapIaHeritee | null };
  droits: RightLine[];
  cacheDansLeChat: boolean;
  avertissements: MapWarningCode[];
}

export interface MapEdge {
  from: string;
  to: string;
  kind: MapEdgeKind;
  confirmation: "demandee" | "sans" | "aucune";
  appliquePar: "opencode" | "cockpit";
  refuseEnSimple: boolean;
  code: MapEdgeCode;
  /** Arête `etape` seulement : rang de l'étape (à partir de 1) et niveau d'IA choisi par l'équipe (null : IA de l'assistant). */
  etape?: { numero: number; niveau: Tier | null };
}

export interface AgentMapResult {
  nodes: MapNode[];
  edges: MapEdge[];
  notes: MapNoteCode[];
}

export const MAP_VOUS_ID = "vous";

/** Identifiant d'un nœud (paramètre `element` de la route et des vues). Les agents partagent un seul espace de noms. */
export function mapNodeId(famille: "agent" | "raccourci" | "fiche" | "equipe", name: string): string {
  return `${famille}:${name}`;
}

// --- Dérivation ----------------------------------------------------------------------------------------------------------------

const KIND_ORDER: Readonly<Record<MapNodeKind, number>> = {
  vous: 0,
  raccourci: 1,
  equipe: 2,
  integre: 3,
  assistant: 4,
  "agent-studio": 5,
  "sous-agent": 6,
  fiche: 7,
};
const EDGE_ORDER: Readonly<Record<MapEdgeKind, number>> = { utilise: 0, lance: 1, etape: 2, delegue: 3, consulte: 4 };
/** Lignes de rightLines qui valent `droits-larges` quand elles sont autorisées sans demande. */
const LARGE_RIGHT_IDS: ReadonlySet<string> = new Set(["modification", "commande", "hors-dossier"]);

function kindOf(agent: MapAgentInput): MapNodeKind {
  if (agent.origine === "integre") return "integre";
  if (agent.mode === "subagent") return "sous-agent";
  return agent.origine === "assistant" ? "assistant" : "agent-studio";
}

/** Règle qui nomme `task` (motif exact ou joker autre que « * ») : sans elle, opencode refuse `task` à la session déléguée (C R6). */
export function hasTaskRule(rules: readonly Rule[]): boolean {
  return rules.some((rule) => rule.permission !== "*" && wildcardMatch("task", rule.permission));
}

function iaOf(own: MapIaInput | null | undefined, inherited: MapIaHeritee): MapNode["ia"] {
  return own ? { label: own.label, niveau: own.niveau, heritee: null } : { label: null, niveau: null, heritee: inherited };
}

function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (k === "" || seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

const bare = (): MapNode["ia"] => ({ label: null, niveau: null, heritee: null });

/**
 * Carte des assistants : nœuds (Vous, agents non internes, raccourcis, fiches, équipes), arêtes et notes, dans un ordre stable
 * (genre, puis nom ; arêtes par origine, genre, cible). Lève RangeError si subagentDepth n'est pas un entier positif ou nul.
 */
export function deriveAgentMap(input: AgentMapInput): AgentMapResult {
  const depth = input.subagentDepth;
  if (!Number.isInteger(depth) || depth < 0) throw new RangeError("invalid:subagent-depth");
  const internes = new Set(input.internes);
  const interne = (name: string) => internes.has(name) || isInternalAgentName(name);

  const agents = uniqueBy(input.agents, (a) => a.name).filter((a) => !interne(a.name));
  const commands = uniqueBy(input.commands, (c) => c.name).filter((c) => c.source === undefined || c.source === "command");
  const fiches = uniqueBy(input.fiches, (f) => f);
  const equipes = uniqueBy(input.equipes, (e) => e.id);
  const agentByName = new Map(agents.map((a) => [a.name, a]));

  const nodes: MapNode[] = [
    { id: MAP_VOUS_ID, kind: "vous", name: MAP_VOUS_ID, title: null, ia: bare(), droits: [], cacheDansLeChat: false, avertissements: [] },
  ];
  for (const agent of agents) {
    const droits = rightLines(agent.rules, [], agent.steps ?? null);
    const avertissements: MapWarningCode[] = [];
    if (agent.ia && !agent.ia.disponible) avertissements.push("ia-indisponible");
    if (droits.some((line) => line.action === "allow" && LARGE_RIGHT_IDS.has(line.id))) avertissements.push("droits-larges");
    nodes.push({
      id: mapNodeId("agent", agent.name),
      kind: kindOf(agent),
      name: agent.name,
      title: agent.titre ?? null,
      // Sans IA propre : un sous-agent prend celle de l'assistant qui délègue (C R7), un agent du chat celle de la conversation.
      ia: iaOf(agent.ia, agent.mode === "subagent" ? "delegant" : "conversation"),
      droits,
      cacheDansLeChat: agent.hidden === true,
      avertissements,
    });
  }
  for (const command of commands) {
    nodes.push({
      id: mapNodeId("raccourci", command.name),
      kind: "raccourci",
      name: command.name,
      title: command.titre ?? null,
      ia: iaOf(command.ia, "conversation"),
      droits: [],
      cacheDansLeChat: false,
      avertissements: command.ia && !command.ia.disponible ? ["ia-indisponible"] : [],
    });
  }
  for (const fiche of fiches) {
    nodes.push({ id: mapNodeId("fiche", fiche), kind: "fiche", name: fiche, title: null, ia: bare(), droits: [], cacheDansLeChat: false, avertissements: [] });
  }
  for (const equipe of equipes) {
    const id = mapNodeId("equipe", equipe.id);
    nodes.push({ id, kind: "equipe", name: equipe.id, title: equipe.titre, ia: bare(), droits: [], cacheDansLeChat: false, avertissements: [] });
  }
  nodes.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || compare(a.name, b.name));

  const edges: MapEdge[] = [];
  const opencode = (from: string, to: string, kind: MapEdgeKind, confirmation: MapEdge["confirmation"], code: MapEdgeCode): MapEdge => ({
    from,
    to,
    kind,
    confirmation,
    appliquePar: "opencode",
    refuseEnSimple: false,
    code,
  });

  // utilise : Vous → assistants du chat (ni sous-agent, ni caché), raccourcis et équipes.
  for (const agent of agents) {
    if (agent.mode !== "subagent" && agent.hidden !== true) edges.push(opencode(MAP_VOUS_ID, mapNodeId("agent", agent.name), "utilise", "aucune", "utilise"));
  }
  for (const command of commands) edges.push(opencode(MAP_VOUS_ID, mapNodeId("raccourci", command.name), "utilise", "aucune", "utilise"));
  for (const equipe of equipes) {
    edges.push({ ...opencode(MAP_VOUS_ID, mapNodeId("equipe", equipe.id), "utilise", "aucune", "utilise"), appliquePar: "cockpit" });
  }

  // lance : raccourci → son assistant. Sous-tâche : lancé sans confirmation (le contrôle `task` est sauté, C R4), puis reprise.
  for (const command of commands) {
    const agent = command.agent === undefined ? undefined : agentByName.get(command.agent);
    if (!agent) continue;
    const from = mapNodeId("raccourci", command.name);
    const to = mapNodeId("agent", agent.name);
    edges.push(
      isSubtask(agent, command) ? opencode(from, to, "lance", "sans", "raccourci-sans-confirmation") : opencode(from, to, "lance", "aucune", "utilise"),
    );
  }

  // etape : équipe → assistant de chaque étape, imposé par le cockpit (une arête par étape).
  for (const equipe of equipes) {
    equipe.etapes.forEach((etape, index) => {
      if (!agentByName.has(etape.assistant)) return;
      edges.push({
        from: mapNodeId("equipe", equipe.id),
        to: mapNodeId("agent", etape.assistant),
        kind: "etape",
        confirmation: "aucune",
        appliquePar: "cockpit",
        refuseEnSimple: false,
        code: "etape-imposee",
        etape: { numero: index + 1, niveau: etape.niveau },
      });
    });
  }

  // delegue : registre d'opencode. Un sous-agent n'appelle `task` que s'il peut déléguer plus loin (profondeur, règle task).
  const simple = input.mode === "simple";
  const canDelegateAsChild = (agent: MapAgentInput) => depth > 1 && hasTaskRule(agent.rules);
  for (const caller of agents) {
    if (caller.mode === "subagent" && !canDelegateAsChild(caller)) continue;
    for (const target of agents) {
      if (target.mode === "primary") continue;
      const action = evaluate(caller.rules, "task", target.name);
      if (action === "deny") continue;
      const from = mapNodeId("agent", caller.name);
      const to = mapNodeId("agent", target.name);
      if (action === "allow") edges.push(opencode(from, to, "delegue", "sans", "delegue-sans-confirmation"));
      else if (simple) edges.push({ from, to, kind: "delegue", confirmation: "demandee", appliquePar: "cockpit", refuseEnSimple: true, code: "delegue-refuse-en-simple" });
      else edges.push(opencode(from, to, "delegue", "demandee", "delegue-apres-accord"));
    }
  }

  // consulte : agent → fiche, selon evaluate(règles, "skill", fiche).
  for (const agent of agents) {
    for (const fiche of fiches) {
      const action = evaluate(agent.rules, "skill", fiche);
      if (action === "deny") continue;
      edges.push(opencode(mapNodeId("agent", agent.name), mapNodeId("fiche", fiche), "consulte", action === "allow" ? "sans" : "demandee", "consulte-fiche"));
    }
  }

  const rank = new Map(nodes.map((node, index) => [node.id, index]));
  const at = (id: string) => rank.get(id) ?? Number.MAX_SAFE_INTEGER;
  edges.sort(
    (a, b) =>
      at(a.from) - at(b.from) ||
      EDGE_ORDER[a.kind] - EDGE_ORDER[b.kind] ||
      at(a.to) - at(b.to) ||
      (a.etape?.numero ?? 0) - (b.etape?.numero ?? 0),
  );

  return { nodes, edges, notes: notesOf(nodes, edges, agents, depth, input.mode) };
}

function notesOf(nodes: readonly MapNode[], edges: readonly MapEdge[], agents: readonly MapAgentInput[], depth: number, mode: UiMode): MapNoteCode[] {
  const notes: MapNoteCode[] = [];
  const delegue = edges.filter((edge) => edge.kind === "delegue");
  if (delegue.length > 0) {
    const byId = new Map(agents.map((a) => [mapNodeId("agent", a.name), a]));
    // Une cible déléguée confie du travail plus loin si la profondeur le permet, si ses règles nomment `task` et si elle a des cibles.
    const deeper = delegue.some((edge) => {
      const target = byId.get(edge.to);
      return depth > 1 && target !== undefined && hasTaskRule(target.rules) && delegue.some((next) => next.from === edge.to);
    });
    if (!deeper) notes.push("profondeur-un");
    else if (mode === "avance") notes.push("profondeur-plus");
  }
  if (nodes.some((node) => node.ia.heritee === "delegant")) notes.push("ia-du-delegant");
  if (!nodes.some((node) => node.kind === "assistant" || node.kind === "agent-studio" || node.kind === "sous-agent")) notes.push("aucun-assistant");
  if (delegue.length === 0) notes.push("aucun-lien");
  notes.push("regles-pas-historique");
  return notes;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// --- Vues ----------------------------------------------------------------------------------------------------------------------

export interface MapNeighbour {
  node: MapNode;
  edge: MapEdge;
}

/** Vue Centrée : « Qui le fait travailler » (entrants) et « Qui il fait travailler et ce qu'il consulte » (sortants). */
export interface MapNeighbours {
  element: MapNode;
  entrants: MapNeighbour[];
  sortants: MapNeighbour[];
}

/** Voisins d'un élément (identifiant de nœud), dans l'ordre des arêtes ; élément inconnu : null. */
export function neighbours(result: AgentMapResult, element: string): MapNeighbours | null {
  const byId = new Map(result.nodes.map((node) => [node.id, node]));
  const node = byId.get(element);
  if (!node) return null;
  const entrants: MapNeighbour[] = [];
  const sortants: MapNeighbour[] = [];
  for (const edge of result.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;
    if (edge.to === element) entrants.push({ node: from, edge });
    if (edge.from === element) sortants.push({ node: to, edge });
  }
  return { element: node, entrants, sortants };
}

/** Une phrase de la vue Liste : l'arête, son sens vu de la section et l'autre élément. La phrase vient du code de l'arête. */
export interface MapListEntry {
  edge: MapEdge;
  sens: "sortant" | "entrant";
  autre: MapNode;
}

export interface MapListSection {
  node: MapNode;
  entries: MapListEntry[];
}

/**
 * Vue Liste, vérité pour le lecteur d'écran : une entrée par arête, jamais deux. Sans élément : une section par nœud, dans l'ordre
 * des nœuds, qui porte les arêtes qui en partent. Avec un élément : sa seule section, avec ses arêtes sortantes et entrantes
 * (une arête vers lui-même une seule fois) ; élément inconnu : aucune section.
 */
export function mapAsList(result: AgentMapResult, element: string | null = null): MapListSection[] {
  const byId = new Map(result.nodes.map((node) => [node.id, node]));
  if (element !== null) {
    const node = byId.get(element);
    if (!node) return [];
    const entries: MapListEntry[] = [];
    for (const edge of result.edges) {
      const autre = edge.from === element ? byId.get(edge.to) : edge.to === element ? byId.get(edge.from) : undefined;
      if (autre) entries.push({ edge, sens: edge.from === element ? "sortant" : "entrant", autre });
    }
    return [{ node, entries }];
  }
  const sections = new Map<string, MapListSection>(result.nodes.map((node) => [node.id, { node, entries: [] }]));
  for (const edge of result.edges) {
    const section = sections.get(edge.from);
    const autre = byId.get(edge.to);
    if (section && autre) section.entries.push({ edge, sens: "sortant", autre });
  }
  return [...sections.values()];
}
