// Formatage français des montants, tokens et dates.

const numberFr = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const smallFr = new Intl.NumberFormat("fr-FR", { maximumSignificantDigits: 2 });
const intFr = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
const compactFr = new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 });

export const USD_PER_CREDIT = 0.01;

/** 12,34 $ ; les très petits montants gardent deux chiffres significatifs (0,0042 $). */
export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value !== 0 && Math.abs(value) < 0.01) return `${smallFr.format(value)} $`;
  return `${numberFr.format(value)} $`;
}

export function formatCredits(usd: number): string {
  return `${intFr.format(Math.round(usd / USD_PER_CREDIT))} crédits`;
}

export function formatInt(value: number): string {
  return intFr.format(value);
}

export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value < 10_000 ? intFr.format(value) : compactFr.format(value);
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "∞ %";
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: value < 10 ? 1 : 0 }).format(value)} %`;
}

export function formatPricePerM(value: number): string {
  if (value === 0) return "gratuit";
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(value)} $/M`;
}

const dateTimeFr = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });
const dayFr = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" });
const monthFr = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });
const timeFr = new Intl.DateTimeFormat("fr-FR", { timeStyle: "short" });

export function formatDateTime(ts: number): string {
  return dateTimeFr.format(ts);
}

export function formatTime(ts: number): string {
  return timeFr.format(ts);
}

/** « 12 sept. » à partir d'une date AAAA-MM-JJ (UTC). */
export function formatDay(day: string): string {
  return dayFr.format(new Date(`${day}T00:00:00Z`));
}

export function monthLabel(month: string): string {
  const label = monthFr.format(new Date(`${month}-01T00:00:00Z`));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function relativeTime(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "hier";
  if (days < 7) return `il y a ${days} j`;
  return dayFr.format(ts);
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0).replace(".", ",")} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} min ${Math.round((ms % 60_000) / 1_000)} s`;
}

export function plural(n: number, one: string, many: string): string {
  return `${formatInt(n)} ${n > 1 ? many : one}`;
}
