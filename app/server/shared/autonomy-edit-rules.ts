// Politique « modification » (`edit`, `write`, `apply_patch`) : règles E1 à E6 (spécification §4.4 et matrice §4.1 ; plan
// d'exécution, fiche L9a et report des mesures §3.5 ; mesure MX1 §3, F-o). Rend des CODES de règle seulement : les phrases sont
// écrites dans autonomy-texts.ts et classifyEdit est réexporté par autonomy-rules.ts (tous deux paquet L9b).
//
// Ordre figé, la première règle qui échoue décide : E6 → E1 → E2 → E3 → E4 → E5. E6, E1, E2, E3 et E4 → attente ; E5 → retour à
// « Demander à chaque fois ». Aucune règle ne rend de refus (§4.3 : l'autonomie n'envoie jamais de refus).
//
// Formes mesurées sur opencode 1.18.30 (MX1 §3, fixtures/mx1-mesures.json). La permission s'appelle « edit » pour les trois
// outils et la demande ne nomme pas l'outil : la forme se lit à la présence de `metadata.files`.
// - edit, write : metadata {filepath absolu, diff}. write ne signale pas un fichier existant : le vidage se lit dans le diff.
// - apply_patch : metadata {filepath, diff, files[]}. `filepath` joint par « , » les chemins SOURCES relatifs au worktree : il
//   n'est jamais lu ici. files[] = {filePath absolu, relativePath, type add|update|delete|move, patch, additions, deletions,
//   movePath absolu si déplacement}. La destination d'un déplacement n'est ni dans `patterns` ni dans `filepath`, seulement dans
//   files[].movePath. files[].deletions d'une suppression vaut lignes + 1 : jamais utilisé comme compte.
// - diff : createTwoFilesPatch (bibliothèque diff) puis trimDiff (tool/edit.ts:646) : en-têtes « Index: », « ==== », « --- »,
//   « +++ », puis des blocs « @@ » à 4 lignes de contexte. Le nombre total de lignes d'un grand fichier n'est donc connu que par
//   une borne inférieure (fin du dernier bloc) : le taux de lignes retirées est majoré, jamais minoré (côté prudent).
//
// Module pur (server/shared), sans module node ni accès au processus : les faits du disque (realpath, liens, dossier permis,
// fichiers déjà comptés) sont relevés par le serveur (L10b, collectEditFacts) et arrivent dans EditFacts.
import { KEY_FILE_READ_RULES, wildcardMatch } from "./assistant-rules.ts";

// --- Chemins protégés (E2) ------------------------------------------------------------------------------------------------------

/** Motifs de fichiers de clés et de `.env` : entrées `deny` et `ask` de KEY_FILE_READ_RULES (l'entrée `allow` est écartée). */
export const KEY_FILE_GLOBS: readonly string[] = Object.freeze(
  Object.entries(KEY_FILE_READ_RULES)
    .filter(([, action]) => action !== "allow")
    .map(([glob]) => glob),
);

/**
 * Liste E2 exacte (§4.4), dans l'ordre de la spécification, puis « fichiers de clés » (KEY_FILE_GLOBS).
 * Lecture (isProtectedPath) : « X/** » désigne le dossier X lui-même et tout ce qu'il contient ; un motif sans « / » vaut pour
 * n'importe quel segment du chemin, à toute profondeur ; un motif avec « / » (seul `*.kube/config`) est comparé à chaque début
 * du chemin, son `*` de tête couvrant les dossiers parents.
 * Casse ignorée : un dossier monté depuis Windows ne distingue pas `.GITHUB` de `.github`.
 */
export const PROTECTED_GLOBS: readonly string[] = Object.freeze([
  ".git/**",
  ".gitmodules",
  ".gitattributes",
  ".opencode/**",
  "opencode.json*",
  "AGENTS.md",
  "CLAUDE.md",
  ".github/**",
  ".gitlab-ci.yml",
  "Jenkinsfile",
  "azure-pipelines*.yml",
  ".vscode/**",
  ".idea/**",
  ".devcontainer/**",
  ".husky/**",
  ".pre-commit-config.yaml",
  ".npmrc",
  ".yarnrc*",
  "pip.conf",
  ".pypirc",
  "settings.xml",
  "Dockerfile*",
  "docker-compose*.y*ml",
  "*.tf",
  "*.tfvars",
  "*.hcl",
  "helm/**",
  "k8s/**",
  "kustomization.y*ml",
  "ansible/**",
  ".env*",
  ...KEY_FILE_GLOBS,
]);

/** Chemin plus long (en caractères) ou plus profond (en segments) : illisible, donc traité comme protégé. */
export const PATH_MAX_CHARS = 4_096;
export const PATH_MAX_SEGMENTS = 64;

interface CompiledGlob {
  glob: string;
  /** Motif sans « / » : comparé à chaque segment ; sinon à chaque préfixe du chemin. */
  perSegment: boolean;
}

const COMPILED_GLOBS: readonly CompiledGlob[] = PROTECTED_GLOBS.map((raw) => {
  const glob = raw.endsWith("/**") ? raw.slice(0, -3) : raw;
  return { glob, perSegment: !glob.includes("/") };
});

/** wildcardMatch d'opencode, casse ignorée (`*` traverse « / »). */
function wildcardMatchCi(input: string, glob: string): boolean {
  return wildcardMatch(input, glob, true);
}

function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/**
 * Nom court 8.3 possible (« GITHUB~1 », « AGENTS~1.MD ») : un volume Windows monté peut le résoudre vers un nom long protégé que
 * ni le chemin demandé ni realpath ne montrent. Impossible de savoir lequel : traité comme protégé.
 */
function mayBeShortName(segment: string): boolean {
  return segment.length <= 12 && /~[0-9]/.test(segment);
}

/**
 * Vrai si le chemin relève de la liste E2. Accepte un chemin absolu ou relatif, avec « / » ou « \ » : tous ses segments sont
 * examinés (le serveur passe le chemin demandé ET le chemin résolu). Chemin vide, trop long, trop profond, avec un caractère de
 * contrôle ou un nom court 8.3 possible : vrai (illisible, donc jamais automatique).
 */
export function isProtectedPath(path: string): boolean {
  if (typeof path !== "string" || path.length > PATH_MAX_CHARS || hasControlCharacter(path)) return true;
  const segments = path
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.length > PATH_MAX_SEGMENTS) return true;
  if (segments.some(mayBeShortName)) return true;
  for (let end = 0; end < segments.length; end++) {
    const segment = segments[end] ?? "";
    const prefix = segments.slice(0, end + 1).join("/");
    for (const { glob, perSegment } of COMPILED_GLOBS) {
      if (wildcardMatchCi(perSegment ? segment : prefix, glob)) return true;
    }
  }
  return false;
}

// --- Métadonnées d'une demande (formes MX1) -------------------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Propriété propre seulement : une clé héritée du prototype n'est jamais lue. */
function own(record: JsonRecord, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * E3 : vrai si une demande apply_patch supprime ou déplace un fichier (`files[].type` delete ou move, ou `movePath` présent).
 * Prudence : `files` qui n'est pas un tableau, entrée qui n'est pas un objet ou type inconnu → vrai. Forme edit/write (sans
 * `files`) → faux : le vidage s'y lit dans le diff (diffRemovalRatio).
 */
export function applyPatchDeletesOrMoves(metadata: unknown): boolean {
  if (!isRecord(metadata)) return false;
  const files = own(metadata, "files");
  if (files === undefined) return false;
  if (!Array.isArray(files)) return true;
  return files.some((file) => {
    if (!isRecord(file) || own(file, "movePath") !== undefined) return true;
    const type = own(file, "type");
    return type !== "add" && type !== "update";
  });
}

/**
 * E3, E4 : diffs d'une demande. edit/write : [metadata.diff] ; apply_patch : files[].patch, un par fichier (jamais le
 * `metadata.diff` concaténé). null : diff absent ou qui n'est pas une chaîne. apply_patch sans fichier → [] (E4 : attente).
 */
export function editDiffs(metadata: unknown): Array<string | null> {
  if (!isRecord(metadata)) return [null];
  const files = own(metadata, "files");
  if (files === undefined) {
    const diff = own(metadata, "diff");
    return [typeof diff === "string" ? diff : null];
  }
  if (!Array.isArray(files)) return [null];
  return files.map((file) => {
    const patch = isRecord(file) ? own(file, "patch") : undefined;
    return typeof patch === "string" ? patch : null;
  });
}

/** Chemin absolu tel qu'opencode le présente dans ses métadonnées (MX1 : toujours « / » en tête, dans un dépôt git ou hors git). */
const isAbsolutePath = (value: unknown): value is string => typeof value === "string" && value.startsWith("/");

/**
 * E1, E2 : chemins touchés, tels qu'opencode les présente. edit/write : [metadata.filepath] ; apply_patch : files[].filePath et
 * files[].movePath (la destination d'un déplacement). Le `metadata.filepath` d'apply_patch (relatif au worktree, joint par
 * « , ») n'est jamais lu. null : métadonnées illisibles, dont un chemin qui n'est pas absolu (forme inattendue, par exemple un
 * apply_patch sans `files`) et un déplacement sans movePath ; apply_patch sans fichier → [].
 */
export function editTargetPaths(metadata: unknown): string[] | null {
  if (!isRecord(metadata)) return null;
  const files = own(metadata, "files");
  if (files === undefined) {
    const filepath = own(metadata, "filepath");
    return isAbsolutePath(filepath) ? [filepath] : null;
  }
  if (!Array.isArray(files)) return null;
  const paths: string[] = [];
  for (const file of files) {
    const filePaths = patchFilePaths(file);
    if (filePaths === null) return null;
    paths.push(...filePaths);
  }
  return paths;
}

/** Une entrée de files[] : [filePath] ou [filePath, movePath] ; null si illisible ou déplacement sans movePath. */
function patchFilePaths(file: unknown): string[] | null {
  if (!isRecord(file)) return null;
  const filePath = own(file, "filePath");
  const movePath = own(file, "movePath");
  if (!isAbsolutePath(filePath)) return null;
  if (movePath !== undefined) return isAbsolutePath(movePath) ? [filePath, movePath] : null;
  return own(file, "type") === "move" ? null : [filePath];
}

// --- Diff (E3, E4) --------------------------------------------------------------------------------------------------------------

/** Diff plus long : illisible (E4). */
export const DIFF_MAX_CHARS = 2_000_000;

/** E3 : un diff qui retire STRICTEMENT plus de cette part des lignes du fichier n'est jamais automatique. */
export const REMOVAL_RATIO_MAX = 0.5;

const HUNK_HEADER = /^@@ -([0-9]{1,9})(?:,([0-9]{1,9}))? \+([0-9]{1,9})(?:,([0-9]{1,9}))? @@/;

interface DiffStats {
  /** Lignes « - » de tous les blocs. */
  removed: number;
  /** Borne inférieure du nombre de lignes du fichier avant : fin du dernier bloc côté ancien. */
  oldLinesAtLeast: number;
}

interface HunkHeader {
  oldStart: number;
  oldCount: number;
  newCount: number;
}

/** « @@ -a,b +c,d @@ » (compte omis = 1) ; null : forme inattendue, bloc vide, début 0 avec des lignes, ou bloc qui recule. */
function readHunkHeader(line: string, previousOldEnd: number): HunkHeader | null {
  const match = HUNK_HEADER.exec(line);
  if (!match) return null;
  const oldStart = Number(match[1]);
  const oldCount = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newCount = match[4] === undefined ? 1 : Number(match[4]);
  if (oldCount + newCount === 0 || (oldCount > 0 && oldStart < 1) || (newCount > 0 && newStart < 1)) return null;
  return oldStart < previousOldEnd ? null : { oldStart, oldCount, newCount };
}

/** Index de la première ligne après les en-têtes « Index: », « ==== », « --- », « +++ » ; null si « --- » ou « +++ » manque. */
function skipFileHeader(lines: readonly string[]): number | null {
  let i = 0;
  if (lines[i]?.startsWith("Index: ")) i++;
  if (/^=+$/.test(lines[i] ?? "")) i++;
  return lines[i]?.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ") ? i + 2 : null;
}

/**
 * Lecture stricte d'un diff unifié d'UN fichier, tel que createTwoFilesPatch puis trimDiff le produisent. Les blocs sont lus
 * par leurs comptes : une ligne retirée qui commence par « -- » (« --- x ») ou ajoutée qui commence par « ++ » reste une ligne
 * de contenu. null : absent, trop long, en-tête manquant, compte incohérent, blocs dans le désordre ou ligne inattendue.
 */
function readUnifiedDiff(diff: unknown): DiffStats | null {
  if (typeof diff !== "string" || diff.length > DIFF_MAX_CHARS) return null;
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const start = skipFileHeader(lines);
  if (start === null) return null;
  const state: HunkState = { removed: 0, oldLinesAtLeast: 0, oldEnd: 0, oldLeft: 0, newLeft: 0, afterContent: false };
  for (const line of lines.slice(start)) {
    if (!readHunkLine(state, line)) return null;
  }
  return state.oldLeft === 0 && state.newLeft === 0 ? { removed: state.removed, oldLinesAtLeast: state.oldLinesAtLeast } : null;
}

interface HunkState extends DiffStats {
  /** Fin (exclue) du bloc précédent, côté ancien. */
  oldEnd: number;
  /** Lignes encore attendues dans le bloc en cours, côté ancien et côté nouveau. */
  oldLeft: number;
  newLeft: number;
  afterContent: boolean;
}

/** Une ligne après les en-têtes : marque « \ », en-tête de bloc (quand le bloc en cours est complet) ou ligne de contenu. */
function readHunkLine(state: HunkState, line: string): boolean {
  if (line.startsWith("\\")) {
    // « \ No newline at end of file » : seulement juste après une ligne de contenu.
    const allowed = state.afterContent;
    state.afterContent = false;
    return allowed;
  }
  if (state.oldLeft === 0 && state.newLeft === 0) {
    const header = readHunkHeader(line, state.oldEnd);
    if (header === null) return false;
    state.oldEnd = header.oldStart + header.oldCount;
    state.oldLinesAtLeast = Math.max(state.oldLinesAtLeast, state.oldEnd - 1);
    state.oldLeft = header.oldCount;
    state.newLeft = header.newCount;
    state.afterContent = false;
    return true;
  }
  const op = line[0];
  const old = op === "-" || op === " ";
  const added = op === "+" || op === " ";
  // Une ligne au-delà d'un compte le fait passer sous zéro : il n'y revient jamais et la lecture finale rejette le diff.
  if (!old && !added) return false;
  if (old) state.oldLeft--;
  if (added) state.newLeft--;
  if (op === "-") state.removed++;
  state.afterContent = true;
  return true;
}

/**
 * Part des lignes du fichier que le diff retire (lignes « - » ; une ligne remplacée compte comme retirée), entre 0 et 1 ;
 * null : diff absent ou illisible (E4). Le dénominateur est la fin du dernier bloc : exact quand le bloc atteint la fin du
 * fichier ou le couvre en entier, sinon plus petit que le vrai nombre de lignes, ce qui majore le taux. Fichier vidé ou supprimé
 * (« +0,0 ») : 1. Fichier nouveau ou diff sans bloc : 0.
 */
export function diffRemovalRatio(diff: unknown): number | null {
  const stats = readUnifiedDiff(diff);
  if (stats === null) return null;
  return stats.oldLinesAtLeast === 0 ? 0 : stats.removed / stats.oldLinesAtLeast;
}

// --- Décision -------------------------------------------------------------------------------------------------------------------

/** Faits d'un chemin touché, relevés par le serveur (L10b). */
export interface EditPathFacts {
  /** Chemin tel qu'opencode le présente (editTargetPaths, ou motif résolu depuis le worktree). */
  path: string;
  /** realpath (vue d'opencode) ; pour un fichier à créer, parent existant résolu puis reste du chemin ; null : non résolu. */
  resolved: string | null;
  /** Chemin résolu dans le dossier de la conversation. */
  inside: boolean;
  /** Un lien symbolique du chemin mène hors du dossier de la conversation. */
  symlinkOut: boolean;
}

/** Faits d'une demande de modification (§4.4), relevés par collectEditFacts (L10b) ; aucune entrée-sortie ici. */
export interface EditFacts {
  /** E6 : projects.isAllowedDirectory(dossier de la demande). */
  directoryAllowed: boolean;
  /** E1, E2 : `patterns` de la demande, relatifs au worktree (« / » hors git). */
  patterns: readonly string[];
  /** E1, E2 : un élément par chemin touché, destination d'un déplacement comprise. */
  paths: readonly EditPathFacts[];
  /** E3 : applyPatchDeletesOrMoves(metadata). */
  deletesOrMoves: boolean;
  /** E3, E4 : editDiffs(metadata). */
  diffs: ReadonlyArray<string | null>;
  /** E5 : fichiers distincts déjà modifiés automatiquement par la demande autonome en cours. */
  filesSoFar: number;
  /** E5 : fichiers distincts de cette demande qui ne sont pas encore comptés dans filesSoFar. */
  newFiles: number;
}

export type EditRule = "E1" | "E2" | "E3" | "E4" | "E5" | "E6";

/** Code de règle d'une modification automatique (famille « A- » des décisions automatiques). */
export const EDIT_AUTO_RULE = "A-edit";

export type EditVerdict =
  | { verdict: "auto"; regle: typeof EDIT_AUTO_RULE }
  | { verdict: "attente"; regle: Exclude<EditRule, "E5"> }
  | { verdict: "retour"; regle: "E5" };

/** Motif relatif : chaîne non vide, sans caractère de contrôle, ni racine (« / », « \ », lecteur), ni « ~ », « $ » ou « .. ». */
function isRelativePattern(pattern: unknown): boolean {
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > PATH_MAX_CHARS || hasControlCharacter(pattern)) return false;
  const normalized = pattern.replaceAll("\\", "/");
  if (/^[/~$]/.test(normalized) || /^[A-Za-z]:/.test(normalized)) return false;
  return !normalized.split("/").includes("..");
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

interface EditCheck {
  facts: EditFacts;
  fichiersMax: number;
  /** Taux de chaque diff, calculés une fois, à la première règle qui les lit. */
  ratios: () => ReadonlyArray<number | null>;
}

/** Règles dans l'ordre figé ; chacune rend vrai quand la modification peut rester automatique. */
const EDIT_CHECKS: ReadonlyArray<readonly [EditRule, (check: EditCheck) => boolean]> = [
  ["E6", ({ facts }) => facts.directoryAllowed === true],
  [
    "E1",
    ({ facts }) =>
      facts.patterns.length > 0 &&
      facts.patterns.every(isRelativePattern) &&
      facts.paths.length > 0 &&
      facts.paths.every(
        (p) => typeof p.path === "string" && p.path !== "" && typeof p.resolved === "string" && p.resolved !== "" && p.inside === true && p.symlinkOut === false,
      ),
  ],
  [
    "E2",
    ({ facts }) => !facts.patterns.some(isProtectedPath) && !facts.paths.some((p) => isProtectedPath(p.path) || isProtectedPath(p.resolved ?? "")),
  ],
  ["E3", ({ facts, ratios }) => facts.deletesOrMoves === false && ratios().every((ratio) => ratio === null || ratio <= REMOVAL_RATIO_MAX)],
  ["E4", ({ facts, ratios }) => facts.diffs.length > 0 && ratios().every((ratio) => ratio !== null)],
  [
    "E5",
    ({ facts, fichiersMax }) =>
      isCount(facts.filesSoFar) && isCount(facts.newFiles) && isCount(fichiersMax) && facts.filesSoFar + facts.newFiles <= fichiersMax,
  ],
];

/** Ordre d'examen des règles E (§4.4), tel que classifyEdit l'applique. */
export const EDIT_RULE_ORDER: readonly EditRule[] = Object.freeze(EDIT_CHECKS.map(([rule]) => rule));

/**
 * Décision sur une demande de modification (§4.4) : la première règle qui échoue décide, dans l'ordre E6 → E1 → E2 → E3 → E4 →
 * E5. E5 (`fichiersMax` dépassé : filesSoFar + newFiles > fichiersMax) → retour à « Demander à chaque fois » ; les autres →
 * attente. Toutes tenues → automatique. Avec un seul fichier nouveau, E5 revient à « fichiers auto de la demande < fichiersMax ».
 */
export function classifyEdit(facts: EditFacts, fichiersMax: number): EditVerdict {
  let ratios: ReadonlyArray<number | null> | null = null;
  const check: EditCheck = { facts, fichiersMax, ratios: () => (ratios ??= facts.diffs.map(diffRemovalRatio)) };
  for (const [rule, holds] of EDIT_CHECKS) {
    if (holds(check)) continue;
    return rule === "E5" ? { verdict: "retour", regle: rule } : { verdict: "attente", regle: rule };
  }
  return { verdict: "auto", regle: EDIT_AUTO_RULE };
}
