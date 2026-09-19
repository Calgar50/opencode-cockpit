// Test « web-animations » (1.1, T2 ; spécification §5.5 et JP-13 ; plan d'exécution, fiche T2). Lecture statique des sources de
// l'interface 1.1, sans navigateur ni dépendance :
// - dans web/pages/chat/{activity,autonomy,delegation,plan}/** et web/pages/diagnostics/** (.css, .ts, .tsx) : aucune animation
//   `infinite`, aucune option WAAPI `iterations` autre qu'un nombre écrit en clair (donc jamais Infinity) ; toute animation CSS
//   (`animation`, `animation-name`, sauf `none`) sous `@media (prefers-reduced-motion: no-preference)` ; aucune animation CSS en
//   ligne (style React ou texte CSS dans une chaîne), qui ne peut pas être placée sous cette requête ; un appel WAAPI `.animate(`
//   seulement dans un fichier qui teste `prefers-reduced-motion: no-preference` ;
// - NeonBand.tsx, neon.css et DemoPlayer.tsx (où qu'ils soient sous web/) : aucune boucle du tout (Infinity, setInterval,
//   requestAnimationFrame, `iterations` ou nombre de répétitions CSS différent de 1, `alternate`, while (true), for (;;)).
// Commentaires ignorés. Les contrôles discriminants font échouer chaque règle sur un source fabriqué, dont une mutation d'un
// squelette réel (animation infinite ajoutée).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const WEB_DIR = path.join(import.meta.dirname, "..", "web");

/** Dossiers de l'interface 1.1 soumis aux règles de mouvement (relatifs à web/). */
const SCOPES = ["pages/chat/activity", "pages/chat/autonomy", "pages/chat/delegation", "pages/chat/plan", "pages/diagnostics"];
// --- équipes (it4) : début ---
// Itération 4 (T4w) : dossiers des équipes et de la carte des assistants.
SCOPES.push("pages/chat/team", "pages/assistants/teams", "pages/assistants/carte");
/** Fichiers soumis aux mêmes règles hors de ces dossiers (relatifs à web/) : onglets de la page Assistants. */
const SCOPE_FILES = new Set(["pages/assistants/assistants-tabs.css", "pages/assistants/AssistantsTabs.tsx"]);
// --- équipes (it4) : fin ---

/** Fichiers sans aucune boucle (nom de fichier, où qu'il soit sous web/). */
const NO_LOOP_FILES = new Set(["NeonBand.tsx", "neon.css", "DemoPlayer.tsx"]);

const REDUCED_MOTION_OK = /prefers-reduced-motion\s*:\s*no-preference/i;

interface Source {
  /** Chemin relatif à web/, séparateur « / ». */
  fichier: string;
  texte: string;
}

interface Violation {
  fichier: string;
  ligne: number;
  regle: string;
}

// --- équipes (it4) : début ---
const inScope = (fichier: string) => SCOPES.some((scope) => fichier.startsWith(`${scope}/`)) || SCOPE_FILES.has(fichier);
// --- équipes (it4) : fin ---
const isNoLoop = (fichier: string) => NO_LOOP_FILES.has(path.posix.basename(fichier));
const lineAt = (text: string, index: number) => text.slice(0, index).split("\n").length;
const blank = (text: string) => text.replace(/[^\n]/g, " ");

/** CSS sans commentaires (positions et lignes gardées). */
function cssCode(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, blank);
}

/** TS/TSX sans commentaires (positions gardées) et contenus des chaînes littérales. */
function lexTs(text: string): { code: string; literals: Array<{ start: number; text: string }> } {
  let code = "";
  const literals: Array<{ start: number; text: string }> = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i] ?? "";
    const next = text[i + 1];
    if (c === "/" && (next === "/" || next === "*")) {
      const end = next === "/" ? text.indexOf("\n", i) : text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : next === "/" ? end : end + 2;
      code += blank(text.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) {
        if (text[j] === "\\") j++;
        else if (c !== "`" && text[j] === "\n") break;
        j++;
      }
      literals.push({ start: i + 1, text: text.slice(i + 1, j) });
      const stop = Math.min(j + 1, text.length);
      code += text.slice(i, stop);
      i = stop;
      continue;
    }
    code += c;
    i++;
  }
  return { code, literals };
}

/** Déclarations CSS avec les en-têtes des blocs qui les contiennent. */
function cssDeclarations(code: string): Array<{ prop: string; value: string; index: number; blocks: string[] }> {
  const out: Array<{ prop: string; value: string; index: number; blocks: string[] }> = [];
  const stack: string[] = [];
  let buffer = "";
  let start = 0;
  const flush = () => {
    const match = /^\s*([\w-]+)\s*:([\s\S]*)$/.exec(buffer);
    if (match && stack.length > 0) out.push({ prop: (match[1] ?? "").toLowerCase(), value: (match[2] ?? "").trim(), index: start, blocks: [...stack] });
  };
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === "{") {
      stack.push(buffer.trim());
      buffer = "";
      start = i + 1;
    } else if (c === ";" || c === "}") {
      flush();
      if (c === "}") stack.pop();
      buffer = "";
      start = i + 1;
    } else {
      buffer += c;
    }
  }
  return out;
}

/** Nombres de répétitions d'une valeur `animation` (jetons numériques sans unité, hors fonctions). */
function shorthandIterationCounts(value: string): string[] {
  return value
    .replace(/\([^()]*\)/g, " ")
    .split(/[\s,]+/)
    .filter((token) => /^\d*\.?\d+$/.test(token));
}

function checkAnimations(sources: readonly Source[]): Violation[] {
  const problems: Violation[] = [];
  for (const { fichier, texte } of sources) {
    const scoped = inScope(fichier);
    const noLoop = isNoLoop(fichier);
    if (!scoped && !noLoop) continue;
    const add = (index: number, regle: string) => problems.push({ fichier, ligne: lineAt(texte, index), regle });

    if (fichier.endsWith(".css")) {
      const code = cssCode(texte);
      for (const match of code.matchAll(/\binfinite\b/gi)) add(match.index ?? 0, "animation infinie (infinite)");
      for (const decl of cssDeclarations(code)) {
        const animating = (decl.prop === "animation" || decl.prop === "animation-name") && decl.value.toLowerCase() !== "none";
        if (animating && !decl.blocks.some((block) => block.startsWith("@media") && REDUCED_MOTION_OK.test(block))) {
          add(decl.index, "animation CSS hors @media (prefers-reduced-motion: no-preference)");
        }
        if (!noLoop) continue;
        if (decl.prop === "animation-iteration-count" && decl.value !== "1") add(decl.index, "boucle : animation-iteration-count différent de 1");
        if (decl.prop === "animation" || decl.prop === "animation-direction") {
          if (shorthandIterationCounts(decl.value).some((n) => n !== "1")) add(decl.index, "boucle : répétitions CSS différentes de 1");
          if (/\balternate\b/i.test(decl.value)) add(decl.index, "boucle : alternate");
        }
      }
      continue;
    }

    if (!/\.tsx?$/.test(fichier)) continue;
    const { code, literals } = lexTs(texte);
    for (const literal of literals) {
      for (const match of literal.text.matchAll(/\binfinite\b/gi)) add(literal.start + (match.index ?? 0), "animation infinie (infinite)");
      // Texte CSS (propriété en minuscules collée à « : ») ; « Animation : … » d'un texte français n'est pas du CSS.
      for (const match of literal.text.matchAll(/\banimation(?:-name)?:\s*(?!\s|none\b)/g)) {
        add(literal.start + (match.index ?? 0), "animation CSS en ligne : jamais sous prefers-reduced-motion");
      }
      if (noLoop) for (const match of literal.text.matchAll(/\balternate\b/gi)) add(literal.start + (match.index ?? 0), "boucle : alternate");
    }
    for (const match of code.matchAll(/\banimation(?:Name)?\s*:\s*["'`](?!none\b)/g)) {
      add(match.index ?? 0, "animation CSS en ligne : jamais sous prefers-reduced-motion");
    }
    for (const match of code.matchAll(/\biterations\s*:\s*([^,}\n)]+)/g)) {
      const value = (match[1] ?? "").trim();
      if (!/^\d+(?:\.\d+)?$/.test(value)) add(match.index ?? 0, "iterations non bornée par un nombre (Infinity interdit)");
      else if (noLoop && value !== "1") add(match.index ?? 0, "boucle : iterations différent de 1");
    }
    if (/\.animate\s*\(/.test(code) && !literals.some((literal) => REDUCED_MOTION_OK.test(literal.text))) {
      add(code.search(/\.animate\s*\(/), "WAAPI sans test de prefers-reduced-motion: no-preference");
    }
    if (noLoop) {
      const loops: Array<[RegExp, string]> = [
        [/\bInfinity\b|\bPOSITIVE_INFINITY\b/g, "boucle : Infinity"],
        [/\bsetInterval\s*\(/g, "boucle : setInterval"],
        [/\brequestAnimationFrame\s*\(/g, "boucle : requestAnimationFrame"],
        [/\bwhile\s*\(\s*true\s*\)/g, "boucle : while (true)"],
        [/\bfor\s*\(\s*;\s*;\s*\)/g, "boucle : for (;;)"],
      ];
      for (const [re, regle] of loops) for (const match of code.matchAll(re)) add(match.index ?? 0, regle);
    }
  }
  return problems.sort((a, b) => a.fichier.localeCompare(b.fichier) || a.ligne - b.ligne || a.regle.localeCompare(b.regle));
}

/** Sources .css, .ts et .tsx de web/, chemins relatifs à web/. */
function webSources(): Source[] {
  return (fs.readdirSync(WEB_DIR, { recursive: true }) as string[])
    .map((entry) => entry.replaceAll("\\", "/"))
    .filter((entry) => /\.(?:css|tsx?)$/.test(entry))
    .map((fichier) => ({ fichier, texte: fs.readFileSync(path.join(WEB_DIR, fichier), "utf8") }));
}

/** Règles relevées, triées (ordre des unités de code). */
const rules = (problems: Violation[]) => problems.map((p) => p.regle).sort();

describe("web-animations : contrôles discriminants", () => {
  const css = (texte: string, fichier = "pages/chat/activity/activity.css"): Source => ({ fichier, texte });
  const tsx = (texte: string, fichier = "pages/chat/autonomy/AutonomyBanner.tsx"): Source => ({ fichier, texte });

  it("CSS : infinite refusé, même sous prefers-reduced-motion", () => {
    const source = css("@media (prefers-reduced-motion: no-preference) {\n  .x { animation: spin 1s linear infinite; }\n}");
    assert.deepEqual(checkAnimations([source]), [{ fichier: source.fichier, ligne: 2, regle: "animation infinie (infinite)" }]);
  });

  it("CSS : animation hors @media (prefers-reduced-motion: no-preference) refusée ; dedans, none et commentaires permis", () => {
    assert.deepEqual(rules(checkAnimations([css(".x { animation: fade 900ms ease-out; }")])), [
      "animation CSS hors @media (prefers-reduced-motion: no-preference)",
    ]);
    assert.deepEqual(rules(checkAnimations([css("@media (prefers-reduced-motion: reduce) { .x { animation-name: fade; } }")])), [
      "animation CSS hors @media (prefers-reduced-motion: no-preference)",
    ]);
    const allowed = [
      "@media (prefers-reduced-motion: no-preference) { .x { animation: fade 900ms ease-out; } }",
      "@media (prefers-reduced-motion: no-preference) and (min-width: 900px) { .x .y { animation-name: fade; animation-duration: 1s } }",
      ".x { animation: none; transition: opacity 0.2s }",
      "/* animation: spin 1s infinite */ .x { color: red }",
      "@keyframes fade { from { opacity: 0 } to { opacity: 1 } }",
    ];
    for (const texte of allowed) assert.deepEqual(checkAnimations([css(texte)]), [], texte);
  });

  it("TS : iterations Infinity ou non numérique, animation en ligne, texte CSS infini et WAAPI sans test refusés", () => {
    assert.deepEqual(rules(checkAnimations([tsx("el.animate(frames, { duration: 900, iterations: Infinity });")])), [
      "WAAPI sans test de prefers-reduced-motion: no-preference",
      "iterations non bornée par un nombre (Infinity interdit)",
    ]);
    assert.deepEqual(rules(checkAnimations([tsx("const o = { iterations: count };")])), ["iterations non bornée par un nombre (Infinity interdit)"]);
    assert.deepEqual(rules(checkAnimations([tsx('return <span style={{ animation: "pulse 1s" }} />;')])), [
      "animation CSS en ligne : jamais sous prefers-reduced-motion",
    ]);
    assert.deepEqual(rules(checkAnimations([tsx("const rule = `.x { animation: spin 1s linear infinite }`;")])), [
      "animation CSS en ligne : jamais sous prefers-reduced-motion",
      "animation infinie (infinite)",
    ]);
  });

  it("TS : WAAPI borné derrière matchMedia, commentaires et setInterval hors fichiers sans boucle permis", () => {
    const allowed = [
      'if (matchMedia("(prefers-reduced-motion: no-preference)").matches) el.animate(frames, { duration: 900, iterations: 1 });',
      "// iterations: Infinity, animation: spin infinite\nexport const x = 1;",
      "/* setInterval(tick, 10) */ const timer = window.setInterval(load, 10_000);",
      "export interface Props { animationFrames: number }",
      'const off = { animation: "none" }; const css = ".x { animation: none }"; const texte = "Animation : désactivée";',
    ];
    for (const texte of allowed) assert.deepEqual(checkAnimations([tsx(texte, "pages/diagnostics/LogsViewer.tsx")]), [], texte);
  });

  it("fichiers sans boucle : Infinity, setInterval, requestAnimationFrame, répétitions ≠ 1, alternate refusés", () => {
    const neon = (texte: string) => tsx(texte, "pages/chat/activity/NeonBand.tsx");
    assert.deepEqual(rules(checkAnimations([neon("const timer = setInterval(tick, 100);")])), ["boucle : setInterval"]);
    assert.deepEqual(rules(checkAnimations([neon("requestAnimationFrame(step);")])), ["boucle : requestAnimationFrame"]);
    assert.deepEqual(rules(checkAnimations([neon("const max = Number.POSITIVE_INFINITY;")])), ["boucle : Infinity"]);
    assert.deepEqual(rules(checkAnimations([neon('if (matchMedia("(prefers-reduced-motion: no-preference)").matches) el.animate(k, { iterations: 2 });')])), [
      "boucle : iterations différent de 1",
    ]);
    assert.deepEqual(rules(checkAnimations([neon("while (true) { step(); }")])), ["boucle : while (true)"]);
    const neonCss = (texte: string) => css(`@media (prefers-reduced-motion: no-preference) { ${texte} }`, "pages/chat/activity/neon.css");
    assert.deepEqual(rules(checkAnimations([neonCss(".b { animation: glow 900ms ease 3; }")])), ["boucle : répétitions CSS différentes de 1"]);
    assert.deepEqual(rules(checkAnimations([neonCss(".b { animation: glow 900ms ease alternate; }")])), ["boucle : alternate"]);
    assert.deepEqual(rules(checkAnimations([neonCss(".b { animation-iteration-count: 2; }")])), ["boucle : animation-iteration-count différent de 1"]);
    assert.deepEqual(checkAnimations([neonCss(".b { animation: glow 900ms cubic-bezier(0.2, 0, 0, 1) 1 forwards; }")]), []);
    // Le même setInterval est permis ailleurs dans le périmètre (LogsViewer) : la règle « sans boucle » vise ces fichiers seuls.
    assert.deepEqual(checkAnimations([tsx("setInterval(tick, 100);", "pages/chat/activity/ActorList.tsx")]), []);
    // DemoPlayer.tsx est aussi sans boucle, même déplacé hors du périmètre.
    assert.deepEqual(rules(checkAnimations([tsx("setInterval(next, 500);", "pages/demo/DemoPlayer.tsx")])), ["boucle : setInterval"]);
  });

  it("hors périmètre (styles.css, autres pages) : non contrôlé", () => {
    const outside = [
      css(".spinner { animation: spin 0.7s linear infinite; }", "styles.css"),
      tsx('<span style={{ animation: "pulse 1s infinite" }} />', "pages/chat/MessageView.tsx"),
      tsx("el.animate(k, { iterations: Infinity });", "pages/chat/activityx/Other.tsx"),
    ];
    assert.deepEqual(checkAnimations(outside), []);
  });

  it("mutation d'un squelette réel : une animation infinite ajoutée fait échouer le test", () => {
    const fichier = "pages/chat/activity/ActivityRegion.tsx";
    const texte = fs.readFileSync(path.join(WEB_DIR, fichier), "utf8");
    assert.deepEqual(checkAnimations([{ fichier, texte }]), []);
    const mutated = texte.replace("return null;", 'return <span style={{ animation: "spin 1s linear infinite" }} />;');
    assert.notEqual(mutated, texte);
    assert.deepEqual(rules(checkAnimations([{ fichier, texte: mutated }])), [
      "animation CSS en ligne : jamais sous prefers-reduced-motion",
      "animation infinie (infinite)",
    ]);
  });
});

describe("web-animations : interface 1.1", () => {
  it("périmètre présent : dossiers 1.1 et fichiers sans boucle", () => {
    for (const scope of SCOPES) assert.ok(fs.statSync(path.join(WEB_DIR, scope)).isDirectory(), scope);
    const names = new Set(webSources().map((s) => path.posix.basename(s.fichier)));
    for (const name of ["NeonBand.tsx", "DemoPlayer.tsx"]) assert.ok(names.has(name), name);
  });

  it("aucune animation infinie, toute animation sous prefers-reduced-motion: no-preference, aucune boucle dans la bande néon", () => {
    assert.deepEqual(checkAnimations(webSources()), []);
  });
});
// --- équipes (it4) : début ---

describe("web-animations : périmètre des équipes et de la carte (it4, T4w)", () => {
  it("dossiers des équipes et de la carte et onglets de la page Assistants : présents et contrôlés, le reste de la page non", () => {
    for (const fichier of SCOPE_FILES) assert.ok(fs.statSync(path.join(WEB_DIR, fichier)).isFile(), fichier);
    for (const fichier of ["pages/chat/team/x.css", "pages/assistants/teams/x.tsx", "pages/assistants/carte/x.ts", ...SCOPE_FILES]) {
      assert.ok(inScope(fichier), fichier);
    }
    for (const fichier of ["pages/assistants/assistants.css", "pages/assistants/AssistantWizard.tsx", "pages/chat/teamx/x.css"]) {
      assert.ok(!inScope(fichier), fichier);
    }
  });

  it("mutation de la feuille des onglets : une animation infinie hors prefers-reduced-motion fait échouer le test", () => {
    const fichier = "pages/assistants/assistants-tabs.css";
    const texte = fs.readFileSync(path.join(WEB_DIR, fichier), "utf8");
    assert.deepEqual(checkAnimations([{ fichier, texte }]), []);
    const mutated = `${texte}\n.ast-tab { animation: pulse 1s linear infinite; }\n`;
    assert.deepEqual(rules(checkAnimations([{ fichier, texte: mutated }])), [
      "animation CSS hors @media (prefers-reduced-motion: no-preference)",
      "animation infinie (infinite)",
    ]);
  });
});
// --- équipes (it4) : fin ---
