// Porte shell, faits du disque (spécification §4.5 S5 et S6, §6 l.1040 ; M10, M11 ; plan d'exécution, fiche L8b) :
// collectShellContext sur de vrais dossiers : chemin réel toujours rempli ; lien sortant (T-L8-d), lien qui sort puis revient,
// lien vers un chemin absent du conteneur du cockpit, cible absolue lue comme opencode la lit ; liens internes vers .git et .env
// (T-L8-f) ; boucle, 40 liens, 4 096 étapes ; alias de nom (8.3), lecture de dossier bornée ; sous-arbres des recherches
// récursives ; six dépôts piégés (T-L8-b), les autres pièges de la sonde git et leurs voisins ; borne de lecture de .git/config ;
// dossier de la conversation douteux ; questions imprévues ; U01 ; aucune exécution de git.
// Relecture 2-vague-1 : hooks et sous-modules (G04 sans clé de configuration), index git (chemins suivis sensibles, liens de
// sous-module ; versions 2 à 4, SHA-1 et SHA-256, formes refusées), historique (git show, révisions), existence des arguments.
// L'index est écrit octet par octet ; quand git est installé, un index produit par le vrai git est relu aussi (seul usage de git
// ici : git init, git add, git update-index, jamais une consultation).
// Liens : sous Windows sans le droit d'en créer (EPERM), un lien de dossier devient une jonction et un lien de fichier saute le cas
// avec sa raison. Sous Linux, aucun cas n'est sauté.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { ProjectsService } from "./projects.ts";
import {
  collectShellContext,
  parseGitIndex,
  SHELL_DIR_SCAN_MAX_ENTRIES,
  SHELL_GIT_CONFIG_MAX_BYTES,
  SHELL_GIT_HOOKS_MAX_ENTRIES,
  SHELL_GIT_INDEX_MAX_BYTES,
  SHELL_RESOLVE_MAX_STEPS,
  SHELL_SYMLINK_MAX_HOPS,
  SHELL_WALK_MAX_ENTRIES,
  type ShellFactsLimits,
} from "./shell-facts.ts";
import { classifyCommand, type ShellVerdict } from "./shared/shell-gate.ts";

const OC_ROOT = "/workspace";
const DIR = "/workspace/proj";
const NL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const DQ = String.fromCharCode(34);
const BS = String.fromCharCode(92);
const SQ = "'";
const WINDOWS = process.platform === "win32";

const CLEAN_GIT_CONFIG = [
  "[core]",
  `${TAB}repositoryformatversion = 0`,
  `${TAB}filemode = true`,
  `${TAB}bare = false`,
  `${TAB}logallrefupdates = true`,
  `[remote ${DQ}origin${DQ}]`,
  `${TAB}url = https://example.invalid/depot.git`,
  `${TAB}fetch = +refs/heads/*:refs/remotes/origin/*`,
  `[branch ${DQ}main${DQ}]`,
  `${TAB}remote = origin`,
  `${TAB}merge = refs/heads/main`,
  "",
].join(NL);

const GIT_AUTOS: ReadonlyArray<readonly [string, string]> = [
  ["git status --short", "A-git-status"],
  ["git log --oneline -n 20", "A-git-log"],
  ["git diff --stat", "A-git-diff"],
  ["git show HEAD:package.json", "A-git-show"],
];

interface Bench {
  /** Workspace local (monté en /workspace côté opencode). */
  root: string;
  /** Dossier local de la conversation (/workspace/proj). */
  proj: string;
  /** Dossier hors du workspace. */
  outside: string;
  projects: ProjectsService;
}

function write(dir: string, relative: string, content: string | Buffer): string {
  const file = path.join(dir, ...relative.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** Workspace réel : projet avec README.md, package.json, src/app.ts, src/a.ts et un dépôt git propre ; un dossier hors du workspace. */
function bench(t: TestContext): Bench {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-shell-facts-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "ws");
  const proj = path.join(root, "proj");
  const outside = path.join(base, "dehors");
  fs.mkdirSync(path.join(proj, ".git", "objects"), { recursive: true });
  fs.mkdirSync(path.join(proj, ".git", "refs"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  write(proj, "README.md", `# Projet${NL}`);
  write(proj, "package.json", `{}${NL}`);
  write(proj, "src/app.ts", `// TODO${NL}`);
  write(proj, "src/a.ts", `export {};${NL}`);
  write(proj, ".git/HEAD", `ref: refs/heads/main${NL}`);
  write(proj, ".git/config", CLEAN_GIT_CONFIG);
  write(outside, "notes.txt", `hors du workspace${NL}`);
  return { root, proj, outside, projects: new ProjectsService({ workspaceDir: root, opencodeWorkspaceDir: OC_ROOT }) };
}

/**
 * Lien réel. Sous Windows sans le droit de créer des liens (EPERM) : jonction pour un dossier ; cas sauté pour un fichier (obligatoire
 * sous Linux). false : cas sauté.
 */
function link(t: TestContext, target: string, at: string, kind: "file" | "dir"): boolean {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  try {
    fs.symlinkSync(target, at, kind);
    return true;
  } catch (err) {
    if (!WINDOWS || (err as NodeJS.ErrnoException).code !== "EPERM") throw err;
    if (kind === "dir") {
      fs.symlinkSync(path.resolve(path.dirname(at), target), at, "junction");
      return true;
    }
    t.skip("EPERM : Windows refuse les liens symboliques de fichier sans le mode développeur ; cas obligatoire sous Linux");
    return false;
  }
}

interface DecideOptions {
  dir?: string;
  allowJudge?: boolean;
  limits?: ShellFactsLimits;
}

async function decide(b: Bench, command: string, options: DecideOptions = {}): Promise<ShellVerdict> {
  const facts = await collectShellContext(command, options.dir ?? DIR, b.projects, options.limits);
  return classifyCommand(command, { ...facts, workdir: null, allowJudge: options.allowJudge ?? false });
}

async function expectRule(b: Bench, command: string, expected: string, options: DecideOptions = {}): Promise<ShellVerdict> {
  const result = await decide(b, command, options);
  assert.equal(`${result.verdict} ${result.regle}`, expected, `${command} → ${JSON.stringify(result)}`);
  return result;
}

async function factsOf(b: Bench, command: string, arg: string) {
  return (await collectShellContext(command, DIR, b.projects)).paths.resolve(arg);
}

// --- Chemins cités (S5) --------------------------------------------------------------------------------------------------------

describe("faits du disque : chemins cités (S5)", () => {
  it("chemin réel toujours rempli : fichier, dossier, absent, absolu dans le projet, « .. » intérieur, suite d'un fichier", async (t) => {
    const b = bench(t);
    const command = "cat README.md src src/nouveau.ts src/../package.json /workspace/proj/src/a.ts src/absent/x/y README.md/x";
    const facts = await collectShellContext(command, DIR, b.projects);
    const expected: Record<string, string> = {
      "README.md": "/workspace/proj/README.md",
      src: "/workspace/proj/src",
      "src/nouveau.ts": "/workspace/proj/src/nouveau.ts",
      "src/../package.json": "/workspace/proj/package.json",
      "/workspace/proj/src/a.ts": "/workspace/proj/src/a.ts",
      "src/absent/x/y": "/workspace/proj/src/absent/x/y",
      "README.md/x": "/workspace/proj/README.md/x",
    };
    for (const [arg, real] of Object.entries(expected)) assert.deepEqual(facts.paths.resolve(arg), { inside: true, symlinkOut: false, real }, arg);
    assert.deepEqual(classifyCommand(command, { ...facts, workdir: null, allowJudge: false }), { verdict: "auto", regle: "A-cat", detail: "" });
  });

  it("T-L8-d : lien sortant réel (dossier) → P02, symlinkOut ; un parcours de sous-arbre ne le suit pas", async (t) => {
    const b = bench(t);
    write(b.outside, "secret.txt", `hors${NL}`);
    link(t, b.outside, path.join(b.proj, "src", "dehors"), "dir");
    await expectRule(b, "cat src/dehors/secret.txt", "attente P02");
    await expectRule(b, "ls src/dehors", "attente P02");
    await expectRule(b, "grep -rn TODO src/dehors", "attente P02");
    await expectRule(b, "mytool --config=src/dehors/x", "attente P02", { allowJudge: true });
    const facts = await factsOf(b, "cat src/dehors/secret.txt", "src/dehors/secret.txt");
    assert.equal(facts?.inside, false);
    assert.equal(facts?.symlinkOut, true);
    assert.ok(facts?.real.startsWith("/"), facts?.real);
    // Parcours qui part par le lien : aucun fait (la porte l'arrête déjà en P02, le serveur ne le parcourt pas non plus).
    assert.equal((await collectShellContext("grep -rn TODO src/dehors", DIR, b.projects)).paths.sensitiveEntries("src/dehors"), null);
    // grep -r ne suit pas un lien trouvé dans le sous-arbre : src/dehors/secret.txt n'est pas lu.
    await expectRule(b, "grep -rn TODO src", "auto A-grep");
  });

  it("composant hors du workspace, invérifiable chez opencode (src/detour → ../../../tmp/../workspace/proj/src/app.ts) : sortant, P02", async (t) => {
    const b = bench(t);
    // Dans le conteneur d'opencode, /tmp peut être un lien : « /tmp/.. » n'est pas « / » à coup sûr. Le cockpit ne lit que /workspace.
    if (!link(t, "../../../tmp/../workspace/proj/src/app.ts", path.join(b.proj, "src", "detour"), "file")) return;
    const facts = await factsOf(b, "cat src/detour", "src/detour");
    assert.equal(facts?.inside, false);
    assert.equal(facts?.symlinkOut, true);
    await expectRule(b, "cat src/detour", "attente P02");
  });

  it("lien relatif qui sort du workspace (src/rel → ../../../dehors) : sortant, P02", async (t) => {
    const b = bench(t);
    link(t, "../../../dehors", path.join(b.proj, "src", "rel"), "dir");
    const facts = await factsOf(b, "cat src/rel/notes.txt", "src/rel/notes.txt");
    assert.equal(facts?.inside, false);
    assert.equal(facts?.symlinkOut, true);
    await expectRule(b, "cat src/rel/notes.txt", "attente P02");
  });

  it("composant que le cockpit n'a pas le droit de lire : faits inconnus (P02), jamais « absent » ; parcours impossible (P03)", async (t) => {
    if (WINDOWS) {
      t.skip("Windows : chmod ne retire pas le droit de parcourir un dossier ; cas obligatoire sous Linux");
      return;
    }
    if (process.getuid?.() === 0) {
      t.skip("root passe outre les droits : aucun refus à provoquer ; cas obligatoire pour un utilisateur ordinaire (CI)");
      return;
    }
    const b = bench(t);
    write(b.proj, "src/verrou/interne.txt", "x");
    const locked = path.join(b.proj, "src", "verrou");
    fs.chmodSync(locked, 0o000);
    try {
      assert.equal(await factsOf(b, "cat src/verrou/interne.txt", "src/verrou/interne.txt"), null);
      await expectRule(b, "cat src/verrou/interne.txt", "attente P02");
      assert.equal((await expectRule(b, "grep -rn TODO src", "attente P03")).detail, "parcours-impossible:src");
    } finally {
      // Avant le nettoyage du banc : un dossier sans droits ne se supprime pas.
      fs.chmodSync(locked, 0o755);
    }
  });

  it("lien qui sort puis revient (src/haut → ../..) : symlinkOut, P02, même si le chemin réel final est dedans", async (t) => {
    const b = bench(t);
    link(t, "../..", path.join(b.proj, "src", "haut"), "dir");
    assert.deepEqual(await factsOf(b, "cat src/haut/proj/README.md", "src/haut/proj/README.md"), {
      inside: true,
      symlinkOut: true,
      real: "/workspace/proj/README.md",
    });
    await expectRule(b, "cat src/haut/proj/README.md", "attente P02");
  });

  it("lien vers un chemin absent du conteneur du cockpit (/home/node/…/auth.json) : sortant, P02", async (t) => {
    const b = bench(t);
    if (!link(t, "/home/node/.local/share/opencode/auth.json", path.join(b.proj, "docs", "notes.md"), "file")) return;
    const facts = await factsOf(b, "cat docs/notes.md", "docs/notes.md");
    assert.equal(facts?.inside, false);
    assert.equal(facts?.symlinkOut, true);
    await expectRule(b, "cat docs/notes.md", "attente P02");
    await expectRule(b, "head -n 5 docs/notes.md", "attente P02");
  });

  it("cible absolue lue dans l'espace de noms d'opencode (/workspace/proj/.env) : attente ; P03 sous Linux", async (t) => {
    const b = bench(t);
    write(b.proj, ".env", `CLE=valeur${NL}`);
    if (!link(t, "/workspace/proj/.env", path.join(b.proj, "src", "cfg.txt"), "file")) return;
    const result = await decide(b, "cat src/cfg.txt");
    assert.equal(result.verdict, "attente");
    if (!WINDOWS) {
      // Sous Windows, une cible « /workspace/… » est enregistrée en chemin Windows (C:\workspace\…) : hors du workspace, P02.
      assert.equal(result.regle, "P03", JSON.stringify(result));
      assert.deepEqual(await factsOf(b, "cat src/cfg.txt", "src/cfg.txt"), { inside: true, symlinkOut: false, real: "/workspace/proj/.env" });
    }
  });

  it("T-L8-f : lien interne vers .git (docs/notes → ../.git, puis cat docs/notes/config) → P03 par le chemin réel", async (t) => {
    const b = bench(t);
    link(t, "../.git", path.join(b.proj, "docs", "notes"), "dir");
    assert.deepEqual(await factsOf(b, "cat docs/notes/config", "docs/notes/config"), { inside: true, symlinkOut: false, real: "/workspace/proj/.git/config" });
    const result = await expectRule(b, "cat docs/notes/config", "attente P03");
    assert.equal(result.detail, "dossier:docs/notes/config");
    await expectRule(b, "ls docs/notes", "attente P03");
    await expectRule(b, "grep -rn url docs/notes", "attente P03");
    // Parcours qui part dans .git par le lien : le dossier sensible est rapporté seul, sans y descendre.
    assert.deepEqual((await collectShellContext("grep -rn url docs/notes", DIR, b.projects)).paths.sensitiveEntries("docs/notes"), [".git"]);
  });

  it("T-L8-f : lien interne vers .env (src/cfg → ../.env) → P03 ; un lien interne inoffensif reste automatique", async (t) => {
    const b = bench(t);
    write(b.proj, ".env", `CLE=valeur${NL}`);
    if (!link(t, "../.env", path.join(b.proj, "src", "cfg"), "file")) return;
    assert.deepEqual(await factsOf(b, "cat src/cfg", "src/cfg"), { inside: true, symlinkOut: false, real: "/workspace/proj/.env" });
    assert.equal((await expectRule(b, "cat src/cfg", "attente P03")).detail, "environnement:src/cfg");
    if (!link(t, "app.ts", path.join(b.proj, "src", "alias.ts"), "file")) return;
    assert.deepEqual(await factsOf(b, "cat src/alias.ts", "src/alias.ts"), { inside: true, symlinkOut: false, real: "/workspace/proj/src/app.ts" });
    await expectRule(b, "cat src/alias.ts", "auto A-cat");
  });

  it(`boucle de liens et plus de ${SHELL_SYMLINK_MAX_HOPS} liens : faits inconnus, P02 ; ${SHELL_SYMLINK_MAX_HOPS} liens suivis passent`, async (t) => {
    const b = bench(t);
    if (!link(t, "boucle", path.join(b.proj, "src", "boucle"), "file")) return;
    assert.equal(await factsOf(b, "cat src/boucle", "src/boucle"), null);
    await expectRule(b, "cat src/boucle", "attente P02");
    // h0 → h1 → … → h40 → app.ts : h1 suit 40 liens, h0 en suit 41.
    for (let k = 0; k <= SHELL_SYMLINK_MAX_HOPS; k++) {
      const target = k === SHELL_SYMLINK_MAX_HOPS ? "app.ts" : `h${k + 1}`;
      if (!link(t, target, path.join(b.proj, "src", `h${k}`), "file")) return;
    }
    assert.equal((await factsOf(b, "cat src/h1", "src/h1"))?.real, "/workspace/proj/src/app.ts");
    await expectRule(b, "cat src/h1", "auto A-cat");
    assert.equal(await factsOf(b, "cat src/h0", "src/h0"), null);
    await expectRule(b, "cat src/h0", "attente P02");
  });

  it(`plus de ${SHELL_RESOLVE_MAX_STEPS} lectures du disque pour un chemin : faits inconnus, P02`, async (t) => {
    const b = bench(t);
    fs.mkdirSync(path.join(b.proj, "src", "d"));
    // Six liens de 800 allers-retours « d/.. » chacun, puis app.ts : 4 800 lectures, moins de 40 liens.
    const detour = "d/../".repeat(800);
    for (let k = 1; k <= 6; k++) {
      if (!link(t, `${detour}${k === 6 ? "app.ts" : `l${k + 1}`}`, path.join(b.proj, "src", `l${k}`), "file")) return;
    }
    // Deux liens (1 600 lectures) : chemin résolu normalement.
    assert.equal((await factsOf(b, "cat src/l5", "src/l5"))?.real, "/workspace/proj/src/app.ts");
    assert.equal(await factsOf(b, "cat src/l1", "src/l1"), null);
    await expectRule(b, "cat src/l1", "attente P02");
  });

  it("nom exact sur le disque : un alias 8.3 (ENV~1 pour .env) rend les faits inconnus ; la casse suit le disque", async (t) => {
    const b = bench(t);
    write(b.proj, ".env", `CLE=valeur${NL}`);
    // Casse : même verdict partout, chemin réel à la casse du disque quand le système de fichiers l'ignore.
    const caseInsensitive = fs.existsSync(path.join(b.proj, "readme.md"));
    assert.equal((await factsOf(b, "cat readme.md", "readme.md"))?.real, caseInsensitive ? "/workspace/proj/README.md" : "/workspace/proj/readme.md");
    await expectRule(b, "cat readme.md", "auto A-cat");
    // Barre oblique inverse : un seul nom sous Linux (absent) ; sous Windows, un chemin réécrit par le système, refusé.
    await expectRule(b, `cat ${SQ}x${BS}..${BS}README.md${SQ}`, WINDOWS ? "attente P02" : "auto A-cat");
    const alias = ["ENV~1", "ENV~2", "ENV~3", "ENV~4"].find((name) => fs.existsSync(path.join(b.proj, name)));
    if (alias === undefined) {
      t.skip("aucun nom court 8.3 sur ce système de fichiers (Linux, ou volume Windows sans noms courts)");
      return;
    }
    assert.equal(await factsOf(b, `cat ${SQ}${alias}${SQ}`, alias), null);
    await expectRule(b, `cat ${SQ}${alias}${SQ}`, "attente P02");
  });

  it(`nom exact cherché parmi ${SHELL_DIR_SCAN_MAX_ENTRIES} entrées au plus du dossier parent : au-delà, faits inconnus (P02)`, async (t) => {
    const b = bench(t);
    // src/lot contient 5 fichiers ; les dossiers au-dessus en ont 4 au plus (proj : .git, README.md, package.json, src).
    const names = [0, 1, 2, 3, 4].map((k) => `src/lot/f${k}.ts`);
    for (const name of names) write(b.proj, name, "x");
    const command = `cat ${names.join(" ")}`;
    await expectRule(b, command, "auto A-cat", { limits: { dirScanMaxEntries: 5 } });
    // Quel que soit l'ordre de lecture du disque, l'un des cinq noms est la 5e entrée de src/lot : avec 4, il reste inconnu.
    const facts = await collectShellContext(command, DIR, b.projects, { dirScanMaxEntries: 4 });
    const unknown = names.filter((name) => facts.paths.resolve(name) === null);
    assert.ok(unknown.length >= 1, JSON.stringify(unknown));
    await expectRule(b, command, "attente P02", { limits: { dirScanMaxEntries: 4 } });
  });
});

// --- Sous-arbre d'une recherche récursive --------------------------------------------------------------------------------------

describe("faits du disque : sous-arbre d'une recherche récursive (grep -r, rg, git grep)", () => {
  it("fichier caché sensible dans un sous-dossier → P03 ; .env.example permis", async (t) => {
    const b = bench(t);
    write(b.proj, "src/config/.env.example", `CLE=${NL}`);
    await expectRule(b, "grep -rn TODO src", "auto A-grep");
    write(b.proj, "src/config/.env.local", `CLE=valeur${NL}`);
    assert.equal((await expectRule(b, "grep -rn TODO src", "attente P03")).detail, "environnement:src/config/.env.local");
    await expectRule(b, "rg -n TODO src", "attente P03");
  });

  it("dossier sensible rapporté seul, sans y descendre ; ordre stable", async (t) => {
    const b = bench(t);
    write(b.proj, "src/.secrets/b/c.txt", "c");
    write(b.proj, "src/.secrets/a.txt", "a");
    write(b.proj, "src/z/id_rsa", "z");
    const facts = await collectShellContext("grep -rn TODO src", DIR, b.projects);
    assert.deepEqual(facts.paths.sensitiveEntries("src"), ["src/.secrets", "src/z/id_rsa"]);
  });

  it("rg sans chemin parcourt le dossier : son .git compte (P03) ; git grep ne lit pas .git (automatique)", async (t) => {
    const b = bench(t);
    assert.equal((await expectRule(b, "rg -n TODO", "attente P03")).detail, "dossier:.git");
    await expectRule(b, "git grep -n TODO", "auto A-git-grep");
    await expectRule(b, "rg -n TODO src", "auto A-rg");
    await expectRule(b, "rg -n TODO src/app.ts", "auto A-rg");
  });

  it(`plafond d'entrées (${SHELL_WALK_MAX_ENTRIES} par défaut) : au-delà, parcours impossible (P03)`, async (t) => {
    const b = bench(t);
    for (let k = 0; k < 4; k++) write(b.proj, `src/lot/f${k}.ts`, "x");
    await expectRule(b, "grep -rn TODO src", "auto A-grep", { limits: { walkMaxEntries: 7 } });
    assert.equal((await expectRule(b, "grep -rn TODO src", "attente P03", { limits: { walkMaxEntries: 6 } })).detail, "parcours-impossible:src");
  });
});

// --- .git (S6, F-m) ------------------------------------------------------------------------------------------------------------

function resetGit(b: Bench, config: string | Buffer | null): void {
  fs.rmSync(path.join(b.proj, ".git"), { recursive: true, force: true });
  fs.mkdirSync(path.join(b.proj, ".git", "objects"), { recursive: true });
  fs.mkdirSync(path.join(b.proj, ".git", "refs"), { recursive: true });
  write(b.proj, ".git/HEAD", `ref: refs/heads/main${NL}`);
  if (config !== null) write(b.proj, ".git/config", config);
}

const withKeys = (...lines: string[]): string => `${CLEAN_GIT_CONFIG}${lines.join(NL)}${NL}`;

async function expectGitWait(b: Bench, detail: string, label: string): Promise<void> {
  for (const [command] of GIT_AUTOS) {
    const result = await decide(b, command);
    assert.deepEqual([result.verdict, result.regle, result.detail], ["attente", "G04", detail], `${label} : ${command}`);
  }
}

describe("faits du disque : .git (S6, F-m ; M10, M11)", () => {
  it("dépôt propre : les quatre consultations git sont automatiques ; .git/config est lu tel quel", async (t) => {
    const b = bench(t);
    for (const [command, regle] of GIT_AUTOS) await expectRule(b, command, `auto ${regle}`);
    // Ni hook, ni sous-module ; index absent (dépôt sans aucun fichier ajouté) : vide, comme git le lit.
    assert.deepEqual((await collectShellContext("git status", DIR, b.projects)).git, {
      gitIsDirectory: true,
      configText: CLEAN_GIT_CONFIG,
      launcher: null,
      trackedSensitive: [],
    });
  });

  it("T-L8-b : six dépôts piégés réels → attente (G04) pour git status, log, diff et show", async (t) => {
    const b = bench(t);
    const traps: ReadonlyArray<readonly [string, string, () => void]> = [
      [
        "fichier gitdir:",
        "git-pas-un-dossier",
        () => {
          fs.rmSync(path.join(b.proj, ".git"), { recursive: true, force: true });
          write(b.proj, ".git", `gitdir: ../ailleurs/.git${NL}`);
        },
      ],
      ["core.worktree", "core.worktree", () => resetGit(b, withKeys("[core]", `${TAB}worktree = /tmp/ailleurs`))],
      ["include", "include.path", () => resetGit(b, withKeys("[include]", `${TAB}path = ../piege.cfg`))],
      ["core.fsmonitor", "core.fsmonitor", () => resetGit(b, withKeys("[core]", `${TAB}fsmonitor = /tmp/temoin-l8b.sh`))],
      ["diff.external", "diff.external", () => resetGit(b, withKeys("[diff]", `${TAB}external = /tmp/temoin-l8b.sh`))],
      ["pager", "pager.log", () => resetGit(b, withKeys("[pager]", `${TAB}log = /tmp/temoin-l8b.sh`))],
      ["configuration illisible", "section-illisible", () => resetGit(b, withKeys("[core"))],
    ];
    for (const [label, detail, trap] of traps) {
      trap();
      await expectGitWait(b, detail, label);
    }
  });

  it("autres pièges de la sonde git (git-probe.sh) : pilote textconv et filtre clean nommés par .gitattributes, core.pager → G04", async (t) => {
    const b = bench(t);
    const traps: ReadonlyArray<readonly [string, string, string, string | null]> = [
      ["diff.tc.textconv", "diff.textconv", withKeys(`[diff ${DQ}tc${DQ}]`, `${TAB}textconv = /tmp/probe/tc.sh`), `a.txt diff=tc${NL}`],
      ["filter.cln.clean", "filter.clean", withKeys(`[filter ${DQ}cln${DQ}]`, `${TAB}clean = /tmp/probe/cln.sh`), `a.txt filter=cln${NL}`],
      ["core.pager", "core.pager", withKeys("[core]", `${TAB}pager = /tmp/probe/pg.sh`), null],
    ];
    for (const [label, detail, config, attributes] of traps) {
      resetGit(b, config);
      fs.rmSync(path.join(b.proj, ".gitattributes"), { force: true });
      if (attributes !== null) write(b.proj, ".gitattributes", attributes);
      await expectGitWait(b, detail, label);
    }
  });

  it("voisins des pièges : .git lien, commondir (configuration d'un autre dossier), .git absent → G04", async (t) => {
    const b = bench(t);
    resetGit(b, withKeys("[extensions]", `${TAB}objectformat = sha1`));
    write(b.proj, ".git/commondir", `../ailleurs${NL}`);
    await expectGitWait(b, "git-pas-un-dossier", "commondir");
    fs.rmSync(path.join(b.proj, ".git"), { recursive: true, force: true });
    await expectGitWait(b, "git-pas-un-dossier", ".git absent");
    const real = path.join(b.proj, "vrai-git");
    fs.mkdirSync(path.join(real, "objects"), { recursive: true });
    write(real, "config", CLEAN_GIT_CONFIG);
    link(t, "vrai-git", path.join(b.proj, ".git"), "dir");
    await expectGitWait(b, "git-pas-un-dossier", ".git lien");
  });

  it(`borne de lecture de .git/config : ${SHELL_GIT_CONFIG_MAX_BYTES} octets lus, un de plus → illisible`, async (t) => {
    const b = bench(t);
    const padding = SHELL_GIT_CONFIG_MAX_BYTES - Buffer.byteLength(CLEAN_GIT_CONFIG) - 2;
    const atLimit = `${CLEAN_GIT_CONFIG}#${"x".repeat(padding)}${NL}`;
    assert.equal(Buffer.byteLength(atLimit), SHELL_GIT_CONFIG_MAX_BYTES);
    resetGit(b, atLimit);
    for (const [command, regle] of GIT_AUTOS) await expectRule(b, command, `auto ${regle}`);
    assert.equal((await collectShellContext("git status", DIR, b.projects)).git.configText, atLimit);
    resetGit(b, `${CLEAN_GIT_CONFIG}#${"x".repeat(padding + 1)}${NL}`);
    await expectGitWait(b, "illisible", "65 537 octets");
    resetGit(b, `${CLEAN_GIT_CONFIG}#${"x".repeat(10 * SHELL_GIT_CONFIG_MAX_BYTES)}${NL}`);
    await expectGitWait(b, "illisible", "640 Kio");
  });

  it(".git/config illisible : absent, dossier, lien, UTF-8 invalide, octet nul → G04", async (t) => {
    const b = bench(t);
    const clean = Buffer.from(CLEAN_GIT_CONFIG);
    resetGit(b, null);
    await expectGitWait(b, "illisible", "absent");
    fs.mkdirSync(path.join(b.proj, ".git", "config"));
    await expectGitWait(b, "illisible", "dossier");
    resetGit(b, Buffer.concat([clean, Buffer.from([0x23, 0xff, 0x0a])]));
    await expectGitWait(b, "illisible", "UTF-8 invalide dans un commentaire");
    resetGit(b, Buffer.concat([clean, Buffer.from([0x23, 0x00, 0x0a])]));
    await expectGitWait(b, "illisible", "octet nul dans un commentaire");
    resetGit(b, null);
    write(b.proj, "propre.cfg", CLEAN_GIT_CONFIG);
    if (!link(t, "../propre.cfg", path.join(b.proj, ".git", "config"), "file")) return;
    await expectGitWait(b, "illisible", "lien vers une configuration propre");
  });

  it("aucune exécution de git (M10) : aucun module qui lance un programme ; un core.fsmonitor piégé n'est jamais lancé", async (t) => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "shell-facts.ts"), "utf8");
    assert.deepEqual(
      [...source.matchAll(/\bfrom\s*"([^"]+)"/g)].map((m) => m[1]),
      ["node:fs", "node:fs/promises", "node:path", "./projects.ts", "./shared/shell-gate.ts"],
    );
    assert.doesNotMatch(source, /child_process|\bspawn|\bexecFile|process\.binding/);
    const b = bench(t);
    const witness = path.join(b.outside, "temoin.txt");
    const script = write(b.outside, "fsmonitor.sh", `#!/bin/sh${NL}echo lance > ${JSON.stringify(witness)}${NL}`);
    fs.chmodSync(script, 0o755);
    resetGit(b, withKeys("[core]", `${TAB}fsmonitor = ${script.split(path.sep).join("/")}`));
    await expectGitWait(b, "core.fsmonitor", "fsmonitor témoin");
    assert.equal(fs.existsSync(witness), false);
  });

  it("M11 : seule la configuration du dépôt est lue ; git n'est lu que si la porte le demande", async (t) => {
    const b = bench(t);
    // cat README.md ne demande rien de git : dépôt propre ou non, aucun fait git relevé.
    assert.deepEqual((await collectShellContext("cat README.md", DIR, b.projects)).git, {
      gitIsDirectory: false,
      configText: null,
      launcher: null,
      trackedSensitive: null,
    });
    assert.deepEqual((await collectShellContext("git diff --stat", DIR, b.projects)).git, {
      gitIsDirectory: true,
      configText: CLEAN_GIT_CONFIG,
      launcher: null,
      trackedSensitive: [],
    });
  });
});

// --- Hooks, sous-modules, index et historique (relecture 2-vague-1) ----------------------------------------------------------------

const MODE_FILE = 0o100644;
const MODE_GITLINK = 0o160000;

interface IndexEntry {
  path: string;
  mode?: number;
  /** Bit « étendu » (version 3 et 4) : deux octets d'indicateurs de plus (skip-worktree ici). */
  extended?: boolean;
}

interface IndexOptions {
  version?: 2 | 3 | 4;
  hashSize?: 20 | 32;
  extensions?: ReadonlyArray<readonly [string, Buffer]>;
}

/** Index git (gitformat-index) écrit octet par octet : métadonnées nulles, empreintes fictives, somme finale nulle. */
function gitIndexBytes(entries: readonly IndexEntry[], options: IndexOptions = {}): Buffer {
  const version = options.version ?? 2;
  const hashSize = options.hashSize ?? 20;
  const header = Buffer.alloc(12);
  header.write("DIRC", 0, "latin1");
  header.writeUInt32BE(version, 4);
  header.writeUInt32BE(entries.length, 8);
  const parts: Buffer[] = [header];
  let previous = Buffer.alloc(0);
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const fixed = Buffer.alloc(40 + hashSize + 2 + (entry.extended ? 2 : 0));
    fixed.writeUInt32BE(entry.mode ?? MODE_FILE, 24);
    fixed.fill(0x11, 40, 40 + hashSize);
    fixed.writeUInt16BE((entry.extended ? 0x4000 : 0) | Math.min(name.length, 0xfff), 40 + hashSize);
    if (entry.extended) fixed.writeUInt16BE(0x4000, 40 + hashSize + 2);
    if (version === 4) {
      let common = 0;
      while (common < previous.length && common < name.length && previous[common] === name[common]) common++;
      const strip = previous.length - common;
      assert.ok(strip < 128, "préfixe à retirer sur un octet");
      parts.push(fixed, Buffer.from([strip]), name.subarray(common), Buffer.from([0]));
    } else {
      const size = (fixed.length + name.length + 8) & ~7;
      parts.push(fixed, name, Buffer.alloc(size - fixed.length - name.length));
    }
    previous = name;
  }
  for (const [signature, data] of options.extensions ?? []) {
    const head = Buffer.alloc(8);
    head.write(signature, 0, "latin1");
    head.writeUInt32BE(data.length, 4);
    parts.push(head, data);
  }
  parts.push(Buffer.alloc(hashSize));
  return Buffer.concat(parts);
}

function writeIndex(b: Bench, entries: readonly IndexEntry[], options: IndexOptions = {}): void {
  fs.writeFileSync(path.join(b.proj, ".git", "index"), gitIndexBytes(entries, options));
}

const TRACKED_CLEAN: readonly IndexEntry[] = [{ path: "README.md" }, { path: "package.json" }, { path: "src/a.ts" }, { path: "src/app.ts" }];
const TRACKED_ENV: readonly IndexEntry[] = [{ path: ".env" }, ...TRACKED_CLEAN];

/** git, si la machine l'a, sans configuration de l'utilisateur ni du système ; null sinon. */
function realGit(t: TestContext, cwd: string): ((...args: string[]) => string) | null {
  const empty = path.join(cwd, "..", "gitconfig-vide");
  fs.writeFileSync(empty, "");
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: empty, GIT_TERMINAL_PROMPT: "0" };
  const run = (...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    run("--version");
  } catch {
    t.skip("git absent de cette machine : l'index écrit octet par octet reste testé");
    return null;
  }
  return run;
}

describe("faits du disque : hooks et sous-modules (G04 sans clé de configuration, relecture 2-vague-1)", () => {
  const CONSULTATIONS = [...GIT_AUTOS.map(([command]) => command), "git status", "git diff", "git log --oneline", "git ls-files", "git grep -n TODO"];

  async function expectG04(b: Bench, detail: string, label: string): Promise<void> {
    for (const command of CONSULTATIONS) {
      const result = await decide(b, command);
      assert.deepEqual([result.verdict, result.regle, result.detail], ["attente", "G04", detail], `${label} : ${command}`);
    }
  }

  it("hook post-index-change dans un dépôt à la configuration propre → G04 ; hooks tous en .sample → consultations automatiques", async (t) => {
    const b = bench(t);
    writeIndex(b, TRACKED_CLEAN);
    for (const sample of ["pre-commit.sample", "post-update.sample", "fsmonitor-watchman.sample"]) write(b.proj, `.git/hooks/${sample}`, `#!/bin/sh${NL}`);
    for (const command of CONSULTATIONS) assert.equal((await decide(b, command)).verdict, "auto", `témoin : ${command}`);
    write(b.proj, ".git/hooks/post-index-change", `#!/bin/sh${NL}echo lance > /tmp/temoin${NL}`);
    await expectG04(b, "hook:post-index-change", "post-index-change");
    // Tout hook actif compte (pre-commit compris) : premier nom par ordre alphabétique.
    write(b.proj, ".git/hooks/pre-commit", `#!/bin/sh${NL}`);
    await expectG04(b, "hook:post-index-change", "deux hooks");
    assert.equal((await collectShellContext("git status", DIR, b.projects)).git.launcher, "hook:post-index-change");
  });

  it(`.git/hooks illisible : fichier, lien, plus de ${SHELL_GIT_HOOKS_MAX_ENTRIES} entrées → G04`, async (t) => {
    const b = bench(t);
    write(b.proj, ".git/hooks", "pas un dossier");
    await expectG04(b, "hooks-illisibles", "fichier");
    fs.rmSync(path.join(b.proj, ".git", "hooks"));
    for (let k = 0; k < SHELL_GIT_HOOKS_MAX_ENTRIES; k++) write(b.proj, `.git/hooks/h${k}.sample`, "");
    assert.equal((await decide(b, "git status")).verdict, "auto", `${SHELL_GIT_HOOKS_MAX_ENTRIES} entrées : lues`);
    write(b.proj, `.git/hooks/h${SHELL_GIT_HOOKS_MAX_ENTRIES}.sample`, "");
    await expectG04(b, "hooks-illisibles", "une entrée de trop");
    fs.rmSync(path.join(b.proj, ".git", "hooks"), { recursive: true });
    // Lecture du dossier refusée (EACCES simulée) : jamais « aucun hook ».
    const hooks = path.join(b.proj, ".git", "hooks");
    write(b.proj, ".git/hooks/pre-commit.sample", "");
    const opendir = fsp.opendir;
    const refused = t.mock.method(fsp, "opendir", (async (dir: string, ...rest: unknown[]) => {
      if (path.resolve(dir) === hooks) throw Object.assign(new Error("EACCES (simulée)"), { code: "EACCES" });
      return (opendir as (...args: unknown[]) => Promise<unknown>)(dir, ...rest);
    }) as typeof fsp.opendir);
    await expectG04(b, "hooks-illisibles", "lecture refusée");
    refused.mock.restore();
    fs.rmSync(hooks, { recursive: true });
    fs.mkdirSync(path.join(b.proj, "crochets"));
    link(t, "../crochets", path.join(b.proj, ".git", "hooks"), "dir");
    await expectG04(b, "hooks-illisibles", "lien");
  });

  it("lien de sous-module peuplé sans .gitmodules, dont la configuration lance un programme → G04 (git status le visiterait)", async (t) => {
    const b = bench(t);
    write(b.proj, "sub/.git/config", `${CLEAN_GIT_CONFIG}[core]${NL}${TAB}fsmonitor = /tmp/temoin.sh${NL}`);
    write(b.proj, "sub/.git/HEAD", `ref: refs/heads/main${NL}`);
    writeIndex(b, [...TRACKED_CLEAN, { path: "sub", mode: MODE_GITLINK }]);
    await expectG04(b, "sous-module:sub", "lien de sous-module");
    assert.deepEqual((await collectShellContext("git status", DIR, b.projects)).git.trackedSensitive, []);
  });

  it(".gitmodules ou .git/modules présents → G04, même sans lien de sous-module dans l'index", async (t) => {
    const b = bench(t);
    writeIndex(b, TRACKED_CLEAN);
    write(b.proj, ".gitmodules", `[submodule ${DQ}sub${DQ}]${NL}${TAB}path = sub${NL}`);
    await expectG04(b, "sous-module:.gitmodules", ".gitmodules");
    fs.rmSync(path.join(b.proj, ".gitmodules"));
    write(b.proj, ".git/modules/sub/config", `${CLEAN_GIT_CONFIG}[core]${NL}${TAB}fsmonitor = /tmp/temoin.sh${NL}`);
    await expectG04(b, "sous-module:.git/modules", ".git/modules");
  });

  it("index illisible (forme inattendue, index scindé) → G04 ; git diff et git grep, qui en montreraient le contenu : P03 d'abord", async (t) => {
    const b = bench(t);
    const content = ["git diff", "git grep -n TODO"];
    for (const [label, corrupt] of [
      ["texte", () => fs.writeFileSync(path.join(b.proj, ".git", "index"), "pas un index")],
      ["extension link", () => writeIndex(b, TRACKED_CLEAN, { extensions: [["link", Buffer.alloc(20)]] })],
    ] as const) {
      corrupt();
      for (const command of CONSULTATIONS) {
        const result = await decide(b, command);
        const expected = content.includes(command) ? ["attente", "P03", "index-illisible"] : ["attente", "G04", "index-illisible"];
        assert.deepEqual([result.verdict, result.regle, result.detail], expected, `${label} : ${command}`);
      }
    }
  });
});

describe("faits du disque : contenu montré par git diff, git show, git grep (P03, relecture 2-vague-1)", () => {
  it("dépôt dont le .env est suivi : git diff et git grep attendent, même .env supprimé du disque ; noms seuls automatiques", async (t) => {
    const b = bench(t);
    write(b.proj, ".env", `CLE=valeur${NL}`);
    writeIndex(b, TRACKED_ENV);
    assert.deepEqual((await collectShellContext("git diff", DIR, b.projects)).git.trackedSensitive, [".env"]);
    for (const command of ["git diff", "git diff src", "git diff -- src", "git grep -n TODO", "git grep -n TODO -- src"]) {
      assert.equal((await expectRule(b, command, "attente P03")).detail, "environnement:.env", command);
    }
    for (const [command, regle] of [
      ["git diff --stat", "A-git-diff"],
      ["git diff --name-only", "A-git-diff"],
      ["git show --stat", "A-git-show"],
      ["git show HEAD:package.json", "A-git-show"],
      ["git status --short", "A-git-status"],
      ["git log --oneline -n 20", "A-git-log"],
    ] as const) {
      await expectRule(b, command, `auto ${regle}`);
    }
    // .env supprimé du disque, toujours suivi : aucun parcours ne le voit, l'index si.
    fs.rmSync(path.join(b.proj, ".env"));
    assert.deepEqual((await collectShellContext("git grep -n TODO", DIR, b.projects)).paths.sensitiveEntries("."), [".git"]);
    assert.equal((await expectRule(b, "git grep -n TODO", "attente P03")).detail, "environnement:.env");
    assert.equal((await expectRule(b, "git diff", "attente P03")).detail, "environnement:.env");
    // Témoin : index sans chemin sensible.
    writeIndex(b, TRACKED_CLEAN);
    for (const command of ["git diff", "git diff src", "git diff -- src", "git grep -n TODO"]) await expectRule(b, command, `auto ${command.startsWith("git diff") ? "A-git-diff" : "A-git-grep"}`);
  });

  it("historique : git show sans rév:chemin, révision absente du disque, argument avant « -- », --cached → P03", async (t) => {
    const b = bench(t);
    writeIndex(b, TRACKED_CLEAN);
    const cases: Array<[string, string]> = [
      ["git show", "historique:HEAD"],
      ["git show HEAD", "historique:HEAD"],
      ["git diff HEAD", "historique:HEAD"],
      ["git diff main src", "historique:main"],
      ["git diff src -- README.md", "historique:src"],
      ["git diff --cached", "historique:--cached"],
      ["git grep -n TODO main", "historique:main"],
      ["git grep -n TODO HEAD:src", "historique:HEAD:src"],
    ];
    for (const [command, detail] of cases) assert.equal((await expectRule(b, command, "attente P03")).detail, detail, command);
    // Un argument qui existe sur le disque est un chemin pour git (un nom à la fois chemin et révision est refusé par git).
    const facts = await collectShellContext("git diff src README.md main", DIR, b.projects);
    assert.deepEqual(["src", "README.md", "main"].map((arg) => facts.paths.exists?.(arg)), [true, true, false]);
    await expectRule(b, "git diff src README.md", "auto A-git-diff");
    await expectRule(b, "git grep -n TODO src", "auto A-git-grep");
  });

  it("index illisible pour git diff : P03 avant G04 ; .git qui n'est pas un dossier : G04", async (t) => {
    const b = bench(t);
    writeIndex(b, TRACKED_CLEAN, { extensions: [["sdir", Buffer.alloc(0)]] });
    assert.equal((await expectRule(b, "git diff", "attente P03")).detail, "index-illisible");
    assert.equal((await expectRule(b, "git status", "attente G04")).detail, "index-illisible");
    fs.rmSync(path.join(b.proj, ".git"), { recursive: true, force: true });
    assert.equal((await expectRule(b, "git diff", "attente G04")).detail, "git-pas-un-dossier");
  });

  it(`index lu sans suivre de lien et borné à ${SHELL_GIT_INDEX_MAX_BYTES} octets ; index absent : vide`, async (t) => {
    const b = bench(t);
    assert.deepEqual((await collectShellContext("git diff", DIR, b.projects)).git.trackedSensitive, [], "absent");
    const big = path.join(b.proj, ".git", "index");
    fs.writeFileSync(big, Buffer.alloc(SHELL_GIT_INDEX_MAX_BYTES + 1));
    assert.equal((await collectShellContext("git diff", DIR, b.projects)).git.trackedSensitive, null, "trop grand");
    fs.rmSync(big);
    fs.writeFileSync(path.join(b.proj, "index-propre"), gitIndexBytes(TRACKED_CLEAN));
    if (!link(t, "../index-propre", big, "file")) return;
    assert.equal((await collectShellContext("git diff", DIR, b.projects)).git.trackedSensitive, null, "lien");
    await expectRule(b, "git diff", "attente P03");
  });
});

describe("faits du disque : lecture de l'index git (parseGitIndex, relecture 2-vague-1)", () => {
  const paths = (buffer: Buffer) => parseGitIndex(buffer)?.paths ?? null;

  it("versions 2, 3 et 4, SHA-1 et SHA-256, bit étendu, liens de sous-module, extensions facultatives", () => {
    const entries: IndexEntry[] = [
      { path: ".env" },
      { path: "src/a.ts", extended: true },
      { path: "src/app.ts" },
      { path: "sub", mode: MODE_GITLINK },
      { path: `docs/${"x".repeat(5000)}` },
    ];
    const expected = entries.map((entry) => entry.path);
    for (const version of [3, 4] as const) {
      for (const hashSize of [20, 32] as const) {
        const parsed = parseGitIndex(gitIndexBytes(entries, { version, hashSize, extensions: [["TREE", Buffer.from("abc")], ["UNTR", Buffer.alloc(0)]] }));
        assert.deepEqual(parsed?.paths, expected, `v${version}, ${hashSize} octets`);
        assert.deepEqual(parsed?.gitlinks, ["sub"], `v${version}, ${hashSize} octets`);
      }
    }
    const plain = entries.filter((entry) => !entry.extended);
    assert.deepEqual(paths(gitIndexBytes(plain)), plain.map((entry) => entry.path), "v2");
    assert.deepEqual(paths(gitIndexBytes([])), [], "index vide");
  });

  it("formes refusées : signature, version, entrée tronquée, bourrage, longueur du nom, dossier clairsemé, extension obligatoire, octets en trop", () => {
    const good = gitIndexBytes(TRACKED_CLEAN);
    assert.ok(parseGitIndex(good));
    const altered = (at: number, byte: number) => {
      const copy = Buffer.from(good);
      copy[at] = byte;
      return copy;
    };
    // package.json (12 octets) : nom, octet nul, puis 5 octets de bourrage ; l'octet de poids faible des indicateurs précède le nom.
    const packageName = good.indexOf("package.json");
    const refused: Array<[string, Buffer]> = [
      ["signature", altered(0, 0x45)],
      ["version 1", altered(7, 1)],
      ["version 5", altered(7, 5)],
      ["tronqué", good.subarray(0, 60)],
      ["plus d'entrées annoncées", altered(11, 9)],
      ["bourrage non nul", altered(packageName + "package.json".length + 2, 0x41)],
      ["longueur du nom", altered(packageName - 1, "package.json".length + 1)],
      ["dossier clairsemé", gitIndexBytes([{ path: "src", mode: 0o40000 }])],
      ["bit étendu en version 2", gitIndexBytes([{ path: "a", extended: true }], { version: 2 })],
      ["extension obligatoire link", gitIndexBytes(TRACKED_CLEAN, { extensions: [["link", Buffer.alloc(4)]] })],
      ["extension obligatoire sdir", gitIndexBytes(TRACKED_CLEAN, { extensions: [["sdir", Buffer.alloc(0)]] })],
      ["extension qui dépasse", Buffer.concat([gitIndexBytes(TRACKED_CLEAN, { extensions: [["TREE", Buffer.alloc(4)]] }).subarray(0, -22), Buffer.alloc(20)])],
      ["octets en trop", Buffer.concat([good.subarray(0, -20), Buffer.from([1, 2, 3]), good.subarray(-20)])],
      ["nom UTF-8 invalide", Buffer.from(gitIndexBytes([{ path: "a-b" }]).toString("latin1").replace("a-b", "a" + String.fromCharCode(0xff) + "b"), "latin1")],
    ];
    for (const [label, buffer] of refused) assert.equal(parseGitIndex(buffer), null, label);
  });

  it("index produit par le vrai git (v2, v4, SHA-256) : chemins suivis et lien de sous-module relus à l'identique", async (t) => {
    const b = bench(t);
    const git = realGit(t, b.proj);
    if (git === null) return;
    fs.rmSync(path.join(b.proj, ".git"), { recursive: true, force: true });
    git("init", "-q");
    write(b.proj, ".env", `CLE=valeur${NL}`);
    write(b.proj, "src/cles/dev.key", "x");
    git("add", "-A");
    git("update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},sub`);
    const listed = git("ls-files", "-s").split(NL).filter(Boolean).map((line) => line.split(TAB)[1]);
    for (const version of ["2", "4"]) {
      git("update-index", "--index-version", version);
      const facts = await collectShellContext("git diff", DIR, b.projects);
      assert.deepEqual(parseGitIndex(fs.readFileSync(path.join(b.proj, ".git", "index")))?.paths, listed, `v${version}`);
      assert.deepEqual(facts.git.trackedSensitive, [".env", "src/cles/dev.key"], `v${version}`);
      assert.equal(facts.git.launcher, "sous-module:sub", `v${version}`);
    }
    fs.rmSync(path.join(b.proj, ".git"), { recursive: true, force: true });
    try {
      git("init", "-q", "--object-format=sha256");
    } catch {
      t.diagnostic("git sans SHA-256 : cas sauté");
      return;
    }
    git("add", "-A");
    assert.deepEqual((await collectShellContext("git diff", DIR, b.projects)).git.trackedSensitive, [".env", "src/cles/dev.key"], "SHA-256");
  });
});

// --- Dossier de la conversation et questions --------------------------------------------------------------------------------------

describe("faits du disque : dossier de la conversation et questions de la porte", () => {
  it("dossier absent, hors du workspace, relatif, lien ou nom inexact : aucun fait, tout attend", async (t) => {
    const b = bench(t);
    link(t, "proj", path.join(b.root, "lien"), "dir");
    const caseInsensitive = fs.existsSync(path.join(b.root, "PROJ"));
    const dirs = ["/workspace/absent", "/tmp/proj", "proj", "/workspace/lien", ...(caseInsensitive ? ["/workspace/PROJ"] : [])];
    for (const dir of dirs) {
      await expectRule(b, "cat README.md", "attente P02", { dir });
      await expectRule(b, "git status", "attente G04", { dir });
      const facts = await collectShellContext("grep -rn TODO src", dir, b.projects);
      assert.equal(facts.paths.sensitiveEntries("src"), null, dir);
    }
  });

  it("racine du workspace absente ou fichier du côté du cockpit (montage manquant) : aucun fait, tout attend", async (t) => {
    const b = bench(t);
    const roots = [path.join(path.dirname(b.root), "absent"), path.join(b.proj, "README.md")];
    for (const workspaceDir of roots) {
      const projects = new ProjectsService({ workspaceDir, opencodeWorkspaceDir: OC_ROOT });
      const facts = await collectShellContext("cat README.md", OC_ROOT, projects);
      assert.equal(facts.paths.resolve("README.md"), null, workspaceDir);
      assert.equal(classifyCommand("cat README.md", { ...facts, workdir: null, allowJudge: false }).regle, "P02", workspaceDir);
    }
  });

  it("racine du workspace comme dossier de la conversation", async (t) => {
    const b = bench(t);
    await expectRule(b, "cat proj/README.md", "auto A-cat", { dir: OC_ROOT });
    await expectRule(b, "git status", "attente G04", { dir: OC_ROOT });
    await expectRule(b, "grep -rn TODO proj", "attente P03", { dir: OC_ROOT });
  });

  it("une question que la porte n'a pas annoncée reçoit null ; les faits rendus sont des copies", async (t) => {
    const b = bench(t);
    const facts = await collectShellContext("cat README.md", DIR, b.projects);
    assert.equal(facts.paths.resolve("package.json"), null);
    assert.equal(facts.paths.sensitiveEntries("."), null);
    const first = facts.paths.resolve("README.md");
    assert.ok(first);
    first.inside = false;
    first.real = "/";
    assert.deepEqual(facts.paths.resolve("README.md"), { inside: true, symlinkOut: false, real: "/workspace/proj/README.md" });
    const walk = await collectShellContext("grep -rn TODO src", DIR, b.projects);
    assert.deepEqual(walk.paths.sensitiveEntries("src"), []);
    assert.equal(walk.paths.resolve("README.md"), null);
  });

  it("U01 et S7 sur de vrais faits : adresse réseau → attente même en Autonome ; programme non listé à juger seulement si permis", async (t) => {
    const b = bench(t);
    const cases: Array<[string, string]> = [
      ["mytool deploy@example.invalid", "utilisateur-hote"],
      ["mytool example.invalid:8080", "port"],
      ["mytool :8080", "port"],
      ["mytool 192.0.2.10", "ipv4"],
      ["mytool fe80::1", "ipv6"],
    ];
    for (const [command, kind] of cases) {
      const result = await expectRule(b, command, "attente U01", { allowJudge: true });
      assert.ok(result.detail.startsWith(`${kind}:`), `${command} → ${result.detail}`);
    }
    assert.equal((await decide(b, "mytool https://example.invalid/x", { allowJudge: true })).verdict, "attente");
    await expectRule(b, "mytool src/app.ts", "a-juger S7", { allowJudge: true });
    await expectRule(b, "mytool src/app.ts", "attente S7");
    await expectRule(b, "mytool ../dehors/notes.txt", "attente P02", { allowJudge: true });
  });
});
