// Liste fermée P8 (itération 3, L32 ; spécification P8 l.43, JP-11 ; plan it3 D-3d-03). Les dépendances de app/package.json
// sont une liste fermée : les cinq `dependencies` et les dix-sept `devDependencies` relues dans app/package.json au moment de
// L32 (tête H0 de chantier/1.1-3d), plus three@0.186.0, seule dépendance ajoutée par le chantier 1.1 côté application. Tout
// nom ajouté fait échouer le test (« liste fermée P8 »), comme tout autre champ de dépendances. L'entrée `node_modules/three` du
// lockfile est vérifiée (registre npm, intégrité = SHA-512 de l'archive vérifiée, aucune dépendance, aucun script
// d'installation). Le test ne lit ni le champ `version` ni d'autres entrées du lockfile que la racine et three : la fusion de
// la 1.0.5 (M0) les change sans toucher à la liste.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const APP_DIR = path.join(import.meta.dirname, "..");

/** `dependencies` de la branche (relues dans app/package.json à H0). */
const DEPENDENCIES = ["@hono/node-server", "hono", "jsonc-parser", "yaml", "zod"] as const;

/** Les dix-sept `devDependencies` de la branche (relues dans app/package.json à H0), sans three. */
const DEV_DEPENDENCIES = [
  "@codemirror/lang-json",
  "@codemirror/lang-markdown",
  "@codemirror/state",
  "@codemirror/theme-one-dark",
  "@codemirror/view",
  "@types/node",
  "@types/react",
  "@types/react-dom",
  "@vitejs/plugin-react",
  "codemirror",
  "dompurify",
  "highlight.js",
  "marked",
  "react",
  "react-dom",
  "typescript",
  "vite",
] as const;

/** Exception P8 du chantier (JP-11) : three, version exacte, en devDependencies. */
const THREE = {
  version: "0.186.0",
  resolved: "https://registry.npmjs.org/three/-/three-0.186.0.tgz",
  // SHA-512 de l'archive vérifiée (SHA-256 61eeff9d7616005c9a481c796f52287d81fbbbc0d55eaca5565322924252c1aa), recalculé par
  // node:crypto et identique à dist.integrity du registre (relevé par L32).
  integrity: "sha512-cr/fIM2ddMSVbYVgkfD4jLJv7Fh/8ZTjvo+7gQeSVGUZHxpx9FDwoL5iC7hUz/LiRA8wMbqfnb90xKfm1/HHkQ==",
} as const;

/** Champs de dépendances interdits dans package.json (la liste fermée ne passe que par dependencies et devDependencies). */
const AUTRES_CHAMPS = ["optionalDependencies", "peerDependencies", "bundleDependencies", "bundledDependencies", "overrides"] as const;

type Json = Record<string, unknown>;

const objet = (valeur: unknown): Json => (valeur !== null && typeof valeur === "object" && !Array.isArray(valeur) ? (valeur as Json) : {});

/** Écart entre les noms trouvés et la liste fermée ; vide si identiques. */
function ecartListe(champ: string, trouves: readonly string[], attendus: readonly string[]): string[] {
  const ajoutes = trouves.filter((nom) => !attendus.includes(nom));
  const retires = attendus.filter((nom) => !trouves.includes(nom));
  const problemes: string[] = [];
  if (ajoutes.length > 0) problemes.push(`liste fermée P8 : ${champ} ajoutée(s) : ${ajoutes.join(", ")}`);
  if (retires.length > 0) problemes.push(`liste fermée P8 : ${champ} absente(s) : ${retires.join(", ")}`);
  return problemes;
}

/** Contrôle de package.json et du lockfile ; rend la liste des problèmes (vide si conforme). */
function controlerP8(paquet: Json, verrou: Json): string[] {
  const problemes: string[] = [];
  const deps = objet(paquet.dependencies);
  const devDeps = objet(paquet.devDependencies);
  problemes.push(...ecartListe("dependencies", Object.keys(deps), DEPENDENCIES));
  problemes.push(...ecartListe("devDependencies", Object.keys(devDeps), [...DEV_DEPENDENCIES, "three"]));
  for (const champ of AUTRES_CHAMPS) if (champ in paquet) problemes.push(`liste fermée P8 : champ ${champ} interdit`);
  if (devDeps.three !== THREE.version) problemes.push(`three : version ${JSON.stringify(devDeps.three)} au lieu de "${THREE.version}" exact`);
  if ("three" in deps) problemes.push("three : en dependencies au lieu de devDependencies");

  const paquets = objet(verrou.packages);
  const racine = objet(paquets[""]);
  for (const champ of ["dependencies", "devDependencies"] as const) {
    const dansPaquet = objet(paquet[champ]);
    const dansVerrou = objet(racine[champ]);
    const noms = [...new Set([...Object.keys(dansPaquet), ...Object.keys(dansVerrou)])].sort();
    for (const nom of noms) if (dansPaquet[nom] !== dansVerrou[nom]) problemes.push(`lockfile : racine ${champ}.${nom} différente de package.json`);
  }
  const entreesThree = Object.keys(paquets).filter((cle) => /(?:^|\/)node_modules\/three$/.test(cle));
  if (entreesThree.join() !== "node_modules/three") problemes.push(`lockfile : entrées de three ${JSON.stringify(entreesThree)} au lieu de ["node_modules/three"]`);
  const three = objet(paquets["node_modules/three"]);
  for (const [champ, attendu] of Object.entries({ ...THREE, dev: true, license: "MIT" })) {
    if (three[champ] !== attendu) problemes.push(`lockfile : three.${champ} = ${JSON.stringify(three[champ])} au lieu de ${JSON.stringify(attendu)}`);
  }
  for (const champ of ["dependencies", "optionalDependencies", "peerDependencies", "hasInstallScript", "bin"]) {
    if (champ in three) problemes.push(`lockfile : three porte ${champ}`);
  }
  return problemes;
}

const lireJson = (fichier: string): Json => objet(JSON.parse(fs.readFileSync(path.join(APP_DIR, fichier), "utf8")));
const reel = () => ({ paquet: lireJson("package.json"), verrou: lireJson("package-lock.json") });

describe("P8 : liste fermée des dépendances", () => {
  it("app/package.json et app/package-lock.json conformes : cinq dependencies, dix-sept devDependencies plus three@0.186.0", () => {
    const { paquet, verrou } = reel();
    assert.deepEqual(controlerP8(paquet, verrou), []);
    assert.equal(DEV_DEPENDENCIES.length, 17);
    assert.equal(DEPENDENCIES.length, 5);
  });

  it("un nom ajouté, retiré ou déplacé fait échouer le contrôle (« liste fermée P8 »)", () => {
    const cas: Array<[string, (paquet: Json) => void]> = [
      ["dependency ajoutée", (p) => { objet(p.dependencies)["left-pad"] = "1.3.0"; }],
      ["devDependency ajoutée", (p) => { objet(p.devDependencies)["@types/three"] = "0.186.0"; }],
      ["devDependency retirée", (p) => { delete objet(p.devDependencies).vite; }],
      ["three déplacé en dependencies", (p) => { delete objet(p.devDependencies).three; objet(p.dependencies).three = "0.186.0"; }],
    ];
    for (const [nom, changer] of cas) {
      const { paquet, verrou } = reel();
      changer(paquet);
      const problemes = controlerP8(paquet, verrou);
      assert.ok(problemes.some((p) => p.startsWith("liste fermée P8 : ")), `${nom} : ${problemes.join(" | ")}`);
    }
    for (const champ of AUTRES_CHAMPS) {
      const { paquet, verrou } = reel();
      paquet[champ] = {};
      assert.deepEqual(controlerP8(paquet, verrou), [`liste fermée P8 : champ ${champ} interdit`], champ);
    }
  });

  it("three : version exacte exigée (^, ~ ou autre version refusés)", () => {
    for (const version of ["^0.186.0", "~0.186.0", "0.187.0", "latest"]) {
      const { paquet, verrou } = reel();
      objet(paquet.devDependencies).three = version;
      objet(objet(objet(verrou.packages)[""]).devDependencies).three = version;
      assert.deepEqual(controlerP8(paquet, verrou), [`three : version "${version}" au lieu de "0.186.0" exact`], version);
    }
  });

  it("lockfile : entrée de three altérée ou dupliquée, racine désynchronisée → échec", () => {
    const cas: Array<[string, (paquets: Json) => void, string]> = [
      ["intégrité", (p) => { objet(p["node_modules/three"]).integrity = "sha512-AAAA"; }, 'lockfile : three.integrity = "sha512-AAAA" au lieu de'],
      ["registre", (p) => { objet(p["node_modules/three"]).resolved = "https://registry.example.test/three-0.186.0.tgz"; }, "lockfile : three.resolved"],
      ["version", (p) => { objet(p["node_modules/three"]).version = "0.186.1"; }, "lockfile : three.version"],
      ["dev", (p) => { delete objet(p["node_modules/three"]).dev; }, "lockfile : three.dev = undefined"],
      ["script", (p) => { objet(p["node_modules/three"]).hasInstallScript = true; }, "lockfile : three porte hasInstallScript"],
      ["dépendance", (p) => { objet(p["node_modules/three"]).dependencies = { x: "1.0.0" }; }, "lockfile : three porte dependencies"],
      ["doublon", (p) => { p["node_modules/vite/node_modules/three"] = { version: "0.160.0" }; }, "lockfile : entrées de three"],
      ["absente", (p) => { delete p["node_modules/three"]; }, "lockfile : entrées de three []"],
      ["racine", (p) => { delete objet(objet(p[""]).devDependencies).three; }, "lockfile : racine devDependencies.three différente de package.json"],
    ];
    for (const [nom, changer, debut] of cas) {
      const { paquet, verrou } = reel();
      changer(objet(verrou.packages));
      const problemes = controlerP8(paquet, verrou);
      assert.ok(problemes.length > 0 && problemes.some((p) => p.startsWith(debut)), `${nom} : ${problemes.join(" | ")}`);
    }
  });

  it("le champ version et les autres entrées du lockfile n'entrent pas dans le contrôle", () => {
    const { paquet, verrou } = reel();
    paquet.version = "9.9.9";
    verrou.version = "9.9.9";
    objet(objet(verrou.packages)[""]).version = "9.9.9";
    objet(verrou.packages)["node_modules/zod"] = { version: "0.0.0" };
    assert.deepEqual(controlerP8(paquet, verrou), []);
  });
});
