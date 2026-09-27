// T2 de la migration du web 1.0.x → 1.1.0 (décision A37, fiche MW §6) : server/migrate-oc-config.ts réellement exécuté par node
// sur des dossiers jetables (modèle : deploiement.test.ts), comme dans le conteneur jetable de l'image app. Cas a à g de la fiche.
// Les cas Linux (liens, FIFO, droits, uid) sont dans .github/ci/migration-web-smoke.sh (T8), joué dans un vrai conteneur.
//
// Aussi, sans Docker (T7) : la liste d'options du conteneur jetable est la MÊME dans CockpitTls.ps1 et dans le banc e2e
// (section « mw: » de e2e/lib/docker-e2e.mjs) ; l'option « --volume-1-0-6 » du banc ne migre que la pile qui la demande, et
// casM2 (e2e/scenarios/it1-api-commun.mjs) lit la configuration migrée avec elle, le Prudent 1.0 sans elle.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { migrer } from "./migrate-oc-config.ts";

const SERVER_DIR = import.meta.dirname;
const RACINE = path.join(SERVER_DIR, "..", "..");
const SCRIPT = path.join(SERVER_DIR, "migrate-oc-config.ts");
const FIXTURE_106 = fs.readFileSync(path.join(SERVER_DIR, "test-support", "oc-config-1.0.6.jsonc"));
const MIGRE_106 = Buffer.from(
  FIXTURE_106.toString("utf8").replace('"webfetch": "ask"', '"webfetch": "deny"').replace('"websearch": "ask"', '"websearch": "deny"'),
  "utf8",
);
/** Ligne de verdict (fiche MW §3), telle que CockpitTls.ps1 la confronte (même expression, ancrée). */
const LIGNE =
  /^migration-web etat=(absent|conforme|migre|non-migre|erreur) profil=(prudent|equilibre|autonome|-) fichier=(opencode\.jsonc|opencode\.json|config\.json|-) blocs=(\d{1,4}) restes=(\d{1,4}) sauvegarde=((opencode\.jsonc|opencode\.json|config\.json)\.avant-1\.1\.0|existante|-) raison=([a-z-]{1,24})$/;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-migration-web-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let compteur = 0;
/** Dossier jetable, avec les fichiers donnés (nom → octets ou texte). */
function dossier(fichiers: Record<string, string | Uint8Array> = {}): string {
  const dir = path.join(tmp, `oc-config-${++compteur}`);
  fs.mkdirSync(dir);
  for (const [nom, contenu] of Object.entries(fichiers)) fs.writeFileSync(path.join(dir, nom), contenu);
  return dir;
}
/** Le script, lancé comme dans le conteneur : node --no-warnings server/migrate-oc-config.ts <dossier>. */
function lancer(...args: string[]) {
  const r = spawnSync(process.execPath, ["--no-warnings", SCRIPT, ...args], { encoding: "utf8", timeout: 60_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
const lister = (dir: string) => fs.readdirSync(dir).sort();

describe("T2 : server/migrate-oc-config.ts exécuté par node", () => {
  it("(a) dossier 1.0.6 → ligne exacte, fichier migré, sauvegarde = original, remplacement atomique (nouveau fichier, aucun temporaire)", () => {
    const dir = dossier({ "opencode.jsonc": FIXTURE_106 });
    const avant = fs.statSync(path.join(dir, "opencode.jsonc"), { bigint: true });
    const r = lancer(dir);
    assert.equal(r.stdout, "migration-web etat=migre profil=prudent fichier=opencode.jsonc blocs=1 restes=0 sauvegarde=opencode.jsonc.avant-1.1.0 raison=-\n");
    assert.equal(r.stderr, "");
    assert.equal(r.code, 0);
    assert.deepEqual(fs.readFileSync(path.join(dir, "opencode.jsonc.avant-1.1.0")), FIXTURE_106);
    assert.deepEqual(fs.readFileSync(path.join(dir, "opencode.jsonc")), MIGRE_106);
    assert.deepEqual(lister(dir), ["opencode.jsonc", "opencode.jsonc.avant-1.1.0"], "aucun temporaire laissé");
    const apres = fs.statSync(path.join(dir, "opencode.jsonc"), { bigint: true });
    assert.notEqual(apres.ino, avant.ino, "écrit à côté puis renommé, jamais réécrit sur place");
    if (process.platform !== "win32") {
      assert.equal(Number(apres.mode & 0o7777n), Number(avant.mode & 0o7777n), "mode d'origine gardé");
      assert.equal(fs.statSync(path.join(dir, "opencode.jsonc.avant-1.1.0")).mode & 0o7777, Number(avant.mode & 0o7777n));
    }
  });

  it("(b) second passage → conforme ; octets, date de modification et sauvegarde inchangés", () => {
    const dir = dossier({ "opencode.jsonc": FIXTURE_106 });
    assert.equal(lancer(dir).code, 0);
    const fichier = path.join(dir, "opencode.jsonc");
    const sauvegarde = path.join(dir, "opencode.jsonc.avant-1.1.0");
    const avant = { octets: fs.readFileSync(fichier), mtime: fs.statSync(fichier).mtimeMs, sauvegarde: fs.readFileSync(sauvegarde), mtimeS: fs.statSync(sauvegarde).mtimeMs };
    const r = lancer(dir);
    assert.equal(r.stdout, "migration-web etat=conforme profil=- fichier=opencode.jsonc blocs=0 restes=0 sauvegarde=- raison=-\n");
    assert.equal(r.code, 0);
    assert.deepEqual(fs.readFileSync(fichier), avant.octets);
    assert.equal(fs.statSync(fichier).mtimeMs, avant.mtime);
    assert.deepEqual(fs.readFileSync(sauvegarde), avant.sauvegarde);
    assert.equal(fs.statSync(sauvegarde).mtimeMs, avant.mtimeS);
    assert.deepEqual(lister(dir), ["opencode.jsonc", "opencode.jsonc.avant-1.1.0"]);
  });

  it("(c) sauvegarde préexistante (fichier ordinaire) → « existante », jamais écrasée ; le fichier est migré", () => {
    const dir = dossier({ "opencode.jsonc": FIXTURE_106, "opencode.jsonc.avant-1.1.0": "la plus ancienne\n" });
    const r = lancer(dir);
    assert.equal(r.stdout, "migration-web etat=migre profil=prudent fichier=opencode.jsonc blocs=1 restes=0 sauvegarde=existante raison=-\n");
    assert.equal(fs.readFileSync(path.join(dir, "opencode.jsonc.avant-1.1.0"), "utf8"), "la plus ancienne\n");
    assert.deepEqual(fs.readFileSync(path.join(dir, "opencode.jsonc")), MIGRE_106);
  });

  it("(c) dossier au nom de la sauvegarde → sauvegarde-impossible, rien n'est écrit", () => {
    const dir = dossier({ "opencode.jsonc": FIXTURE_106 });
    fs.mkdirSync(path.join(dir, "opencode.jsonc.avant-1.1.0"));
    const r = lancer(dir);
    assert.equal(r.stdout, "migration-web etat=non-migre profil=prudent fichier=opencode.jsonc blocs=0 restes=0 sauvegarde=- raison=sauvegarde-impossible\n");
    assert.equal(r.code, 0);
    assert.deepEqual(fs.readFileSync(path.join(dir, "opencode.jsonc")), FIXTURE_106);
    assert.deepEqual(lister(dir), ["opencode.jsonc", "opencode.jsonc.avant-1.1.0"]);
  });

  it("(d) plus de 1 Mio → trop-gros, rien n'est écrit", () => {
    const gros = Buffer.concat([Buffer.from('{ "permission": { "webfetch": "ask" }, "x": "'), Buffer.alloc(1_048_576, 0x61), Buffer.from('" }')]);
    const dir = dossier({ "opencode.jsonc": gros });
    const r = lancer(dir);
    assert.equal(r.stdout, "migration-web etat=non-migre profil=- fichier=opencode.jsonc blocs=0 restes=0 sauvegarde=- raison=trop-gros\n");
    assert.deepEqual(lister(dir), ["opencode.jsonc"]);
  });

  it("(e) fichier modifié entre l'analyse et l'écriture → modifie-pendant, ni sauvegarde ni écriture", () => {
    const dir = dossier({ "opencode.jsonc": FIXTURE_106 });
    const change = Buffer.from(FIXTURE_106.toString("utf8").replace('"edit": "ask"', '"edit": "allow"'));
    const verdict = migrer(dir, { avantEcriture: () => fs.writeFileSync(path.join(dir, "opencode.jsonc"), change) });
    assert.deepEqual(verdict, { etat: "non-migre", profil: "prudent", fichier: "opencode.jsonc", blocs: 0, restes: 0, sauvegarde: "-", raison: "modifie-pendant" });
    assert.deepEqual(fs.readFileSync(path.join(dir, "opencode.jsonc")), change);
    assert.deepEqual(lister(dir), ["opencode.jsonc"]);
    // Sans modification entre les deux, la même fonction migre (témoin).
    const temoin = dossier({ "opencode.jsonc": FIXTURE_106 });
    assert.equal(migrer(temoin, { avantEcriture: () => {} }).etat, "migre");
  });

  it("(f) stdout tient en UNE ligne au format §3, stderr vide ; ni l'adresse Copilot ni la clé factice, même pour un fichier illisible", () => {
    const secrets = ["https://api.business.githubcopilot.com", "cle-factice-a-ne-jamais-afficher"];
    const fournisseur = `"provider": { "github-copilot": { "options": { "baseURL": "${secrets[0]}", "apiKey": "${secrets[1]}" } } }`;
    const cas: Array<Record<string, string | Uint8Array>> = [
      { "opencode.jsonc": `{ ${fournisseur}, "permission": { "webfetch": "ask" } }` },
      { "opencode.jsonc": `{ ${fournisseur}, "permission": { "webfetch": ` },
      { "opencode.json": `{ ${fournisseur}, "permission": "ask", "permission": "allow" }` },
      { "opencode.jsonc": `{ ${fournisseur}, "x": "{env:${secrets[1]}}" }` },
      { "opencode.jsonc": Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`{ ${fournisseur} }`)]) },
      { "opencode.jsonc": Buffer.from([0x7b, 0xff, 0xfe, 0x7d]) },
      {},
    ];
    for (const fichiers of cas) {
      const r = lancer(dossier(fichiers));
      const lignes = r.stdout.split("\n");
      assert.equal(lignes.length, 2, r.stdout);
      assert.equal(lignes[1], "");
      assert.match(lignes[0] ?? "", LIGNE);
      assert.equal(r.stderr, "");
      for (const secret of secrets) assert.equal(r.stdout.includes(secret), false, secret);
    }
  });

  it("(g) argument absent, relatif, en trop ou dossier absent → erreur raison=argument, code 1", () => {
    for (const args of [[], ["oc-config"], [dossier(), "en-trop"], [path.join(tmp, "absent")]]) {
      const r = lancer(...args);
      assert.equal(r.stdout, "migration-web etat=erreur profil=- fichier=- blocs=0 restes=0 sauvegarde=- raison=argument\n", JSON.stringify(args));
      assert.equal(r.stderr, "");
      assert.equal(r.code, 1);
    }
  });

  it("volume neuf → absent, rien d'écrit ; plusieurs fichiers ou fichier hérité « config » → plusieurs-fichiers", () => {
    const vide = dossier();
    assert.equal(lancer(vide).stdout, "migration-web etat=absent profil=- fichier=- blocs=0 restes=0 sauvegarde=- raison=-\n");
    assert.deepEqual(lister(vide), []);
    const cas: Array<Record<string, string | Uint8Array>> = [
      { "opencode.jsonc": FIXTURE_106, "opencode.json": "{}" },
      { "opencode.jsonc": FIXTURE_106, config: "x = 1" },
    ];
    for (const fichiers of cas) {
      const dir = dossier(fichiers);
      assert.equal(lancer(dir).stdout, "migration-web etat=non-migre profil=- fichier=- blocs=0 restes=0 sauvegarde=- raison=plusieurs-fichiers\n");
      assert.deepEqual(fs.readFileSync(path.join(dir, "opencode.jsonc")), FIXTURE_106);
    }
  });

  it("dossier au nom du fichier de configuration → lien-ou-special, jamais parcouru", () => {
    const dir = dossier();
    fs.mkdirSync(path.join(dir, "opencode.jsonc"));
    assert.equal(lancer(dir).stdout, "migration-web etat=non-migre profil=- fichier=opencode.jsonc blocs=0 restes=0 sauvegarde=- raison=lien-ou-special\n");
  });

  it("lien symbolique au nom du fichier (quand le système permet d'en créer) → lien-ou-special, cible intacte", (t) => {
    const dir = dossier({ "cible.jsonc": FIXTURE_106 });
    try {
      fs.symlinkSync(path.join(dir, "cible.jsonc"), path.join(dir, "opencode.jsonc"), "file");
    } catch {
      t.skip("création de lien refusée sur ce poste : le cas est joué par .github/ci/migration-web-smoke.sh (T8)");
      return;
    }
    assert.equal(lancer(dir).stdout, "migration-web etat=non-migre profil=- fichier=opencode.jsonc blocs=0 restes=0 sauvegarde=- raison=lien-ou-special\n");
    assert.deepEqual(fs.readFileSync(path.join(dir, "cible.jsonc")), FIXTURE_106);
    assert.equal(fs.lstatSync(path.join(dir, "opencode.jsonc")).isSymbolicLink(), true);
  });

  it("réglage personnalisé avec un « ask » qui reste : migre, restes compté ; rejeu → conforme avec le même reste", () => {
    const source = '{\n  "permission": { "webfetch": "ask", "*": { "https://*": "ask" }, "websearch": "ask" }\n}\n';
    const dir = dossier({ "opencode.json": source });
    assert.equal(lancer(dir).stdout, "migration-web etat=migre profil=- fichier=opencode.json blocs=1 restes=1 sauvegarde=opencode.json.avant-1.1.0 raison=-\n");
    assert.equal(lancer(dir).stdout, "migration-web etat=conforme profil=- fichier=opencode.json blocs=0 restes=1 sauvegarde=- raison=-\n");
  });
});

// --- T7 sans Docker : une seule liste d'options, et l'option du banc qui ne migre que sa pile ---------------------------------------

interface BancMw {
  argumentsMigration(projet: string, image: string, nom: string): string[];
  etapesVolume106(plan: Record<string, unknown>): Array<{ compose?: string[]; migration?: string }>;
  analyserArguments(argv: string[]): { volume106: boolean; mode: string };
  preparerPlan(options: Record<string, unknown>): Promise<Record<string, unknown>>;
}
interface ScenariosCommuns {
  casM2(nom: string, pile?: unknown): { tools: string[]; retiresParLaPile: string[] };
}
const importer = async <T>(...parts: string[]) => (await import(pathToFileURL(path.join(RACINE, ...parts)).href)) as T;

/** Liste d'options de Get-CockpitWebMigrationArgs (CockpitTls.ps1), lue dans le source : chaque élément du tableau rendu. */
function listePowerShell(): string[] {
  const source = fs.readFileSync(path.join(RACINE, "CockpitTls.ps1"), "utf8");
  const debut = source.indexOf("function Get-CockpitWebMigrationArgs");
  assert.ok(debut >= 0, "Get-CockpitWebMigrationArgs absent de CockpitTls.ps1");
  const corps = source.slice(source.indexOf("return @(", debut) + "return @(".length, source.indexOf("\n}", debut));
  const elements = corps
    .replace(/\)\s*$/, "")
    .split(/,\s*/)
    .map((e) => e.trim());
  return elements.map((e) => {
    if (/^'[^']*'$/.test(e)) return e.slice(1, -1);
    if (e === "$Name") return "<nom>";
    if (e === "$Image") return "<image>";
    const volume = /^\(\$Project \+ '([^']*)'\)$/.exec(e);
    if (volume) return `<projet>${volume[1]}`;
    throw new Error(`élément inattendu dans Get-CockpitWebMigrationArgs : ${e}`);
  });
}

describe("T7 sans Docker : conteneur jetable et option --volume-1-0-6 du banc", () => {
  it("la liste d'options du banc (docker-e2e.mjs) est celle de CockpitTls.ps1, et celle de la fiche MW §1.2", async () => {
    const banc = await importer<BancMw>("e2e", "lib", "docker-e2e.mjs");
    const ps = listePowerShell();
    assert.deepEqual(banc.argumentsMigration("<projet>", "<image>", "<nom>"), ps);
    assert.equal(
      ["docker", ...ps].join(" "),
      "docker run --rm --pull never --name <nom> --network none --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 32 -v <projet>_oc-config:/oc-config --entrypoint node <image> --no-warnings server/migrate-oc-config.ts /oc-config",
    );
    for (const interdit of ["--env-file", "-e", "--env", "--privileged"]) assert.equal(ps.includes(interdit), false, interdit);
  });

  it("--volume-1-0-6 : lu, réservé à --reel-hors-ligne ; sans lui, la pile par défaut n'est NI ensemencée NI migrée (Prudent 1.0 pour GF5)", async () => {
    const banc = await importer<BancMw>("e2e", "lib", "docker-e2e.mjs");
    assert.equal(banc.analyserArguments([]).volume106, false);
    assert.equal(banc.analyserArguments(["--reel-hors-ligne", "--volume-1-0-6"]).volume106, true);
    const base = { projet: "gf11-e2e-essai", imageApp: "gf11-e2e/app:essai" };
    assert.deepEqual(banc.etapesVolume106({ ...base, mode: "reel-hors-ligne", volume106: false }), []);
    assert.deepEqual(banc.etapesVolume106({ ...base, mode: "faux", volume106: false }), []);
    const etapes = banc.etapesVolume106({ ...base, mode: "reel-hors-ligne", volume106: true });
    assert.deepEqual(etapes[0]?.compose, [
      "run",
      "--rm",
      "--no-deps",
      "--entrypoint",
      "sh",
      "preparation",
      "-c",
      "cp /seed/opencode-volume-1.0.6.jsonc /cfg/opencode.jsonc && chown 1000:1000 /cfg/opencode.jsonc",
    ]);
    assert.equal(etapes[1]?.migration, "migration-web etat=migre profil=prudent fichier=opencode.jsonc blocs=1 restes=0 sauvegarde=opencode.jsonc.avant-1.1.0 raison=-");
    // Leurre APRÈS la migration : un temporaire laissé par un arrêt brutal (graine non migrée), qu'opencode doit ignorer.
    assert.equal(etapes[2]?.compose?.at(-1), "cp /seed/opencode-volume-1.0.6.jsonc /cfg/opencode.jsonc.0123456789ab.tmp && chown 1000:1000 /cfg/opencode.jsonc.0123456789ab.tmp");
    assert.equal(etapes.length, 3);
    for (const mode of ["faux", "reel"]) {
      await assert.rejects(banc.preparerPlan({ mode, volume106: true, prefixe: "gf11-e2e", tag: "essai" }), /n'existe qu'en « --reel-hors-ligne »/);
    }
  });

  it("casM2 : le Prudent 1.0 sans l'option (webfetch et websearch attendus), la configuration migrée avec (tous deux retirés)", async () => {
    const communs = await importer<ScenariosCommuns>("e2e", "scenarios", "it1-api-commun.mjs");
    assert.deepEqual(communs.casM2("sans-regle", "reel-hors-ligne").retiresParLaPile, []);
    assert.deepEqual(communs.casM2("sans-regle", { mode: "reel-hors-ligne", volume106: false }).retiresParLaPile, []);
    assert.deepEqual(communs.casM2("sans-regle", { mode: "reel-hors-ligne", volume106: true }).retiresParLaPile, ["webfetch", "websearch"]);
    assert.deepEqual(communs.casM2("sans-regle", { mode: "faux", volume106: false }).retiresParLaPile, ["webfetch", "websearch"]);
    const avec = communs.casM2("sans-regle", { mode: "reel-hors-ligne", volume106: true }).tools;
    assert.equal(avec.includes("webfetch") || avec.includes("websearch"), false);
  });
});
