// Propriétaire : L39b.
// Carte des assistants (spécification §5.2 l.887-892, §5.4 l.911, §3.9 l.339 ; conception C §7.4, §9.9 ; plan d'exécution it4,
// fiche L39b et §4.1.5) : module « agentMap » (routes seulement, AUCUN port) et service qui compose l'entrée de deriveAgentMap
// (shared/agent-map.ts, L39a) avec ce que le cockpit sait déjà.
// - LECTURE SEULE : aucune écriture en base, aucune requête qui change opencode. Les agents et les raccourcis viennent du cache
//   d'OcLookup (GET /agent, GET /command), les fiches du Studio (mêmes fichiers que la page Assistants), les équipes du magasin
//   (L37s), la profondeur de GET /global/config. La carte montre ce que les règles permettent, pas ce qui s'est passé.
// - MODE SIMPLE : la carte est OUVERTE dans les deux modes (plan §2.6). En Simple, les agents du Studio sont RETIRÉS de l'entrée
//   (avec leurs arêtes), et les équipes tant qu'EQUIPES_SIMPLE_OUVERTES est fausse : la constante n'est pas lisible depuis un
//   module partagé, donc le service filtre (report MX-EQ §4.2, consommateur prévenu). Le reste des écarts de mode (refus d'une
//   délégation demandée, note de profondeur en Avancé seulement) est porté par deriveAgentMap.
// - Profondeur : `subagent_depth` absent, illisible ou hors de portée = 1 (défaut d'opencode) ; 0 est traité comme 1 (report
//   MX-EQ §4.2 : la valeur n'a pas été vérifiée dans les sources d'opencode, et 1 est la lecture prudente).
import type { DatabaseSync } from "node:sqlite";
import type { EqContext, EqModule } from "./contracts-eq.ts";
import { subagentDepth } from "./diagnostics-11.ts";
import { errorMessage } from "./log.ts";
import type { OcAgentInfo, OcCommandInfo } from "./oc-lookup.ts";
import { registerAgentMapRoutes } from "./routes-agent-map.ts";
import {
  type AgentMapInput,
  type AgentMapResult,
  deriveAgentMap,
  type MapAgentInput,
  type MapCommandInput,
  type MapIaInput,
  type MapTeamInput,
} from "./shared/agent-map.ts";
import { builtinAssistantInfo, type Tier, type UiMode } from "./shared/assistant-rules.ts";
import { planSteps } from "./shared/team-limits.ts";
import type { Flow, FlowStep } from "./shared/team-types.ts";
import { INTERNAL_AGENTS } from "./studio.ts";
import { createTeamStore } from "./team-store.ts";

/**
 * Élément demandé par la route (?element=) : identifiant de nœud de mapNodeId (L39a), jamais un nom seul. MÊME règle que
 * CARTE_ELEMENT_ID de web/lib/router.ts (T4w), recoupée par agent-map-service.test.ts : l'adresse et la route acceptent
 * exactement les mêmes valeurs.
 */
export const AGENT_MAP_ELEMENT_RE = /^(?:vous|(?:agent|raccourci|fiche):[A-Za-z0-9][A-Za-z0-9_.-]{0,63}|equipe:[a-z0-9-]{1,40})$/;

/** Bornes de lecture : au-delà, la carte serait illisible et la dérivation coûteuse. */
const LIMITS = Object.freeze({ agents: 300, commands: 300, fiches: 300, equipes: 200 });

/** Temps laissé à opencode pour rendre sa configuration globale ; au-delà, la profondeur vaut son défaut. */
const CONFIG_TIMEOUT_MS = 10_000;

/**
 * Refus de la route. `forbidden-directory` et `invalid` sont des AgentMapErrorCode (L39a) ; `opencode-injoignable` n'en est pas
 * un : agent-map-texts.ts rend alors sa phrase générale (« La carte n'a pas pu être lue. »), ce que phraseErreurCarte garantit
 * pour tout code hors de la liste fermée.
 */
export type AgentMapRefusal = { ok: false; status: 400 | 403 | 502; code: "invalid" | "forbidden-directory" | "opencode-injoignable" };

export type AgentMapOutcome = { ok: true; result: AgentMapResult } | AgentMapRefusal;

export interface AgentMapQuery {
  /** Dossier de la conversation ; null : instance par défaut. */
  directory: string | null;
  /** Élément demandé, validé ici ; les vues calculent leurs colonnes et leur liste avec neighbours et mapAsList (L39a). */
  element: string | null;
}

export interface AgentMapService {
  /** Carte du dossier demandé. N'écrit rien, nulle part. */
  build(query: AgentMapQuery): Promise<AgentMapOutcome>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Métadonnées d'assistant lues dans item_meta (table d'une autre itération, lue sans jamais l'écrire). */
interface ItemMeta {
  title: string | null;
  origin: string;
}

function metaOf(db: DatabaseSync, kind: "agents" | "commands"): Map<string, ItemMeta> {
  const rows = db.prepare("SELECT name, title, origin FROM item_meta WHERE kind = ?").all(kind) as unknown as Array<{
    name: string;
    title: string | null;
    origin: string;
  }>;
  return new Map(rows.map((row) => [row.name, { title: row.title, origin: row.origin }]));
}

/**
 * Origine d'un agent pour la carte : assistant intégré d'opencode (`native`), assistant du cockpit (catalogue, créé ou adopté :
 * item_meta porte un titre), sinon agent du Studio.
 */
function origineOf(agent: OcAgentInfo, meta: ItemMeta | undefined): MapAgentInput["origine"] {
  if (agent.native === true) return "integre";
  return meta && meta.title !== null ? "assistant" : "studio";
}

/** Étapes d'une équipe installée, dans l'ordre d'exécution (planSteps) ; déroulé illisible : aucune étape, jamais d'exception. */
export function teamStepsOf(flowJson: string): Array<{ assistant: string; niveau: Tier | null }> {
  let flow: Flow;
  try {
    const parsed: unknown = JSON.parse(flowJson);
    if (!isRecord(parsed) || !Array.isArray(parsed.blocs)) return [];
    flow = parsed as unknown as Flow;
  } catch {
    return [];
  }
  const byId = new Map<string, FlowStep>();
  for (const bloc of flow.blocs) {
    const steps = bloc.type === "etape" ? [bloc.etape] : bloc.type === "avis" ? [...bloc.avis, bloc.synthese] : [];
    for (const step of steps) if (isRecord(step) && typeof step.id === "string") byId.set(step.id, step);
  }
  let ordre: ReturnType<typeof planSteps>;
  try {
    ordre = planSteps(flow);
  } catch {
    return [];
  }
  const out: Array<{ assistant: string; niveau: Tier | null }> = [];
  for (const { stepId } of ordre) {
    const step = byId.get(stepId);
    if (step && typeof step.assistant === "string") out.push({ assistant: step.assistant, niveau: step.niveau ?? null });
  }
  return out;
}

/**
 * Profondeur de délégation effective, lue dans la configuration globale d'opencode : absente = 1 (son défaut), et 0 TRAITÉ
 * COMME 1 (report MX-EQ §4.2 : la valeur 0 n'a pas été vérifiée dans les sources d'opencode, 1 est la lecture prudente).
 * Une valeur illisible lève (subagentDepth) : l'appelant retombe alors sur 1 en journalisant la raison.
 */
export function profondeurEffective(config: unknown): number {
  const depth = subagentDepth(isRecord(config) ? config : {});
  return depth < 1 ? 1 : depth;
}

export function createAgentMapService(eq: EqContext): AgentMapService {
  const { c11 } = eq;

  /** IA propre d'un agent ou d'un raccourci ; null : aucune (l'IA est celle de la conversation, ou de l'assistant qui délègue). */
  const iaOf = (key: string | null): MapIaInput | null => {
    if (key === null) return null;
    const slash = key.indexOf("/");
    if (slash <= 0) return null;
    const providerID = key.slice(0, slash);
    const modelID = key.slice(slash + 1);
    const known = c11.catalog.get(providerID, modelID);
    return {
      label: known?.name ?? modelID,
      niveau: c11.tiers.tierOfModel(key),
      // Catalogue jamais lu : rien n'est vérifiable, donc rien n'est signalé (jamais d'avertissement inventé).
      disponible: c11.catalog.loaded ? known !== undefined : true,
    };
  };

  const agentInput = (agent: OcAgentInfo, meta: Map<string, ItemMeta>): MapAgentInput => {
    const origine = origineOf(agent, meta.get(agent.name));
    const titre =
      origine === "integre" && (agent.name === "build" || agent.name === "plan")
        ? builtinAssistantInfo(agent.name, agent.permission).title
        : (meta.get(agent.name)?.title ?? null);
    return {
      name: agent.name,
      mode: agent.mode,
      hidden: agent.hidden,
      rules: agent.permission,
      origine,
      titre,
      ia: iaOf(agent.model ? `${agent.model.providerID}/${agent.model.modelID}` : null),
      steps: agent.steps ?? null,
    };
  };

  const commandInput = (command: OcCommandInfo, meta: Map<string, ItemMeta>): MapCommandInput => ({
    name: command.name,
    agent: command.agent,
    subtask: command.subtask,
    source: command.source,
    titre: meta.get(command.name)?.title ?? null,
    ia: iaOf(command.model ?? null),
  });

  /** Noms des fiches, même source que le Studio (fichiers de configuration) ; illisibles : aucune fiche, la raison est journalisée. */
  const fichesOf = async (): Promise<string[]> => {
    try {
      const items = await c11.studio.list("skills", { type: "global" });
      return items.map((item) => item.name).slice(0, LIMITS.fiches);
    } catch (err) {
      c11.log.warn("carte des assistants : fiches illisibles", { error: errorMessage(err) });
      return [];
    }
  };

  /** Équipes installées (magasin de L37s) ; lecture seule, jamais d'écriture. */
  const equipesOf = (): MapTeamInput[] =>
    createTeamStore({ db: c11.db })
      .teams.list()
      .slice(0, LIMITS.equipes)
      .map((row) => ({ id: row.id, titre: row.titre, etapes: teamStepsOf(row.flow) }));

  /** subagent_depth effectif ; absent, illisible ou opencode muet : 1 (défaut d'opencode). 0 est traité comme 1. */
  const depthOf = async (): Promise<number> => {
    try {
      const config = await c11.client.request<unknown>("GET", "/global/config", { timeoutMs: CONFIG_TIMEOUT_MS });
      return profondeurEffective(config);
    } catch (err) {
      c11.log.warn("carte des assistants : profondeur de délégation illisible (1 par défaut)", { error: errorMessage(err) });
      return 1;
    }
  };

  return {
    async build({ directory, element }) {
      if (directory !== null && !c11.projects.isAllowedDirectory(directory)) return { ok: false, status: 403, code: "forbidden-directory" };
      if (element !== null && !AGENT_MAP_ELEMENT_RE.test(element)) return { ok: false, status: 400, code: "invalid" };

      const mode: UiMode = c11.settings.get().ui.mode;
      const simple = mode === "simple";
      let snapshot;
      try {
        snapshot = await c11.lookup.get(directory);
      } catch (err) {
        c11.log.warn("carte des assistants : agents et raccourcis illisibles", { error: errorMessage(err) });
        return { ok: false, status: 502, code: "opencode-injoignable" };
      }

      const agentsMeta = metaOf(c11.db, "agents");
      const commandsMeta = metaOf(c11.db, "commands");
      const [fiches, subagentDepthValue] = await Promise.all([fichesOf(), depthOf()]);
      const agents = snapshot.agents.slice(0, LIMITS.agents).map((agent) => agentInput(agent, agentsMeta));
      const input: AgentMapInput = {
        // En Simple, les agents du Studio sortent de la carte avec toutes leurs arêtes (§5.2 : aucun détail technique en Simple).
        agents: simple ? agents.filter((agent) => agent.origine !== "studio") : agents,
        commands: snapshot.commands.slice(0, LIMITS.commands).map((command) => commandInput(command, commandsMeta)),
        fiches,
        // Équipes fermées en Simple tant que la constante est fausse (U1) : l'ouverture reste une seule ligne de wiring-eq.ts.
        equipes: simple && !eq.simpleOuvertes ? [] : equipesOf(),
        subagentDepth: subagentDepthValue,
        mode,
        internes: INTERNAL_AGENTS,
      };
      return { ok: true, result: deriveAgentMap(input) };
    },
  };
}

export const agentMapModule: EqModule = {
  name: "agentMap",
  install(reg, eq) {
    const service = createAgentMapService(eq);
    reg.routes("agent-map", (app) => registerAgentMapRoutes(app, service));
  },
};
