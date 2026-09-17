// Politique « modification » E1 à E6 (spécification §4.4, §4.1 ; plan d'exécution, fiche L9a et §3.5 ; mesure MX1 §3, F-o) :
// un cas isolé par règle ; ordre figé E6 → E1 → E2 → E3 → E4 → E5 ; E5 → retour ; liste E2 exacte et échantillon par famille de
// chemins protégés ; borne des 50 % ; diff absent ou illisible ; formes réelles des métadonnées (fixtures/mx1-mesures.json,
// opencode 1.18.30), dont la destination d'un déplacement ; pureté.
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { KEY_FILE_READ_RULES } from "./shared/assistant-rules.ts";
import {
  applyPatchDeletesOrMoves,
  classifyEdit,
  DIFF_MAX_CHARS,
  diffRemovalRatio,
  EDIT_AUTO_RULE,
  EDIT_RULE_ORDER,
  type EditFacts,
  type EditPathFacts,
  editDiffs,
  editTargetPaths,
  isProtectedPath,
  KEY_FILE_GLOBS,
  PATH_MAX_CHARS,
  PATH_MAX_SEGMENTS,
  PROTECTED_GLOBS,
  REMOVAL_RATIO_MAX,
} from "./shared/autonomy-edit-rules.ts";

interface Mx1Case {
  marker: string;
  tool: string;
  asked: { permission: string; patterns: string[]; metadata: Record<string, unknown> };
}

interface Mx1Fixture {
  metadata: Array<{ name: string; directory: string; worktree: string; cases: Mx1Case[] }>;
}

const MX1_URL = new URL("./test-support/fixtures/mx1-mesures.json", import.meta.url);
const mx1 = JSON.parse(fs.readFileSync(MX1_URL, "utf8")) as Mx1Fixture;

const DIR = "/workspace/projet";
const MAX = 25;
const BACKSLASH = String.fromCharCode(92);

/** Diff d'un fichier avec les en-têtes de createTwoFilesPatch ; `body` : en-têtes de blocs et lignes de contenu. */
const diffOf = (file: string, ...body: string[]): string => `Index: ${file}\n${"=".repeat(67)}\n--- ${file}\n+++ ${file}\n${body.map((line) => `${line}\n`).join("")}`;
const EDIT_DIFF = diffOf(`${DIR}/src/app.ts`, "@@ -1,3 +1,3 @@", " ligne 1", "-ligne 2", "+ligne deux", " ligne 3");

const target = (path: string, over: Partial<EditPathFacts> = {}): EditPathFacts => ({ path, resolved: path, inside: true, symlinkOut: false, ...over });
const facts = (over: Partial<EditFacts> = {}): EditFacts => ({
  directoryAllowed: true,
  patterns: ["src/app.ts"],
  paths: [target(`${DIR}/src/app.ts`)],
  deletesOrMoves: false,
  diffs: [EDIT_DIFF],
  filesSoFar: 0,
  newFiles: 1,
  ...over,
});

const AUTO = { verdict: "auto", regle: EDIT_AUTO_RULE } as const;
const attente = (regle: "E1" | "E2" | "E3" | "E4" | "E6") => ({ verdict: "attente", regle }) as const;
const RETOUR = { verdict: "retour", regle: "E5" } as const;

describe("classifyEdit : un cas isolé par règle", () => {
  it("toutes les règles tenues → automatique, code A-edit", () => {
    assert.equal(EDIT_AUTO_RULE, "A-edit");
    assert.deepEqual(classifyEdit(facts(), MAX), AUTO);
  });

  it("E6 : dossier hors du workspace → attente", () => {
    assert.deepEqual(classifyEdit(facts({ directoryAllowed: false }), MAX), attente("E6"));
  });

  it("E1 : motif absent, absolu, avec « .. », « ~ », « $ », lecteur, vide ou avec un caractère de contrôle → attente", () => {
    const refused = [
      [],
      ["/etc/passwd"],
      ["../voisin/x.ts"],
      ["src/../../voisin/x.ts"],
      [`src${BACKSLASH}..${BACKSLASH}..${BACKSLASH}x.ts`],
      ["~/x.ts"],
      ["$HOME/x.ts"],
      ["C:/Windows/x.ts"],
      [`c:${BACKSLASH}x.ts`],
      [`${BACKSLASH}${BACKSLASH}serveur${BACKSLASH}partage${BACKSLASH}x.ts`],
      [""],
      [`src/a${String.fromCharCode(0)}.ts`],
      ["a".repeat(PATH_MAX_CHARS + 1)],
      [42 as unknown as string],
      ["src/app.ts", "/etc/passwd"],
    ];
    for (const patterns of refused) assert.deepEqual(classifyEdit(facts({ patterns }), MAX), attente("E1"), JSON.stringify(patterns));
    // « .. » dans un nom n'est pas un segment « .. ».
    assert.deepEqual(classifyEdit(facts({ patterns: ["src/a..b.ts"] }), MAX), AUTO);
  });

  it("E1 : aucun chemin, chemin hors du dossier, lien sortant, non résolu ou vide → attente", () => {
    const cases: Array<[string, EditPathFacts[]]> = [
      ["aucun chemin", []],
      ["hors du dossier", [target(`${DIR}/src/app.ts`), target("/workspace/autre/x.ts", { inside: false })]],
      ["lien sortant", [target(`${DIR}/lien/x.ts`, { symlinkOut: true })]],
      ["non résolu", [target(`${DIR}/src/app.ts`, { resolved: null })]],
      ["résolu vide", [target(`${DIR}/src/app.ts`, { resolved: "" })]],
      ["chemin vide", [target("", { resolved: `${DIR}/src/app.ts` })]],
      ["chemin absent", [target(undefined as unknown as string, { resolved: `${DIR}/src/app.ts` })]],
    ];
    for (const [name, paths] of cases) assert.deepEqual(classifyEdit(facts({ paths }), MAX), attente("E1"), name);
  });

  it("E2 : chemin protégé dans le chemin demandé, dans le chemin résolu ou dans un motif → attente", () => {
    const workflow = `${DIR}/.github/workflows/x.yml`;
    assert.deepEqual(classifyEdit(facts({ patterns: [".github/workflows/x.yml"], paths: [target(workflow)] }), MAX), attente("E2"));
    // Lien interne « docs » → « .github » : seul le chemin résolu le montre.
    assert.deepEqual(classifyEdit(facts({ paths: [target(`${DIR}/docs/workflows/x.yml`, { resolved: workflow })] }), MAX), attente("E2"));
    // Lien interne « .github » → « ci » : seul le chemin demandé le montre.
    assert.deepEqual(classifyEdit(facts({ paths: [target(workflow, { resolved: `${DIR}/ci/workflows/x.yml` })] }), MAX), attente("E2"));
    assert.deepEqual(classifyEdit(facts({ patterns: ["src/app.ts", "AGENTS.md"] }), MAX), attente("E2"));
  });

  it("E3 : suppression ou déplacement dans apply_patch, diff qui retire plus de 50 % des lignes → attente", () => {
    assert.deepEqual(classifyEdit(facts({ deletesOrMoves: true }), MAX), attente("E3"));
    const empties = diffOf(`${DIR}/src/app.ts`, "@@ -1,2 +0,0 @@", "-ligne 1", "-ligne 2");
    assert.deepEqual(classifyEdit(facts({ diffs: [EDIT_DIFF, empties] }), MAX), attente("E3"));
  });

  it("E4 : aucun diff, diff absent ou illisible → attente", () => {
    for (const diffs of [[], [null], ["pas un diff"], [EDIT_DIFF, null]]) {
      assert.deepEqual(classifyEdit(facts({ diffs }), MAX), attente("E4"), JSON.stringify(diffs));
    }
  });

  it("E5 : fichiers distincts de la demande au-delà de fichiersMax → retour à « Demander à chaque fois », jamais attente", () => {
    assert.deepEqual(classifyEdit(facts({ filesSoFar: 24, newFiles: 1 }), MAX), AUTO);
    assert.deepEqual(classifyEdit(facts({ filesSoFar: 25, newFiles: 1 }), MAX), RETOUR);
    assert.deepEqual(classifyEdit(facts({ filesSoFar: 23, newFiles: 3 }), MAX), RETOUR);
    // Fichier déjà compté : la demande n'ajoute aucun fichier distinct.
    assert.deepEqual(classifyEdit(facts({ filesSoFar: 25, newFiles: 0 }), MAX), AUTO);
    assert.deepEqual(classifyEdit(facts({ filesSoFar: 0, newFiles: 1 }), 0), RETOUR);
  });

  it("E5 : compte ou plafond invalide → retour", () => {
    const invalid: Array<[string, Partial<EditFacts>, number]> = [
      ["filesSoFar négatif", { filesSoFar: -1 }, MAX],
      ["filesSoFar décimal", { filesSoFar: 1.5 }, MAX],
      ["newFiles négatif", { filesSoFar: MAX, newFiles: -1 }, MAX],
      ["newFiles NaN", { newFiles: Number.NaN }, MAX],
      ["newFiles infini", { newFiles: Number.POSITIVE_INFINITY }, MAX],
      ["plafond NaN", {}, Number.NaN],
      ["plafond négatif", {}, -1],
      ["plafond décimal", {}, 25.5],
      ["plafond infini", {}, Number.POSITIVE_INFINITY],
    ];
    for (const [name, over, max] of invalid) assert.deepEqual(classifyEdit(facts(over), max), RETOUR, name);
  });
});

describe("classifyEdit : ordre figé E6 → E1 → E2 → E3 → E4 → E5", () => {
  it("ordre exporté", () => {
    assert.deepEqual(EDIT_RULE_ORDER, ["E6", "E1", "E2", "E3", "E4", "E5"]);
  });

  it("toutes les règles en échec : chaque correction fait apparaître la règle suivante", () => {
    let current = facts({
      directoryAllowed: false,
      patterns: ["../x.ts"],
      paths: [target(`${DIR}/.github/x.yml`, { inside: false })],
      deletesOrMoves: true,
      diffs: [null],
      filesSoFar: MAX,
      newFiles: 1,
    });
    const steps: Array<[ReturnType<typeof classifyEdit>, Partial<EditFacts>]> = [
      [attente("E6"), { directoryAllowed: true }],
      [attente("E1"), { patterns: [".github/x.yml"], paths: [target(`${DIR}/.github/x.yml`)] }],
      [attente("E2"), { patterns: ["src/app.ts"], paths: [target(`${DIR}/src/app.ts`)] }],
      [attente("E3"), { deletesOrMoves: false }],
      [attente("E4"), { diffs: [EDIT_DIFF] }],
      [RETOUR, { filesSoFar: 0 }],
      [AUTO, {}],
    ];
    for (const [expected, fix] of steps) {
      assert.deepEqual(classifyEdit(current, MAX), expected);
      current = { ...current, ...fix };
    }
  });

  it("E3 avant E4 : un diff qui vide le fichier l'emporte sur un diff illisible ; un diff illisible seul relève de E4", () => {
    const empties = diffOf(`${DIR}/src/app.ts`, "@@ -1,1 +0,0 @@", "-seule ligne");
    assert.deepEqual(classifyEdit(facts({ diffs: [null, empties] }), MAX), attente("E3"));
    assert.deepEqual(classifyEdit(facts({ diffs: ["illisible"] }), MAX), attente("E4"));
  });
});

/** Liste E2 du §4.4, recopiée de la spécification (révision 2), sans les fichiers de clés. */
const SPEC_E2_GLOBS = [
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
];

/** Échantillon par famille de chemins protégés (relatifs ; aussi essayés en absolu, en profondeur et en majuscules). */
const PROTECTED_SAMPLES: Record<string, string[]> = {
  git: [".git/config", ".git/hooks/pre-commit", ".git", "vendor/lib/.git", ".gitmodules", ".gitattributes"],
  "consignes d'IA et opencode": [".opencode/agent/revue.md", "opencode.json", "opencode.jsonc", "AGENTS.md", "docs/CLAUDE.md"],
  "CI/CD": [".github/workflows/x.yml", ".github", ".gitlab-ci.yml", "Jenkinsfile", "azure-pipelines.yml", "azure-pipelines-prod.yml"],
  "outils de développement": [".vscode/settings.json", ".idea/workspace.xml", ".devcontainer/devcontainer.json", ".husky/pre-commit", ".pre-commit-config.yaml"],
  "gestionnaires de paquets": [".npmrc", ".yarnrc", ".yarnrc.yml", "pip.conf", ".pypirc", "maven/settings.xml"],
  infrastructure: [
    "Dockerfile",
    "Dockerfile.prod",
    "docker-compose.yml",
    "docker-compose.override.yaml",
    "infra/main.tf",
    "prod.tfvars",
    "packer.pkr.hcl",
    "helm/values.yaml",
    "k8s/deploy.yaml",
    "kustomization.yaml",
    "kustomization.yml",
    "ansible/site.yml",
  ],
  environnement: [".env", ".env.local", ".env.example", ".envrc", "config/prod.env", "config/app.env.local"],
  "fichiers de clés": [
    "certs/client.pfx",
    "certs/client.p12",
    "tls/server.key",
    "keystore.jks",
    "app.keystore",
    "coffre.kdbx",
    "ssh/privkey.pem",
    "tls-key.pem",
    "tls_key.pem",
    "ssh/id_rsa",
    "ssh/id_ecdsa.pub",
    "ssh/id_ed25519",
    "kubeconfig-prod",
    "home/.kube/config",
  ],
};

const NOT_PROTECTED = [
  "src/app.ts",
  "README.md",
  ".gitignore",
  "package.json",
  "docs/github-actions.md",
  "src/environment.ts",
  "src/keys.ts",
  "src/monkey.py",
  "helmet.config.js",
  "src/k8s.ts",
  "docs/ansible-notes.md",
  "settings.json",
  "pipeline.yml",
  "src/agents/liste.md",
  "notes~brouillon.md",
  "un-nom-assez-long~1.txt",
  "workspace/meta/existant.txt",
  "/workspace/meta-git/sous/deplace.txt",
];

describe("isProtectedPath : liste E2 (§4.4)", () => {
  it("liste exacte : §4.4 dans l'ordre, puis les fichiers de clés (entrées deny et ask de KEY_FILE_READ_RULES)", () => {
    const keyGlobs = Object.entries(KEY_FILE_READ_RULES)
      .filter(([, action]) => action !== "allow")
      .map(([glob]) => glob);
    assert.deepEqual(KEY_FILE_GLOBS, keyGlobs);
    assert.ok(KEY_FILE_GLOBS.includes("*.pfx") && KEY_FILE_GLOBS.includes("*.env") && !KEY_FILE_GLOBS.includes("*.env.example"));
    assert.deepEqual(PROTECTED_GLOBS, [...SPEC_E2_GLOBS, ...keyGlobs]);
    assert.ok(Object.isFrozen(PROTECTED_GLOBS) && Object.isFrozen(KEY_FILE_GLOBS));
  });

  it("échantillon par famille : relatif, absolu, en profondeur, en majuscules et avec « \\ »", () => {
    for (const [family, samples] of Object.entries(PROTECTED_SAMPLES)) {
      for (const sample of samples) {
        for (const form of [sample, `${DIR}/${sample}`, `${DIR}/sous/dossier/${sample}`, sample.toUpperCase(), `sous/${sample}`.replaceAll("/", BACKSLASH)]) {
          assert.equal(isProtectedPath(form), true, `${family} : ${form}`);
        }
      }
    }
  });

  it("chemins ordinaires : non protégés", () => {
    for (const path of NOT_PROTECTED) assert.equal(isProtectedPath(path), false, path);
  });

  it("nom court 8.3 possible (« GITHUB~1 ») : protégé", () => {
    assert.equal(isProtectedPath(`${DIR}/GITHUB~1/workflows/x.yml`), true);
    assert.equal(isProtectedPath("AGENTS~1.MD"), true);
  });

  it("illisible → protégé : vide, racine seule, trop long, trop profond, caractère de contrôle", () => {
    for (const path of ["", "/", ".", "./", `src/a${String.fromCharCode(0)}.ts`, "src/a\nb.ts", `src/a${String.fromCharCode(127)}.ts`]) {
      assert.equal(isProtectedPath(path), true, JSON.stringify(path));
    }
    assert.equal(isProtectedPath("a".repeat(PATH_MAX_CHARS)), false);
    assert.equal(isProtectedPath("a".repeat(PATH_MAX_CHARS + 1)), true);
    const deep = (n: number) => Array.from({ length: n }, () => "a").join("/");
    assert.equal(isProtectedPath(deep(PATH_MAX_SEGMENTS)), false);
    assert.equal(isProtectedPath(deep(PATH_MAX_SEGMENTS + 1)), true);
    assert.equal(isProtectedPath(undefined as unknown as string), true);
  });
});

describe("diffRemovalRatio : borne des 50 % (E3) et diff lisible (E4)", () => {
  const file = `${DIR}/src/app.ts`;
  const ratio = (...body: string[]) => diffRemovalRatio(diffOf(file, ...body));

  it("borne : exactement 50 % → automatique ; au-delà → attente E3", () => {
    assert.equal(REMOVAL_RATIO_MAX, 0.5);
    const half = diffOf(file, "@@ -1,2 +1,1 @@", " ligne 1", "-ligne 2");
    const twoThirds = diffOf(file, "@@ -1,3 +1,1 @@", " ligne 1", "-ligne 2", "-ligne 3");
    assert.equal(diffRemovalRatio(half), 0.5);
    assert.deepEqual(classifyEdit(facts({ diffs: [half] }), MAX), AUTO);
    assert.equal(diffRemovalRatio(twoThirds), 2 / 3);
    assert.deepEqual(classifyEdit(facts({ diffs: [twoThirds] }), MAX), attente("E3"));
  });

  it("une ligne remplacée compte comme retirée ; fichier vidé → 1 ; fichier nouveau ou diff sans bloc → 0", () => {
    assert.equal(ratio("@@ -1,2 +1,2 @@", "-ligne 1", "+ligne un", " ligne 2"), 0.5);
    assert.equal(ratio("@@ -1,2 +1,2 @@", "-ligne 1", "-ligne 2", "+autre 1", "+autre 2"), 1);
    assert.equal(ratio("@@ -1,3 +0,0 @@", "-a", "-b", "-c"), 1);
    assert.equal(ratio("@@ -0,0 +1,2 @@", "+a", "+b"), 0);
    assert.equal(diffRemovalRatio(diffOf(file)), 0);
  });

  it("blocs partiels (4 lignes de contexte) : dénominateur = fin du dernier bloc, le taux n'est jamais minoré", () => {
    const context = (from: number, n: number) => Array.from({ length: n }, (_, k) => ` ligne ${from + k}`);
    // Une ligne retirée au milieu d'un fichier d'au moins 104 lignes.
    assert.equal(ratio("@@ -96,9 +96,8 @@", ...context(96, 4), "-ligne 100", ...context(101, 4)), 1 / 104);
    // Deux blocs : le second fixe le dénominateur.
    assert.equal(ratio("@@ -1,5 +1,4 @@", "-ligne 1", ...context(2, 4), "@@ -20,9 +19,9 @@", ...context(20, 4), "-ligne 24", "+ligne vingt-quatre", ...context(25, 4)), 2 / 28);
    // Dix lignes retirées en tête d'un grand fichier : taux majoré (10/14), donc attente, du côté prudent.
    assert.equal(ratio("@@ -1,14 +1,4 @@", ...Array.from({ length: 10 }, (_, k) => `-ligne ${k + 1}`), ...context(11, 4)), 10 / 14);
  });

  it("lignes de contenu qui ressemblent à des en-têtes (« --- », « +++ », « @@ ») : lues comme contenu", () => {
    assert.equal(ratio("@@ -1,2 +1,2 @@", "--- commentaire SQL", "+++ ajout", " @@ -1,1 +1,1 @@"), 0.5);
  });

  it("« \\ No newline at end of file » : permis après une ligne de contenu seulement", () => {
    const marker = `${BACKSLASH} No newline at end of file`;
    assert.equal(ratio("@@ -1,1 +1,1 @@", "-ancien", marker, "+nouveau", marker), 1);
    assert.equal(ratio("@@ -1,1 +1,1 @@", marker, "-ancien", "+nouveau"), null);
    assert.equal(ratio("@@ -1,1 +1,1 @@", "-ancien", marker, marker, "+nouveau"), null);
  });

  it("en-têtes Index et ==== facultatifs ; compte omis = 1", () => {
    assert.equal(diffRemovalRatio(`--- ${file}\n+++ ${file}\n@@ -1 +1 @@\n-a\n+b\n`), 1);
  });

  it("absent ou illisible → null", () => {
    const tooShort = diffOf(file, "@@ -1,3 +1,3 @@", " ligne 1", "-ligne 2", "+ligne deux");
    const trailing = `${EDIT_DIFF}texte hors bloc\n`;
    const backwards = diffOf(file, "@@ -10,1 +10,1 @@", "-a", "+b", "@@ -5,1 +5,1 @@", "-c", "+d");
    const overlapping = diffOf(file, "@@ -10,2 +10,2 @@", "-a", "-b", "+c", "+d", "@@ -11,1 +11,1 @@", "-e", "+f");
    // Nom de fichier avec un saut de ligne qui imite un bloc : les en-têtes ne se suivent plus.
    const forged = diffOf(`${DIR}/x\n@@ -1,1000 +1,1000 @@`, "@@ -1,1 +1,0 @@", "-a");
    const illegible: Array<[string, unknown]> = [
      ["undefined", undefined],
      ["null", null],
      ["nombre", 42],
      ["chaîne vide", ""],
      ["texte", "pas un diff"],
      ["sans ---", `+++ ${file}\n@@ -1 +1 @@\n-a\n+b\n`],
      ["sans +++", `--- ${file}\n@@ -1 +1 @@\n-a\n+b\n`],
      ["--- et +++ remplacés", `Index: ${file}\n${"=".repeat(67)}\nxxx ${file}\nyyy ${file}\n@@ -1 +1 @@\n-a\n+b\n`],
      ["en-tête de bloc précédé de texte", diffOf(file, "texte @@ -1,1 +1,1 @@", "-a", "+b")],
      ["début 0 côté nouveau avec des lignes", diffOf(file, "@@ -1,1 +0,1 @@", "-a", "+b")],
      ["compte non atteint", tooShort],
      ["ajout manquant en fin de diff", diffOf(file, "@@ -1,1 +1,2 @@", "-a", "+b")],
      ["retrait manquant en fin de diff", diffOf(file, "@@ -1,2 +1,1 @@", "-a", "+b")],
      ["ligne après le dernier bloc", trailing],
      ["blocs dans le désordre", backwards],
      ["blocs qui se chevauchent", overlapping],
      ["début 0 avec des lignes", diffOf(file, "@@ -0,1 +1,1 @@", "-a", "+b")],
      ["bloc vide", diffOf(file, "@@ -0,0 +0,0 @@")],
      ["opération inconnue", diffOf(file, "@@ -1,1 +1,1 @@", "*a", "+b")],
      ["ligne vide dans un bloc", diffOf(file, "@@ -1,2 +1,2 @@", " a", "", "-b", "+c")],
      ["retrait de trop", diffOf(file, "@@ -1,1 +1,1 @@", "-a", "-b", "+c")],
      ["ajout de trop", diffOf(file, "@@ -1,1 +1,1 @@", "-a", "+b", "+c")],
      ["nom forgé", forged],
      ["trop long", diffOf(file, "@@ -1,1 +1,1 @@", `-${"a".repeat(DIFF_MAX_CHARS)}`, "+b")],
    ];
    for (const [name, diff] of illegible) assert.equal(diffRemovalRatio(diff), null, name);
  });
});

/** Résultats attendus sur les 7 cas mesurés, identiques dans un dépôt git et hors git. */
const MX1_EXPECTED: Record<string, { deletesOrMoves: boolean; ratios: number[]; paths: number; verdict: ReturnType<typeof classifyEdit> }> = {
  "META-EDIT": { deletesOrMoves: false, ratios: [1 / 3], paths: 1, verdict: AUTO },
  "META-WRITE": { deletesOrMoves: false, ratios: [0], paths: 1, verdict: AUTO },
  "META-PADD": { deletesOrMoves: false, ratios: [0], paths: 1, verdict: AUTO },
  "META-PUPD": { deletesOrMoves: false, ratios: [1 / 3], paths: 1, verdict: AUTO },
  "META-PDEL": { deletesOrMoves: true, ratios: [1], paths: 1, verdict: attente("E3") },
  "META-PMOVE": { deletesOrMoves: true, ratios: [1 / 3], paths: 2, verdict: attente("E3") },
  "META-PMULTI": { deletesOrMoves: true, ratios: [0, 1 / 3, 1, 1 / 3], paths: 5, verdict: attente("E3") },
};

/** Faits d'un cas mesuré, comme L10b les relèverait pour des fichiers intérieurs, sans lien, non protégés. */
function factsOf(metadata: Record<string, unknown>, patterns: readonly string[], paths?: EditPathFacts[]): EditFacts {
  const targets = editTargetPaths(metadata);
  assert.ok(targets, "métadonnées illisibles");
  return {
    directoryAllowed: true,
    patterns,
    paths: paths ?? targets.map((path) => target(path)),
    deletesOrMoves: applyPatchDeletesOrMoves(metadata),
    diffs: editDiffs(metadata),
    filesSoFar: 0,
    newFiles: new Set(targets).size,
  };
}

describe("formes des métadonnées mesurées (MX1, opencode 1.18.30)", () => {
  it("les 14 cas : chemins, diffs, suppression ou déplacement, taux et décision", () => {
    let count = 0;
    for (const directory of mx1.metadata) {
      for (const c of directory.cases) {
        const expected = MX1_EXPECTED[c.marker];
        assert.ok(expected, c.marker);
        const label = `${directory.name} ${c.marker}`;
        const metadata = c.asked.metadata;
        const files = metadata.files as Array<Record<string, unknown>> | undefined;
        const targets = editTargetPaths(metadata);
        assert.ok(targets, label);
        assert.equal(targets.length, expected.paths, label);
        assert.ok(
          targets.every((path) => path.startsWith(`${directory.directory}/`)),
          `${label} : chemins absolus du dossier`,
        );
        if (c.tool === "apply_patch") {
          assert.ok(files, label);
          assert.deepEqual(editDiffs(metadata), files.map((file) => file.patch), label);
          // metadata.filepath d'apply_patch (relatif au worktree, joint par « , ») n'est jamais lu.
          assert.equal(targets.includes(String(metadata.filepath)), false, label);
          for (const file of files) if (file.type === "move") assert.ok(targets.includes(String(file.movePath)), `${label} : destination`);
        } else {
          assert.equal(files, undefined, label);
          assert.deepEqual(targets, [metadata.filepath], label);
          assert.deepEqual(editDiffs(metadata), [metadata.diff], label);
        }
        assert.equal(applyPatchDeletesOrMoves(metadata), expected.deletesOrMoves, label);
        assert.deepEqual(editDiffs(metadata).map(diffRemovalRatio), expected.ratios, label);
        assert.deepEqual(classifyEdit(factsOf(metadata, c.asked.patterns), MAX), expected.verdict, label);
        count++;
      }
    }
    assert.equal(count, 14);
  });

  it("déplacement mesuré vers un chemin protégé → E2 ; hors du dossier → E1 (la destination n'est que dans movePath)", () => {
    const move = mx1.metadata[0]?.cases.find((c) => c.marker === "META-PMOVE");
    assert.ok(move);
    const files = move.asked.metadata.files as Array<Record<string, unknown>>;
    const toProtected = { ...move.asked.metadata, files: [{ ...files[0], movePath: "/workspace/meta-git/.github/workflows/x.yml" }] };
    const toProtectedFacts = factsOf(toProtected, move.asked.patterns);
    assert.deepEqual(move.asked.patterns, ["a-deplacer.txt"]);
    assert.deepEqual(classifyEdit(toProtectedFacts, MAX), attente("E2"));
    const outside = { ...move.asked.metadata, files: [{ ...files[0], movePath: "/workspace/autre/deplace.txt" }] };
    const targets = editTargetPaths(outside) ?? [];
    const outsideFacts = factsOf(outside, move.asked.patterns, targets.map((path) => target(path, { inside: path.startsWith("/workspace/meta-git/") })));
    assert.deepEqual(classifyEdit(outsideFacts, MAX), attente("E1"));
  });

  it("formes illisibles ou inattendues", () => {
    const file = { filePath: `${DIR}/a.txt`, relativePath: "a.txt", type: "update", patch: EDIT_DIFF, additions: 1, deletions: 1 };
    // Métadonnées absentes : aucun chemin, diff absent, rien à dire d'apply_patch.
    for (const metadata of [null, undefined, "texte", [1, 2]]) {
      assert.equal(editTargetPaths(metadata), null);
      assert.deepEqual(editDiffs(metadata), [null]);
      assert.equal(applyPatchDeletesOrMoves(metadata), false);
    }
    // Tableau porteur de propriétés : jamais lu comme des métadonnées.
    const array = Object.assign([], { filepath: `${DIR}/a.txt`, diff: EDIT_DIFF, files: [{ ...file, type: "delete" }] });
    assert.equal(editTargetPaths(array), null);
    assert.deepEqual(editDiffs(array), [null]);
    assert.equal(applyPatchDeletesOrMoves(array), false);
    // edit/write sans filepath, avec un filepath qui n'est pas absolu, ou sans diff.
    assert.equal(editTargetPaths({ diff: EDIT_DIFF }), null);
    assert.equal(editTargetPaths({ filepath: "", diff: EDIT_DIFF }), null);
    assert.equal(editTargetPaths({ filepath: "src/app.ts", diff: EDIT_DIFF }), null);
    assert.equal(editTargetPaths({ filepath: `C:${BACKSLASH}src${BACKSLASH}app.ts`, diff: EDIT_DIFF }), null);
    assert.deepEqual(editDiffs({ filepath: `${DIR}/a.txt`, diff: 42 }), [null]);
    // files qui n'est pas un tableau.
    assert.equal(editTargetPaths({ filepath: "a.txt", files: {} }), null);
    assert.deepEqual(editDiffs({ files: {} }), [null]);
    assert.equal(applyPatchDeletesOrMoves({ files: {} }), true);
    // Entrée qui n'est pas un objet, sans filePath, déplacement sans movePath, movePath vide.
    for (const entry of ["x", null]) {
      assert.equal(editTargetPaths({ files: [file, entry] }), null);
      assert.equal(applyPatchDeletesOrMoves({ files: [file, entry] }), true);
      assert.deepEqual(editDiffs({ files: [file, entry] }), [EDIT_DIFF, null]);
    }
    assert.equal(editTargetPaths({ files: [{ ...file, filePath: undefined }] }), null);
    assert.equal(editTargetPaths({ files: [{ ...file, type: "move" }] }), null);
    assert.equal(editTargetPaths({ files: [{ ...file, type: "move", movePath: "" }] }), null);
    // filePath ou movePath qui n'est pas absolu (relativePath pris à la place, par exemple).
    assert.equal(editTargetPaths({ files: [{ ...file, filePath: "a.txt" }] }), null);
    assert.equal(editTargetPaths({ files: [{ ...file, type: "move", movePath: "sous/b.txt" }] }), null);
    assert.deepEqual(editDiffs({ files: [file, { ...file, patch: undefined }] }), [EDIT_DIFF, null]);
    // movePath sans type move, type inconnu : traités comme un déplacement.
    assert.equal(applyPatchDeletesOrMoves({ files: [{ ...file, movePath: `${DIR}/b.txt` }] }), true);
    assert.deepEqual(editTargetPaths({ files: [{ ...file, movePath: `${DIR}/b.txt` }] }), [`${DIR}/a.txt`, `${DIR}/b.txt`]);
    assert.equal(applyPatchDeletesOrMoves({ files: [{ ...file, type: "rename" }] }), true);
    assert.equal(applyPatchDeletesOrMoves({ files: [{ ...file, type: undefined }] }), true);
    // apply_patch sans fichier : aucun chemin → E1.
    assert.deepEqual(editTargetPaths({ files: [] }), []);
    assert.deepEqual(editDiffs({ files: [] }), []);
    assert.equal(applyPatchDeletesOrMoves({ files: [] }), false);
    assert.deepEqual(classifyEdit(facts({ paths: [], diffs: [] }), MAX), attente("E1"));
    // metadata.filepath d'apply_patch jamais lu, même quand il sort du dossier.
    assert.deepEqual(editTargetPaths({ filepath: "../../etc/passwd", files: [file] }), [`${DIR}/a.txt`]);
  });

  it("apply_patch mesuré privé de files[] : son filepath relatif n'est pas lu comme celui d'un edit, son diff concaténé est illisible", () => {
    for (const directory of mx1.metadata) {
      for (const c of directory.cases.filter((one) => one.tool === "apply_patch")) {
        const { files: _files, ...withoutFiles } = c.asked.metadata;
        const label = `${directory.name} ${c.marker}`;
        assert.equal(editTargetPaths(withoutFiles), null, label);
        assert.deepEqual(editDiffs(withoutFiles).map(diffRemovalRatio), [null], label);
      }
    }
  });

  it("propriétés héritées du prototype : jamais lues", () => {
    const inherited = Object.create({ files: [{ filePath: "/etc/passwd", type: "delete", patch: EDIT_DIFF }] }) as Record<string, unknown>;
    inherited.filepath = `${DIR}/a.txt`;
    inherited.diff = EDIT_DIFF;
    assert.deepEqual(editTargetPaths(inherited), [`${DIR}/a.txt`]);
    assert.deepEqual(editDiffs(inherited), [EDIT_DIFF]);
    assert.equal(applyPatchDeletesOrMoves(inherited), false);
  });
});

describe("autonomy-edit-rules : pureté", () => {
  it("source : n'importe que assistant-rules.ts, ni module node ni process", () => {
    const source = fs.readFileSync(new URL("./shared/autonomy-edit-rules.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)].map((m) => m[1]);
    assert.deepEqual(imports, ["./assistant-rules.ts"]);
    assert.equal(source.includes('"node:'), false);
    assert.equal(/\bprocess\./.test(source), false);
  });

  it("faits gelés : aucune écriture, même résultat à chaque appel", () => {
    const deepFreeze = <T>(value: T): T => {
      if (typeof value === "object" && value !== null) {
        for (const inner of Object.values(value)) deepFreeze(inner);
        Object.freeze(value);
      }
      return value;
    };
    const cases = [facts(), facts({ directoryAllowed: false }), facts({ diffs: [null] }), facts({ filesSoFar: MAX })];
    for (const current of cases) {
      const frozen = deepFreeze(structuredClone(current));
      const before = JSON.stringify(frozen);
      const first = classifyEdit(frozen, MAX);
      assert.deepEqual(classifyEdit(frozen, MAX), first);
      assert.equal(JSON.stringify(frozen), before);
    }
  });
});
