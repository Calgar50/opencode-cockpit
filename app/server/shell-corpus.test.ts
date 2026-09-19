// Corpus de la sonde « autonomy-probe » (spécification §4.5 « corpus porté tel quel », §6 l.1040 ; décision D-08 : 116 commandes ;
// plan d'exécution, fiche L8b) : les 116 lignes de results.json, portées dans test-support/fixtures/shell-corpus.json, rejouées sur
// un vrai dossier par collectShellContext puis la porte (shared/shell-gate.ts) : exactement les 11 consultations automatiques de la
// sonde (T-L8-a), le reste en attente avec sa règle ; dépôt piégé : toute commande git attend ; formes sans motif (F-l) ; analyse
// de secrets de la fixture à chaque exécution.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { ProjectsService } from "./projects.ts";
import { redactSecrets } from "./redact.ts";
import { collectShellContext } from "./shell-facts.ts";
import { classifyCommand, isNoRequestShellForm, type ShellVerdict } from "./shared/shell-gate.ts";
import { leaks } from "./test-support/helpers.ts";

interface ProbeRow {
  id: string;
  command: string;
  opencodePatterns: string[];
  opencodeExternalDirs: string[];
  treeSitterError: boolean;
  prudent: string;
  nativeReadOnlyRules: string;
  gate: { decision: "auto" | "pause"; rule: string; detail: string };
  gateIfRepoConfigNotClean?: "auto" | "pause";
  attendu: { verdict: "auto" | "attente"; regle: string };
}

interface Corpus {
  source: string;
  opencode: string;
  dossier: string;
  notes: string[];
  nettoyage: string;
  commandes: ProbeRow[];
}

const CORPUS_URL = new URL("./test-support/fixtures/shell-corpus.json", import.meta.url);
const CORPUS_TEXT = fs.readFileSync(CORPUS_URL, "utf8");
const CORPUS = JSON.parse(CORPUS_TEXT) as Corpus;
const ROWS = CORPUS.commandes;

const AUTOS = ["ok-ls", "ok-pwd", "ok-status", "ok-cat", "ok-grep", "ok-log", "ok-diff", "ok-show-path", "ok-find", "ok-abs-in-project", "ok-head"];
const PROBE_KEYS = ["id", "command", "opencodePatterns", "opencodeExternalDirs", "treeSitterError", "prudent", "nativeReadOnlyRules", "gate"];
const NL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const DQ = String.fromCharCode(34);

const CLEAN_GIT_CONFIG = [
  "[core]",
  `${TAB}repositoryformatversion = 0`,
  `${TAB}filemode = true`,
  `${TAB}bare = false`,
  `[remote ${DQ}origin${DQ}]`,
  `${TAB}url = https://example.invalid/depot.git`,
  `${TAB}fetch = +refs/heads/*:refs/remotes/origin/*`,
  "",
].join(NL);

/**
 * Dossier de la sonde (/workspace/proj) sur le disque : README.md, package.json, src/app.ts, src/a.ts et un dépôt git dont la
 * configuration est donnée. Rend la fonction de décision : faits réels, puis la porte.
 */
function project(t: TestContext, gitConfig: string): (command: string, allowJudge?: boolean) => Promise<ShellVerdict> {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-shell-corpus-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "ws");
  const proj = path.join(root, "proj");
  for (const dir of ["src", ".git/objects", ".git/refs"]) fs.mkdirSync(path.join(proj, ...dir.split("/")), { recursive: true });
  const files: Record<string, string> = {
    "README.md": `# Projet${NL}`,
    "package.json": `{}${NL}`,
    "src/app.ts": `// TODO${NL}`,
    "src/a.ts": `export {};${NL}`,
    ".git/HEAD": `ref: refs/heads/main${NL}`,
    ".git/config": gitConfig,
  };
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(proj, ...name.split("/")), content);
  const projects = new ProjectsService({ workspaceDir: root, opencodeWorkspaceDir: "/workspace" });
  return async (command, allowJudge = false) => {
    const facts = await collectShellContext(command, CORPUS.dossier, projects);
    return classifyCommand(command, { ...facts, workdir: null, allowJudge });
  };
}

describe("corpus de la sonde : fixture (116 lignes, D-08)", () => {
  it("116 lignes, identifiants uniques, champs de la sonde gardés, verdict attendu de la porte 1.1", () => {
    assert.equal(ROWS.length, 116);
    assert.equal(new Set(ROWS.map((row) => row.id)).size, 116);
    assert.equal(CORPUS.dossier, "/workspace/proj");
    for (const row of ROWS) {
      for (const key of PROBE_KEYS) assert.ok(Object.hasOwn(row, key), `${row.id} : ${key}`);
      assert.deepEqual(Object.keys(row).filter((key) => !PROBE_KEYS.includes(key) && key !== "gateIfRepoConfigNotClean"), ["attendu"], row.id);
      assert.equal(row.attendu.verdict, row.attendu.regle.startsWith("A-") ? "auto" : "attente", row.id);
    }
    // Une ligne par commande, comme results.json.
    assert.equal(CORPUS_TEXT.split(NL).filter((line) => line.startsWith(`    {${DQ}id${DQ}:`)).length, 116);
  });

  it("analyse de secrets : aucun secret ; deux concordances bénignes documentées (motif cherché par grep-abs, adresse privée de redirect-dev-tcp)", () => {
    const benign: Record<string, string[]> = { "grep-abs": ["en-tête ou mot de passe"], "redirect-dev-tcp": ["adresse IP"] };
    for (const row of ROWS) assert.deepEqual(leaks(JSON.stringify(row)), benign[row.id] ?? [], row.id);
    const { commandes: _rows, ...header } = CORPUS;
    assert.deepEqual(leaks(JSON.stringify(header)), []);
    // Le masquage des journaux (redact.ts) ne trouve rien à masquer.
    const strings = (value: unknown): string[] =>
      typeof value === "string" ? [value] : value !== null && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
    for (const text of strings(CORPUS)) assert.equal(redactSecrets(text), text, text);
    // Les deux concordances : un mot seul (aucune valeur) et une adresse du réseau privé 10/8.
    const grepAbs = ROWS.find((row) => row.id === "grep-abs");
    assert.equal(grepAbs?.command, "grep -r password /home/node");
    assert.match(ROWS.find((row) => row.id === "redirect-dev-tcp")?.command ?? "", /\/dev\/tcp\/10\.[0-9.]+\/80$/);
  });

  it("règles de la sonde et de la porte : mêmes codes, ou correspondance documentée", () => {
    for (const { id, gate, attendu } of ROWS) {
      assert.equal(gate.decision === "auto", attendu.verdict === "auto", id);
      const probe = gate.rule.slice(0, 3);
      if (gate.decision === "auto") assert.equal(gate.rule, attendu.regle, id);
      else if (probe === "C04") assert.match(attendu.regle, /^(S4-[a-z]+|S7)$/, id);
      else if (probe === "G02" || probe === "G03") assert.equal(attendu.regle, "S4-git", id);
      else if (probe === "F01") assert.equal(attendu.regle, "O01", id);
      else assert.equal(attendu.regle, probe, id);
    }
  });

  it("F-l : opencode ne pose aucune demande (aucun motif) exactement pour les formes reconnues par isNoRequestShellForm", () => {
    const noPattern = ROWS.filter((row) => row.opencodePatterns.length === 0).map((row) => row.id);
    assert.deepEqual(noPattern, ["assign-only", "declare-only", "bare-redirect", "bare-redirect-config"]);
    assert.deepEqual(ROWS.filter((row) => isNoRequestShellForm(row.command)).map((row) => row.id), noPattern);
  });
});

describe("corpus de la sonde sur un vrai dossier (T-L8-a)", () => {
  it("exactement les 11 consultations automatiques de la sonde ; les 105 autres en attente avec leur règle", async (t) => {
    const decide = project(t, CLEAN_GIT_CONFIG);
    const autos: string[] = [];
    for (const row of ROWS) {
      const result = await decide(row.command);
      assert.deepEqual({ verdict: result.verdict, regle: result.regle }, row.attendu, `${row.id} → ${JSON.stringify(result)}`);
      if (result.verdict === "auto") autos.push(row.id);
    }
    assert.deepEqual(autos, AUTOS);
    assert.deepEqual(ROWS.filter((row) => row.gate.decision === "auto").map((row) => row.id), AUTOS);
  });

  it("en Autonome avec contrôle par IA : seuls sort -o et uniq sont « à juger »", async (t) => {
    const decide = project(t, CLEAN_GIT_CONFIG);
    const judged: string[] = [];
    for (const row of ROWS) if ((await decide(row.command, true)).verdict === "a-juger") judged.push(row.id);
    assert.deepEqual(judged, ["sort-o", "uniq-out"]);
  });

  it("dépôt piégé (core.fsmonitor) : toute commande git de la sonde attend, comme gateIfRepoConfigNotClean", async (t) => {
    const decide = project(t, `${CLEAN_GIT_CONFIG}[core]${NL}${TAB}fsmonitor = /tmp/temoin${NL}`);
    const gitRows = ROWS.filter((row) => row.gateIfRepoConfigNotClean !== undefined);
    // La sonde n'a relevé ce verdict que pour les commandes qui commencent par « git » : 21 lignes.
    assert.deepEqual(
      gitRows.map((row) => row.id),
      ROWS.filter((row) => row.command.startsWith("git ")).map((row) => row.id),
    );
    assert.equal(gitRows.length, 21);
    for (const row of gitRows) {
      assert.equal(row.gateIfRepoConfigNotClean, "pause", row.id);
      const result = await decide(row.command);
      assert.equal(result.verdict, "attente", row.id);
      if (row.attendu.verdict === "auto") assert.deepEqual([result.regle, result.detail], ["G04", "core.fsmonitor"], row.id);
      else assert.equal(result.regle, row.attendu.regle, row.id);
    }
  });
});
