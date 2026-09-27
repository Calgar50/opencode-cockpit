// Test « mouvement de la salle de contrôle » (spécification §5.5, §5.8 l.997 ; JP-13 ; plan d'exécution de l'itération 3, §4.2.4,
// D-3d-17, D-3d-22 ; paquet T3d-b). Applique à web/pages/salle-controle/** (.css, .ts, .tsx) les règles de web-animations.test.ts,
// qui n'est pas modifié (son périmètre est écrit en dur), par une lecture statique, sans navigateur ni dépendance :
// - aucune animation `infinite` (CSS, ou texte CSS dans une chaîne) ; aucune option WAAPI `iterations` autre qu'un nombre écrit ;
// - toute animation CSS (`animation`, `animation-name`, sauf `none`) sous `@media (prefers-reduced-motion: no-preference)` ;
// - aucune animation CSS en ligne (style React ou texte CSS dans une chaîne), qui ne peut pas être placée sous cette requête ;
// - un appel WAAPI `.animate(` seulement dans un fichier qui teste `prefers-reduced-motion: no-preference` ;
// - `requestAnimationFrame` seulement dans three/moteur.ts (boucle à la demande, D-3d-17) et fluidite.ts (sonde bornée à
//   90 images, L30) ; `setInterval` nulle part.
// Commentaires ignorés ; lexique recopié de web-animations.test.ts. Chaque règle échoue sur un source fabriqué. Tant que le dossier
// salle-controle/ n'existe pas (créé par T3d-a), le parcours du code réel est sauté avec sa raison, jamais un échec ; le train de
// V0 vérifie qu'il parcourt les fichiers réels.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const WEB_DIR = path.join(import.meta.dirname, "..", "web");

/** Périmètre, relatif à web/. */
const SALLE = "pages/salle-controle";

/** Seuls fichiers qui peuvent citer requestAnimationFrame (D-3d-22), relatifs à web/. */
const RAF_PERMIS = new Set([`${SALLE}/three/moteur.ts`, `${SALLE}/fluidite.ts`]);

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

// --- Lexique recopié de web-animations.test.ts --------------------------------------------------------------------------------

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

// --- Règles de la salle de contrôle ---------------------------------------------------------------------------------------------

function checkSalle(sources: readonly Source[]): Violation[] {
  const problems: Violation[] = [];
  for (const { fichier, texte } of sources) {
    if (!fichier.startsWith(`${SALLE}/`)) continue;
    const add = (index: number, regle: string) => problems.push({ fichier, ligne: lineAt(texte, index), regle });

    if (fichier.endsWith(".css")) {
      const code = cssCode(texte);
      for (const match of code.matchAll(/\binfinite\b/gi)) add(match.index ?? 0, "animation infinie (infinite)");
      for (const decl of cssDeclarations(code)) {
        const animating = (decl.prop === "animation" || decl.prop === "animation-name") && decl.value.toLowerCase() !== "none";
        if (animating && !decl.blocks.some((block) => block.startsWith("@media") && REDUCED_MOTION_OK.test(block))) {
          add(decl.index, "animation CSS hors @media (prefers-reduced-motion: no-preference)");
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
    }
    for (const match of code.matchAll(/\banimation(?:Name)?\s*:\s*["'`](?!none\b)/g)) {
      add(match.index ?? 0, "animation CSS en ligne : jamais sous prefers-reduced-motion");
    }
    for (const match of code.matchAll(/\biterations\s*:\s*([^,}\n)]+)/g)) {
      if (!/^\d+(?:\.\d+)?$/.test((match[1] ?? "").trim())) add(match.index ?? 0, "iterations non bornée par un nombre (Infinity interdit)");
    }
    if (/\.animate\s*\(/.test(code) && !literals.some((literal) => REDUCED_MOTION_OK.test(literal.text))) {
      add(code.search(/\.animate\s*\(/), "WAAPI sans test de prefers-reduced-motion: no-preference");
    }
    if (!RAF_PERMIS.has(fichier)) {
      for (const match of code.matchAll(/\brequestAnimationFrame\b/g)) add(match.index ?? 0, "requestAnimationFrame hors de three/moteur.ts et fluidite.ts");
    }
    for (const match of code.matchAll(/\bsetInterval\b/g)) add(match.index ?? 0, "setInterval interdit");
  }
  return problems.sort((a, b) => a.fichier.localeCompare(b.fichier) || a.ligne - b.ligne || a.regle.localeCompare(b.regle));
}

/** Sources .css, .ts et .tsx de web/pages/salle-controle/, chemins relatifs à web/ ; null si le dossier n'existe pas. */
function salleSources(): Source[] | null {
  const dir = path.join(WEB_DIR, SALLE);
  if (!fs.existsSync(dir)) return null;
  return (fs.readdirSync(dir, { recursive: true }) as string[])
    .map((entry) => `${SALLE}/${entry.replaceAll("\\", "/")}`)
    .filter((fichier) => /\.(?:css|tsx?)$/.test(fichier))
    .map((fichier) => ({ fichier, texte: fs.readFileSync(path.join(WEB_DIR, fichier), "utf8") }));
}

/** Règles relevées, triées. */
const rules = (problems: Violation[]) => problems.map((p) => p.regle).sort();

describe("salle3d-animations : contrôles discriminants", () => {
  const css = (texte: string, fichier = `${SALLE}/salle-controle.css`): Source => ({ fichier, texte });
  const ts = (texte: string, fichier = `${SALLE}/Scene3d.tsx`): Source => ({ fichier, texte });

  it("CSS : infinite refusé, même sous prefers-reduced-motion ; commentaires ignorés", () => {
    const source = css("@media (prefers-reduced-motion: no-preference) {\n  .halo { animation: pulse 2s ease-in-out infinite; }\n}");
    assert.deepEqual(checkSalle([source]), [{ fichier: source.fichier, ligne: 2, regle: "animation infinie (infinite)" }]);
    assert.deepEqual(checkSalle([css("/* animation: pulse 2s infinite */ .halo { opacity: 0.8 }")]), []);
  });

  it("CSS : animation hors @media (prefers-reduced-motion: no-preference) refusée ; dedans, none et keyframes permis", () => {
    assert.deepEqual(rules(checkSalle([css(".halo { animation: pulse 2s ease-in-out 3; }")])), ["animation CSS hors @media (prefers-reduced-motion: no-preference)"]);
    assert.deepEqual(rules(checkSalle([css("@media (prefers-reduced-motion: reduce) { .halo { animation-name: pulse; } }")])), [
      "animation CSS hors @media (prefers-reduced-motion: no-preference)",
    ]);
    const allowed = [
      "@media (prefers-reduced-motion: no-preference) { .halo { animation: pulse 2s ease-in-out 3; } }",
      ".halo { animation: none; transition: opacity 0.2s }",
      "@keyframes pulse { from { opacity: 0.6 } to { opacity: 1 } }",
    ];
    for (const texte of allowed) assert.deepEqual(checkSalle([css(texte)]), [], texte);
  });

  it("TS : iterations non numérique, animation en ligne et texte CSS infini refusés", () => {
    assert.deepEqual(rules(checkSalle([ts('if (matchMedia("(prefers-reduced-motion: no-preference)").matches) el.animate(k, { iterations: Infinity });')])), [
      "iterations non bornée par un nombre (Infinity interdit)",
    ]);
    assert.deepEqual(rules(checkSalle([ts("const o = { iterations: tours };")])), ["iterations non bornée par un nombre (Infinity interdit)"]);
    assert.deepEqual(rules(checkSalle([ts('return <div style={{ animationName: "pulse" }} />;')])), ["animation CSS en ligne : jamais sous prefers-reduced-motion"]);
    assert.deepEqual(rules(checkSalle([ts("const regle = `.halo { animation: pulse 2s infinite }`;")])), [
      "animation CSS en ligne : jamais sous prefers-reduced-motion",
      "animation infinie (infinite)",
    ]);
    assert.deepEqual(checkSalle([ts('const o = { iterations: 1 }; const off = { animation: "none" }; const t = "Animation : désactivée";')]), []);
  });

  it("TS : .animate( sans test de prefers-reduced-motion: no-preference refusé ; avec le test, permis", () => {
    assert.deepEqual(rules(checkSalle([ts("el.animate(k, { duration: 1000, iterations: 1 });")])), ["WAAPI sans test de prefers-reduced-motion: no-preference"]);
    assert.deepEqual(checkSalle([ts('if (matchMedia("(prefers-reduced-motion: no-preference)").matches) el.animate(k, { duration: 1000, iterations: 1 });')]), []);
  });

  it("requestAnimationFrame : permis dans three/moteur.ts et fluidite.ts seulement, appel ou simple référence", () => {
    const raf = "export const sonder = (raf = requestAnimationFrame) => raf(() => undefined);";
    assert.deepEqual(checkSalle([ts(raf, `${SALLE}/three/moteur.ts`), ts(raf, `${SALLE}/fluidite.ts`)]), []);
    for (const fichier of [`${SALLE}/Scene3d.tsx`, `${SALLE}/useFluidite.ts`, `${SALLE}/three/graphe.ts`, `${SALLE}/revoir/fluidite.ts`]) {
      assert.deepEqual(rules(checkSalle([ts(raf, fichier)])), ["requestAnimationFrame hors de three/moteur.ts et fluidite.ts"], fichier);
    }
    assert.deepEqual(rules(checkSalle([ts("window.requestAnimationFrame(step);", `${SALLE}/SalleControlePage.tsx`)])), [
      "requestAnimationFrame hors de three/moteur.ts et fluidite.ts",
    ]);
    assert.deepEqual(checkSalle([ts("// requestAnimationFrame(step) : jamais ici\nexport const x = 1;")]), []);
  });

  it("setInterval : refusé partout, fichiers permis pour requestAnimationFrame compris ; commentaire ignoré", () => {
    for (const fichier of [`${SALLE}/three/moteur.ts`, `${SALLE}/fluidite.ts`, `${SALLE}/revoir/ReplayBar.tsx`]) {
      assert.deepEqual(rules(checkSalle([ts("const t = window.setInterval(tick, 16);", fichier)])), ["setInterval interdit"], fichier);
    }
    assert.deepEqual(checkSalle([ts("/* setInterval(tick, 16) */ clearInterval(t);")]), []);
  });

  it("hors de salle-controle/ : non contrôlé (web-animations.test.ts garde son propre périmètre)", () => {
    const outside = [
      css(".spinner { animation: spin 0.7s linear infinite; }", "styles.css"),
      ts("setInterval(tick, 100); requestAnimationFrame(step);", "pages/diagnostics/LogsViewer.tsx"),
      ts("el.animate(k, { iterations: Infinity });", "pages/salle-controle-bis/Autre.tsx"),
    ];
    assert.deepEqual(checkSalle(outside), []);
  });
});

describe("salle3d-animations : web/pages/salle-controle/", () => {
  const sources = salleSources();
  const raison = "dossier web/pages/salle-controle/ absent de cette copie (créé par T3d-a) : parcours vide, le train de V0 vérifie qu'il parcourt les fichiers réels";
  it("aucune animation infinie, toute animation sous prefers-reduced-motion: no-preference, boucles seulement dans les fichiers permis", { skip: sources === null ? raison : false }, () => {
    assert.ok(sources !== null && sources.length > 0, "dossier présent : au moins un fichier .css, .ts ou .tsx parcouru");
    assert.deepEqual(checkSalle(sources ?? []), []);
  });
});
