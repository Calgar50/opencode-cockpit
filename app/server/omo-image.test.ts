// Tests L15a : image opencode-omo LUE, jamais construite (P13 ; spéc. §3.15.1 ; plan, fiche L15a ; D-2b-32, D-2b-33, D-2b-36).
//
// - Dockerfile : base épinglée par empreinte, `npm ci --ignore-scripts`, extension à root sans écriture, aucun `USER node`,
//   licence copiée, cinq dossiers de configuration du HOME vides à root, copies aux chemins EXACTS de `contrat-salle.json`,
//   référence du manifeste hors périmètre, variables de l'image, entrée tini + superviseur, validation à la construction.
// - `manifest.sh` : périmètre = contrat ; calculé sur une arborescence jetable quand un shell POSIX et les outils GNU sont là
//   (CI Linux ; sous Windows avec Git Bash), sauté avec raison sinon.
// - Configurations : `.env.example` jamais refusé, `.env*` et fichiers de clés refusés (portage d'opencode du cockpit,
//   indépendant du validateur), `snapshot: false`, G3 statique (IA `github-copilot/*` partout, déclarées, tarifées et
//   recommandées par le cockpit), noms d'`omo.jsonc` ⊆ énumérations de L20 et chaque « couper » appliqué (croisement de V1).
// Aucun test ne construit, ne télécharge ni ne charge l'image ou l'extension.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import * as salle from "../../docker/opencode-omo/supervisor-lib.mjs";
import { CATEGORIES_4_19_4, MOTIFS_REFUSES_EXIGES, type OmoEnumerationsLues, lireJsonc } from "../../docker/opencode-omo/validate-core.mjs";
import { OMO_SALLE_CONTRACT_FILE } from "./omo-contracts.ts";
import { COPILOT_PRICES } from "./pricing.ts";
import { DEFAULT_TIERS, KEY_FILE_READ_RULES, effectiveAgentRules, evaluate, rulesFromConfig } from "./shared/assistant-rules.ts";
import { SONDES_FICHIERS_DE_CLES } from "./shared/omo-audit-4.19.4.ts";
import { EXTENSIONS_CLE_P03 } from "./shared/omo-precheck-rules.ts";
import type { OmoSalleContract } from "./shared/omo-types.ts";

const RACINE_DEPOT = path.join(import.meta.dirname, "..", "..");
const DOCKER_OMO = path.join(RACINE_DEPOT, "docker", "opencode-omo");
const lire = (nom: string): string => fs.readFileSync(path.join(DOCKER_OMO, nom), "utf8");
const CONTRAT = JSON.parse(fs.readFileSync(path.join(RACINE_DEPOT, OMO_SALLE_CONTRACT_FILE), "utf8")) as OmoSalleContract;
const IMG = CONTRAT.cheminsImage;
const ENUMS = JSON.parse(lire("enums-4.19.4.json")) as OmoEnumerationsLues;

type Json = Record<string, unknown>;
const objet = (v: unknown): Json => v as Json;

// --- Lecture du Dockerfile ------------------------------------------------------------------------------------------------------

interface Instruction {
  cmd: string;
  args: string;
}

/** Instructions du Dockerfile : lignes jointes aux « \ » de fin, commentaires retirés (y compris dans une suite, comme Docker). */
function lireDockerfile(texte: string): Instruction[] {
  const instructions: Instruction[] = [];
  let courante: Instruction | null = null;
  for (const brute of texte.split("\n")) {
    const ligne = brute.replace(/\r$/, "");
    if (/^\s*#/.test(ligne) || (courante === null && ligne.trim() === "")) continue;
    let reste = ligne;
    if (courante === null) {
      const m = /^\s*([A-Za-z]+)\s*(.*)$/.exec(ligne);
      assert.ok(m, `instruction illisible : ${ligne}`);
      courante = { cmd: (m[1] ?? "").toUpperCase(), args: "" };
      reste = m[2] ?? "";
    }
    if (reste.endsWith("\\")) {
      courante.args += `${reste.slice(0, -1).trim()} `;
    } else {
      courante.args = `${courante.args}${reste.trim()}`.trim();
      instructions.push(courante);
      courante = null;
    }
  }
  assert.equal(courante, null, "instruction non terminée à la fin du Dockerfile");
  return instructions;
}

const DOCKERFILE = lireDockerfile(lire("Dockerfile"));
const runs = () => DOCKERFILE.filter((i) => i.cmd === "RUN").map((i) => i.args);
const runAvec = (extrait: string): string[] => runs().filter((r) => r.includes(extrait));

/** Copies du Dockerfile : destination de chaque fichier → source dans le contexte (docker/opencode-omo). */
function copies(instructions: Instruction[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const { cmd, args } of instructions) {
    if (cmd !== "COPY") continue;
    const mots = args.split(/\s+/).filter((m) => !m.startsWith("--"));
    const dest = mots.pop() ?? "";
    assert.ok(mots.length > 0, `COPY sans source : ${args}`);
    if (dest.endsWith("/")) for (const source of mots) map.set(`${dest}${path.posix.basename(source)}`, source);
    else {
      assert.equal(mots.length, 1, `COPY vers un fichier avec plusieurs sources : ${args}`);
      map.set(dest, mots[0] ?? "");
    }
  }
  return map;
}

/** Variables posées par ENV (forme clé=valeur). */
function variables(instructions: Instruction[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const { cmd, args } of instructions) {
    if (cmd !== "ENV") continue;
    for (const paire of args.split(/\s+/)) {
      const k = paire.indexOf("=");
      assert.ok(k > 0, `ENV sans « = » : ${paire}`);
      map.set(paire.slice(0, k), paire.slice(k + 1));
    }
  }
  return map;
}

// --- Dockerfile ---------------------------------------------------------------------------------------------------------------

describe("image opencode-omo : Dockerfile (lu, jamais construit)", () => {
  it("base : l'image opencode du cockpit épinglée par empreinte, sans valeur par défaut", () => {
    assert.deepEqual(DOCKERFILE[0], { cmd: "ARG", args: "OPENCODE_BASE" });
    const froms = DOCKERFILE.filter((i) => i.cmd === "FROM");
    assert.deepEqual(froms, [{ cmd: "FROM", args: "${OPENCODE_BASE}" }]);
    const indexFrom = DOCKERFILE.findIndex((i) => i.cmd === "FROM");
    assert.ok(DOCKERFILE.slice(indexFrom + 1).some((i) => i.cmd === "ARG" && i.args === "OPENCODE_BASE"), "ARG redéclaré après FROM");
    const verif = runAvec("OPENCODE_BASE##*@sha256:");
    assert.ok(verif.length >= 1, "contrôle de l'empreinte de la base");
    assert.ok(verif.some((r) => r.includes('case "$OPENCODE_BASE" in *@sha256:*) ;;') && r.includes("grep -Eq '^[0-9a-f]{64}$'")));
  });

  it("utilisateur node d'uid et gid 1000 exigé : celui que le superviseur suppose (UID_NODE)", () => {
    assert.equal(salle.UID_NODE, 1000);
    assert.equal(runAvec('test "$(id -u node)" = 1000 && test "$(id -g node)" = 1000').length, 1);
    const outils = runAvec("for outil in tini setpriv node npm find sha256sum sed sort; do");
    assert.equal(outils.length, 1, "outils du superviseur vérifiés dans la base");
  });

  it("extension : npm ci sans script, sans audit réseau ni dépendance de développement ; aucune autre installation", () => {
    const npm = runAvec("npm ci");
    assert.equal(npm.length, 1);
    for (const option of ["--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev"]) assert.ok(npm[0]?.includes(option), option);
    assert.ok(npm[0]?.includes("cd /opt/omo;"), "npm ci dans /opt/omo");
    const tout = DOCKERFILE.map((i) => `${i.cmd} ${i.args}`).join("\n");
    for (const interdit of [/\bnpm (?:install|i|add|update)\b/, /\bnpx\b/, /\byarn\b/, /\bpnpm\b/, /\bbun\b/, /\bcurl\b/, /\bwget\b/, /https?:\/\//]) {
      assert.doesNotMatch(tout, interdit);
    }
    assert.ok(!DOCKERFILE.some((i) => i.cmd === "ADD"), "aucun ADD");
  });

  it("extension à root, sans aucun droit d'écriture ; licence copiée dans l'image (G11)", () => {
    const npm = runAvec("npm ci")[0] ?? "";
    assert.match(npm, /chown -R root:root \/opt\/omo /);
    assert.match(npm, /chmod -R a\+rX,a-w \/opt\/omo /);
    assert.ok(npm.includes(`cp ${IMG.extension}/node_modules/oh-my-openagent/LICENSE.md ${IMG.licence};`), "licence copiée au chemin du contrat");
    assert.ok(npm.indexOf("npm ci") < npm.indexOf("chown -R root:root"), "droits posés après l'installation");
  });

  it("l'image finit en root : aucun USER node (le superviseur bascule lui-même vers node)", () => {
    const users = DOCKERFILE.filter((i) => i.cmd === "USER").map((i) => i.args);
    assert.ok(users.length >= 1);
    assert.deepEqual(new Set(users), new Set(["root"]));
    assert.equal(DOCKERFILE.findLast((i) => i.cmd === "USER")?.args, "root");
  });

  it("cinq dossiers de configuration du HOME : vidés, recréés, à root (D-2b-33)", () => {
    const boucle = runAvec(`for d in ${CONTRAT.dossiersConfigHome.join(" ")}; do`);
    assert.equal(boucle.length, 1, "une boucle sur exactement les dossiers du contrat");
    const r = boucle[0] ?? "";
    const etapes = ['rm -rf "$d";', 'mkdir -p "$d";', 'chown root:root "$d";', 'chmod 0755 "$d";'];
    const positions = etapes.map((e) => r.indexOf(e));
    assert.ok(positions.every((p) => p >= 0), `étapes présentes : ${etapes.join(" ")}`);
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, "vider, recréer, puis donner à root");
    assert.equal(CONTRAT.dossiersConfigHome.length, 5);
  });

  it("copies aux chemins EXACTS du contrat, et aucune autre", () => {
    const attendu = new Map<string, string>([
      [IMG.superviseur, "supervisor.sh"],
      [IMG.superviseurLib, "supervisor-lib.mjs"],
      [IMG.valider, "validate.mjs"],
      [IMG.validerCoeur, "validate-core.mjs"],
      [IMG.enumerations, "enums-4.19.4.json"],
      [IMG.manifeste, "manifest.sh"],
      [IMG.garde, "guard/cockpit-guard.js"],
      [IMG.referenceManifeste, "omo-manifest.sha256"],
      [`${IMG.configuration}/opencode.jsonc`, "opencode.jsonc"],
      [`${IMG.configuration}/omo/omo.jsonc`, "omo.jsonc"],
      [`${IMG.extension}/package.json`, "package.json"],
      [`${IMG.extension}/package-lock.json`, "package-lock.json"],
    ]);
    assert.deepEqual(new Map([...copies(DOCKERFILE)].sort()), new Map([...attendu].sort()));
    // Chemins écrits par la construction elle-même : identifiant, licence.
    assert.equal(runAvec(`> ${IMG.imageId};`).length, 1, "identifiant de construction au chemin du contrat");
    assert.equal(runAvec(IMG.licence).length, 1);
  });

  it("sources des copies présentes dans le contexte (le filet de L24, même vague, dès que guard/ existe)", () => {
    for (const source of copies(DOCKERFILE).values()) {
      const chemin = path.join(DOCKER_OMO, ...source.split("/"));
      if (source.startsWith("guard/") && !fs.existsSync(path.join(DOCKER_OMO, "guard"))) continue;
      assert.ok(fs.existsSync(chemin), `source absente : ${source}`);
    }
  });

  it("référence du manifeste HORS du périmètre haché ; périmètre du superviseur = contrat (D-2b-32)", () => {
    const dans = (chemin: string, racine: string) => chemin === racine || chemin.startsWith(`${racine}/`);
    assert.ok(!CONTRAT.perimetreManifeste.some((p) => dans(IMG.referenceManifeste, p)), "référence hors périmètre");
    for (const cle of ["superviseur", "superviseurLib", "valider", "validerCoeur", "enumerations", "manifeste", "garde", "configuration", "imageId", "extension"] as const) {
      assert.ok(CONTRAT.perimetreManifeste.some((p) => dans(IMG[cle], p)), `${cle} dans le périmètre`);
    }
    const sousReference = [...copies(DOCKERFILE).keys()].filter((d) => d.startsWith(`${path.posix.dirname(IMG.referenceManifeste)}/`));
    assert.deepEqual(sousReference, [IMG.referenceManifeste]);
    assert.deepEqual([...salle.PERIMETRE_MANIFESTE], CONTRAT.perimetreManifeste);
  });

  it("identifiant de construction sans date : deux constructions identiques donnent le même manifeste", () => {
    const r = runAvec(`> ${IMG.imageId};`)[0] ?? "";
    assert.doesNotMatch(r, /\bdate\b|\$RANDOM|uuid/);
    assert.ok(r.includes("sha256sum /opt/omo/package-lock.json"));
  });

  it("dossier de configuration : .gitignore posé d'avance (opencode ne sait pas ignorer un refus EROFS)", () => {
    assert.equal(runAvec(`> ${IMG.configuration}/.gitignore;`).length, 1);
  });

  it("périmètre à root, sans écriture ; superviseur et calcul du manifeste exécutables", () => {
    const r = runAvec(`> ${IMG.imageId};`)[0] ?? "";
    for (const chemin of ["/etc/opencode-omo", "/opt/omo-check", "/opt/omo-guard", "/etc/omo-reference"]) {
      assert.ok(r.includes(`chmod -R a+rX,a-w`) && r.includes(chemin), chemin);
    }
    assert.ok(r.includes(`chown -R root:root /etc/opencode-omo /opt/omo-check /opt/omo-guard /etc/omo-reference ${IMG.superviseur};`));
    assert.ok(r.includes(`chmod 0555 ${IMG.superviseur} ${IMG.manifeste}`));
  });

  it("variables de l'image (spéc. l.485)", () => {
    assert.deepEqual(
      variables(DOCKERFILE),
      new Map([
        ["OMO_DISABLE_POSTHOG", "1"],
        ["OMO_SEND_ANONYMOUS_TELEMETRY", "0"],
        ["OPENCODE_DISABLE_CLAUDE_CODE", "1"],
        ["OPENCODE_DISABLE_PROJECT_CONFIG", "1"],
        ["GIT_EDITOR", ":"],
        ["GIT_PAGER", "cat"],
        ["OPENCODE_CONFIG_DIR", IMG.configuration],
      ]),
    );
  });

  it("entrée : tini, puis le superviseur du contrat ; aucune commande par défaut", () => {
    const entrees = DOCKERFILE.filter((i) => i.cmd === "ENTRYPOINT");
    assert.equal(entrees.length, 1);
    assert.deepEqual(JSON.parse(entrees[0]?.args ?? "null"), ["tini", "--", IMG.superviseur]);
    assert.ok(!DOCKERFILE.some((i) => i.cmd === "CMD"));
  });

  it("validation à la construction, après toutes les copies : une configuration fausse fait échouer la construction (G14)", () => {
    const index = DOCKERFILE.findIndex((i) => i.cmd === "RUN" && i.args === `node ${IMG.valider} --construction`);
    assert.ok(index >= 0, "RUN node <valider> --construction");
    const derniereCopie = DOCKERFILE.findLastIndex((i) => i.cmd === "COPY");
    const dernierRun = DOCKERFILE.findLastIndex((i) => i.cmd === "RUN");
    assert.ok(index > derniereCopie && index === dernierRun, "après la dernière copie et le dernier changement de fichier");
  });
});

// --- manifest.sh ---------------------------------------------------------------------------------------------------------------

describe("image opencode-omo : manifest.sh", () => {
  const texte = lire("manifest.sh");

  it("périmètre = contrat, ASCII, shell POSIX, sortie triée, arrêt au moindre échec", () => {
    const ligne = /^PERIMETRE="([^"]*)"$/m.exec(texte);
    assert.ok(ligne, "ligne PERIMETRE");
    assert.deepEqual((ligne[1] ?? "").split(" "), CONTRAT.perimetreManifeste);
    assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(texte), "ASCII pur");
    assert.ok(texte.startsWith("#!/bin/sh\n"));
    for (const extrait of ["set -eu", "LC_ALL=C", "| sort", "|| exit 1", "|| return 1", "-exec sha256sum -- {} +"]) assert.ok(texte.includes(extrait), extrait);
  });

  // Sous Windows, chaque processus de Git Bash coûte des secondes (≈ 17 s pour ce bloc) : le calcul réel est exigé en CI Linux,
  // où il prend quelques dizaines de millisecondes (plan §2.1 : ≈ 10 s au plus par paquet).
  const outils =
    process.platform === "win32"
      ? null
      : spawnSync("sh", ["-c", "find . -maxdepth 0 -printf ok && command -v sha256sum >/dev/null && command -v sort >/dev/null"], { encoding: "utf8" });
  const raison =
    outils === null ? "Windows : processus de Git Bash trop lents, calcul réel exigé en CI Linux" : outils.status === 0 && outils.stdout === "ok" ? null : "sh, find de GNU ou sha256sum absents (exigés en CI Linux)";

  it("calcul sur une arborescence jetable : stable, trié, chemins de l'image, sensible au contenu et aux droits", { skip: raison ?? false }, (t) => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "omo-l15a-manifeste-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const poser = (chemin: string, contenu: string) => {
      const ici = path.join(dir, ...chemin.split("/").filter(Boolean));
      fs.mkdirSync(path.dirname(ici), { recursive: true });
      fs.writeFileSync(ici, contenu);
    };
    for (const p of CONTRAT.perimetreManifeste) {
      if (p === IMG.superviseur) poser(p, "#!/bin/sh\n");
      else poser(`${p}/fichier avec espace.txt`, `contenu de ${p}\n`);
    }
    poser(`${IMG.extension}/node_modules/x/index.js`, "a\n");
    const calcul = (...args: string[]) => spawnSync("sh", [path.join(DOCKER_OMO, "manifest.sh"), ...args], { encoding: "utf8" });
    const base = calcul("--racine", dir);
    assert.equal(base.status, 0, base.stderr);
    const lignes = base.stdout.trimEnd().split("\n");
    assert.deepEqual(calcul("--racine", dir).stdout, base.stdout, "deux calculs identiques");
    assert.deepEqual([...lignes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), lignes, "sortie triée");
    assert.ok(!lignes.includes(""), "aucune ligne vide");
    assert.ok(lignes.some((l) => /^[0-9a-f]{64} {2}\/opt\/omo\/node_modules\/x\/index\.js$/.test(l)), "empreinte au format sha256sum, chemin de l'image");
    assert.ok(lignes.some((l) => /^meta f [0-7]+ \d+:\d+ \/usr\/local\/bin\/omo-supervisor$/.test(l)), "superviseur dans le manifeste");
    assert.ok(lignes.some((l) => /^meta d [0-7]+ \d+:\d+ \/etc\/opencode-omo$/.test(l)), "racine d'un dossier du périmètre");
    assert.ok(!base.stdout.includes(dir) && !base.stdout.includes(" ./"), "aucun chemin de l'hôte ni chemin relatif");
    assert.ok(!base.stdout.includes("omo-reference"), "référence hors périmètre");

    poser(`${IMG.extension}/node_modules/x/index.js`, "b\n");
    assert.notEqual(calcul("--racine", dir).stdout, base.stdout, "un octet changé change le manifeste");
    poser(`${IMG.extension}/node_modules/x/index.js`, "a\n");
    poser(`${IMG.configuration}/ajout.json`, "{}");
    assert.notEqual(calcul("--racine", dir).stdout, base.stdout, "un fichier ajouté change le manifeste");
    fs.rmSync(path.join(dir, "etc", "opencode-omo", "ajout.json"));
    const cible = path.join(dir, "opt", "omo", "node_modules", "x", "index.js");
    const droits = fs.statSync(cible).mode & 0o777;
    fs.chmodSync(cible, droits ^ 0o020);
    assert.notEqual(calcul("--racine", dir).stdout, base.stdout, "un droit d'écriture ajouté change le manifeste");
    fs.chmodSync(cible, droits);
    assert.equal(calcul("--racine", dir).stdout, base.stdout, "droits rétablis : manifeste d'origine");

    fs.rmSync(path.join(dir, "opt", "omo-guard"), { recursive: true });
    const absent = calcul("--racine", dir);
    assert.notEqual(absent.status, 0, "chemin du périmètre absent : échec");
    assert.equal(absent.stdout, "", "aucun manifeste partiel");
    assert.match(absent.stderr, /chemin du perimetre absent : \/opt\/omo-guard/);

    assert.equal(calcul("--racine").status, 2, "usage");
    assert.equal(calcul("--autre", dir).status, 2, "usage");
  });

  it("lien à la place d'un chemin du périmètre, fichier illisible : échec sans sortie", { skip: raison ?? false }, (t) => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "omo-l15a-manifeste-"));
    t.after(() => {
      fs.chmodSync(path.join(dir, "opt", "omo-check", "x.mjs"), 0o644);
      fs.rmSync(dir, { recursive: true, force: true });
    });
    for (const p of CONTRAT.perimetreManifeste) {
      const ici = path.join(dir, ...p.split("/").filter(Boolean));
      if (p === IMG.superviseur) {
        fs.mkdirSync(path.dirname(ici), { recursive: true });
        fs.writeFileSync(ici, "#!/bin/sh\n");
      } else {
        fs.mkdirSync(ici, { recursive: true });
        fs.writeFileSync(path.join(ici, "x.mjs"), "x\n");
      }
    }
    const calcul = () => spawnSync("sh", [path.join(DOCKER_OMO, "manifest.sh"), "--racine", dir], { encoding: "utf8" });
    assert.equal(calcul().status, 0);
    fs.renameSync(path.join(dir, "opt", "omo-guard"), path.join(dir, "opt", "omo-guard-vrai"));
    fs.symlinkSync("omo-guard-vrai", path.join(dir, "opt", "omo-guard"));
    const lien = calcul();
    assert.notEqual(lien.status, 0);
    assert.equal(lien.stdout, "");
    fs.rmSync(path.join(dir, "opt", "omo-guard"));
    fs.renameSync(path.join(dir, "opt", "omo-guard-vrai"), path.join(dir, "opt", "omo-guard"));
    fs.chmodSync(path.join(dir, "opt", "omo-check", "x.mjs"), 0o000);
    const illisible = calcul();
    if (process.getuid?.() === 0) {
      t.diagnostic("root lit tout : cas du fichier illisible non éprouvable ici");
      return;
    }
    assert.notEqual(illisible.status, 0);
    assert.equal(illisible.stdout, "");
  });
});

// --- Configurations ---------------------------------------------------------------------------------------------------------------

describe("configurations de la salle : opencode.jsonc", () => {
  const config = lireJsonc(lire("opencode.jsonc")) as Json;
  const permission = objet(config.permission);
  const FICHIERS = ["read", "edit", "grep", "glob", "list"] as const;
  const regles = (cle: string) => rulesFromConfig({ [cle]: permission[cle] });

  it("coupures d'instance : snapshot, lsp, formatter, partage, mise à jour (D-2b-36)", () => {
    assert.equal(config.snapshot, false);
    assert.equal(config.lsp, false);
    assert.equal(config.formatter, false);
    assert.equal(config.share, "disabled");
    assert.equal(config.autoupdate, false);
    assert.deepEqual(config.enabled_providers, ["github-copilot"]);
  });

  it(".env.example n'est jamais refusé, sur aucune permission de fichiers (portage d'opencode du cockpit)", () => {
    for (const cle of FICHIERS) {
      for (const chemin of [".env.example", "app/.env.example", "/workspace/projet/.env.example"]) {
        assert.notEqual(evaluate(regles(cle), cle, chemin), "deny", `${cle} ${chemin}`);
      }
    }
  });

  it(".env* et fichiers de clés refusés en lecture, modification, recherche et liste", () => {
    const sondes = [
      ".env",
      ".env.local",
      ".envrc",
      "app/.env.production",
      "config/prod.env",
      "certs/serveur.key",
      "certs/SERVEUR.KEY",
      "certs/serveur.pfx",
      ".ssh/id_ed25519",
      ".kube/config",
      "kubeconfig.yaml",
      "certs/privkey.pem",
      ...EXTENSIONS_CLE_P03.flatMap((ext) => [`a/b.${ext}`, `a/B.${ext.toUpperCase()}`]),
    ];
    for (const cle of FICHIERS) {
      for (const chemin of sondes) assert.equal(evaluate(regles(cle), cle, chemin), "deny", `${cle} ${chemin}`);
    }
    // Sondes de la porte G12 (L20) : règles EFFECTIVES d'un agent (défauts d'opencode, puis instance).
    const effectives = effectiveAgentRules(permission, {});
    for (const cle of ["read", "edit"]) {
      for (const sonde of SONDES_FICHIERS_DE_CLES) assert.equal(evaluate(effectives, cle, sonde), "deny", `${cle} ${sonde}`);
    }
  });

  it("motifs refusés ⊇ motifs du cockpit (KEY_FILE_READ_RULES, P03) ; le validateur les exige tous", () => {
    const cockpit = [
      ...Object.entries(KEY_FILE_READ_RULES)
        .filter(([, action]) => action !== "allow")
        .map(([motif]) => motif),
      ...EXTENSIONS_CLE_P03.flatMap((ext) => [`*.${ext}`, `*.${ext.toUpperCase()}`]),
      ".env*",
      "*/.env*",
    ];
    for (const motif of cockpit) {
      assert.ok(MOTIFS_REFUSES_EXIGES.includes(motif), `exigé par le validateur : ${motif}`);
      for (const cle of FICHIERS) assert.equal(objet(permission[cle])[motif], "deny", `${cle} ${motif}`);
    }
  });

  it("webfetch, websearch, external_directory refusés explicitement ; edit, bash, task demandés", () => {
    assert.equal(permission.webfetch, "deny");
    assert.equal(permission.websearch, "deny");
    assert.equal(permission.external_directory, "deny");
    assert.equal(permission.bash, "ask");
    assert.equal(permission.task, "ask");
    assert.equal(evaluate(regles("edit"), "edit", "src/index.ts"), "ask");
  });

  it("adresse Copilot par la variable du contrat, aucun secret dans les options (MO-6)", () => {
    const copilot = objet(objet(config.provider)["github-copilot"]);
    assert.deepEqual(copilot.options, { baseURL: "{env:COCKPIT_COPILOT_API_URL}" });
    assert.ok(CONTRAT.variables.salle.includes("COCKPIT_COPILOT_API_URL"));
    assert.deepEqual(Object.keys(objet(config.provider)), ["github-copilot"]);
  });

  it("greffons : l'extension, puis le filet du cockpit, aux chemins du contrat", () => {
    assert.deepEqual(config.plugin, [`file://${IMG.extension}/node_modules/oh-my-openagent/dist/index.js`, `file://${IMG.garde}`]);
  });
});

describe("configurations de la salle : omo.jsonc et G3 statique", () => {
  const omo = lireJsonc(lire("omo.jsonc")) as Json;
  const opencode = lireJsonc(lire("opencode.jsonc")) as Json;

  it("noms ⊆ énumérations de L20 et chaque décision « couper » appliquée (croisement de V1)", () => {
    const paires = [
      ["disabled_hooks", ENUMS.hooks, ENUMS.hooksCoupes],
      ["disabled_tools", ENUMS.outils, ENUMS.outilsCoupes],
      ["disabled_mcps", ENUMS.mcps, ENUMS.mcpsCoupes],
      ["disabled_skills", ENUMS.competences, ENUMS.competencesCoupees],
      ["disabled_commands", ENUMS.commandes, ENUMS.commandesCoupees],
      ["disabled_agents", ENUMS.agents, ENUMS.agentsCoupes],
      ["disabled_providers", ENUMS.fournisseursCoupes, ENUMS.fournisseursCoupes],
    ] as const;
    for (const [cle, enumeres, coupes] of paires) {
      const noms = omo[cle] as string[];
      for (const nom of noms) assert.ok(enumeres.includes(nom), `${cle} : ${nom} hors énumération`);
      assert.deepEqual(new Set(noms), new Set(coupes), cle);
    }
    for (const cle of Object.keys(omo)) assert.ok(ENUMS.cles.includes(cle), `clé ${cle} hors énumération`);
    assert.deepEqual(Object.keys(objet(omo.agents)).sort(), [...ENUMS.agents].sort());
    assert.deepEqual(Object.keys(objet(omo.categories)).sort(), [...CATEGORIES_4_19_4].sort());
  });

  it("ralph-loop : absent (pas un hook de la 4.19.4) ; la boucle est coupée par goal (décision du 19/09)", () => {
    assert.ok(!(omo.disabled_hooks as string[]).includes("ralph-loop"));
    assert.ok((omo.disabled_hooks as string[]).includes("goal"));
    assert.ok(!Object.hasOwn(omo, "ralph_loop"));
    assert.deepEqual(omo.goal, { enabled: false, auto_start: false });
    for (const nom of ["directory-agents-injector", "rules-injector", "non-interactive-env", "auto-update-checker", "claude-code-hooks", "runtime-fallback", "model-fallback"]) {
      assert.ok((omo.disabled_hooks as string[]).includes(nom), nom);
    }
    for (const garde of ["keyword-detector", "atlas", "start-work", "todo-continuation-enforcer"]) assert.ok(!(omo.disabled_hooks as string[]).includes(garde), garde);
  });

  it("G3 statique : chaque IA est github-copilot/*, déclarée dans l'instance, tarifée et recommandée par le cockpit", () => {
    const modeles = [
      ...Object.values(objet(omo.agents)).map((a) => objet(a).model),
      ...Object.values(objet(omo.categories)).map((c) => objet(c).model),
      opencode.model,
      opencode.small_model,
    ];
    assert.equal(modeles.length, ENUMS.agents.length + CATEGORIES_4_19_4.length + 2);
    const declares = Object.keys(objet(objet(objet(opencode.provider)["github-copilot"]).models));
    const recommandes = new Set(Object.values(DEFAULT_TIERS).flatMap((tier) => [...tier.candidates]));
    for (const modele of modeles) {
      assert.equal(typeof modele, "string");
      const id = String(modele);
      assert.ok(id.startsWith("github-copilot/"), id);
      assert.ok(declares.includes(id.slice("github-copilot/".length)), `${id} déclarée`);
      assert.ok(Object.hasOwn(COPILOT_PRICES, id.slice("github-copilot/".length)), `${id} tarifée`);
      assert.ok(recommandes.has(id), `${id} recommandée`);
    }
    for (const id of declares) assert.ok(modeles.includes(`github-copilot/${id}`), `IA déclarée mais inutilisée : ${id}`);
  });

  it("Prometheus : edit demandé, bash et webfetch refusés (JS-3) ; deux tâches de fond au plus", () => {
    assert.deepEqual(objet(objet(omo.agents).prometheus).permission, { edit: "ask", bash: "deny", webfetch: "deny" });
    assert.deepEqual(omo.background_task, { defaultConcurrency: 2 });
    assert.deepEqual(omo.team_mode, { enabled: false, tmux_visualization: false });
    assert.equal(omo.hashline_edit, false);
  });
});
