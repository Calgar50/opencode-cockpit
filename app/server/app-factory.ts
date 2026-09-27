// Fabrique de l'application 1.1 (plan d'exécution §2.2, L1a) : portillon partagé, prédicat de la garde de rechargement,
// câblage wiring-11, puis createApp. Seul endroit où les dérivations, les abonnements au hub, le démarrage et les routes 1.1 sont
// branchés : createApp n'enregistre rien de 1.1 (integration.test.ts, qui monte createApp avec un faux processeur, reste valable).
// Utilisée par main.ts (tous les modules) et par le harnais des tests (modules déclarés, surcharges de ports).
// Salle OMO (plan 2 bis §4.2, T3b) : le routeur d'instances est construit ici, la salle à null tant qu'elle est coupée, et chaque
// dérivation et chaque abonnement est branché selon les instances qu'il sert.
import type { Hono } from "hono";
import { probeSessionsBusyStrict } from "./assistants.ts";
import { billRefusal, type ConfigWriteQueue } from "./config-queue.ts";
import type { Cockpit11, Cockpit11Deps, HubEventMap, InternalAgentsPort, OmoControlDirs, PermissionGate } from "./contracts-11.ts";
import type { BrowserEvent } from "./hub.ts";
import { type AppDeps, createApp } from "./http.ts";
import { createInstanceRouter } from "./instance-router.ts";
import { closeInternalAgents } from "./internal-agents.ts";
import { errorMessage } from "./log.ts";
import type { InstanceDeps, InstanceRouter } from "./omo-contracts.ts";
import { createPermissionGate } from "./permission-gate.ts";
import { reloadOccupancy } from "./reload-guard.ts";
import type { SessionTracker } from "./sessions.ts";
import type { SessionInstance } from "./shared/activity-types.ts";
import { type BuildCockpit11Options, buildCockpit11, type Cockpit11Wiring, servesInstance, STEP_ORDER } from "./wiring-11.ts";
// [3d] début : routes et dérivation de la salle de contrôle 3D, hors du registre 1.1 (itération 3, T3d-a)
import { buildSalle3dDerivations, buildSalle3dRoutes } from "./wiring-3d.ts";
// [3d] fin

export interface CockpitAppDeps extends Omit<AppDeps, "gate" | "proxyHooks" | "internalAgents" | "reloadBusy" | "configQueue"> {
  /** Suivi des sessions (arbre d'une conversation pour le portillon, modules 1.1). */
  sessions: SessionTracker;
  /** File d'écriture de la configuration, partagée par l'API, le Studio, la synchro de l'adresse Copilot et la garde. */
  configQueue: ConfigWriteQueue;
  /** Portillon remplacé (tests) ; absent : createPermissionGate. */
  gate?: PermissionGate;
  /**
   * Instance de la Salle OMO (L18a, au train de V3) : son client, son portillon et son processeur. `null` ou absente : salle
   * coupée — le routeur d'instances est construit avec `omo: null` et AUCUNE inscription de la salle n'est active.
   */
  omo?: InstanceDeps | null;
  /**
   * Dossiers de contrôle de la salle remis au module `omoControl` ; absents ou null : port neutre, aucun fichier écrit, jamais.
   * Relié à `env.omo` (T3c) par l'intégrateur au train de V2.
   */
  omoControlDirs?: OmoControlDirs | null;
}

export interface CockpitAppOptions {
  /** Absent : tous les modules (production). Tableau : seulement ceux-là, les autres gardent leur port neutre (tests). */
  modules?: BuildCockpit11Options["modules"];
  /** Surcharges de ports (tests), posées après l'installation des modules. */
  ports?: BuildCockpit11Options["ports"];
}

/**
 * Instance d'un événement du cockpit, ALIGNÉE PAR L'INTÉGRATEUR AU TRAIN DE V2 sur les types de T3c : l'étiquette vit sur
 * l'ENVELOPPE (`BrowserEvent.instance`, `HubInstanceTag` de hub.ts), posée par `EventHub.cockpit(type, data, instance)`, et jamais
 * dans la donnée — un lecteur qui ne connaît pas la salle lit exactement l'objet 1.0.x. Champ absent ou d'une autre valeur =
 * instance PRINCIPALE, comme en 1.0.x.
 */
function instanceDeLEvenement(event: BrowserEvent): SessionInstance {
  return event.instance === "omo" ? "omo" : "principale";
}

export interface CockpitApp {
  app: Hono;
  wiring: Cockpit11Wiring;
  c11: Cockpit11;
  gate: PermissionGate;
  /**
   * Démarrage 1.1, une fois opencode joignable et l'adresse de l'API Copilot synchronisée, avant processor.start : inscriptions
   * « startup » dans l'ordre de STEP_ORDER, ports.internalAgents.ensureAll() à sa place. Une étape en échec est journalisée et
   * n'arrête pas les suivantes.
   */
  startup(): Promise<void>;
  /** Retire les dérivations du processeur et les abonnements au hub ; arrête la reprise d'installation des agents internes. */
  close(): void;
}

/**
 * Construit le cockpit 1.1 sur des services déjà créés. Rend la décision « examen en cours » par une fonction lue à chaque appel :
 * les services créés avant la fabrique (AssistantService) la reçoivent par `reloadBusy`.
 */
export function createCockpitApp(deps: CockpitAppDeps, options: CockpitAppOptions = {}): CockpitApp {
  const { env, log, db, client, hub, settings, sessions, ledger, archive, lookup, catalog, tiers, projects, control, configQueue, copilotConfig, studio } =
    deps;
  const gate = deps.gate ?? createPermissionGate({ client, db, log, hub, sessions });
  // Lu à chaque appel : aucun module ne lit le prédicat pendant son installation.
  let wiring: Cockpit11Wiring | null = null;
  const reloadBusy = (): boolean => (wiring ? wiring.c11.reloadBusy() : false);
  const occupancy = reloadOccupancy({ queue: configQueue, reloadBusy, probe: () => probeSessionsBusyStrict({ client, projects, db, log }) });
  // Routeur d'instances (T3a) : l'instance principale est faite des dépendances ci-dessus ; la salle reste null tant qu'elle est
  // coupée (aucun client, aucun processeur). `beginBilled` est le compteur du proxy, qui reste dans http.ts en 1.0.x : L18b
  // donnera le sien à l'instance de la salle.
  const omo: InstanceDeps | null = deps.omo ?? null;
  const instances: InstanceRouter = createInstanceRouter({
    principale: {
      instance: "principale",
      client,
      gate,
      lookup,
      catalog,
      processor: deps.processor,
      billRefusal: () => billRefusal({ queue: configQueue, control, copilotConfig }),
      beginBilled: () => () => undefined,
      isAllowedDirectory: (dir) => projects.isAllowedDirectory(dir),
    },
    omo,
  });
  const c11Deps: Cockpit11Deps = {
    env,
    log,
    db,
    client,
    hub,
    settings,
    sessions,
    ledger,
    archive,
    lookup,
    catalog,
    tiers,
    projects,
    control,
    configQueue,
    copilotConfig,
    studio,
    gate,
    occupancy,
    instances,
    omoControlDirs: deps.omoControlDirs ?? null,
  };
  const built = buildCockpit11(c11Deps, { modules: options.modules, ports: options.ports });
  wiring = built;

  // Dérivations (synchrones, avant la file du processeur) et abonnements aux événements du cockpit, dans l'ordre de STEP_ORDER.
  // Un abonné qui lève n'arrête pas les autres : EventHub.publish isole chaque abonné.
  // FILTRE PAR INSTANCE (plan 2 bis §4.2) : une inscription qui ne sert que la salle n'est branchée qu'au processeur de la salle,
  // et la salle coupée (omo === null) n'en branche AUCUNE. Une inscription sans `instances` ne sert que l'instance principale.
  const detach: Array<() => void> = [];
  for (const derivation of built.derivations) {
    if (servesInstance(derivation, "principale")) detach.push(deps.processor.addDerivation(derivation));
    if (omo !== null && servesInstance(derivation, "omo")) detach.push(omo.processor.addDerivation(derivation));
  }
  for (const subscription of built.subscriptions) {
    const fn = subscription.fn as (data: HubEventMap[typeof subscription.type]) => void;
    // Hub unique aux deux instances : l'abonné de la salle ne voit que les événements de la salle, et inversement.
    if (!servesInstance(subscription, "principale") && omo === null) continue;
    detach.push(
      hub.subscribe((event) => {
        if (event.kind !== "cockpit" || event.type !== subscription.type) return;
        if (!servesInstance(subscription, instanceDeLEvenement(event))) return;
        fn(event.data as HubEventMap[typeof subscription.type]);
      }),
    );
  }

  // Port lu au moment de l'appel (jamais en copie) : un module ou une surcharge qui le pose après reste pris en compte.
  const internalAgents: Pick<InternalAgentsPort, "ensureAll"> = { ensureAll: () => built.c11.ports.internalAgents.ensureAll() };
  // [3d] début : routes et dérivation de la salle de contrôle 3D, hors du registre 1.1 (itération 3, T3d-a)
  // Toujours montées (wiring-3d.ts), jamais inscrites dans wiring-11 ; la dérivation des consignes est retirée par close().
  const routes3d = buildSalle3dRoutes(built.c11);
  for (const derivation of buildSalle3dDerivations(built.c11)) detach.push(deps.processor.addDerivation(derivation));
  // [3d] fin
  const app = createApp({
    ...deps,
    gate,
    proxyHooks: built,
    internalAgents,
    reloadBusy,
    routes: [...(deps.routes ?? []), ...built.routes, ...routes3d], // [3d] routes 3d en dernier (itération 3, T3d-a)
  });

  const startup = async (): Promise<void> => {
    const steps = built.registrations.filter((r) => r.kind === "startup");
    const ensureRank = STEP_ORDER.startup.indexOf("internalAgents");
    let ensured = false;
    const ensureAll = async () => {
      ensured = true;
      await internalAgents.ensureAll().catch((err: unknown) => log.warn("agents internes non installés", { error: errorMessage(err) }));
    };
    for (const [index, run] of built.startup.entries()) {
      const module = steps[index]?.module;
      if (!ensured && module !== undefined && (STEP_ORDER.startup as readonly string[]).indexOf(module) >= ensureRank) await ensureAll();
      try {
        await run();
      } catch (err) {
        log.warn("démarrage 1.1 : étape en échec", { module, error: errorMessage(err) });
      }
    }
    if (!ensured) await ensureAll();
  };

  return {
    app,
    wiring: built,
    c11: built.c11,
    gate,
    startup,
    close: () => {
      for (const undo of detach.splice(0)) undo();
      closeInternalAgents(built.c11);
    },
  };
}
