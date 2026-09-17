// Propriétaire : L1g (classifieur) puis L11b (cockpit-controle).
// Agents internes gardés (spécification §3.11) : un agent dont le fichier manque ou a changé s'installe au repos seulement, car
// l'installation recharge opencode et couperait une réponse en cours. Au repos = aucun redémarrage d'opencode, aucune application
// de la configuration, et occupation « idle » (Cockpit11Deps.occupancy : ni réponse lue en cours, ni demande facturée en vol, ni
// décision en examen ; une occupation non vérifiable ne vaut jamais « au repos »). Sinon : reprise planifiée à 30 s, doublée à
// chaque report jusqu'à 5 min. La vérification est refaite après l'attente de la file d'écriture de la configuration, `applying`
// posé jusqu'à la fin du rechargement (même tenue que la garde du Studio, reload-guard.ts) : aucune demande facturée ne commence
// entre la vérification et le rechargement. ensureAll ne lève jamais : état lisible par le Diagnostic (GET /api/diagnostic/activite),
// jamais de 503 silencieux. L1a appelle ports.internalAgents.ensureAll() au démarrage et après un redémarrage d'opencode ;
// app-factory arrête la minuterie à la fermeture (closeInternalAgents).
// neutralInternalAgents reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan §2.2).
import type { SessionsOccupancy } from "./assistants.ts";
import { CLASSIFIER_AGENT, CLASSIFIER_AGENT_FILE } from "./classifier.ts";
import type { ConfigWriteQueue } from "./config-queue.ts";
import type { Cockpit11, Cockpit11Deps, Cockpit11Module, InternalAgentsPort } from "./contracts-11.ts";
import type { ControlService } from "./control.ts";
import { errorMessage, type Logger } from "./log.ts";
import type { InternalAgentState, InternalAgentStatus } from "./shared/cockpit-event-types.ts";
import { StudioApplyError, type StudioService } from "./studio.ts";

export function neutralInternalAgents(deps: Cockpit11Deps): InternalAgentsPort {
  return {
    ensureAll: () =>
      deps.studio.ensureClassifierAgent().catch((err: unknown) => deps.log.warn("agent de classement non installé", { error: errorMessage(err) })),
    status: () => [{ nom: CLASSIFIER_AGENT, etat: "non-suivi", prochainEssai: null }],
  };
}

/** Première reprise après un report (§3.11). */
export const RETRY_FIRST_MS = 30_000;
/** Reprise doublée à chaque report, plafonnée à 5 min (§3.11). */
export const RETRY_MAX_MS = 5 * 60_000;

/** Agent interne installé par le module : nom réservé (studio.ts, INTERNAL_AGENTS) et contenu exact du fichier. */
export interface InternalAgentDefinition {
  name: string;
  content: string;
}

/** Agents installés par le module, dans l'ordre (L11b ajoute cockpit-controle). */
export const INSTALLED_AGENTS: readonly InternalAgentDefinition[] = [{ name: CLASSIFIER_AGENT, content: CLASSIFIER_AGENT_FILE }];

/** Horloge injectable (tests) : minuterie de reprise. */
export interface InternalAgentsClock {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/** Horloge réelle : la minuterie ne retient pas le processus (arrêt du cockpit). */
const SYSTEM_CLOCK: InternalAgentsClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface InternalAgentsDeps {
  studio: Pick<StudioService, "internalAgentUpToDate" | "ensureInternalAgent">;
  configQueue: Pick<ConfigWriteQueue, "run" | "applyingWhile" | "applying">;
  control: Pick<ControlService, "restarting">;
  /** Prédicat de la garde de rechargement (Cockpit11Deps.occupancy) ; une erreur compte comme « non vérifiable ». */
  occupancy: () => Promise<SessionsOccupancy>;
  log: Pick<Logger, "info" | "warn">;
  /** Absent : INSTALLED_AGENTS. */
  agents?: readonly InternalAgentDefinition[];
  /** Absent : horloge réelle. */
  clock?: InternalAgentsClock;
}

export interface InternalAgentsService extends InternalAgentsPort {
  /** Minuterie arrêtée ; plus aucune tentative ensuite (ensureAll sans effet). */
  close(): void;
}

/** Ce qui empêche d'installer maintenant (journal seulement). */
type Blocker = "redemarrage" | "configuration" | "reponse-en-cours" | "non-verifiable";

type Outcome = "installe" | "differe" | "echec" | "refuse";

/** État affiché par le Diagnostic pour chaque issue d'une tentative. */
const STATE_OF: Readonly<Record<Outcome, InternalAgentState>> = { installe: "installe", differe: "en-attente", echec: "echec", refuse: "echec" };

interface AgentState {
  etat: InternalAgentState;
  prochainEssai: number | null;
  /** Refusé par opencode (retour arrière fait) : aucune reprise automatique, seulement au prochain ensureAll (démarrage, redémarrage). */
  refused: boolean;
}

export function createInternalAgents(deps: InternalAgentsDeps): InternalAgentsService {
  const { studio, configQueue: queue, control, log } = deps;
  const agents = deps.agents ?? INSTALLED_AGENTS;
  const clock = deps.clock ?? SYSTEM_CLOCK;
  // Aucune tentative avant le premier ensureAll (démarrage, une fois opencode joignable) : en attente, sans échéance.
  const states = new Map<string, AgentState>(agents.map((agent) => [agent.name, { etat: "en-attente", prochainEssai: null, refused: false }]));
  let delay = RETRY_FIRST_MS;
  let timer: unknown = null;
  // Incrémentée par chaque passe demandée : une reprise planifiée avant elle n'a plus d'objet.
  let epoch = 0;
  let closed = false;
  // Une passe à la fois : un ensureAll pendant une passe s'exécute après elle.
  let chain: Promise<void> = Promise.resolve();

  const stopTimer = () => {
    if (timer === null) return;
    clock.clearTimer(timer);
    timer = null;
  };

  /** null : au repos. `holding` : applying posé par cette tentative (il ne compte plus comme application en cours). */
  const blocker = async (holding: boolean): Promise<Blocker | null> => {
    if (control.restarting) return "redemarrage";
    if (!holding && queue.applying) return "configuration";
    const occupancy = await deps.occupancy().catch((): SessionsOccupancy => "unverifiable");
    if (occupancy === "idle") return null;
    return occupancy === "busy" ? "reponse-en-cours" : "non-verifiable";
  };

  /** Installation au repos seulement ; rend ce qui l'a empêchée (rien d'écrit), null si faite. */
  const installAtRest = async (agent: InternalAgentDefinition): Promise<Blocker | null> => {
    const cause = await blocker(false);
    if (cause !== null) return cause;
    // Application de la configuration en cours (redémarrage, correctif, adresse Copilot) : attendue d'abord. Aucune tâche de la file
    // n'appelle le Studio : l'installation, qui repasse par la file pour recharger, ne peut pas s'exécuter dedans.
    await queue.run(async () => undefined);
    // Lu puis posé sans attente entre les deux : aucune autre application ne commence entre-temps.
    if (queue.applying) return "configuration";
    return queue.applyingWhile(async () => {
      // Vérification refaite, applying posé : une réponse commencée pendant l'attente n'est jamais coupée, et aucune demande
      // facturée ne commence avant la fin du rechargement.
      const again = await blocker(true);
      if (again === null) await studio.ensureInternalAgent(agent.name, agent.content);
      return again;
    });
  };

  const attempt = async (agent: InternalAgentDefinition): Promise<Outcome> => {
    try {
      // Fichier déjà en place : ni écriture ni rechargement, rien à garder.
      if (await studio.internalAgentUpToDate(agent.name, agent.content)) return "installe";
      const cause = await installAtRest(agent);
      if (cause === null) {
        log.info("agent interne installé", { agent: agent.name });
        return "installe";
      }
      log.info("agent interne : installation reportée à un moment sans réponse en cours", { agent: agent.name, cause });
      return "differe";
    } catch (err) {
      const refused = err instanceof StudioApplyError;
      log.warn(refused ? "agent interne refusé par opencode : retour arrière fait" : "agent interne non installé", {
        agent: agent.name,
        error: errorMessage(err),
      });
      return refused ? "refuse" : "echec";
    }
  };

  /** Tentative pour chaque agent non refusé ; true si une reprise est nécessaire (installation reportée ou en échec). */
  const attemptAll = async (): Promise<boolean> => {
    let retry = false;
    for (const agent of agents) {
      // Fermé avant ou pendant la passe : plus aucune tentative.
      if (closed) break;
      const state = states.get(agent.name) as AgentState;
      if (state.refused) continue;
      const outcome = await attempt(agent);
      state.refused = outcome === "refuse";
      state.etat = STATE_OF[outcome];
      state.prochainEssai = null;
      retry ||= outcome === "differe" || outcome === "echec";
    }
    return retry;
  };

  /** Reprise planifiée : 30 s, puis doublée à chaque report jusqu'à 5 min ; échéance exposée pour chaque agent non installé. */
  const schedule = () => {
    const wait = delay;
    delay = Math.min(delay * 2, RETRY_MAX_MS);
    const at = clock.now() + wait;
    for (const state of states.values()) {
      if (state.etat !== "installe" && !state.refused) state.prochainEssai = at;
    }
    const scheduledEpoch = epoch;
    timer = clock.setTimer(() => {
      timer = null;
      void enqueue(scheduledEpoch);
    }, wait);
  };

  /** `from` : époque de la reprise qui lance la passe ; absent : passe demandée (démarrage ou redémarrage d'opencode). */
  const pass = async (from?: number): Promise<void> => {
    if (from === undefined) {
      // Tentative immédiate de chaque agent, refusés compris, reprise remise à 30 s.
      epoch++;
      delay = RETRY_FIRST_MS;
      for (const state of states.values()) state.refused = false;
    } else if (from !== epoch) {
      // Reprise échue pendant une passe demandée, qui a replanifié elle-même : sans objet (aucun essai en double).
      return;
    }
    const retry = await attemptAll();
    if (closed) return;
    stopTimer();
    // Sans reprise, la prochaine passe est une passe demandée : elle remet elle-même le délai à 30 s.
    if (retry) schedule();
  };

  const enqueue = (from?: number): Promise<void> => {
    const run = chain.then(() => pass(from));
    // Filet : une passe ne lève pas (attempt attrape tout) ; une erreur imprévue est journalisée et n'arrête pas les suivantes.
    chain = run.catch((err: unknown) => log.warn("agents internes : passe d'installation en échec", { error: errorMessage(err) }));
    return chain;
  };

  return {
    // Après close : passe sans effet (attemptAll lit `closed`, rien n'est planifié).
    ensureAll: () => enqueue(),
    status: (): InternalAgentStatus[] =>
      agents.map((agent) => {
        const state = states.get(agent.name) as AgentState;
        return { nom: agent.name, etat: state.etat, prochainEssai: state.prochainEssai };
      }),
    close: () => {
      closed = true;
      stopTimer();
    },
  };
}

/** Service posé par le module, par câblage : app-factory l'arrête à la fermeture, même si un test a surchargé le port. */
const installed = new WeakMap<Cockpit11, InternalAgentsService>();

/** Module avec une horloge ou une liste d'agents injectées (tests) ; production : internalAgentsModule. */
export function createInternalAgentsModule(options: Pick<InternalAgentsDeps, "agents" | "clock"> = {}): Cockpit11Module {
  return {
    name: "internalAgents",
    install(_reg, c11) {
      const service = createInternalAgents({
        studio: c11.studio,
        configQueue: c11.configQueue,
        control: c11.control,
        occupancy: c11.occupancy,
        log: c11.log,
        ...options,
      });
      installed.get(c11)?.close();
      installed.set(c11, service);
      c11.ports.internalAgents = service;
    },
  };
}

export const internalAgentsModule: Cockpit11Module = createInternalAgentsModule();

/** Fermeture du cockpit : minuterie de reprise arrêtée, plus aucune tentative (sans effet si le module n'est pas installé). */
export function closeInternalAgents(c11: Cockpit11): void {
  installed.get(c11)?.close();
  installed.delete(c11);
}
