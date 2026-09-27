// Déclarations locales de three contre le vrai module (itération 3, L32 ; plan it3 D-3d-04, décision Q2 (a)). Chaque classe et
// chaque constante déclarées dans web/pages/salle-controle/three/*.d.ts existent dans `await import("three")` ; une constante
// déclarée avec une valeur littérale a cette valeur ; REVISION === "186". Chaque fichier est un script fait d'un seul bloc
// `declare module "three"` (sinon la déclaration deviendrait une augmentation, ou viserait three/webgpu), sans `any`. Les
// classes et constantes de la fiche L32 restent déclarées. Commentaires ignorés.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const THREE_DIR = path.join(import.meta.dirname, "..", "web", "pages", "salle-controle", "three");

/** Classes et constantes de la fiche L32 (point 4) : toujours déclarées. */
const CLASSES_FICHE = [
  "WebGLRenderer", "Scene", "PerspectiveCamera", "Object3D", "Group", "Mesh", "InstancedMesh", "LineSegments", "Sprite",
  "BufferGeometry", "PlaneGeometry", "CylinderGeometry", "ExtrudeGeometry", "EdgesGeometry", "TubeGeometry", "BoxGeometry",
  "Shape", "QuadraticBezierCurve3", "Vector3", "Matrix4", "Quaternion", "Color", "MeshBasicMaterial", "LineBasicMaterial",
  "SpriteMaterial", "ShaderMaterial", "DataTexture", "Texture",
] as const;
const CONSTANTES_FICHE = [
  "AdditiveBlending", "NormalBlending", "DoubleSide", "RepeatWrapping", "ClampToEdgeWrapping", "RGBAFormat", "SRGBColorSpace",
  "LinearFilter", "REVISION",
] as const;

interface Declarations {
  classes: string[];
  /** Constantes et valeur littérale attendue (undefined si le type n'est pas un littéral). */
  constantes: Array<{ nom: string; valeur: number | string | undefined }>;
  problemes: string[];
}

/** Source sans commentaires ni directives `///` (chaînes gardées). */
function sansCommentaires(texte: string): string {
  let code = "";
  for (let i = 0; i < texte.length; i++) {
    const c = texte[i] ?? "";
    const suivant = texte[i + 1];
    if (c === "/" && (suivant === "/" || suivant === "*")) {
      const fin = suivant === "/" ? texte.indexOf("\n", i) : texte.indexOf("*/", i + 2);
      i = fin === -1 ? texte.length : suivant === "/" ? fin - 1 : fin + 1;
      code += " ";
      continue;
    }
    if (c === '"' || c === "'") {
      const fin = texte.indexOf(c, i + 1);
      const stop = fin === -1 ? texte.length : fin;
      code += texte.slice(i, stop + 1);
      i = stop;
      continue;
    }
    code += c;
  }
  return code;
}

/** Lecture d'un fichier de déclarations : un seul bloc `declare module "three" { … }`, classes et constantes du bloc. */
function lireDeclarations(texte: string): Declarations {
  const code = sansCommentaires(texte).trim();
  const problemes: string[] = [];
  const entete = /^declare\s+module\s+(["'])([^"']*)\1\s*\{/.exec(code);
  if (!entete) return { classes: [], constantes: [], problemes: ["le fichier doit être un seul bloc declare module \"three\" { … }"] };
  if (entete[2] !== "three") problemes.push(`module déclaré « ${entete[2]} » : seul « three » est permis`);
  let profondeur = 0;
  let fin = -1;
  for (let i = entete[0].length - 1; i < code.length; i++) {
    if (code[i] === "{") profondeur++;
    else if (code[i] === "}" && --profondeur === 0) {
      fin = i;
      break;
    }
  }
  if (fin !== code.length - 1) problemes.push("code hors du bloc declare module \"three\" (le fichier doit rester un script d'un seul bloc)");
  const corps = code.slice(entete[0].length, fin === -1 ? code.length : fin);
  if (/\bany\b/.test(corps.replace(/(["'])(?:(?!\1).)*\1/g, '""'))) problemes.push("type any interdit");
  const classes = [...corps.matchAll(/(?:^|[\s;{}])(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1] ?? "");
  const constantes = [...corps.matchAll(/(?:^|[\s;{}])(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*:\s*([^;]+);/g)].map((m) => {
    const type = (m[2] ?? "").trim();
    const litteral = /^(["'])(.*)\1$/.exec(type);
    const valeur = litteral ? litteral[2] : /^-?\d+(?:\.\d+)?$/.test(type) ? Number(type) : undefined;
    return { nom: m[1] ?? "", valeur };
  });
  return { classes, constantes, problemes };
}

/** Écarts entre des déclarations et le module réel (noms absents, valeurs différentes, classe qui n'est pas une fonction). */
function ecarts(declarations: Declarations, module: ReadonlyMap<string, unknown>): string[] {
  const problemes = [...declarations.problemes];
  for (const nom of declarations.classes) {
    if (!module.has(nom)) problemes.push(`classe ${nom} absente de three`);
    else if (typeof module.get(nom) !== "function") problemes.push(`${nom} n'est pas une classe dans three`);
  }
  for (const { nom, valeur } of declarations.constantes) {
    if (!module.has(nom)) problemes.push(`constante ${nom} absente de three`);
    else if (valeur !== undefined && module.get(nom) !== valeur) problemes.push(`constante ${nom} = ${JSON.stringify(module.get(nom))} dans three, déclarée ${JSON.stringify(valeur)}`);
  }
  return problemes;
}

const fichiersDeclarations = () =>
  fs
    .readdirSync(THREE_DIR)
    .filter((nom) => nom.endsWith(".d.ts"))
    .sort();

const moduleThree = async () => {
  const three = await import("three");
  return { three, noms: new Map<string, unknown>(Object.entries(three)) };
};

describe("déclarations de three : contrôles discriminants", () => {
  it("nom absent, valeur différente, non-classe, any, autre module et code hors du bloc sont refusés", async () => {
    const { noms } = await moduleThree();
    const lire = (texte: string) => ecarts(lireDeclarations(texte), noms);
    assert.deepEqual(lire('declare module "three" { export class Scene {} export const DoubleSide: 2; }'), []);
    assert.deepEqual(lire('declare module "three" { export class WebGPURenderer {} }'), ["classe WebGPURenderer absente de three"]);
    assert.deepEqual(lire('declare module "three" { export const RGBAFormat: 1024; }'), ["constante RGBAFormat = 1023 dans three, déclarée 1024"]);
    assert.deepEqual(lire("declare module \"three\" { export const REVISION: \"187\"; }"), ['constante REVISION = "186" dans three, déclarée "187"']);
    assert.deepEqual(lire('declare module "three" { export const MeshNormalNodeMaterial: 1; }'), ["constante MeshNormalNodeMaterial absente de three"]);
    assert.deepEqual(lire('declare module "three" { export class REVISION {} }'), ["REVISION n'est pas une classe dans three"]);
    assert.deepEqual(lire('declare module "three" { export class Scene { userData: Record<string, any> } }'), ["type any interdit"]);
    assert.deepEqual(lire('declare module "three/webgpu" { export class Scene {} }'), ["module déclaré « three/webgpu » : seul « three » est permis"]);
    assert.deepEqual(lire('import type { X } from "y";\ndeclare module "three" { export class Scene {} }'), ["le fichier doit être un seul bloc declare module \"three\" { … }"]);
    assert.deepEqual(lire('declare module "three" { export class Scene {} }\nexport {};'), ["code hors du bloc declare module \"three\" (le fichier doit rester un script d'un seul bloc)"]);
    // Commentaires ignorés : une classe citée en commentaire n'est pas déclarée ; « any » dans un commentaire ou une chaîne permis.
    assert.deepEqual(lire('// class WebGPURenderer\ndeclare module "three" { /* any */ export class Group {} export type P = "any"; }'), []);
  });
});

describe("déclarations de three contre three 0.186.0", () => {
  it("REVISION === \"186\"", async () => {
    const { three } = await moduleThree();
    assert.equal(three.REVISION, "186");
  });

  it("chaque classe et constante déclarées dans three/*.d.ts existent dans le vrai module, valeurs comprises", async () => {
    const { noms } = await moduleThree();
    const fichiers = fichiersDeclarations();
    assert.ok(fichiers.includes("three.d.ts"), "three.d.ts présent");
    const classes = new Set<string>();
    const constantes = new Set<string>();
    for (const fichier of fichiers) {
      const declarations = lireDeclarations(fs.readFileSync(path.join(THREE_DIR, fichier), "utf8"));
      assert.deepEqual(ecarts(declarations, noms), [], fichier);
      for (const nom of declarations.classes) classes.add(nom);
      for (const { nom } of declarations.constantes) constantes.add(nom);
    }
    for (const nom of CLASSES_FICHE) assert.ok(classes.has(nom), `classe ${nom} déclarée`);
    for (const nom of CONSTANTES_FICHE) assert.ok(constantes.has(nom), `constante ${nom} déclarée`);
  });
});
