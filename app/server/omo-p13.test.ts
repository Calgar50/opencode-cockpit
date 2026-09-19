// Tests L15a : P13, « extension jamais publiée » (spéc. P13 l.48, §3.15.1 point 4, §7.1 l.1087 ; P8 l.43 ; plan D-2b-23, D-2b-32).
//
// - T-L15-a : `.github/**` et tout script appelé PAR CHEMIN depuis un `run:` des workflows (hors cibles de npm et de
//   `node --test`) ne citent ni opencode-omo, ni oh-my-openagent, ni build-omo-image, ni COCKPIT_OMO_IMAGE ;
// - T-L15-b : aucun lockfile installé par la CI (npm ci des workflows, COPY des Dockerfiles construits par la CI) ne contient
//   oh-my-openagent ;
// - T-L15-c : l'archive de release ne contient que les deux images du cockpit, et la CI ne pousse qu'elles ;
// - exception P8 limitée à docker/opencode-omo/package.json : extension épinglée exactement, aucune autre dépendance ;
// - lockfile de l'extension (accord Q1 (c) du 17/09) : intégrité sha512 de chaque paquet, registre npm public, archive de
//   l'extension identique à celle qu'a auditée L20 ;
// - amorce du manifeste présente et reconnue comme telle par le superviseur (D-2b-32).
// Les workflows sont lus avec le paquet `yaml` du cockpit ; rien n'est construit ni téléchargé.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { parse as parseYaml } from "yaml";
import * as salle from "../../docker/opencode-omo/supervisor-lib.mjs";

const RACINE = path.join(import.meta.dirname, "..", "..");
const DOCKER_OMO = path.join(RACINE, "docker", "opencode-omo");
const WORKFLOWS = path.join(RACINE, ".github", "workflows");

/** Chaînes que rien de ce que la CI lit ou lance ne doit citer (P13, C2-15), casse ignorée. */
const JETONS_P13: readonly string[] = ["opencode-omo", "oh-my-openagent", "build-omo-image", "COCKPIT_OMO_IMAGE"];

/**
 * Empreinte SHA-512 de l'archive npm `oh-my-openagent-4.19.4.tgz` AUDITÉE par L20 (paquet lu dans omo-study/npm-stable),
 * relevée par L15a le 19/09 : l'image installe exactement ce qui a été audité.
 */
const INTEGRITE_AUDITEE = "sha512-XZFwJQK9+iy3vtpPzty1BcyA/tZRHW+h5IpCSnEIGFNnWwpzEhP/dbBVcZ+LKz7mFyD3wIrm5+ijqLk3y12/TA==";

type Json = Record<string, unknown>;
const objet = (v: unknown): Json => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const tableau = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const relatif = (chemin: string) => path.relative(RACINE, chemin).split(path.sep).join("/");

/** Dossiers jamais parcourus : dépendances, sorties de construction, données locales de l'installation (.dockerignore). */
const DOSSIERS_IGNORES = new Set([".git", "node_modules", "data", "dist", "workspace", "archives", "backups", "testinstall", "certs", ".tls-dev"]);

/** Fichiers d'un dossier, récursivement, sans entrer dans les dossiers ignorés ni dans les dossiers cachés (sauf .github). */
function fichiers(dossier: string): string[] {
  const sortie: string[] = [];
  if (!fs.existsSync(dossier)) return sortie;
  for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
    if (DOSSIERS_IGNORES.has(entree.name)) continue;
    if (entree.isDirectory() && entree.name.startsWith(".") && entree.name !== ".github") continue;
    const chemin = path.join(dossier, entree.name);
    if (entree.isDirectory()) sortie.push(...fichiers(chemin));
    else if (entree.isFile()) sortie.push(chemin);
  }
  return sortie;
}

function jetonsCites(texte: string): string[] {
  const bas = texte.toLowerCase();
  return JETONS_P13.filter((jeton) => bas.includes(jeton.toLowerCase()));
}

// --- Lecture des workflows ------------------------------------------------------------------------------------------------------

interface Etape {
  job: string;
  run: string | null;
  dossier: string;
  uses: string | null;
  with: Json;
}

/** Étapes de tous les workflows, avec leur dossier de travail (`defaults.run.working-directory` du job ou de l'étape). */
function etapesDe(textes: readonly string[]): Etape[] {
  const etapes: Etape[] = [];
  for (const texte of textes) {
    const doc = objet(parseYaml(texte));
    const defautWorkflow = String(objet(objet(doc.defaults).run)["working-directory"] ?? ".");
    for (const [nom, job] of Object.entries(objet(doc.jobs))) {
      const defautJob = String(objet(objet(objet(job).defaults).run)["working-directory"] ?? defautWorkflow);
      for (const etape of tableau(objet(job).steps)) {
        const e = objet(etape);
        etapes.push({
          job: nom,
          run: typeof e.run === "string" ? e.run : null,
          dossier: String(e["working-directory"] ?? defautJob),
          uses: typeof e.uses === "string" ? e.uses : null,
          with: objet(e.with),
        });
      }
    }
  }
  return etapes;
}

const EXTENSIONS_SCRIPT = /\.(?:sh|bash|ps1|psm1|mjs|cjs|js|ts|py)$/i;

/**
 * Scripts du dépôt appelés PAR CHEMIN depuis les `run:` : chaque mot qui désigne un fichier existant du dépôt (depuis la racine
 * ou le dossier de travail). Les lignes `npm …` et `node --test …` sont hors du contrôle : elles lancent les tests du cockpit,
 * qui citent ces chaînes pour les interdire.
 */
function scriptsAppeles(etapes: readonly Etape[], racine: string): string[] {
  const trouves = new Set<string>();
  for (const etape of etapes) {
    if (etape.run === null) continue;
    for (const brute of etape.run.split("\n")) {
      const ligne = brute.trim();
      if (ligne === "" || ligne.startsWith("#") || /^npm\s/.test(ligne) || /^node\s+--test\b/.test(ligne)) continue;
      for (const mot of ligne.split(/[\s"'`;|&()<>]+/)) {
        if (!EXTENSIONS_SCRIPT.test(mot) || mot.includes("$") || mot.includes("://")) continue;
        for (const base of [racine, path.join(racine, etape.dossier)]) {
          const chemin = path.resolve(base, mot);
          if (chemin.startsWith(racine) && fs.existsSync(chemin) && fs.statSync(chemin).isFile()) trouves.add(chemin);
        }
      }
    }
  }
  return [...trouves].sort();
}

const TEXTES_WORKFLOWS = fs
  .readdirSync(WORKFLOWS)
  .filter((nom) => /\.ya?ml$/.test(nom))
  .map((nom) => fs.readFileSync(path.join(WORKFLOWS, nom), "utf8"));
const ETAPES = etapesDe(TEXTES_WORKFLOWS);

// --- T-L15-a ------------------------------------------------------------------------------------------------------------------

describe("P13, T-L15-a : la CI ne cite jamais l'image ni l'extension", () => {
  it("lecture des workflows éprouvée sur un exemple : run simple et bloc, dossier de travail, npm et node --test exclus", (t) => {
    const racine = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "omo-l15a-p13-"));
    t.after(() => fs.rmSync(racine, { recursive: true, force: true }));
    fs.mkdirSync(path.join(racine, "sous"));
    fs.writeFileSync(path.join(racine, "sous", "outil.sh"), "echo\n");
    fs.writeFileSync(path.join(racine, "sous", "suite.ps1"), "echo\n");
    const exemple = [
      "jobs:",
      "  a:",
      "    defaults:",
      "      run:",
      "        working-directory: sous",
      "    steps:",
      "      - run: bash ./outil.sh --option",
      "      - run: npm test ./suite.ps1",
      "      - run: node --test ./suite.ps1",
      "  b:",
      "    steps:",
      "      - run: |",
      "          set -eu",
      "          powershell.exe -File sous/suite.ps1",
    ].join("\n");
    const rel = (chemin: string) => path.relative(racine, chemin).split(path.sep).join("/");
    assert.deepEqual(scriptsAppeles(etapesDe([exemple]), racine).map(rel), ["sous/outil.sh", "sous/suite.ps1"]);
    const sansB = scriptsAppeles(etapesDe([exemple.split("  b:")[0] ?? ""]), racine).map(rel);
    assert.deepEqual(sansB, ["sous/outil.sh"], "npm et node --test ne comptent pas");
  });

  it("aucun fichier de .github ne cite opencode-omo, oh-my-openagent, build-omo-image ni COCKPIT_OMO_IMAGE", () => {
    const tous = fichiers(path.join(RACINE, ".github"));
    assert.ok(tous.length >= 3, "workflows et scripts de CI lus");
    for (const fichier of tous) assert.deepEqual(jetonsCites(fs.readFileSync(fichier, "latin1")), [], relatif(fichier));
  });

  it("aucun script appelé par chemin depuis un run: des workflows ne les cite", () => {
    const appeles = scriptsAppeles(ETAPES, RACINE);
    assert.ok(appeles.length >= 1, "au moins un script appelé par chemin (lecture des workflows en panne sinon)");
    for (const script of appeles) assert.deepEqual(jetonsCites(fs.readFileSync(script, "latin1")), [], relatif(script));
  });

  it("aucune étape ne construit ni ne pousse une image depuis docker/opencode-omo", () => {
    for (const etape of ETAPES) {
      const texte = JSON.stringify(etape);
      assert.deepEqual(jetonsCites(texte), [], `${etape.job} ${etape.uses ?? etape.run ?? ""}`);
    }
  });
});

// --- T-L15-b ------------------------------------------------------------------------------------------------------------------

/** Lockfiles que la CI installe : dossiers des `npm ci`/`npm install` des run:, lockfiles copiés par les Dockerfiles construits. */
function lockfilesInstallesParLaCi(): string[] {
  const trouves = new Set<string>();
  for (const etape of ETAPES) {
    if (etape.run !== null && /\bnpm\s+(?:ci|install|i)\b/.test(etape.run)) trouves.add(path.join(RACINE, etape.dossier, "package-lock.json"));
    const constructions: { dockerfile: string; contexte: string }[] = [];
    if (etape.uses?.startsWith("docker/build-push-action") === true) {
      const contexte = String(etape.with.context ?? ".");
      constructions.push({ dockerfile: path.join(RACINE, String(etape.with.file ?? path.join(contexte, "Dockerfile"))), contexte });
    }
    for (const m of (etape.run ?? "").matchAll(/docker\s+(?:buildx\s+)?build\b[^\n]*?-f\s+(\S+)/g)) constructions.push({ dockerfile: path.join(RACINE, m[1] ?? ""), contexte: "." });
    for (const { dockerfile, contexte } of constructions) {
      assert.ok(fs.existsSync(dockerfile), `Dockerfile construit par la CI absent : ${relatif(dockerfile)}`);
      for (const m of fs.readFileSync(dockerfile, "utf8").matchAll(/^COPY\s+(?!--from)([^\n]+)$/gm)) {
        for (const mot of (m[1] ?? "").split(/\s+/)) {
          if (/(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(mot)) trouves.add(path.join(RACINE, contexte, mot));
        }
      }
    }
  }
  return [...trouves].sort();
}

describe("P13, T-L15-b : aucun lockfile installé par la CI ne contient l'extension", () => {
  it("lockfiles installés par la CI : repérés, présents, sans oh-my-openagent", () => {
    const lockfiles = lockfilesInstallesParLaCi();
    assert.ok(lockfiles.map(relatif).includes("app/package-lock.json"), `app/package-lock.json attendu parmi ${lockfiles.map(relatif).join(", ")}`);
    for (const lockfile of lockfiles) {
      assert.ok(fs.existsSync(lockfile), `lockfile installé par la CI absent : ${relatif(lockfile)}`);
      assert.ok(!relatif(lockfile).startsWith("docker/opencode-omo/"), relatif(lockfile));
      assert.deepEqual(jetonsCites(fs.readFileSync(lockfile, "utf8")), [], relatif(lockfile));
    }
  });

  it("aucun autre lockfile ni package.json du dépôt ne mentionne l'extension (exception P8 limitée à docker/opencode-omo)", () => {
    const candidats = fichiers(RACINE).filter((f) => /(?:^|[\\/])(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(f));
    assert.ok(candidats.map(relatif).includes("app/package.json"));
    for (const fichier of candidats) {
      if (relatif(fichier).startsWith("docker/opencode-omo/")) continue;
      assert.ok(!fs.readFileSync(fichier, "utf8").includes("oh-my-openagent"), relatif(fichier));
    }
  });
});

// --- T-L15-c ------------------------------------------------------------------------------------------------------------------

const IMAGES_RELEASE = ["opencode-cockpit-app", "opencode-cockpit-opencode"];

/** Nom de dépôt d'une image : sans registre, propriétaire, étiquette ni empreinte. */
const nomImage = (reference: string) => (reference.split("@")[0] ?? "").replace(/:[^/]*$/, "").split("/").pop() ?? "";

describe("P13, T-L15-c : l'archive de release ne contient que les deux images du cockpit", () => {
  it("chaque docker save des workflows porte exactement les deux images du cockpit", () => {
    const saves = ETAPES.filter((e) => e.run !== null && /\bdocker\s+save\b/.test(e.run));
    assert.ok(saves.length >= 1, "archive des images repérée");
    for (const etape of saves) {
      const run = etape.run ?? "";
      const valeurs = new Map([...run.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)="([^"]*)"\s*$/gm)].map((m) => [m[1] ?? "", m[2] ?? ""]));
      for (const m of run.matchAll(/\bdocker\s+save\s+([^|\n>]+)/g)) {
        const mots = (m[1] ?? "").trim().split(/\s+/).filter((mot) => !mot.startsWith("-"));
        const images = mots.map((mot) => {
          const variable = /^"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?$/.exec(mot);
          return nomImage(variable ? (valeurs.get(variable[1] ?? "") ?? mot) : mot.replaceAll('"', ""));
        });
        assert.deepEqual([...images].sort(), IMAGES_RELEASE, run);
      }
    }
  });

  it("les images poussées par la CI sont les deux images du cockpit, et elles seules", () => {
    let poussees = 0;
    for (const etape of ETAPES) {
      if (etape.uses?.startsWith("docker/build-push-action") !== true || etape.with.push !== true) continue;
      const tags = String(etape.with.tags ?? "")
        .replace(/\$\{\{[^}]*\}\}/g, "x")
        .split(/[\s,]+/)
        .filter(Boolean);
      assert.ok(tags.length > 0);
      for (const tag of tags) assert.ok(IMAGES_RELEASE.includes(nomImage(tag)), tag);
      poussees += 1;
    }
    assert.ok(poussees >= 1, "étapes de publication repérées");
    for (const etape of ETAPES) assert.doesNotMatch(etape.run ?? "", /\bdocker\s+push\b/);
  });
});

// --- P8 : exception limitée, lockfile, amorce --------------------------------------------------------------------------------------

describe("P8 et D-2b-23 : package.json de l'image", () => {
  const paquet = JSON.parse(fs.readFileSync(path.join(DOCKER_OMO, "package.json"), "utf8")) as Json;

  it("oh-my-openagent épinglé EXACTEMENT en 4.19.4, aucune autre dépendance, jamais publiable", () => {
    assert.deepEqual(paquet.dependencies, { "oh-my-openagent": "4.19.4" });
    for (const cle of ["devDependencies", "optionalDependencies", "peerDependencies", "bundleDependencies", "bundledDependencies", "overrides", "scripts", "workspaces"]) {
      assert.ok(!Object.hasOwn(paquet, cle), cle);
    }
    assert.equal(paquet.private, true);
    assert.notEqual(paquet.name, "oh-my-openagent");
  });

  it("lockfile (accord Q1 (c)) : sha512 partout, registre public, extension identique à l'archive auditée par L20", () => {
    const lock = JSON.parse(fs.readFileSync(path.join(DOCKER_OMO, "package-lock.json"), "utf8")) as Json;
    assert.equal(lock.lockfileVersion, 3);
    const paquets = objet(lock.packages);
    assert.deepEqual(objet(paquets[""]).dependencies, paquet.dependencies, "racine du lockfile = package.json");
    const entrees = Object.entries(paquets).filter(([cle]) => cle !== "");
    assert.ok(entrees.length > 1);
    for (const [cle, valeur] of entrees) {
      const v = objet(valeur);
      assert.ok(cle.startsWith("node_modules/"), cle);
      assert.ok(v.link !== true, `lien local refusé : ${cle}`);
      assert.match(String(v.integrity), /^sha512-[A-Za-z0-9+/]+={0,2}$/, `intégrité sha512 : ${cle}`);
      assert.ok(String(v.resolved).startsWith("https://registry.npmjs.org/"), `registre public : ${cle}`);
    }
    const extension = objet(paquets["node_modules/oh-my-openagent"]);
    assert.equal(extension.version, "4.19.4");
    assert.equal(extension.integrity, INTEGRITE_AUDITEE);
  });
});

describe("D-2b-32 : amorce du manifeste", () => {
  it("amorce présente, d'une seule ligne, reconnue et refusée par le superviseur", () => {
    const texte = fs.readFileSync(path.join(DOCKER_OMO, "omo-manifest.sha256"), "utf8");
    assert.equal(texte, "# amorce\n");
    assert.equal(salle.estAmorce(texte), true);
    const calcule = `${"a".repeat(64)}  /opt/omo/x\nmeta f 444 0:0 /opt/omo/x\n`;
    assert.equal(salle.comparerManifeste(calcule, texte).manifesteReference, "amorce");
  });
});
