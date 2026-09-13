// Masquage des secrets avant archivage, indexation ou affichage de journaux.
// Défensif : une conversation peut contenir un jeton collé par erreur.

const MASK = "****";

const RULES: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, `-----PRIVATE KEY ${MASK}-----`],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, `gh_${MASK}`],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g, `sk-${MASK}`],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, `AKIA${MASK}`],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, `AIza${MASK}`],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, `xox-${MASK}`],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, `jwt.${MASK}`],
  [/(AccountKey=|SharedAccessKey=)[A-Za-z0-9+/=]{20,}/g, `$1${MASK}`],
  // schéma://utilisateur:motdepasse@hôte
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s]+(@)/gi, `$1${MASK}$2`],
  // password = "…", api_key: …, Authorization: Bearer …
  [
    /((?:password|passwd|pwd|secret|token|api[_-]?key|client[_-]?secret|access[_-]?key)["']?\s*[:=]\s*)(["']?)[^\s"',;]{6,}\2/gi,
    `$1$2${MASK}$2`,
  ],
  [/(\bAuthorization\s*:\s*(?:Bearer|Basic|token)\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${MASK}`],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}
