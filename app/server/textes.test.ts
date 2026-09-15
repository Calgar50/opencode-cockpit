// Test « textes » (spécification §2.2, §2.3 ; plan d'exécution §4.6, T0) : mots interdits en mode Simple, interdits partout et
// bannis, un sens par mot, « étape » accolé au nombre `steps`.
//
// Modules contrôlés, découverts par leur nom (aucun paquet n'a à éditer ce test pour être contrôlé) :
// - server/shared/*-texts.ts : exportent `TEXTES = { simple, avance, partout }` (textes affichés en Simple seulement, en Avancé
//   seulement, dans les deux modes), ou `TEXTES_VARIANTES = { <variante>: { simple, avance, partout } }` (par exemple avec et sans
//   IA de contrôle) : chaque variante est contrôlée. Chaque feuille est une chaîne (valeurs en gabarit « {nom} », jamais `${}`),
//   jamais une fonction : un module formate ses gabarits dans des fonctions exportées à part. À côté de TEXTES, seules des
//   fonctions sont exportées : toute autre exportation qui contient une chaîne est refusée (structure) et ses chaînes sont contrôlées
//   comme « partout ». Le source est lu aussi : un texte affichable écrit hors des textes exportés (fonction, constante interne,
//   message d'erreur ; lettre et espace, lettre accentuée ou mot à majuscule initiale) est refusé, et aucune chaîne littérale qui
//   n'est pas un code en minuscules ASCII n'échappe aux interdits partout, aux bannis ni à « étape » accolé à `steps` ;
// - server/shared/neon-*.ts : mêmes exports s'ils portent des textes ; leurs autres chaînes exportées, avec ou sans TEXTES, sont
//   contrôlées comme « partout » (fonctions ignorées) ;
// - un *-texts.ts ou neon-*.ts posé ailleurs sous server/ ou web/ (sous-dossier de server/shared compris) n'est pas contrôlé : refusé ;
// - phrases fixées par un contrat (commentaire « phrase affichée … : « … » » d'un server/shared/*-types.ts, reprises telles quelles
//   par un module de textes) : contrôlées comme « partout » d'un module soumis à « un sens par mot » ;
// - MESSAGES (assistant-rules.ts) : mots interdits en Simple permis seulement par la liste nominative d'exceptions ci-dessous.
// Tolérances « réfléchit » datées : chacune porte le paquet qui la retire ; une tolérance devenue inutile fait échouer le test.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { MESSAGES } from "./shared/assistant-rules.ts";

const SERVER_DIR = import.meta.dirname;
const APP_DIR = path.join(SERVER_DIR, "..");

// --- Listes (spécification §2.2 et §2.3) ----------------------------------------------------------------------------------------

interface WordRule {
  mot: string;
  re: RegExp;
}

const LETTER = "\\p{L}\\p{N}_";

/** Mot ou expression entier, casse ignorée : ni lettre ni trait d'union avant (« sous-agent » a sa propre règle), ni lettre après. */
const rule = (mot: string, pattern: string): WordRule => ({ mot, re: new RegExp(`(?<![${LETTER}-])(?:${pattern})(?![${LETTER}])`, "iu") });

/** §2.3 l.102 : interdits en mode Simple (« modèle », « Réfléchit » et « chef d'équipe » sont dans les bannis). */
const INTERDITS_SIMPLE: readonly WordRule[] = [
  rule("agent", "agents?"),
  rule("sous-agent", "sous-agents?"),
  rule("session", "sessions?"),
  rule("prompt", "prompts?"),
  rule("jeton", "jetons?"),
  rule("token", "tokens?"),
  rule("workflow", "workflows?"),
  rule("pipeline", "pipelines?"),
  rule("orchestrateur", "orchestrat(?:eur|rice)s?"),
  rule("nœud", "n(?:œ|oe)uds?"),
  rule("parallèle", "parall[èe]les?"),
  rule("boucle", "boucles?"),
  rule("itération", "it[ée]rations?"),
  rule("permission", "permissions?"),
  rule("juge", "juges?"),
  rule("classifieur", "classifi(?:eur|cateur)s?"),
  rule("LLM", "llms?"),
  rule("profondeur", "profondeurs?"),
  rule("subagent_depth", "subagent_depth"),
  rule("regard", "regards?"),
  rule("validé", "validée?s?"),
  rule("approuvé", "approuvée?s?"),
  rule("vérifié par l'IA", "vérifiée?s?\\s+par\\s+l['’]\\s*IA"),
  rule("feu vert", "feux?\\s+verts?"),
  rule("prêt pour le CAB", "prête?s?\\s+pour\\s+le\\s+CAB"),
];

/** §2.3 l.103 : interdits partout. */
const INTERDITS_PARTOUT: readonly WordRule[] = [
  rule("Toujours autoriser", "toujours\\s+autoriser"),
  rule("jamais plus de", "jamais\\s+plus\\s+de"),
  rule("sans risque", "sans\\s+risques?"),
  rule("tout autoriser", "tout\\s+autoriser"),
  rule("réussi", "réussie?s?"),
];

/** §2.2 : bannis partout. « modèle » vise une IA ; seule tournure admise : « modèle de réflexion » (phrase d'accueil). */
const BANNIS: readonly WordRule[] = [
  rule("Dossier transmis", "dossiers?\\s+transmis"),
  rule("chef d'équipe", "chefs?\\s+d['’]\\s*équipes?"),
  rule("validation", "validations?"),
  rule("modèle", "mod[èe]les?(?!\\s+de\\s+réflexion)"),
  rule("Réfléchit", "r[ée]fl[ée]chi(?:t|ssent)"),
];

/** Un sens par mot : « mode » seulement dans « mode Simple » ou « mode Avancé » ; « pause » (équipes) et « relecture » (Revoir). */
const UN_SENS: readonly WordRule[] = [
  rule("mode", "modes?(?!\\s+(?:Simple|Avancé)(?![\\p{L}]))"),
  rule("pause", "pauses?"),
  rule("relecture", "relectures?"),
];

/** Modules soumis à « un sens par mot » : autonomy*-texts, neon-texts, activity-texts, delegation-texts. */
const UN_SENS_MODULES = /^(?:autonomy[\w-]*|neon|activity|delegation)-texts\.ts$/;

const STEPS_PLACEHOLDER = "\\{[^{}]*\\bsteps\\b[^{}]*\\}";

/** « étape » accolé au nombre `steps` (« {steps} étapes », « Étapes maximum : {steps} ») et le libellé « Étapes maximum » (§2.2). */
const ETAPE_STEPS: readonly RegExp[] = [
  new RegExp(`${STEPS_PLACEHOLDER}[\\s\\u00a0]*(?:\\p{L}+[\\s\\u00a0]+)?étapes?(?![\\p{L}])`, "iu"),
  new RegExp(`(?<![\\p{L}])étapes?[\\s\\u00a0]*(?:maximum|max\\.?)?[\\s\\u00a0]*[:=(]?[\\s\\u00a0]*${STEPS_PLACEHOLDER}`, "iu"),
  new RegExp("(?<![\\p{L}])étapes?[\\s\\u00a0]+maximum(?![\\p{L}])", "iu"),
];

// --- Exceptions et tolérances nominatives ---------------------------------------------------------------------------------------

interface MessageException {
  cle: string;
  mot: string;
  raison: string;
}

/** Occurrences de la 1.0.4 dans MESSAGES d'un mot interdit en Simple, chacune justifiée. Toute autre occurrence fait échouer. */
const MESSAGES_EXCEPTIONS: readonly MessageException[] = [
  {
    cle: "paquetCopilotRefuse",
    mot: "jeton",
    raison:
      "refus d'une configuration d'opencode (provider.github-copilot.npm) : « jeton Copilot » nomme le secret réellement exposé, sans synonyme exact ; affiché avec la configuration refusée et le verrou fournisseur",
  },
];

interface Tolerance {
  /** Chemin relatif au dossier app, séparateur « / ». */
  fichier: string;
  extrait: string;
  /** Paquet qui retire l'occurrence (et cette tolérance). */
  paquet: string;
}

/** « Réfléchit » (état) devient « Travaille » (§2.2) : occurrences connues, tolérées jusqu'au train de V3 (plan §4.6). */
const TOLERANCES_REFLECHIT: readonly Tolerance[] = [
  { fichier: "server/shared/assistant-rules.ts", extrait: "Réfléchit et propose un plan. Ses droits suivent vos réglages", paquet: "L5t" },
  { fichier: "server/shared/assistant-rules.ts", extrait: "Réfléchit et propose un plan, sans rien modifier.", paquet: "L5t" },
];

// --- Contrôles --------------------------------------------------------------------------------------------------------------------

interface Violation {
  source: string;
  chemin: string;
  regle: string;
  mot: string;
}

type Section = "simple" | "avance" | "partout";
const SECTIONS: readonly Section[] = ["simple", "avance", "partout"];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const wordsIn = (text: string, rules: readonly WordRule[]) => rules.filter((r) => r.re.test(text)).map((r) => r.mot);

/** Modules de textes d'un dossier, par leur nom. */
function textModules(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => !f.endsWith(".test.ts") && (/^[\w.-]+-texts\.ts$/.test(f) || /^neon-[\w.-]+\.ts$/.test(f)))
    .sort();
}

/** Modules de textes (*-texts ou neon-*, .ts ou .tsx) sous server/ et web/ que textModules(server/shared) ne contrôle pas. */
function misplacedTextModules(appDir: string): string[] {
  const shared = path.join(appDir, "server", "shared");
  const controlled = new Set(fs.existsSync(shared) ? textModules(shared).map((f) => `server/shared/${f}`) : []);
  const found: string[] = [];
  for (const top of ["server", "web"]) {
    const dir = path.join(appDir, top);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { recursive: true }) as string[]) {
      const rel = `${top}/${entry.replaceAll("\\", "/")}`;
      const name = path.posix.basename(rel);
      if (/\.test\.tsx?$/.test(name) || !/^(?:[\w.-]+-texts|neon-[\w.-]+)\.tsx?$/.test(name)) continue;
      if (!controlled.has(rel)) found.push(rel);
    }
  }
  return found.sort();
}

interface Leaf {
  chemin: string;
  texte: string;
}

function collectLeaves(value: unknown, chemin: string, out: Leaf[], problems: Violation[], source: string, strict: boolean): void {
  if (typeof value === "string") {
    out.push({ chemin, texte: value });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => collectLeaves(item, `${chemin}[${index}]`, out, problems, source, strict));
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) collectLeaves(item, chemin ? `${chemin}.${key}` : key, out, problems, source, strict);
  } else if (strict && !(typeof value === "number" || typeof value === "boolean" || value === null || value === undefined)) {
    problems.push({ source, chemin, regle: "structure", mot: `${typeof value} : écrire un gabarit « {nom} » dans une chaîne` });
  }
}

function checkLeaves(source: string, section: Section, leaves: readonly Leaf[], unSens: boolean, problems: Violation[]): void {
  for (const { chemin, texte } of leaves) {
    if (section !== "avance") for (const mot of wordsIn(texte, INTERDITS_SIMPLE)) problems.push({ source, chemin, regle: "interdit en mode Simple", mot });
    for (const mot of wordsIn(texte, [...INTERDITS_PARTOUT, ...BANNIS])) problems.push({ source, chemin, regle: "interdit partout", mot });
    if (unSens) for (const mot of wordsIn(texte, UN_SENS)) problems.push({ source, chemin, regle: "un sens par mot", mot });
    if (ETAPE_STEPS.some((re) => re.test(texte))) problems.push({ source, chemin, regle: "étape accolé à steps", mot: "étape" });
  }
}

interface SourceLiteral {
  ligne: number;
  texte: string;
  /** true : chaîne entière (guillemets, ou gabarit sans `${}`) ; false : morceau fixe d'un gabarit à trous. */
  entier: boolean;
}

/** Mots-clés après lesquels « / » ouvre une expression régulière. */
const BEFORE_EXPRESSION = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

const IDENT_CHAR = /[\p{L}\p{N}_$]/u;

/** Décode les échappements d'une chaîne JavaScript (lettres, code hexadécimal ou Unicode, fin de ligne échappée). */
function unescapeJs(raw: string): string {
  const simples: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: String.fromCharCode(8), f: String.fromCharCode(12), v: String.fromCharCode(11), 0: String.fromCharCode(0) };
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|[\s\S])/g, (_, seq: string) => {
    if (seq.length > 1 && (seq[0] === "u" || seq[0] === "x")) return String.fromCodePoint(Number.parseInt(seq.slice(1).replace(/[{}]/g, ""), 16));
    if (seq === "\r\n" || seq === "\n" || seq === "\r" || seq === String.fromCharCode(0x2028) || seq === String.fromCharCode(0x2029)) return "";
    return simples[seq] ?? seq;
  });
}

/**
 * Chaînes littérales et morceaux fixes de gabarits d'un source TypeScript, dans l'ordre : commentaires et expressions régulières
 * écartés, expressions `${…}` parcourues (gabarits imbriqués compris). Lecture lexicale sans dépendance (P8), suffisante pour un
 * module de textes : « / » ouvre une expression régulière sauf après un identifiant, un nombre, « ) », « ] » ou « } ».
 */
function sourceLiterals(source: string): SourceLiteral[] {
  const out: SourceLiteral[] = [];
  const ligne = (at: number) => source.slice(0, at).split("\n").length;
  const step = (at: number) => (source[at] === "\\" ? (source.startsWith("\r\n", at + 1) ? at + 3 : at + 2) : at + 1);
  type Frame = { depth: number; pieces: Array<{ at: number; raw: string }> };
  /** Gabarits suspendus dans une expression `${…}`, refermée quand la profondeur d'accolades revient à `depth`. */
  const suspended: Frame[] = [];
  let depth = 0;
  let regexAllowed = true;
  const emit = (frame: Frame, entier: boolean) => {
    for (const piece of frame.pieces) out.push({ ligne: ligne(piece.at), texte: unescapeJs(piece.raw), entier });
  };
  /** Lit un morceau de gabarit à partir de `from` ; rend l'indice qui suit « ` » (gabarit fini) ou « ${ » (expression). */
  const readTemplate = (frame: Frame, from: number): number => {
    let at = from;
    while (at < source.length && source[at] !== "`" && !(source[at] === "$" && source[at + 1] === "{")) at = step(at);
    frame.pieces.push({ at: from, raw: source.slice(from, Math.min(at, source.length)) });
    if (source[at] === "$") {
      depth += 1;
      frame.depth = depth;
      suspended.push(frame);
      regexAllowed = true;
      return at + 2;
    }
    emit(frame, frame.pieces.length === 1);
    regexAllowed = false;
    return at + 1;
  };
  let i = 0;
  while (i < source.length) {
    const c = source.charAt(i);
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
    } else if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (c === '"' || c === "'") {
      let at = i + 1;
      while (at < source.length && source[at] !== c && source[at] !== "\n") at = step(at);
      out.push({ ligne: ligne(i), texte: unescapeJs(source.slice(i + 1, Math.min(at, source.length))), entier: true });
      i = at + 1;
      regexAllowed = false;
    } else if (c === "`") {
      i = readTemplate({ depth: 0, pieces: [] }, i + 1);
    } else if (c === "}" && suspended.at(-1)?.depth === depth) {
      depth -= 1;
      i = readTemplate(suspended.pop() as Frame, i + 1);
    } else if (IDENT_CHAR.test(c)) {
      let at = i + 1;
      while (at < source.length && IDENT_CHAR.test(source.charAt(at))) at += 1;
      regexAllowed = BEFORE_EXPRESSION.has(source.slice(i, at));
      i = at;
    } else if (c === "/" && regexAllowed && readRegex(source, i) !== -1) {
      i = readRegex(source, i);
      regexAllowed = false;
    } else {
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      if (!/\s/u.test(c)) regexAllowed = !(c === ")" || c === "]" || c === "}");
      i += 1;
    }
  }
  for (const frame of suspended) emit(frame, false);
  return out;
}

/** Fin (indice qui suit les drapeaux) de l'expression régulière ouverte en `start`, ou -1 si la ligne ne la referme pas. */
function readRegex(source: string, start: number): number {
  let at = start + 1;
  let inClass = false;
  while (at < source.length && source[at] !== "\n") {
    const c = source.charAt(at);
    if (c === "\\") {
      at += 2;
      continue;
    }
    if (c === "/" && !inClass) {
      at += 1;
      while (at < source.length && IDENT_CHAR.test(source.charAt(at))) at += 1;
      return at;
    }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    at += 1;
  }
  return -1;
}

/** Code (identifiant, clé, valeur d'énumération) plutôt que texte : minuscules ASCII et chiffres, séparés par - _ . ou :. */
const CODE_LIKE = /^[a-z0-9]+(?:[-_.:][a-z0-9]+)*$/;

/** Texte affichable plutôt que code : lettre et espace, lettre accentuée, ou mot à majuscule initiale (« Terminé », « Session »). */
const looksDisplayed = (texte: string) =>
  (/\p{L}/u.test(texte) && /\s/u.test(texte)) || /(?=\P{ASCII})\p{L}/u.test(texte) || /^\p{Lu}\p{Ll}[\p{L}'’-]*[.!?…]?$/u.test(texte);

/**
 * Source d'un *-texts.ts : une chaîne égale à un texte exporté est déjà contrôlée (avec sa section). Toute autre chaîne littérale ou
 * tout morceau de gabarit est écrit hors des textes exportés : refusé s'il est affichable, contrôlé contre les interdits partout, les
 * bannis et « étape » accolé à `steps` s'il n'est pas un code.
 */
function checkTextSource(file: string, source: string, exported: readonly Leaf[]): Violation[] {
  const problems: Violation[] = [];
  const known = new Set(exported.map((leaf) => leaf.texte));
  for (const { ligne, texte, entier } of sourceLiterals(source)) {
    if ((entier && known.has(texte)) || CODE_LIKE.test(texte)) continue;
    const chemin = `ligne ${ligne}`;
    if (looksDisplayed(texte)) problems.push({ source: file, chemin, regle: "structure", mot: `texte écrit hors de TEXTES, à y ranger : « ${texte} »` });
    for (const mot of wordsIn(texte, [...INTERDITS_PARTOUT, ...BANNIS])) problems.push({ source: file, chemin, regle: "interdit partout", mot });
    if (ETAPE_STEPS.some((re) => re.test(texte))) problems.push({ source: file, chemin, regle: "étape accolé à steps", mot: "étape" });
  }
  return problems;
}

/**
 * Contrôle un module de textes à partir de ses exportations ; `source` (texte du fichier) ajoute, pour un *-texts.ts, le contrôle
 * des chaînes écrites hors des textes exportés.
 */
function checkTextModule(file: string, exports: Record<string, unknown>, source?: string): Violation[] {
  const problems: Violation[] = [];
  const unSens = UN_SENS_MODULES.test(file);
  const isTexts = file.endsWith("-texts.ts");
  const variants: Array<[string, unknown]> = [];
  if ("TEXTES" in exports) variants.push(["TEXTES", exports.TEXTES]);
  if ("TEXTES_VARIANTES" in exports) {
    const all = exports.TEXTES_VARIANTES;
    if (!isRecord(all) || Object.keys(all).length === 0) {
      problems.push({ source: file, chemin: "TEXTES_VARIANTES", regle: "structure", mot: "au moins une variante { simple, avance, partout }" });
    } else {
      for (const [name, value] of Object.entries(all)) variants.push([`TEXTES_VARIANTES.${name}`, value]);
    }
  }
  if (variants.length === 0 && isTexts) {
    problems.push({ source: file, chemin: "", regle: "structure", mot: "exporter TEXTES ou TEXTES_VARIANTES" });
    return problems;
  }
  const exported: Leaf[] = [];
  for (const [prefix, value] of variants) {
    if (!isRecord(value)) {
      problems.push({ source: file, chemin: prefix, regle: "structure", mot: "{ simple, avance, partout }" });
      continue;
    }
    const keys = Object.keys(value).sort();
    if (keys.join(",") !== "avance,partout,simple") {
      problems.push({ source: file, chemin: prefix, regle: "structure", mot: `sections simple, avance, partout attendues (reçu : ${keys.join(", ")})` });
    }
    for (const section of SECTIONS) {
      if (!(section in value)) continue;
      const leaves: Leaf[] = [];
      collectLeaves(value[section], `${prefix}.${section}`, leaves, problems, file, true);
      checkLeaves(file, section, leaves, unSens, problems);
      exported.push(...leaves);
    }
  }
  // Autres exportations (fonctions ignorées), avec ou sans TEXTES : chaînes contrôlées comme « partout » ; refusées dans un *-texts.ts.
  for (const [name, value] of Object.entries(exports)) {
    if (name === "TEXTES" || name === "TEXTES_VARIANTES" || typeof value === "function") continue;
    const leaves: Leaf[] = [];
    collectLeaves(value, name, leaves, problems, file, false);
    if (leaves.length === 0) continue;
    if (isTexts) problems.push({ source: file, chemin: name, regle: "structure", mot: "texte exporté hors de TEXTES : seules des fonctions s'exportent à côté" });
    checkLeaves(file, "partout", leaves, unSens, problems);
    exported.push(...leaves);
  }
  if (isTexts && source !== undefined) problems.push(...checkTextSource(file, source, exported));
  return problems;
}

/** Phrases fixées par un contrat : « phrase affichée … : « texte » » dans un commentaire (une ligne). */
function contractPhrases(source: string): Leaf[] {
  return [...source.matchAll(/phrase affichée[^«\n]*«\s*([^»\n]+?)\s*»/gu)].map((m) => ({ chemin: `ligne ${source.slice(0, m.index).split("\n").length}`, texte: m[1] ?? "" }));
}

/** Phrases fixées pour le code « a-venir » : son article dans le commentaire d'ActivationRefusalCode, lignes de suite comprises. */
function aVenirPhrases(source: string): Leaf[] {
  const article = /^[ \t]*\*[ \t]*-[ \t]*a-venir[ \t]*:[^\n]*(?:\n[ \t]*\*[ \t]{2,}[^\n]*)*/mu.exec(source);
  return article ? contractPhrases(article[0]) : [];
}

function checkMessages(messages: Readonly<Record<string, string>>, exceptions: readonly MessageException[]): Violation[] {
  const problems: Violation[] = [];
  const used = new Set<MessageException>();
  for (const [cle, texte] of Object.entries(messages)) {
    for (const mot of wordsIn(texte, INTERDITS_SIMPLE)) {
      const exception = exceptions.find((e) => e.cle === cle && e.mot === mot);
      if (exception) used.add(exception);
      else problems.push({ source: "MESSAGES", chemin: cle, regle: "interdit en mode Simple, hors liste d'exceptions", mot });
    }
    for (const mot of wordsIn(texte, [...INTERDITS_PARTOUT, ...BANNIS])) {
      problems.push({ source: "MESSAGES", chemin: cle, regle: "interdit partout (aucune exception)", mot });
    }
    if (ETAPE_STEPS.some((re) => re.test(texte))) problems.push({ source: "MESSAGES", chemin: cle, regle: "étape accolé à steps", mot: "étape" });
  }
  for (const exception of exceptions) {
    if (exception.raison.trim() === "") problems.push({ source: "MESSAGES", chemin: exception.cle, regle: "exception sans raison", mot: exception.mot });
    if (!used.has(exception)) {
      problems.push({ source: "MESSAGES", chemin: exception.cle, regle: "exception devenue inutile : la retirer", mot: exception.mot });
    }
  }
  return problems;
}

function checkReflechit(sources: ReadonlyArray<{ fichier: string; texte: string }>, tolerances: readonly Tolerance[]): Violation[] {
  const problems: Violation[] = [];
  const used = new Set<Tolerance>();
  for (const { fichier, texte } of sources) {
    const ranges = tolerances
      .filter((t) => t.fichier === fichier)
      .flatMap((t) => {
        const found: Array<{ t: Tolerance; start: number; end: number }> = [];
        for (let at = texte.indexOf(t.extrait); at !== -1; at = texte.indexOf(t.extrait, at + 1)) found.push({ t, start: at, end: at + t.extrait.length });
        return found;
      });
    for (const match of texte.matchAll(/r[ée]fl[ée]chi(?:t|ssent)/giu)) {
      const at = match.index ?? 0;
      const range = ranges.find((r) => r.start <= at && at + match[0].length <= r.end);
      if (range) {
        used.add(range.t);
      } else {
        const line = texte.slice(0, at).split("\n").length;
        problems.push({ source: fichier, chemin: `ligne ${line}`, regle: "« Réfléchit » banni (§2.2), hors tolérance", mot: match[0] });
      }
    }
  }
  for (const t of tolerances) {
    if (!used.has(t)) problems.push({ source: t.fichier, chemin: t.extrait, regle: `tolérance périmée (retirée par ${t.paquet}) : la supprimer de ce test`, mot: "réfléchit" });
  }
  return problems;
}

/** Sources scannées pour « réfléchit » : toute l'interface (web/**\/*.ts, *.tsx) et assistant-rules.ts. */
function reflechitSources(): Array<{ fichier: string; texte: string }> {
  const webDir = path.join(APP_DIR, "web");
  const web = (fs.readdirSync(webDir, { recursive: true }) as string[])
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => ({ fichier: `web/${f.replaceAll("\\", "/")}`, texte: fs.readFileSync(path.join(webDir, f), "utf8") }));
  const rules = path.join(SERVER_DIR, "shared", "assistant-rules.ts");
  return [...web, { fichier: "server/shared/assistant-rules.ts", texte: fs.readFileSync(rules, "utf8") }];
}

// --- Tests ------------------------------------------------------------------------------------------------------------------------

describe("textes : contrôles discriminants", () => {
  it("modules découverts par leur nom : *-texts.ts et neon-*.ts, jamais les tests", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-textes-"));
    try {
      for (const file of ["autonomy-texts.ts", "neon-scene.ts", "session-floors.ts", "neon-texts.test.ts", "api-types.ts"]) fs.writeFileSync(path.join(dir, file), "");
      assert.deepEqual(textModules(dir), ["autonomy-texts.ts", "neon-scene.ts"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("module de textes : chaque mot interdit est trouvé, dans la bonne section et la bonne famille", () => {
    const empty = { simple: {}, avance: {}, partout: {} };
    const cases: Array<[string, Record<string, unknown>, string, string]> = [
      ["floor-texts.ts", { TEXTES: { ...empty, simple: { a: "Votre session" } } }, "interdit en mode Simple", "session"],
      ["floor-texts.ts", { TEXTES: { ...empty, partout: { a: "Aucun sous-agent" } } }, "interdit en mode Simple", "sous-agent"],
      ["floor-texts.ts", { TEXTES: { ...empty, partout: { a: "Vérifiée par l’IA" } } }, "interdit en mode Simple", "vérifié par l'IA"],
      ["floor-texts.ts", { TEXTES: { ...empty, avance: { a: "Envoi réussi" } } }, "interdit partout", "réussi"],
      ["floor-texts.ts", { TEXTES: { ...empty, avance: { a: "Choisissez un modèle" } } }, "interdit partout", "modèle"],
      ["floor-texts.ts", { TEXTES: { ...empty, avance: { a: "L'assistant RÉFLÉCHIT" } } }, "interdit partout", "Réfléchit"],
      ["floor-texts.ts", { TEXTES: { ...empty, avance: { a: "Chef d’équipe" } } }, "interdit partout", "chef d'équipe"],
      ["autonomy-choice-texts.ts", { TEXTES: { ...empty, avance: { a: "Le mode autonome" } } }, "un sens par mot", "mode"],
      ["neon-texts.ts", { TEXTES: { ...empty, partout: { a: "En pause" } } }, "un sens par mot", "pause"],
      ["activity-texts.ts", { TEXTES: { ...empty, avance: { a: "Relecture en cours" } } }, "un sens par mot", "relecture"],
      ["delegation-texts.ts", { TEXTES: { ...empty, avance: { a: "Modes de travail" } } }, "un sens par mot", "mode"],
      ["floor-texts.ts", { TEXTES: { ...empty, avance: { a: "{steps} étapes au plus" } } }, "étape accolé à steps", "étape"],
      ["floor-texts.ts", { TEXTES: { ...empty, avance: { a: "Étapes maximum : {agent.steps}" } } }, "étape accolé à steps", "étape"],
    ];
    for (const [file, exports, regle, mot] of cases) {
      const problems = checkTextModule(file, exports);
      assert.ok(problems.some((p) => p.regle === regle && p.mot === mot), `${file} ${JSON.stringify(exports)} → ${JSON.stringify(problems)}`);
    }
    // Mots du mode Avancé dans « avance », « mode » hors des familles concernées, tournures admises : aucun échec.
    assert.deepEqual(checkTextModule("floor-texts.ts", { TEXTES: { ...empty, avance: { a: "Session et permission" }, partout: { b: "Le mode de lecture" } } }), []);
    const admis = { simple: { a: "En mode Simple ou en mode Avancé." }, avance: {}, partout: { b: "Ce que vous appeliez « modèle de réflexion » s'appelle ici Équipe." } };
    assert.deepEqual(checkTextModule("autonomy-texts.ts", { TEXTES: admis }), []);
  });

  it("module de textes : structure imposée, variantes toutes contrôlées, neon-* sans TEXTES contrôlé comme « partout »", () => {
    assert.ok(checkTextModule("floor-texts.ts", {}).some((p) => p.regle === "structure"));
    assert.ok(checkTextModule("floor-texts.ts", { TEXTES: { simple: {}, partout: {} } }).some((p) => p.regle === "structure"));
    assert.ok(checkTextModule("floor-texts.ts", { TEXTES: { simple: { a: () => "Votre session" }, avance: {}, partout: {} } }).some((p) => p.regle === "structure"));
    const variantes = {
      TEXTES_VARIANTES: {
        avecControleIa: { simple: { a: "Contrôle de sécurité" }, avance: {}, partout: {} },
        sansControleIa: { simple: { a: "Aucun juge" }, avance: {}, partout: {} },
      },
    };
    assert.deepEqual(
      checkTextModule("autonomy-texts.ts", variantes).map((p) => [p.chemin, p.mot]),
      [["TEXTES_VARIANTES.sansControleIa.simple.a", "juge"]],
    );
    assert.ok(checkTextModule("neon-scene.ts", { LEGENDES: { a: "Tout autoriser" }, scene: () => null }).some((p) => p.mot === "tout autoriser"));
    assert.deepEqual(checkTextModule("neon-palette.ts", { COULEURS: { rose: "#ff2bd6" }, scene: () => "session" }), []);
  });

  it("module de textes : exportation à côté de TEXTES refusée dans un *-texts.ts, contrôlée comme « partout » dans un neon-*", () => {
    const empty = { simple: {}, avance: {}, partout: {} };
    const summary = (problems: Violation[]) => problems.map((p) => [p.chemin, p.regle, p.regle === "structure" ? "" : p.mot]);
    assert.deepEqual(summary(checkTextModule("floor-texts.ts", { TEXTES: empty, LIBELLE: "Votre session" })), [
      ["LIBELLE", "structure", ""],
      ["LIBELLE", "interdit en mode Simple", "session"],
    ]);
    assert.deepEqual(summary(checkTextModule("floor-texts.ts", { TEXTES_VARIANTES: { a: empty, b: empty }, CHOIX: ["demander", "autonome"] })), [["CHOIX", "structure", ""]]);
    assert.deepEqual(summary(checkTextModule("neon-texts.ts", { TEXTES: empty, CHOIX: { a: "Toujours autoriser" } })), [
      ["CHOIX", "structure", ""],
      ["CHOIX.a", "interdit partout", "Toujours autoriser"],
    ]);
    assert.deepEqual(summary(checkTextModule("neon-scene.ts", { TEXTES: empty, LEGENDES: { a: "Tout autoriser" }, scene: () => null })), [
      ["LEGENDES.a", "interdit partout", "tout autoriser"],
    ]);
    // Fonctions, nombres et booléens à côté de TEXTES : permis.
    assert.deepEqual(checkTextModule("floor-texts.ts", { TEXTES: empty, formater: () => "Votre session", LIMITE: 120, ACTIF: true }), []);
  });

  it("module de textes : source lu, texte écrit hors de TEXTES refusé, chaînes hors TEXTES contrôlées contre les interdits partout", () => {
    const bs = String.fromCharCode(92);
    const exports = { TEXTES: { simple: { a: "L’IA travaille", c: "Arrêt.\n\t« Terminé »" }, avance: { b: "Session et permission" }, partout: {} }, raison: () => "" };
    const source = [
      /* 1 */ `import type { ActivationRefusalCode } from "./autonomy-types.ts";`,
      /* 2 */ `export const TEXTES = { simple: { "a": "L${bs}u2019IA travaille", c: "Arr${bs}xeat.${bs}n${bs}t${bs}u{AB} Termin${bs}u00e9 ${bs}xbb" }, avance: { b: 'Session et permission' }, partout: {} };`,
      /* 3 */ `// « Toujours autoriser » dans un commentaire, /* "Envoi réussi" */ aussi : ignorés.`,
      /* 4 */ `const CLE = "modele-indisponible";`,
      /* 5 */ `export function raison(code: ActivationRefusalCode, n: number): string {`,
      /* 6 */ `  if (/["'\`]/.test(code) || n / 2 > 1) return "";`,
      /* 7 */ `  return code === CLE ? \`Toujours autoriser \${code}\` : 'r${bs}u00e9ussi';`,
      /* 8 */ `}`,
      /* 9 */ `export const titre = (steps: number) => \`\${fmt({ n: "{steps} étapes", k: "a" })}\${steps > 1 ? \`\${steps}\` : "Session"} fin\`;`,
      /* 10 */ `throw new Error("gabarit inconnu");`,
      /* 11 */ `export const suite = (x: string) => \`\${x}Session et permission\`;`,
    ].join("\n");
    const summary = checkTextModule("floor-texts.ts", exports, source).map((p) => [p.chemin, p.regle, p.regle === "structure" ? "" : p.mot]);
    assert.deepEqual(summary, [
      ["ligne 7", "structure", ""],
      ["ligne 7", "interdit partout", "Toujours autoriser"],
      ["ligne 7", "structure", ""],
      ["ligne 7", "interdit partout", "réussi"],
      ["ligne 9", "structure", ""],
      ["ligne 9", "étape accolé à steps", "étape"],
      ["ligne 9", "structure", ""],
      ["ligne 9", "structure", ""],
      ["ligne 10", "structure", ""],
      ["ligne 11", "structure", ""],
    ]);
    // Sans source, ou dans un neon-* qui n'est pas un *-texts.ts : le source n'est pas lu.
    assert.deepEqual(checkTextModule("floor-texts.ts", exports), []);
    assert.deepEqual(checkTextModule("neon-scene.ts", { scene: () => "" }, `export const scene = () => "Toujours autoriser";`), []);
  });

  it("modules de textes posés hors de server/shared (ou dans un sous-dossier) : trouvés, tests et composants exceptés", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-textes-"));
    try {
      const files = [
        "server/shared/floor-texts.ts",
        "server/shared/neon-scene.ts",
        "server/shared/sub/omo-room-texts.ts",
        "server/routes-texts.ts",
        "server/neon-scene.test.ts",
        "web/lib/neon-band.tsx",
        "web/pages/chat/activity/NeonBand.tsx",
        "web/lib/api-types.ts",
      ];
      for (const file of files) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), "");
      }
      assert.deepEqual(misplacedTextModules(dir), ["server/routes-texts.ts", "server/shared/sub/omo-room-texts.ts", "web/lib/neon-band.tsx"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("phrases fixées par un contrat : trouvées dans les commentaires et contrôlées", () => {
    const contrat = [
      " * - a-venir : activation fermée ;",
      " *   phrase affichée (section partout) : « Arrive avec l'itération 2. »",
      " * phrase affichée : module de textes (L9b).",
    ].join("\n");
    assert.deepEqual(contractPhrases(contrat), [{ chemin: "ligne 2", texte: "Arrive avec l'itération 2." }]);
    const problems: Violation[] = [];
    checkLeaves("autonomy-types.ts", "partout", contractPhrases(contrat), true, problems);
    assert.deepEqual(problems.map((p) => [p.chemin, p.mot]), [["ligne 2", "itération"]]);
    assert.equal(aVenirPhrases(contrat.replace(/phrase affichée[^\n]*/, "à venir")).length, 0);
    assert.equal(aVenirPhrases(contrat).length, 1);
  });

  it("MESSAGES : occurrence hors liste, exception devenue inutile et mot interdit partout échouent", () => {
    const messages = { a: "Collez le jeton.", b: "Rien à signaler." };
    const exception = { cle: "a", mot: "jeton", raison: "raison" };
    assert.deepEqual(checkMessages(messages, [exception]), []);
    assert.deepEqual(
      checkMessages(messages, []).map((p) => [p.chemin, p.mot, p.regle]),
      [["a", "jeton", "interdit en mode Simple, hors liste d'exceptions"]],
    );
    assert.ok(checkMessages(messages, [exception, { cle: "b", mot: "prompt", raison: "x" }]).some((p) => p.chemin === "b" && p.regle.startsWith("exception devenue inutile")));
    assert.ok(checkMessages(messages, [{ ...exception, raison: " " }]).some((p) => p.regle === "exception sans raison"));
    assert.ok(checkMessages({ c: "Envoi réussi." }, [{ cle: "c", mot: "réussi", raison: "x" }]).some((p) => p.regle === "interdit partout (aucune exception)"));
  });

  it("« réfléchit » : occurrence hors tolérance (toute casse) et tolérance périmée échouent", () => {
    const tolerance = { fichier: "web/x.tsx", extrait: "L'assistant réfléchit…", paquet: "T2" };
    assert.deepEqual(checkReflechit([{ fichier: "web/x.tsx", texte: "<p>L'assistant réfléchit…</p>" }], [tolerance]), []);
    const extra = checkReflechit([{ fichier: "web/x.tsx", texte: "<p>L'assistant réfléchit…</p>\n<p>Il RÉFLÉCHIT</p>" }], [tolerance]);
    assert.deepEqual(extra.map((p) => [p.chemin, p.mot]), [["ligne 2", "RÉFLÉCHIT"]]);
    const stale = checkReflechit([{ fichier: "web/x.tsx", texte: "<p>L'assistant travaille…</p>" }], [tolerance]);
    assert.deepEqual(stale.map((p) => p.regle), ["tolérance périmée (retirée par T2) : la supprimer de ce test"]);
  });
});

describe("textes : code du cockpit", () => {
  it("server/shared/*-texts.ts et neon-*.ts : aucun mot interdit, structure respectée", async () => {
    const dir = path.join(SERVER_DIR, "shared");
    const problems: Violation[] = [];
    for (const file of textModules(dir)) {
      const exports = (await import(pathToFileURL(path.join(dir, file)).href)) as Record<string, unknown>;
      problems.push(...checkTextModule(file, { ...exports }, fs.readFileSync(path.join(dir, file), "utf8")));
    }
    assert.deepEqual(problems, []);
  });

  it("aucun *-texts.ts ni neon-*.ts hors de server/shared : un module posé ailleurs ne serait pas contrôlé", () => {
    assert.deepEqual(misplacedTextModules(APP_DIR), []);
  });

  it("contrats server/shared/*-types.ts : phrases affichées fixées sans mot interdit, raison « a-venir » fixée", () => {
    const dir = path.join(SERVER_DIR, "shared");
    const problems: Violation[] = [];
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith("-types.ts")).sort()) {
      checkLeaves(file, "partout", contractPhrases(fs.readFileSync(path.join(dir, file), "utf8")), true, problems);
    }
    assert.deepEqual(problems, []);
    const aVenir = aVenirPhrases(fs.readFileSync(path.join(dir, "autonomy-types.ts"), "utf8"));
    assert.equal(aVenir.length, 1, "autonomy-types.ts : la raison « a-venir » cite sa phrase affichée, reprise telle quelle par L9b et L10d");
  });

  it("MESSAGES : mots interdits en Simple seulement dans les exceptions nominatives, aucun mot interdit partout", () => {
    assert.deepEqual(checkMessages(MESSAGES, MESSAGES_EXCEPTIONS), []);
  });

  it("« réfléchit » : seulement les occurrences tolérées, chacune retirée par son paquet", () => {
    assert.deepEqual(checkReflechit(reflechitSources(), TOLERANCES_REFLECHIT), []);
  });
});
