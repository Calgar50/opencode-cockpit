// Tableau de bord des coûts GitHub Copilot : budget mensuel, rythme, répartitions, conversations coûteuses.
import { useMemo, useRef, useState } from "react";
import { useApp } from "../app/AppContext.tsx";
import { Icon } from "../components/Icon.tsx";
import { useToast } from "../components/Toast.tsx";
import { Button, Card, CategoryChip, EmptyState, Meter, Spinner, useAsync } from "../components/ui.tsx";
import { api, errorText } from "../lib/api.ts";
import { cockpitEvent, useEvents } from "../lib/events.ts";
import { formatCredits, formatDateTime, formatDay, formatInt, formatPercent, formatTokens, formatUsd, monthLabel, relativeTime } from "../lib/format.ts";
import { routeHref } from "../lib/router.ts";
import { BarList, CumulativeChart, DailySpendChart } from "./costs/charts.tsx";

const PURPOSES: Record<string, string> = {
  chat: "Conversations",
  subagent: "Sous-agents",
  classifier: "Classement automatique",
};

const SOURCES: Record<string, string> = {
  reported: "montant facturé rapporté par GitHub / opencode",
  table: "estimation d'après la grille GitHub",
  override: "tarif personnalisé",
  catalog: "estimation d'après le catalogue opencode",
  none: "non tarifé",
};

function projectName(directory: string, root: string): string {
  const norm = directory.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (norm === base) return "Tout le workspace";
  return norm.startsWith(`${base}/`) ? (norm.slice(base.length + 1).split("/")[0] ?? norm) : norm.split("/").pop() || norm;
}

export function CostsPage() {
  const { boot, categoryById, modelByKey } = useApp();
  const toast = useToast();
  const [month, setMonth] = useState(boot.usage.month);
  const [showTable, setShowTable] = useState(false);
  const summary = useAsync(() => api.usageSummary(month), [month]);
  const reloadTimer = useRef<number | undefined>(undefined);

  useEvents((event) => {
    if (cockpitEvent(event, "usage.updated", "settings.updated", "quota.updated", "stream.reconnected")) {
      window.clearTimeout(reloadTimer.current);
      reloadTimer.current = window.setTimeout(() => summary.reload(), 1_500);
    }
  });

  const s = summary.data;
  const months = useMemo(() => [...new Set([boot.usage.month, month, ...(s?.months ?? [])])].sort().reverse(), [boot.usage.month, month, s?.months]);

  if (!s) {
    return (
      <div className="page">
        {summary.error ? (
          <EmptyState icon="alert" title="Coûts indisponibles" action={<Button onClick={summary.reload}>Réessayer</Button>}>
            {errorText(summary.error)}
          </EmptyState>
        ) : (
          <div className="empty">
            <Spinner large />
          </div>
        )}
      </div>
    );
  }

  const dailyBudget = s.budgetUsd > 0 ? s.budgetUsd / s.daysInMonth : 0;
  const reportedShare = s.spentUsd > 0 ? ((s.bySource.find((b) => b.source === "reported")?.cost ?? 0) / s.spentUsd) * 100 : 0;
  const overBudgetProjection = s.isCurrentMonth && s.budgetUsd > 0 && s.projectedUsd > s.budgetUsd;
  const exhaustionDay =
    s.isCurrentMonth && s.daysUntilExhausted !== null && s.daysElapsed + s.daysUntilExhausted < s.daysInMonth
      ? new Date(s.startsAt + (s.daysElapsed + s.daysUntilExhausted) * 86_400_000)
      : null;
  const quota = s.quota;

  const recompute = async () => {
    try {
      const result = await api.recompute(month);
      toast.success("Coûts recalculés", `${formatInt(result.updated)} appels réévalués avec la grille actuelle.`);
      summary.reload();
    } catch (err) {
      toast.error("Recalcul impossible", err);
    }
  };

  return (
    <div className="page">
      <div className="page-narrow stack loose" style={{ opacity: summary.loading ? 0.65 : 1, transition: "opacity .2s" }}>
        <div className="page-header" style={{ marginBottom: 0 }}>
          <div className="spacer">
            <h1>Coûts GitHub Copilot</h1>
            <p>
              Facturation au token en crédits IA (1 crédit = 0,01 $), remise à zéro le 1er de chaque mois à 00:00 UTC.
            </p>
          </div>
          <select className="select" style={{ width: "auto" }} value={month} aria-label="Mois" onChange={(e) => setMonth(e.target.value)}>
            {months.map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </select>
          <a className="btn" href={api.usageExportUrl(month)} download>
            <Icon name="download" />
            Export CSV
          </a>
          <Button variant="ghost" icon="refresh" onClick={() => void recompute()} title="Réappliquer la grille tarifaire actuelle">
            Recalculer
          </Button>
        </div>

        <section className="card" aria-label="Budget du mois">
          <div className="grid-2" style={{ alignItems: "center" }}>
            <div className="stack tight">
              <span className="secondary small">Dépensé en {monthLabel(s.month).toLowerCase()}</span>
              <span className="hero-figure">{formatUsd(s.spentUsd)}</span>
              <span className="muted small">
                {formatCredits(s.spentUsd)} · budget {formatUsd(s.budgetUsd)}
              </span>
            </div>
            <div className="stack">
              <div className="row between">
                <strong>{formatPercent(s.percent)} du budget</strong>
                <span className="small muted">reste {formatUsd(s.remainingUsd)}</span>
              </div>
              <Meter percent={s.percent} large label="Part du budget mensuel consommée" />
              {s.isCurrentMonth ? (
                <div className={`callout ${overBudgetProjection ? "warning" : "good"}`}>
                  <Icon name={overBudgetProjection ? "alert" : "check"} size={16} />
                  <span>
                    Projection fin de mois : <strong>{formatUsd(s.projectedUsd)}</strong>
                    {overBudgetProjection && exhaustionDay
                      ? `. Au rythme actuel, le budget sera épuisé vers le ${exhaustionDay.toLocaleDateString("fr-FR", { day: "numeric", month: "long", timeZone: "UTC" })}.`
                      : overBudgetProjection
                        ? " : au-dessus du budget."
                        : " : dans le budget."}
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        </section>

        <div className="grid-4">
          <div className="stat-tile">
            <span className="label">Rythme quotidien</span>
            <span className="value">{formatUsd(s.dailyBurnUsd)}</span>
            <span className="sub">budget : {formatUsd(dailyBudget)} / jour</span>
          </div>
          <div className="stat-tile">
            <span className="label">Demandes</span>
            <span className="value">{formatInt(s.prompts)}</span>
            <span className="sub">{formatInt(s.calls)} appels de modèle</span>
          </div>
          <div className="stat-tile">
            <span className="label">Coût moyen par demande</span>
            <span className="value">{s.prompts > 0 ? formatUsd(s.spentUsd / s.prompts) : "—"}</span>
            <span className="sub">sous-agents compris</span>
          </div>
          <div className="stat-tile">
            <span className="label">Tokens</span>
            <span className="value">{formatTokens(s.tokens.input + s.tokens.cacheRead + s.tokens.cacheWrite)}</span>
            <span className="sub">
              en entrée ({formatTokens(s.tokens.cacheRead)} en cache) · {formatTokens(s.tokens.output + s.tokens.reasoning)} en sortie
            </span>
          </div>
        </div>

        {quota ? (
          <div className="callout accent">
            <Icon name="shield" size={16} />
            <span>
              Solde lu chez GitHub {relativeTime(quota.takenAt)} :{" "}
              {quota.unlimited
                ? "illimité"
                : `${formatInt(quota.remaining ?? 0)} restants sur ${formatInt(quota.entitlement ?? 0)} (${formatPercent(quota.percentRemaining ?? 0)})`}
              . Unités non documentées par GitHub : comparez avec la page « Copilot settings › Usage ».
            </span>
          </div>
        ) : null}

        <div className="grid-2">
          <Card title="Dépense par jour" subtitle="Montant du jour (UTC) comparé au rythme qui épuiserait le budget en fin de mois">
            <DailySpendChart days={s.byDay} daysInMonth={s.daysInMonth} dailyBudget={dailyBudget} />
          </Card>
          <Card title="Cumul du mois" subtitle={s.isCurrentMonth ? "Trajectoire, projection et budget" : "Trajectoire et budget"}>
            <CumulativeChart
              days={s.byDay}
              daysInMonth={s.daysInMonth}
              budget={s.budgetUsd}
              projected={s.projectedUsd}
              showProjection={s.isCurrentMonth}
            />
          </Card>
        </div>

        <div className="grid-2">
          <Card title="Par modèle">
            <BarList
              items={s.byModel.map((m) => ({
                key: `${m.providerID}/${m.modelID}`,
                label: modelByKey(`${m.providerID}/${m.modelID}`)?.name ?? m.modelID,
                value: m.cost,
                detail: `${formatInt(m.calls)} appels`,
              }))}
            />
          </Card>
          <Card title="Par catégorie de conversation">
            <BarList
              items={s.byCategory.map((c) => {
                const category = categoryById(c.category);
                return {
                  key: c.category,
                  label: category ? `${category.emoji} ${category.label}` : c.category === "unclassified" ? "Pas encore classée" : c.category,
                  value: c.cost,
                  detail: `${formatInt(c.conversations)} conv.`,
                };
              })}
            />
          </Card>
          <Card title="Par agent">
            <BarList items={s.byAgent.map((a) => ({ key: a.agent || "(inconnu)", label: a.agent || "(inconnu)", value: a.cost, detail: `${formatInt(a.calls)} appels` }))} />
          </Card>
          <Card title="Par projet">
            <BarList
              items={s.byProject.map((p) => ({
                key: p.directory,
                label: projectName(p.directory, boot.workspace.root),
                value: p.cost,
                detail: `${formatInt(p.calls)} appels`,
              }))}
            />
          </Card>
        </div>

        <Card title="Conversations les plus coûteuses" flush>
          {s.topSessions.length === 0 ? (
            <p className="small muted" style={{ padding: 16 }}>
              Aucune conversation ce mois-ci.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Conversation</th>
                    <th>Catégorie</th>
                    <th>Projet</th>
                    <th className="num">Appels</th>
                    <th className="num">Coût</th>
                    <th>Dernière activité</th>
                  </tr>
                </thead>
                <tbody>
                  {s.topSessions.map((t) => (
                    <tr key={t.rootId}>
                      <td style={{ maxWidth: 320 }}>
                        <a className="ellipsis" style={{ display: "block" }} href={routeHref("chat", t.rootId)}>
                          {t.title || "Sans titre"}
                        </a>
                      </td>
                      <td>{t.category ? <CategoryChip category={categoryById(t.category)} fallback={t.category} /> : <span className="muted small">—</span>}</td>
                      <td className="small">{projectName(t.directory, boot.workspace.root)}</td>
                      <td className="num">{formatInt(t.calls)}</td>
                      <td className="num">
                        <strong>{formatUsd(t.cost)}</strong>
                      </td>
                      <td className="small muted nowrap">{formatDateTime(t.lastAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="grid-2">
          <Card title="Par usage">
            <BarList items={s.byPurpose.map((p) => ({ key: p.purpose, label: PURPOSES[p.purpose] ?? p.purpose, value: p.cost, detail: `${formatInt(p.calls)} appels` }))} />
          </Card>
          <Card title="Fiabilité des montants">
            <div className="stack tight">
              <p className="small secondary">
                {s.spentUsd > 0
                  ? `${formatPercent(reportedShare)} du montant provient du coût facturé rapporté par GitHub ; le reste est estimé avec la grille tarifaire (relevé du ${boot.pricing.asOf}).`
                  : "Aucune dépense enregistrée pour ce mois."}
              </p>
              <dl className="kv">
                {s.bySource.map((b) => (
                  <div key={b.source} style={{ display: "contents" }}>
                    <dt>{SOURCES[b.source] ?? b.source}</dt>
                    <dd>{formatUsd(b.cost)}</dd>
                  </div>
                ))}
              </dl>
              <a className="small" href={routeHref("parametres", "tarifs")}>
                Voir ou ajuster la grille tarifaire
              </a>
            </div>
          </Card>
        </div>

        <div className="stack tight">
          <Button variant="ghost" size="sm" icon={showTable ? "chevronDown" : "chevronRight"} onClick={() => setShowTable((v) => !v)}>
            {showTable ? "Masquer" : "Afficher"} les données jour par jour
          </Button>
          {showTable ? (
            <Card flush>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Jour (UTC)</th>
                      <th className="num">Appels</th>
                      <th className="num">Dépense</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.byDay.map((d) => (
                      <tr key={d.day}>
                        <td>{formatDay(d.day)}</td>
                        <td className="num">{formatInt(d.calls)}</td>
                        <td className="num">{formatUsd(d.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
