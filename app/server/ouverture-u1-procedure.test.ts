// Procédure d'ouverture des équipes en mode Simple, JOUÉE (relecture de la vague 4 de la 5b ; U1, D-5-24, fiche L50b).
// e2e/README.md donne un bloc shell qui tire une copie jetable de la tête, y bascule `EQUIPES_SIMPLE_OUVERTES` et lance le banc
// depuis elle, « jamais dans le dépôt ni dans le dossier de travail ». Sa première version n'avait ni arrêt au premier échec ni
// enchaînement : quand le dossier de la copie ne pouvait pas être créé ($TEMP absent, parent manquant), `cd` échouait, le `test`
// comparait l'index DU DÉPÔT à la tête et passait, puis `sed -i` basculait la constante du dépôt — avec exactement la sortie
// annoncée comme attendue — et le banc partait du dépôt.
//
// Ce test extrait le bloc À L'OCTET d'e2e/README.md et le joue avec bash dans un dépôt git jetable du dossier temporaire, dont
// `scripts/run-e2e.sh` est un faux banc qui écrit où il a été lancé, la ligne qu'il y lit et ses arguments :
//   1. chemin nominal : le banc part d'une copie NEUVE où la constante vaut true, le dépôt n'a pas bougé, la copie est supprimée ;
//   2. dossier de la copie impossible à créer (parent absent) : échec, dépôt intact, banc jamais lancé ;
//   3. copie différente de la tête (un fichier `export-ignore`, que `git archive` n'emporte pas) : échec DIT, banc jamais lancé,
//      copie supprimée.
// Les contrôles de forme (arrêt au premier échec, dossier neuf, rien sur le dossier courant) tournent partout ; le bloc n'est
// joué que là où bash et git sont présents, sinon le test le dit et saute. Aucun réseau, aucun Docker, rien dans le dépôt.
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";

const DEPOT = path.resolve(import.meta.dirname, "..", "..");
const LIGNE_FERMEE = "export const EQUIPES_SIMPLE_OUVERTES = false;";
const LIGNE_OUVERTE = "export const EQUIPES_SIMPLE_OUVERTES = true;";
const WIRING = `// Câblage des équipes (dépôt jetable du test).\n${LIGNE_FERMEE}\nexport const AUTRE_REGLAGE = 1;\n`;

/** Faux banc : dit OÙ il a été lancé (le marqueur n'existe que dans le dépôt), la ligne qu'il y lit et ses arguments. */
const FAUX_BANC = [
  "#!/bin/sh",
  "if [ -e MARQUEUR-DEPOT ]; then ou=depot; else ou=copie; fi",
  "printf '%s\\n%s\\n%s\\n' \"$ou\" \"$(grep 'EQUIPES_SIMPLE_OUVERTES =' app/server/wiring-eq.ts)\" \"$*\" > \"$TRACE_BANC\"",
  "",
].join("\n");

/** Bloc shell de la procédure d'ouverture, extrait à l'octet de la section des scénarios d'e2e/README.md. */
function blocDOuverture(): string {
  const readme = fs.readFileSync(path.join(DEPOT, "e2e", "README.md"), "utf8");
  // Balises assemblées en deux morceaux : écrites d'un bloc, `construction-balises.test.ts` les prendrait pour des balises.
  const debut = readme.indexOf("<!-- " + "c5:scenarios -->");
  const fin = readme.indexOf("<!-- /" + "c5:scenarios -->");
  assert.ok(debut >= 0 && fin > debut, "section des scénarios de la construction introuvable dans e2e/README.md");
  const blocs = [...readme.slice(debut, fin).matchAll(/```sh\r?\n([\s\S]*?)```/g)]
    .map((m) => (m[1] ?? "").replace(/\r\n/g, "\n"))
    .filter((bloc) => bloc.includes("EQUIPES_SIMPLE_OUVERTES"));
  assert.equal(blocs.length, 1, "un seul bloc d'ouverture attendu dans e2e/README.md");
  return blocs[0] ?? "";
}

/** Chemin passé à bash : séparateur « / » (Git Bash accepte « C:/… »). */
const pourBash = (chemin: string): string => chemin.replace(/\\/g, "/");

interface Banc {
  racine: string;
  depot: string;
  trace: string;
  env: NodeJS.ProcessEnv;
  bash: string;
}

/**
 * Dépôt git jetable sous le dossier temporaire, sans configuration de l'utilisateur ni du système : `app/server/wiring-eq.ts`
 * fermé, le faux banc, et un marqueur NON SUIVI (exclu par `.git/info/exclude`) qui n'existe que dans le dépôt. `fichiers`
 * ajoute des fichiers suivis. Rend null, après avoir sauté le test en le disant, quand bash ou git manque.
 */
function preparer(t: TestContext, fichiers: Readonly<Record<string, string>> = {}): Banc | null {
  const racine = fs.mkdtempSync(path.join(os.tmpdir(), "c5b-ouverture-"));
  t.after(() => fs.rmSync(racine, { recursive: true, force: true, maxRetries: 3 }));
  const configVide = path.join(racine, "gitconfig-vide");
  fs.writeFileSync(configVide, "");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: configVide,
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "banc",
    GIT_AUTHOR_EMAIL: "banc@example.invalid",
    GIT_COMMITTER_NAME: "banc",
    GIT_COMMITTER_EMAIL: "banc@example.invalid",
  };
  const bash = process.env.COCKPIT_BASH?.trim() || "bash";
  // Sonde : ce bash voit $TEMP tel qu'on le lui passe (un bash de WSL ne le voit pas) et trouve les outils du bloc.
  fs.mkdirSync(path.join(racine, "sonde"));
  const sonde = spawnSync(bash, ["-c", 'test -d "$TEMP/sonde" && command -v git && command -v tar && command -v mktemp && command -v sed'], {
    env: { ...env, TEMP: pourBash(racine) },
    encoding: "utf8",
    timeout: 30_000,
  });
  if (sonde.error || sonde.status !== 0) {
    t.skip(`bash (avec git, tar, mktemp et sed, et $TEMP transmis) absent de cette machine : seuls les contrôles de forme tournent`);
    return null;
  }

  const depot = path.join(racine, "depot");
  const ecrire = (relatif: string, contenu: string) => {
    fs.mkdirSync(path.dirname(path.join(depot, relatif)), { recursive: true });
    fs.writeFileSync(path.join(depot, relatif), contenu);
  };
  ecrire("app/server/wiring-eq.ts", WIRING);
  ecrire("scripts/run-e2e.sh", FAUX_BANC);
  if (process.platform !== "win32") fs.chmodSync(path.join(depot, "scripts", "run-e2e.sh"), 0o755);
  for (const [relatif, contenu] of Object.entries(fichiers)) ecrire(relatif, contenu);
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: depot, env, encoding: "utf8", timeout: 30_000 });
    assert.equal(r.status, 0, `git ${args.join(" ")} : ${r.stderr}`);
    return r.stdout;
  };
  git("init", "-q");
  fs.mkdirSync(path.join(depot, ".git", "info"), { recursive: true });
  fs.appendFileSync(path.join(depot, ".git", "info", "exclude"), "MARQUEUR-DEPOT\n");
  ecrire("MARQUEUR-DEPOT", "le dépôt, jamais la copie\n");
  git("add", "-A");
  git("commit", "-q", "-m", "départ");
  assert.equal(git("status", "--porcelain=v1"), "", "le dépôt jetable doit partir propre");
  return { racine, depot, trace: path.join(racine, "trace-banc.txt"), env, bash };
}

/** Joue le bloc du README depuis le dépôt, avec le $TEMP donné. */
function jouer(banc: Banc, temp: string): SpawnSyncReturns<string> {
  const script = path.join(banc.racine, "ouverture.sh");
  fs.writeFileSync(script, blocDOuverture());
  return spawnSync(banc.bash, [pourBash(script)], {
    cwd: banc.depot,
    env: { ...banc.env, TEMP: pourBash(temp), TRACE_BANC: pourBash(banc.trace) },
    encoding: "utf8",
    timeout: 120_000,
  });
}

/** Le dépôt n'a pas bougé : constante fermée, à l'octet, et aucun changement vu par git. */
function depotIntact(banc: Banc): void {
  assert.equal(fs.readFileSync(path.join(banc.depot, "app", "server", "wiring-eq.ts"), "utf8"), WIRING, "la constante DU DÉPÔT a été basculée");
  const statut = spawnSync("git", ["status", "--porcelain=v1"], { cwd: banc.depot, env: banc.env, encoding: "utf8" });
  assert.equal(statut.stdout, "", `le dépôt a changé : ${statut.stdout}`);
}

describe("procédure d'ouverture en une ligne (e2e/README.md) : jamais dans le dépôt, arrêt au premier échec", () => {
  it("forme : sous-shell arrêté au premier échec, copie NEUVE supprimée à la sortie, rien sur le dossier courant", () => {
    const bloc = blocDOuverture();
    const lignes = bloc.split("\n").map((ligne) => ligne.trim()).filter((ligne) => ligne !== "");
    assert.equal(lignes[0], "( set -euo pipefail");
    assert.equal(lignes.at(-1), ")");
    assert.match(bloc, /copie="\$\(mktemp -d "\$\{TEMP:-\$\{TMPDIR:-\/tmp\}\}\/c511-ouverture-u1\.XXXXXX"\)"/);
    assert.match(bloc, /trap '[^']*rm -rf -- "\$copie"' EXIT/);
    // Chaque contrôle PARLE quand il échoue : un `test` nu échouerait en silence hors d'un `set -e`.
    for (const ligne of lignes.filter((l) => l.startsWith("test "))) assert.match(ligne, /\|\| \{ echo "[^"]+" >&2; exit 1; \}$/, ligne);
    // Aucun git sans `-C` (hors la lecture qui TROUVE le dépôt), aucun sed hors de la copie, et le seul `cd` va dans la copie,
    // après les contrôles.
    assert.match(bloc, /depot="\$\(git rev-parse --show-toplevel\)"/);
    for (const m of bloc.matchAll(/\bgit (?!-C |rev-parse --show-toplevel\))(\S+)/g)) assert.fail(`git sans -C : « git ${m[1]} »`);
    assert.match(bloc, /sed -i '[^']+' "\$copie\/app\/server\/wiring-eq\.ts"/);
    const cd = lignes.filter((l) => /^cd\b/.test(l));
    assert.deepEqual(cd, ['cd "$copie"']);
    const derniereVerification = lignes.findLastIndex((l) => l.startsWith("test "));
    assert.ok(lignes.indexOf('cd "$copie"') > derniereVerification, "le banc part de la copie seulement après les contrôles");
    assert.match(bloc, /test "\$\(git -C "\$depot" status --porcelain=v1\)" = "\$etat_depot"/);
  });

  it("chemin nominal : le banc part d'une copie neuve, constante ouverte ; le dépôt n'a pas bougé ; la copie est supprimée", (t) => {
    const banc = preparer(t);
    if (!banc) return;
    const temp = path.join(banc.racine, "tmp");
    fs.mkdirSync(temp);
    const r = jouer(banc, temp);
    assert.equal(r.status, 0, `procédure en échec : ${r.stderr}`);
    const [ou, ligne, args] = fs.readFileSync(banc.trace, "utf8").split("\n");
    assert.equal(ou, "copie", "le banc est parti du dépôt");
    assert.equal(ligne, LIGNE_OUVERTE);
    assert.equal(args, "--faux --scenarios c5b-demonstration --project-prefix c511-e2e --image-tag c511");
    depotIntact(banc);
    assert.deepEqual(fs.readdirSync(temp), [], "la copie jetable n'a pas été supprimée");
  });

  it("dossier de la copie impossible à créer (parent absent) : échec, le dépôt reste fermé, le banc ne part pas", (t) => {
    const banc = preparer(t);
    if (!banc) return;
    const r = jouer(banc, path.join(banc.racine, "absent", "sous-dossier"));
    // Le dommage d'abord (constante du dépôt basculée, banc parti du dépôt), puis le code de sortie.
    depotIntact(banc);
    assert.equal(fs.existsSync(banc.trace), false, `le banc est parti : ${fs.existsSync(banc.trace) ? fs.readFileSync(banc.trace, "utf8") : ""}`);
    assert.notEqual(r.status, 0, "la procédure a réussi sans copie");
  });

  it("copie différente de la tête : l'échec est DIT, le banc ne part pas, la copie est supprimée", (t) => {
    // `export-ignore` : `git archive` n'emporte pas ce fichier, la copie n'est donc pas la tête.
    const banc = preparer(t, { ".gitattributes": "absent-de-l-archive.txt export-ignore\n", "absent-de-l-archive.txt": "suivi, non archivé\n" });
    if (!banc) return;
    const temp = path.join(banc.racine, "tmp");
    fs.mkdirSync(temp);
    const r = jouer(banc, temp);
    assert.equal(fs.existsSync(banc.trace), false, "le banc est parti d'une copie qui n'est pas la tête");
    assert.notEqual(r.status, 0, "une copie qui n'est pas la tête a été acceptée");
    assert.match(r.stderr, /copie différente de la tête/);
    depotIntact(banc);
    assert.deepEqual(fs.readdirSync(temp), [], "la copie jetable n'a pas été supprimée");
  });
});
