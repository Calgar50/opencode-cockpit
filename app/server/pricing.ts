// Tarification des modèles et calcul du coût d'un appel.
//
// GitHub Copilot facture à l'usage depuis le 2026-06-01 : chaque appel de modèle
// consomme des « crédits IA » (1 crédit = 0,01 USD) calculés sur les tokens.
// opencode lit déjà le coût réellement facturé par GitHub (metadata copilot.totalNanoAiu)
// et le reporte dans `cost` : cette grille sert d'estimation de secours et de devis.

export const PRICING_AS_OF = "2026-09-13";
export const PRICING_SOURCE_URL =
  "https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing";
export const USD_PER_CREDIT = 0.01;

/** Prix en USD par million de tokens. */
export interface PriceRates {
  input: number;
  cachedInput: number;
  /** null : écriture de cache non facturée à part (comptée au prix d'entrée par prudence). */
  cacheWrite: number | null;
  output: number;
}

export interface PriceTier {
  /** Au-delà de ce nombre de tokens d'entrée (cache compris), ces tarifs s'appliquent. */
  aboveInputTokens: number;
  rates: PriceRates;
}

export interface ModelPrice {
  rates: PriceRates;
  tiers?: PriceTier[];
  note?: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

const r = (input: number, cachedInput: number, cacheWrite: number | null, output: number): PriceRates => ({
  input,
  cachedInput,
  cacheWrite,
  output,
});

const PROMO_GEMINI = "Prix promotionnel jusqu'au 2026-12-31";

/** Grille officielle GitHub Copilot, clés = identifiants de modèles côté opencode (provider github-copilot). */
export const COPILOT_PRICES: Readonly<Record<string, ModelPrice>> = {
  "gpt-5-mini": { rates: r(0.25, 0.025, null, 2) },
  "gpt-5.3-codex": { rates: r(1.75, 0.175, null, 14) },
  "gpt-5.4": { rates: r(2.5, 0.25, null, 15), tiers: [{ aboveInputTokens: 272_000, rates: r(5, 0.5, null, 22.5) }] },
  "gpt-5.4-mini": { rates: r(0.75, 0.075, null, 4.5) },
  "gpt-5.4-nano": { rates: r(0.2, 0.02, null, 1.25) },
  "gpt-5.5": { rates: r(5, 0.5, null, 30), tiers: [{ aboveInputTokens: 272_000, rates: r(10, 1, null, 45) }] },
  "gpt-5.6-luna": { rates: r(0.2, 0.02, 0.25, 1.2), tiers: [{ aboveInputTokens: 200_000, rates: r(0.4, 0.04, 0.5, 1.8) }] },
  "gpt-5.6-sol": { rates: r(4, 0.4, 5, 20), tiers: [{ aboveInputTokens: 272_000, rates: r(8, 0.8, 10, 30) }] },
  "gpt-5.6-terra": { rates: r(2, 0.2, 2.5, 12), tiers: [{ aboveInputTokens: 272_000, rates: r(4, 0.4, 5, 18) }] },
  "gpt-6-astra": { rates: r(10, 1, 12.5, 50), tiers: [{ aboveInputTokens: 272_000, rates: r(20, 2, 25, 75) }] },
  "claude-haiku-4.5": { rates: r(1, 0.1, 1.25, 5) },
  "claude-sonnet-4": { rates: r(3, 0.3, 3.75, 15) },
  "claude-sonnet-4.6": { rates: r(3, 0.3, 3.75, 15) },
  "claude-sonnet-5": { rates: r(2, 0.2, 2.5, 10) },
  "claude-opus-4.7": { rates: r(5, 0.5, 6.25, 25) },
  "claude-opus-4.8": { rates: r(5, 0.5, 6.25, 25) },
  "claude-opus-4.8-fast": { rates: r(10, 1, 12.5, 50) },
  "claude-opus-5": { rates: r(5, 0.5, 6.25, 25) },
  "claude-fable-5": { rates: r(10, 1, 12.5, 50) },
  "claude-fable-5.1": { rates: r(10, 0.25, 12.5, 50) },
  "gemini-3.5-flash": { rates: r(1.5, 0.15, null, 9) },
  "gemini-3.6-flash": { rates: r(0.75, 0.075, null, 3.75), note: PROMO_GEMINI },
  "gemini-3.7-flash": { rates: r(0.75, 0.075, null, 3.75), note: PROMO_GEMINI },
  "gemini-3.8-flash": { rates: r(0.75, 0.075, null, 3.75), note: PROMO_GEMINI },
  "mai-code-1.1-flash": { rates: r(0.2, 0.02, null, 1.2) },
  "grok-4.5": { rates: r(2, 0.5, null, 6), tiers: [{ aboveInputTokens: 200_000, rates: r(4, 1, null, 12) }] },
  "grok-4.6": { rates: r(2, 0.5, null, 6), tiers: [{ aboveInputTokens: 200_000, rates: r(4, 1, null, 12) }] },
  "kimi-k2.7-code": { rates: r(0.95, 0.19, null, 4) },
  "kimi-k3": { rates: r(3, 0.3, null, 15) },
};

/** Forme du champ `cost` d'un modèle dans le catalogue opencode (USD / million de tokens). */
export interface CatalogCost {
  input: number;
  output: number;
  cache?: { read: number; write: number };
  tiers?: Array<{ input: number; output: number; cache?: { read: number; write: number }; tier: { type: string; size: number } }>;
}

export function priceFromCatalog(cost: CatalogCost): ModelPrice {
  const rates = r(cost.input, cost.cache?.read ?? cost.input, cost.cache?.write ? cost.cache.write : null, cost.output);
  const tiers = (cost.tiers ?? [])
    .filter((t) => t.tier.type === "context" && Number.isFinite(t.tier.size))
    .map((t) => ({
      aboveInputTokens: t.tier.size,
      rates: r(t.input, t.cache?.read ?? t.input, t.cache?.write ? t.cache.write : null, t.output),
    }));
  return tiers.length > 0 ? { rates, tiers } : { rates };
}

const finite = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);

export function ratesFor(price: ModelPrice, contextTokens: number): PriceRates {
  const tier = (price.tiers ?? [])
    .filter((t) => contextTokens > t.aboveInputTokens)
    .sort((a, b) => b.aboveInputTokens - a.aboveInputTokens)[0];
  return tier ? tier.rates : price.rates;
}

/** Coût en USD d'un appel. Les tokens de raisonnement sont facturés au prix de sortie. */
export function computeCost(usage: TokenUsage, price: ModelPrice): number {
  const input = finite(usage.input);
  const cacheRead = finite(usage.cacheRead);
  const cacheWrite = finite(usage.cacheWrite);
  const rates = ratesFor(price, input + cacheRead + cacheWrite);
  const usd =
    input * rates.input +
    cacheRead * rates.cachedInput +
    cacheWrite * (rates.cacheWrite ?? rates.input) +
    (finite(usage.output) + finite(usage.reasoning)) * rates.output;
  return roundUsd(usd / 1_000_000);
}

export function roundUsd(usd: number): number {
  return Math.round(usd * 1e8) / 1e8;
}

export const usdToCredits = (usd: number): number => Math.round((usd / USD_PER_CREDIT) * 100) / 100;

export type CostSource = "reported" | "override" | "table" | "catalog" | "none";

export interface PricingContext {
  /** Tarifs saisis par l'utilisateur, clé `provider/model`. */
  overrides: Readonly<Record<string, ModelPrice>>;
  /** Tarifs du catalogue opencode, clé `provider/model`. */
  catalog: ReadonlyMap<string, ModelPrice>;
  /** true : ignorer le coût rapporté par opencode et toujours appliquer la grille. */
  preferTable: boolean;
}

export function resolvePrice(
  providerID: string,
  modelID: string,
  ctx: Pick<PricingContext, "overrides" | "catalog">,
): { price: ModelPrice; source: Exclude<CostSource, "reported" | "none"> } | null {
  const key = `${providerID}/${modelID}`;
  const override = ctx.overrides[key];
  if (override) return { price: override, source: "override" };
  if (providerID === "github-copilot") {
    const official = COPILOT_PRICES[modelID];
    if (official) return { price: official, source: "table" };
  }
  const fromCatalog = ctx.catalog.get(key);
  return fromCatalog ? { price: fromCatalog, source: "catalog" } : null;
}

export interface ResolvedCost {
  cost: number;
  estimated: number | null;
  source: CostSource;
}

export function resolveMessageCost(
  msg: { providerID: string; modelID: string; reportedCost: number | null | undefined; usage: TokenUsage },
  ctx: PricingContext,
): ResolvedCost {
  const resolved = resolvePrice(msg.providerID, msg.modelID, ctx);
  const estimated = resolved ? computeCost(msg.usage, resolved.price) : null;
  const reported = finite(msg.reportedCost);
  if (!ctx.preferTable && reported > 0) return { cost: roundUsd(reported), estimated, source: "reported" };
  if (resolved && estimated !== null) return { cost: estimated, estimated, source: resolved.source };
  return { cost: roundUsd(reported), estimated, source: reported > 0 ? "reported" : "none" };
}
