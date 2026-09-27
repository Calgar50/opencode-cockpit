// Câblage 1.1 (plan d'exécution §2.2, §2.6, §4.4 ; T0) : porte I1, ordre figé des modules, des crochets, des dérivations, des
// abonnements, du démarrage et des routes, ports neutres. Aucun paquet n'édite ce fichier : l'intégrateur seul, au train de vague
// (ajout d'un couple à STEP_ORDER avec relecture ; bascule d'ACTIVATION_OUVERTE faite au train de la vague 3 de l'itération 2).
// Rien n'est enregistré dans createApp : app-factory.ts (L1a) appelle buildCockpit11 puis branche les listes rendues.
// Salle OMO (plan 2 bis §2.7, §4.1.2, §4.2 ; T3b) : porte SALLE_OUVERTE, modules `omo*` et leurs ports neutres, ordre de la salle
// fondu dans MODULE_ORDER et STEP_ORDER (chaque instance garde son ordre, en sous-suite), filtre d'instance des inscriptions
// (absent = principale) et des crochets (runHooks lit ProxyContext.instance).
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
  InstanceFilter,
  ModuleName,
  PortName,
  ProxyContext,
  RegistrationOptions,
  Registrar,
  RouteGroup,
} from "./contracts-11.ts";
import { controlAiModule, neutralControlAi } from "./control-ai.ts";
import { conversationAutonomyModule, neutralConversationAutonomy } from "./conversation-autonomy.ts";
import { delegationWatchModule, neutralDelegationWatch } from "./delegation-watch.ts";
import { diagnosticsModule, neutralDiagnostics } from "./diagnostics-11.ts";
import { factsModule, neutralFacts } from "./fact-store.ts";
import { internalAgentsModule, neutralInternalAgents } from "./internal-agents.ts";
import { neutralOmoActivation, omoActivationModule } from "./omo-activation.ts";
import { neutralOmoCaps, omoCapsModule } from "./omo-caps.ts";
import { neutralOmoControl, omoControlModule } from "./omo-control-module.ts";
import { neutralOmoDetections, omoDetectionsModule } from "./omo-detections-service.ts";
import { neutralOmoPrecheck, omoPrecheckModule } from "./omo-precheck-service.ts";
import { neutralOmoResponder, omoResponderModule } from "./omo-responder.ts";
import { neutralOmoRoom, omoRoomModule } from "./omo-room.ts";
import { neutralOmoStop, omoStopModule } from "./omo-stop.ts";
import { neutralPlans, plansModule } from "./plans.ts";
import { floorsModule, neutralFloors } from "./session-floor-service.ts";
import type { SessionInstance } from "./shared/activity-types.ts";
import { neutralStopTree, stopTreeModule } from "./stop-tree.ts";
import { neutralTaskGuard, taskGuardModule } from "./task-once-guard.ts";
// <c5:import>
import { CONSTRUCTION_MODULE_ORDER, CONSTRUCTION_MODULES, CONSTRUCTION_ROUTES } from "./wiring-construction.ts";
// </c5:import>
// <nav:import>
import { fichiersModule } from "./routes-fichiers.ts";
// </nav:import>

/**
 * Porte I1 tenue par le code (plan §2.6). Tant qu'elle valait false, le port activation réel répondait comme le port neutre
 * (refus « a-venir ») ; les tests ouvraient l'activation par surcharge de port.
 *
 * BASCULÉE À true au train de la vague 3 de l'itération 2 (20/09/2026), par l'intégrateur, après vérification des conditions
 * du §2.6 : L1c (arrêt), L3 (plancher), L10c (plafonds), L1f (« Arrêter » visible), L12b (bandeau) et L12c (Journal) fusionnés
 * et verts ; scénarios e2e API de l'itération 1 (L7b-1) verts en faux ; revue de l'itération 1 verte le 20/09 (H1), aucun
 * constat haut ouvert. Rien n'est publié pour autant : la publication reste une décision humaine (§7.11).
 */
export const ACTIVATION_OUVERTE = true;

/**
 * Porte de la Salle OMO, tenue par le code (plan 2 bis §2.7, risque n° 16). FAUSSE dans le dépôt, et un test de
 * wiring-11.test.ts échoue si elle vaut true. Tant qu'elle est fausse, même avec COCKPIT_OMO=on :
 * - toutes les routes /api/omo/* répondent 403 « salle-coupee » (routes-omo.ts) et les ports de la salle refusent ;
 * - `omoControl` n'écrit ni battement, ni precheck-ok, ni omo-auth/auth.json (omo-control-module.ts) ;
 * - `instances.omo` reste null : aucun client, aucun processeur, aucune inscription de la salle active.
 * JAMAIS de variable d'environnement pour l'ouvrir : les bancs basculent cette constante dans leur COPIE jetable, jamais dans
 * le dépôt ; la mise en service reste une décision humaine, hors de ce plan (procédure écrite par DOC-OMO).
 */
export const SALLE_OUVERTE = false;

/** Instances servies par une inscription qui n'en déclare aucune : l'instance principale seule (comportement 1.0.x). */
export const INSTANCES_PAR_DEFAUT: InstanceFilter = ["principale"];

/** Ordre d'installation des modules : ceux du cockpit (it1, it2), puis ceux de la salle (OMO_MODULE_NAMES, T3a). */
export const MODULE_ORDER = [
  "pending", // gf5:d11 : table des attentes (D11), installée avant le portillon qui la lit
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
  "omoControl",
  "omoRoom",
  "omoPrecheck",
  "omoActivation",
  "omoStop",
  "omoDetections",
  "omoResponder",
  "omoCaps",
  "fichiers", // nav : avant la construction, que croisements-c5a-v0 garde au bout (GFN)
  ...CONSTRUCTION_MODULE_ORDER, // c5
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
 *
 * UNE SEULE table pour les deux instances (plan 2 bis §4.1.2) : l'ordre de la salle (OMO_ORDRE_PROPOSE) y est fondu en
 * SOUS-SUITE, et celui du cockpit aussi. Chaque inscription ne côtoie à l'exécution que celles de son instance, donc chaque
 * ordre est respecté ; wiring-11.test.ts vérifie les deux sous-suites.
 */
export const STEP_ORDER = {
  hooks: {
    createSession: ["floors"],
    sessionCreated: ["floors"],
    // Salle : omoActivation (jeton et conditions revérifiées) puis omoCaps (garde-fou budgétaire du message de l'utilisateur).
    // <c5:ordre-crochets>
    // `secondReading` est en TÊTE : il ne refuse jamais et ne fait qu'un UPDATE de la ligne que `enforceTurn` vient d'écrire.
    // En queue, un refus antérieur le sautait (`runHooks` s'arrête au premier refus) et la ligne restait mal qualifiée : le
    // composeur basculait alors sur le Relecteur après une seconde lecture qui n'était jamais partie (wiring-construction.ts).
    // </c5:ordre-crochets>
    beforeBilledSend: ["secondReading", "floors", "plans", "activation", "requests", "omoActivation", "omoCaps"], // c5
    beforeOnceRelay: ["taskGuard"],
    // Salle : omoStop (arrêt de la salle, D-2b-30).
    abort: ["stopTree", "omoStop"],
  },
  // gate : permission.replied (réévaluation des refus retenus) ; taskGuard : refus Simple.
  // Salle : gate → omoDetections → omoResponder → facts → omoCaps (les deux modules de la salle s'intercalent avant les faits).
  // <gf5:d11>
  // pending (GF5, D11) : table des attentes de chaque instance, EN TÊTE — tout module qui lit gate.pending pendant un événement voit
  // la table déjà à jour de cet événement (permission.asked, permission.replied, libérations).
  // </gf5:d11>
  derivations: ["pending", "gate", "omoDetections", "omoResponder", "facts", "taskGuard", "delegationWatch", "autonomy", "capWatch", "omoCaps"],
  hub: [
    // <gf5:d11>
    // pending : coupure ou reconnexion du flux de chaque instance → table non fiable (avant la relecture de l'autonomie).
    ["pending", "opencode.connection"],
    ["pending", "omo.connection"],
    // </gf5:d11>
    ["delegationWatch", "usage.updated"],
    ["autonomy", "opencode.connection"],
    ["capWatch", "usage.updated"],
    // Salle : plafonds (usage.updated de la salle) puis détections (usage.updated hors demande).
    ["omoCaps", "usage.updated"],
    ["omoDetections", "usage.updated"],
  ],
  // conversationAutonomy : retour à « demander » ; internalAgents : ensureAll ; capWatch : recover.
  // Salle : omoControl (authentification retirée puis lecture d'état) → omoStop (redémarrage du cockpit, D-2b-29) → omoRoom →
  // omoPrecheck (surveillance de state.json).
  startup: ["conversationAutonomy", "internalAgents", "capWatch", "omoControl", "omoStop", "omoRoom", "omoPrecheck"],
  routes: [
    ["conversations", "stopTree"],
    ["delegations", "taskGuard"],
    ["activity", "facts"],
    ["autonomy", "conversationAutonomy"],
    ["plans", "plans"],
    ["diagnostic-11", "diagnostics"],
    ["fichiers", "fichiers"], // nav : juste avant [construction ×4, omo], rangs que la salle et GF4 figent en fin (GFN)
    ...CONSTRUCTION_ROUTES, // c5
    // Salle : monté en dernier, juste avant le 404 de /api/*.
    ["omo", "omoRoom"],
  ],
} as const satisfies StepOrder;

/** Module « gate » : le portillon est une dépendance (deps.gate) ; son installation est portée par l'objet (L1b). */
const gateModule: Cockpit11Module = {
  name: "gate",
  install(reg, c11) {
    c11.gate?.install?.(reg, c11);
  },
};

// <gf5:d11>
/**
 * Module « pending » (GF5, D11) : la table des attentes est portée par le portillon (une par instance) ; son installation aussi,
 * comme celle du module « gate ». Sans port.
 */
const pendingModule: Cockpit11Module = {
  name: "pending",
  install(reg, c11) {
    c11.gate?.installPending?.(reg, c11);
  },
};
// </gf5:d11>

/** Modules réels, par nom (production : tous ; harnais : ceux que le test déclare). */
export const MODULES: { readonly [N in ModuleName]: Cockpit11Module } = {
  pending: pendingModule, // gf5:d11
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
  // Salle OMO : omoControl branche le service réel de L17b (inerte tant que SALLE_OUVERTE est faux) ; les autres sont des
  // squelettes de T3b, sans comportement, et omoRoom monte le groupe de routes qui refuse 403 « salle-coupee ».
  omoControl: omoControlModule,
  omoRoom: omoRoomModule,
  omoPrecheck: omoPrecheckModule,
  omoActivation: omoActivationModule,
  omoStop: omoStopModule,
  omoDetections: omoDetectionsModule,
  omoResponder: omoResponderModule,
  omoCaps: omoCapsModule,
  fichiers: fichiersModule, // nav
  ...CONSTRUCTION_MODULES, // c5
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
  // Salle coupée : omoControl n'écrit ni ne lit rien ; les routes /api/omo/* refusent 403 « salle-coupee » ; le pré-contrôle et
  // l'activation refusent « salle-coupee » ; l'arrêt de la salle n'est pas disponible.
  omoControl: neutralOmoControl,
  omoRoom: neutralOmoRoom,
  omoPrecheck: neutralOmoPrecheck,
  omoActivation: neutralOmoActivation,
  omoStop: neutralOmoStop,
  omoDetections: neutralOmoDetections,
  omoResponder: neutralOmoResponder,
  omoCaps: neutralOmoCaps,
};

export type RegistrationKind = "hook" | "derivation" | "hub" | "startup" | "routes";

export interface Registration {
  kind: RegistrationKind;
  /** Étape, nom de dérivation, type d'événement, « startup » ou groupe de routes. */
  key: string;
  module: ModuleName;
  /**
   * Instances servies. ABSENT = l'instance principale seule : une inscription de l'itération 1 ou 2 garde exactement la forme
   * qu'elle avait (les listes exhaustives des tests de croisement restent comparables). Les inscriptions de la salle portent
   * `["omo"]`, sauf le démarrage d'omoControl, qui est côté cockpit (`["principale"]`, omo-control-module.ts).
   */
  instances?: InstanceFilter;
}

/** Instances d'une inscription, filtre par défaut appliqué. */
export function instancesOf(registration: Pick<Registration, "instances">): InstanceFilter {
  return registration.instances ?? INSTANCES_PAR_DEFAUT;
}

/** L'inscription sert-elle cette instance ? (absent = principale). */
export function servesInstance(registration: Pick<Registration, "instances">, instance: SessionInstance): boolean {
  return instancesOf(registration).includes(instance);
}

export type HubSubscription = {
  [K in HubEventType]: { type: K; fn: (data: HubEventMap[K]) => void; instances?: InstanceFilter };
}[HubEventType];

export interface Cockpit11Wiring {
  c11: Cockpit11;
  /** Modules installés, dans l'ordre d'installation. */
  modules: readonly ModuleName[];
  /** Toutes les inscriptions, rangées par STEP_ORDER à l'intérieur de chaque nature, les deux instances confondues. */
  registrations: readonly Registration[];
  /** Crochets inscrits, TOUTES instances confondues (une par inscription) : le filtre par instance se fait dans runHooks. */
  hooks: { readonly [S in HookStep]: ReadonlyArray<HookSignatures[S]> };
  derivations: readonly EventDerivation[];
  subscriptions: readonly HubSubscription[];
  startup: ReadonlyArray<() => Promise<void>>;
  routes: ReadonlyArray<(app: Hono) => void>;
  /**
   * Crochets d'une étape, dans l'ordre : la première Response l'emporte (les suivants ne sont pas appelés) ; null = continuer.
   * Seuls les crochets inscrits pour l'instance du contexte sont appelés (`ProxyContext.instance`, absente = principale) : le
   * proxy de l'instance principale n'appelle jamais un crochet de la salle, et inversement.
   */
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
    salleOuverte: SALLE_OUVERTE,
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
    const add = (kind: RegistrationKind, key: string, value: unknown, options?: RegistrationOptions) => {
      if (!open) throw new Error(`wiring-11 : inscription hors de l'installation (${kind} ${key} / ${module.name})`);
      const rank = rankOf(kind, key, module.name);
      if (rank < 0) throw new Error(`wiring-11 : couple non prévu dans STEP_ORDER (${kind} ${key} / ${module.name})`);
      // Filtre par défaut : une inscription qui ne déclare rien ne sert que l'instance principale, et le champ reste ABSENT
      // (une inscription de l'itération 1 ou 2 garde sa forme exacte).
      const instances = options?.instances;
      entries.push({ kind, key, module: module.name, rank, order: entries.length, value, ...(instances === undefined ? {} : { instances }) });
    };
    const reg: Registrar = {
      hook: (step, fn, options) => add("hook", step, fn, options),
      derivation: (derivation) => add("derivation", derivation.name, derivation, { instances: derivation.instances }),
      hub: (type, fn, options) => add("hub", type, { type, fn, ...(options?.instances === undefined ? {} : { instances: options.instances }) }, options),
      startup: (fn, options) => add("startup", "startup", fn, options),
      routes: (group, fn, options) => add("routes", group, fn, options),
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
  const entriesOf = (kind: RegistrationKind, key?: string) => sorted.filter((e) => e.kind === kind && (key === undefined || e.key === key));
  const valuesOf = <T>(kind: RegistrationKind, key?: string) => entriesOf(kind, key).map((e) => e.value as T);
  /** Crochets par étape, avec leurs instances : runHooks n'appelle que ceux de l'instance du contexte. */
  const hookEntries = {
    createSession: entriesOf("hook", "createSession"),
    sessionCreated: entriesOf("hook", "sessionCreated"),
    beforeBilledSend: entriesOf("hook", "beforeBilledSend"),
    beforeOnceRelay: entriesOf("hook", "beforeOnceRelay"),
    abort: entriesOf("hook", "abort"),
  } satisfies { [S in HookStep]: unknown };
  const hooks = {
    createSession: hookEntries.createSession.map((e) => e.value as HookSignatures["createSession"]),
    sessionCreated: hookEntries.sessionCreated.map((e) => e.value as HookSignatures["sessionCreated"]),
    beforeBilledSend: hookEntries.beforeBilledSend.map((e) => e.value as HookSignatures["beforeBilledSend"]),
    beforeOnceRelay: hookEntries.beforeOnceRelay.map((e) => e.value as HookSignatures["beforeOnceRelay"]),
    abort: hookEntries.abort.map((e) => e.value as HookSignatures["abort"]),
  };

  return {
    c11,
    modules: selected.map((m) => m.name),
    registrations: sorted.map(({ kind, key, module, instances }) => ({ kind, key, module, ...(instances === undefined ? {} : { instances }) })),
    hooks,
    derivations: valuesOf<EventDerivation>("derivation"),
    subscriptions: valuesOf<HubSubscription>("hub"),
    startup: valuesOf<() => Promise<void>>("startup"),
    routes: valuesOf<(app: Hono) => void>("routes"),
    async runHooks<S extends HookStep>(step: S, ...args: Parameters<HookSignatures[S]>): Promise<Response | null> {
      // Instance visée : celle du contexte du proxy, absente = principale (proxy 1.0.x de http.ts).
      const instance: SessionInstance = (args[0] as ProxyContext | undefined)?.instance ?? "principale";
      for (const entry of hookEntries[step]) {
        if (!servesInstance(entry, instance)) continue;
        const fn = entry.value as (...a: Parameters<HookSignatures[S]>) => Promise<Response | null>;
        const response = await fn(...args);
        if (response) return response;
      }
      return null;
    },
  };
}
