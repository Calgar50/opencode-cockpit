// Masquage des secrets avant archivage, indexation ou affichage de journaux.
// Défensif : une conversation peut contenir un jeton collé par erreur. Masquage « au mieux » : la liste couvre les formes
// courantes (commandes shell, chaînes de connexion, fichiers de configuration), pas tout secret imaginable.

const MASK = "****";

const RULES: Array<[RegExp, string]> = [
  // Blocs de clé privée PEM et PGP, puis bloc tronqué sans ligne de fin (masqué jusqu'à la fin du texte).
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g, `-----PRIVATE KEY ${MASK}-----`],
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*/g, `-----PRIVATE KEY ${MASK}-----`],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, `gh_${MASK}`],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g, `sk-${MASK}`],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, `AKIA${MASK}`],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, `AIza${MASK}`],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, `xox-${MASK}`],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, `jwt.${MASK}`],
  [/(AccountKey=|SharedAccessKey=)[A-Za-z0-9+/=]{20,}/g, `$1${MASK}`],
  // Jeton de session GitHub Copilot : tid=…;exp=…;…
  [/\btid=[^;\s]+;exp=\d+;[^\s"'`]*/g, `tid=${MASK}`],
  // Signature d'une URL SAS Azure (…&sig=…)
  [/([?&]sig=)[^&\s"'<>]+/gi, `$1${MASK}`],
  // kubeconfig : clé et certificat client encodés
  [/(\bclient-(?:key|certificate)-data\s*:\s*)["']?[A-Za-z0-9+/=]{16,}["']?/g, `$1${MASK}`],
  // schéma://utilisateur:motdepasse@hôte, jusqu'au dernier « @ » avant le chemin (mot de passe contenant « @ »)…
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^\s/]*@/gi, `$1${MASK}@`],
  // … puis mot de passe contenant « / »
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s]+(@)/gi, `$1${MASK}$2`],
  // Oracle : jdbc:oracle:thin:utilisateur/motdepasse@base, sqlplus utilisateur/motdepasse@base
  [/(\b(?:jdbc:[a-z0-9]+(?::[a-z0-9]+)*:|sqlplus\s+(?:-\S+\s+)*)[^/\s:@"']+\/)[^@\s"']+(@)/gi, `$1${MASK}$2`],
  // curl/wget -u utilisateur:motdepasse, --user, --proxy-user
  [/((?:^|\s)(?:-u|-U|--user|--proxy-user)(?:\s+|=)["']?[^\s:"']+:)[^\s"']+/g, `$1${MASK}`],
  // mysql -p suivi du mot de passe collé à l'option, sshpass -p suivi du mot de passe
  [/(\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^\n|;&]*?\s-p)(?=[^\s-])[^\s"']+/g, `$1${MASK}`],
  [/(\bsshpass\s+-p\s*)["']?[^\s"']+["']?/g, `$1${MASK}`],
  // password = "…", DB_PASS=…, pwd=…, api_key: … (toute longueur)
  [
    /((?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|client[_-]?secret|access[_-]?key)["']?\s*[:=]\s*)(["']?)[^\s"',;]+\2/gi,
    `$1$2${MASK}$2`,
  ],
  [/(\bAuthorization\s*:\s*(?:Bearer|Basic|token)\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${MASK}`],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}
