// Faits d'une demande de modification (spécification §4.4, F-o ; plan d'exécution, fiche L10b et report des mesures §3.5 ; mesure
// MX1 §3) : collectEditFacts sur un vrai disque (workspace temporaire, monté en « /workspace » pour opencode), puis classifyEdit.
// Cas de la fiche : fichier intérieur, « .. », lien sortant (sauté avec sa raison quand Windows refuse les liens, EPERM ;
// obligatoire ailleurs), chemin absolu /workspace, diff absent, apply_patch avec suppression et déplacement ; en plus, lien
// physique (opencode réécrit sur place, realpath ne montre pas l'autre nom), obligatoire partout. Cas du report MX1 :
// déplacement vers un chemin protégé et hors du dossier, dossier hors git (worktree « / », GET /path du faux opencode). Les 14
// demandes mesurées sont rejouées sur disque. Relecture 2-vague-1 : « add » d'apply_patch sur un fichier existant, ou dont
// l'absence n'est pas prouvée → E3. Chaque garde du module a au moins un test qui échoue sans elle.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";
import { type CollectedEditFacts, collectEditFacts, EDIT_PATHS_MAX, type EditFactsOptions, type EditFactsProjects, type EditFilesSoFar } from "./edit-facts.ts";
import { OpencodeClient } from "./opencode.ts";
import { ProjectsService } from "./projects.ts";
import { classifyEdit, EDIT_AUTO_RULE, type EditPathFacts, type EditVerdict } from "./shared/autonomy-edit-rules.ts";
import { FakeOpencode, type FakePermissionRequest, type FakeSession, type FakeToolScript } from "./test-support/fake-opencode.ts";
import { applyPatchTool, editTool, promptAsync, within } from "./test-support/helpers.ts";

interface Mx1Case {
  marker: string;
  tool: string;
  asked: { permission: string; patterns: string[]; metadata: Record<string, unknown> };
}

interface Mx1Fixture {
  files: Record<string, string>;
  metadata: Array<{ name: string; directory: string; worktree: string; cases: Mx1Case[] }>;
}

const mx1 = JSON.parse(fs.readFileSync(new URL("./test-support/fixtures/mx1-mesures.json", import.meta.url), "utf8")) as Mx1Fixture;

const OC = "/workspace";
const CONV = "/workspace/proj";
const MAX = 25;
const LINES = "ligne 1\nligne 2\nligne 3\n";
const BACKSLASH = String.fromCharCode(92);

const AUTO: EditVerdict = { verdict: "auto", regle: EDIT_AUTO_RULE };
const attente = (regle: "E1" | "E2" | "E3" | "E4" | "E6"): EditVerdict => ({ verdict: "attente", regle });

/** Racine locale du workspace (vue du cockpit) et dossier hors du workspace, recréés pour ce fichier. */
let root = "";
let outside = "";
let projects: ProjectsService;

const local = (rel: string) => path.join(root, ...rel.split("/"));

function put(rel: string, content: string): void {
  fs.mkdirSync(path.dirname(local(rel)), { recursive: true });
  fs.writeFileSync(local(rel), content);
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-edit-facts-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-edit-facts-hors-"));
  // proj : dépôt git (worktree = dossier) ; libre : hors git (worktree « / ») ; autre : un autre projet du workspace.
  fs.mkdirSync(local("proj/.git"), { recursive: true });
  for (const name of ["src/app.ts", "existant.txt", "a-supprimer.txt", "a-deplacer.txt"]) put(`proj/${name}`, LINES);
  put("proj/.github/workflows/ci.yml", "on: push\n");
  put("autre/cible.txt", LINES);
  put("libre/a.txt", LINES);
  fs.writeFileSync(path.join(outside, "hors.txt"), LINES);
  // Témoins des 14 demandes mesurées (MX1 §3) : meta-git (dépôt git) et meta (hors git).
  fs.mkdirSync(local("meta-git/.git"), { recursive: true });
  for (const directory of ["meta-git", "meta"]) for (const [name, content] of Object.entries(mx1.files)) put(`${directory}/${name}`, content);
  projects = new ProjectsService({ workspaceDir: root, opencodeWorkspaceDir: OC });
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

/** Diff d'un fichier avec les en-têtes de createTwoFilesPatch (tool/edit.ts), comme opencode 1.18.30 le publie. */
const diffOf = (file: string, ...body: string[]): string => `Index: ${file}\n${"=".repeat(67)}\n--- ${file}\n+++ ${file}\n${body.map((line) => `${line}\n`).join("")}`;
const UPDATE = ["@@ -1,3 +1,3 @@", " ligne 1", "-ligne 2", "+ligne deux", " ligne 3"];
const CREATE = ["@@ -0,0 +1,1 @@", "+nouveau"];
const DELETE = ["@@ -1,3 +0,0 @@", "-ligne 1", "-ligne 2", "-ligne 3"];

/** Demande edit ou write (MX1 §3) : motif relatif au worktree, metadata {filepath absolu, diff}. */
function editRequest(filepath: string, patterns: unknown, metadata: Record<string, unknown> = { filepath, diff: diffOf(filepath, ...UPDATE) }) {
  return { id: "per_1", sessionID: "ses_1", permission: "edit", patterns, always: ["*"], metadata, tool: { messageID: "msg_1", callID: "call_1" } };
}

interface PatchFile {
  filePath: string;
  type: "add" | "update" | "delete" | "move";
  movePath?: string;
}

/** Demande apply_patch (MX1 §3) : files[] {filePath, relativePath, type, patch, additions, deletions, movePath} ; filepath jamais lu. */
function patchRequest(files: PatchFile[], patterns: string[], filepath = patterns.join(", ")) {
  const entries = files.map((file) => {
    const body = file.type === "add" ? CREATE : file.type === "delete" ? DELETE : UPDATE;
    return {
      filePath: file.filePath,
      relativePath: path.posix.relative(CONV, file.movePath ?? file.filePath),
      type: file.type,
      patch: diffOf(file.filePath, ...body),
      additions: file.type === "delete" ? 0 : 1,
      deletions: file.type === "delete" ? 4 : file.type === "add" ? 0 : 1,
      ...(file.movePath ? { movePath: file.movePath } : {}),
    };
  });
  const metadata = { filepath, diff: entries.map((entry) => `${entry.patch}\n`).join(""), files: entries };
  return { id: "per_2", sessionID: "ses_1", permission: "edit", patterns, always: ["*"], metadata, tool: { messageID: "msg_2", callID: "call_2" } };
}

const collect = (request: unknown, conversationDir = CONV, filesSoFar: EditFilesSoFar = new Set<string>(), options: EditFactsOptions = {}, service: EditFactsProjects = projects) =>
  collectEditFacts(request, conversationDir, service, filesSoFar, options);

const decide = (facts: CollectedEditFacts): EditVerdict => classifyEdit(facts, MAX);

const inner = (file: string): EditPathFacts => ({ path: file, resolved: file, inside: true, symlinkOut: false });

const LINK_SKIP = "Windows refuse de créer un lien symbolique (EPERM, mode développeur absent) : cas obligatoire sous Linux (CI, conteneur).";

/** Lien symbolique ; faux seulement quand Windows refuse d'en créer (EPERM) : le test est alors sauté avec LINK_SKIP. */
function link(target: string, file: string, type: "file" | "dir"): boolean {
  try {
    fs.symlinkSync(target, file, type);
    return true;
  } catch (err) {
    if (process.platform === "win32" && (err as NodeJS.ErrnoException).code === "EPERM") return false;
    throw err;
  }
}

/** Espions des lectures du disque : realpath, lstat, stat. */
function spyDisk(t: TestContext): () => number {
  const spies = [t.mock.method(fsp, "realpath"), t.mock.method(fsp, "lstat"), t.mock.method(fsp, "stat")];
  return () => spies.reduce((sum, spy) => sum + spy.mock.callCount(), 0);
}

describe("collectEditFacts : fichier intérieur", () => {
  it("edit d'un fichier existant (dépôt git) : chemin réel dans la vue d'opencode, intérieur, motif résolu depuis le worktree → auto", async () => {
    const file = `${CONV}/src/app.ts`;
    const facts = await collect(editRequest(file, ["src/app.ts"]));
    assert.deepEqual(facts, {
      directoryAllowed: true,
      patterns: ["src/app.ts"],
      deletesOrMoves: false,
      diffs: [diffOf(file, ...UPDATE)],
      filesSoFar: 0,
      // Motif « src/app.ts » résolu depuis le worktree (dossier du dépôt) : même chemin que filepath, examiné une fois.
      paths: [inner(file)],
      newFiles: 1,
      touchedFiles: [file],
    });
    assert.deepEqual(decide(facts), AUTO);
  });

  it("write d'un fichier à créer sous des dossiers absents : parent existant résolu, reste ajouté → auto", async () => {
    const file = `${CONV}/nouveau/sous/x.txt`;
    const facts = await collect(editRequest(file, ["nouveau/sous/x.txt"], { filepath: file, diff: diffOf(file, ...CREATE) }));
    assert.deepEqual(facts.paths, [inner(file)]);
    assert.deepEqual(decide(facts), AUTO);
    assert.equal(fs.existsSync(local("proj/nouveau")), false, "rien n'est créé");
  });

  it("conversation à la racine /workspace (hors git, worktree « / ») : un fichier d'un projet y est intérieur → auto", async () => {
    const file = `${CONV}/src/app.ts`;
    const facts = await collect(editRequest(file, ["workspace/proj/src/app.ts"]), OC);
    assert.deepEqual(facts.paths, [inner(file)]);
    assert.deepEqual(decide(facts), AUTO);
  });
});

describe("collectEditFacts : « .. »", () => {
  it("filepath avec « .. » : jamais résolu, même quand la normalisation le ramènerait dans le dossier → E1", async () => {
    for (const file of [`${CONV}/../autre/cible.txt`, `${CONV}/src/../src/app.ts`, `${CONV}/src/..`]) {
      const facts = await collect(editRequest(file, ["src/app.ts"]));
      assert.deepEqual(facts.paths[0], { path: file, resolved: null, inside: false, symlinkOut: false }, file);
      assert.deepEqual(decide(facts), attente("E1"), file);
    }
  });

  it("motif avec « .. » : non résolu (le motif est gardé tel quel pour E1)", async () => {
    const file = `${CONV}/src/app.ts`;
    const facts = await collect(editRequest(file, ["src/../src/app.ts"]));
    assert.deepEqual(facts.paths, [inner(file), { path: `${CONV}/src/../src/app.ts`, resolved: null, inside: false, symlinkOut: false }]);
    assert.deepEqual(decide(facts), attente("E1"));
  });
});

describe("collectEditFacts : chemin absolu /workspace (F-o)", () => {
  it("resolved est dans la vue d'opencode : le chemin local du cockpit n'y apparaît jamais", async () => {
    const facts = await collect(editRequest(`${CONV}/existant.txt`, ["existant.txt"]));
    for (const entry of facts.paths) {
      assert.ok(entry.resolved?.startsWith(`${OC}/`), String(entry.resolved));
      assert.equal(entry.resolved?.includes(path.basename(root)), false);
    }
  });

  it("hors du workspace, ou préfixe voisin de /workspace : non résolu → E1", async () => {
    for (const file of ["/etc/passwd", "/workspacex/proj/a.txt", "/workspace-bis/proj/a.txt", "/"]) {
      const facts = await collect(editRequest(file, ["src/app.ts"]));
      assert.deepEqual(facts.paths[0], { path: file, resolved: null, inside: false, symlinkOut: false }, file);
      assert.deepEqual(decide(facts), attente("E1"), file);
    }
  });

  it("autre projet du workspace : résolu, mais hors du dossier de la conversation (fichier, puis motif) → E1", async () => {
    const other = `${OC}/autre/cible.txt`;
    const facts = await collect(editRequest(other, ["workspace/autre/cible.txt"]), CONV, new Set(), { worktree: "/" });
    assert.deepEqual(facts.paths, [{ path: other, resolved: other, inside: false, symlinkOut: false }]);
    assert.deepEqual(decide(facts), attente("E1"));
  });

  it("chemin qui n'est pas absolu (worktree illisible) : jamais résolu depuis le dossier courant du processus → E1", async (t) => {
    // Dossier courant simulé dans le dossier de la conversation : une résolution relative y tomberait « à l'intérieur ».
    t.mock.method(process, "cwd", () => (process.platform === "win32" ? `C:${BACKSLASH}workspace${BACKSLASH}proj` : CONV));
    assert.equal(path.posix.resolve("src/app.ts"), `${CONV}/src/app.ts`, "simulation du dossier courant");
    const file = `${CONV}/src/app.ts`;
    const facts = await collect(editRequest(file, ["src/app.ts"]), CONV, new Set(), { worktree: "." });
    assert.deepEqual(facts.paths, [inner(file), { path: "./src/app.ts", resolved: null, inside: false, symlinkOut: false }]);
    assert.deepEqual(decide(facts), attente("E1"));
  });

  it("« \\ » dans un chemin : non résolu (séparateur pour un cockpit sous Windows, caractère ordinaire sous Linux) → E1", async () => {
    const file = `${OC}/autre${BACKSLASH}..${BACKSLASH}proj${BACKSLASH}src${BACKSLASH}app.ts`;
    const facts = await collect(editRequest(file, ["src/app.ts"]));
    assert.deepEqual(facts.paths[0], { path: file, resolved: null, inside: false, symlinkOut: false });
    assert.deepEqual(decide(facts), attente("E1"));
  });

  it("erreur de lecture autre que « absent » (EACCES simulée), ou lecture incohérente : jamais sautée, non résolu → E1", async (t) => {
    const realpath = fsp.realpath;
    // verrou/x.txt : realpath refusé (EACCES) ; existant.txt : realpath le dit absent alors que lstat le voit (changé entre deux lectures).
    const failures = new Map([
      [local("proj/verrou/x.txt"), "EACCES"],
      [local("proj/existant.txt"), "ENOENT"],
    ]);
    t.mock.method(fsp, "realpath", (async (file: string) => {
      const code = failures.get(path.resolve(file));
      if (code) throw Object.assign(new Error(`${code} (simulée)`), { code });
      return realpath(file);
    }) as typeof fsp.realpath);
    for (const [file, pattern] of [
      [`${CONV}/verrou/x.txt`, "verrou/x.txt"],
      [`${CONV}/existant.txt`, "existant.txt"],
    ] as const) {
      const facts = await collect(editRequest(file, [pattern], { filepath: file, diff: diffOf(file, ...CREATE) }));
      assert.deepEqual(facts.paths, [{ path: file, resolved: null, inside: false, symlinkOut: false }], file);
      assert.deepEqual(decide(facts), attente("E1"), file);
    }
  });

  it("fichier sous un fichier (« existant.txt/x.txt ») : parent qui n'est pas un dossier, non résolu → E1", async () => {
    const file = `${CONV}/existant.txt/x.txt`;
    const facts = await collect(editRequest(file, ["existant.txt/x.txt"], { filepath: file, diff: diffOf(file, ...CREATE) }));
    assert.deepEqual(facts.paths[0], { path: file, resolved: null, inside: false, symlinkOut: false });
    assert.deepEqual(decide(facts), attente("E1"));
  });
});

describe("collectEditFacts : liens symboliques", () => {
  it("fichier-lien vers un fichier hors du workspace : lien sortant, sans vue d'opencode → E1", async (t) => {
    if (!link(path.join(outside, "hors.txt"), local("proj/sortant.txt"), "file")) return t.skip(LINK_SKIP);
    const file = `${CONV}/sortant.txt`;
    const facts = await collect(editRequest(file, ["sortant.txt"]));
    assert.deepEqual(facts.paths, [{ path: file, resolved: null, inside: false, symlinkOut: true }]);
    assert.deepEqual(decide(facts), attente("E1"));
  });

  it("dossier-lien vers un autre projet : un fichier à créer dessous sort du dossier → E1", async (t) => {
    if (!link(local("autre"), local("proj/vers-autre"), "dir")) return t.skip(LINK_SKIP);
    const file = `${CONV}/vers-autre/nouveau.txt`;
    const facts = await collect(editRequest(file, ["vers-autre/nouveau.txt"], { filepath: file, diff: diffOf(file, ...CREATE) }));
    assert.deepEqual(facts.paths, [{ path: file, resolved: `${OC}/autre/nouveau.txt`, inside: false, symlinkOut: true }]);
    assert.deepEqual(decide(facts), attente("E1"));
  });

  it("lien pendant (cible absente) : l'écriture le suivrait, lien sortant → E1", async (t) => {
    if (!link(path.join(outside, "absent.txt"), local("proj/pendant.txt"), "file")) return t.skip(LINK_SKIP);
    const file = `${CONV}/pendant.txt`;
    const facts = await collect(editRequest(file, ["pendant.txt"], { filepath: file, diff: diffOf(file, ...CREATE) }));
    assert.deepEqual(facts.paths, [{ path: file, resolved: null, inside: false, symlinkOut: true }]);
    assert.deepEqual(decide(facts), attente("E1"));
  });

  it("dossier-lien pendant : un fichier à créer dessous suivrait le lien → E1", async (t) => {
    if (!link(path.join(outside, "dossier-absent"), local("proj/dossier-pendant"), "dir")) return t.skip(LINK_SKIP);
    const file = `${CONV}/dossier-pendant/sous/x.txt`;
    const facts = await collect(editRequest(file, ["dossier-pendant/sous/x.txt"], { filepath: file, diff: diffOf(file, ...CREATE) }));
    assert.deepEqual(facts.paths, [{ path: file, resolved: null, inside: false, symlinkOut: true }]);
    assert.deepEqual(decide(facts), attente("E1"));
  });

  it("boucle de liens : lien sortant → E1", async (t) => {
    if (!link(local("proj/boucle-b"), local("proj/boucle-a"), "file")) return t.skip(LINK_SKIP);
    if (!link(local("proj/boucle-a"), local("proj/boucle-b"), "file")) return t.skip(LINK_SKIP);
    const file = `${CONV}/boucle-a`;
    const facts = await collect(editRequest(file, ["boucle-a"]));
    assert.deepEqual(facts.paths, [{ path: file, resolved: null, inside: false, symlinkOut: true }]);
    assert.deepEqual(decide(facts), attente("E1"));
  });

  it("lien intérieur vers un fichier ou un dossier protégé : intérieur, mais E2 lit le chemin réel", async (t) => {
    if (!link(local("proj/.github/workflows/ci.yml"), local("proj/notes.txt"), "file")) return t.skip(LINK_SKIP);
    if (!link(local("proj/.git"), local("proj/docs-git"), "dir")) return t.skip(LINK_SKIP);
    const cases: Array<[string, string]> = [
      [`${CONV}/notes.txt`, `${CONV}/.github/workflows/ci.yml`],
      [`${CONV}/docs-git/config`, `${CONV}/.git/config`],
    ];
    for (const [file, real] of cases) {
      const facts = await collect(editRequest(file, [file.slice(CONV.length + 1)], { filepath: file, diff: diffOf(file, ...CREATE) }));
      assert.deepEqual(facts.paths, [{ path: file, resolved: real, inside: true, symlinkOut: false }], file);
      assert.deepEqual(decide(facts), attente("E2"), file);
      assert.deepEqual(facts.touchedFiles, [real], "clé : le chemin réel");
    }
  });

  it("dossier de la conversation qui est un lien hors du workspace : tout y est lien sortant → E1", async (t) => {
    if (!link(outside, local("lienproj"), "dir")) return t.skip(LINK_SKIP);
    const file = `${OC}/lienproj/hors.txt`;
    const facts = await collect(editRequest(file, ["hors.txt"]), `${OC}/lienproj`, new Set(), { worktree: `${OC}/lienproj` });
    assert.equal(facts.directoryAllowed, true, "E6 est lexical");
    assert.deepEqual(facts.paths, [{ path: file, resolved: null, inside: false, symlinkOut: true }]);
    assert.deepEqual(decide(facts), attente("E1"));
  });

  it("dossier de la conversation qui est un fichier ou qui n'existe pas : rien n'y est intérieur → E1", async () => {
    const file = `${CONV}/existant.txt`;
    const onFile = await collect(editRequest(file, ["existant.txt"]), file, new Set(), { worktree: CONV });
    assert.deepEqual(onFile.paths, [{ path: file, resolved: file, inside: false, symlinkOut: false }]);
    assert.deepEqual(decide(onFile), attente("E1"));
    const missing = `${OC}/absent`;
    const inMissing = await collect(editRequest(`${missing}/a.txt`, ["a.txt"]), missing, new Set(), { worktree: missing });
    assert.deepEqual(inMissing.paths, [{ path: `${missing}/a.txt`, resolved: `${missing}/a.txt`, inside: false, symlinkOut: false }]);
    assert.deepEqual(decide(inMissing), attente("E1"));
  });
});

describe("collectEditFacts : liens physiques et cibles qui ne sont pas des fichiers", () => {
  it("fichier intérieur qui a un second nom (lien physique) protégé ou dans un autre projet : non résolu → E1", async () => {
    // opencode réécrit un fichier existant sur place : l'écriture changerait aussi l'autre nom, que realpath ne montre pas.
    const file = `${CONV}/physique.txt`;
    put("proj/physique.txt", LINES);
    const request = editRequest(file, ["physique.txt"]);
    assert.deepEqual(decide(await collect(request)), AUTO, "témoin : un seul nom");
    for (const other of ["proj/.github/workflows/physique.yml", "autre/physique.txt"]) {
      fs.linkSync(local("proj/physique.txt"), local(other));
      assert.equal(fs.statSync(local("proj/physique.txt")).nlink, 2, "second nom créé");
      const facts = await collect(request);
      assert.deepEqual(facts.paths, [{ path: file, resolved: null, inside: false, symlinkOut: false }], other);
      assert.deepEqual(facts.touchedFiles, [file]);
      assert.deepEqual(decide(facts), attente("E1"), other);
      fs.unlinkSync(local(other));
    }
    assert.deepEqual(decide(await collect(request)), AUTO, "second nom retiré : automatique de nouveau");
  });

  it("cible qui existe sans être un fichier (dossier) : non résolu → E1", async () => {
    const directory = `${CONV}/src`;
    const facts = await collect(editRequest(directory, ["src"]));
    assert.deepEqual(facts.paths, [{ path: directory, resolved: null, inside: false, symlinkOut: false }]);
    assert.deepEqual(decide(facts), attente("E1"));
  });
});

describe("collectEditFacts : diff absent", () => {
  it("edit sans diff, ou avec un diff qui n'est pas une chaîne : diffs [null] → E4", async () => {
    const file = `${CONV}/existant.txt`;
    for (const metadata of [{ filepath: file }, { filepath: file, diff: 42 }, { filepath: file, diff: null }]) {
      const facts = await collect(editRequest(file, ["existant.txt"], metadata));
      assert.deepEqual(facts.paths, [inner(file)], JSON.stringify(metadata));
      assert.deepEqual(facts.diffs, [null]);
      assert.deepEqual(decide(facts), attente("E4"));
    }
  });
});

describe("collectEditFacts : apply_patch, suppression et déplacement", () => {
  it("suppression : chemin intérieur, suppression relevée → E3", async () => {
    const file = `${CONV}/a-supprimer.txt`;
    const facts = await collect(patchRequest([{ filePath: file, type: "delete" }], ["a-supprimer.txt"]));
    assert.deepEqual(facts.paths, [inner(file)]);
    assert.equal(facts.deletesOrMoves, true);
    assert.deepEqual(decide(facts), attente("E3"));
  });

  it("déplacement dans le dossier : la destination (movePath seulement) est résolue et examinée → E3", async () => {
    const source = `${CONV}/a-deplacer.txt`;
    const destination = `${CONV}/sous/deplace.txt`;
    const facts = await collect(patchRequest([{ filePath: source, type: "move", movePath: destination }], ["a-deplacer.txt"]));
    assert.deepEqual(facts.paths, [inner(source), inner(destination)]);
    assert.deepEqual(facts.touchedFiles, [source, destination]);
    assert.equal(facts.newFiles, 2);
    assert.deepEqual(decide(facts), attente("E3"));
  });

  it("déplacement vers un chemin protégé → E2 (la destination n'est ni dans patterns ni dans filepath)", async () => {
    const source = `${CONV}/a-deplacer.txt`;
    const destination = `${CONV}/.github/workflows/x.yml`;
    const facts = await collect(patchRequest([{ filePath: source, type: "move", movePath: destination }], ["a-deplacer.txt"]));
    assert.deepEqual(facts.paths, [inner(source), inner(destination)]);
    assert.deepEqual(decide(facts), attente("E2"));
  });

  it("déplacement hors du dossier → E1", async () => {
    const source = `${CONV}/a-deplacer.txt`;
    const destination = `${OC}/autre/deplace.txt`;
    const facts = await collect(patchRequest([{ filePath: source, type: "move", movePath: destination }], ["a-deplacer.txt"]));
    assert.deepEqual(facts.paths, [inner(source), { path: destination, resolved: destination, inside: false, symlinkOut: false }]);
    assert.deepEqual(decide(facts), attente("E1"));
  });

  it("« add » sur un fichier qui existe déjà : opencode l'écraserait sans lire le disque → E3 ; sur un fichier absent → auto (relecture 2-vague-1)", async () => {
    const existing = `${CONV}/existant.txt`;
    const fresh = `${CONV}/ajout-neuf.txt`;
    const overwrite = await collect(patchRequest([{ filePath: existing, type: "add" }], ["existant.txt"]));
    // Le chemin est intérieur et le patch « @@ -0,0 » ne retire rien : seul le disque montre ce qui disparaîtrait.
    assert.deepEqual(overwrite.paths, [inner(existing)]);
    assert.deepEqual(overwrite.diffs, [diffOf(existing, ...CREATE)]);
    assert.equal(overwrite.deletesOrMoves, true);
    assert.deepEqual(decide(overwrite), attente("E3"));
    const created = await collect(patchRequest([{ filePath: fresh, type: "add" }], ["ajout-neuf.txt"]));
    assert.equal(created.deletesOrMoves, false);
    assert.deepEqual(decide(created), AUTO);
    assert.equal(fs.existsSync(local("proj/ajout-neuf.txt")), false, "rien n'est créé");
    // Un seul « add » qui remplace suffit, parmi des ajouts et des mises à jour.
    const mixed = await collect(
      patchRequest(
        [
          { filePath: fresh, type: "add" },
          { filePath: `${CONV}/src/app.ts`, type: "update" },
          { filePath: existing, type: "add" },
        ],
        ["ajout-neuf.txt", "src/app.ts", "existant.txt"],
      ),
    );
    assert.deepEqual(decide(mixed), attente("E3"));
    // Un dossier existant visé par un « add » : E1 d'abord (cible qui n'est pas un fichier), et jamais un ajout.
    const onDirectory = await collect(patchRequest([{ filePath: `${CONV}/src`, type: "add" }], ["src"]));
    assert.equal(onDirectory.deletesOrMoves, true);
    assert.deepEqual(decide(onDirectory), attente("E1"));
  });

  it("« add » dont l'existence ne peut pas être lue (lien pendant, parent qui est un fichier, erreur de lecture, aucun accès au disque) : jamais automatique", async (t) => {
    const underFile = await collect(patchRequest([{ filePath: `${CONV}/existant.txt/x.txt`, type: "add" }], ["existant.txt/x.txt"]));
    assert.equal(underFile.deletesOrMoves, true, "parent qui est un fichier (ENOTDIR sous Linux, ENOENT sous Windows)");
    assert.notDeepEqual(decide(underFile), AUTO);

    const lstat = fsp.lstat;
    const locked = local("proj/verrou-ajout.txt");
    t.mock.method(fsp, "lstat", (async (file: string, ...rest: unknown[]) => {
      if (path.resolve(file) === locked) throw Object.assign(new Error("EACCES (simulée)"), { code: "EACCES" });
      return (lstat as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
    }) as typeof fsp.lstat);
    const unreadable = await collect(patchRequest([{ filePath: `${CONV}/verrou-ajout.txt`, type: "add" }], ["verrou-ajout.txt"]));
    assert.equal(unreadable.deletesOrMoves, true, "EACCES");
    assert.notDeepEqual(decide(unreadable), AUTO);
    t.mock.restoreAll();

    const count = spyDisk(t);
    const refused = await collect(patchRequest([{ filePath: `${CONV}/ajout-neuf.txt`, type: "add" }], ["ajout-neuf.txt"]), "/etc");
    assert.equal(refused.deletesOrMoves, true, "E6 : existence jamais lue");
    assert.deepEqual(decide(refused), attente("E6"));
    assert.equal(count(), 0, "aucun accès au disque");

    if (!link(path.join(outside, "absent-ajout.txt"), local("proj/pendant-ajout.txt"), "file")) return t.skip(LINK_SKIP);
    const dangling = await collect(patchRequest([{ filePath: `${CONV}/pendant-ajout.txt`, type: "add" }], ["pendant-ajout.txt"]));
    assert.equal(dangling.deletesOrMoves, true, "lien pendant : un élément présent");
    assert.notDeepEqual(decide(dangling), AUTO);
  });

  it("metadata.filepath d'apply_patch jamais résolu, même quand il sort du dossier", async () => {
    const file = `${CONV}/existant.txt`;
    const facts = await collect(patchRequest([{ filePath: file, type: "update" }], ["existant.txt"], "../../etc/passwd"));
    assert.deepEqual(facts.paths, [inner(file)]);
    assert.deepEqual(decide(facts), AUTO);
  });

  it("apply_patch sans fichier, ou edit sans filepath : un chemin non résolu fait décider E1, jamais le diff ni les motifs", async (t) => {
    const count = spyDisk(t);
    const file = `${CONV}/existant.txt`;
    const empty = { ...patchRequest([], ["existant.txt"]), metadata: { filepath: "existant.txt", diff: "", files: [] } };
    const withoutPath = editRequest(file, ["existant.txt"], { diff: diffOf(file, ...UPDATE) });
    const relative = editRequest(file, ["existant.txt"], { filepath: "existant.txt", diff: diffOf(file, ...UPDATE) });
    for (const request of [empty, withoutPath, relative]) {
      const facts = await collect(request);
      assert.deepEqual(facts.paths, [{ path: "", resolved: null, inside: false, symlinkOut: false }]);
      assert.deepEqual(facts.touchedFiles, []);
      assert.deepEqual(decide(facts), attente("E1"));
    }
    assert.equal(count(), 0, "aucun accès au disque");
  });
});

describe("collectEditFacts : worktree et dossier hors git", () => {
  const PASSWORD = randomBytes(18).toString("base64url");

  async function startFake(t: TestContext) {
    const fake = new FakeOpencode({ password: PASSWORD });
    await fake.start();
    t.after(() => fake.close());
    return { fake, oc: new OpencodeClient({ opencodeUrl: fake.url, opencodeUsername: "opencode", opencodePassword: PASSWORD }) };
  }

  /** Demande publiée par le faux pour un outil scripté dans `directory`, puis refusée (aucun effet). */
  async function askedBy(fake: FakeOpencode, oc: OpencodeClient, directory: string, tool: FakeToolScript): Promise<FakePermissionRequest> {
    const session = await oc.request<FakeSession>("POST", "/session", { body: { title: "L10b" }, directory });
    fake.script(session.id, { tools: [tool], followUp: { text: "fin" } });
    const since = fake.emitted.length;
    assert.equal(await promptAsync(oc, session.id, "[L10b]"), 204);
    const asked = (await fake.waitForEvent("permission.asked", (p) => p.sessionID === session.id, { since })).properties as unknown as FakePermissionRequest;
    assert.equal(await oc.request("POST", `/permission/${asked.id}/reply`, { body: { reply: "reject" }, directory }), true);
    await within(fake.settled(session.id), "refus");
    return asked;
  }

  it("faux opencode, fake.worktrees.set(dossier, « / ») : worktree lu par GET /path, motifs du faux → auto ; repli local identique", async (t) => {
    const { fake, oc } = await startFake(t);
    const libre = `${OC}/libre`;
    fake.worktrees.set(libre, "/");
    fake.files.set(`${libre}/a.txt`, LINES);
    const worktree = (await oc.request<{ worktree: string }>("GET", "/path", { directory: libre })).worktree;
    assert.equal(worktree, "/");
    assert.equal(await projects.opencodeWorktree(libre), worktree, "repli local = GET /path (hors git)");
    assert.equal(await projects.opencodeWorktree(CONV), (await oc.request<{ worktree: string }>("GET", "/path", { directory: CONV })).worktree, "dépôt git");

    const asked = await askedBy(fake, oc, libre, editTool("a.txt", "ligne 2", "ligne deux", { directory: libre, worktree: "/" }));
    assert.deepEqual(asked.patterns, ["workspace/libre/a.txt"]);
    const facts = await collect(asked, libre, new Set(), { worktree });
    assert.deepEqual(facts.paths, [inner(`${libre}/a.txt`)]);
    assert.deepEqual(decide(facts), AUTO);
    assert.deepEqual(await collect(asked, libre), facts, "repli local sur projects.opencodeWorktree");
    assert.deepEqual(fake.failures, []);
  });

  it("faux opencode hors git : déplacement vers un chemin protégé → E2, hors du dossier → E1", async (t) => {
    const { fake, oc } = await startFake(t);
    const libre = `${OC}/libre`;
    fake.worktrees.set(libre, "/");
    fake.files.set(`${libre}/a.txt`, LINES);
    const options = { directory: libre, worktree: "/" };
    const cases: Array<[string, string, EditVerdict]> = [
      [".github/workflows/x.yml", `${libre}/.github/workflows/x.yml`, attente("E2")],
      ["../autre/b.txt", `${OC}/autre/b.txt`, attente("E1")],
    ];
    for (const [movePath, destination, expected] of cases) {
      const asked = await askedBy(fake, oc, libre, applyPatchTool([{ type: "update", path: "a.txt", from: "ligne 2\n", to: "ligne deux\n", movePath }], options));
      assert.deepEqual(asked.patterns, ["workspace/libre/a.txt"], "source seulement");
      const facts = await collect(asked, libre, new Set(), { worktree: "/" });
      assert.deepEqual(
        facts.paths.map((entry) => entry.path),
        [`${libre}/a.txt`, destination],
      );
      assert.deepEqual(decide(facts), expected, movePath);
    }
    assert.deepEqual(fake.failures, []);
  });

  it("motif qui désigne un autre fichier que les métadonnées : examiné pour lui-même → E1", async () => {
    const file = `${CONV}/src/app.ts`;
    const facts = await collect(editRequest(file, ["workspace/autre/cible.txt"]), CONV, new Set(), { worktree: "/" });
    assert.deepEqual(facts.paths, [inner(file), { path: `${OC}/autre/cible.txt`, resolved: `${OC}/autre/cible.txt`, inside: false, symlinkOut: false }]);
    assert.deepEqual(decide(facts), attente("E1"));
  });

  it("motif absolu, `~` ou `$` en tête : jamais rattaché au worktree, non résolu → E1", async () => {
    const file = `${CONV}/src/app.ts`;
    for (const pattern of ["/etc/passwd", `${BACKSLASH}etc${BACKSLASH}passwd`, "~/.bashrc", "$HOME/.bashrc"]) {
      const facts = await collect(editRequest(file, [pattern]), CONV, new Set(), { worktree: CONV });
      assert.deepEqual(facts.paths, [inner(file), { path: pattern, resolved: null, inside: false, symlinkOut: false }], pattern);
      assert.deepEqual(decide(facts), attente("E1"), pattern);
    }
  });

  it("worktree inconnu (repli en échec) ou illisible : motifs non résolus → E1", async () => {
    const failing: EditFactsProjects = {
      opencodeRoot: projects.opencodeRoot,
      isAllowedDirectory: (directory) => projects.isAllowedDirectory(directory),
      toLocalPath: (file) => projects.toLocalPath(file),
      opencodeWorktree: () => Promise.reject(new Error("worktree illisible")),
    };
    const file = `${CONV}/src/app.ts`;
    const request = editRequest(file, ["src/app.ts"]);
    const unknown = await collect(request, CONV, new Set(), {}, failing);
    const garbled = await collect(request, CONV, new Set(), { worktree: 42 as unknown as string });
    for (const facts of [unknown, garbled]) {
      assert.deepEqual(facts.paths, [inner(file), { path: "src/app.ts", resolved: null, inside: false, symlinkOut: false }]);
      assert.deepEqual(decide(facts), attente("E1"));
    }
  });
});

describe("collectEditFacts : E6, dossier de la conversation", () => {
  it("hors du workspace, relatif, avec « .. » ou « \\ » : E6, et aucun accès au disque", async (t) => {
    const count = spyDisk(t);
    // Dossier courant simulé à la racine du workspace : un dossier relatif y serait « permis » par une lecture lexicale.
    t.mock.method(process, "cwd", () => (process.platform === "win32" ? `C:${BACKSLASH}workspace` : OC));
    assert.equal(projects.isAllowedDirectory("proj"), true, "simulation du dossier courant");
    const file = `${CONV}/src/app.ts`;
    const slashed = `${CONV}${BACKSLASH}..${BACKSLASH}autre`;
    for (const directory of ["/etc", "proj", `${OC}/../etc`, `${CONV}/../proj`, slashed, "", 42 as unknown as string]) {
      const facts = await collect(editRequest(file, ["src/app.ts"]), directory);
      assert.equal(facts.directoryAllowed, false, String(directory));
      assert.deepEqual(facts.paths, []);
      assert.deepEqual(decide(facts), attente("E6"), String(directory));
    }
    assert.equal(count(), 0, "aucun accès au disque");
    assert.deepEqual(decide(await collect(editRequest(file, ["src/app.ts"]))), AUTO);
    assert.ok(count() > 0, "témoin : les espions voient les lectures");
  });
});

describe("collectEditFacts : E5, fichiers déjà comptés", () => {
  it("ensemble : un fichier déjà compté ne l'est pas deux fois ; nombre : chaque fichier de la demande compte", async () => {
    const a = `${CONV}/existant.txt`;
    const b = `${CONV}/src/app.ts`;
    const request = patchRequest(
      [
        { filePath: a, type: "update" },
        { filePath: b, type: "update" },
      ],
      ["existant.txt", "src/app.ts"],
    );
    const fresh = await collect(request);
    assert.deepEqual([fresh.filesSoFar, fresh.newFiles, fresh.touchedFiles], [0, 2, [a, b]]);
    const counted = await collect(request, CONV, new Set([a, `${CONV}/autre.txt`]));
    assert.deepEqual([counted.filesSoFar, counted.newFiles], [2, 1]);
    const byNumber = await collect(request, CONV, 7);
    assert.deepEqual([byNumber.filesSoFar, byNumber.newFiles], [7, 2]);
    assert.deepEqual(decide(await collect(request, CONV, MAX - 1)), { verdict: "retour", regle: "E5" });
    assert.deepEqual(decide(await collect(request, CONV, MAX - 2)), AUTO);
  });

  it("deux écritures du même fichier réel sous deux formes : une seule clé (chemin réel)", async () => {
    const file = `${CONV}/existant.txt`;
    const request = patchRequest(
      [
        { filePath: file, type: "update" },
        { filePath: `${CONV}/./existant.txt`, type: "update" },
      ],
      ["existant.txt"],
    );
    const facts = await collect(request);
    assert.deepEqual(facts.touchedFiles, [file]);
    assert.equal(facts.newFiles, 1);
  });
});

describe("collectEditFacts : formes illisibles et bornes", () => {
  it("demande qui n'est pas un objet, permission autre que edit, motifs qui ne sont pas un tableau → E1", async (t) => {
    const count = spyDisk(t);
    const file = `${CONV}/existant.txt`;
    for (const request of [null, "edit", [editRequest(file, ["existant.txt"])], { ...editRequest(file, ["existant.txt"]), permission: "bash" }]) {
      const facts = await collect(request);
      assert.deepEqual(facts.paths, [{ path: "", resolved: null, inside: false, symlinkOut: false }], JSON.stringify(request));
      assert.deepEqual(decide(facts), attente("E1"));
    }
    assert.equal(count(), 0, "aucun accès au disque");
    for (const patterns of ["existant.txt", undefined]) {
      const facts = await collect(editRequest(file, patterns));
      assert.deepEqual([facts.patterns, facts.paths], [[], [inner(file)]], String(patterns));
      assert.deepEqual(decide(facts), attente("E1"));
    }
    // Motif qui n'est pas une chaîne : "" gardé pour E1, jamais rattaché au worktree (il désignerait le dossier lui-même).
    const facts = await collect(editRequest(file, [42]));
    assert.deepEqual([facts.patterns, facts.paths], [[""], [inner(file), { path: "", resolved: null, inside: false, symlinkOut: false }]]);
    assert.deepEqual(decide(facts), attente("E1"));
  });

  it(`plus de ${EDIT_PATHS_MAX} chemins : aucune résolution, E1, aucun accès au disque`, async (t) => {
    const count = spyDisk(t);
    const files = Array.from({ length: EDIT_PATHS_MAX }, () => ({ filePath: `${CONV}/existant.txt`, type: "update" as const }));
    const facts = await collect(patchRequest(files, ["existant.txt"]));
    assert.deepEqual(facts.paths, [{ path: "", resolved: null, inside: false, symlinkOut: false }]);
    assert.deepEqual(decide(facts), attente("E1"));
    assert.equal(count(), 0, "aucun accès au disque");
    const atLimit = await collect(patchRequest(files.slice(1), ["existant.txt"]));
    assert.deepEqual(atLimit.paths, [inner(`${CONV}/existant.txt`)], "à la borne : résolu");
    assert.ok(count() > 0, "témoin : les espions voient les lectures");
  });
});

/** Décision attendue de chaque demande mesurée, identique dans un dépôt git et hors git (MX1 §3). */
const MX1_EXPECTED: Record<string, { paths: number; verdict: EditVerdict }> = {
  "META-EDIT": { paths: 1, verdict: AUTO },
  "META-WRITE": { paths: 1, verdict: AUTO },
  "META-PADD": { paths: 1, verdict: AUTO },
  "META-PUPD": { paths: 1, verdict: AUTO },
  "META-PDEL": { paths: 1, verdict: attente("E3") },
  "META-PMOVE": { paths: 2, verdict: attente("E3") },
  "META-PMULTI": { paths: 5, verdict: attente("E3") },
};

describe("collectEditFacts : les 14 demandes mesurées (MX1), rejouées sur un disque réel", () => {
  it("dépôt git et hors git : chemins et motifs intérieurs, décisions attendues, avec le worktree mesuré puis avec le repli local", async () => {
    let count = 0;
    for (const directory of mx1.metadata) {
      for (const c of directory.cases) {
        const label = `${directory.name} ${c.marker}`;
        const expected = MX1_EXPECTED[c.marker];
        assert.ok(expected, label);
        const facts = await collect(c.asked, directory.directory, new Set(), { worktree: directory.worktree });
        assert.equal(facts.touchedFiles.length, expected.paths, label);
        // Motifs de la source seulement, résolus depuis le worktree : mêmes chemins que les métadonnées, aucun en plus.
        assert.equal(facts.paths.length, expected.paths, label);
        for (const entry of facts.paths) assert.deepEqual(entry, inner(entry.path), `${label} : ${entry.path}`);
        assert.ok(
          facts.paths.every((entry) => entry.path.startsWith(`${directory.directory}/`)),
          label,
        );
        assert.deepEqual(decide(facts), expected.verdict, label);
        assert.deepEqual(await collect(c.asked, directory.directory), facts, `${label} : repli local`);
        count++;
      }
    }
    assert.equal(count, 14);
  });
});

describe("collectEditFacts : aucune écriture", () => {
  it("arborescence identique avant et après des relevés, fichiers et dossiers à créer compris", async () => {
    const snapshot = () =>
      (fs.readdirSync(root, { recursive: true }) as string[])
        .sort()
        .map((entry) => {
          const info = fs.lstatSync(path.join(root, entry));
          return `${entry}:${info.size}:${info.mtimeMs}`;
        });
    const initial = snapshot();
    await collect(editRequest(`${CONV}/neuf/dossier/fichier.txt`, ["neuf/dossier/fichier.txt"]));
    await collect(patchRequest([{ filePath: `${CONV}/a-deplacer.txt`, type: "move", movePath: `${CONV}/ailleurs/x.txt` }], ["a-deplacer.txt"]));
    for (const directory of mx1.metadata) for (const c of directory.cases) await collect(c.asked, directory.directory);
    assert.deepEqual(snapshot(), initial);
  });
});
