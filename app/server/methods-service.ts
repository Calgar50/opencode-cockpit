// Propriétaire : L44b.
// Module « methods » (itération 5, plan d'exécution it5 fiche L44b, D-5-07 ; conception C §5.4, §14 ; recherche RM §5.2) :
// il monte la seule route des méthodes, `GET /api/methods` → `MethodsResponse`, dans le groupe « construction ».
//
// LECTURE SEULE : aucune écriture, aucun appel à opencode, aucun appel d'IA. L'attachement d'une méthode à un assistant est
// l'affaire d'`assistants.ts` (PUT /api/assistants/:name), derrière la garde de rechargement ; ce module ne fait que dire
// ce que le catalogue propose et ce que les fichiers d'agent contiennent déjà.
//
// Deux vérités, jamais confondues (D-5-07) :
// - le FICHIER d'agent fait foi : `utiliseePar` et `attachee` sont lus par `methodIdsIn` dans le corps des fichiers, donc un
//   bloc ajouté ou retiré à la main dans le Studio se voit tout de suite ;
// - `item_meta` ne sert qu'à savoir QUI est un assistant installé (ligne titrée) et DE QUELLE entrée du catalogue il vient
//   (`catalog_id`), ce qu'un fichier d'agent ne dit pas.
//
// Aucune méthode n'est attachée automatiquement : `conseilleePour` ne fait que conseiller (C §16 n° 5).
// Mode Simple : `sources` est vide (spécification §2.3, §5.4) ; la route est servie dans les DEUX modes.
import type { Hono } from "hono";
import type { ConstructionModule } from "./construction-contracts.ts";
import type { Cockpit11 } from "./contracts-11.ts";
import type { ItemMetaRow } from "./db.ts";
import { METHODS } from "./methods-catalogue.ts";
import { isAdvanced } from "./mode.ts";
import type { SettingsStore } from "./settings.ts";
import { CONSTRUCTION_ROUTE_PATHS } from "./shared/construction-constants.ts";
import type { AssistantRef, MethodsResponse, MethodView } from "./shared/construction-types.ts";
import { METHOD_LIMITS, type Method, methodIdsIn } from "./shared/methods.ts";
import type { StudioService } from "./studio.ts";

/** Les assistants du cockpit sont des agents de portée globale (assistants.ts). */
const GLOBAL = { type: "global" } as const;

export interface MethodsServiceDeps {
  db: Cockpit11["db"];
  settings: Pick<SettingsStore, "get">;
  studio: Pick<StudioService, "list">;
}

/** Assistant installé : sa ligne item_meta (nom, titre, entrée du catalogue) et les méthodes de son FICHIER. */
interface InstalledAssistant {
  name: string;
  title: string;
  catalogId: string | null;
  /** Identifiants lus dans le corps du fichier d'agent, dans l'ordre du fichier (vérité, D-5-07). */
  methodIds: string[];
}

/** Ligne item_meta lue ici : trois colonnes, jamais `SELECT *` (seul ce qui sert est lu). */
type AssistantMetaRow = Pick<ItemMetaRow, "name" | "title" | "catalog_id">;

/**
 * Assistants installés : lignes `item_meta` titrées dont le fichier d'agent existe (même règle que `AssistantService.list`,
 * pour que les deux vues nomment les mêmes assistants). SQL paramétré, jamais de concaténation.
 */
async function installedAssistants(deps: MethodsServiceDeps): Promise<InstalledAssistant[]> {
  const rows = deps.db
    .prepare("SELECT name, title, catalog_id FROM item_meta WHERE kind = ? AND title IS NOT NULL ORDER BY name")
    .all("agents") as unknown as AssistantMetaRow[];
  const files = await deps.studio.list("agents", GLOBAL);
  const bodies = new Map(files.map((file) => [file.name, file.body]));
  return rows.flatMap((row) => {
    const body = bodies.get(row.name);
    if (body === undefined) return [];
    return [{ name: row.name, title: row.title ?? row.name, catalogId: row.catalog_id, methodIds: methodIdsIn(body).map((m) => m.id) }];
  });
}

/** Une méthode, vue par l'interface. `sources` reste vide en mode Simple. */
function methodView(method: Method, installed: readonly InstalledAssistant[], avance: boolean): MethodView {
  const utiliseePar: AssistantRef[] = installed
    .filter((assistant) => assistant.methodIds.includes(method.id))
    .map((assistant) => ({ name: assistant.name, title: assistant.title }));
  // Conseillée pour les assistants du catalogue effectivement INSTALLÉS : un identifiant du catalogue sans assistant installé
  // n'est pas rendu (rien à proposer), et `attachee` dit si le bloc est déjà dans son fichier.
  const conseilleePour = method.suggereePour.flatMap((catalogId) => {
    const assistant = installed.find((candidate) => candidate.catalogId === catalogId);
    return assistant ? [{ name: assistant.name, title: assistant.title, attachee: assistant.methodIds.includes(method.id) }] : [];
  });
  return {
    id: method.id,
    version: method.version,
    titre: method.titre,
    phrase: method.phrase,
    quand: method.quand,
    attention: method.attention,
    kind: method.kind,
    bloc: method.bloc,
    enTete: method.enTete,
    sources: avance ? [...method.sources] : [],
    utiliseePar,
    conseilleePour,
  };
}

/** Catalogue des méthodes et limites, dans l'ordre du catalogue. Lecture seule. */
export async function methodsResponse(deps: MethodsServiceDeps): Promise<MethodsResponse> {
  const installed = await installedAssistants(deps);
  const avance = isAdvanced(deps.settings);
  return {
    methods: METHODS.map((method) => methodView(method, installed, avance)),
    limites: { parAssistant: METHOD_LIMITS.parAssistant, parMessage: METHOD_LIMITS.parMessage, parEtape: METHOD_LIMITS.parEtape },
  };
}

/** `GET /api/methods` (adresse lue dans construction-constants.ts, seule source partagée avec le client d'API). */
export function registerMethodsRoutes(app: Hono, deps: MethodsServiceDeps): void {
  app.get(CONSTRUCTION_ROUTE_PATHS.methodes, async (c) => c.json(await methodsResponse(deps)));
}

export const methodsModule: ConstructionModule = {
  name: "methods",
  install(reg, c11) {
    reg.routes("construction", (app) => registerMethodsRoutes(app, c11));
  },
};
