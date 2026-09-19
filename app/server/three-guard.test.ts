// Garde du build de three.js (itération 3, L32 ; plan it3 D-3d-06) : fonctions pures sur des morceaux fabriqués, puis greffon
// Vite appelé avec des contextes simulés. Les quatre cas d'échec (new Function ou eval( dans un morceau de three ; module
// three.webgpu, three.tsl, examples ou src ; three atteint statiquement depuis une entrée ; licence non émise) font échouer le
// build ; « retrieval( » et « obj.eval( » sont tolérés ; un build propre journalise « [three] aucun morceau three » ou la taille
// de chaque morceau de three (M24). Le branchement réel est vérifié dans vite.config.ts.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import zlib from "node:zlib";
import type { Plugin } from "vite";
import {
  atteintStatiquement,
  type BundleGarde,
  codeInterdit,
  emettreLicence,
  garderBundle,
  LICENCE_THREE,
  type LicenceThree,
  lignesJournal,
  lireLicenceThree,
  type MorceauGarde,
  modulesThreeInterdits,
  threeGuard,
  verifierBundle,
} from "./build-three-guard.ts";

const THREE = "/src/node_modules/three/build/three.module.js";
const THREE_CORE = "C:\\src\\node_modules\\three\\build\\three.core.js";
const TEXTE_LICENCE = "The MIT License\n\nCopyright © 2010-2026 three.js authors\n";

const morceau = (fileName: string, champs: Partial<MorceauGarde> = {}): MorceauGarde => ({
  type: "chunk",
  fileName,
  isEntry: false,
  code: "export const x = 1;",
  moduleIds: [`/app/web/${fileName}.ts`],
  imports: [],
  dynamicImports: [],
  ...champs,
});

/** Bundle propre : entrée qui charge three par import dynamique, morceau paresseux de three, licence émise. */
function bundlePropre(changer: (b: Record<string, MorceauGarde>) => void = () => {}): BundleGarde {
  const morceaux: Record<string, MorceauGarde> = {
    "assets/index.js": morceau("assets/index.js", { isEntry: true, imports: ["assets/commun.js"], dynamicImports: ["assets/moteur.js"] }),
    "assets/commun.js": morceau("assets/commun.js"),
    "assets/moteur.js": morceau("assets/moteur.js", {
      code: "import{a}from'./commun.js';const r=new WebGLRenderer({retrieval(){}});",
      moduleIds: ["/app/web/pages/salle-controle/three/moteur.ts", THREE, THREE_CORE],
      imports: ["assets/commun.js"],
    }),
  };
  changer(morceaux);
  return { ...morceaux, [LICENCE_THREE]: { type: "asset", fileName: LICENCE_THREE, source: TEXTE_LICENCE } };
}

/** Garde complète sur un bundle ; rend le message d'erreur (null si le build passe) et le journal. */
function garder(bundle: BundleGarde, licence: LicenceThree = { texte: TEXTE_LICENCE }): { erreur: string | null; journal: string[] } {
  const journal: string[] = [];
  try {
    garderBundle({ error: (message: string): never => { throw new Error(message); } }, bundle, licence, (ligne) => journal.push(ligne));
    return { erreur: null, journal };
  } catch (error) {
    return { erreur: (error as Error).message, journal };
  }
}

describe("garde three : fonctions pures", () => {
  it("codeInterdit : new Function( et eval( (espaces permis) ; retrieval(, obj.eval(, $eval(, _eval( et 2eval( tolérés", () => {
    for (const code of ["new Function('a', 'return a')", "x=new  Function (s)", "new\nFunction(\n)"]) assert.deepEqual(codeInterdit(code), ["new Function("], code);
    for (const code of ["eval(s)", "a=eval ( s )", "(eval\n(s))", ";eval(1)", "x=>eval(s)"]) assert.deepEqual(codeInterdit(code), ["eval("], code);
    assert.deepEqual(codeInterdit("new Function(s);eval(s)"), ["new Function(", "eval("]);
    for (const code of ["retrieval(x)", "obj.eval(x)", "$eval(x)", "_eval(x)", "a2eval(x)", "évaluéeval(x)", "const evaluation = 1", "new Functions(x)", "new FunctionX(x)", "Function.prototype", "eval", "obj.Function(x)", "setFunction(x)", "myglobalThis.eval(x)"]) {
      assert.deepEqual(codeInterdit(code), [], code);
    }
  });

  it("codeInterdit : formes minifiées, indirectes et globales mesurées sur le minifieur de Vite 8.3.0", () => {
    // Relevées par L32 dans un morceau minifié : new Function(s) → Function(e) ; new Function("a", s) → Function(`a`,e) ;
    // new globalThis.Function(s) et (0, eval)(s), globalThis.eval(s), window.eval(s) gardés tels quels.
    for (const code of ["f1=e=>Function(e)", "f4=e=>Function(`a`,e)", "f2=e=>new globalThis.Function(e)", "window.Function(e)", "self . Function (e)"]) {
      assert.deepEqual(codeInterdit(code), ["new Function("], code);
    }
    for (const code of ["e1=e=>(0,eval)(e)", "(0, eval) (e)", "e2=e=>globalThis.eval(e)", "e4=e=>window.eval(e)", "self.eval(e)"]) assert.deepEqual(codeInterdit(code), ["eval("], code);
  });

  it("modulesThreeInterdits : three.webgpu, three.tsl, examples et src (séparateurs normalisés) ; build/three.module.js et three.core.js permis", () => {
    const interdits = [
      "C:\\a\\node_modules\\three\\build\\three.webgpu.js",
      "/a/node_modules/three/build/three.webgpu.nodes.js",
      "/a/node_modules/three/build/three.tsl.js",
      "/a/node_modules/three/examples/jsm/Addons.js",
      "C:\\a\\node_modules\\three\\src\\Three.js",
    ];
    const permis = [THREE, THREE_CORE, "/app/web/pages/salle-controle/three/moteur.ts", "/a/node_modules/threestudio/src/x.js", "\0vite/preload-helper.js"];
    assert.deepEqual(modulesThreeInterdits([...permis, ...interdits, interdits[0] ?? ""]), [...interdits].sort());
    assert.deepEqual(modulesThreeInterdits(permis), []);
  });

  it("atteintStatiquement : imports statiques suivis depuis chaque entrée, jamais dynamicImports ; cycles tolérés", () => {
    assert.deepEqual(atteintStatiquement(bundlePropre()), []);
    const statique = bundlePropre((b) => {
      b["assets/commun.js"] = morceau("assets/commun.js", { imports: ["assets/index.js", "assets/moteur.js"] });
    });
    assert.deepEqual(atteintStatiquement(statique), ["assets/moteur.js"]);
    const dansEntree = bundlePropre((b) => {
      b["assets/index.js"] = morceau("assets/index.js", { isEntry: true, moduleIds: ["/app/web/main.tsx", THREE_CORE] });
    });
    assert.deepEqual(atteintStatiquement(dansEntree), ["assets/index.js"]);
    // Morceau de three importé statiquement par un morceau paresseux seulement : permis.
    const paresseux = bundlePropre((b) => {
      b["assets/moteur.js"] = morceau("assets/moteur.js", { imports: ["assets/three.js"] });
      b["assets/three.js"] = morceau("assets/three.js", { moduleIds: [THREE] });
    });
    assert.deepEqual(atteintStatiquement(paresseux), []);
  });

  it("verifierBundle : bundle propre → aucun problème ; chacun des trois cas du bundle signalé", () => {
    assert.deepEqual(verifierBundle(bundlePropre()), []);
    const cas: Array<[string, (b: Record<string, MorceauGarde>) => void, string]> = [
      ["new Function", (b) => { b["assets/moteur.js"] = { ...(b["assets/moteur.js"] as MorceauGarde), code: "const f=new Function('return this');" }; }, "assets/moteur.js : « new Function( » dans un morceau de three"],
      ["eval (", (b) => { b["assets/moteur.js"] = { ...(b["assets/moteur.js"] as MorceauGarde), code: "x=eval (s);" }; }, "assets/moteur.js : « eval( » dans un morceau de three"],
      ["three.webgpu", (b) => { b["assets/webgpu.js"] = morceau("assets/webgpu.js", { moduleIds: ["C:\\n\\three\\build\\three.webgpu.js"] }); }, "module de three interdit dans le build : C:/n/three/build/three.webgpu.js"],
      ["import statique", (b) => { b["assets/index.js"] = { ...(b["assets/index.js"] as MorceauGarde), imports: ["assets/moteur.js"] }; }, "assets/moteur.js : three atteint depuis une entrée par import statique (il doit rester dans un morceau paresseux)"],
    ];
    for (const [nom, changer, attendu] of cas) assert.deepEqual(verifierBundle(bundlePropre(changer)), [attendu], nom);
    // Portée : eval( hors d'un morceau de three n'échoue pas (signalé au journal, M3D-8).
    const horsThree = bundlePropre((b) => { b["assets/commun.js"] = morceau("assets/commun.js", { code: "eval(s)" }); });
    assert.deepEqual(verifierBundle(horsThree), []);
  });

  it("lignesJournal : taille brute et gzip de chaque morceau de three, sinon « aucun morceau three » ; hors three signalé", () => {
    const code = (bundlePropre()["assets/moteur.js"] as MorceauGarde).code;
    assert.deepEqual(lignesJournal(bundlePropre()), [`[three] assets/moteur.js : ${Buffer.byteLength(code)} octets, ${zlib.gzipSync(code).length} octets gzip`]);
    const sansThree = bundlePropre((b) => { delete b["assets/moteur.js"]; });
    assert.deepEqual(lignesJournal(sansThree), ["[three] aucun morceau three"]);
    const signale = bundlePropre((b) => { b["assets/commun.js"] = morceau("assets/commun.js", { code: "new Function(s);eval(s)" }); });
    assert.equal(lignesJournal(signale)[1], "[three] signalé, hors three (non bloquant) : assets/commun.js contient « new Function( » et « eval( »");
  });

  it("lireLicenceThree : build/../LICENSE à côté du module résolu, licence MIT exigée", (t) => {
    const racine = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-three-guard-"));
    t.after(() => fs.rmSync(racine, { recursive: true, force: true }));
    const dossier = path.join(racine, "node_modules", "three");
    fs.mkdirSync(path.join(dossier, "build"), { recursive: true });
    const module = path.join(dossier, "build", "three.module.js");
    fs.writeFileSync(module, "export const REVISION = '186';");
    assert.match((lireLicenceThree(module) as { erreur: string }).erreur, /LICENSE illisible \(ENOENT\)$/);
    fs.writeFileSync(path.join(dossier, "LICENSE"), TEXTE_LICENCE);
    assert.deepEqual(lireLicenceThree(module), { texte: TEXTE_LICENCE });
    fs.writeFileSync(path.join(dossier, "LICENSE"), "Tous droits réservés");
    assert.match((lireLicenceThree(module) as { erreur: string }).erreur, /ne porte pas la licence MIT$/);
    assert.deepEqual(lireLicenceThree(null), { erreur: "module three introuvable depuis la racine du build" });
    assert.match((lireLicenceThree(path.join(racine, "three.js")) as { erreur: string }).erreur, /^module three résolu hors de three\/build : /);
  });
});

describe("garde three : fin du build (quatre cas d'échec)", () => {
  it("bundle propre et licence émise → build vert, journal de la taille", () => {
    const { erreur, journal } = garder(bundlePropre());
    assert.equal(erreur, null);
    assert.match(journal[0] ?? "", /^\[three\] assets\/moteur\.js : \d+ octets, \d+ octets gzip$/);
  });

  it("sans three dans le build → build vert, « [three] aucun morceau three »", () => {
    assert.deepEqual(garder(bundlePropre((b) => { delete b["assets/moteur.js"]; })), { erreur: null, journal: ["[three] aucun morceau three"] });
  });

  it("new Function, eval (, three.webgpu, import statique depuis l'entrée → build en échec", () => {
    const cas: Array<(b: Record<string, MorceauGarde>) => void> = [
      (b) => { b["assets/moteur.js"] = { ...(b["assets/moteur.js"] as MorceauGarde), code: "new Function('x')" }; },
      (b) => { b["assets/moteur.js"] = { ...(b["assets/moteur.js"] as MorceauGarde), code: "var y = eval ( x );" }; },
      (b) => { b["assets/moteur.js"] = { ...(b["assets/moteur.js"] as MorceauGarde), moduleIds: [THREE, "/n/three/build/three.webgpu.js"] }; },
      (b) => { b["assets/index.js"] = { ...(b["assets/index.js"] as MorceauGarde), imports: ["assets/moteur.js"], dynamicImports: [] }; },
    ];
    for (const changer of cas) assert.match(garder(bundlePropre(changer)).erreur ?? "", /^\[three\] garde du build en échec : /);
  });

  it("« retrieval( » et « obj.eval( » dans le morceau de three tolérés", () => {
    const tolere = bundlePropre((b) => { b["assets/moteur.js"] = { ...(b["assets/moteur.js"] as MorceauGarde), code: "retrieval(a);obj.eval(b);" }; });
    assert.equal(garder(tolere).erreur, null);
  });

  it("licence non émise : absente du bundle, texte différent ou three introuvable → build en échec", () => {
    const sansLicence = { ...bundlePropre() };
    delete sansLicence[LICENCE_THREE];
    assert.equal(garder(sansLicence).erreur, `[three] garde du build en échec : licence non émise : ${LICENCE_THREE} absent du build`);
    assert.match(garder(bundlePropre(), { texte: "The MIT License (autre)" }).erreur ?? "", /licence non émise/);
    assert.equal(garder(bundlePropre(), { erreur: "module three introuvable depuis la racine du build" }).erreur, "[three] garde du build en échec : licence non émise : module three introuvable depuis la racine du build");
    // Contenu en octets (Uint8Array) accepté.
    const octets = { ...bundlePropre(), [LICENCE_THREE]: { type: "asset" as const, fileName: LICENCE_THREE, source: new TextEncoder().encode(TEXTE_LICENCE) } };
    assert.equal(garder(octets).erreur, null);
  });

  it("emettreLicence : un seul fichier émis, au nom fixé, seulement si la licence a été lue", () => {
    const emis: Array<{ fileName: string; source: string }> = [];
    const contexte = { emitFile: (f: { type: "asset"; fileName: string; source: string }) => { emis.push(f); return "ref"; } };
    emettreLicence(contexte, { erreur: "absente" });
    assert.deepEqual(emis, []);
    emettreLicence(contexte, { texte: TEXTE_LICENCE });
    assert.deepEqual(emis, [{ type: "asset", fileName: LICENCE_THREE, source: TEXTE_LICENCE }]);
  });
});

describe("garde three : greffon Vite", () => {
  /** Fonction d'un crochet du greffon (forme fonction ou objet `handler`). */
  const crochet = (plugin: Plugin, nom: "configResolved" | "buildStart" | "generateBundle") => {
    const brut = plugin[nom];
    const fonction = typeof brut === "function" ? brut : brut?.handler;
    assert.equal(typeof fonction, "function", nom);
    return fonction as unknown as (this: unknown, ...args: unknown[]) => unknown;
  };

  /** Build simulé : configResolved, buildStart (three résolu par `resoudre`), puis generateBundle sur le bundle et les émissions. */
  async function construire(resoudre: (id: string, importer: string) => { id: string; external: boolean } | null, bundle: Record<string, unknown>) {
    const plugin = threeGuard();
    const journal: string[] = [];
    const appels: string[] = [];
    crochet(plugin, "configResolved").call({}, { root: "/app/web", logger: { info: (ligne: string) => journal.push(ligne) } });
    await crochet(plugin, "buildStart").call({
      resolve: async (id: string, importer: string) => {
        appels.push(`${id} depuis ${importer.replaceAll("\\", "/")}`);
        return resoudre(id, importer);
      },
      emitFile: (f: { fileName: string }) => {
        bundle[f.fileName] = f;
        return "ref";
      },
    }, {});
    try {
      crochet(plugin, "generateBundle").call({ error: (message: string): never => { throw new Error(message); } }, {}, bundle, true);
      return { erreur: null, journal, appels };
    } catch (error) {
      return { erreur: (error as Error).message, journal, appels };
    }
  }

  it("nom, build seulement ; three résolu depuis la racine, licence émise au début du build puis vérifiée", async (t) => {
    const plugin = threeGuard();
    assert.equal(plugin.name, "cockpit:three-guard");
    assert.equal(plugin.apply, "build");
    const racine = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-three-guard-"));
    t.after(() => fs.rmSync(racine, { recursive: true, force: true }));
    fs.mkdirSync(path.join(racine, "three", "build"), { recursive: true });
    fs.writeFileSync(path.join(racine, "three", "LICENSE"), TEXTE_LICENCE);
    const module = path.join(racine, "three", "build", "three.module.js");
    const bundle: Record<string, unknown> = { ...bundlePropre() };
    delete bundle[LICENCE_THREE];
    const vert = await construire(() => ({ id: module, external: false }), bundle);
    assert.equal(vert.erreur, null);
    assert.deepEqual(vert.appels, ["three depuis /app/web/index.html"]);
    assert.deepEqual(bundle[LICENCE_THREE], { type: "asset", fileName: LICENCE_THREE, source: TEXTE_LICENCE });
    assert.match(vert.journal[0] ?? "", /^\[three\] assets\/moteur\.js : /);
    // three introuvable (ou externe) : licence non émise, build en échec.
    for (const resolu of [null, { id: module, external: true }]) {
      const rouge = await construire(() => resolu, { ...bundlePropre() });
      assert.equal(rouge.erreur, "[three] garde du build en échec : licence non émise : module three introuvable depuis la racine du build");
    }
  });

  it("vite.config.ts : threeGuard() branché dans plugins, importé depuis server/build-three-guard.ts", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "..", "vite.config.ts"), "utf8").replace(/\/\/[^\n]*/g, "");
    assert.match(source, /^import \{ threeGuard \} from "\.\/server\/build-three-guard\.ts";$/m);
    assert.match(source, /\bplugins:\s*\[[^\]]*\bthreeGuard\(\)[^\]]*\]/);
  });
});
