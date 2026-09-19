// Règle d'import de three (itération 3, L32 ; plan it3 D-3d-05 ; spécification §5.8 l.996, JP-11). Lecture lexicale de
// web/**/*.{ts,tsx}, commentaires, chaînes et gabarits ignorés :
// - un spécificateur qui commence par « three » (import statique, dynamique, export … from, require) n'est permis que dans
//   web/pages/salle-controle/three/**, et seulement égal à « three » : jamais three/webgpu, three/tsl, three/addons ni
//   three/src/… ; un `import type` de « three » est permis partout (effacé), sous ce seul nom ; dans ce dossier, jamais par
//   import("three") dynamique (train de V0, MX-3D M3D-3 : non élagué, +30,8 % en gzip) ;
// - hors de ce dossier, un chemin vers web/pages/salle-controle/three/ n'est permis que dans
//   web/pages/salle-controle/moteur-chargeur.ts, par import("./three/moteur.ts") dynamique ; un `import type` est permis partout ;
// - un import dynamique non littéral (gabarit à substitution, variable) qui cite three est refusé ; import.meta.glob compte comme
//   un import dynamique ;
// - vite.config.ts n'importe pas three ; les modules de production du serveur (server/**, hors tests et test-support) non plus,
//   sauf en `import type` : three est une dépendance de développement, retirée de l'image (npm prune --omit=dev). Les tests de
//   server/ peuvent importer three et three/.
// Contrôle du lecteur : sur chaque fichier réel, il retrouve chaque « import|export … from "…" » et « import "…" » en début de
// ligne. Contrôles discriminants sur des sources fabriquées et sur un fichier réel muté.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const APP_DIR = path.join(import.meta.dirname, "..");
const DOSSIER_THREE = "web/pages/salle-controle/three/";
const CHARGEUR = "web/pages/salle-controle/moteur-chargeur.ts";
/** Cible du seul import dynamique permis hors de three/ (sans extension). */
const MOTEUR = "web/pages/salle-controle/three/moteur";

// --- Lecteur lexical -------------------------------------------------------------------------------------------------------------

type Genre = "mot" | "chaine" | "gabarit" | "regex" | "ponct";

interface Jeton {
  genre: Genre;
  valeur: string;
  debut: number;
  fin: number;
}

/** Mots après lesquels « / » ouvre une expression régulière (et non une division). */
const MOTS_AVANT_EXPRESSION = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await", "default", "extends"]);

/**
 * Jetons d'un source TS ou TSX : commentaires sautés ; chaîne (y compris gabarit sans substitution, `valeur` = contenu) ;
 * gabarit à substitution (jeton « gabarit » au début et à la fin, code des substitutions lu comme du code) ; expression régulière
 * (heuristique : « / » qui ne suit pas une fin d'expression, fermée sur la même ligne) ; mots et ponctuation.
 */
function jetons(texte: string): Jeton[] {
  const sortie: Jeton[] = [];
  /** Profondeurs d'accolades auxquelles une substitution `${…}` se referme. */
  const reprises: number[] = [];
  let profondeur = 0;
  /** Vrai si « / » est ici une division ou la fin d'une balise JSX « </ », jamais le début d'une expression régulière. */
  const pasDeRegex = () => {
    const dernier = sortie.at(-1);
    if (!dernier) return false;
    if (dernier.genre === "mot") return !MOTS_AVANT_EXPRESSION.has(dernier.valeur);
    if (dernier.genre === "ponct") return dernier.valeur === ")" || dernier.valeur === "]" || dernier.valeur === "}" || dernier.valeur === "<";
    return true;
  };
  /** Suite d'un gabarit depuis `depart` (après « ` » ou après la « } » d'une substitution) ; rend l'indice suivant. */
  const gabarit = (depart: number, ouverture: number, premier: boolean): number => {
    for (let j = depart; j < texte.length; j++) {
      const c = texte[j];
      if (c === "\\") {
        j++;
      } else if (c === "`") {
        sortie.push({ genre: premier ? "chaine" : "gabarit", valeur: premier ? texte.slice(depart, j) : "", debut: ouverture, fin: j + 1 });
        return j + 1;
      } else if (c === "$" && texte[j + 1] === "{") {
        if (premier) sortie.push({ genre: "gabarit", valeur: texte.slice(depart, j), debut: ouverture, fin: j });
        reprises.push(profondeur);
        return j + 2;
      }
    }
    return texte.length;
  };
  let i = 0;
  while (i < texte.length) {
    const c = texte[i] ?? "";
    const suivant = texte[i + 1];
    if (/\s/.test(c)) {
      i++;
    } else if (c === "/" && (suivant === "/" || suivant === "*")) {
      const fin = suivant === "/" ? texte.indexOf("\n", i) : texte.indexOf("*/", i + 2);
      i = fin === -1 ? texte.length : suivant === "/" ? fin : fin + 2;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < texte.length && texte[j] !== c && texte[j] !== "\n") j += texte[j] === "\\" ? 2 : 1;
      if (texte[j] === c) {
        sortie.push({ genre: "chaine", valeur: texte.slice(i + 1, j), debut: i, fin: j + 1 });
        i = j + 1;
      } else {
        // Guillemet non fermé sur sa ligne : apostrophe d'un texte JSX (« L'IA »), simple ponctuation.
        sortie.push({ genre: "ponct", valeur: c, debut: i, fin: i + 1 });
        i++;
      }
    } else if (c === "`") {
      i = gabarit(i + 1, i, true);
    } else if (c === "}" && reprises.length > 0 && profondeur === reprises.at(-1)) {
      reprises.pop();
      i = gabarit(i + 1, i, false);
    } else if (c === "/" && !pasDeRegex()) {
      i = expressionReguliere(texte, i, sortie);
    } else if (/[\p{L}_$]/u.test(c)) {
      let j = i + 1;
      while (j < texte.length && /[\p{L}\p{N}_$]/u.test(texte[j] ?? "")) j++;
      sortie.push({ genre: "mot", valeur: texte.slice(i, j), debut: i, fin: j });
      i = j;
    } else if (/\d/.test(c)) {
      let j = i + 1;
      while (j < texte.length && /[\w.]/.test(texte[j] ?? "")) j++;
      sortie.push({ genre: "mot", valeur: texte.slice(i, j), debut: i, fin: j });
      i = j;
    } else {
      if (c === "{") profondeur++;
      else if (c === "}") profondeur--;
      sortie.push({ genre: "ponct", valeur: c, debut: i, fin: i + 1 });
      i++;
    }
  }
  return sortie;
}

/**
 * Expression régulière qui commence en `debut` : jusqu'au « / » non échappé hors d'une classe, sur la même ligne. Rend l'indice
 * qui suit ses drapeaux ; si elle ne se ferme pas sur la ligne, le « / » est une simple ponctuation. Le jeton lu est ajouté à
 * `sortie`.
 */
function expressionReguliere(texte: string, debut: number, sortie: Jeton[]): number {
  let classe = false;
  for (let j = debut + 1; j < texte.length && texte[j] !== "\n"; j++) {
    const c = texte[j];
    if (c === "\\") j++;
    else if (c === "[") classe = true;
    else if (c === "]") classe = false;
    else if (c === "/" && !classe) {
      let fin = j + 1;
      while (fin < texte.length && /[a-z]/i.test(texte[fin] ?? "")) fin++;
      sortie.push({ genre: "regex", valeur: texte.slice(debut, fin), debut, fin });
      return fin;
    }
  }
  sortie.push({ genre: "ponct", valeur: "/", debut, fin: debut + 1 });
  return debut + 1;
}

/** `require` compte comme un import statique ; il a sa forme pour le contrôle du lecteur. */
type Forme = "statique" | "require" | "dynamique" | "export" | "type" | "non-litteral";

interface ImportTrouve {
  specificateur: string;
  forme: Forme;
  ligne: number;
}

/** Imports d'un source : déclarations, export … from, import(), import.meta.glob(), require(). */
function lireImports(texte: string): ImportTrouve[] {
  const js = jetons(texte);
  const trouves: ImportTrouve[] = [];
  const ligne = (index: number) => texte.slice(0, index).split("\n").length;
  const est = (k: number, genre: Genre, valeur?: string) => js[k]?.genre === genre && (valeur === undefined || js[k]?.valeur === valeur);
  const ajouter = (k: number, forme: Forme, debut: number) => trouves.push({ specificateur: js[k]?.valeur ?? "", forme, ligne: ligne(debut) });
  /** Appel dont la parenthèse ouvrante est en `k` : argument littéral, sinon texte brut s'il cite three. Rend l'indice fermant. */
  const appel = (k: number, forme: Forme, debut: number): number => {
    let fin = k;
    for (let d = 0; fin < js.length; fin++) {
      if (est(fin, "ponct", "(")) d++;
      else if (est(fin, "ponct", ")") && --d === 0) break;
    }
    if (est(k + 1, "chaine") && (est(k + 2, "ponct", ")") || est(k + 2, "ponct", ","))) ajouter(k + 1, forme, debut);
    else {
      const brut = texte.slice(js[k]?.debut ?? 0, js[fin]?.fin ?? texte.length);
      if (/three/.test(brut)) trouves.push({ specificateur: brut, forme: "non-litteral", ligne: ligne(debut) });
    }
    return fin;
  };
  /** Clause d'import ou d'export depuis `k` : mots et « { } , * » jusqu'à `from "…"` ; rend l'indice de la chaîne ou -1. */
  const source = (k: number): number => {
    for (let m = k; m < js.length; m++) {
      if (est(m, "mot", "from") && est(m + 1, "chaine")) return m + 1;
      if (!(est(m, "mot") || (est(m, "ponct") && "{},*".includes(js[m]?.valeur ?? "")))) return -1;
    }
    return -1;
  };
  for (let k = 0; k < js.length; k++) {
    const jeton = js[k];
    if (jeton?.genre !== "mot" || est(k - 1, "ponct", ".")) continue;
    if (jeton.valeur === "import") {
      if (est(k + 1, "ponct", "(")) {
        k = appel(k + 1, est(k - 1, "mot", "typeof") ? "type" : "dynamique", jeton.debut);
      } else if (est(k + 1, "ponct", ".")) {
        if (est(k + 2, "mot", "meta") && est(k + 3, "ponct", ".") && est(k + 4, "mot", "glob") && est(k + 5, "ponct", "(")) k = appel(k + 5, "dynamique", jeton.debut);
      } else if (est(k + 1, "chaine")) {
        ajouter(k + 1, "statique", jeton.debut);
      } else {
        // « import type from "x" » et « import type, { … } » importent une valeur nommée `type`.
        const typeSeul = est(k + 1, "mot", "type") && !est(k + 2, "mot", "from") && !est(k + 2, "ponct", ",");
        const s = source(k + 1);
        if (s !== -1) ajouter(s, typeSeul ? "type" : "statique", jeton.debut);
      }
    } else if (jeton.valeur === "export") {
      const typeSeul = est(k + 1, "mot", "type") && (est(k + 2, "ponct", "{") || est(k + 2, "ponct", "*"));
      const m = typeSeul ? k + 2 : k + 1;
      if (!est(m, "ponct", "{") && !est(m, "ponct", "*")) continue;
      // Clause fermée par « } » (ou « * [as nom] ») puis `from "…"` ; sinon export local.
      let fin = m;
      if (est(m, "ponct", "{")) while (fin < js.length && !est(fin, "ponct", "}")) fin++;
      else if (est(m + 1, "mot", "as")) fin = m + 2;
      if (est(fin + 1, "mot", "from") && est(fin + 2, "chaine")) ajouter(fin + 2, typeSeul ? "type" : "export", jeton.debut);
    } else if (jeton.valeur === "require" && est(k + 1, "ponct", "(")) {
      k = appel(k + 1, "require", jeton.debut);
    }
  }
  return trouves;
}

// --- Règle -----------------------------------------------------------------------------------------------------------------------

const sansExtension = (chemin: string) => chemin.replace(/\.(?:[cm]?[jt]sx?)$/, "");

/** Cible (relative à app/) d'un chemin relatif, ou absolu depuis la racine de Vite (web/) ; null pour un nom de paquet. */
function cible(fichier: string, specificateur: string): string | null {
  if (/^\.\.?(?:\/|$)/.test(specificateur)) return path.posix.normalize(path.posix.join(path.posix.dirname(fichier), specificateur));
  if (specificateur.startsWith("/")) return path.posix.normalize(path.posix.join("web", specificateur));
  return null;
}

const versDossierThree = (chemin: string | null) => chemin !== null && `${chemin}/`.startsWith(DOSSIER_THREE);

/** Violations d'un fichier de web/ (chemin relatif à app/, séparateur « / »). */
function violationsWeb(fichier: string, imports: readonly ImportTrouve[]): string[] {
  const dansThree = fichier.startsWith(DOSSIER_THREE);
  const violations: string[] = [];
  for (const { specificateur, forme, ligne } of imports) {
    const ou = `${fichier}:${ligne}`;
    if (forme === "non-litteral") {
      violations.push(`${ou} : import non littéral qui cite three`);
    } else if (specificateur.startsWith("three")) {
      if (specificateur !== "three") violations.push(`${ou} : « ${specificateur} » interdit, seul « three » est permis`);
      else if (forme !== "type" && !dansThree) violations.push(`${ou} : three importé hors de ${DOSSIER_THREE}`);
      // Train de V0 (MX-3D, M3D-3) : dans three/, import("three") n'est pas élagué par Rolldown (+30,8 % en gzip) ; le morceau
      // paresseux vient de moteur-chargeur.ts, three s'y importe par imports nommés statiques (D-3d-05).
      else if (forme === "dynamique") violations.push(`${ou} : import("three") dynamique interdit dans ${DOSSIER_THREE} : imports nommés statiques (M3D-3)`);
    } else if (!dansThree && forme !== "type" && versDossierThree(cible(fichier, specificateur))) {
      const frontiere = fichier === CHARGEUR && forme === "dynamique" && sansExtension(cible(fichier, specificateur) ?? "") === MOTEUR;
      if (!frontiere) violations.push(`${ou} : « ${specificateur} » franchit la frontière de ${DOSSIER_THREE} (seul ${CHARGEUR}, par import("./three/moteur.ts"))`);
    }
  }
  return violations;
}

/** Violations de vite.config.ts (aucun import de three) et d'un module de production du serveur (import type seul permis). */
function violationsHorsWeb(fichier: string, imports: readonly ImportTrouve[]): string[] {
  const violations: string[] = [];
  for (const { specificateur, forme, ligne } of imports) {
    if (forme === "type" && fichier !== "vite.config.ts") continue;
    const three = forme === "non-litteral" || specificateur.startsWith("three") || versDossierThree(cible(fichier, specificateur));
    if (three) violations.push(`${fichier}:${ligne} : three importé par ${fichier === "vite.config.ts" ? "vite.config.ts" : "un module de production du serveur"}`);
  }
  return violations;
}

// --- Sources réelles -------------------------------------------------------------------------------------------------------------

interface Source {
  fichier: string;
  texte: string;
}

function sources(dossier: "web" | "server"): Source[] {
  return (fs.readdirSync(path.join(APP_DIR, dossier), { recursive: true }) as string[])
    .map((entree) => `${dossier}/${entree.replaceAll("\\", "/")}`)
    .filter((fichier) => (dossier === "web" ? /\.tsx?$/.test(fichier) : fichier.endsWith(".ts") && !fichier.endsWith(".test.ts") && !fichier.startsWith("server/test-support/")))
    .sort()
    .map((fichier) => ({ fichier, texte: fs.readFileSync(path.join(APP_DIR, fichier), "utf8") }));
}

/** Contrôle naïf du lecteur : « import|export … from "…" » et « import "…" » en début de ligne. */
function importsEnDebutDeLigne(texte: string): string[] {
  const trouves = [...texte.matchAll(/^[ \t]*(?:import|export)\b[^;'"`]*?\bfrom\s*(["'])([^"'\n]+)\1/gm), ...texte.matchAll(/^[ \t]*import\s*(["'])([^"'\n]+)\1/gm)];
  return trouves.map((m) => m[2] ?? "").sort();
}

// --- Tests -----------------------------------------------------------------------------------------------------------------------

const web = (fichier: string, texte: string) => violationsWeb(fichier, lireImports(texte));
const SCENE = "web/pages/salle-controle/Scene3d.tsx";
const GRAPHE = "web/pages/salle-controle/three/graphe.ts";

describe("three-import : lecteur", () => {
  it("formes reconnues : statique, type, export … from, dynamique, glob, require ; membres, chaînes, gabarits et commentaires ignorés", () => {
    const texte = [
      'import React, { useState } from "react";',
      "import type { Scene } from 'three';",
      "import type from \"three\";",
      "import type, { Group } from \"three\";",
      'import "./styles.css";',
      "import {\n  Mesh,\n  type Vector3,\n} from \"three\";",
      'export * from "./a.ts";',
      'export * as b from "./b.ts";',
      'export { c, type D } from "./c.ts";',
      'export type { E } from "./e.ts";',
      'export type * from "./f.ts";',
      "export type G = { from: string };",
      "export { local };",
      'const m = await import("./three/moteur.ts");',
      "type M = typeof import(\"./three/graphe.ts\");",
      'const g = import.meta.glob("./three/*.ts");',
      "const env = import.meta.env; obj.import(\"three\"); x.require(\"three\");",
      'const r = require("three");',
      "const n = import(`./three/${nom}.ts`);",
      "const t = `import(\"three\")`; const s = 'import \"three\"'; const re = /from \"three\"/g;",
      "// import { Scene } from \"three\";",
      "/* import(\"three\") */",
      'const p = <p>L\'IA décide</p>; const q = a / b / c; const u = import("./u.ts");',
    ].join("\n");
    assert.deepEqual(
      lireImports(texte).map((i) => `${i.ligne} ${i.forme} ${i.specificateur}`),
      [
        "1 statique react",
        "2 type three",
        "3 statique three",
        "4 statique three",
        "5 statique ./styles.css",
        "6 statique three",
        "10 export ./a.ts",
        "11 export ./b.ts",
        "12 export ./c.ts",
        "13 type ./e.ts",
        "14 type ./f.ts",
        "17 dynamique ./three/moteur.ts",
        "18 type ./three/graphe.ts",
        "19 dynamique ./three/*.ts",
        "21 require three",
        "22 non-litteral (`./three/${nom}.ts`)",
        "26 dynamique ./u.ts",
      ],
    );
  });
});

describe("three-import : règle (contrôles discriminants)", () => {
  it("dans three/ : « three » permis en import statique ; import(\"three\") dynamique refusé (M3D-3) ; three/webgpu, three/tsl, three/addons, three/src refusés", () => {
    for (const texte of ['import { Scene, Group } from "three";', 'import * as T from "three";', 'export { Mesh } from "three";', 'import { a } from "./sol.ts";', 'import { b } from "../camera-3d.ts";']) {
      assert.deepEqual(web(GRAPHE, texte), [], texte);
    }
    for (const texte of ['const t = await import("three");', 'const { Mesh } = await import("three");']) {
      assert.deepEqual(web(GRAPHE, texte), [`${GRAPHE}:1 : import("three") dynamique interdit dans ${DOSSIER_THREE} : imports nommés statiques (M3D-3)`], texte);
    }
    for (const spec of ["three/webgpu", "three/tsl", "three/addons/controls/OrbitControls.js", "three/src/Three.js", "three/examples/jsm/Addons.js"]) {
      assert.deepEqual(web(GRAPHE, `import { X } from "${spec}";`), [`${GRAPHE}:1 : « ${spec} » interdit, seul « three » est permis`], spec);
    }
    assert.deepEqual(web(GRAPHE, 'const w = import("three/webgpu");'), [`${GRAPHE}:1 : « three/webgpu » interdit, seul « three » est permis`]);
    assert.deepEqual(web(SCENE, 'import type { X } from "three/src/Three.js";'), [`${SCENE}:1 : « three/src/Three.js » interdit, seul « three » est permis`]);
  });

  it("hors de three/ : « three » refusé (statique, dynamique, export, require, import type from) ; import type permis", () => {
    const refuses = ['import { Scene } from "three";', 'const t = await import("three");', 'export * from "three";', 'const t = require("three");', 'import type from "three";', "import {\n  Scene,\n} from 'three';"];
    for (const texte of refuses) assert.deepEqual(web(SCENE, texte), [`${SCENE}:1 : three importé hors de ${DOSSIER_THREE}`], texte);
    assert.deepEqual(web("web/app/App.tsx", 'import "three";'), [`web/app/App.tsx:1 : three importé hors de ${DOSSIER_THREE}`]);
    for (const texte of ['import type { Scene } from "three";', 'export type { Scene } from "three";', "// import { Scene } from \"three\";", 'const s = "import { Scene } from \'three\'";']) {
      assert.deepEqual(web(SCENE, texte), [], texte);
    }
  });

  it("frontière : seul moteur-chargeur.ts importe three/, par import(\"./three/moteur.ts\") dynamique ; import type permis partout", () => {
    assert.deepEqual(web(CHARGEUR, 'export const chargerMoteur = () => import("./three/moteur.ts");'), []);
    assert.deepEqual(web(CHARGEUR, 'export const chargerMoteur = () => import("./three/moteur");'), []);
    for (const texte of ['import type { Graphe } from "./three/graphe.ts";', 'type M = typeof import("./three/moteur.ts");']) {
      assert.deepEqual(web(SCENE, texte), [], texte);
      assert.deepEqual(web(CHARGEUR, texte), [], texte);
    }
    const franchit = (fichier: string, spec: string) => `${fichier}:1 : « ${spec} » franchit la frontière de ${DOSSIER_THREE} (seul ${CHARGEUR}, par import("./three/moteur.ts"))`;
    assert.deepEqual(web(CHARGEUR, 'const g = import("./three/graphe.ts");'), [franchit(CHARGEUR, "./three/graphe.ts")]);
    assert.deepEqual(web(CHARGEUR, 'import { creerMoteur } from "./three/moteur.ts";'), [franchit(CHARGEUR, "./three/moteur.ts")]);
    assert.deepEqual(web(SCENE, 'const m = import("./three/moteur.ts");'), [franchit(SCENE, "./three/moteur.ts")]);
    assert.deepEqual(web(SCENE, 'export { creerGraphe } from "./three/graphe.ts";'), [franchit(SCENE, "./three/graphe.ts")]);
    assert.deepEqual(web("web/app/App.tsx", 'import { x } from "../pages/salle-controle/three/sol.ts";'), [franchit("web/app/App.tsx", "../pages/salle-controle/three/sol.ts")]);
    assert.deepEqual(web("web/app/App.tsx", 'import { x } from "/pages/salle-controle/three";'), [franchit("web/app/App.tsx", "/pages/salle-controle/three")]);
    assert.deepEqual(web(CHARGEUR, 'const g = import.meta.glob("./three/*.ts");'), [franchit(CHARGEUR, "./three/*.ts")]);
    assert.deepEqual(web(CHARGEUR, "const m = (nom: string) => import(`./three/${nom}.ts`);"), [`${CHARGEUR}:1 : import non littéral qui cite three`]);
    // Un voisin au nom proche n'est pas dans three/.
    assert.deepEqual(web(SCENE, 'import { x } from "./three-outils.ts";'), []);
  });

  it("hors web : vite.config.ts n'importe pas three (même en type) ; module de production du serveur : import type seul", () => {
    const vite = (texte: string) => violationsHorsWeb("vite.config.ts", lireImports(texte));
    const serveur = (texte: string) => violationsHorsWeb("server/app-factory.ts", lireImports(texte));
    assert.deepEqual(vite('import * as THREE from "three";'), ["vite.config.ts:1 : three importé par vite.config.ts"]);
    assert.deepEqual(vite('import type { Scene } from "three";'), ["vite.config.ts:1 : three importé par vite.config.ts"]);
    assert.deepEqual(vite('import { threeGuard } from "./server/build-three-guard.ts";'), []);
    assert.deepEqual(serveur('import { Scene } from "three";'), ["server/app-factory.ts:1 : three importé par un module de production du serveur"]);
    assert.deepEqual(serveur('const g = await import("../web/pages/salle-controle/three/graphe.ts");'), ["server/app-factory.ts:1 : three importé par un module de production du serveur"]);
    assert.deepEqual(serveur('import type { Scene } from "three";'), []);
  });

  it("mutation d'un fichier réel : un import de three ajouté à App.tsx fait échouer la règle", () => {
    const fichier = "web/app/App.tsx";
    const texte = fs.readFileSync(path.join(APP_DIR, fichier), "utf8");
    assert.deepEqual(web(fichier, texte), []);
    assert.deepEqual(web(fichier, `import { Scene } from "three";\n${texte}`), [`${fichier}:1 : three importé hors de ${DOSSIER_THREE}`]);
    const dynamique = texte.replace(/\n\n/, '\nconst moteur = () => import("../pages/salle-controle/three/moteur.ts");\n\n');
    assert.notEqual(dynamique, texte);
    assert.equal(web(fichier, dynamique).length, 1);
  });
});

describe("three-import : sources réelles", () => {
  it("le lecteur retrouve chaque import en début de ligne de web/ et des modules du serveur", () => {
    const toutes = [...sources("web"), ...sources("server")];
    assert.ok(toutes.length > 100, `${toutes.length} fichiers lus`);
    for (const { fichier, texte } of toutes) {
      const lus = lireImports(texte)
        .filter((i) => i.forme === "statique" || i.forme === "export" || i.forme === "type")
        .map((i) => i.specificateur)
        .sort();
      assert.deepEqual(lus, importsEnDebutDeLigne(texte), fichier);
    }
  });

  it("web/**/*.{ts,tsx} : règle tenue ; three.d.ts lu", () => {
    const fichiers = sources("web");
    assert.ok(fichiers.some((s) => s.fichier === `${DOSSIER_THREE}three.d.ts`));
    assert.deepEqual(fichiers.flatMap((s) => violationsWeb(s.fichier, lireImports(s.texte))), []);
  });

  it("vite.config.ts et modules de production du serveur : aucun import de three", () => {
    const vite = { fichier: "vite.config.ts", texte: fs.readFileSync(path.join(APP_DIR, "vite.config.ts"), "utf8") };
    const serveur = sources("server");
    assert.ok(serveur.some((s) => s.fichier === "server/build-three-guard.ts"));
    assert.deepEqual([vite, ...serveur].flatMap((s) => violationsHorsWeb(s.fichier, lireImports(s.texte))), []);
  });
});
