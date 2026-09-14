// Registre des coûts : un enregistrement par appel de modèle, agrégats mensuels, alertes et garde-fou.
import type { DatabaseSync } from "node:sqlite";
import type { ModelCatalog } from "./catalog.ts";
import { type ChatTurnRow, params } from "./db.ts";
import type { OcAssistantMessage, OcUserMessage } from "./opencode.ts";
import { type ModelPrice, type PricingContext, resolveMessageCost, resolvePrice, roundUsd, usdToCredits } from "./pricing.ts";
import { redactSecrets } from "./redact.ts";
import type { SessionRow } from "./sessions.ts";
import type { SettingsStore } from "./settings.ts";
import type { BudgetGuardError, ChoicesResponse } from "./shared/api-types.ts";
import {
  BUDGET_CONFIRM_TITLE,
  budgetConfirmMessage,
  estimateTaskCost,
  type ModelRef,
  parseModelKey,
  type Run,
  type TaskSize,
  type Tier,
  TIER_IDS,
} from "./shared/assistant-rules.ts";

const DAY_MS = 86_400_000;
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Mois de facturation GitHub : remise à zéro le 1er à 00:00 UTC. */
export function monthKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthBounds(key: string): { start: number; end: number; days: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match || !MONTH_RE.test(key)) throw new RangeError(`Mois invalide : ${key}`);
  const start = Date.UTC(Number(match[1]), Number(match[2]) - 1, 1);
  const end = Date.UTC(Number(match[1]), Number(match[2]), 1);
  return { start, end, days: Math.round((end - start) / DAY_MS) };
}

export interface GuardDecision {
  allowed: boolean;
  code?: "expensive-model" | "budget-exhausted";
  message?: string;
  percent: number;
  outputPricePerM: number | null;
}

export interface UsageSummary {
  month: string;
  isCurrentMonth: boolean;
  startsAt: number;
  endsAt: number;
  generatedAt: number;
  budgetUsd: number;
  spentUsd: number;
  spentCredits: number;
  remainingUsd: number;
  percent: number;
  daysInMonth: number;
  daysElapsed: number;
  dailyBurnUsd: number;
  projectedUsd: number;
  daysUntilExhausted: number | null;
  prompts: number;
  calls: number;
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  byDay: Array<{ day: string; cost: number; calls: number }>;
  byModel: Array<{ providerID: string; modelID: string; cost: number; calls: number; tokensIn: number; tokensOut: number }>;
  byAgent: Array<{ agent: string; cost: number; calls: number }>;
  byPurpose: Array<{ purpose: string; cost: number; calls: number }>;
  byProject: Array<{ directory: string; cost: number; calls: number }>;
  byCategory: Array<{ category: string; cost: number; conversations: number }>;
  bySource: Array<{ source: string; cost: number; calls: number }>;
  topSessions: Array<{ rootId: string; title: string; directory: string; category: string | null; cost: number; calls: number; lastAt: number }>;
  months: string[];
}

export interface BudgetAlert {
  month: string;
  threshold: number;
  percent: number;
  spentUsd: number;
  budgetUsd: number;
}

type Num = number | null;

/** Contexte du texte de confirmation du garde-fou (conception §9.2). */
export interface GuardRunsContext {
  /** Raccourci (sans « / ») ou null. */
  command: string | null;
  modelName: (model: string) => string;
  tierOfModel: (model: string) => Tier | null;
  /** Taille de demande de l'estimation « environ {coût} ». */
  size: TaskSize;
}

/** Coût moyen observé par prompt de chat (sous-agents compris) : `where` est un fragment SQL interne, jamais une entrée. */
const PROMPT_COST_SQL = `SELECT COUNT(DISTINCT p.message_id) AS prompts, COALESCE(SUM(u.cost), 0) AS cost
  FROM prompts p
  JOIN sessions s ON s.id = p.session_id AND s.purpose = 'chat' AND s.parent_id IS NULL
  LEFT JOIN usage u ON u.root_id = p.root_id AND u.created_at >= p.created_at
    AND u.created_at < COALESCE((SELECT MIN(p2.created_at) FROM prompts p2 WHERE p2.root_id = p.root_id AND p2.created_at > p.created_at), 9e15)
  WHERE p.created_at >= ?`;

export class Ledger {
  readonly #db: DatabaseSync;
  readonly #settings: SettingsStore;
  readonly #catalog: ModelCatalog;
  #monthCache: { key: string; total: number } | null = null;

  constructor(deps: { db: DatabaseSync; settings: SettingsStore; catalog: ModelCatalog }) {
    this.#db = deps.db;
    this.#settings = deps.settings;
    this.#catalog = deps.catalog;
  }

  pricingContext(): PricingContext {
    const s = this.#settings.get();
    return { overrides: s.pricing.overrides, catalog: this.#catalog.prices, preferTable: s.pricing.preferTable };
  }

  /** Enregistre (ou met à jour) un appel de modèle. Renvoie true si le coût a changé. */
  recordAssistant(msg: OcAssistantMessage, session: SessionRow): boolean {
    const usage = {
      input: msg.tokens?.input ?? 0,
      output: msg.tokens?.output ?? 0,
      reasoning: msg.tokens?.reasoning ?? 0,
      cacheRead: msg.tokens?.cache?.read ?? 0,
      cacheWrite: msg.tokens?.cache?.write ?? 0,
    };
    const resolved = resolveMessageCost(
      { providerID: msg.providerID, modelID: msg.modelID, reportedCost: msg.cost, usage },
      this.pricingContext(),
    );
    const purpose = session.purpose === "classifier" ? "classifier" : session.parent_id ? "subagent" : "chat";
    const previous = this.#db.prepare("SELECT cost FROM usage WHERE message_id = ?").get(msg.id) as { cost: number } | undefined;
    this.#db
      .prepare(
        `INSERT INTO usage (message_id, session_id, root_id, directory, provider_id, model_id, agent, purpose, parent_message_id,
           created_at, completed_at, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
           cost_reported, cost_estimated, cost, cost_source, error)
         VALUES (:message_id, :session_id, :root_id, :directory, :provider_id, :model_id, :agent, :purpose, :parent_message_id,
           :created_at, :completed_at, :tokens_input, :tokens_output, :tokens_reasoning, :tokens_cache_read, :tokens_cache_write,
           :cost_reported, :cost_estimated, :cost, :cost_source, :error)
         ON CONFLICT(message_id) DO UPDATE SET
           root_id = excluded.root_id, completed_at = excluded.completed_at, agent = excluded.agent, purpose = excluded.purpose,
           tokens_input = excluded.tokens_input, tokens_output = excluded.tokens_output, tokens_reasoning = excluded.tokens_reasoning,
           tokens_cache_read = excluded.tokens_cache_read, tokens_cache_write = excluded.tokens_cache_write,
           cost_reported = excluded.cost_reported, cost_estimated = excluded.cost_estimated, cost = excluded.cost,
           cost_source = excluded.cost_source, error = excluded.error`,
      )
      .run(
        params({
          message_id: msg.id,
          session_id: msg.sessionID,
          root_id: session.root_id,
          directory: session.directory,
          provider_id: msg.providerID,
          model_id: msg.modelID,
          agent: msg.agent ?? "",
          purpose,
          parent_message_id: msg.parentID,
          created_at: msg.time.created,
          completed_at: msg.time.completed,
          tokens_input: usage.input,
          tokens_output: usage.output,
          tokens_reasoning: usage.reasoning,
          tokens_cache_read: usage.cacheRead,
          tokens_cache_write: usage.cacheWrite,
          cost_reported: Number.isFinite(msg.cost) ? msg.cost : 0,
          cost_estimated: resolved.estimated,
          cost: resolved.cost,
          cost_source: resolved.source,
          error: msg.error ? msg.error.data?.message ?? msg.error.name : null,
        }),
      );
    const changed = previous?.cost !== resolved.cost;
    if (changed) this.#monthCache = null;
    return changed;
  }

  recordUser(msg: OcUserMessage, session: SessionRow): void {
    this.#db
      .prepare(
        `INSERT INTO prompts (message_id, session_id, root_id, directory, provider_id, model_id, agent, created_at)
         VALUES (:message_id, :session_id, :root_id, :directory, :provider_id, :model_id, :agent, :created_at)
         ON CONFLICT(message_id) DO UPDATE SET root_id = excluded.root_id`,
      )
      .run(
        params({
          message_id: msg.id,
          session_id: msg.sessionID,
          root_id: session.root_id,
          directory: session.directory,
          provider_id: msg.model?.providerID ?? "",
          model_id: msg.model?.modelID ?? "",
          agent: msg.agent ?? "",
          created_at: msg.time.created,
        }),
      );
  }

  /** Réapplique la tarification (après modification de la grille) sur un mois donné. */
  recompute(month = monthKey(Date.now())): number {
    const { start, end } = monthBounds(month);
    const rows = this.#db
      .prepare(
        `SELECT message_id, provider_id, model_id, cost_reported, tokens_input, tokens_output, tokens_reasoning,
                tokens_cache_read, tokens_cache_write FROM usage WHERE created_at >= ? AND created_at < ?`,
      )
      .all(start, end) as Array<{
      message_id: string;
      provider_id: string;
      model_id: string;
      cost_reported: number;
      tokens_input: number;
      tokens_output: number;
      tokens_reasoning: number;
      tokens_cache_read: number;
      tokens_cache_write: number;
    }>;
    const ctx = this.pricingContext();
    const update = this.#db.prepare("UPDATE usage SET cost = ?, cost_estimated = ?, cost_source = ? WHERE message_id = ?");
    for (const row of rows) {
      const r = resolveMessageCost(
        {
          providerID: row.provider_id,
          modelID: row.model_id,
          reportedCost: row.cost_reported,
          usage: {
            input: row.tokens_input,
            output: row.tokens_output,
            reasoning: row.tokens_reasoning,
            cacheRead: row.tokens_cache_read,
            cacheWrite: row.tokens_cache_write,
          },
        },
        ctx,
      );
      update.run(r.cost, r.estimated, r.source, row.message_id);
    }
    this.#monthCache = null;
    return rows.length;
  }

  monthTotal(key = monthKey(Date.now())): number {
    if (this.#monthCache?.key === key) return this.#monthCache.total;
    const { start, end } = monthBounds(key);
    const row = this.#db
      .prepare("SELECT COALESCE(SUM(cost), 0) AS total FROM usage WHERE created_at >= ? AND created_at < ?")
      .get(start, end) as { total: number };
    this.#monthCache = { key, total: row.total };
    return row.total;
  }

  percentUsed(key = monthKey(Date.now())): number {
    const budget = this.#settings.get().budget.monthlyUsd;
    const spent = this.monthTotal(key);
    if (budget <= 0) return spent > 0 ? Number.POSITIVE_INFINITY : 0;
    return (spent / budget) * 100;
  }

  /** Seuils d'alerte nouvellement franchis ce mois-ci (chacun n'est signalé qu'une fois). */
  checkAlerts(now = Date.now()): BudgetAlert[] {
    const month = monthKey(now);
    const { budget } = this.#settings.get();
    const percent = this.percentUsed(month);
    const spentUsd = this.monthTotal(month);
    const insert = this.#db.prepare("INSERT OR IGNORE INTO budget_alerts (month, threshold, created_at) VALUES (?, ?, ?)");
    const alerts: BudgetAlert[] = [];
    for (const threshold of [...budget.alertThresholds].sort((a, b) => a - b)) {
      if (percent < threshold) break;
      if (insert.run(month, threshold, now).changes > 0) {
        alerts.push({ month, threshold, percent, spentUsd, budgetUsd: budget.monthlyUsd });
      }
    }
    return alerts;
  }

  guard(model: { providerID: string; modelID: string } | undefined, confirmed: boolean): GuardDecision {
    const { guard, monthlyUsd } = this.#settings.get().budget;
    const percent = this.percentUsed();
    const resolved = model ? resolvePrice(model.providerID, model.modelID, this.pricingContext()) : null;
    const outputPricePerM = resolved ? resolved.price.rates.output : null;
    const base = { percent, outputPricePerM };
    if (!guard.enabled || confirmed || !model || outputPricePerM === null || outputPricePerM === 0) {
      return { allowed: true, ...base };
    }
    if (guard.blockAtLimit && percent >= 100) {
      return {
        allowed: false,
        code: "budget-exhausted",
        message: `Budget mensuel atteint (${percent.toFixed(0)} % de ${monthlyUsd} $). Confirmez pour envoyer quand même.`,
        ...base,
      };
    }
    if (percent >= guard.fromPercent && outputPricePerM > guard.maxOutputPricePerM) {
      return {
        allowed: false,
        code: "expensive-model",
        message: `${percent.toFixed(0)} % du budget consommé : ${model.modelID} coûte ${outputPricePerM} $ / M tokens en sortie (seuil ${guard.maxOutputPricePerM} $). Confirmez ou choisissez un modèle moins cher.`,
        ...base,
      };
    }
    return { allowed: true, ...base };
  }

  /**
   * Garde-fou sur tous les appels réellement facturés d'un tour (message, raccourci, travail délégué, reprise) :
   * du plus cher au moins cher (prix de sortie effectif), premier refus de guard(), avec le texte français §9.2.
   */
  guardRuns(runs: Run[], confirmed: boolean, ctx: GuardRunsContext): BudgetGuardError | null {
    if (confirmed || runs.length === 0) return null;
    const pricing = this.pricingContext();
    const priced = runs.map((run) => {
      const ref = parseModelKey(run.model);
      return { run, ref, price: resolvePrice(ref.providerID, ref.modelID, pricing)?.price ?? null };
    });
    const ordered = [...priced].sort((a, b) => (b.price?.rates.output ?? -1) - (a.price?.rates.output ?? -1));
    for (const item of ordered) {
      const decision = this.guard(item.ref, false);
      if (decision.allowed || decision.code === undefined) continue;
      const known = priced.filter((p) => p.price !== null);
      const usd = known.length > 0 ? roundUsd(known.reduce((sum, p) => (p.price ? sum + estimateTaskCost(p.price, ctx.size) : sum), 0)) : null;
      const modelName = ctx.modelName(item.run.model);
      const { message } = budgetConfirmMessage({
        atLimit: decision.code === "budget-exhausted",
        percent: decision.percent,
        spentUsd: this.monthTotal(),
        budgetUsd: this.#settings.get().budget.monthlyUsd,
        modelName,
        tier: ctx.tierOfModel(item.run.model),
        usd,
        command: ctx.command,
      });
      return {
        error: "budget-guard",
        allowed: false,
        code: decision.code,
        title: BUDGET_CONFIRM_TITLE,
        message,
        percent: decision.percent,
        outputPricePerM: decision.outputPricePerM,
        run: item.run,
        modelName,
      };
    }
    return null;
  }

  /** Coût moyen observé par prompt pour un modèle sur 30 jours (sous-agents compris). */
  estimate(providerID: string, modelID: string, now = Date.now()): { price: ModelPrice | null; avgUsd: number | null; samples: number } {
    const since = now - 30 * DAY_MS;
    const row = this.#db
      .prepare(`${PROMPT_COST_SQL} AND p.provider_id = ? AND p.model_id = ?`)
      .get(since, providerID, modelID) as { prompts: number; cost: number };
    const resolved = resolvePrice(providerID, modelID, this.pricingContext());
    return {
      price: resolved?.price ?? null,
      avgUsd: row.prompts > 0 ? row.cost / row.prompts : null,
      samples: row.prompts,
    };
  }

  /** Coût moyen observé par demande d'un agent sur 30 jours (et d'une IA si précisée) : base des estimations « observées ». */
  estimateAgent(agent: string, model?: ModelRef, now = Date.now()): { avgUsd: number | null; samples: number } {
    const since = now - 30 * DAY_MS;
    const row = (
      model
        ? this.#db
            .prepare(`${PROMPT_COST_SQL} AND p.agent = ? AND p.provider_id = ? AND p.model_id = ?`)
            .get(since, agent, model.providerID, model.modelID)
        : this.#db.prepare(`${PROMPT_COST_SQL} AND p.agent = ?`).get(since, agent)
    ) as { prompts: number; cost: number };
    return { avgUsd: row.prompts > 0 ? row.cost / row.prompts : null, samples: row.prompts };
  }

  /** Une ligne par demande relayée : IA et réflexion envoyées, appels facturés prévus. */
  recordChatTurn(row: Omit<ChatTurnRow, "id" | "runs"> & { runs: Run[] }): void {
    this.#db
      .prepare(
        `INSERT INTO chat_turns (session_id, created_at, kind, agent, command, tier, model, variant, runs)
         VALUES (:session_id, :created_at, :kind, :agent, :command, :tier, :model, :variant, :runs)`,
      )
      .run(
        params({
          session_id: row.session_id,
          created_at: row.created_at,
          kind: row.kind,
          agent: row.agent,
          command: row.command,
          tier: row.tier,
          model: row.model,
          variant: row.variant,
          runs: JSON.stringify(row.runs),
        }),
      );
  }

  /** Derniers choix d'une conversation : dernière ligne « message » (jamais un raccourci), sinon null. */
  lastChatChoice(sessionId: string): ChoicesResponse {
    const row = this.#db
      .prepare(
        `SELECT agent, tier, model, variant, created_at FROM chat_turns
         WHERE session_id = ? AND kind = 'message' ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(sessionId) as Pick<ChatTurnRow, "agent" | "tier" | "model" | "variant" | "created_at"> | undefined;
    if (!row) return null;
    const tier = TIER_IDS.find((id) => id === row.tier) ?? null;
    return { agent: row.agent, tier, model: row.model, variant: row.variant, createdAt: row.created_at };
  }

  sessionUsage(rootId: string): {
    cost: number;
    calls: number;
    tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
    byModel: Array<{ providerID: string; modelID: string; cost: number; calls: number }>;
  } {
    const totals = this.#db
      .prepare(
        `SELECT COALESCE(SUM(cost),0) cost, COUNT(*) calls, COALESCE(SUM(tokens_input),0) ti, COALESCE(SUM(tokens_output),0) tout,
                COALESCE(SUM(tokens_reasoning),0) tr, COALESCE(SUM(tokens_cache_read),0) tcr, COALESCE(SUM(tokens_cache_write),0) tcw
         FROM usage WHERE root_id = ?`,
      )
      .get(rootId) as { cost: number; calls: number; ti: number; tout: number; tr: number; tcr: number; tcw: number };
    const byModel = this.#db
      .prepare(
        `SELECT provider_id AS providerID, model_id AS modelID, SUM(cost) AS cost, COUNT(*) AS calls
         FROM usage WHERE root_id = ? GROUP BY provider_id, model_id ORDER BY cost DESC`,
      )
      .all(rootId) as Array<{ providerID: string; modelID: string; cost: number; calls: number }>;
    return {
      cost: totals.cost,
      calls: totals.calls,
      tokens: { input: totals.ti, output: totals.tout, reasoning: totals.tr, cacheRead: totals.tcr, cacheWrite: totals.tcw },
      byModel,
    };
  }

  months(): string[] {
    const rows = this.#db
      .prepare("SELECT DISTINCT strftime('%Y-%m', created_at / 1000, 'unixepoch') AS m FROM usage ORDER BY m DESC")
      .all() as Array<{ m: string }>;
    return rows.map((r) => r.m);
  }

  summary(key = monthKey(Date.now()), now = Date.now()): UsageSummary {
    const { start, end, days } = monthBounds(key);
    const range = { start, end };
    const budgetUsd = this.#settings.get().budget.monthlyUsd;
    const q = <T>(sql: string) => this.#db.prepare(sql).all(range) as T[];
    const one = <T>(sql: string) => this.#db.prepare(sql).get(range) as T;
    const inRange = "u.created_at >= :start AND u.created_at < :end";

    const totals = one<{ cost: number; calls: number; ti: Num; tout: Num; tr: Num; tcr: Num; tcw: Num }>(
      `SELECT COALESCE(SUM(cost),0) cost, COUNT(*) calls, SUM(tokens_input) ti, SUM(tokens_output) tout, SUM(tokens_reasoning) tr,
              SUM(tokens_cache_read) tcr, SUM(tokens_cache_write) tcw FROM usage u WHERE ${inRange}`,
    );
    const prompts = one<{ n: number }>(
      `SELECT COUNT(*) n FROM prompts p JOIN sessions s ON s.id = p.session_id
       WHERE s.purpose = 'chat' AND s.parent_id IS NULL AND p.created_at >= :start AND p.created_at < :end`,
    ).n;

    const dayRows = q<{ day: string; cost: number; calls: number }>(
      `SELECT strftime('%Y-%m-%d', u.created_at / 1000, 'unixepoch') day, SUM(cost) cost, COUNT(*) calls
       FROM usage u WHERE ${inRange} GROUP BY day ORDER BY day`,
    );
    const isCurrentMonth = now >= start && now < end;
    const lastDay = isCurrentMonth ? new Date(now).getUTCDate() : days;
    const byDayMap = new Map(dayRows.map((d) => [d.day, d]));
    const byDay = Array.from({ length: lastDay }, (_, i) => {
      const day = new Date(start + i * DAY_MS).toISOString().slice(0, 10);
      const row = byDayMap.get(day);
      return { day, cost: row?.cost ?? 0, calls: row?.calls ?? 0 };
    });

    const spentUsd = totals.cost;
    const daysElapsed = isCurrentMonth ? Math.max((now - start) / DAY_MS, 0) : now < start ? 0 : days;
    const dailyBurnUsd = daysElapsed > 0 ? spentUsd / Math.max(daysElapsed, 1) : 0;
    const projectedUsd = isCurrentMonth ? spentUsd + dailyBurnUsd * Math.max(days - daysElapsed, 0) : spentUsd;
    const remainingUsd = Math.max(budgetUsd - spentUsd, 0);

    return {
      month: key,
      isCurrentMonth,
      startsAt: start,
      endsAt: end,
      generatedAt: now,
      budgetUsd,
      spentUsd,
      spentCredits: usdToCredits(spentUsd),
      remainingUsd,
      percent: budgetUsd > 0 ? (spentUsd / budgetUsd) * 100 : 0,
      daysInMonth: days,
      daysElapsed,
      dailyBurnUsd,
      projectedUsd,
      daysUntilExhausted: isCurrentMonth && dailyBurnUsd > 0 ? remainingUsd / dailyBurnUsd : null,
      prompts,
      calls: totals.calls,
      tokens: {
        input: totals.ti ?? 0,
        output: totals.tout ?? 0,
        reasoning: totals.tr ?? 0,
        cacheRead: totals.tcr ?? 0,
        cacheWrite: totals.tcw ?? 0,
      },
      byDay,
      byModel: q(
        `SELECT provider_id providerID, model_id modelID, SUM(cost) cost, COUNT(*) calls,
                SUM(tokens_input + tokens_cache_read + tokens_cache_write) tokensIn, SUM(tokens_output + tokens_reasoning) tokensOut
         FROM usage u WHERE ${inRange} GROUP BY provider_id, model_id ORDER BY cost DESC, calls DESC`,
      ),
      byAgent: q(`SELECT agent, SUM(cost) cost, COUNT(*) calls FROM usage u WHERE ${inRange} GROUP BY agent ORDER BY cost DESC`),
      byPurpose: q(`SELECT purpose, SUM(cost) cost, COUNT(*) calls FROM usage u WHERE ${inRange} GROUP BY purpose ORDER BY cost DESC`),
      byProject: q(
        `SELECT directory, SUM(cost) cost, COUNT(*) calls FROM usage u WHERE ${inRange} GROUP BY directory ORDER BY cost DESC LIMIT 20`,
      ),
      byCategory: q(
        `SELECT COALESCE(c.category, 'unclassified') category, SUM(u.cost) cost, COUNT(DISTINCT u.root_id) conversations
         FROM usage u LEFT JOIN conversations c ON c.session_id = u.root_id
         WHERE ${inRange} AND u.purpose != 'classifier' GROUP BY category ORDER BY cost DESC`,
      ),
      bySource: q(`SELECT cost_source source, SUM(cost) cost, COUNT(*) calls FROM usage u WHERE ${inRange} GROUP BY cost_source`),
      topSessions: q(
        `SELECT u.root_id rootId, COALESCE(NULLIF(c.title, ''), s.title, '') title, COALESCE(s.directory, u.directory) directory,
                c.category category, SUM(u.cost) cost, COUNT(*) calls, MAX(u.created_at) lastAt
         FROM usage u LEFT JOIN sessions s ON s.id = u.root_id LEFT JOIN conversations c ON c.session_id = u.root_id
         WHERE ${inRange} AND u.purpose != 'classifier'
         GROUP BY u.root_id ORDER BY cost DESC LIMIT 10`,
      ),
      months: this.months(),
    };
  }

  exportCsv(key: string): string {
    const { start, end } = monthBounds(key);
    const rows = this.#db
      .prepare(
        `SELECT u.created_at, u.root_id, u.session_id, u.directory, u.agent, u.purpose, u.provider_id, u.model_id,
                u.tokens_input, u.tokens_output, u.tokens_reasoning, u.tokens_cache_read, u.tokens_cache_write,
                u.cost, u.cost_source, COALESCE(c.category, '') category, COALESCE(NULLIF(c.title,''), s.title, '') title
         FROM usage u LEFT JOIN sessions s ON s.id = u.root_id LEFT JOIN conversations c ON c.session_id = u.root_id
         WHERE u.created_at >= ? AND u.created_at < ? ORDER BY u.created_at`,
      )
      .all(start, end) as Array<Record<string, string | number | null>>;
    const header = [
      "date_utc", "conversation", "titre", "categorie", "session", "projet", "agent", "usage", "fournisseur", "modele",
      "tokens_entree", "tokens_sortie", "tokens_raisonnement", "cache_lecture", "cache_ecriture", "cout_usd", "credits", "source_cout",
    ];
    const lines = rows.map((r) =>
      [
        new Date(Number(r.created_at)).toISOString(), r.root_id, redactSecrets(String(r.title ?? "")), r.category, r.session_id, r.directory, r.agent, r.purpose,
        r.provider_id, r.model_id, r.tokens_input, r.tokens_output, r.tokens_reasoning, r.tokens_cache_read, r.tokens_cache_write,
        Number(r.cost).toFixed(6), usdToCredits(Number(r.cost)), r.cost_source,
      ]
        .map(csvCell)
        .join(","),
    );
    return `${[header.join(","), ...lines].join("\r\n")}\r\n`;
  }
}

/** Cellule CSV sûre : guillemets échappés et neutralisation des formules (injection CSV dans Excel). */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  // Excel en français sépare les colonnes par « ; » : une formule qui suit un « ; », une tabulation ou un retour à la ligne
  // (éventuellement derrière des espaces ou des guillemets) deviendrait une cellule évaluée à l'ouverture du fichier.
  text = text.replace(/([;\t\r\n][ "]*)([=+\-@])/g, "$1'$2");
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
