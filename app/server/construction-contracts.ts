// Contrats serveur de la construction (itération 5, plan d'exécution it5 §4.4, T5a, D-5-04) : noms des modules et groupe de
// routes. Types seulement. Aucun port nouveau : les modules de la construction n'exposent rien aux autres (contracts-11.ts garde
// ses PortName tels quels). Les deux extensions de contracts-11.ts (`ModuleName`, `RouteGroup`) sont posées par l'INTÉGRATEUR du
// train de vague 0, jamais par un paquet : la règle en tête de contracts-11.ts et de wiring-11.ts l'impose (D-5-04). T5a les
// demande par écrit dans son rapport, texte exact compris.
import type { Cockpit11Module } from "./contracts-11.ts";

/** Modules de la construction, dans l'ordre d'installation (wiring-construction.ts). */
export type ConstructionModuleName = "methods" | "secondReading" | "chronologie" | "teamCosts";

/** Groupe de routes de la construction, monté avec les autres groupes 1.1 juste avant le 404 de /api/*. */
export type ConstructionRouteGroup = "construction";

/**
 * Module de la construction : un `Cockpit11Module` dont le nom vient de `ConstructionModuleName`. Tant que l'union `ModuleName`
 * de contracts-11.ts n'a pas reçu `ConstructionModuleName` (ligne posée par l'intégrateur du train de vague 0), un nom de la
 * construction n'est pas encore un `ModuleName` : ce type porte donc le nom à part, sans aucune conversion forcée. Après la pose,
 * `ConstructionModuleName` est un sous-ensemble de `ModuleName` et ce type est exactement `Cockpit11Module` : `CONSTRUCTION_MODULES`
 * entre alors dans `MODULES` sans rien changer ici.
 */
export interface ConstructionModule extends Omit<Cockpit11Module, "name"> {
  readonly name: ConstructionModuleName;
}
