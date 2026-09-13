// Niveaux d'IA (conception 0.2.0 §6) : définitions en vigueur (réglage personnalisé ou recommandation livrée),
// résolution sur le catalogue Copilot de ce poste, prix effectif et vues prêtes à afficher.
import type { ModelCatalog } from "./catalog.ts";
import type { AppEnv } from "./env.ts";
import type { Ledger } from "./ledger.ts";
import { resolvePrice } from "./pricing.ts";
import type { SettingsStore } from "./settings.ts";
import type { IssueLite, TierView } from "./shared/api-types.ts";
import {
  effectiveTiers,
  fallbackText,
  MESSAGES,
  type ModelPrice,
  modelName,
  parseModelKey,
  perRequestText,
  providerOf,
  resolveTier,
  TIER_HELP,
  TIER_IDS,
  TIER_LABELS,
  TIER_STATUS_HELP,
  TIER_STATUS_LABELS,
  type Tier,
  type TierDefs,
  type TierResolution,
  taskCosts,
  tierOfModel as tierOfResolvedModel,
  variantLabel,
} from "./shared/assistant-rules.ts";

export interface TierServiceDeps {
  settings: Pick<SettingsStore, "get">;
  catalog: Pick<ModelCatalog, "loaded" | "lite" | "list">;
  ledger: Pick<Ledger, "pricingContext">;
  env: Pick<AppEnv, "allowedProviders" | "version">;
}

export class TierService {
  readonly #d: TierServiceDeps;

  constructor(deps: TierServiceDeps) {
    this.#d = deps;
  }

  /** Définitions en vigueur : réglage personnalisé, sinon la recommandation livrée (DEFAULT_TIERS). */
  definitions(): TierDefs {
    return effectiveTiers(this.#d.settings.get().ai.tiers);
  }

  source(): "recommandation" | "personnalise" {
    return this.#d.settings.get().ai.tiers === null ? "recommandation" : "personnalise";
  }

  /** « Recommandation livrée avec le cockpit 0.2.0 » ou « Réglage personnalisé ». */
  sourceText(): string {
    return this.source() === "recommandation" ? `Recommandation livrée avec le cockpit ${this.#d.env.version}` : "Réglage personnalisé";
  }

  /** false tant que la liste des IA Copilot n'a jamais été lue : niveaux « non vérifiés », édition bloquée. */
  catalogLoaded(): boolean {
    return this.#d.catalog.loaded;
  }

  resolve(id: Tier): TierResolution {
    return resolveTier(this.definitions()[id], this.#d.catalog.lite(), this.#d.env.allowedProviders);
  }

  /** `defs` absent : définitions en vigueur ; null : recommandation livrée ; objet : définitions à essayer. */
  resolveAll(defs?: TierDefs | null): Record<Tier, TierResolution> {
    const effective = defs === undefined ? this.definitions() : effectiveTiers(defs);
    const catalog = this.#d.catalog.lite();
    const allowed = this.#d.env.allowedProviders;
    return {
      rapide: resolveTier(effective.rapide, catalog, allowed),
      equilibre: resolveTier(effective.equilibre, catalog, allowed),
      expert: resolveTier(effective.expert, catalog, allowed),
    };
  }

  // Les méthodes suivantes sont passées comme fonctions de rappel (describeTurn, garde-fou) : fonctions fléchées.

  /** Niveau dont l'IA résolue est ce modèle (ordre Rapide, Équilibré, Expert), sinon null. */
  readonly tierOfModel = (model: string): Tier | null => tierOfResolvedModel(model, this.resolveAll());

  /** Prix effectif : tarifs personnalisés, puis grille officielle, puis catalogue. */
  readonly priceOf = (model: string): ModelPrice | null => {
    const { providerID, modelID } = parseModelKey(model);
    if (!providerID || !modelID) return null;
    return resolvePrice(providerID, modelID, this.#d.ledger.pricingContext())?.price ?? null;
  };

  /** Prix de sortie effectif au-delà du seuil « cher » du garde-fou budgétaire. */
  readonly isExpensive = (model: string): boolean =>
    (this.priceOf(model)?.rates.output ?? 0) > this.#d.settings.get().budget.guard.maxOutputPricePerM;

  readonly taskCost = (model: string): { S: number; M: number; L: number } | null => taskCosts(this.priceOf(model));

  views(): TierView[] {
    const defs = this.definitions();
    const catalog = this.#d.catalog.lite();
    const allowed = this.#d.env.allowedProviders;
    return TIER_IDS.map((id): TierView => {
      const def = defs[id];
      const res = resolveTier(def, catalog, allowed);
      const planned = def.candidates[0] ?? null;
      const plannedName = planned ? modelName(planned, catalog) : null;
      const name = res.model ? modelName(res.model, catalog) : null;
      const cost = res.model ? this.taskCost(res.model) : null;
      return {
        id,
        label: TIER_LABELS[id],
        help: TIER_HELP[id],
        candidates: [...def.candidates],
        configuredVariant: def.variant,
        plannedModel: planned,
        plannedName,
        model: res.model,
        modelName: name,
        status: res.status,
        statusLabel: TIER_STATUS_LABELS[res.status],
        statusHelp: TIER_STATUS_HELP[res.status],
        variant: res.variant,
        variantLabel: variantLabel(res.variant),
        fallbackText: res.status === "secours" && plannedName && name ? fallbackText(plannedName, name) : null,
        warnings: [...res.warnings],
        taskCost: cost,
        estimateText: cost ? perRequestText(cost.M) : null,
        expensive: res.model ? this.isExpensive(res.model) : false,
      };
    });
  }

  /**
   * Contrôle des fournisseurs d'un réglage de niveaux (COCKPIT_ALLOWED_PROVIDERS). Les candidats absents de ce compte
   * restent acceptés : ce sont des IA de secours pour les collègues.
   */
  validate(tiers: TierDefs): IssueLite[] {
    const issues: IssueLite[] = [];
    for (const id of TIER_IDS) {
      for (const [index, candidate] of (tiers[id]?.candidates ?? []).entries()) {
        if (!this.#d.env.allowedProviders.includes(providerOf(candidate))) {
          issues.push({ path: `tiers.${id}.candidates.${index}`, message: MESSAGES.fournisseurRefuse });
        }
      }
    }
    return issues;
  }
}
