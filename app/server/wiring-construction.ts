// Câblage de la construction (itération 5, plan d'exécution it5 §4.4, T5a, D-5-04) : ordre des modules, crochets, routes et
// modules réels de la construction. Ce fichier est la SEULE source des quatre lignes que l'intégrateur du train de vague 0 ajoute
// à wiring-11.ts (`MODULE_ORDER`, `STEP_ORDER.hooks.beforeBilledSend`, `STEP_ORDER.routes`, `MODULES`) : aucun paquet n'édite
// wiring-11.ts ni contracts-11.ts (règle en tête de ces fichiers). `NEUTRAL_PORTS` est inchangé : la construction n'ajoute aucun
// port, donc aucun module de la construction n'a de port neutre, et un module non installé n'a simplement aucune inscription
// (route absente → 404, crochet absent → envoi relayé comme avant).
// Le crochet `secondReading` est le DERNIER de `beforeBilledSend` (D-5-06) : il ne requalifie que la ligne qu'`enforceTurn` vient
// d'écrire, après les planchers, les plans, l'activation et les demandes.
import type { ConstructionModule, ConstructionModuleName, ConstructionRouteGroup } from "./construction-contracts.ts";
import type { HookStep } from "./contracts-11.ts";
import { methodsModule } from "./methods-service.ts";
import { chronologieModule } from "./routes-chronologie.ts";
import { secondReadingModule } from "./second-reading.ts";
import { teamCostsModule } from "./team-costs.ts";

/** Ordre d'installation des modules de la construction, ajouté EN FIN de MODULE_ORDER par l'intégrateur. */
export const CONSTRUCTION_MODULE_ORDER = ["methods", "secondReading", "chronologie", "teamCosts"] as const satisfies readonly ConstructionModuleName[];

/** Crochets de la construction : un seul, en fin de `beforeBilledSend` (Seconde lecture). */
export const CONSTRUCTION_HOOKS = {
  beforeBilledSend: ["secondReading"],
} as const satisfies Partial<Record<HookStep, readonly ConstructionModuleName[]>>;

/** Couples (groupe, module) ajoutés EN FIN de STEP_ORDER.routes : un seul groupe, « construction ». */
export const CONSTRUCTION_ROUTES = [
  ["construction", "methods"],
  ["construction", "secondReading"],
  ["construction", "chronologie"],
  ["construction", "teamCosts"],
] as const satisfies ReadonlyArray<readonly [ConstructionRouteGroup, ConstructionModuleName]>;

/** Modules réels de la construction, par nom ; squelettes inertes tant que leurs paquets (V1, V2) ne sont pas livrés. */
export const CONSTRUCTION_MODULES: { readonly [N in ConstructionModuleName]: ConstructionModule } = {
  methods: methodsModule,
  secondReading: secondReadingModule,
  chronologie: chronologieModule,
  teamCosts: teamCostsModule,
};
