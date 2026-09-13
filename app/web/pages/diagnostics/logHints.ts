// Détection de problèmes connus dans le journal d'opencode.

export type LogProblemId = "tls" | "network" | "auth" | "config";

const RULES: Array<{ id: LogProblemId; pattern: RegExp }> = [
  { id: "tls", pattern: /SELF_SIGNED_CERT_IN_CHAIN|unable to get local issuer certificate|UNABLE_TO_VERIFY_LEAF_SIGNATURE/i },
  { id: "network", pattern: /ECONNREFUSED|ETIMEDOUT|ENOTFOUND/ },
  { id: "auth", pattern: /ProviderAuthError|\b401\b/ },
  { id: "config", pattern: /ConfigInvalidError/ },
];

export interface LogProblem {
  id: LogProblemId;
  count: number;
  /** Dernière ligne concernée, tronquée (texte brut, jamais interprété). */
  lastLine: string;
}

const MAX_LINE = 280;

export function detectLogProblems(text: string): LogProblem[] {
  if (!text) return [];
  const found = new Map<LogProblemId, LogProblem>();
  for (const line of text.split("\n")) {
    for (const rule of RULES) {
      if (!rule.pattern.test(line)) continue;
      const trimmed = line.trim();
      const excerpt = trimmed.length > MAX_LINE ? `${trimmed.slice(0, MAX_LINE)}…` : trimmed;
      const current = found.get(rule.id);
      found.set(rule.id, { id: rule.id, count: (current?.count ?? 0) + 1, lastLine: excerpt });
    }
  }
  return RULES.map((r) => found.get(r.id)).filter((p): p is LogProblem => p !== undefined);
}
