// Câblage des équipes (itération 4, plan d'exécution it4 §2.6, §4.1.3, T4, D-eq-03 à D-eq-06, D-eq-13, D-eq-14) : constantes
// d'ouverture et d'injection, ordre figé des modules et des inscriptions, ports neutres, buildEquipes. Composé À CÔTÉ du câblage
// 1.1 par app-factory.ts (wiring-11.ts n'est pas modifié, aucune nouvelle étape de crochet) : dérivations, abonnements,
// démarrage et routes s'ajoutent APRÈS ceux de la 1.1 ; apply(c11) décore c11.ports.stopTree et compose c11.reloadBusy avant
// createApp. Aucun paquet n'édite ce fichier seul : l'intégrateur, au train de vague (ajout d'un couple à EQ_STEP_ORDER avec
// relecture) ; l'ouverture en Simple est une décision humaine (ci-dessous).
import type { Hono } from "hono";
import { agentMapModule } from "./agent-map-service.ts";
import type { Cockpit11, EventDerivation, HubEventType, StopTreePort } from "./contracts-11.ts";
import type {
  EqContext,
  EqDeps,
  EqModule,
  EqModuleName,
  EqPortName,
  EqPorts,
  EqRegistrar,
  EqRouteGroup,
  TeamProxyGuard,
  TeamProxyGuardRequest,
} from "./contracts-eq.ts";
import type { EquipesInjection } from "./shared/team-types.ts";
import { neutralPreflight, teamPreflightModule } from "./team-preflight.ts";
import { neutralGuards, teamGuardsModule } from "./team-run-guards.ts";
import { neutralRunner, teamRunnerModule } from "./team-runner.ts";
import { neutralTeams, teamsModule } from "./team-service.ts";
import type { HubSubscription } from "./wiring-11.ts";

/**
 * Équipes en mode Simple (décision U1 du 19/09, option a ; plan it4 §2.6, D-eq-13). Tant qu'elle vaut false, en Simple : les six
 * routes de mutation et de lancement répondent 403 equipes-simple-fermees, GET /api/teams rend `ouvertesEnSimple: false`, l'éditeur
 * guidé est inaccessible et l'avis de délégation garde son texte court. OUVERTURE : cette seule ligne, par une décision humaine
 * après les recettes du §7.11 n° 4 (clavier seul, NVDA, captures, test chronométré avec un collègue) ; jamais par une variable
 * d'environnement. Le serveur lit eq.simpleOuvertes, le web lit `ouvertesEnSimple`.
 */
export const EQUIPES_SIMPLE_OUVERTES = false;

/** Injection de la demande et du résultat (D-eq-14) ; repli « carte-seule » en une ligne si la recette M1 échoue. */
export const EQUIPES_INJECTION: EquipesInjection = "noReply";

/** Ordre d'installation des modules d'équipes. */
export const EQ_MODULE_ORDER = ["agentMap", "teams", "teamPreflight", "teamRunner", "teamGuards"] as const satisfies readonly EqModuleName[];

export interface EqStepOrder {
  derivations: readonly EqModuleName[];
  hub: ReadonlyArray<readonly [EqModuleName, HubEventType]>;
  startup: readonly EqModuleName[];
  routes: ReadonlyArray<readonly [EqRouteGroup, EqModuleName]>;
  proxyGuard: readonly EqModuleName[];
  stopTreeDecorator: readonly EqModuleName[];
  reloadBusy: readonly EqModuleName[];
}

/**
 * Table des couples attendus (plan it4 §4.1.3). Le registre range chaque inscription par son rang ; un couple absent fait
 * échouer buildEquipes (donc wiring-eq.test.ts et le démarrage).
 * - dérivations (après celles de la 1.1) : teamRunner (session.status, session.idle, session.error, message.updated,
 *   permission.asked, permission.replied), puis teamGuards (global.disposed, server.instance.disposed) ;
 * - abonnements : teamGuards sur usage.updated (plafond), puis teamRunner sur opencode.connection (vérification à la reconnexion) ;
 * - démarrage (après celui de la 1.1) : teamRunner (recover) ;
 * - routes (après celles de la 1.1, avant le 404) : agent-map, teams, puis team-runs du runner et des incidents ;
 * - verrou du proxy et des Archives, décorateur de stopTree : teamGuards ; prédicat de rechargement : teamRunner (stepsBusy).
 */
export const EQ_STEP_ORDER = {
  derivations: ["teamRunner", "teamGuards"],
  hub: [
    ["teamGuards", "usage.updated"],
    ["teamRunner", "opencode.connection"],
  ],
  startup: ["teamRunner"],
  routes: [
    ["agent-map", "agentMap"],
    ["teams", "teams"],
    ["team-runs", "teamRunner"],
    ["team-runs", "teamGuards"],
  ],
  proxyGuard: ["teamGuards"],
  stopTreeDecorator: ["teamGuards"],
  reloadBusy: ["teamRunner"],
} as const satisfies EqStepOrder;

/** Modules réels, par nom (production : tous ; harnais : ceux que le test déclare par `equipes`). */
export const EQ_MODULES: { readonly [N in EqModuleName]: EqModule } = {
  agentMap: agentMapModule,
  teams: teamsModule,
  teamPreflight: teamPreflightModule,
  teamRunner: teamRunnerModule,
  teamGuards: teamGuardsModule,
};

/** Ports neutres : ceux de tout module non installé, même quand son code réel est fusionné. */
export const EQ_NEUTRAL_PORTS: { readonly [P in EqPortName]: (deps: EqDeps) => EqPorts[P] } = {
  teams: neutralTeams,
  preflight: neutralPreflight,
  runner: neutralRunner,
  guards: neutralGuards,
};

export type EqRegistrationKind = "derivation" | "hub" | "startup" | "routes" | "proxyGuard" | "stopTreeDecorator" | "reloadBusy";

export interface EqRegistration {
  kind: EqRegistrationKind;
  /** Nom de dérivation, type d'événement, « startup », groupe de routes ou nom de la nature. */
  key: string;
  module: EqModuleName;
}

export interface EquipesWiring {
  eq: EqContext;
  /** Modules installés, dans l'ordre d'installation. */
  modules: readonly EqModuleName[];
  /** Toutes les inscriptions, rangées par EQ_STEP_ORDER à l'intérieur de chaque nature. */
  registrations: readonly EqRegistration[];
  derivations: readonly EventDerivation[];
  subscriptions: readonly HubSubscription[];
  startup: ReadonlyArray<() => Promise<void>>;
  routes: ReadonlyArray<(app: Hono) => void>;
  /** Verrous inscrits, dans l'ordre : la première Response l'emporte ; null = la route continue. */
  proxyGuard(req: TeamProxyGuardRequest): Promise<Response | null>;
  /** Prédicats de rechargement inscrits (étapes d'équipe en cours) ; false sans inscription. */
  stepsBusy(): boolean;
  /**
   * Pose le décorateur de c11.ports.stopTree (si teamGuards l'a inscrit, D-eq-05) et compose
   * c11.reloadBusy = () => inner() || stepsBusy() (si teamRunner a inscrit son prédicat, D-eq-06). Idempotent : un second appel
   * sur le même c11 ne compose rien de plus.
   */
  apply(c11: Cockpit11): void;
}

export interface BuildEquipesOptions {
  /** Absent : tous les modules (production, app-factory.ts). Tableau : seulement ceux-là, par nom ou module factice (tests). */
  modules?: ReadonlyArray<EqModuleName | EqModule>;
  /** Surcharges de ports (tests), posées après l'installation des modules : elles l'emportent. */
  ports?: Partial<EqPorts>;
  /**
   * TESTS SEULEMENT : ouvre (ou ferme) les équipes en mode Simple sans toucher à EQUIPES_SIMPLE_OUVERTES. Interdit en production :
   * app-factory.ts ne le transmet jamais, et l'ouverture réelle est la constante (décision U1).
   */
  simpleOuvertes?: boolean;
}

const MODULE_RANK = new Map<string, number>(EQ_MODULE_ORDER.map((name, index) => [name, index]));

function rankOf(kind: EqRegistrationKind, key: string, module: EqModuleName): number {
  switch (kind) {
    case "derivation":
      return (EQ_STEP_ORDER.derivations as readonly string[]).indexOf(module);
    case "hub":
      return EQ_STEP_ORDER.hub.findIndex(([m, type]) => m === module && type === key);
    case "startup":
      return (EQ_STEP_ORDER.startup as readonly string[]).indexOf(module);
    case "routes":
      return EQ_STEP_ORDER.routes.findIndex(([group, m]) => group === key && m === module);
    case "proxyGuard":
    case "stopTreeDecorator":
    case "reloadBusy":
      return (EQ_STEP_ORDER[kind] as readonly string[]).indexOf(module);
  }
}

/** Construit le câblage des équipes : ports neutres, installation des modules demandés, inscriptions rangées, surcharges. */
export function buildEquipes(deps: EqDeps, options: BuildEquipesOptions = {}): EquipesWiring {
  const ports = Object.fromEntries(
    (Object.keys(EQ_NEUTRAL_PORTS) as EqPortName[]).map((name) => [name, EQ_NEUTRAL_PORTS[name](deps)]),
  ) as unknown as EqPorts;
  const eq: EqContext = {
    ...deps,
    ports,
    simpleOuvertes: options.simpleOuvertes ?? EQUIPES_SIMPLE_OUVERTES,
    injection: EQUIPES_INJECTION,
  };

  const selected: EqModule[] = [];
  for (const entry of options.modules ?? EQ_MODULE_ORDER) {
    const name: string = typeof entry === "string" ? entry : entry.name;
    const module: EqModule | undefined = typeof entry === "string" ? EQ_MODULES[entry] : entry;
    if (!module || module.name !== name || !MODULE_RANK.has(name)) throw new Error(`wiring-eq : module inconnu (${name})`);
    if (selected.some((m) => m.name === name)) throw new Error(`wiring-eq : module déclaré deux fois (${name})`);
    selected.push(module);
  }
  selected.sort((a, b) => (MODULE_RANK.get(a.name) ?? 0) - (MODULE_RANK.get(b.name) ?? 0));

  const entries: Array<EqRegistration & { rank: number; order: number; value: unknown }> = [];
  let open = true;
  for (const module of selected) {
    const add = (kind: EqRegistrationKind, key: string, value: unknown) => {
      if (!open) throw new Error(`wiring-eq : inscription hors de l'installation (${kind} ${key} / ${module.name})`);
      const rank = rankOf(kind, key, module.name);
      if (rank < 0) throw new Error(`wiring-eq : couple non prévu dans EQ_STEP_ORDER (${kind} ${key} / ${module.name})`);
      entries.push({ kind, key, module: module.name, rank, order: entries.length, value });
    };
    const reg: EqRegistrar = {
      derivation: (derivation) => add("derivation", derivation.name, derivation),
      hub: (type, fn) => add("hub", type, { type, fn }),
      startup: (fn) => add("startup", "startup", fn),
      routes: (group, fn) => add("routes", group, fn),
      proxyGuard: (fn) => add("proxyGuard", "proxyGuard", fn),
      stopTreeDecorator: (fn) => add("stopTreeDecorator", "stopTreeDecorator", fn),
      reloadBusy: (fn) => add("reloadBusy", "reloadBusy", fn),
    };
    module.install(reg, eq);
  }
  open = false;

  for (const [name, port] of Object.entries(options.ports ?? {})) {
    if (port !== undefined) (eq.ports as unknown as Record<string, unknown>)[name] = port;
  }

  const kinds: EqRegistrationKind[] = ["derivation", "hub", "startup", "routes", "proxyGuard", "stopTreeDecorator", "reloadBusy"];
  const sorted = kinds.flatMap((kind) => entries.filter((e) => e.kind === kind).sort((a, b) => a.rank - b.rank || a.order - b.order));
  const valuesOf = <T>(kind: EqRegistrationKind) => sorted.filter((e) => e.kind === kind).map((e) => e.value as T);
  const guards = valuesOf<TeamProxyGuard>("proxyGuard");
  const decorators = valuesOf<(inner: StopTreePort) => StopTreePort>("stopTreeDecorator");
  const busy = valuesOf<() => boolean>("reloadBusy");
  const stepsBusy = (): boolean => busy.some((fn) => fn() === true);
  const applied = new WeakSet<Cockpit11>();

  return {
    eq,
    modules: selected.map((m) => m.name),
    registrations: sorted.map(({ kind, key, module }) => ({ kind, key, module })),
    derivations: valuesOf<EventDerivation>("derivation"),
    subscriptions: valuesOf<HubSubscription>("hub"),
    startup: valuesOf<() => Promise<void>>("startup"),
    routes: valuesOf<(app: Hono) => void>("routes"),
    async proxyGuard(req) {
      for (const guard of guards) {
        const response = await guard(req);
        if (response) return response;
      }
      return null;
    },
    stepsBusy,
    apply(c11) {
      if (applied.has(c11)) return;
      applied.add(c11);
      // D-eq-05 : l'arrêt interne reste celui en vigueur (module ou surcharge) ; la route et le crochet abort lisent
      // c11.ports.stopTree au moment de l'appel, donc passent par le décorateur.
      for (const decorate of decorators) c11.ports.stopTree = decorate(c11.ports.stopTree);
      if (busy.length > 0) {
        // D-eq-06 : tous les lecteurs appellent c11.reloadBusy au moment de l'appel (prédicat local d'app-factory, AssistantService
        // par main.ts et par le harnais, donc aussi le réalignement).
        const inner = c11.reloadBusy;
        c11.reloadBusy = () => inner.call(c11) || stepsBusy();
      }
    },
  };
}
