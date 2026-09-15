// Test « textes » (spécification §2.2, §2.3 ; plan d'exécution §4.6, T0) : mots interdits en mode Simple, interdits partout et
// bannis, un sens par mot, « étape » accolé au nombre `steps`.
//
// Modules contrôlés, découverts par leur nom (aucun paquet n'a à éditer ce test pour être contrôlé) :
// - server/shared/*-texts.ts : exportent `TEXTES = { simple, avance, partout }` (textes affichés en Simple seulement, en Avancé
//   seulement, dans les deux modes), ou `TEXTES_VARIANTES = { <variante>: { simple, avance, partout } }` (par exemple avec et sans
//   IA de contrôle) : chaque variante est contrôlée. Chaque feuille est une chaîne (valeurs en gabarit « {nom} »), jamais une
//   fonction : un module formate ses gabarits dans des fonctions exportées à part ;
// - server/shared/neon-*.ts : mêmes exports s'ils portent des textes ; sinon leurs chaînes exportées sont contrôlées comme « partout » ;
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
  { fichier: "web/pages/ChatPage.tsx", extrait: "L'assistant réfléchit…", paquet: "T2" },
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

function checkTextModule(file: string, exports: Record<string, unknown>): Violation[] {
  const problems: Violation[] = [];
  const unSens = UN_SENS_MODULES.test(file);
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
  if (variants.length === 0) {
    if (file.endsWith("-texts.ts")) {
      problems.push({ source: file, chemin: "", regle: "structure", mot: "exporter TEXTES ou TEXTES_VARIANTES" });
      return problems;
    }
    // neon-*.ts sans textes structurés : chaînes exportées contrôlées comme « partout » (fonctions ignorées).
    const leaves: Leaf[] = [];
    for (const [name, value] of Object.entries(exports)) collectLeaves(value, name, leaves, problems, file, false);
    checkLeaves(file, "partout", leaves, unSens, problems);
    return problems;
  }
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
    }
  }
  return problems;
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
      problems.push(...checkTextModule(file, { ...exports }));
    }
    assert.deepEqual(problems, []);
  });

  it("MESSAGES : mots interdits en Simple seulement dans les exceptions nominatives, aucun mot interdit partout", () => {
    assert.deepEqual(checkMessages(MESSAGES, MESSAGES_EXCEPTIONS), []);
  });

  it("« réfléchit » : seulement les occurrences tolérées, chacune retirée par son paquet", () => {
    assert.deepEqual(checkReflechit(reflechitSources(), TOLERANCES_REFLECHIT), []);
  });
});
