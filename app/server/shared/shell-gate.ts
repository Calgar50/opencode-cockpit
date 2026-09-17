// Porte déterministe des commandes (spécification §4.5, §4.10, décisions n° 6 et 7, F-l, F-m ; plan d'exécution, fiche L8a).
// Entrée : `metadata.command` d'une demande `bash`, texte complet ; jamais `patterns` (opencode n'y met que les nœuds `command` :
// pour `export GIT_CONFIG_COUNT=1 …; git status`, seulement « git status » [M]).
// Sept étapes, dans l'ordre ; la première qui échoue décide :
//   S1 lexique (B01-B05) · S2 tête (C01-C03) · S3 consultation, liste blanche d'options (O01-O05) · S4 interdits par catégorie
//   (attente, IA de contrôle jamais consultée : décisions n° 6 et 7) · S5 dossier de travail et chemins (P01-P03) · S6 git
//   (G04, F-m) · S7 programme non listé (U01 ; « à juger » seulement si l'appelant l'autorise : Autonome avec contrôle par IA).
// Listes blanches d'options reprises de la sonde `autonomy-probe/probe.mjs` (corpus de 116 commandes, 11 automatiques).
// Les codes de règle et le détail sont des DONNÉES (journal du contrôle) : les phrases affichées vivent dans un module de textes.
// Module pur (server/shared) : les faits du disque (realpath, liens, `.git`, texte de `.git/config`) sont fournis par l'appelant
// dans `ShellContext` ; aucun module node, aucun accès à process (test de pureté de core.test.ts).
import { redactSecrets } from "../redact.ts";

// --- Contrat -------------------------------------------------------------------------------------------------------------------

export type ShellVerdictKind = "auto" | "attente" | "a-juger";

export interface ShellVerdict {
  verdict: ShellVerdictKind;
  /** B01…B05, C01…C03, O01…O05, S4-<catégorie>, P01…P03, G04, U01, S7 (programme non listé), A-<commande>. */
  regle: string;
  /** Donnée technique (mot, caractère, clé de configuration), masquée et bornée ; jamais une phrase affichée. */
  detail: string;
}

/** Faits d'un chemin cité par la commande, établis par le serveur (`realpath` sous /workspace), jamais par ce module. */
export interface ShellPathFacts {
  /** Chemin réel égal au dossier de la conversation ou contenu dans lui. */
  inside: boolean;
  /** Un composant du chemin est un lien symbolique dont la cible sort du dossier de la conversation. */
  symlinkOut: boolean;
  /** Facultatif : chemin réel absolu. S'il est fourni, il doit être dans le dossier, et P03 s'applique aussi à lui. */
  real?: string;
}

export interface ShellPaths {
  /**
   * `arg` tel qu'écrit dans la commande (relatif au dossier de la conversation, ou absolu). Un chemin qui n'existe pas se résout
   * par son plus long préfixe existant. null : faits impossibles à établir (lecture refusée, boucle de liens) → attente.
   */
  resolve(arg: string): ShellPathFacts | null;
}

export interface ShellGitFacts {
  /** `.git` est un DOSSIER dans le dossier de la conversation (faux : absent, fichier `gitdir:`, lien). */
  gitIsDirectory: boolean;
  /** Texte de `.git/config` lu par le cockpit ; null si illisible. Jamais d'exécution de git pour l'obtenir. */
  configText: string | null;
}

export interface ShellContext {
  /** Dossier de la conversation, chemin absolu du conteneur. */
  conversationDir: string;
  /**
   * `workdir` de l'appel `bash` (entrée de la partie d'outil), null s'il est absent. La demande d'autorisation ne porte que
   * `metadata.command` (opencode 1.18.30, `tool/shell.ts`) : l'appelant doit lire la partie. Tout dossier de travail autre que
   * celui de la conversation, ou inconnu, met la commande en attente (P02) : chemins relatifs, liens et `.git` seraient ceux d'un
   * autre dossier.
   */
  workdir: string | null;
  paths: ShellPaths;
  git: ShellGitFacts;
  /** Vrai seulement en « Autonome avec contrôle » avec l'IA de contrôle active : S7 donne alors « à juger ». */
  allowJudge: boolean;
}

export interface ShellWord {
  /** Valeur vue par le programme (sans les guillemets simples). */
  value: string;
  /** Mot écrit entre guillemets simples. */
  quoted: boolean;
}

export type TokenizeResult = { ok: true; words: ShellWord[] } | { ok: false; regle: "B01" | "B02" | "B03" | "B04" | "B05"; detail: string };

export const SHELL_MAX_LENGTH = 400;
const DETAIL_MAX = 80;

function bounded(text: string): string {
  return Array.from(redactSecrets(text)).slice(0, DETAIL_MAX).join("");
}

function verdict(kind: ShellVerdictKind, regle: string, detail: string): ShellVerdict {
  return { verdict: kind, regle, detail: bounded(detail) };
}

const attente = (regle: string, detail: string) => verdict("attente", regle, detail);

// --- S1 lexique ----------------------------------------------------------------------------------------------------------------

const QUOTE = "'";
const SAFE_BARE = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._/:@%+,=-");

/**
 * S1 : mots de la commande, ou la règle B qui la refuse. Seuls l'espace, les caractères de SAFE_BARE et les chaînes entre
 * guillemets simples isolées (ni collées à un mot, ni suivies d'autre chose qu'une espace) sont permis : aucune expansion,
 * redirection, substitution ni enchaînement n'est donc possible dans une commande acceptée.
 */
export function tokenizeCommand(text: string): TokenizeResult {
  if (typeof text !== "string") return { ok: false, regle: "B01", detail: "type" };
  if (text.length === 0 || text.length > SHELL_MAX_LENGTH) return { ok: false, regle: "B01", detail: String(text.length) };
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32 || code > 126) return { ok: false, regle: "B02", detail: `U+${code.toString(16).padStart(4, "0")}` };
  }
  const words: ShellWord[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === " ") {
      i++;
      continue;
    }
    if (text[i] === QUOTE) {
      const end = text.indexOf(QUOTE, i + 1);
      if (end < 0) return { ok: false, regle: "B03", detail: bounded(text.slice(i)) };
      if (end + 1 < text.length && text[end + 1] !== " ") return { ok: false, regle: "B04", detail: bounded(text.slice(i, end + 2)) };
      words.push({ value: text.slice(i + 1, end), quoted: true });
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < text.length && text[j] !== " ") {
      const c = text[j] ?? "";
      if (c === QUOTE) return { ok: false, regle: "B04", detail: bounded(text.slice(i, j + 1)) };
      if (!SAFE_BARE.has(c)) return { ok: false, regle: "B05", detail: c };
      j++;
    }
    words.push({ value: text.slice(i, j), quoted: false });
    i = j;
  }
  if (words.length === 0) return { ok: false, regle: "B01", detail: "vide" };
  return { ok: true, words };
}

// --- S3 consultation : listes blanches (probe.mjs) ------------------------------------------------------------------------------

interface OptionSpec {
  /** Lettres d'options courtes, groupables (`-la`). */
  short?: string;
  flags?: readonly string[];
  /** Options suivies d'une valeur (`-n 20`) ; une option de deux caractères accepte aussi la valeur collée (`-n20`). */
  value?: readonly string[];
  /** Options (value ou valueEq) dont la valeur doit être un entier de 1 à 6 chiffres. */
  numeric?: readonly string[];
  /** Options longues à valeur après `=` (`--max-depth=2`). */
  valueEq?: readonly string[];
  /** `-20` accepté (nombre de lignes ou de révisions). */
  numericDash?: boolean;
  /** Rôle des arguments : chemins, motif puis chemins, révisions, révisions ou `révision:chemin`. */
  pos: "paths" | "pattern+paths" | "revs" | "revs+paths" | "pattern+revs+paths";
  minPos?: number;
  maxPos?: number;
}

const SIMPLE_COMMANDS: Readonly<Record<string, OptionSpec>> = {
  pwd: { pos: "paths", maxPos: 0 },
  ls: { short: "alhRtrS1dFi", flags: ["--all", "--long", "--human-readable", "--reverse"], pos: "paths" },
  cat: { short: "nbA", pos: "paths", minPos: 1 },
  head: { short: "q", value: ["-n", "-c"], numeric: ["-n", "-c"], numericDash: true, pos: "paths", minPos: 1 },
  tail: { short: "q", value: ["-n", "-c"], numeric: ["-n", "-c"], numericDash: true, pos: "paths", minPos: 1 },
  wc: { short: "lwcm", pos: "paths", minPos: 1 },
  stat: { pos: "paths", minPos: 1 },
  du: { short: "shc", value: ["-d"], numeric: ["-d", "--max-depth"], valueEq: ["--max-depth"], pos: "paths" },
  grep: {
    short: "inrlLcvwxEFHhosI",
    value: ["-e", "-A", "-B", "-C", "-m"],
    numeric: ["-A", "-B", "-C", "-m"],
    valueEq: ["--include", "--exclude", "--exclude-dir"],
    pos: "pattern+paths",
  },
  rg: {
    short: "inlcwFSH",
    value: ["-e", "-g", "-t", "-A", "-B", "-C", "-m"],
    numeric: ["-A", "-B", "-C", "-m"],
    valueEq: ["--glob", "--type"],
    flags: ["--files"],
    pos: "pattern+paths",
  },
};

const GIT_COMMANDS: Readonly<Record<string, OptionSpec>> = {
  status: {
    flags: ["-s", "--short", "-b", "--branch", "--porcelain", "--porcelain=v1", "--porcelain=v2", "-uno", "-unormal", "--untracked-files=no", "--untracked-files=normal"],
    pos: "paths",
  },
  log: {
    flags: ["--oneline", "--graph", "--decorate", "--reverse", "--first-parent", "--no-merges", "--merges", "--no-color", "--no-ext-diff", "--no-textconv", "--name-only", "--name-status", "--stat", "--shortstat"],
    value: ["-n"],
    numeric: ["-n", "--max-count"],
    numericDash: true,
    valueEq: ["--max-count", "--since", "--until", "--author", "--format", "--pretty", "--date", "--grep"],
    pos: "revs+paths",
  },
  diff: {
    flags: ["--stat", "--shortstat", "--name-only", "--name-status", "--cached", "--staged", "--no-color", "--no-ext-diff", "--no-textconv", "-w", "--ignore-all-space"],
    numeric: ["--unified"],
    valueEq: ["--unified"],
    pos: "revs+paths",
  },
  show: {
    flags: ["--stat", "--shortstat", "--name-only", "--name-status", "--no-color", "--no-ext-diff", "--no-textconv", "--oneline"],
    valueEq: ["--format", "--pretty"],
    pos: "revs+paths",
  },
  "ls-files": { flags: ["-m", "-o", "-c", "--others", "--modified", "--cached", "--exclude-standard"], pos: "paths" },
  "rev-parse": { flags: ["--abbrev-ref", "--show-toplevel", "--short", "--is-inside-work-tree"], pos: "revs" },
  branch: { flags: ["--list", "-a", "-r", "-v", "-vv", "--show-current", "--all", "--remotes"], pos: "paths", maxPos: 0 },
  blame: { flags: ["-w", "-s"], value: ["-L"], pos: "paths", minPos: 1 },
  grep: { flags: ["-n", "-i", "-w", "-l", "-c", "-E", "-F", "-I", "--cached"], value: ["-e"], pos: "pattern+revs+paths" },
};

/** Sous-commandes git de consultation (S3) ; toute autre sous-commande relève de S4 « git ». */
export const GIT_CONSULTATION_SUBCOMMANDS: readonly string[] = Object.freeze(Object.keys(GIT_COMMANDS));

/**
 * Options globales git qui changent le dépôt, la configuration ou les programmes lancés (§4.5 : `-c -C --git-dir --exec-path`,
 * plus `--work-tree` et `--config-env`, de même effet). Dans l'instance principale, TOUTE option placée avant la sous-commande
 * relève déjà de S4 « git » ; cette liste nommée sert aux interdits absolus de la Salle OMO (réservation 6).
 */
export const GIT_GLOBAL_OPTIONS: readonly string[] = Object.freeze(["-c", "-C", "--git-dir", "--exec-path", "--work-tree", "--config-env"]);

/** Expressions de `find` permises et nature de leur valeur (null : sans valeur). */
const FIND_EXPRESSIONS: Readonly<Record<string, "motif" | "type" | "entier" | "taille" | "age" | null>> = {
  "-name": "motif",
  "-iname": "motif",
  "-path": "motif",
  "-ipath": "motif",
  "-type": "type",
  "-maxdepth": "entier",
  "-mindepth": "entier",
  "-size": "taille",
  "-mtime": "age",
  "-mmin": "age",
  "-empty": null,
  "-print": null,
};

const NUMBER = /^[0-9]{1,6}$/;
const FIND_VALUES: Readonly<Record<"motif" | "type" | "entier" | "taille" | "age", RegExp>> = {
  motif: /^/,
  type: /^[fdl]$/,
  entier: NUMBER,
  taille: /^[+-]?[0-9]{1,9}[bcwkMG]?$/,
  age: /^[+-]?[0-9]{1,6}$/,
};

/** Chemin à contrôler en S5 : `path` résolu (P01, P02, P03), ou null pour un contrôle lexical P03 du seul mot. */
interface PathCheck {
  word: string;
  path: string | null;
}

interface ConsultationPlan {
  regle: string;
  paths: PathCheck[];
  git: boolean;
}

function parseOptions(args: readonly ShellWord[], spec: OptionSpec): { flags: Set<string>; positionals: ShellWord[] } | ShellVerdict {
  const flags = new Set<string>();
  const positionals: ShellWord[] = [];
  let endOfOptions = false;
  for (let k = 0; k < args.length; k++) {
    const word = args[k] as ShellWord;
    // Les guillemets ne changent pas ce que reçoit le programme : « '-p' » reste une option.
    const v = word.value;
    if (!endOfOptions && v === "--") {
      endOfOptions = true;
      continue;
    }
    if (endOfOptions || !v.startsWith("-") || v.length === 1) {
      positionals.push(word);
      continue;
    }
    if (spec.flags?.includes(v)) {
      flags.add(v);
      continue;
    }
    const eq = v.indexOf("=");
    if (eq > 0 && spec.valueEq?.includes(v.slice(0, eq))) {
      const name = v.slice(0, eq);
      if (spec.numeric?.includes(name) && !NUMBER.test(v.slice(eq + 1))) return attente("O03", v);
      flags.add(name);
      continue;
    }
    if (spec.value?.includes(v)) {
      const next = args[k + 1];
      if (next === undefined) return attente("O02", v);
      if (spec.numeric?.includes(v) && !NUMBER.test(next.value)) return attente("O03", v);
      flags.add(v);
      k++;
      continue;
    }
    const attached = spec.value?.find((option) => option.length === 2 && v.length > 2 && v.startsWith(option));
    if (attached !== undefined) {
      if (spec.numeric?.includes(attached) && !NUMBER.test(v.slice(2))) return attente("O03", v);
      flags.add(attached);
      continue;
    }
    if (spec.numericDash === true && /^-[0-9]{1,6}$/.test(v)) {
      flags.add("-N");
      continue;
    }
    const short = spec.short;
    if (short !== undefined && /^-[A-Za-z0-9]+$/.test(v) && Array.from(v.slice(1)).every((letter) => short.includes(letter))) {
      for (const letter of v.slice(1)) flags.add(`-${letter}`);
      continue;
    }
    return attente("O01", v);
  }
  return { flags, positionals };
}

function pathsOfPositionals(spec: OptionSpec, flags: Set<string>, positionals: readonly ShellWord[], name: string): PathCheck[] | ShellVerdict {
  if (spec.maxPos !== undefined && positionals.length > spec.maxPos) return attente("O04", name);
  if (spec.minPos !== undefined && positionals.length < spec.minPos) return attente("O05", name);
  if (spec.pos === "revs") return [];
  const patternFirst = (spec.pos === "pattern+paths" || spec.pos === "pattern+revs+paths") && !flags.has("-e") && !flags.has("--files");
  const rest = patternFirst ? positionals.slice(1) : positionals;
  const splitRevision = spec.pos === "revs+paths" || spec.pos === "pattern+revs+paths";
  return rest.map((word) => {
    const colon = splitRevision ? word.value.indexOf(":") : -1;
    return { word: word.value, path: colon >= 0 ? word.value.slice(colon + 1) || "." : word.value };
  });
}

function findPlan(args: readonly ShellWord[]): ConsultationPlan | ShellVerdict {
  const paths: PathCheck[] = [];
  let k = 0;
  while (k < args.length && !(args[k] as ShellWord).value.startsWith("-")) {
    const start = (args[k] as ShellWord).value;
    paths.push({ word: start, path: start });
    k++;
  }
  for (; k < args.length; k++) {
    const expression = (args[k] as ShellWord).value;
    if (!Object.hasOwn(FIND_EXPRESSIONS, expression)) return attente("O01", expression);
    const kind = FIND_EXPRESSIONS[expression];
    if (kind === null || kind === undefined) continue;
    const next = args[k + 1];
    if (next === undefined) return attente("O02", expression);
    if (!FIND_VALUES[kind].test(next.value)) return attente("O03", `${expression} ${next.value}`);
    k++;
  }
  return { regle: "A-find", paths, git: false };
}

/** S3 : null si le programme n'est pas une consultation listée ; sinon le verdict O0x qui la refuse, ou ce qu'il reste à contrôler. */
function consultationPlan(program: string, args: readonly ShellWord[]): ConsultationPlan | ShellVerdict | null {
  if (program === "find") return findPlan(args);
  if (program === "git") {
    const sub = args[0];
    if (sub === undefined || sub.quoted || !Object.hasOwn(GIT_COMMANDS, sub.value)) return null;
    const spec = GIT_COMMANDS[sub.value] as OptionSpec;
    const parsed = parseOptions(args.slice(1), spec);
    if ("verdict" in parsed) return parsed;
    const paths = pathsOfPositionals(spec, parsed.flags, parsed.positionals, `git ${sub.value}`);
    if (!Array.isArray(paths)) return paths;
    return { regle: `A-git-${sub.value}`, paths, git: true };
  }
  if (!Object.hasOwn(SIMPLE_COMMANDS, program)) return null;
  const spec = SIMPLE_COMMANDS[program] as OptionSpec;
  const parsed = parseOptions(args, spec);
  if ("verdict" in parsed) return parsed;
  const paths = pathsOfPositionals(spec, parsed.flags, parsed.positionals, program);
  if (!Array.isArray(paths)) return paths;
  return { regle: `A-${program}`, paths, git: false };
}

// --- S4 interdits --------------------------------------------------------------------------------------------------------------

export type ShellForbiddenCategory = "reseau" | "production" | "code" | "enveloppes" | "suppression" | "editeurs" | "declarations";

/**
 * S4 (§4.5), par catégorie ; « nom* » : tout programme qui commence par « nom ». Chaque liste reprend celle de la spécification,
 * puis des ajouts de même nature (plus strict, jamais plus permissif) : une commande qui exécute du code, touche au réseau ou à la
 * production, enveloppe un autre programme, supprime ou écrase un fichier n'est jamais soumise à l'IA de contrôle (décisions n° 6
 * et 7, phrase « Toujours avec votre accord » du §4.13). La Salle OMO n'applique que « reseau » et « production » (§4.5, Q2).
 */
const S4_SPEC_AND_ADDITIONS = (specification: string, additions: string): readonly string[] =>
  Object.freeze([...specification.split(" "), ...additions.split(" ")]);

export const SHELL_FORBIDDEN: Readonly<Record<ShellForbiddenCategory, readonly string[]>> = Object.freeze({
  reseau: S4_SPEC_AND_ADDITIONS(
    "curl wget nc ncat socat telnet ftp sftp scp ssh rsync openssl gh az aws gcloud",
    "ssh* netcat ping ping6 dig nslookup host whois traceroute tracepath nmap tftp http https xh aria2c lynx w3m links elinks mail mailx " +
      "sendmail mutt smbclient ldapsearch",
  ),
  production: S4_SPEC_AND_ADDITIONS(
    "kubectl oc helm terraform tofu ansible* vault docker podman sqlplus psql mysql mongosh redis-cli",
    "docker-compose nerdctl buildah skopeo crictl ctr minikube kind k9s kubectx kubens eksctl pulumi packer vagrant nomad consul mariadb " +
      "mysqldump mariadb-dump pg_dump pg_dumpall pg_restore mongo mongodump mongorestore influx cqlsh",
  ),
  code: S4_SPEC_AND_ADDITIONS(
    "sh bash zsh dash python* node deno bun ruby perl php pwsh java go cargo npm npx yarn pnpm make cmake mvn gradle dotnet pytest tox",
    "ksh fish csh tcsh busybox nodejs pip* pipx pipenv poetry pdm uv uvx conda mamba hatch nox invoke pre-commit gem bundle bundler rake " +
      "irb composer jest vitest mocha ava playwright cypress tsx ts-node vite webpack rollup esbuild parcel turbo nx lerna eslint lua luajit " +
      "r rscript julia rustc rustup gcc g++ cc c++ clang clang++ ld swift swiftc kotlin kotlinc scala scalac sbt ant bazel ninja meson just " +
      "ghc runghc stack cabal elixir mix erl iex dart flutter zig nim groovy tclsh sqlite3",
  ),
  enveloppes: S4_SPEC_AND_ADDITIONS(
    "env command nice nohup timeout time xargs exec eval source . coproc watch sudo su",
    "builtin setsid stdbuf flock chroot nsenter unshare doas pkexec runuser script expect strace ltrace gdb lldb parallel at batch crontab " +
      "ionice chrt taskset unbuffer trap",
  ),
  suppression: S4_SPEC_AND_ADDITIONS("rm rmdir shred truncate chmod chown chgrp ln dd mkfs", "mkfs* unlink mv cp install rename wipefs chattr setfacl"),
  editeurs: S4_SPEC_AND_ADDITIONS("sed awk ed vi vim nano tee", "gawk mawk nawk ex view nvim emacs pico patch"),
  declarations: S4_SPEC_AND_ADDITIONS("export declare typeset set unset alias", "readonly local unalias shopt ulimit umask hash"),
});

const FORBIDDEN_ORDER: readonly ShellForbiddenCategory[] = ["reseau", "production", "code", "enveloppes", "suppression", "editeurs", "declarations"];

/** Nom sans suffixe de chiffres et de points (`python3.12` → `python`) ; lecture de droite à gauche, sans retour arrière. */
function withoutVersion(name: string): string {
  let start = name.length;
  while (start > 0 && "0123456789.".includes(name[start - 1] ?? "")) start--;
  return name.slice(0, start);
}

/**
 * Catégorie S4 d'un programme, ou null. Casse ignorée ; un suffixe de version est ignoré (`python3.12`, `perl5.36`, `go1.22`).
 * git n'y figure pas : ses sous-commandes et options sont triées par classifyCommand.
 */
export function forbiddenCategory(program: string): ShellForbiddenCategory | null {
  if (typeof program !== "string" || program === "") return null;
  const name = program.toLowerCase();
  const unversioned = withoutVersion(name);
  for (const category of FORBIDDEN_ORDER) {
    for (const entry of SHELL_FORBIDDEN[category]) {
      const matches = entry.endsWith("*") ? name.startsWith(entry.slice(0, -1)) : name === entry || unversioned === entry;
      if (matches) return category;
    }
  }
  return null;
}

// --- S5 chemins ----------------------------------------------------------------------------------------------------------------

export type SensitiveKind = "dossier" | "environnement" | "identifiants" | "cle" | "nom";

const SENSITIVE_DIRS = new Set([".git", ".ssh", ".kube", ".gnupg", ".aws", ".azure", ".docker", "secrets", ".secrets", ".terraform", ".opencode", ".agents", ".claude"]);
const SENSITIVE_EXTENSION = /[.](?:pfx|p12|key|jks|keystore|kdbx|pem|crt|cer|der|p8|gpg|asc|ovpn|tfstate|tfvars)$/;
const SENSITIVE_NAME = /id_rsa|id_dsa|id_ecdsa|id_ed25519|privkey|kubeconfig|credential|secret|passw|token/;
const SENSITIVE_FILES = new Set([".netrc", ".npmrc", ".pypirc", ".pgpass", ".git-credentials", "auth.json", ".envrc", "settings.xml"]);

/**
 * P03, lexical (§4.5) : nature sensible d'un chemin tel qu'écrit, casse ignorée, ou null. Dossiers sensibles et `.env*` (sauf
 * `.env.example`) sur chaque segment ; fichiers d'identifiants, extensions de clés et noms sensibles sur le dernier segment.
 */
export function sensitivePath(arg: string): SensitiveKind | null {
  if (typeof arg !== "string") return null;
  const segments = arg.toLowerCase().split("/").filter((segment) => segment !== "" && segment !== ".");
  const base = segments[segments.length - 1] ?? "";
  if (segments.some((segment) => SENSITIVE_DIRS.has(segment))) return "dossier";
  if (segments.some((segment) => segment.startsWith(".env") && segment !== ".env.example") || base.endsWith(".env")) return "environnement";
  if (SENSITIVE_FILES.has(base)) return "identifiants";
  if (SENSITIVE_EXTENSION.test(base)) return "cle";
  if (SENSITIVE_NAME.test(base)) return "nom";
  return null;
}

/** Dossier absolu sans barre finale (« / » gardé), ou null s'il n'est pas absolu. */
function normalizeDir(dir: unknown): string | null {
  if (typeof dir !== "string" || !dir.startsWith("/")) return null;
  return lexicalResolve("/", dir);
}

/** Résolution lexicale POSIX de `arg` depuis `base` (absolu) : « . » et « .. » appliqués, sans lire le disque. */
function lexicalResolve(base: string, arg: string): string {
  const out: string[] = [];
  for (const segment of (arg.startsWith("/") ? arg : `${base}/${arg}`).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return `/${out.join("/")}`;
}

function relativeInside(dir: string, abs: string): string | null {
  if (abs === dir) return "";
  if (dir === "/") return abs.slice(1);
  return abs.startsWith(`${dir}/`) ? abs.slice(dir.length + 1) : null;
}

const pathLike = (text: string) => text.startsWith(".") || text.startsWith("~") || text.includes("/");

/**
 * Programme non listé : on ignore quels arguments sont des chemins. Sont résolus le mot s'il ressemble à un chemin (§4.5 : « / »,
 * « . » en tête ; ici aussi « ~ »), la valeur après « = », la partie après « : », et, pour une option courte collée à sa valeur
 * (`-o/tmp/x`, `-I../inc`), ce qui suit ses deux caractères ; puis chaque mot passe le contrôle lexical P03.
 */
function genericPathChecks(args: readonly ShellWord[]): PathCheck[] {
  const checks: PathCheck[] = [];
  for (const { value } of args) {
    const candidates = new Set<string>();
    if (value.startsWith("-")) {
      if (!value.startsWith("--") && value.length > 2 && pathLike(value.slice(2))) candidates.add(value.slice(2));
    } else if (pathLike(value)) {
      candidates.add(value);
    }
    for (const separator of ["=", ":"]) {
      const at = value.indexOf(separator);
      if (at >= 0 && pathLike(value.slice(at + 1))) candidates.add(value.slice(at + 1));
    }
    for (const candidate of candidates) checks.push({ word: value, path: candidate });
    checks.push({ word: value, path: null });
  }
  return checks;
}

function resolveFacts(ctx: ShellContext, arg: string): ShellPathFacts | null {
  const resolve = ctx?.paths?.resolve;
  if (typeof resolve !== "function") return null;
  try {
    const facts = resolve.call(ctx.paths, arg);
    return facts !== null && typeof facts === "object" ? facts : null;
  } catch {
    // Faits impossibles à établir : la commande attend, avec la règle P02 (jamais une consultation automatique).
    return null;
  }
}

/** S5, en premier : la commande s'exécute dans le dossier de la conversation (`workdir` absent ou égal à lui). */
function checkWorkdir(ctx: ShellContext): ShellVerdict | null {
  const workdir: unknown = ctx?.workdir;
  if (workdir === null) return null;
  if (typeof workdir !== "string") return attente("P02", "workdir-inconnu");
  const dir = normalizeDir(ctx?.conversationDir);
  if (dir === null || lexicalResolve(dir, workdir) !== dir) return attente("P02", `workdir:${workdir}`);
  return null;
}

function checkPaths(checks: readonly PathCheck[], ctx: ShellContext): ShellVerdict | null {
  for (const { word, path } of checks) {
    if (path === null) {
      const kind = sensitivePath(word);
      if (kind !== null) return attente("P03", `${kind}:${word}`);
      continue;
    }
    if (path.startsWith("~")) return attente("P01", word);
    const dir = normalizeDir(ctx?.conversationDir);
    if (dir === null) return attente("P02", word);
    const relative = relativeInside(dir, lexicalResolve(dir, path));
    if (relative === null) return attente("P02", word);
    const facts = resolveFacts(ctx, path);
    if (facts === null || facts.inside !== true || facts.symlinkOut !== false) return attente("P02", word);
    const lexicalKind = sensitivePath(relative);
    if (lexicalKind !== null) return attente("P03", `${lexicalKind}:${word}`);
    if (facts.real !== undefined) {
      const real = typeof facts.real === "string" && facts.real.startsWith("/") ? relativeInside(dir, lexicalResolve("/", facts.real)) : null;
      if (real === null) return attente("P02", word);
      const realKind = sensitivePath(real);
      if (realKind !== null) return attente("P03", `${realKind}:${word}`);
    }
  }
  return null;
}

// --- S6 git (F-m) --------------------------------------------------------------------------------------------------------------

/** Sections dont toute clé fait lire une autre configuration ou lancer un programme. */
const RISKY_GIT_SECTIONS = new Set(["include", "includeif", "filter", "pager", "submodule"]);
/** Noms de clés (toute section) qui lancent un programme, déplacent le dépôt ou chargent une autre configuration ; et « *command ». */
const RISKY_GIT_NAMES = new Set([
  "fsmonitor",
  "pager",
  "hookspath",
  "worktree",
  "askpass",
  "gitproxy",
  "external",
  "textconv",
  "driver",
  "helper",
  "program",
  "uploadpack",
  "receivepack",
  "promisor",
  "worktreeconfig",
  "partialclone",
]);

const GIT_SECTION_EXTENDED = /^\[([A-Za-z0-9.-]+)[ \t]+"((?:[^"\\]|\\.)*)"\]/;
const GIT_SECTION_SIMPLE = /^\[([A-Za-z0-9.-]+)\]/;
const GIT_KEY = /^([A-Za-z][A-Za-z0-9-]*)[ \t]*(?:$|[=#;])/;
const BOM = String.fromCharCode(0xfeff);

/**
 * S6 (F-m) : clé de `.git/config` qui fait exécuter un programme par une consultation git, ou null. Lecture PRUDENTE, ligne à
 * ligne : tout ce que la lecture ne reconnaît pas (config illisible, ligne inconnue, clé hors section, suite de ligne par « \ »)
 * compte comme un risque ; une ligne de valeur prolongée peut donc être refusée à tort, jamais acceptée à tort.
 */
export function gitConfigRisk(configText: string | null): string | null {
  if (typeof configText !== "string") return "illisible";
  const text = configText.startsWith(BOM) ? configText.slice(1) : configText;
  let section: string | null = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (/\\[ \t]*$/.test(line)) return "suite-de-ligne";
    let rest = line.replace(/^[ \t]+/, "");
    if (rest === "" || rest.startsWith("#") || rest.startsWith(";")) continue;
    if (rest.startsWith("[")) {
      const extended = GIT_SECTION_EXTENDED.exec(rest);
      const header = extended ?? GIT_SECTION_SIMPLE.exec(rest);
      if (header === null) return "section-illisible";
      section = (header[1] ?? "").toLowerCase();
      rest = rest.slice(header[0].length).replace(/^[ \t]+/, "");
      if (rest === "" || rest.startsWith("#") || rest.startsWith(";")) continue;
    }
    const key = GIT_KEY.exec(rest);
    if (key === null || section === null) return "ligne-illisible";
    const name = (key[1] ?? "").toLowerCase();
    const sectionName = section.split(".")[0] ?? section;
    if (RISKY_GIT_SECTIONS.has(sectionName)) return `${section}.${name}`;
    if (RISKY_GIT_NAMES.has(name) || name.endsWith("command")) return `${section}.${name}`;
  }
  return null;
}

// --- S7 non listé --------------------------------------------------------------------------------------------------------------

const NETWORK_TOKENS: ReadonlyArray<readonly [string, RegExp]> = [
  ["url", /:\/\//],
  ["utilisateur-hote", /[^@]@[A-Za-z0-9]/],
  ["ipv4", /(?:[0-9]{1,3}\.){3}[0-9]{1,3}/],
  ["ipv6", /(?:[0-9A-Fa-f]{0,4}:){2,}[0-9A-Fa-f]{0,4}/],
  ["port", /:[0-9]{1,5}(?:$|\/)/],
];

/** U01 : premier mot qui désigne une adresse réseau (URL, utilisateur@hôte, hôte:port, IPv4, IPv6), ou null. */
function networkToken(words: readonly ShellWord[]): string | null {
  for (const { value } of words) {
    for (const [kind, pattern] of NETWORK_TOKENS) if (pattern.test(value)) return `${kind}:${value}`;
  }
  return null;
}

// --- Classement ----------------------------------------------------------------------------------------------------------------

/**
 * Verdict de la porte pour `metadata.command` (texte complet). « auto » : consultation listée dans le dossier de la conversation ;
 * « a-juger » : programme non listé, sans astuce shell, quand `ctx.allowJudge` vaut true ; « attente » sinon. S1 à S6 et U01 ne
 * donnent jamais « a-juger » : l'IA de contrôle n'est pas consultée.
 */
export function classifyCommand(text: string, ctx: ShellContext): ShellVerdict {
  // S1 lexique
  const lexed = tokenizeCommand(text);
  if (!lexed.ok) return attente(lexed.regle, lexed.detail);
  const [head, ...args] = lexed.words as [ShellWord, ...ShellWord[]];

  // S2 tête
  if (head.quoted) return attente("C01", head.value);
  if (head.value.includes("=")) return attente("C02", head.value);
  if (head.value.includes("/")) return attente("C03", head.value);

  // S3 consultation
  const plan = consultationPlan(head.value, args);
  if (plan !== null && "verdict" in plan) return plan;

  // S4 interdits
  if (plan === null) {
    if (head.value === "git") return attente("S4-git", args[0]?.value ?? "");
    const category = forbiddenCategory(head.value);
    if (category !== null) return attente(`S4-${category}`, head.value);
  }

  // S5 chemins
  const workdirVerdict = checkWorkdir(ctx);
  if (workdirVerdict !== null) return workdirVerdict;
  const pathVerdict = checkPaths(plan !== null ? plan.paths : genericPathChecks(args), ctx);
  if (pathVerdict !== null) return pathVerdict;

  // S6 git
  if (plan !== null && plan.git) {
    const git = ctx?.git;
    if (git === null || typeof git !== "object" || git.gitIsDirectory !== true) return attente("G04", "git-pas-un-dossier");
    const risk = gitConfigRisk(typeof git.configText === "string" ? git.configText : null);
    if (risk !== null) return attente("G04", risk);
  }
  if (plan !== null) return verdict("auto", plan.regle, "");

  // S7 non listé
  const network = networkToken(lexed.words);
  if (network !== null) return attente("U01", network);
  return ctx?.allowJudge === true ? verdict("a-juger", "S7", head.value) : attente("S7", head.value);
}

// --- F-l : commandes qu'opencode laisse passer sans demande ---------------------------------------------------------------------

/** Mots qui ouvrent ou ferment une structure : le mot suivant peut encore être un programme. */
const COMPOUND_WORDS = new Set(["!", "{", "}", "if", "then", "elif", "else", "fi", "do", "done", "while", "until"]);
/** Structures non modélisées ici (tests, boucles à liste, aiguillages, fonctions nommées) : réponse prudente « sans demande possible ». */
const UNMODELED_WORDS = new Set(["[[", "[", "for", "select", "case", "function"]);
/** opencode 1.18.30 (`tool/shell.ts`) : ces programmes ne produisent aucun motif, donc aucune demande. */
const CWD_COMMANDS = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"]);
/** tree-sitter-bash : déclarations et `unset` ne sont pas des nœuds `command`. */
const DECLARATION_COMMANDS = new Set(["declare", "typeset", "export", "readonly", "local", "unset", "unsetenv"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;

type ScanOutcome = "commande" | "sans-commande" | "incertain";

interface ScanFrame {
  kind: "substitution" | "backtick" | "subshell" | "parametre";
  outer: { raw: string; expectCommand: boolean; redirectTarget: boolean; inDouble: boolean } | null;
}

/**
 * Cherche un programme qui produirait un motif opencode (nœud `command` hors `cd`). « incertain » dès qu'une structure n'est pas
 * modélisée : l'appelant la traite comme « sans demande possible ».
 */
function scanForCommand(text: string): ScanOutcome {
  let raw = "";
  let inWord = false;
  let expectCommand = true;
  let redirectTarget = false;
  let inDouble = false;
  const stack: ScanFrame[] = [];

  const finishWord = (): ScanOutcome | null => {
    if (!inWord) return null;
    const word = raw;
    raw = "";
    inWord = false;
    if (redirectTarget) {
      redirectTarget = false;
      return null;
    }
    if (!expectCommand || ASSIGNMENT.test(word) || COMPOUND_WORDS.has(word)) return null;
    if (UNMODELED_WORDS.has(word)) return "incertain";
    if (CWD_COMMANDS.has(word) || DECLARATION_COMMANDS.has(word)) {
      expectCommand = false;
      return null;
    }
    return "commande";
  };
  const separator = (): ScanOutcome | null => {
    const outcome = finishWord();
    expectCommand = true;
    redirectTarget = false;
    return outcome;
  };
  const pushScope = (kind: "substitution" | "backtick") => {
    stack.push({ kind, outer: { raw, expectCommand, redirectTarget, inDouble } });
    raw = "";
    inWord = false;
    expectCommand = true;
    redirectTarget = false;
    inDouble = false;
  };
  const popScope = (): ScanOutcome | null => {
    const outcome = finishWord();
    if (outcome !== null) return outcome;
    const frame = stack.pop();
    if (frame === undefined || frame.outer === null || inDouble) return "incertain";
    ({ raw, expectCommand, redirectTarget, inDouble } = frame.outer);
    raw += "_";
    inWord = true;
    return null;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    const next = text[i + 1] ?? "";
    const top = stack[stack.length - 1];
    let outcome: ScanOutcome | null = null;

    if (c === "\\") {
      if (next === "\n" && !inDouble && top?.kind !== "parametre") {
        i++;
        continue;
      }
      raw += c + next;
      inWord = true;
      i++;
      continue;
    }
    if (c === "$" && next === "(") {
      if (text[i + 2] === "(") return "incertain";
      inWord = true;
      pushScope("substitution");
      i++;
      continue;
    }
    if (c === "$" && next === "{") {
      stack.push({ kind: "parametre", outer: null });
      raw += "${";
      inWord = true;
      i++;
      continue;
    }
    if (c === "`") {
      if (top?.kind === "backtick") outcome = popScope();
      else {
        inWord = true;
        pushScope("backtick");
      }
      if (outcome !== null) return outcome;
      continue;
    }

    if (top?.kind === "parametre") {
      if (c === "'" || c === '"') return "incertain";
      if (c === "}") stack.pop();
      raw += c;
      continue;
    }

    if (inDouble) {
      if (c === '"') inDouble = false;
      raw += c;
      continue;
    }

    if (c === "'" || (c === "$" && next === "'")) {
      const open = c === "'" ? i : i + 1;
      let end = open + 1;
      while (end < text.length && text[end] !== "'") end += c === "$" && text[end] === "\\" ? 2 : 1;
      if (end >= text.length) return "incertain";
      raw += text.slice(i, end + 1);
      inWord = true;
      i = end;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      raw += c;
      inWord = true;
      continue;
    }
    if (c === "#" && !inWord) {
      const end = text.indexOf("\n", i);
      if (end < 0) break;
      i = end - 1;
      continue;
    }
    if (c === " " || c === "\t") {
      outcome = finishWord();
    } else if (c === "\n" || c === ";") {
      outcome = separator();
    } else if (c === "&" && next !== ">") {
      outcome = separator();
      if (next === "&") i++;
    } else if (c === "|") {
      outcome = separator();
      if (next === "|" || next === "&") i++;
    } else if (c === "(") {
      if (inWord) {
        // `nom()` : définition de fonction ; tout autre mot collé à « ( » (tableau `x=(a b)`, erreur) n'est pas modélisé.
        const close = text.slice(i + 1).search(/[^ \t]/);
        if (close < 0 || text[i + 1 + close] !== ")") return "incertain";
        raw = "";
        inWord = false;
        expectCommand = true;
        i += 1 + close;
        continue;
      }
      if (next === "(") return "incertain";
      outcome = separator();
      stack.push({ kind: "subshell", outer: null });
    } else if (c === ")") {
      if (top?.kind === "substitution") outcome = popScope();
      else if (top?.kind === "subshell") {
        outcome = finishWord();
        stack.pop();
        expectCommand = false;
        redirectTarget = false;
      } else return "incertain";
    } else if (c === "<" || c === ">" || c === "&") {
      if (inWord && (/^[0-9]+$/.test(raw) || /^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(raw))) {
        raw = "";
        inWord = false;
      } else outcome = finishWord();
      if (outcome !== null) return outcome;
      if ((c === "<" || c === ">") && next === "(") {
        inWord = true;
        pushScope("substitution");
        i++;
        continue;
      }
      if (c === "<" && next === "<") {
        if (text[i + 2] !== "<") return "incertain";
        i += 2;
      } else {
        while (i + 1 < text.length && "<>&|".includes(text[i + 1] ?? "")) i++;
      }
      redirectTarget = true;
      continue;
    } else {
      raw += c;
      inWord = true;
    }
    if (outcome !== null) return outcome;
  }
  // Structure ou guillemet non fermés : bash refuse la commande entière ; « sans commande » suffit (même réponse qu'« incertain »).
  return finishWord() ?? "sans-commande";
}

/**
 * F-l (§4.10) : vrai si opencode a pu exécuter cette commande SANS demande, faute de motif : affectation seule, `declare` et
 * autres déclarations, redirection seule, `cd`, et leurs combinaisons ; vrai aussi, par prudence, pour toute structure que cette
 * lecture ne modélise pas. Faux dès qu'un programme lancé est reconnu (opencode demande alors, pour toute la commande).
 * Sert à « Passé sans contrôle » : partie `bash` terminée sans `permission.asked` pour son `callID` (L10c). Liste ajustée au
 * train selon la mesure F-l de MX2.
 */
export function isNoRequestShellForm(text: string): boolean {
  if (typeof text !== "string") return false;
  return scanForCommand(text) !== "commande";
}
