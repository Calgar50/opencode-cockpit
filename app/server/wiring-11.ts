// Câblage 1.1 (plan d'exécution §2.2, §2.6, §4.4 ; T0) : porte I1, ordre figé des modules, des crochets, des dérivations, des
// abonnements, du démarrage et des routes, ports neutres. Aucun paquet n'édite ce fichier : l'intégrateur seul, au train de vague
// (ajout d'un couple à STEP_ORDER avec relecture, bascule d'ACTIVATION_OUVERTE au train de V4).
// Rien n'est enregistré dans createApp : app-factory.ts (L1a) appelle buildCockpit11 puis branche les listes rendues.
import type { Hono } from "hono";
import { activationModule, neutralActivation } from "./autonomy-activation.ts";
import { delegationPolicyModule, neutralDelegationPolicy } from "./autonomy-delegation.ts";
import { neutralRequests, requestsModule } from "./autonomy-requests.ts";
import { capWatchModule, neutralCapWatch } from "./autonomy-watch.ts";
import { autonomyModule, neutralAutonomy } from "./autonomy.ts";
import type {
  Cockpit11,
  Cockpit11Deps,
  Cockpit11Module,
  Cockpit11Ports,
  EventDerivation,
  HookSignatures,
  HookStep,
  HubEventMap,
  HubEventType,
  ModuleName,
  PortName,
  Registrar,
  RouteGroup,
} from "./contracts-11.ts";
import { controlAiModule, neutralControlAi } from "./control-ai.ts";
import { conversationAutonomyModule, neutralConversationAutonomy } from "./conversation-autonomy.ts";
import { delegationWatchModule, neutralDelegationWatch } from "./delegation-watch.ts";
import { diagnosticsModule, neutralDiagnostics } from "./diagnostics-11.ts";
import { factsModule, neutralFacts } from "./fact-store.ts";
import { internalAgentsModule, neutralInternalAgents } from "./internal-agents.ts";
import { neutralPlans, plansModule } from "./plans.ts";
import { floorsModule, neutralFloors } from "./session-floor-service.ts";
import { neutralStopTree, stopTreeModule } from "./stop-tree.ts";
import { neutralTaskGuard, taskGuardModule } from "./task-once-guard.ts";

/**
 * Porte I1 tenue par le code (plan §2.6). Tant qu'elle vaut false, le port activation réel répond comme le port neutre (refus
 * « a-venir ») ; les tests ouvrent l'activation par surcharge de port. Bascule : une ligne, par l'intégrateur, au train de V4.
 */
export const ACTIVATION_OUVERTE = false;

/** Ordre d'installation des modules. */
export const MODULE_ORDER = [
  "gate",
  "floors",
  "facts",
  "conversationAutonomy",
  "plans",
  "activation",
  "requests",
  "taskGuard",
  "delegationWatch",
  "stopTree",
  "autonomy",
  "delegationPolicy",
  "controlAi",
  "capWatch",
  "internalAgents",
  "diagnostics",
] as const satisfies readonly ModuleName[];

export interface StepOrder {
  hooks: { readonly [S in HookStep]: readonly ModuleName[] };
  derivations: readonly ModuleName[];
  hub: ReadonlyArray<readonly [ModuleName, HubEventType]>;
  startup: readonly ModuleName[];
  routes: ReadonlyArray<readonly [RouteGroup, ModuleName]>;
}

/**
 * Table des couples attendus (plan §4.4, D-13). Le registre range chaque inscription par son rang dans cette table ; un couple
 * absent fait échouer buildCockpit11 (donc wiring-11.test.ts et le démarrage).
 */
export const STEP_ORDER = {
  hooks: {
    createSession: ["floors"],
    sessionCreated: ["floors"],
    beforeBilledSend: ["floors", "plans", "activation", "requests"],
    beforeOnceRelay: ["taskGuard"],
    abort: ["stopTree"],
  },
  // gate : permission.replied (réévaluation des refus retenus) ; taskGuard : refus Simple.
  derivations: ["gate", "facts", "taskGuard", "delegationWatch", "autonomy", "capWatch"],
  hub: [
    ["delegationWatch", "usage.updated"],
    ["autonomy", "opencode.connection"],
    ["capWatch", "usage.updated"],
  ],
  // conversationAutonomy : retour à « demander » ; internalAgents : ensureAll ; capWatch : recover.
  startup: ["conversationAutonomy", "internalAgents", "capWatch"],
  routes: [
    ["conversations", "stopTree"],
    ["delegations", "taskGuard"],
    ["activity", "facts"],
    ["autonomy", "conversationAutonomy"],
    ["plans", "plans"],
    ["diagnostic-11", "diagnostics"],
  ],
} as const satisfies StepOrder;

/** Module « gate » : le portillon est une dépendance (deps.gate) ; son installation est portée par l'objet (L1b). */
const gateModule: Cockpit11Module = {
  name: "gate",
  install(reg, c11) {
    c11.gate?.install?.(reg, c11);
  },
};

/** Modules réels, par nom (production : tous ; harnais : ceux que le test déclare). */
export const MODULES: { readonly [N in ModuleName]: Cockpit11Module } = {
  gate: gateModule,
  floors: floorsModule,
  facts: factsModule,
  conversationAutonomy: conversationAutonomyModule,
  plans: plansModule,
  activation: activationModule,
  requests: requestsModule,
  taskGuard: taskGuardModule,
  delegationWatch: delegationWatchModule,
  stopTree: stopTreeModule,
  autonomy: autonomyModule,
  delegationPolicy: delegationPolicyModule,
  controlAi: controlAiModule,
  capWatch: capWatchModule,
  internalAgents: internalAgentsModule,
  diagnostics: diagnosticsModule,
};

/** Ports neutres (= comportement 1.0.4) : ceux de tout module non installé, même quand son code réel est fusionné. */
export const NEUTRAL_PORTS: { readonly [P in PortName]: (deps: Cockpit11Deps) => Cockpit11Ports[P] } = {
  stopTree: neutralStopTree,
  taskGuard: neutralTaskGuard,
  delegationWatch: neutralDelegationWatch,
  floors: neutralFloors,
  facts: neutralFacts,
  conversationAutonomy: neutralConversationAutonomy,
  plans: neutralPlans,
  autonomy: neutralAutonomy,
  requests: neutralRequests,
  activation: neutralActivation,
  delegationPolicy: neutralDelegationPolicy,
  capWatch: neutralCapWatch,
  controlAi: neutralControlAi,
  internalAgents: neutralInternalAgents,
  diagnostics: neutralDiagnostics,
};

export type RegistrationKind = "hook" | "derivation" | "hub" | "startup" | "routes";

export interface Registration {
  kind: RegistrationKind;
  /** Étape, nom de dérivation, type d'événement, « startup » ou groupe de routes. */
  key: string;
  module: ModuleName;
}

export type HubSubscription = { [K in HubEventType]: { type: K; fn: (data: HubEventMap[K]) => void } }[HubEventType];

export interface Cockpit11Wiring {
  c11: Cockpit11;
  /** Modules installés, dans l'ordre d'installation. */
  modules: readonly ModuleName[];
  /** Toutes les inscriptions, rangées par STEP_ORDER à l'intérieur de chaque nature. */
  registrations: readonly Registration[];
  hooks: { readonly [S in HookStep]: ReadonlyArray<HookSignatures[S]> };
  derivations: readonly EventDerivation[];
  subscriptions: readonly HubSubscription[];
  startup: ReadonlyArray<() => Promise<void>>;
  routes: ReadonlyArray<(app: Hono) => void>;
  /** Crochets d'une étape, dans l'ordre : la première Response l'emporte (les suivants ne sont pas appelés) ; null = continuer. */
  runHooks<S extends HookStep>(step: S, ...args: Parameters<HookSignatures[S]>): Promise<Response | null>;
}

export interface BuildCockpit11Options {
  /** Absent : tous les modules (production, app-factory.ts). Tableau : seulement ceux-là, par nom ou module factice (tests). */
  modules?: ReadonlyArray<ModuleName | Cockpit11Module>;
  /** Surcharges de ports (tests), posées après l'installation des modules : elles l'emportent. */
  ports?: Partial<Cockpit11Ports>;
}

const MODULE_RANK = new Map<string, number>(MODULE_ORDER.map((name, index) => [name, index]));

function rankOf(kind: RegistrationKind, key: string, module: ModuleName): number {
  switch (kind) {
    case "hook": {
      const list: readonly string[] | undefined = (STEP_ORDER.hooks as Record<string, readonly string[]>)[key];
      return list ? list.indexOf(module) : -1;
    }
    case "derivation":
      return (STEP_ORDER.derivations as readonly string[]).indexOf(module);
    case "hub":
      return STEP_ORDER.hub.findIndex(([m, type]) => m === module && type === key);
    case "startup":
      return (STEP_ORDER.startup as readonly string[]).indexOf(module);
    case "routes":
      return STEP_ORDER.routes.findIndex(([group, m]) => group === key && m === module);
  }
}

/** Construit le câblage 1.1 : ports neutres, installation des modules demandés, inscriptions rangées, surcharges de ports. */
export function buildCockpit11(deps: Cockpit11Deps, options: BuildCockpit11Options = {}): Cockpit11Wiring {
  const ports = Object.fromEntries(
    (Object.keys(NEUTRAL_PORTS) as PortName[]).map((name) => [name, NEUTRAL_PORTS[name](deps)]),
  ) as unknown as Cockpit11Ports;
  const c11: Cockpit11 = {
    ...deps,
    ports,
    activationOuverte: ACTIVATION_OUVERTE,
    reloadBusy: () => c11.ports.autonomy.examining(),
  };

  const selected: Cockpit11Module[] = [];
  for (const entry of options.modules ?? MODULE_ORDER) {
    const name: string = typeof entry === "string" ? entry : entry.name;
    const module: Cockpit11Module | undefined = typeof entry === "string" ? MODULES[entry] : entry;
    if (!module || module.name !== name || !MODULE_RANK.has(name)) throw new Error(`wiring-11 : module inconnu (${name})`);
    if (selected.some((m) => m.name === name)) throw new Error(`wiring-11 : module déclaré deux fois (${name})`);
    selected.push(module);
  }
  selected.sort((a, b) => (MODULE_RANK.get(a.name) ?? 0) - (MODULE_RANK.get(b.name) ?? 0));

  const entries: Array<Registration & { rank: number; order: number; value: unknown }> = [];
  let open = true;
  for (const module of selected) {
    const add = (kind: RegistrationKind, key: string, value: unknown) => {
      if (!open) throw new Error(`wiring-11 : inscription hors de l'installation (${kind} ${key} / ${module.name})`);
      const rank = rankOf(kind, key, module.name);
      if (rank < 0) throw new Error(`wiring-11 : couple non prévu dans STEP_ORDER (${kind} ${key} / ${module.name})`);
      entries.push({ kind, key, module: module.name, rank, order: entries.length, value });
    };
    const reg: Registrar = {
      hook: (step, fn) => add("hook", step, fn),
      derivation: (derivation) => add("derivation", derivation.name, derivation),
      hub: (type, fn) => add("hub", type, { type, fn }),
      startup: (fn) => add("startup", "startup", fn),
      routes: (group, fn) => add("routes", group, fn),
    };
    module.install(reg, c11);
  }
  open = false;

  for (const [name, port] of Object.entries(options.ports ?? {})) {
    if (port !== undefined) (c11.ports as unknown as Record<string, unknown>)[name] = port;
  }

  const kinds: RegistrationKind[] = ["hook", "derivation", "hub", "startup", "routes"];
  const stepIndex = (e: Registration) => (e.kind === "hook" ? Object.keys(STEP_ORDER.hooks).indexOf(e.key) : 0);
  const sorted = kinds.flatMap((kind) =>
    entries.filter((e) => e.kind === kind).sort((a, b) => stepIndex(a) - stepIndex(b) || a.rank - b.rank || a.order - b.order),
  );
  const valuesOf = <T>(kind: RegistrationKind, key?: string) =>
    sorted.filter((e) => e.kind === kind && (key === undefined || e.key === key)).map((e) => e.value as T);
  const hooks = {
    createSession: valuesOf<HookSignatures["createSession"]>("hook", "createSession"),
    sessionCreated: valuesOf<HookSignatures["sessionCreated"]>("hook", "sessionCreated"),
    beforeBilledSend: valuesOf<HookSignatures["beforeBilledSend"]>("hook", "beforeBilledSend"),
    beforeOnceRelay: valuesOf<HookSignatures["beforeOnceRelay"]>("hook", "beforeOnceRelay"),
    abort: valuesOf<HookSignatures["abort"]>("hook", "abort"),
  };

  return {
    c11,
    modules: selected.map((m) => m.name),
    registrations: sorted.map(({ kind, key, module }) => ({ kind, key, module })),
    hooks,
    derivations: valuesOf<EventDerivation>("derivation"),
    subscriptions: valuesOf<HubSubscription>("hub"),
    startup: valuesOf<() => Promise<void>>("startup"),
    routes: valuesOf<(app: Hono) => void>("routes"),
    async runHooks<S extends HookStep>(step: S, ...args: Parameters<HookSignatures[S]>): Promise<Response | null> {
      for (const fn of hooks[step] as ReadonlyArray<(...a: Parameters<HookSignatures[S]>) => Promise<Response | null>>) {
        const response = await fn(...args);
        if (response) return response;
      }
      return null;
    },
  };
}
