// Propriétaire : L37p.
// Pré-lancement P1 à P11 et ajouts (spécification §3.13 l.414-419, §3.12 l.412, P1 l.36, P5 l.40, §6 l.1037 et l.1050 ;
// conception C §6.2 ; plan d'exécution it4, fiche L37p, §4.1.2, D-eq-17, D-eq-18, D-eq-19, décision A4 du 19/09).
//
// Trois points d'entrée, et une seule règle qui les sépare (A4, option b — « zéro requête à la lettre ») :
// - `estimate` est le SEUL point du pré-lancement qui lit opencode. Ses lectures (agents et raccourcis du dossier par `lookup`,
//   configuration globale, conversations occupées) sont gardées EN MÉMOIRE dans un instantané lié à `estimateSha256` :
//   10 minutes de validité, 32 au plus, jamais écrit en base, jamais journalisé, jamais rendu au navigateur, et sans la demande
//   ni les pièces jointes. Une lecture impossible rend 502 `opencode-injoignable` et ne garde AUCUN instantané ;
// - `check` (appelé par `POST …/run` et `POST …/relancer`) n'émet AUCUNE requête, pour AUCUN code de refus : il ne lit que le
//   corps, la base du cockpit, le système de fichiers, les réglages, le catalogue des IA et l'instantané. Il n'appelle ni
//   `lookup`, ni `c11.client`, ni aucune fonction qui peut émettre une requête (repère « Contrôles sans aucune requête ») ;
// - `recheck` (contrôle de fraîcheur) refait les lectures APRÈS l'acceptation, pour le runner seulement : un écart met l'équipe
//   en pause « À vérifier » au lieu de refuser, avant toute injection et avant tout envoi facturé.
//
// Reports de la mesure MX-EQ (train de V0, §2 « L37p (V2) : pré-lancement ») :
// - la configuration est lue par `GET /global/config` : elle répond en millisecondes même quand une extension déclarée bloque le
//   chargement d'une instance ; `subagent_depth` absent = 1 ; `mcp` absent ou vide = aucun ; `plugin` absent ou vide = aucun
//   (`GET /config` ajoute toujours `plugin: []`) ; un serveur MCP DÉSACTIVÉ compte comme configuré (refus prudent, décision 14) ;
// - `external_directory` est jugé SUR L'ENTRÉE GÉNÉRIQUE (« * ») : opencode ajoute toujours une liste blanche (sorties tronquées,
//   /tmp/opencode/*, un `allow` par dossier de fiche), donc un contrôle « aucune règle allow » refuserait tous les assistants ;
// - les empreintes P11 portent sur une FORME CANONIQUE des règles (canonicalAgentRules) : sans elle, l'ordre des `allow` des
//   dossiers de fiches change d'un chargement à l'autre et produirait de fausses pauses « un assistant a changé » ;
// - toute lecture d'un dossier dont l'instance n'est pas chargée reste bornée (LECTURE_TIMEOUT_MS) et se solde par un refus
//   explicite (`opencode-injoignable`), jamais par une attente sans fin.
//
// Ce module ne crée ni racine ni session, n'écrit rien en base et n'envoie rien : il rend un plan (`RunPlan`) ou un refus.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  EqContext,
  EqModule,
  EstimateOutcome,
  EstimateSnapshot,
  PlannedStep,
  PreflightInput,
  PreflightOutcome,
  RecheckOutcome,
  RunPlan,
  TeamPreflightPort,
  TeamRow,
} from "./contracts-eq.ts";
import { configuredExtensions, subagentDepth } from "./diagnostics-11.ts";
import { isInside } from "./fsutil.ts";
import { errorMessage } from "./log.ts";
// <c5:methodes-import>
import { METHODS } from "./methods-catalogue.ts";
import { methodIdsIn } from "./shared/methods.ts";
// </c5:methodes-import>
import type { OcAgentInfo } from "./oc-lookup.ts";
import { roundUsd } from "./pricing.ts";
import { redactSecrets } from "./redact.ts";
import { floorHash } from "./session-floor-service.ts";
import { isChatAgent, isInternalAgentName } from "./shared/agent-choice.ts";
import {
  catalogEntry,
  evaluate,
  modelKey,
  modelName,
  providerOf,
  rightLines,
  type Rule,
  type Run,
  type TaskSize,
  type Tier,
  type UiMode,
} from "./shared/assistant-rules.ts";
import {
  canonicalSteps,
  estimateCanonical,
  estimateFlow,
  estimateProblems,
  type FlowEstimateContext,
  type StepIa,
  suiteEstimate,
} from "./shared/flow-estimate.ts";
import { type FlowMethodsContext, validateFlow } from "./shared/flow.ts";
import { buildFloor, canonicalRules } from "./shared/session-floors.ts";
import { FLOW_LIMITS, planSteps, TEAM_TEXT_LIMITS } from "./shared/team-limits.ts";
import type {
  Flow,
  FlowEstimate,
  FlowProblem,
  FlowStep,
  StepAssistant,
  TeamConfirmation,
  TeamErrorCode,
  TeamEstimateBody,
  TeamStepState,
} from "./shared/team-types.ts";
import { INTERNAL_AGENTS } from "./studio.ts";
import { createTeamStore, type TeamStore } from "./team-store.ts";

/** Validité d'un instantané de lectures (D-eq-17) : au-delà, la feuille ré-estime (409 estimation-perimee). */
export const SNAPSHOT_TTL_MS = 10 * 60_000;
/** Instantanés gardés en mémoire au plus ; le plus ancien sort. */
export const SNAPSHOT_MAX = 32;
/** Délai borné de chaque lecture d'opencode (MX-EQ : une instance non chargée ne doit jamais faire attendre sans fin). */
export const LECTURE_TIMEOUT_MS = 10_000;
/** Fenêtre des moyennes observées passées à l'estimation (magasin, L37s). */
const OBSERVED_WINDOW_MS = 30 * 86_400_000;
/** Codes de la grammaire qui ne sont refusés qu'en mode Simple : ils rendent 403 mode-avance, pas 422 equipe-invalide. */
const CODES_AVANCE: readonly string[] = ["niveau-avance", "personnalise"];

const sha256 = (texte: string): string => createHash("sha256").update(texte, "utf8").digest("hex");

// <c5:methodes-contexte>
/** Méthodes du catalogue attachables à une étape (genre « consigne », L44a) : une méthode « relecture » n'en est pas une. */
const METHODES_CONSIGNE: ReadonlySet<string> = new Set(METHODS.filter((methode) => methode.kind === "consigne").map((methode) => methode.id));
const AUCUNE_METHODE: ReadonlySet<string> = new Set<string>();

/**
 * Méthodes déjà posées dans les fichiers d'agent, RATTACHÉES À L'INSTANTANÉ de l'estimation (A4, réponse (b) à la Q5 du plan
 * it4). Elles sortent des fichiers que `planifier` a DÉJÀ lus et empreintés pour l'estimation : le pré-lancement n'ajoute ni
 * lecture ni requête, et un refus `methodes` n'émet rien. Une table à part plutôt qu'un champ d'`EstimateSnapshot` : ce
 * contrat appartient à l'itération 4 et n'est pas touché ici ; la table faible se vide avec l'instantané qu'elle suit.
 * Un fichier CHANGÉ depuis l'estimation relève de la reprise de fraîcheur de l'exécuteur (pause « À vérifier », L42b), jamais
 * d'une requête ajoutée au pré-lancement.
 */
const methodesDInstantane = new WeakMap<EstimateSnapshot, ReadonlyMap<string, ReadonlySet<string>>>();

/** Contexte `methods` de `validateFlow` (C §5.2) bâti sur ces lectures ; un assistant hors du chemin estimé n'y figure pas. */
const contexteMethodes = (parAssistant: ReadonlyMap<string, ReadonlySet<string>>): FlowMethodsContext => ({
  consigne: METHODES_CONSIGNE,
  parAssistant: (nom) => parAssistant.get(nom) ?? AUCUNE_METHODE,
});
// </c5:methodes-contexte>

/**
 * Forme canonique des règles d'un assistant, base des empreintes P11 (report MX-EQ) : chaque SUITE de règles consécutives de
 * même permission et de même action est triée par motif. L'ordre relatif des suites, lui, décide (la dernière règle qui
 * correspond l'emporte) et n'est donc jamais touché. Sans cette mise en forme, la liste blanche que génère opencode (un `allow`
 * par dossier de fiche) change d'ordre d'un chargement à l'autre et ferait croire qu'un assistant a été modifié.
 */
export function canonicalAgentRules(rules: readonly Rule[]): Rule[] {
  const parMotif = (a: Rule, b: Rule) => (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0);
  const out: Rule[] = [];
  let debut = 0;
  for (let i = 1; i <= rules.length; i++) {
    const avant = rules[i - 1];
    const ici = rules[i];
    if (avant !== undefined && (ici === undefined || ici.permission !== avant.permission || ici.action !== avant.action)) {
      out.push(...rules.slice(debut, i).toSorted(parMotif));
      debut = i;
    }
  }
  return out;
}

/** Empreinte des règles effectives d'un assistant (P11), sur leur forme canonique. */
export function rulesSha256(rules: readonly Rule[]): string {
  return sha256(canonicalRules(canonicalAgentRules(rules)));
}

/** Déroulé enregistré (colonne `flow`), null s'il est illisible. */
function parseFlow(raw: string): Flow | null {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && Array.isArray((value as Flow).blocs) ? (value as Flow) : null;
  } catch {
    return null;
  }
}

/** JSON à clés triées : deux déroulés identiques donnent la même empreinte, quel que soit l'ordre d'écriture des clés. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Ligne d'`item_meta` lue pour un assistant (lecture seule d'une table d'une autre itération). */
interface MetaAssistant {
  title: string | null;
  rights: string | null;
  task_size: string | null;
  origin: string;
}

/** Origine d'un assistant : agent interne, agent natif d'opencode, assistant du cockpit, ou fichier du Studio. */
function origineDe(interne: boolean, natif: boolean, meta: MetaAssistant | null): StepAssistant["origin"] {
  if (interne) return "interne";
  if (natif) return "natif";
  if (meta === null || meta.title === null) return "studio";
  if (meta.origin === "catalogue") return "catalogue";
  return meta.origin === "studio" ? "studio" : "cree";
}

/** Profil de droits : « intégré » pour un agent d'opencode ou du cockpit, sinon celui d'`item_meta` (à défaut, personnalisé). */
function droitsDe(origin: StepAssistant["origin"], meta: MetaAssistant | null): StepAssistant["rights"] {
  if (origin === "natif" || origin === "interne") return "integre";
  if (meta?.rights === "lecture" || meta?.rights === "propose" || meta?.rights === "personnalise") return meta.rights;
  return "personnalise";
}

/** Étapes du déroulé par identifiant (lecture unique des blocs). */
function stepsById(flow: Flow): Map<string, FlowStep> {
  const out = new Map<string, FlowStep>();
  for (const bloc of flow.blocs) {
    if (bloc.type === "etape") out.set(bloc.etape.id, bloc.etape);
    else if (bloc.type === "avis") for (const step of [...bloc.avis, bloc.synthese]) out.set(step.id, step);
    // <c5:formes-5b>
    // Formes de la 5b (L42a) : sans ces deux branches, les étapes d'une relecture ou d'un aiguillage seraient inconnues de
    // `planifier`, donc absentes du plan — aucune règle effective, aucune empreinte, aucun droit pour elles.
    else if (bloc.type === "relecture") for (const step of [bloc.auteur, bloc.relecteur]) out.set(step.id, step);
    else if (bloc.type === "aiguillage") {
      for (const step of [bloc.aiguilleur, ...bloc.specialistes, ...(bloc.synthese ? [bloc.synthese] : [])]) out.set(step.id, step);
    }
    // </c5:formes-5b>
  }
  return out;
}

/** Lectures d'opencode réutilisées par les contrôles du groupe B (instantané de l'estimation, D-eq-17). */
interface Lectures {
  assistants: ReadonlyMap<string, StepAssistant>;
  agents: Array<{ name: string; mode: "primary" | "subagent" | "all"; hidden: boolean }>;
  config: { subagentDepth: number; mcp: boolean; plugin: boolean };
  /** Racine occupée au moment des lectures ; null sans racine. */
  rootBusy: boolean | null;
}

/** Refus rendu par un contrôle, avant d'être habillé par la route. */
interface Refus {
  status: 400 | 403 | 404 | 409 | 422;
  code: TeamErrorCode;
  details?: Record<string, unknown>;
}

const refus = (status: Refus["status"], code: TeamErrorCode, details?: Record<string, unknown>): Refus =>
  details === undefined ? { status, code } : { status, code, details };

/** Lecture impossible : aucune supposition, aucun instantané. */
class LecturesImpossibles extends Error {
  override name = "LecturesImpossibles";
}

/**
 * B1 (constat 20) : l'assistant qui portera la conversation doit être connu du dossier, sélectionnable dans le chat, ni interne
 * ni caché. Même jugement pour `check` (sur l'instantané) et pour le contrôle de fraîcheur (sur les lectures refaites).
 */
function agentDeConversation(
  agents: readonly { name: string; mode: "primary" | "subagent" | "all"; hidden: boolean }[],
  nom: unknown,
): { name: string; mode: "primary" | "subagent" | "all"; hidden: boolean } | null {
  if (typeof nom !== "string" || isInternalAgentName(nom) || INTERNAL_AGENTS.includes(nom)) return null;
  const agent = agents.find((candidate) => candidate.name === nom);
  if (!agent || agent.hidden || !isChatAgent(agent)) return null;
  return agent;
}

export interface TeamPreflightOptions {
  /** Horloge des instantanés (tests) ; défaut : Date.now. */
  now?: () => number;
}

/**
 * Pré-lancement d'une équipe. Aucune dépendance n'est lue à la construction : le câblage installe ce port sur un contexte dont
 * seuls les services réellement appelés existent (wiring-eq.test.ts construit tous les modules sur un c11 minimal).
 */
export function createTeamPreflight(eq: EqContext, options: TeamPreflightOptions = {}): TeamPreflightPort {
  const now = options.now ?? Date.now;
  const c11 = eq.c11;
  /** Instantanés par `estimateSha256`, dans l'ordre d'insertion (le plus ancien sort). */
  const instantanes = new Map<string, EstimateSnapshot>();
  let magasin: TeamStore | null = null;
  const store = (): TeamStore => (magasin ??= createTeamStore({ db: c11.db }));

  // --- Catalogue, IA et prix (tout local) ---------------------------------------------------------------------------------

  /** Catalogue jamais chargé : aucun contrôle de disponibilité (même prudence que la résolution d'un tour de chat). */
  const catalogueCharge = (): boolean => c11.catalog.lite().length > 0;

  /** IA réellement utilisable : fournisseur autorisé mis à part, elle est au catalogue, sait utiliser les outils et n'est pas en fin de vie. */
  const iaDisponible = (model: string): boolean => {
    if (!catalogueCharge()) return true;
    const entry = catalogEntry(c11.catalog.lite(), model);
    return entry !== undefined && entry.toolcall && entry.status !== "deprecated";
  };

  const fournisseurAutorise = (model: string): boolean => c11.env.allowedProviders.includes(providerOf(model));

  const niveauDisponible = (niveau: Tier): boolean => {
    const res = c11.tiers.resolve(niveau);
    return res.model !== null && (res.status === "ok" || res.status === "secours" || res.status === "non-verifie");
  };

  /** IA d'une étape : niveau résolu en mode Avancé, IA propre de l'assistant sinon (décision n° 3). */
  const iaDeLEtape = (step: FlowStep, assistants: ReadonlyMap<string, StepAssistant>, mode: UiMode, variantes: ReadonlyMap<string, string | null>): StepIa | null => {
    const lite = c11.catalog.lite();
    if (mode === "avance" && step.niveau !== null && step.niveau !== undefined) {
      const res = c11.tiers.resolve(step.niveau);
      if (res.model === null) return null;
      return { model: res.model, variant: res.variant, niveau: step.niveau, label: modelName(res.model, lite) };
    }
    const assistant = assistants.get(step.assistant);
    if (!assistant || assistant.model === null) return null;
    return {
      model: assistant.model,
      variant: variantes.get(assistant.name) ?? null,
      niveau: c11.tiers.tierOfModel(assistant.model),
      label: modelName(assistant.model, lite),
    };
  };

  /** Contexte d'estimation (L36b) : le module pur ne lit rien, tout lui est passé. */
  const contexte = (assistants: ReadonlyMap<string, StepAssistant>, ia: (step: FlowStep) => StepIa | null): FlowEstimateContext => ({
    assistants,
    iaDe: ia,
    prix: (model) => c11.tiers.priceOf(model),
    observe: (assistant, model) => store().observedStepCost(assistant, model, now() - OBSERVED_WINDOW_MS),
    simultanees: c11.settings.get().teams.concurrentSteps,
  });

  /** Empreinte de l'estimation (D-eq-19) : texte canonique de L36b, restreint au chemin estimé (relance : le reste). */
  const empreinteEstimation = (flow: Flow, ctx: FlowEstimateContext, chemin: readonly string[], plafond: number): string => {
    const ordre = planSteps(flow).map((planned) => planned.stepId);
    const toutes = canonicalSteps(flow, ctx);
    const restants = new Set(chemin);
    const etapes = toutes.length === ordre.length ? toutes.filter((_, index) => restants.has(ordre[index] ?? "")) : toutes;
    const { teams, budget } = c11.settings.get();
    return sha256(
      estimateCanonical({
        flowSha256: sha256(canonicalJson(flow)),
        etapes,
        plafond,
        teams: { maxCapUsd: teams.maxCapUsd, concurrentSteps: teams.concurrentSteps },
        budget: { monthlyUsd: budget.monthlyUsd },
      }),
    );
  };

  /** Plafond maximal d'un lancement (P8) : réglage, ou 5 % du budget mensuel ; null = aucun plafond opposable. */
  const plafondPermis = (): number | null => {
    const { teams, budget } = c11.settings.get();
    if (teams.maxCapUsd !== null) return teams.maxCapUsd;
    return budget.monthlyUsd > 0 ? Math.round(budget.monthlyUsd * 5) / 100 : null;
  };

  // --- Lectures d'opencode : estimate et recheck SEULEMENT (A4) : début ------------------------------------------------------

  /** Agents du dossier tels qu'opencode les voit, avec le profil de droits et l'origine lus dans `item_meta` (lecture seule). */
  const lireAssistants = async (directory: string): Promise<{ assistants: Map<string, StepAssistant>; variantes: Map<string, string | null>; agents: OcAgentInfo[] }> => {
    // `lookup.get` lit GET /agent et GET /command ensemble, pour ce dossier, avec son propre délai borné.
    const snapshot = await c11.lookup.get(directory);
    const metas = new Map<string, MetaAssistant>();
    // Requête PARAMÉTRÉE, en lecture seule : le pré-lancement n'écrit jamais dans les tables des autres itérations.
    const rows = c11.db.prepare("SELECT name, title, rights, task_size, origin FROM item_meta WHERE kind = ?").all("agents") as unknown as Array<
      MetaAssistant & { name: string }
    >;
    for (const row of rows) metas.set(row.name, row);

    const assistants = new Map<string, StepAssistant>();
    const variantes = new Map<string, string | null>();
    for (const agent of snapshot.agents) {
      const meta = metas.get(agent.name) ?? null;
      const interne = isInternalAgentName(agent.name) || INTERNAL_AGENTS.includes(agent.name);
      const model = agent.model ? modelKey(agent.model) : null;
      const origin = origineDe(interne, agent.native === true, meta);
      const rights = droitsDe(origin, meta);
      const taille = meta?.task_size === "S" || meta?.task_size === "M" || meta?.task_size === "L" ? (meta.task_size as TaskSize) : null;
      assistants.set(agent.name, {
        name: agent.name,
        title: meta?.title ?? agent.name,
        origin,
        rights,
        mode: agent.mode,
        hidden: agent.hidden === true,
        rules: agent.permission,
        model,
        // P1 : un assistant dont l'IA propre n'est plus au catalogue n'est pas proposable. Le fournisseur, lui, est jugé par
        // étape (403 fournisseur-refuse) : une IA d'un autre fournisseur reste lisible, elle n'est simplement jamais appelée.
        available: model === null || iaDisponible(model),
        steps: agent.steps ?? null,
        taille,
      });
      variantes.set(agent.name, agent.variant ?? null);
    }
    return { assistants, variantes, agents: snapshot.agents };
  };

  /** Configuration globale (MX-EQ : /global/config répond même quand une extension bloque le chargement d'une instance). */
  const lireConfig = async (): Promise<Lectures["config"]> => {
    const raw = await c11.client.request<unknown>("GET", "/global/config", { timeoutMs: LECTURE_TIMEOUT_MS });
    const config: Record<string, unknown> = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const mcp = config.mcp;
    return {
      subagentDepth: subagentDepth(config),
      // Un serveur MCP déclaré compte, même désactivé (refus prudent, décision n° 14).
      mcp: typeof mcp === "object" && mcp !== null && !Array.isArray(mcp) && Object.keys(mcp).length > 0,
      plugin: configuredExtensions(config.plugin).length > 0,
    };
  };

  /** Conversation occupée (P4, seconde moitié) : une session de l'arbre de la racine n'est pas au repos. */
  const lireRootBusy = async (directory: string, rootId: string): Promise<boolean> => {
    const raw = await c11.client.request<unknown>("GET", "/session/status", { directory, timeoutMs: LECTURE_TIMEOUT_MS });
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
    return Object.entries(raw as Record<string, unknown>).some(([sessionId, status]) => {
      const repos = typeof status === "object" && status !== null && (status as { type?: unknown }).type === "idle";
      if (repos) return false;
      return sessionId === rootId || c11.sessions.rootOf(sessionId) === rootId;
    });
  };

  /** Les trois lectures de l'estimation. Une seule qui échoue → aucune supposition (502, ou pause « À vérifier » en fraîcheur). */
  const lectures = async (directory: string, rootId: string | null): Promise<Lectures & { variantes: ReadonlyMap<string, string | null> }> => {
    try {
      const [agents, config, busy] = await Promise.all([
        lireAssistants(directory),
        lireConfig(),
        rootId === null ? Promise.resolve(null) : lireRootBusy(directory, rootId),
      ]);
      return {
        assistants: agents.assistants,
        variantes: agents.variantes,
        agents: agents.agents.map((agent) => ({ name: agent.name, mode: agent.mode, hidden: agent.hidden === true })),
        config,
        rootBusy: busy,
      };
    } catch (err) {
      // Aucun texte d'instantané ici : seulement la cause technique.
      c11.log.warn("équipes : lectures du pré-lancement impossibles", { error: errorMessage(err) });
      throw new LecturesImpossibles(errorMessage(err));
    }
  };

  /**
   * Empreinte du fichier d'agent (lecture LOCALE par le Studio) ; assistant natif, sans fichier ou illisible → null.
   * 5b (L45b) : la MÊME lecture rend aussi les méthodes posées dans le corps du fichier (`methodIdsIn`, vérité D-5-07). Aucune
   * lecture n'est ajoutée : c'est le fichier déjà lu et déjà empreinté pour l'estimation qui sert au contexte `methods` (A4).
   */
  const lireFichierAgent = async (assistant: StepAssistant): Promise<{ sha: string | null; methodes: readonly string[] }> => {
    if (assistant.origin === "natif" || assistant.origin === "interne") return { sha: null, methodes: [] };
    try {
      const item = await c11.studio.get("agents", assistant.name, { type: "global" });
      if (item === null) return { sha: null, methodes: [] };
      return {
        sha: sha256(canonicalJson({ frontmatter: item.frontmatter, body: item.body })),
        methodes: methodIdsIn(item.body).map((methode) => methode.id),
      };
    } catch {
      return { sha: null, methodes: [] };
    }
  };

  /**
   * Instantané P11 d'une étape : règles effectives et leur empreinte, fichier d'agent, plancher ETAPE, droits, IA.
   * 5b (L45b) : la même passe recueille les méthodes de chaque fichier d'agent lu, pour le contexte `methods` — un assistant
   * dont aucune étape n'est sur le chemin estimé n'y figure pas, puisque son fichier n'est pas lu (A4 : aucune lecture ajoutée).
   */
  const planifier = async (
    flow: Flow,
    chemin: readonly string[],
    source: { assistants: ReadonlyMap<string, StepAssistant>; variantes: ReadonlyMap<string, string | null> },
    mode: UiMode,
  ): Promise<{ etapes: PlannedStep[]; methodes: Map<string, ReadonlySet<string>> }> => {
    const steps = stepsById(flow);
    const ordre = new Map(planSteps(flow).map((planned) => [planned.stepId, planned]));
    const etapes: PlannedStep[] = [];
    const methodes = new Map<string, ReadonlySet<string>>();
    for (const stepId of chemin) {
      const step = steps.get(stepId);
      const planned = ordre.get(stepId);
      const assistant = step ? source.assistants.get(step.assistant) : undefined;
      const ia = step ? iaDeLEtape(step, source.assistants, mode, source.variantes) : null;
      if (!step || !planned || !assistant || ia === null) continue;
      const agentRules = assistant.rules;
      const floor = buildFloor("ETAPE", { agentRules });
      // Même lecture qu'avant (une par passage, l'ordre des lectures ne change pas) ; elle rend en plus les méthodes du corps.
      const fichier = await lireFichierAgent(assistant);
      methodes.set(assistant.name, new Set(fichier.methodes));
      etapes.push({
        stepId,
        blocIndex: planned.blocIndex,
        ordre: planned.ordre,
        titre: step.titre,
        assistant: assistant.name,
        agentRules,
        rulesSha256: rulesSha256(agentRules),
        agentFileSha256: fichier.sha,
        floor,
        floorSha256: floorHash("ETAPE", { agentRules }),
        droits: rightLines([...agentRules, ...floor], [], assistant.steps),
        model: ia.model,
        variant: ia.variant,
        steps: assistant.steps,
        taille: step.taille,
      });
    }
    return { etapes, methodes };
  };

  // --- Lectures d'opencode : fin --------------------------------------------------------------------------------------------

  // --- Contrôles sans aucune requête (A4) : début ---------------------------------------------------------------------------
  // Tout ce qui suit, jusqu'au repère de fin, ne lit que le corps, la base du cockpit, le système de fichiers, les réglages, le
  // catalogue des IA et l'instantané. Aucune fonction de lecture d'opencode n'y est appelée (team-preflight.test.ts le vérifie
  // par le texte du module ET par le journal du faux opencode : zéro requête reçue pour chaque code de refus).

  /** Pièce jointe acceptable (D-eq-18) : chemin court, sans « .. », résolu dans le dossier, existant, fichier ordinaire. */
  const fichierAccepte = async (dossierLocal: string, racineReelle: string, chemin: string): Promise<boolean> => {
    if (chemin.length === 0 || chemin.length > TEAM_TEXT_LIMITS.cheminFichier || chemin.includes("\0")) return false;
    if (chemin.split(/[\\/]/).includes("..")) return false;
    const local = c11.projects.toLocalPath(chemin) ?? path.resolve(dossierLocal, ...chemin.split(/[\\/]/));
    if (!isInside(dossierLocal, local)) return false;
    try {
      const reel = await fs.realpath(local);
      if (!isInside(racineReelle, reel)) return false;
      return (await fs.stat(reel)).isFile();
    } catch {
      return false;
    }
  };

  /** Groupe A : corps, base, système de fichiers et réglages. Premier refus = réponse. */
  const groupeA = async (input: PreflightInput): Promise<Refus | null> => {
    const { body, mode, relance } = input;
    // A1 P1 : dossier dans le workspace, puis pièces jointes (D-eq-18).
    if (typeof body.directory !== "string" || !c11.projects.isAllowedDirectory(body.directory)) return refus(403, "forbidden-directory");
    const dossierLocal = c11.projects.toLocalPath(body.directory);
    if (dossierLocal === null) return refus(403, "forbidden-directory");
    const fichiers = Array.isArray(body.fichiers) ? body.fichiers : [];
    if (fichiers.length > FLOW_LIMITS.fichiers) return refus(403, "fichier-refuse");
    if (fichiers.length > 0) {
      const racineReelle = await fs.realpath(dossierLocal).catch(() => dossierLocal);
      for (const fichier of fichiers) {
        if (typeof fichier !== "string" || !(await fichierAccepte(dossierLocal, racineReelle, fichier))) return refus(403, "fichier-refuse");
      }
    }
    // A2 : racine connue en base, racine d'une conversation, servie par l'instance principale.
    if (body.rootId !== null && body.rootId !== undefined) {
      const row = c11.sessions.get(body.rootId);
      if (!row || row.deleted_at !== null || row.root_id !== row.id) return refus(404, "not-found");
      if (row.instance !== "principale") return refus(409, "instance-salle");
    }
    // A3 : équipes fermées en mode Simple tant que la constante n'est pas ouverte (décision U1).
    if (mode === "simple" && !eq.simpleOuvertes) return refus(403, "equipes-simple-fermees");
    // A4 P4 (première moitié) : une seule équipe active par conversation ; en relance, ce lancement lui-même est ignoré.
    if (body.rootId) {
      const actifs = store()
        .runs.activeOfRoot(body.rootId)
        .filter((run) => run.id !== relance?.runId);
      if (actifs.length > 0) return refus(409, "equipe-en-cours");
    }
    // A5 P5 : nombre d'équipes actives, toutes conversations confondues.
    if (store().runs.activeCount() >= c11.settings.get().teams.maxActiveRuns) return refus(409, "trop-d-equipes");
    // A6 P9 : le dossier est la racine du workspace.
    if (body.directory === c11.projects.opencodeRoot && body.confirmations?.workspace !== true) return refus(409, "confirmation-workspace");
    // A7 P10 : secret probable dans la demande (jamais le texte du secret dans la réponse ni dans un journal).
    const demande = typeof body.demande === "string" ? body.demande : "";
    if (redactSecrets(demande) !== demande && body.confirmations?.secret !== true) return refus(409, "secret-probable");
    return null;
  };

  /** Ce que le groupe B juge, quelle que soit sa source : instantané (check) ou lectures fraîches (estimation, fraîcheur). */
  interface EntreeB {
    lectures: Lectures;
    flow: Flow;
    mode: UiMode;
    etapes: readonly PlannedStep[];
    /** Réflexion propre de chaque assistant, quand elle a été lue (estimation, fraîcheur) : sans elle, réflexion standard. */
    variantes?: ReadonlyMap<string, string | null>;
    /** Confirmations déjà accordées ; l'estimation les considère toutes accordées (elles sont annoncées à part). */
    accordees: { workspace?: true; secret?: true; plafond?: true; budget?: true };
    /** Garde-fou budgétaire P6 confirmé (en-tête x-cockpit-confirm: 1). */
    confirmed: boolean;
    /** Empreinte attendue ; null : aucune comparaison (l'estimation la calcule). */
    estimateSha256: string | null;
    chemin: readonly string[];
    /** Relance : dépense déjà faite, comptée dans le plafond. */
    deja: number;
    /** false : B4 sauté (le contrôle de fraîcheur ne rejoue que B1 à B3 et B5 ; budget et plafond ont été tranchés au lancement). */
    calculs: boolean;
    // <c5:methodes-entree>
    /**
     * Contexte `methods` de la grammaire (5b, L45b), tiré des fichiers d'agent DÉJÀ LUS pour l'estimation. ABSENT → seul le
     * NOMBRE de méthodes d'une étape est contrôlé : rien n'est supposé, et surtout aucune lecture n'est ajoutée pour le savoir.
     */
    methodes?: FlowMethodsContext;
    // </c5:methodes-entree>
  }

  /** Résultat du groupe B : refus ou estimation calculée (réutilisée par l'estimation et par le plan). */
  interface SortieB {
    refus: Refus | null;
    estimate: FlowEstimate;
    plafond: number;
    empreinte: string;
    /** Confirmations que le lancement demandera (annoncées par l'estimation). */
    confirmations: TeamConfirmation[];
    /** Problèmes du déroulé, lus sur les mêmes assistants et la même IA par étape que le refus. */
    problems: FlowProblem[];
  }

  /** Comptage des passages d'une liste : `chemin` et le plan portent un élément PAR PASSAGE, pas par étape (L42a). */
  const passagesPar = (ids: readonly string[]): Map<string, number> => {
    const out = new Map<string, number>();
    for (const stepId of ids) out.set(stepId, (out.get(stepId) ?? 0) + 1);
    return out;
  };

  /**
   * État des étapes reconstruit à partir du reste du chemin : `tours` = passages prévus moins passages restants. Compter par
   * identifiant ferait passer une relecture dont le premier jet est fini pour une étape entièrement terminée, et ses révisions
   * sortiraient du « Coût du reste » comme du plafond de la relance.
   */
  const etatDuReste = (flow: Flow, chemin: readonly string[]): Array<{ stepId: string; state: TeamStepState; tours: number }> => {
    const prevus = passagesPar(planSteps(flow).map((planned) => planned.stepId));
    const restants = passagesPar(chemin);
    return [...prevus].map(([stepId, total]) => {
      const reste = restants.get(stepId) ?? 0;
      return { stepId, state: (reste > 0 ? "prevue" : "terminee") as TeamStepState, tours: Math.max(0, total - reste) };
    });
  };

  /**
   * Groupe B, sans aucune nouvelle lecture. Ordre : grammaire et étapes (B2), configuration (B3), calculs locaux (B4),
   * conversation occupée (B5) ; B0 et B1 sont faits par l'appelant, avant.
   */
  const groupeB = (entree: EntreeB): SortieB => {
    const { lectures: src, flow, mode, etapes, accordees } = entree;
    const parEtapeId = new Map(etapes.map((etape) => [etape.stepId, etape]));
    const variantes = entree.variantes ?? new Map<string, string | null>();
    const ctx = contexte(src.assistants, (step) => {
      const planned = parEtapeId.get(step.id);
      // Étape hors du chemin estimé (relance : étape déjà terminée) : son IA est relue sur les assistants, jamais « aucune ».
      if (!planned) return iaDeLEtape(step, src.assistants, mode, variantes);
      return {
        model: planned.model,
        variant: planned.variant,
        niveau: step.niveau ?? c11.tiers.tierOfModel(planned.model),
        label: modelName(planned.model, c11.catalog.lite()),
      };
    });
    // Reste à faire, compté en PASSAGES et non en identifiants : une relecture repasse par la même étape à chaque tour (L42a),
    // et `chemin` porte déjà un élément par passage. L'écart entre les passages prévus et ceux qui restent donne le compte de
    // tours déjà faits, sans quoi les révisions à venir sortiraient du reste — et du plafond de la relance (ligne `plafond`).
    const estimate = entree.chemin.length === planSteps(flow).length ? estimateFlow(flow, ctx) : suiteEstimate(flow, { etapes: etatDuReste(flow, entree.chemin) }, ctx);
    // P8 : le plafond EST l'estimation haute (`FlowEstimate.plafond` = `maximum`, L36b) ; en relance, il couvre tout le
    // lancement, donc la dépense déjà faite s'y ajoute (comme `spentOfRun`).
    const plafond = roundUsd(entree.deja + estimate.plafond);
    const empreinte = empreinteEstimation(flow, ctx, entree.chemin, plafond);
    const permis = plafondPermis();
    const { budget } = c11.settings.get();
    const reste = roundUsd(budget.monthlyUsd - c11.ledger.monthTotal());
    const confirmations: TeamConfirmation[] = [];
    if (budget.monthlyUsd > 0 && estimate.maximum > reste) confirmations.push("budget");
    if (permis !== null && plafond > permis) confirmations.push("plafond");

    // B2 P2 : grammaire dans le mode courant, sur les assistants de l'instantané.
    const problems: FlowProblem[] = [
      ...validateFlow(flow, {
        assistants: [...src.assistants.values()],
        mode,
        niveauDisponible,
        pour: "lancement",
        // <c5:methodes-validation>
        ...(entree.methodes ? { methods: entree.methodes } : {}),
        // </c5:methodes-validation>
      }),
      ...estimateProblems(flow, ctx),
    ];

    const premier = (): Refus | null => {
      const bloquants = problems.filter((probleme) => probleme.bloquant);
      if (bloquants.some((probleme) => CODES_AVANCE.includes(probleme.code))) return refus(403, "mode-avance");
      if (bloquants.length > 0) return refus(422, "equipe-invalide", { problems: bloquants });
      // B2 P3 : par étape, fournisseur autorisé puis IA au catalogue et disponible (sans repli, P1), puis dossier extérieur.
      for (const etape of etapes) {
        if (!fournisseurAutorise(etape.model)) return refus(403, "fournisseur-refuse", { titre: etape.titre });
        if (!iaDisponible(etape.model)) return refus(409, "ia-indisponible", { titre: etape.titre });
        const assistant = src.assistants.get(etape.assistant);
        // Entrée générique seulement (report MX-EQ) : la liste blanche d'opencode ne décide pas pour « * ».
        if (assistant && evaluate(assistant.rules, "external_directory", "*") === "allow") return refus(409, "dossier-externe", { titre: etape.titre });
      }
      // B3 : configuration d'opencode (subagent_depth absent = 1 ; un MCP désactivé compte, décision n° 14).
      if (src.config.subagentDepth !== 1) return refus(409, "profondeur-delegation");
      if (src.config.mcp || src.config.plugin) return refus(409, "extension-configuree");
      // B4 : calculs locaux (empreinte, garde-fou budgétaire P6, budget P7, plafond P8). Le contrôle de fraîcheur les saute :
      // ils ont été tranchés au lancement, et l'argent ne change pas d'avis tout seul (il est surveillé par l'arrêt au plafond).
      const b4 = (): Refus | null => {
        if (entree.estimateSha256 !== null && entree.estimateSha256 !== empreinte) return refus(409, "estimation-perimee");
        const lite = c11.catalog.lite();
        const runs: Run[] = etapes.map((etape) => ({ role: "etape", model: etape.model, variant: etape.variant, source: "equipe", agent: etape.assistant }));
        const tailles = etapes.map((etape) => etape.taille);
        const taille: TaskSize = tailles.includes("L") ? "L" : tailles.includes("M") ? "M" : "S";
        const garde = c11.ledger.guardRuns(runs, entree.confirmed, {
          command: null,
          modelName: (key) => modelName(key, lite),
          tierOfModel: (key) => c11.tiers.tierOfModel(key),
          size: taille,
        });
        // Le texte du garde-fou vient du serveur (§9.2) : la route le rend tel quel, la feuille l'affiche sans le réécrire.
        if (garde !== null) return refus(409, "budget-guard", { message: garde.message, titre: garde.title, code: garde.code });
        if (budget.monthlyUsd > 0 && estimate.maximum > reste && accordees.budget !== true) return refus(409, "budget-insuffisant", { reste });
        if (permis !== null && plafond > permis) {
          if (mode === "simple") return refus(403, "plafond-trop-haut", { permis });
          if (accordees.plafond !== true) return refus(409, "plafond-a-confirmer", { permis });
        }
        return null;
      };
      if (entree.calculs) {
        const refusB4 = b4();
        if (refusB4 !== null) return refusB4;
      }
      // B5 P4 (seconde moitié) : réponse en cours dans la conversation, d'après l'instantané.
      if (src.rootBusy === true) return refus(409, "conversation-occupee");
      return null;
    };

    return { refus: premier(), estimate, plafond, empreinte, confirmations, problems };
  };

  /** B0 : instantané présent, non expiré, et de la même équipe (ou du même lancement), du même dossier, de la même racine et du même mode. */
  const instantaneDe = (input: PreflightInput): EstimateSnapshot | null => {
    const snap = typeof input.body.estimateSha256 === "string" ? instantanes.get(input.body.estimateSha256) : undefined;
    if (!snap) return null;
    if (now() - snap.at >= SNAPSHOT_TTL_MS) return null;
    if (snap.teamId !== input.team.id || snap.runId !== (input.relance?.runId ?? null)) return null;
    if (snap.directory !== input.body.directory || snap.rootId !== (input.body.rootId ?? null) || snap.mode !== input.mode) return null;
    return snap;
  };

  /** Pré-lancement complet : AUCUNE requête, pour aucun code (A4). Premier refus = réponse. */
  const check = async (input: PreflightInput): Promise<PreflightOutcome> => {
    const flow = parseFlow(input.team.flow);
    if (flow === null) return { ok: false, status: 422, code: "equipe-invalide" };
    const refusA = await groupeA(input);
    if (refusA !== null) return { ok: false, ...refusA };

    // B0.
    const snap = instantaneDe(input);
    if (snap === null) return { ok: false, status: 409, code: "estimation-perimee" };
    // B1 (constat 20) : assistant de la conversation connu, sélectionnable, ni interne ni caché.
    const agent = agentDeConversation(snap.agents, input.body.agentConversation);
    if (agent === null) return { ok: false, status: 400, code: "invalid", details: { champ: "agentConversation" } };

    const chemin = input.relance ? input.relance.restantes : planSteps(flow).map((planned) => planned.stepId);
    // <c5:methodes-check>
    // A4 à la lettre : les méthodes viennent de l'instantané, donc des fichiers lus par `POST /estimate`. Aucune lecture, aucune
    // requête, et un refus `methodes` n'émet rien. Un instantané d'avant la 5b n'en a pas : la grammaire contrôle alors le seul
    // nombre de méthodes, jamais davantage.
    const methodes = methodesDInstantane.get(snap);
    // </c5:methodes-check>
    const sortie = groupeB({
      lectures: snap,
      flow,
      mode: input.mode,
      etapes: snap.etapes,
      accordees: input.body.confirmations ?? {},
      confirmed: input.confirmed,
      estimateSha256: input.body.estimateSha256,
      chemin,
      deja: input.relance?.depense ?? 0,
      calculs: true,
      ...(methodes ? { methodes: contexteMethodes(methodes) } : {}),
    });
    if (sortie.refus !== null) return { ok: false, ...sortie.refus };

    // IA de la conversation : dernier choix de la conversation, sinon l'IA propre de l'assistant, sinon aucune (champ `model`
    // omis à l'injection : opencode prend alors l'IA de l'assistant, avec sa réflexion propre).
    const choix = input.body.rootId ? c11.ledger.lastChatChoice(input.body.rootId) : null;
    const propre = snap.assistants.get(agent.name)?.model ?? null;
    const iaConversation = choix?.model ? { model: choix.model, variant: choix.variant } : propre === null ? null : { model: propre, variant: null };

    return {
      ok: true,
      plan: {
        flow,
        flowSha256: sha256(canonicalJson(flow)),
        estimate: sortie.estimate,
        estimateSha256: sortie.empreinte,
        plafond: sortie.plafond,
        rootId: input.body.rootId ?? null,
        directory: input.body.directory,
        modeUi: input.mode,
        agentConversation: agent.name,
        iaConversation,
        etapes: [...snap.etapes],
      },
    };
  };

  // --- Contrôles sans aucune requête (A4) : fin -----------------------------------------------------------------------------

  /** Garde l'instantané des lectures : 10 minutes, 32 au plus, jamais en base, jamais journalisé, jamais rendu au navigateur. */
  const garder = (snap: EstimateSnapshot): void => {
    instantanes.delete(snap.estimateSha256);
    instantanes.set(snap.estimateSha256, snap);
    for (const [cle, ancien] of [...instantanes]) if (now() - ancien.at >= SNAPSHOT_TTL_MS) instantanes.delete(cle);
    while (instantanes.size > SNAPSHOT_MAX) {
      const plusAncien = instantanes.keys().next().value;
      if (plusAncien === undefined) break;
      instantanes.delete(plusAncien);
    }
  };

  const estimate = async (team: TeamRow, body: TeamEstimateBody, mode: UiMode, relance?: { runId: string }): Promise<EstimateOutcome> => {
    const flow = parseFlow(team.flow);
    if (flow === null) return { ok: false, status: 422, code: "equipe-invalide" };
    if (typeof body.directory !== "string" || !c11.projects.isAllowedDirectory(body.directory)) return { ok: false, status: 403, code: "forbidden-directory" };
    if (mode === "simple" && !eq.simpleOuvertes) return { ok: false, status: 403, code: "equipes-simple-fermees" };
    const rootId = body.rootId ?? null;
    if (rootId !== null) {
      const row = c11.sessions.get(rootId);
      if (!row || row.deleted_at !== null || row.root_id !== row.id) return { ok: false, status: 404, code: "not-found" };
      if (row.instance !== "principale") return { ok: false, status: 409, code: "instance-salle" };
    }

    // Chemin estimé : tout le déroulé, ou le reste des étapes pour une relance (plafond = déjà dépensé + reste).
    const tous = planSteps(flow).map((planned) => planned.stepId);
    let chemin = tous;
    let deja = 0;
    if (relance) {
      const run = store().runs.get(relance.runId);
      if (!run || run.root_session_id !== rootId) return { ok: false, status: 404, code: "not-found" };
      // Passages déjà TERMINÉS, une ligne par (étape, tour), sa dernière tentative faisant foi : une relecture repasse par la
      // même étape à chaque tour (L42a), donc un seul passage fini n'en retire qu'un du chemin, jamais tous.
      const faits = new Map<string, number>();
      const derniere = new Map<string, { tentative: number; state: string; stepId: string }>();
      for (const step of store().steps.ofRun(relance.runId)) {
        const cle = `${step.step_id}\u0000${step.tour}`;
        const kept = derniere.get(cle);
        if (!kept || step.tentative >= kept.tentative) derniere.set(cle, { tentative: step.tentative, state: step.state, stepId: step.step_id });
      }
      for (const ligne of derniere.values()) if (ligne.state === "terminee") faits.set(ligne.stepId, (faits.get(ligne.stepId) ?? 0) + 1);
      chemin = tous.filter((stepId) => {
        const restant = faits.get(stepId) ?? 0;
        if (restant <= 0) return true;
        faits.set(stepId, restant - 1);
        return false;
      });
      deja = store().spentOfRun(relance.runId);
    }

    let src: Lectures & { variantes: ReadonlyMap<string, string | null> };
    try {
      src = await lectures(body.directory, rootId);
    } catch {
      // Lecture impossible : aucun instantané n'est gardé, donc aucun lancement ne peut s'appuyer dessus.
      return { ok: false, status: 502, code: "opencode-injoignable" };
    }
    const { etapes, methodes } = await planifier(flow, chemin, src, mode);
    // Blocage : refus PRÉVISIBLE, donc jugé toutes confirmations accordées (celles-ci sont annoncées par `confirmations`) et
    // garde-fou budgétaire P6 mis de côté (il se confirme par l'en-tête, après le clic).
    const sortie = groupeB({
      lectures: src,
      flow,
      mode,
      etapes,
      variantes: src.variantes,
      accordees: { workspace: true, secret: true, plafond: true, budget: true },
      confirmed: true,
      estimateSha256: null,
      chemin,
      deja,
      calculs: true,
      // <c5:methodes-estimate>
      methodes: contexteMethodes(methodes),
      // </c5:methodes-estimate>
    });
    const at = now();
    const confirmations: TeamConfirmation[] = [
      ...(body.directory === c11.projects.opencodeRoot ? (["workspace"] as const) : []),
      ...sortie.confirmations,
    ];
    const snapshot: EstimateSnapshot = {
      estimateSha256: sortie.empreinte,
      teamId: team.id,
      runId: relance?.runId ?? null,
      directory: body.directory,
      rootId,
      mode,
      at,
      assistants: src.assistants,
      agents: src.agents,
      config: src.config,
      rootBusy: src.rootBusy,
      etapes,
    };
    // <c5:methodes-garder>
    // Les méthodes suivent l'instantané, sans entrer dans son contrat (it4) : la table faible les libère avec lui. Elles sont
    // posées AVANT `garder`, pour qu'un `check` ne trouve jamais un instantané sans ses méthodes.
    methodesDInstantane.set(snapshot, methodes);
    // </c5:methodes-garder>
    garder(snapshot);
    return {
      ok: true,
      response: {
        estimate: sortie.estimate,
        estimateSha256: sortie.empreinte,
        problems: sortie.problems,
        plafond: sortie.plafond,
        confirmations,
        blocage: sortie.refus === null ? null : { status: sortie.refus.status as 403 | 409 | 422, code: sortie.refus.code, ...(sortie.refus.details ? { details: sortie.refus.details } : {}) },
        expireA: at + SNAPSHOT_TTL_MS,
        deja: relance ? deja : null,
      },
    };
  };

  /**
   * Contrôle de fraîcheur, appelé par le runner APRÈS l'acceptation, jamais par une route de refus : les lectures sont refaites
   * et les contrôles B1 à B3 et B5 rejoués dessus. Règles d'un assistant changées → pause « un assistant a changé » ; tout
   * autre écart → pause « À vérifier » avec son code ; lecture impossible → « À vérifier » (opencode-injoignable).
   */
  const recheck = async (plan: RunPlan, rootId: string): Promise<RecheckOutcome> => {
    let src: Lectures & { variantes: ReadonlyMap<string, string | null> };
    try {
      src = await lectures(plan.directory, rootId);
    } catch {
      return { ok: false, genre: "changement", code: "opencode-injoignable" };
    }
    // P11 : les règles effectives font foi, sur leur forme canonique (report MX-EQ).
    for (const etape of plan.etapes) {
      const assistant = src.assistants.get(etape.assistant);
      if (!assistant || rulesSha256(assistant.rules) !== etape.rulesSha256) return { ok: false, genre: "modification" };
    }
    // B1 : l'assistant de la conversation a pu être caché, renommé ou retiré depuis l'acceptation.
    if (agentDeConversation(src.agents, plan.agentConversation) === null) {
      return { ok: false, genre: "changement", code: "invalid", details: { champ: "agentConversation" } };
    }
    const sortie = groupeB({
      lectures: src,
      flow: plan.flow,
      mode: plan.modeUi,
      etapes: plan.etapes,
      variantes: src.variantes,
      // Budget et plafond ont été tranchés au lancement : la fraîcheur ne juge que l'état d'opencode (B1 à B3, B5).
      accordees: { workspace: true, secret: true, plafond: true, budget: true },
      confirmed: true,
      estimateSha256: null,
      chemin: plan.etapes.map((etape) => etape.stepId),
      deja: 0,
      calculs: false,
      // <c5:methodes-recheck>
      // Aucun contexte `methods` ici : la fraîcheur juge l'état d'OPENCODE (B1 à B3, B5), et les fichiers d'agent ne sont pas
      // relus. Une méthode ajoutée à la main dans un fichier après l'acceptation change ce fichier : c'est la reprise de
      // fraîcheur de l'exécuteur (pause « À vérifier », L42b) qui la voit, jamais une lecture ajoutée ici.
      // </c5:methodes-recheck>
    });
    if (sortie.refus === null) return { ok: true };
    return { ok: false, genre: "changement", code: sortie.refus.code, ...(sortie.refus.details ? { details: sortie.refus.details } : {}) };
  };

  return {
    async assistants(directory) {
      return (await lireAssistants(directory)).assistants;
    },
    estimate,
    check,
    recheck,
  };
}

export function neutralPreflight(): TeamPreflightPort {
  return {
    assistants: async () => new Map(),
    estimate: async () => ({ ok: false, status: 409, code: "a-venir" }),
    check: async () => ({ ok: false, status: 409, code: "a-venir" }),
    recheck: async () => ({ ok: false, genre: "changement", code: "a-venir" }),
  };
}

export const teamPreflightModule: EqModule = {
  name: "teamPreflight",
  install(_reg, eq) {
    // Aucune inscription : le pré-lancement n'a ni dérivation, ni route, ni verrou (EQ_STEP_ORDER).
    eq.ports.preflight = createTeamPreflight(eq);
  },
};
