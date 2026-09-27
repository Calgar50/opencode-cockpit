// Tests L15b : scripts/build-omo-image.ps1 et docker/opencode-omo/audit-baseline.json (plan 2 bis, fiche L15b ; spécification
// §3.15.1 l.453-461, §7.1 l.1087, §7.5 l.1143, G14 l.1228 ; D-2b-32).
// Partout, CI Linux comprise : contrôles statiques du script (ASCII + BOM + CRLF, jetons interdits et exigés, paramètres, chemins
// de l'image lus dans le contrat), base d'audit, mutations de -SelfTest rejouées sur un omo.jsonc synthétique, et croisement du
// train de V1 avec le Dockerfile, le omo.jsonc et validate-core.mjs de L15a dès qu'ils existent.
// Sous Windows (FIN local) : Windows PowerShell 5.1 réel. ParseFile sans erreur ; fonctions pures du script chargées depuis son
// arbre syntaxique (aucun crochet de test dans le script ; espions par fonctions homonymes) ; -DryRun sur des dépôts synthétiques,
// avec un faux docker en tête du PATH qui laisse une trace s'il est lancé ; déroulé complet avec un faux docker scripté. Aucune
// construction, aucun Docker réel (§7.1 l.1087).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";
import { type ParseError, parse as parseJsonc } from "jsonc-parser";
import { OMO_SALLE_CONTRACT_FILE } from "./omo-contracts.ts";
import { OMO_VERSION } from "./shared/omo-audit-4.19.4.ts";
import type { OmoSalleContract } from "./shared/omo-types.ts";

const APP_DIR = path.join(import.meta.dirname, "..");
const RACINE = path.join(APP_DIR, "..");
const SCRIPT = path.join(RACINE, "scripts", "build-omo-image.ps1");
const OMO_DIR = path.join(RACINE, "docker", "opencode-omo");
const BASELINE = path.join(OMO_DIR, "audit-baseline.json");
const DOCKERFILE = path.join(OMO_DIR, "Dockerfile");
const OMO_JSONC = path.join(OMO_DIR, "omo.jsonc");
const VALIDATE_CORE = path.join(OMO_DIR, "validate-core.mjs");
const ENUMS = path.join(OMO_DIR, "enums-4.19.4.json");

const OCTETS = fs.readFileSync(SCRIPT);
const TEXTE = OCTETS.subarray(3).toString("latin1");
/** Code sans les lignes de commentaire entières : un jeton exigé n'est jamais satisfait par un commentaire. */
const CODE = TEXTE.split("\r\n")
  .filter((ligne) => !ligne.trimStart().startsWith("#"))
  .join("\n");
const CONTRAT = JSON.parse(fs.readFileSync(path.join(RACINE, OMO_SALLE_CONTRACT_FILE), "utf8")) as OmoSalleContract;
const CLES_CONTRAT = ["valider", "manifeste", "extension", "referenceManifeste"] as const;

// --- Jetons -----------------------------------------------------------------------------------------------------------------------

/** Interdits dans tout le fichier, commentaires compris ; chaque règle est éprouvée sur son exemple. */
const INTERDITS: ReadonlyArray<{ nom: string; re: RegExp; exemple: string }> = [
  { nom: "docker push", re: /docker\s+push/i, exemple: "docker push opencode-cockpit/opencode-omo:x" },
  { nom: "push en tableau d'arguments", re: /['"](image\s+)?push['"]/i, exemple: "Invoke-OmoDocker -Arguments @('push', $tag)" },
  { nom: "connexion à un registre", re: /['"]login['"]|docker\s+login/i, exemple: "@('login', 'ghcr.io')" },
  { nom: "Invoke-Expression", re: /Invoke-Expression/i, exemple: "Invoke-Expression $texte" },
  { nom: "iex", re: /\biex\b/i, exemple: "$code | iex" },
  { nom: "téléchargement suivi d'un tube", re: /\b(iwr|irm|curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b[^\r\n]*\|/i, exemple: "iwr https://exemple.test/a | Out-File a" },
  { nom: "tube vers un interpréteur", re: /\|\s*(sh|bash|pwsh|powershell)\b/i, exemple: "Get-Content a | powershell -" },
  { nom: "code construit à partir de texte", re: /ScriptBlock\]::Create|NewScriptBlock|-EncodedCommand/i, exemple: "& ([ScriptBlock]::Create($t))" },
  { nom: "Add-Type", re: /Add-Type/i, exemple: "Add-Type -TypeDefinition $t" },
  { nom: "docker lancé hors de Invoke-OmoDocker", re: /^\s*&?\s*docker(\.exe)?\s/im, exemple: "  & docker build ." },
];

/** Exigés dans le code (hors lignes de commentaire), sous leur forme de tableau d'arguments. */
const EXIGES: ReadonlyArray<{ nom: string; re: RegExp }> = [
  { nom: "Set-StrictMode -Version Latest", re: /^Set-StrictMode -Version Latest$/m },
  { nom: "$ErrorActionPreference = 'Stop'", re: /^\$ErrorActionPreference = 'Stop'$/m },
  { nom: "[CmdletBinding()] (paramètre inconnu refusé)", re: /^\[CmdletBinding\(\)\]$/m },
  { nom: "-AcceptManifest", re: /\[switch\]\$AcceptManifest\b/ },
  { nom: "--ignore-scripts", re: /'--ignore-scripts'/ },
  { nom: "--package-lock-only", re: /'--package-lock-only'/ },
  // Grande fusion, D7 a : npm n'est plus hors ligne dans le seul conteneur du lockfile (base 1.0.6 : npm_config_offline=true).
  { nom: "lockfile : -e npm_config_offline=false avant l'image de base (D7 a)", re: /'-e', 'npm_config_offline=false', '--entrypoint', 'npm', \$BaseImage,/ },
  // Grande fusion, D7 b : ENV de la base lu avant toute construction, refus sans les drapeaux de la 1.0.6.
  { nom: "ENV de la base lu (D7 b)", re: /'image', 'inspect', '--format', '\{\{json \.Config\.Env\}\}', \$BaseImage/ },
  { nom: "drapeaux de la base vérifiés juste après Docker (D7 b)", re: /^ {4}Assert-OmoDocker\n {4}Assert-OmoBaseFlags\n/m },
  { nom: "--network none", re: /'--network', 'none'/ },
  { nom: "Get-FileHash", re: /\bGet-FileHash -(LiteralPath|InputStream)\b/ },
  { nom: "construction sans cache", re: /'build', '--no-cache'/ },
  { nom: "--build-arg OPENCODE_BASE", re: /'--build-arg', \('OPENCODE_BASE=' \+ \$BaseImage\)/ },
  { nom: "npm audit --omit=dev --json", re: /'audit', '--omit=dev', '--json'/ },
  { nom: "SBOM npm ls --all --json", re: /'ls', '--all', '--json'/ },
  { nom: "docker save vers un fichier", re: /'save', '--output'/ },
  { nom: "contrat lu à l'exécution", re: /'contrat-salle\.json'/ },
  { nom: "validate.mjs --construction (contrôles de l'image seule, L15a)", re: /@\(\$Contract\.Valider, '--construction'\)/ },
  { nom: "conteneurs sans capacité", re: /'--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true'/ },
];

// --- Mutations de -SelfTest (G14), rejouées en JavaScript avec les ancres lues dans le script ------------------------------------

type Cas = "hook-faux" | "cle-inconnue" | "valeur-retiree";
const CAS: readonly Cas[] = ["hook-faux", "cle-inconnue", "valeur-retiree"];

/** Nom que le refus de la validation doit citer pour une mutation, lu dans Get-OmoSelfTestMarker du script. */
function marqueur(cas: Cas): string {
  const trouve = new RegExp(`'${cas}' \\{ return '([^']+)' \\}`).exec(TEXTE);
  assert.ok(trouve?.[1], `marqueur de ${cas} absent du script`);
  return trouve[1];
}

function ancre(nom: string): RegExp {
  const trouve = new RegExp("\\$" + nom + " = '([^']+)'").exec(TEXTE);
  assert.ok(trouve?.[1], `ancre ${nom} absente du script`);
  return new RegExp(trouve[1]);
}

const ANCRES = {
  hook: ancre("hookAnchor"),
  cle: ancre("keyAnchor"),
  epinglee: ancre("pinnedAnchor"),
  epingleeDerniere: ancre("pinnedAnchorLast"),
};

function muter(jsonc: string, cas: Cas): string {
  switch (cas) {
    case "hook-faux":
      return jsonc.replace(ANCRES.hook, (m) => `${m}"g14-crochet-inexistant", `);
    case "cle-inconnue":
      return jsonc.replace(ANCRES.cle, (m) => `"g14_cle_inconnue": true, ${m}`);
    case "valeur-retiree": {
      const sansVirgule = jsonc.replace(ANCRES.epinglee, "");
      return sansVirgule !== jsonc ? sansVirgule : jsonc.replace(ANCRES.epingleeDerniere, "");
    }
  }
}

function lireJsonc(texte: string): Record<string, unknown> {
  const erreurs: ParseError[] = [];
  const valeur = parseJsonc(texte, erreurs, { allowTrailingComma: false, disallowComments: false }) as unknown;
  assert.deepEqual(erreurs, [], "JSONC mal formé après mutation");
  assert.ok(valeur !== null && typeof valeur === "object" && !Array.isArray(valeur));
  return valeur as Record<string, unknown>;
}

/** Chaque mutation change bien ce qu'elle annonce, et seulement cela. */
function verifierMutations(jsonc: string): void {
  const origine = lireJsonc(jsonc);
  assert.equal(origine.hashline_edit, false, "valeur épinglée hashline_edit: false attendue");
  assert.ok(Array.isArray(origine.disabled_hooks) && origine.disabled_hooks.length > 0, "disabled_hooks non vide attendu");
  const hook = lireJsonc(muter(jsonc, "hook-faux"));
  assert.deepEqual(hook.disabled_hooks, ["g14-crochet-inexistant", ...(origine.disabled_hooks as unknown[])]);
  assert.deepEqual({ ...hook, disabled_hooks: origine.disabled_hooks }, origine);
  const cle = lireJsonc(muter(jsonc, "cle-inconnue"));
  assert.equal(cle.g14_cle_inconnue, true);
  assert.deepEqual(Object.keys(cle).sort(), [...Object.keys(origine), "g14_cle_inconnue"].sort());
  const retiree = lireJsonc(muter(jsonc, "valeur-retiree"));
  assert.equal("hashline_edit" in retiree, false);
  assert.deepEqual({ ...retiree, hashline_edit: false }, origine);
}

/** omo.jsonc synthétique (D-2b-31 : aucun texte de l'extension) ; `dernier` place hashline_edit en fin d'objet. */
function jsoncSynthetique(dernier = false): string {
  const epinglee = '  "hashline_edit": false';
  return [
    "// [synthétique] forme de omo.jsonc (L15a), jamais lue par une image",
    "{",
    '  "$schema": "https://exemple.test/schema.json",',
    '  "disabled_hooks": [',
    "    // coupés (D-2b-47)",
    '    "directory-agents-injector",',
    '    "goal"',
    "  ],",
    ...(dernier ? ['  "auto_update": false,', epinglee] : [`${epinglee},`, '  "auto_update": false']),
    "}",
    "",
  ].join("\n");
}

// --- Contrôles statiques ------------------------------------------------------------------------------------------------------

describe("L15b : build-omo-image.ps1, contrôles statiques", () => {
  it("encodage : BOM UTF-8, puis ASCII pur, aucun caractère de contrôle, fins de ligne CRLF (lu en cp1252 sans BOM)", () => {
    assert.deepEqual([...OCTETS.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const fautes: string[] = [];
    for (let i = 3; i < OCTETS.length; i++) {
      const o = OCTETS[i] ?? 0;
      if (o > 127) fautes.push(`octet non ASCII à ${i}`);
      else if (o === 10 && OCTETS[i - 1] !== 13) fautes.push(`LF sans CR à ${i}`);
      else if (o < 32 && o !== 9 && o !== 10 && o !== 13) fautes.push(`caractère de contrôle à ${i}`);
    }
    assert.deepEqual(fautes.slice(0, 5), []);
  });

  it("jetons interdits absents (commentaires compris), chaque règle éprouvée sur son exemple", () => {
    for (const { nom, re, exemple } of INTERDITS) {
      assert.match(exemple, re, `règle « ${nom} » non discriminante`);
      assert.doesNotMatch(TEXTE, re, `jeton interdit : ${nom}`);
    }
  });

  it("jetons exigés présents dans le code, jamais seulement en commentaire", () => {
    for (const { nom, re } of EXIGES) assert.match(CODE, re, `jeton exigé absent : ${nom}`);
    const commentaire = "# '--network', 'none'\r\n";
    assert.doesNotMatch(commentaire.split("\r\n").filter((l) => !l.trimStart().startsWith("#")).join("\n"), /'--network', 'none'/);
  });

  it("paramètres : exactement -BaseImage, -OutDir, -UpdateLock, -SelfTest, -AcceptManifest, -DryRun", () => {
    const bloc = /^\[CmdletBinding\(\)\]\r\nparam\(([\s\S]*?)\r\n\)/m.exec(TEXTE);
    assert.ok(bloc?.[1], "bloc param absent");
    assert.deepEqual(
      [...bloc[1].matchAll(/\$([A-Za-z]+)/g)].map((m) => m[1]),
      ["BaseImage", "OutDir", "UpdateLock", "SelfTest", "AcceptManifest", "DryRun"],
    );
    assert.match(bloc[1], /\[string\]\$BaseImage/);
    for (const commutateur of ["UpdateLock", "SelfTest", "AcceptManifest", "DryRun"]) assert.match(bloc[1], new RegExp(`\\[switch\\]\\$${commutateur}\\b`));
  });

  it("un seul lancement de processus (Invoke-CockpitProcess), appelé par Invoke-OmoDocker seul ; aucun chemin de l'image écrit en dur", () => {
    assert.equal(CODE.match(/ProcessStartInfo/g)?.length, 1);
    assert.equal(CODE.match(/Diagnostics\.Process\]/g)?.length, 1);
    const processus = /^function Invoke-CockpitProcess \{[\s\S]*?^\}/m.exec(CODE);
    assert.ok(processus?.[0].includes("ProcessStartInfo") && processus[0].includes("[System.Diagnostics.Process]::Start"), "processus lancé hors de Invoke-CockpitProcess");
    const docker = /^function Invoke-OmoDocker \{[\s\S]*?^\}/m.exec(CODE);
    assert.ok(docker?.[0].includes("Invoke-CockpitProcess -FilePath $script:DockerPath"), "Invoke-OmoDocker ne passe pas par Invoke-CockpitProcess");
    assert.equal(CODE.match(/\bInvoke-CockpitProcess\b/g)?.length, 2, "une définition, un seul appel (Invoke-OmoDocker)");
    assert.doesNotMatch(CODE, /['"]\/(opt|etc|usr|home)\//, "chemin de l'image écrit en dur : il se lit dans le contrat");
  });

  it("croisement V1 (1/3) : chemins du script = contrat (clés lues à l'exécution, présentes et absolues dans contrat-salle.json)", () => {
    for (const cle of CLES_CONTRAT) {
      assert.match(CODE, new RegExp(`'${cle}'`), `clé ${cle} non lue par le script`);
      assert.match(CONTRAT.cheminsImage[cle], /^\/[A-Za-z0-9._/-]+$/, cle);
    }
    assert.match(CODE, /'perimetreManifeste'/);
    assert.ok(CONTRAT.perimetreManifeste.length > 0);
    assert.equal(
      CONTRAT.perimetreManifeste.some((racine) => CONTRAT.cheminsImage.referenceManifeste.startsWith(`${racine}/`)),
      false,
      "la référence du manifeste reste hors du périmètre (D-2b-32)",
    );
  });

  it("paquet et version du script = audit de la 4.19.4", () => {
    assert.match(CODE, /^\$OmoPackage = 'oh-my-openagent'$/m);
    assert.match(CODE, new RegExp(`^\\$OmoVersion = '${OMO_VERSION.replaceAll(".", "\\.")}'$`, "m"));
  });
});

describe("L15b : audit-baseline.json", () => {
  const brut = fs.readFileSync(BASELINE);
  const base = JSON.parse(brut.toString("utf8")) as Record<string, unknown>;

  it("JSON strict en ASCII, sans BOM, terminé par une fin de ligne LF", () => {
    assert.equal(brut[0], 0x7b);
    assert.equal([...brut].every((o) => o < 128), true);
    assert.equal(brut.toString("utf8").endsWith("}\n"), true);
    assert.equal(brut.includes(13), false);
  });

  it("base initiale : clés fermées, oh-my-openagent 4.19.4, aucune alerte acceptée", () => {
    assert.deepEqual(Object.keys(base), ["version", "description", "paquet", "versionPaquet", "alertesAcceptees"]);
    assert.equal(base.version, 1);
    assert.equal(base.paquet, "oh-my-openagent");
    assert.equal(base.versionPaquet, OMO_VERSION);
    assert.deepEqual(base.alertesAcceptees, []);
  });

  it("aucun secret ni jeton", () => {
    const texte = brut.toString("utf8");
    for (const re of [/gh[pousr]_[A-Za-z0-9]{16,}/, /github_pat_/, /_authToken/i, /BEGIN [A-Z ]*PRIVATE KEY/, /AKIA[0-9A-Z]{16}/, /(password|passwd|secret)\s*[:=]/i]) {
      assert.doesNotMatch(texte, re);
    }
  });
});

describe("L15b : mutations de -SelfTest (G14)", () => {
  it("ancres et valeurs insérées du script : un hook faux, une clé inconnue, hashline_edit retirée", () => {
    assert.match(CODE, /'\$0"g14-crochet-inexistant", '/);
    assert.match(CODE, /'"g14_cle_inconnue": true, \$0'/);
    for (const cas of ["temoin", "hook-faux", "cle-inconnue", "valeur-retiree"]) assert.match(CODE, new RegExp(`'${cas}'`));
    assert.deepEqual(CAS.map(marqueur), ["g14-crochet-inexistant", "g14_cle_inconnue", "hashline_edit"], "chaque refus cite la mutation");
  });

  it("omo.jsonc synthétique : chaque mutation produit un JSONC valide qui change exactement ce qu'elle annonce", () => {
    verifierMutations(jsoncSynthetique());
    verifierMutations(jsoncSynthetique(true));
  });

  it(
    "croisement V1 (2/3) : les ancres trouvent leur cible dans le omo.jsonc de L15a, et son validate-core refuse chaque mutation en la citant",
    { skip: !fs.existsSync(OMO_JSONC) && "omo.jsonc de L15a absent sur cette branche : croisement joué au train de V1" },
    async () => {
      const texte = fs.readFileSync(OMO_JSONC, "utf8");
      verifierMutations(texte);
      assert.ok(fs.existsSync(VALIDATE_CORE), "validate-core.mjs livré avec omo.jsonc (L15a)");
      const coeur = (await import(pathToFileURL(VALIDATE_CORE).href)) as { lireJsonc(t: string): unknown; verifierOmo(config: unknown, enums: unknown): string[] };
      const enums = JSON.parse(fs.readFileSync(ENUMS, "utf8")) as unknown;
      assert.deepEqual(coeur.verifierOmo(coeur.lireJsonc(texte), enums), [], "omo.jsonc livré : aucun message");
      for (const cas of CAS) {
        const messages = coeur.verifierOmo(coeur.lireJsonc(muter(texte, cas)), enums);
        assert.ok(messages.some((m) => m.includes(marqueur(cas))), `${cas} : ${JSON.stringify(messages)}`);
      }
    },
  );
});

describe("L15b : croisement V1 (3/3) avec le Dockerfile de L15a", { skip: !fs.existsSync(DOCKERFILE) && "Dockerfile de L15a absent sur cette branche : croisement joué au train de V1" }, () => {
  it("contexte docker/opencode-omo, ARG OPENCODE_BASE, npm ci --ignore-scripts, chemins du contrat copiés", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf8").replace(/\\\r?\n/g, " ");
    assert.match(dockerfile, /^ARG OPENCODE_BASE\b/m);
    assert.match(dockerfile, /^FROM\s+\$\{?OPENCODE_BASE\}?(\s|$)/m);
    assert.match(dockerfile, /\bnpm\s+ci\b[^\n]*--ignore-scripts/);
    assert.doesNotMatch(dockerfile, /^\s*(COPY|ADD)\s+(--\S+\s+)*docker\//m, "contexte = docker/opencode-omo : aucune source depuis la racine du dépôt");
    assert.doesNotMatch(dockerfile, /^\s*ADD\s+(--\S+\s+)*https?:/im, "aucun téléchargement par ADD");
    for (const cle of CLES_CONTRAT) {
      const chemin = CONTRAT.cheminsImage[cle];
      const present = dockerfile.includes(chemin) || (dockerfile.includes(`${path.posix.dirname(chemin)}/`) && dockerfile.includes(path.posix.basename(chemin)));
      assert.ok(present, `${cle} : ${chemin} absent du Dockerfile`);
    }
  });

  it("-SelfTest et -AcceptManifest : omo.jsonc copié, validation à la construction, référence copiée au chemin du contrat", () => {
    const lignes = fs.readFileSync(DOCKERFILE, "utf8").replace(/\\\r?\n/g, " ").split(/\r?\n/);
    const echappe = (texte: string) => texte.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.ok(lignes.some((l) => /^COPY\s+(--\S+\s+)*omo\.jsonc\s/.test(l)), "omo.jsonc (muté par -SelfTest) copié dans l'image");
    // Étape que Test-OmoSelfTestRefusal cherche au journal : « RUN node <valider> --construction ».
    assert.ok(
      lignes.some((l) => new RegExp(`^RUN node ${echappe(CONTRAT.cheminsImage.valider)} --construction\\s*$`).test(l)),
      "validation de la construction absente : les mutations de -SelfTest ne feraient pas échouer la construction",
    );
    assert.ok(
      lignes.some((l) => new RegExp(`^COPY\\s+(--\\S+\\s+)*omo-manifest\\.sha256\\s+${echappe(CONTRAT.cheminsImage.referenceManifeste)}\\s*$`).test(l)),
      "référence écrite par -AcceptManifest non copiée au chemin du contrat",
    );
  });
});

// --- Windows PowerShell 5.1 réel -------------------------------------------------------------------------------------------------

const PS51 = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : null;
const SAUT_PS = PS51 === null || !fs.existsSync(PS51) ? "Windows PowerShell 5.1 absent (CI Linux) : joué au FIN local sous Windows" : false;
const EMPREINTE = "0123456789abcdef".repeat(4);
const BASE = `ghcr.io/exemple/opencode-cockpit-opencode:1.0.5@sha256:${EMPREINTE}`;
/** ENV d'une image opencode du cockpit 1.0.6 (docker/opencode/Dockerfile), tel que docker image inspect le rend. */
const ENV_BASE_106 = ["PATH=/usr/local/bin:/usr/bin", "OPENCODE_DISABLE_MODELS_FETCH=1", "OPENCODE_MODELS_URL=http://127.0.0.1:9", "npm_config_offline=true"];
const INTEGRITE = `sha512-${crypto.createHash("sha512").update("[synthétique] oh-my-openagent").digest("base64")}`;
const RESOLU = "https://registry.npmjs.org/oh-my-openagent/-/oh-my-openagent-4.19.4.tgz";

function lockfile(entree: Record<string, unknown> = {}, autres: Record<string, unknown> = {}, version = 3): string {
  return `${JSON.stringify(
    {
      name: "opencode-omo",
      lockfileVersion: version,
      requires: true,
      packages: {
        "": { name: "opencode-omo", dependencies: { "oh-my-openagent": "4.19.4" } },
        "node_modules/oh-my-openagent": { version: "4.19.4", resolved: RESOLU, integrity: INTEGRITE, ...entree },
        ...autres,
      },
    },
    null,
    2,
  )}\n`;
}

/** Lockfile valide et différent du lockfile synthétique par défaut (un paquet embarqué de plus). */
const LOCK_REGENERE = lockfile({}, { "node_modules/oh-my-openagent/node_modules/embarque": { version: "1.0.0", inBundle: true } });

/** Vulnérabilité au format de npm audit --json (auditReportVersion 2), synthétique. */
function vuln(nom: string, severite: string, avis: string): Record<string, unknown> {
  const via = { source: 1100000, name: nom, dependency: nom, title: "[synthétique]", url: `https://github.com/advisories/${avis}`, severity: severite, range: "<1.0.1" };
  return { name: nom, severity: severite, isDirect: false, via: [via], effects: [], range: "<1.0.1", nodes: [`node_modules/${nom}`], fixAvailable: false };
}

function audit(vulnerabilities: Record<string, unknown>, compteurs: Record<string, number> = {}): string {
  const total = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0, ...compteurs };
  return JSON.stringify({ auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: total, dependencies: { prod: 3, dev: 0, total: 3 } } });
}

const PACKAGE_JSON = `${JSON.stringify({ name: "opencode-omo", private: true, dependencies: { "oh-my-openagent": "4.19.4" } }, null, 2)}\n`;
/** Manifeste synthétique au format de manifest.sh (L15a) : empreintes des fichiers et lignes meta, trié, tout le périmètre. */
const REFERENCE_VALIDE = `${CONTRAT.perimetreManifeste
  .flatMap((racine, i) =>
    racine === CONTRAT.cheminsImage.superviseur
      ? [`${String(i).repeat(64)}  ${racine}`, `meta f 555 0:0 ${racine}`]
      : [`meta d 555 0:0 ${racine}`, `${String(i).repeat(64)}  ${racine}/fichier`, `meta f 444 0:0 ${racine}/fichier`],
  )
  .sort()
  .join("\n")}\n`;
const PREMIERE_RACINE = CONTRAT.perimetreManifeste[0] ?? "";
const VALIDER = CONTRAT.cheminsImage.valider;

/** Journal synthétique (--progress=plain de BuildKit) d'une construction refusée par la validation, message citant `cite`. */
function journalRefus(cite: string, valider = VALIDER, etapeErreur = "9"): string[] {
  return [
    "#5 [2/9] RUN npm ci --ignore-scripts --no-audit --no-fund --omit=dev",
    "#5 DONE 1.4s",
    `#9 [9/9] RUN node ${valider} --construction`,
    `#9 0.310 omo.jsonc : [synthétique] refus : ${cite}`,
    `#${etapeErreur} ERROR: process "/bin/sh -c node ${valider} --construction" did not complete successfully: exit code: 1`,
  ];
}

/** Panne hors de l'étape de validation (réseau pendant npm ci), même quand une ligne cite une mutation. */
const JOURNAL_PANNE = [
  "#5 [2/9] RUN npm ci --ignore-scripts --no-audit --no-fund --omit=dev",
  "#5 12.0 npm error network [synthétique] g14-crochet-inexistant",
  '#5 ERROR: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1',
  "",
].join("\n");

interface Execution {
  code: number;
  sortie: string;
  dockerAppele: boolean;
  sortieCreee: boolean;
  referenceAvant: string;
  referenceApres: string;
  lockAvant: string;
  lockApres: string;
}

function executer(fichier: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<{ code: number; sortie: string }> {
  return new Promise((resolve) => {
    execFile(fichier, [...args], { env, timeout: 90_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (erreur, stdout, stderr) => {
      const code = erreur === null ? 0 : typeof erreur.code === "number" ? erreur.code : -1;
      resolve({ code, sortie: `${stdout}${stderr}` });
    });
  });
}

/** Dépôt synthétique : le script copié (sa racine se déduit de son dossier), le contrat et la base réels, le reste synthétique. */
function depotSynthetique(racine: string, options: { reference?: string; lock?: string | null; packageJson?: string }): string {
  const depot = path.join(racine, "depot");
  const omo = path.join(depot, "docker", "opencode-omo");
  fs.mkdirSync(path.join(depot, "scripts"), { recursive: true });
  fs.mkdirSync(omo, { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(depot, "scripts", "build-omo-image.ps1"));
  fs.copyFileSync(path.join(RACINE, OMO_SALLE_CONTRACT_FILE), path.join(omo, "contrat-salle.json"));
  fs.copyFileSync(BASELINE, path.join(omo, "audit-baseline.json"));
  fs.writeFileSync(path.join(omo, "Dockerfile"), "# [synthétique] jamais construit\n");
  fs.writeFileSync(path.join(omo, "package.json"), options.packageJson ?? PACKAGE_JSON);
  if (options.lock !== null) fs.writeFileSync(path.join(omo, "package-lock.json"), options.lock ?? lockfile());
  fs.writeFileSync(path.join(omo, "omo.jsonc"), jsoncSynthetique());
  fs.writeFileSync(path.join(omo, "omo-manifest.sha256"), options.reference ?? "# amorce\n");
  return depot;
}

function suiteDryRun(): void {
  let racine = "";
  const executions = new Map<string, Execution>();
  let harnais: Record<string, unknown> = {};

  async function lancerDryRun(nom: string, args: readonly string[], options: { reference?: string; lock?: string; packageJson?: string; sortieDansDepot?: boolean } = {}): Promise<void> {
    const dossier = path.join(racine, nom);
    const depot = depotSynthetique(dossier, options);
    const faux = path.join(dossier, "faux-docker");
    fs.mkdirSync(faux);
    const trace = path.join(faux, "docker-appele.txt");
    fs.writeFileSync(path.join(faux, "docker.cmd"), `@echo off\r\necho appel>>"${trace}"\r\nexit /b 97\r\n`);
    const sortie = options.sortieDansDepot ? path.join(depot, "sortie") : path.join(dossier, "sortie");
    const cle = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    const env = { ...process.env, [cle]: `${faux};${process.env[cle] ?? ""}` };
    const reference = path.join(depot, "docker", "opencode-omo", "omo-manifest.sha256");
    const lock = path.join(depot, "docker", "opencode-omo", "package-lock.json");
    const referenceAvant = fs.readFileSync(reference, "utf8");
    const lockAvant = fs.readFileSync(lock, "utf8");
    const script = path.join(depot, "scripts", "build-omo-image.ps1");
    const r = await executer(PS51 ?? "", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args, "-OutDir", sortie], env);
    executions.set(nom, {
      ...r,
      dockerAppele: fs.existsSync(trace),
      sortieCreee: fs.existsSync(sortie),
      referenceAvant,
      referenceApres: fs.readFileSync(reference, "utf8"),
      lockAvant,
      lockApres: fs.readFileSync(lock, "utf8"),
    });
  }

  async function lancerHarnais(): Promise<void> {
    const dossier = path.join(racine, "harnais");
    fs.mkdirSync(dossier);
    const cas = {
      contractFile: path.join(RACINE, OMO_SALLE_CONTRACT_FILE),
      contractBad: [
        JSON.stringify({ ...CONTRAT, cheminsImage: { ...CONTRAT.cheminsImage, valider: "opt/omo-check/validate.mjs" } }),
        JSON.stringify({ ...CONTRAT, cheminsImage: { ...CONTRAT.cheminsImage, manifeste: "/opt/omo-check/../x.sh" } }),
        JSON.stringify({ ...CONTRAT, perimetreManifeste: [] }),
        "pas du JSON",
      ],
      baseImage: [
        BASE,
        `opencode-cockpit/opencode@sha256:${EMPREINTE}`,
        `localhost:5000/a/b:1@sha256:${EMPREINTE}`,
        "opencode-cockpit/opencode:local",
        `opencode-cockpit/opencode@sha256:${EMPREINTE.slice(1)}`,
        `opencode-cockpit/opencode@sha256:${EMPREINTE.toUpperCase()}`,
        `-v@sha256:${EMPREINTE}`,
        `a b@sha256:${EMPREINTE}`,
        `opencode@sha256:${EMPREINTE}\n`,
        `sha256:${EMPREINTE}`,
      ],
      // Grande fusion, D7 b : ENV de l'image de base (sortie de docker image inspect --format '{{json .Config.Env}}').
      baseFlags: [
        JSON.stringify(ENV_BASE_106),
        JSON.stringify(["PATH=/usr/bin", "NODE_VERSION=24"]),
        JSON.stringify(["OPENCODE_DISABLE_MODELS_FETCH=1", "npm_config_offline=false"]),
        JSON.stringify(["opencode_disable_models_fetch=1", "NPM_CONFIG_OFFLINE=true"]),
        "null",
        "pas du JSON",
      ],
      inside: [
        { path: "C:\\depot", root: "C:\\depot" },
        { path: "c:\\DEPOT\\sortie", root: "C:\\depot\\" },
        { path: "C:\\depot-voisin", root: "C:\\depot" },
        { path: "D:\\ailleurs", root: "C:\\depot" },
      ],
      argText: ["simple", "a b", "C:\\x y\\", "", 'dit "oui"'],
      safeText: ["abc", "é\r\n", "0123456789012345678901234"],
      hide: ["https://utilisateur:motdepasse-factice@registre.exemple/x", "npm_config__auth=abcdef", "rien a masquer"],
      manifestCompare: [
        { current: "a  /x\nb  /y\n", reference: "# commentaire\na  /x\r\nb  /y  \n\n" },
        { current: "a  /x\n", reference: "# amorce\n" },
        { current: "a  /x\n", reference: "a  /y\n" },
        { current: "", reference: "" },
        { current: "a  /x\nb  /y\n", reference: "b  /y\na  /x\n" },
      ],
      amorce: ["# amorce\n", "#amorce : remplacée par build-omo-image.ps1 -AcceptManifest\n", "# amorce\na  /x\n", "# Reference\n", "  # amorce\n"],
      manifestProblems: [
        REFERENCE_VALIDE,
        `${REFERENCE_VALIDE}${"f".repeat(64)}  /etc/omo-reference/omo-manifest.sha256\n`,
        REFERENCE_VALIDE.split("\n")
          .filter((l) => !(l.endsWith(` ${PREMIERE_RACINE}`) || l.includes(` ${PREMIERE_RACINE}/`)))
          .join("\n"),
        "cat: /opt/omo: No such file or directory\n",
        `${REFERENCE_VALIDE}${REFERENCE_VALIDE}`,
        "",
        `${REFERENCE_VALIDE}meta l 777 1000:1000 ${PREMIERE_RACINE}/lien -> fichier\nmeta d 1555 0:0 ${PREMIERE_RACINE}/collant\n`,
        REFERENCE_VALIDE.replace(`meta f 444 0:0 ${PREMIERE_RACINE}/fichier`, `meta f 444 1000:1000 ${PREMIERE_RACINE}/fichier`),
        REFERENCE_VALIDE.replace(`meta d 555 0:0 ${PREMIERE_RACINE}\n`, `meta d 557 0:0 ${PREMIERE_RACINE}\n`),
        REFERENCE_VALIDE.replace(`meta f 444 0:0 ${PREMIERE_RACINE}/fichier`, `meta f 464 0:0 ${PREMIERE_RACINE}/fichier`),
        REFERENCE_VALIDE.replace(`meta f 555 0:0 ${CONTRAT.cheminsImage.superviseur}`, `meta f 4555 0:0 ${CONTRAT.cheminsImage.superviseur}`),
        REFERENCE_VALIDE.replace(`meta d 555 0:0 ${PREMIERE_RACINE}\n`, `meta d 755 0:0 ${PREMIERE_RACINE}\n`),
        `${REFERENCE_VALIDE}${"e".repeat(64)}  ${PREMIERE_RACINE}/fichier\n`,
        `${REFERENCE_VALIDE}meta f 444 0:0 ${PREMIERE_RACINE}/fichier\n`,
      ],
      buildLog: [
        ["#5 [2/6] RUN npm ci --ignore-scripts --no-audit --no-fund --omit=dev", "#5 1.20 added 3 packages in 1s", "#5 DONE 1.4s"],
        ["#5 [2/6] RUN npm ci --no-audit --omit=dev", "#5 DONE 1.4s"],
        ["#5 [2/6] RUN npm install --ignore-scripts", "#5 DONE 1.4s"],
        ["#5 [2/6] RUN npm ci --ignore-scripts", "#5 CACHED"],
        ["#5 [2/6] RUN npm ci --ignore-scripts", "#5 2.10 > esbuild@0.25.0 postinstall", "#5 DONE 3s"],
        ["#5 [2/6] RUN npm ci --ignore-scripts --loglevel=info", "#5 2.10 npm info run esbuild@0.25.0 postinstall node_modules/esbuild node install.js"],
        ["#5 [2/6] RUN npm ci --ignore-scripts", "#5 3.00 gyp info it worked if it ends with ok"],
        ["#3 [1/6] FROM exemple", "#3 DONE 0.1s"],
        ["#5 [build 2/6] RUN set -eu; cd /opt/omo; npm ci --ignore-scripts; npm cache clean --force", "#5 DONE 1s"],
        ["#5 [2/6] RUN npm ci --ignore-scripts && npm ci", "#5 DONE 1s"],
        ["#5 [2/6] RUN npm ci --ignore-scripts && npm install autre", "#5 DONE 1s"],
        ["#5 [2/6] RUN npm ci --ignore-scripts=false", "#5 DONE 1s"],
      ],
      packageJson: [
        PACKAGE_JSON,
        JSON.stringify({ dependencies: { "oh-my-openagent": "^4.19.4" } }),
        JSON.stringify({ dependencies: { "oh-my-openagent": "4.19.4", autre: "github:x/y" } }),
        JSON.stringify({ dependencies: { "oh-my-openagent": "4.19.4" }, devDependencies: { x: "1.0.0" } }),
        JSON.stringify({ name: "sans-dependances" }),
        "[1]",
        JSON.stringify({ dependencies: { "oh-my-openagent": "4.19.4" }, overrides: { x: "1.0.0" } }),
        JSON.stringify({ dependencies: { "oh-my-openagent": "4.19.4" }, scripts: { preinstall: "[synthétique]" } }),
        JSON.stringify({ dependencies: { "oh-my-openagent": "4.19.4" }, workspaces: ["x"] }),
      ],
      lockfile: [
        lockfile(),
        lockfile({ integrity: undefined }),
        lockfile({ integrity: "sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=" }),
        lockfile({ resolved: "http://registry.npmjs.org/oh-my-openagent/-/oh-my-openagent-4.19.4.tgz" }),
        lockfile({}, { "node_modules/local": { link: true, resolved: "../local" } }),
        lockfile({ version: "4.19.5" }),
        lockfile({}, {}, 1),
        lockfile({}, { "node_modules/oh-my-openagent/node_modules/embarque": { version: "1.0.0", inBundle: true } }),
        "{ tronqué",
      ],
      baseline: [
        fs.readFileSync(BASELINE, "utf8"),
        JSON.stringify({ version: 1, description: "", paquet: "oh-my-openagent", versionPaquet: "4.19.4", alertesAcceptees: [], autre: 1 }),
        JSON.stringify({ version: 1, description: "", paquet: "oh-my-openagent", versionPaquet: "4.19.3", alertesAcceptees: [] }),
        JSON.stringify({
          version: 1,
          description: "",
          paquet: "oh-my-openagent",
          versionPaquet: "4.19.4",
          alertesAcceptees: [{ paquet: "exemple", avis: "GHSA-abcd-efgh-ijkm", severite: "high", raison: "[synthétique] sans chemin atteignable", accepteeLe: "2026-09-19" }],
        }),
        JSON.stringify({
          version: 1,
          description: "",
          paquet: "oh-my-openagent",
          versionPaquet: "4.19.4",
          alertesAcceptees: [{ paquet: "exemple", avis: "GHSA-abcd-efgh-ijkm", severite: "moderate", raison: "x", accepteeLe: "2026-09-19" }],
        }),
        JSON.stringify({ version: 1, description: "", paquet: "oh-my-openagent", versionPaquet: "4.19.4", alertesAcceptees: {} }),
      ],
      audit: [
        { json: audit({}), accepted: [] },
        { json: audit({ exemple: vuln("exemple", "high", "GHSA-abcd-efgh-ijkm") }, { high: 1 }), accepted: [] },
        { json: audit({ exemple: vuln("exemple", "high", "GHSA-abcd-efgh-ijkm") }, { high: 1 }), accepted: [{ paquet: "exemple", avis: "GHSA-abcd-efgh-ijkm" }] },
        { json: audit({ exemple: vuln("exemple", "critical", "GHSA-abcd-efgh-ijkm") }, { critical: 1 }), accepted: [{ paquet: "exemple", avis: "GHSA-wxyz-wxyz-wxyz" }] },
        { json: audit({ exemple: vuln("exemple", "moderate", "GHSA-abcd-efgh-ijkm") }, { moderate: 1 }), accepted: [] },
        {
          json: audit({ exemple: vuln("exemple", "high", "GHSA-abcd-efgh-ijkm"), parent: { name: "parent", severity: "high", via: ["exemple"] } }, { high: 2 }),
          accepted: [],
        },
        { json: JSON.stringify({ error: { code: "ENOAUDIT", summary: "[synthétique]" } }), accepted: [] },
        { json: "npm ERR! pas de JSON", accepted: [] },
        { json: audit({}, { high: 1 }), accepted: [] },
        { json: JSON.stringify({ auditReportVersion: 1, vulnerabilities: {}, metadata: { vulnerabilities: {} } }), accepted: [] },
      ],
      mutation: [
        { text: jsoncSynthetique(), cas: "hook-faux" },
        { text: jsoncSynthetique(), cas: "cle-inconnue" },
        { text: jsoncSynthetique(), cas: "valeur-retiree" },
        { text: jsoncSynthetique(true), cas: "valeur-retiree" },
        { text: "{}", cas: "hook-faux" },
        { text: '{ "disabled_hooks": ["a"] }', cas: "valeur-retiree" },
        { text: jsoncSynthetique(), cas: "inconnu" },
      ],
      selfTestMarker: ["hook-faux", "cle-inconnue", "valeur-retiree", "temoin"],
      selfTestRefusal: [
        { lines: journalRefus("g14-crochet-inexistant"), valider: VALIDER, marker: "g14-crochet-inexistant" },
        { lines: journalRefus("g14-crochet-inexistant"), valider: VALIDER, marker: "g14_cle_inconnue" },
        { lines: journalRefus("hashline_edit").slice(0, -1), valider: VALIDER, marker: "hashline_edit" },
        { lines: journalRefus("hashline_edit", VALIDER, "5"), valider: VALIDER, marker: "hashline_edit" },
        { lines: journalRefus("hashline_edit", "/opt/autre/validate.mjs"), valider: VALIDER, marker: "hashline_edit" },
        { lines: JOURNAL_PANNE.trimEnd().split("\n"), valider: VALIDER, marker: "g14-crochet-inexistant" },
        { lines: [...journalRefus("autre-nom"), "#10 0.100 [synthétique] g14-crochet-inexistant"], valider: VALIDER, marker: "g14-crochet-inexistant" },
      ],
      checksum: { name: "opencode-cockpit-omo-4.19.4-20260919-101500.tar.gz", sha: "ab".repeat(32), id: `sha256:${"cd".repeat(32)}`, tag: "opencode-cockpit/opencode-omo:4.19.4-20260919-101500" },
      checksumBad: [
        { name: "autre.tar.gz", sha: "ab".repeat(32), id: `sha256:${"cd".repeat(32)}`, tag: "opencode-cockpit/opencode-omo:x" },
        { name: "opencode-cockpit-omo-4.19.4-20260919-101500.tar.gz", sha: "AB".repeat(32), id: `sha256:${"cd".repeat(32)}`, tag: "opencode-cockpit/opencode-omo:x" },
        { name: "opencode-cockpit-omo-4.19.4-20260919-101500.tar.gz", sha: "ab".repeat(32), id: `sha256:${"cd".repeat(31)}`, tag: "opencode-cockpit/opencode-omo:x" },
        { name: "opencode-cockpit-omo-4.19.4-20260919-101500.tar.gz", sha: "ab".repeat(32), id: `sha256:${"cd".repeat(32)}`, tag: "autre/image:x" },
      ],
      workDir: dossier,
    };
    const fichierCas = path.join(dossier, "cas.json");
    const fichierHarnais = path.join(dossier, "harnais.ps1");
    const fichierSortie = path.join(dossier, "resultats.json");
    fs.writeFileSync(fichierCas, JSON.stringify(cas));
    fs.writeFileSync(fichierHarnais, `${HARNAIS.join("\r\n")}\r\n`);
    // Remove-OmoWorkDirs : dossier temporaire du harnais (TMP) ; un dossier au préfixe du script, un autre nom, un dossier dehors.
    const tmp = path.join(dossier, "tmp-harnais");
    for (const d of [path.join(tmp, "opencode-omo-build-a"), path.join(tmp, "autre"), path.join(dossier, "opencode-omo-build-dehors")]) {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "x.txt"), "a garder sauf au prefixe du script, sous TMP");
    }
    const r = await executer(
      PS51 ?? "",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fichierHarnais, "-Script", SCRIPT, "-Cases", fichierCas, "-ResultFile", fichierSortie],
      { ...process.env, TMP: tmp, TEMP: tmp },
    );
    assert.equal(r.code, 0, r.sortie);
    harnais = JSON.parse(fs.readFileSync(fichierSortie, "utf8")) as Record<string, unknown>;
  }

  before(async () => {
    racine = fs.mkdtempSync(path.join(os.tmpdir(), "l15b-"));
    await Promise.all([
      lancerHarnais(),
      lancerDryRun("amorcage", ["-BaseImage", BASE, "-DryRun", "-AcceptManifest"]),
      lancerDryRun("normal-amorce", ["-BaseImage", BASE, "-DryRun"]),
      lancerDryRun("normal", ["-BaseImage", BASE, "-DryRun"], { reference: REFERENCE_VALIDE }),
      lancerDryRun("selftest", ["-BaseImage", BASE, "-DryRun", "-SelfTest"]),
      lancerDryRun("lockfile", ["-BaseImage", BASE, "-DryRun", "-UpdateLock"]),
      lancerDryRun("base-etiquette", ["-BaseImage", "opencode-cockpit/opencode:local", "-DryRun"]),
      lancerDryRun("base-absente", ["-DryRun"]),
      lancerDryRun("modes", ["-BaseImage", BASE, "-DryRun", "-UpdateLock", "-SelfTest"]),
      lancerDryRun("sortie-depot", ["-BaseImage", BASE, "-DryRun", "-AcceptManifest"], { sortieDansDepot: true }),
      lancerDryRun("lock-sans-integrite", ["-BaseImage", BASE, "-DryRun"], { reference: REFERENCE_VALIDE, lock: lockfile({ integrity: undefined }) }),
      lancerDryRun("package-plage", ["-BaseImage", BASE, "-DryRun", "-AcceptManifest"], { packageJson: JSON.stringify({ dependencies: { "oh-my-openagent": "^4.19.4" } }) }),
      lancerDryRun("parametre-inconnu", ["-BaseImage", BASE, "-DryRn"]),
      lancerDryRun("reference-hors-format", ["-BaseImage", BASE, "-DryRun"], { reference: "cat: /opt/omo: No such file or directory\n" }),
    ]);
  });

  after(() => {
    if (racine) fs.rmSync(racine, { recursive: true, force: true });
  });

  const exec = (nom: string): Execution => {
    const e = executions.get(nom);
    assert.ok(e, `exécution ${nom} absente`);
    return e;
  };
  const lignes = (e: Execution, prefixe: string): string[] => e.sortie.split(/\r?\n/).filter((l) => l.startsWith(prefixe));
  const valeur = <T>(cle: string): T => {
    assert.ok(cle in harnais, `résultat ${cle} absent du harnais`);
    return harnais[cle] as T;
  };

  it("ParseFile sans erreur ; fonctions pures et étapes chargées depuis l'arbre syntaxique", () => {
    assert.equal(valeur<number>("parseErrors"), 0);
    const fonctions = valeur<string>("functions").split(",");
    for (const f of ["Test-OmoBaseImage", "Get-OmoAuditVerdict", "Get-OmoManifestProblems", "Invoke-OmoDocker", "Invoke-OmoBootstrap", "Invoke-OmoMain"]) assert.ok(fonctions.includes(f), f);
  });

  it("-BaseImage : empreinte @sha256 en minuscules obligatoire, nom docker valide, rien d'autre", () => {
    assert.deepEqual(valeur<boolean[]>("baseImage"), [true, true, true, false, false, false, false, false, false, false]);
  });

  it("D7 b : ENV de la base sans OPENCODE_DISABLE_MODELS_FETCH=1 et npm_config_offline=true (noms sensibles à la casse) → refus ; ENV illisible → refus", () => {
    assert.deepEqual(valeur<string[]>("baseFlags"), [
      "",
      "OPENCODE_DISABLE_MODELS_FETCH=1 absent de l ENV de l image de base | npm_config_offline=true absent de l ENV de l image de base",
      "npm_config_offline vaut false dans l image de base, true attendu",
      "OPENCODE_DISABLE_MODELS_FETCH=1 absent de l ENV de l image de base | npm_config_offline=true absent de l ENV de l image de base",
      "OPENCODE_DISABLE_MODELS_FETCH=1 absent de l ENV de l image de base | npm_config_offline=true absent de l ENV de l image de base",
      "ENV de l image de base illisible",
    ]);
  });

  it("contrat lu à l'exécution : chemins égaux à contrat-salle.json ; chemin relatif, .., périmètre vide ou JSON invalide refusés", () => {
    assert.deepEqual(valeur<Record<string, unknown>>("contract"), {
      valider: CONTRAT.cheminsImage.valider,
      manifeste: CONTRAT.cheminsImage.manifeste,
      extension: CONTRAT.cheminsImage.extension,
      reference: CONTRAT.cheminsImage.referenceManifeste,
      perimetre: CONTRAT.perimetreManifeste,
    });
    for (const r of valeur<string[]>("contractBad")) assert.match(r, /^ERREUR: contrat-salle\.json/);
  });

  it("utilitaires : dossier dans le dépôt, arguments de docker.exe, texte affichable, secrets masqués", () => {
    assert.deepEqual(valeur<boolean[]>("inside"), [true, true, false, false]);
    assert.deepEqual(valeur<string[]>("argText"), ["simple", '"a b"', '"C:\\x y\\\\"', '""', '"dit \\"oui\\""']);
    assert.deepEqual(valeur<string[]>("safeText"), ["abc", "???", "01234567890123456789..."]);
    const masques = valeur<string[]>("hide");
    assert.equal(masques[0]?.includes("motdepasse-factice"), false);
    assert.equal(masques[0]?.includes("****"), true);
    assert.equal(masques[1]?.includes("abcdef"), false);
    assert.equal(masques[2], "rien a masquer");
  });

  it("manifeste : même verdict que supervisor-lib (ok, amorce, écart ; commentaires et blancs de fin ignorés, ordre compté)", () => {
    assert.deepEqual(valeur<string[]>("manifestCompare"), ["ok", "amorce", "ecart", "ecart", "ecart"]);
    // « # amorce » précédé d'espaces : ligne utile pour supervisor-lib aussi (trimEnd seulement), donc pas une amorce.
    assert.deepEqual(valeur<boolean[]>("amorce"), [true, true, false, false, false]);
  });

  it("manifeste : lignes de manifest.sh seulement, tout le périmètre couvert, rien hors du périmètre ; entrées à root, sans écriture pour node", () => {
    const p = valeur<string[]>("manifestProblems");
    assert.equal(p[0], "");
    assert.match(p[1] ?? "", /chemin hors du perimetre : \/etc\/omo-reference\/omo-manifest\.sha256/);
    assert.equal(p[2], `aucune entree pour ${PREMIERE_RACINE}`);
    assert.match(p[3] ?? "", /ligne hors format/);
    assert.match(p[4] ?? "", /chemin en double/);
    assert.equal(p[5], "manifeste vide");
    assert.equal(p[6], "", "lien (quel que soit son propriétaire) et bit collant admis");
    for (const i of [7, 8, 9, 10]) assert.match(p[i] ?? "", /^entree hors de root, inscriptible par le groupe ou les autres, ou setuid : meta /, String(i));
    assert.equal(p[11], "", "écriture du seul propriétaire root admise");
    assert.equal(p[12], `chemin en double : ${PREMIERE_RACINE}/fichier`, "empreinte en double");
    assert.equal(p[13], `chemin en double : ${PREMIERE_RACINE}/fichier`, "ligne meta en double");
  });

  it("journal de construction : npm ci --ignore-scripts exigé, rejoué, sans script de cycle de vie", () => {
    const p = valeur<string[]>("buildLog");
    assert.equal(p[0], "");
    assert.match(p[1] ?? "", /npm ci sans --ignore-scripts/);
    assert.match(p[2] ?? "", /npm install au lieu de npm ci/);
    assert.match(p[3] ?? "", /en cache/);
    assert.match(p[4] ?? "", /script de cycle de vie au journal/);
    assert.match(p[5] ?? "", /script de cycle de vie au journal/);
    assert.match(p[6] ?? "", /script de cycle de vie au journal/);
    assert.equal(p[7], "aucune etape npm ci --ignore-scripts au journal");
    assert.equal(p[8], "");
    assert.equal(p[9], "npm ci sans --ignore-scripts (etape #5)", "chaque appel de npm porte son propre --ignore-scripts");
    assert.equal(p[10], "npm install au lieu de npm ci (etape #5)");
    assert.match(p[11] ?? "", /npm ci sans --ignore-scripts/);
  });

  it("package.json : oh-my-openagent épinglé exactement, aucune plage, aucune autre section", () => {
    const p = valeur<string[]>("packageJson");
    assert.equal(p[0], "");
    assert.match(p[1] ?? "", /doit etre epingle exactement/);
    assert.match(p[2] ?? "", /version non epinglee : autre/);
    assert.match(p[3] ?? "", /section refusee dans package\.json : devDependencies/);
    assert.match(p[4] ?? "", /sans dependencies/);
    assert.match(p[5] ?? "", /illisible/);
    assert.equal(p[6], "section refusee dans package.json : overrides");
    assert.equal(p[7], "section refusee dans package.json : scripts");
    assert.equal(p[8], "section refusee dans package.json : workspaces");
  });

  it("lockfile : intégrité sha512 et registre npm en HTTPS pour chaque paquet, aucun lien, version épinglée, clé racine vide lue", () => {
    const p = valeur<string[]>("lockfile");
    assert.equal(p[0], "");
    assert.match(p[1] ?? "", /integrite sha512 absente/);
    assert.match(p[2] ?? "", /integrite sha512 absente/);
    assert.match(p[3] ?? "", /source hors du registre npm/);
    assert.match(p[4] ?? "", /lien local refuse/);
    assert.match(p[5] ?? "", /absent du lockfile/);
    assert.match(p[6] ?? "", /lockfileVersion 2 ou 3/);
    assert.equal(p[7], "");
    assert.match(p[8] ?? "", /illisible/);
  });

  it("audit-baseline.json relue par le script : clés fermées, bon paquet, entrées complètes", () => {
    const p = valeur<string[]>("baseline");
    assert.equal(p[0], "accepte:0");
    assert.match(p[1] ?? "", /^ERREUR: audit-baseline\.json : cles attendues/);
    assert.match(p[2] ?? "", /^ERREUR: audit-baseline\.json ne porte pas sur/);
    assert.equal(p[3], "accepte:1");
    assert.match(p[4] ?? "", /^ERREUR: audit-baseline\.json : alerte acceptee mal formee/);
    assert.match(p[5] ?? "", /^ERREUR: audit-baseline\.json : alertesAcceptees doit etre un tableau/);
  });

  it("npm audit : alerte haute ou critique nouvelle détectée, acceptée seulement par paquet ET avis, rapport douteux refusé", () => {
    const a = valeur<Array<{ probleme: string; nouvelles: string; acceptees: string; mineures: number }>>("audit");
    assert.deepEqual(a[0], { probleme: "", nouvelles: "", acceptees: "", mineures: 0 });
    assert.deepEqual(a[1], { probleme: "", nouvelles: "exemple GHSA-abcd-efgh-ijkm (high)", acceptees: "", mineures: 0 });
    assert.deepEqual(a[2], { probleme: "", nouvelles: "", acceptees: "exemple GHSA-abcd-efgh-ijkm (high)", mineures: 0 });
    assert.deepEqual(a[3], { probleme: "", nouvelles: "exemple GHSA-abcd-efgh-ijkm (critical)", acceptees: "", mineures: 0 });
    assert.deepEqual(a[4], { probleme: "", nouvelles: "", acceptees: "", mineures: 1 });
    assert.deepEqual(a[5], { probleme: "", nouvelles: "exemple GHSA-abcd-efgh-ijkm (high)", acceptees: "", mineures: 0 });
    assert.match(a[6]?.probleme ?? "", /npm audit a echoue : ENOAUDIT/);
    assert.match(a[7]?.probleme ?? "", /rapport illisible/);
    assert.match(a[8]?.probleme ?? "", /compteurs incoherents/);
    assert.match(a[9]?.probleme ?? "", /format de rapport inattendu/);
  });

  it("-SelfTest : mutations du script = mutations rejouées en JavaScript ; ancre absente ou cas inconnu refusés", () => {
    const m = valeur<string[]>("mutation");
    assert.equal(m[0], muter(jsoncSynthetique(), "hook-faux"));
    assert.equal(m[1], muter(jsoncSynthetique(), "cle-inconnue"));
    assert.equal(m[2], muter(jsoncSynthetique(), "valeur-retiree"));
    assert.equal(m[3], muter(jsoncSynthetique(true), "valeur-retiree"));
    assert.match(m[4] ?? "", /^ERREUR: omo\.jsonc : ancre de la mutation hook-faux introuvable/);
    assert.match(m[5] ?? "", /^ERREUR: omo\.jsonc : ancre de la mutation valeur-retiree introuvable/);
    assert.match(m[6] ?? "", /^ERREUR: Cas d auto-test inconnu/);
  });

  it("-SelfTest : un refus ne compte qu'à l'étape de validation du Dockerfile, en erreur, avec un message qui cite la mutation", () => {
    assert.deepEqual(valeur<string[]>("selfTestMarker").slice(0, 3), CAS.map(marqueur));
    assert.match(valeur<string[]>("selfTestMarker")[3] ?? "", /^ERREUR: Cas d auto-test inconnu : temoin/);
    // refus prouvé ; autre mutation citée ; étape sans ERROR ; ERROR d'une autre étape ; autre validateur ; panne de npm ci ;
    // mutation citée seulement par une autre étape.
    assert.deepEqual(valeur<boolean[]>("selfTestRefusal"), [true, false, false, false, false, false, false]);
  });

  it("empreintes : une copie ou une écriture dont Get-FileHash ne retrouve pas l'empreinte est refusée", () => {
    assert.match(valeur<string>("copyCorrupt"), /^ERREUR: Copie non verifiee par empreinte : .*copie-corrompu\.bin$/);
    assert.match(valeur<string>("writeCorrupt"), /^ERREUR: Ecriture non verifiee par empreinte : .*ecrit-corrompu\.bin$/);
  });

  it("dossiers temporaires retirés seulement sous TMP et au préfixe du script ; tout autre dossier gardé", () => {
    assert.deepEqual(valeur<boolean[]>("workDirs"), [false, true, true]);
  });

  it("fichier .sha256 : trois lignes LF (archive, image-id, image) ; toute valeur hors format refusée, rien n'est écrit", () => {
    assert.equal(
      valeur<string>("checksum"),
      `${"ab".repeat(32)}  opencode-cockpit-omo-4.19.4-20260919-101500.tar.gz\nimage-id sha256:${"cd".repeat(32)}\nimage opencode-cockpit/opencode-omo:4.19.4-20260919-101500\n`,
    );
    const refus = valeur<string[]>("checksumBad");
    assert.equal(refus.length, 4);
    for (const r of refus) assert.match(r, /^ERREUR: Fichier \.sha256 : valeur hors format/);
  });

  it("gzip et fichiers : aller-retour vérifié par empreinte, archive abîmée refusée, jamais d'écrasement", () => {
    assert.equal(valeur<boolean>("gzipOk"), true);
    assert.notEqual(valeur<string>("gzipBroken"), "True");
    assert.equal(valeur<string>("gzipOther"), "False", "archive valide d'un autre contenu : empreintes différentes");
    assert.match(valeur<string>("gzipNoOverwrite"), /^ERREUR: /);
    assert.equal(valeur<string>("verified"), "ok");
    assert.match(valeur<string>("saveExisting"), /^ERREUR: Fichier deja present, jamais ecrase : .*deja\.tar\.gz\.sha256$/);
    assert.equal(valeur<string>("saveExistingKept"), "a garder");
    assert.match(valeur<string>("saveBadGzip"), /^ERREUR: Archive compressee differente de la sortie de docker save : .*abime-save\.tar\.gz$/);
    assert.equal(valeur<number>("saveBadGzipLeft"), 0, "ni .tar, ni archive, ni .sha256 laissés");
  });

  it("dossiers temporaires : un lien est refusé à la copie et retiré seul à la suppression, sa cible intacte", () => {
    assert.match(valeur<string>("copyLink"), /^ERREUR: Lien refuse dans le contexte de construction/);
    assert.equal(valeur<string>("removeLink"), "cible intacte");
  });

  it("-DryRun -AcceptManifest : les deux constructions de l'amorçage et toute la suite affichées, Docker jamais lancé, rien écrit", () => {
    const e = exec("amorcage");
    assert.equal(e.code, 0, e.sortie);
    assert.equal(e.dockerAppele, false);
    assert.equal(e.sortieCreee, false);
    assert.equal(e.referenceApres, e.referenceAvant);
    const docker = lignes(e, "[simulation] docker ");
    const builds = docker.filter((l) => l.startsWith("[simulation] docker build "));
    assert.equal(builds.length, 2);
    assert.match(builds[0] ?? "", /--tag opencode-cockpit\/opencode-omo:4\.19\.4-\d{8}-\d{6}-construction1 /);
    assert.match(builds[1] ?? "", /--tag opencode-cockpit\/opencode-omo:4\.19\.4-\d{8}-\d{6} /);
    for (const b of builds) {
      assert.match(b, /^\[simulation\] docker build --no-cache --progress=plain --provenance=false --build-arg OPENCODE_BASE=/);
      assert.ok(b.includes(`OPENCODE_BASE=${BASE} `));
    }
    const runs = docker.filter((l) => l.startsWith("[simulation] docker run "));
    for (const r of runs) assert.match(r, /--cap-drop ALL --security-opt no-new-privileges:true/);
    for (const r of runs.filter((l) => !l.includes(BASE))) assert.match(r, /^\[simulation\] docker run --rm --network none /, r);
    const indice = (motif: RegExp): number => e.sortie.split(/\r?\n/).findIndex((l) => motif.test(l));
    const ordre = [
      indice(/docker build .*-construction1 /),
      indice(new RegExp(`--entrypoint ${CONTRAT.cheminsImage.manifeste} `)),
      indice(/\[simulation\] ecriture de la reference/),
      indice(/docker build .*:4\.19\.4-\d{8}-\d{6} --file/),
      indice(new RegExp(`--entrypoint cat \\S+ ${CONTRAT.cheminsImage.referenceManifeste}$`)),
      indice(/audit --omit=dev --json$/),
      indice(new RegExp(`--entrypoint npm \\S+ ls --all --json --omit=dev --prefix ${CONTRAT.cheminsImage.extension}$`)),
      indice(new RegExp(`--entrypoint node \\S+ ${CONTRAT.cheminsImage.valider} --construction$`)),
      indice(/\[simulation\] docker save --output /),
    ];
    assert.equal(ordre.includes(-1), false, JSON.stringify(ordre));
    assert.deepEqual([...ordre].sort((x, y) => x - y), ordre);
    assert.equal(lignes(e, "[simulation] docker run").filter((l) => l.includes(`--entrypoint ${CONTRAT.cheminsImage.manifeste} `)).length, 2);
    assert.match(e.sortie, /\[simulation\] docker image rm opencode-cockpit\/opencode-omo:4\.19\.4-\d{8}-\d{6}-construction1/);
  });

  it("-DryRun : une construction, manifeste comparé à la référence ; amorce refusée avant toute construction", () => {
    const e = exec("normal");
    assert.equal(e.code, 0, e.sortie);
    assert.equal(e.dockerAppele, false);
    assert.equal(e.sortieCreee, false);
    assert.equal(lignes(e, "[simulation] docker build ").length, 1);
    assert.equal(lignes(e, "[simulation] docker save ").length, 1);
    const amorce = exec("normal-amorce");
    assert.equal(amorce.code, 1);
    assert.match(amorce.sortie, /ARRET : omo-manifest\.sha256 est encore l amorce : lancez d abord ce script avec -AcceptManifest/);
    assert.equal(lignes(amorce, "[simulation] docker build").length, 0);
    assert.equal(amorce.dockerAppele, false);
  });

  it("-DryRun -SelfTest : témoin et trois mutations construits, témoin seul validé sans réseau, Docker jamais lancé", () => {
    const e = exec("selftest");
    assert.equal(e.code, 0, e.sortie);
    assert.equal(e.dockerAppele, false);
    const builds = lignes(e, "[simulation] docker build ");
    assert.deepEqual(
      builds.map((b) => /:selftest-\d{8}-\d{6}-(\S+) /.exec(b)?.[1]),
      ["temoin", "hook-faux", "cle-inconnue", "valeur-retiree"],
    );
    const validations = lignes(e, "[simulation] docker run --rm --network none ").filter((l) => l.includes(`--entrypoint node `) && l.endsWith(`${VALIDER} --construction`));
    assert.equal(validations.length, 1);
    assert.match(validations[0] ?? "", /:selftest-\d{8}-\d{6}-temoin /);
    assert.match(e.sortie, /verdicts non evalues/);
  });

  it("-DryRun -UpdateLock : npm install --package-lock-only --ignore-scripts dans l'image de base, lockfile inchangé", () => {
    const e = exec("lockfile");
    assert.equal(e.code, 0, e.sortie);
    assert.equal(e.dockerAppele, false);
    assert.equal(e.lockApres, e.lockAvant);
    const run = lignes(e, "[simulation] docker run ");
    assert.equal(run.length, 1);
    assert.match(run[0] ?? "", new RegExp(`--entrypoint npm ${BASE.replaceAll(".", "\\.")} install --package-lock-only --ignore-scripts --no-audit --no-fund$`));
    assert.match(run[0] ?? "", /:\/omo-lock -w \/omo-lock /);
  });

  it("refus avant tout Docker : étiquette sans empreinte, image absente, modes combinés, sortie dans le dépôt, lockfile ou package.json douteux, paramètre inconnu", () => {
    const attendus: Array<[string, RegExp]> = [
      ["base-etiquette", /ARRET : -BaseImage refusee : une empreinte @sha256/],
      ["base-absente", /ARRET : -BaseImage est obligatoire/],
      ["modes", /ARRET : -UpdateLock, -SelfTest et -AcceptManifest ne se combinent pas/],
      ["sortie-depot", /ARRET : -OutDir refuse : .* est dans le depot/],
      ["lock-sans-integrite", /integrite sha512 absente : node_modules\/oh-my-openagent/],
      ["package-plage", /oh-my-openagent doit etre epingle exactement en 4\.19\.4/],
      ["parametre-inconnu", /DryRn/],
      ["reference-hors-format", /ARRET : omo-manifest\.sha256 hors format : relancez -AcceptManifest/],
    ];
    for (const [nom, motif] of attendus) {
      const e = exec(nom);
      assert.notEqual(e.code, 0, nom);
      assert.match(e.sortie, motif, nom);
      assert.equal(e.dockerAppele, false, nom);
      assert.equal(lignes(e, "[simulation] docker build").length, 0, nom);
      assert.equal(e.referenceApres, e.referenceAvant, nom);
    }
  });
}

// --- Déroulé réel avec un faux docker scripté : les gardes qui suivent une construction -------------------------------------------

/**
 * Faux docker (CommonJS). Journalise chaque appel (et, pour `build`, le omo.jsonc du contexte) ; la première règle dont le motif
 * correspond aux arguments joints et dont `max` n'est pas atteint répond ; `sortie` écrit le fichier de `--output` ; `montage`
 * écrit des fichiers dans le dossier hôte du `-v`.
 */
const FAUX_DOCKER = [
  "const fs = require('node:fs');",
  "const s = JSON.parse(fs.readFileSync(process.env.L15B_SCENARIO, 'utf8'));",
  "const fEtat = process.env.L15B_SCENARIO + '.etat';",
  "const etat = fs.existsSync(fEtat) ? JSON.parse(fs.readFileSync(fEtat, 'utf8')) : {};",
  "const args = process.argv.slice(2);",
  "const joint = args.join(' ');",
  "const entree = { args };",
  "if (args[0] === 'build') { try { entree.omoJsonc = fs.readFileSync(args[args.length - 1] + '/omo.jsonc', 'utf8'); } catch { entree.omoJsonc = null; } }",
  "fs.appendFileSync(s.journal, JSON.stringify(entree) + String.fromCharCode(10));",
  "const i = s.regles.findIndex((r, n) => new RegExp(r.motif).test(joint) && (r.max === undefined || (etat[n] || 0) < r.max));",
  "if (i < 0) { process.stderr.write('faux docker : aucune regle pour ' + joint); process.exitCode = 99; }",
  "else {",
  "  const r = s.regles[i];",
  "  etat[i] = (etat[i] || 0) + 1;",
  "  fs.writeFileSync(fEtat, JSON.stringify(etat));",
  "  if (r.sortie !== undefined) fs.writeFileSync(args[args.indexOf('--output') + 1], r.sortie);",
  "  if (r.montage) { const v = args[args.indexOf('-v') + 1]; const hote = v.slice(0, v.lastIndexOf(':/')); for (const [nom, texte] of Object.entries(r.montage)) fs.writeFileSync(hote + '/' + nom, texte); }",
  "  if (r.stdout) process.stdout.write(r.stdout);",
  "  if (r.stderr) process.stderr.write(r.stderr);",
  "  process.exitCode = r.code || 0;",
  "}",
].join("\n");

interface Regle {
  motif: string;
  stdout?: string;
  stderr?: string;
  code?: number;
  max?: number;
  sortie?: string;
  montage?: Record<string, string>;
}

const ID_1 = `sha256:${"1".repeat(64)}`;
const ID_2 = `sha256:${"2".repeat(64)}`;
const JOURNAL_OK = "#5 [2/6] RUN npm ci --ignore-scripts --no-audit --no-fund --omit=dev\n#5 1.20 added 3 packages in 1s\n#5 DONE 1.4s\n";
const MANIFESTE_AUTRE = `f${REFERENCE_VALIDE.slice(1)}`;
const MANIFESTE_RE = CONTRAT.cheminsImage.manifeste.replaceAll(".", "\\.");
const SORTIE_SAVE = "[synthétique] contenu de docker save\n".repeat(200);
const regle = (motif: string, reponse: Omit<Regle, "motif"> = {}): Regle => ({ motif, ...reponse });
const VERSION = regle("^version ", { stdout: "29.8.0\n" });
/** D7 b : ENV d'une base 1.0.6, lu par docker image inspect avant toute construction ; en tête de chaque scénario. */
const BASE_ENV = regle("^image inspect --format \\{\\{json \\.Config\\.Env\\}\\} ", { stdout: `${JSON.stringify(ENV_BASE_106)}\n` });
const IMAGE_RM = regle("^image rm ");
const CONSTRUCTIONS_AMORCAGE = [
  regle("^build .*-construction1 ", { stderr: JOURNAL_OK }),
  regle("^build ", { stderr: JOURNAL_OK }),
  regle("^image inspect --format \\{\\{\\.Id\\}\\} \\S+-construction1$", { stdout: `${ID_1}\n` }),
  regle("^image inspect --format \\{\\{\\.Id\\}\\} ", { stdout: `${ID_2}\n` }),
];
const SBOM_OK = JSON.stringify({ name: "opencode-omo", dependencies: { "oh-my-openagent": { version: "4.19.4" } } });

/** Déroulé normal complet jusqu'à la réponse de `docker save` ; `remplace` substitue les règles de même motif. */
function deroule(remplace: readonly Regle[] = [], avant: readonly Regle[] = []): Regle[] {
  const base = [
    VERSION,
    regle("^build ", { stderr: JOURNAL_OK }),
    regle("^image inspect ", { stdout: `${ID_2}\n` }),
    regle(" audit --omit=dev --json$", { stdout: audit({}) }),
    regle(" ls --all --json --omit=dev --prefix ", { stdout: SBOM_OK }),
    regle(`--entrypoint node ${ID_2} `, { stdout: "validation : ok\n" }),
    regle(`--entrypoint ${MANIFESTE_RE} ${ID_2}$`, { stdout: REFERENCE_VALIDE }),
    regle(`--entrypoint cat ${ID_2} `, { stdout: REFERENCE_VALIDE }),
    regle("^save --output ", { sortie: SORTIE_SAVE }),
  ];
  return [...avant, ...base.map((r) => remplace.find((x) => x.motif === r.motif) ?? r)];
}

interface ExecutionReelle {
  code: number;
  sortie: string;
  appels: string[][];
  contextes: Array<{ contexte: string; omoJsonc: string | null }>;
  reference: string;
  lock: string | null;
  omoJsoncIntact: boolean;
  dossierSortie: string;
  sortieFichiers: string[];
}

function suiteFauxDocker(): void {
  let racine = "";
  const resultats = new Map<string, ExecutionReelle>();

  /** `sansDocker` : PATH réduit au dossier système de Windows, où aucun docker n'est installé. */
  async function lancerReel(
    nom: string,
    args: readonly string[],
    reglesScenario: readonly Regle[],
    options: { reference?: string; lock?: string | null; sansDocker?: boolean; baseEnv?: Regle } = {},
  ): Promise<void> {
    // D7 b : la lecture de l'ENV de la base répond d'abord (une base 1.0.6, sauf scénario qui en donne une autre).
    const regles = [options.baseEnv ?? BASE_ENV, ...reglesScenario];
    const dossier = path.join(racine, nom);
    const depot = depotSynthetique(dossier, options);
    const omo = path.join(depot, "docker", "opencode-omo");
    const journal = path.join(dossier, "appels.jsonl");
    const scenario = path.join(dossier, "scenario.json");
    fs.writeFileSync(journal, "");
    fs.writeFileSync(scenario, JSON.stringify({ journal, regles }));
    const sortie = path.join(dossier, "sortie");
    const avant = fs.readFileSync(path.join(omo, "omo.jsonc"), "utf8");
    const cle = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    const systeme = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
    const chemins = options.sansDocker ? systeme : `${path.join(racine, "faux-docker")};${process.env[cle] ?? ""}`;
    const env = { ...process.env, [cle]: chemins, L15B_SCENARIO: scenario };
    const script = path.join(depot, "scripts", "build-omo-image.ps1");
    const r = await executer(PS51 ?? "", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-BaseImage", BASE, ...args, "-OutDir", sortie], env);
    const entrees = fs
      .readFileSync(journal, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as { args: string[]; omoJsonc?: string | null });
    resultats.set(nom, {
      ...r,
      appels: entrees.map((e) => e.args),
      contextes: entrees.filter((e) => e.args[0] === "build").map((e) => ({ contexte: e.args[e.args.length - 1] ?? "", omoJsonc: e.omoJsonc ?? null })),
      reference: fs.readFileSync(path.join(omo, "omo-manifest.sha256"), "utf8"),
      lock: fs.existsSync(path.join(omo, "package-lock.json")) ? fs.readFileSync(path.join(omo, "package-lock.json"), "utf8") : null,
      omoJsoncIntact: fs.readFileSync(path.join(omo, "omo.jsonc"), "utf8") === avant,
      dossierSortie: sortie,
      sortieFichiers: fs.existsSync(sortie) ? fs.readdirSync(sortie).map((f) => f.replace(/\d{8}-\d{6}/, "<date>")).sort() : [],
    });
  }

  before(async () => {
    racine = fs.mkdtempSync(path.join(os.tmpdir(), "l15b-reel-"));
    // Un seul faux docker pour tous les scénarios, chacun désigné par L15B_SCENARIO. Mesuré sur ce poste : un lancement sur une
    // quinzaine environ (cmd.exe puis node, sous powershell.exe) attend ~5 s avant de démarrer, avec ou sans parallélisme ; cela
    // ne coûte que du temps, jamais un résultat.
    const faux = path.join(racine, "faux-docker");
    fs.mkdirSync(faux);
    fs.writeFileSync(path.join(faux, "faux-docker.cjs"), FAUX_DOCKER);
    fs.writeFileSync(path.join(faux, "docker.cmd"), `@echo off\r\n"${process.execPath}" "${path.join(faux, "faux-docker.cjs")}" %*\r\nexit /b %ERRORLEVEL%\r\n`);
    const auditHaut = audit({ exemple: vuln("exemple", "high", "GHSA-abcd-efgh-ijkm") }, { high: 1 });
    /** -SelfTest : chaque mutation refusée à l'étape de validation en la citant, sauf réponse remplacée ; témoin construit. */
    const selfTest = (remplace: Partial<Record<Cas, Omit<Regle, "motif">>> = {}, validationTemoin = 0): Regle[] => [
      VERSION,
      ...CAS.map((cas) => regle(`^build .*:selftest-\\S+-${cas} `, remplace[cas] ?? { stderr: `${journalRefus(marqueur(cas)).join("\n")}\n`, code: 1 })),
      regle("^build ", { stderr: JOURNAL_OK }),
      regle("--entrypoint node ", { stdout: "[synthétique] validation\n", code: validationTemoin }),
      IMAGE_RM,
    ];
    const lock = (reponse: Omit<Regle, "motif">): Regle[] => [VERSION, regle(" install --package-lock-only --ignore-scripts --no-audit --no-fund$", reponse)];
    const ref = { reference: REFERENCE_VALIDE };
    await Promise.all([
      lancerReel("amorcage-ecart", ["-AcceptManifest"], [
        VERSION,
        ...CONSTRUCTIONS_AMORCAGE,
        regle(`--entrypoint ${MANIFESTE_RE} ${ID_1}$`, { stdout: REFERENCE_VALIDE }),
        regle(`--entrypoint ${MANIFESTE_RE} ${ID_2}$`, { stdout: MANIFESTE_AUTRE }),
        IMAGE_RM,
      ]),
      lancerReel("amorcage-audit", ["-AcceptManifest"], [
        VERSION,
        ...CONSTRUCTIONS_AMORCAGE,
        regle(`--entrypoint ${MANIFESTE_RE} `, { stdout: REFERENCE_VALIDE }),
        regle(`--entrypoint cat ${ID_2} `, { stdout: REFERENCE_VALIDE }),
        regle(" audit --omit=dev --json$", { stdout: auditHaut, code: 1 }),
        IMAGE_RM,
      ]),
      lancerReel("normal-succes", [], deroule(), ref),
      lancerReel("normal-ecart", [], deroule([regle(`--entrypoint ${MANIFESTE_RE} ${ID_2}$`, { stdout: MANIFESTE_AUTRE })]), ref),
      lancerReel("normal-reference-embarquee", [], deroule([regle(`--entrypoint cat ${ID_2} `, { stdout: MANIFESTE_AUTRE })]), ref),
      lancerReel("normal-validation", [], deroule([regle(`--entrypoint node ${ID_2} `, { stderr: "[synthétique] cle inconnue\n", code: 1 })]), ref),
      lancerReel("normal-sbom-code", [], deroule([regle(" ls --all --json --omit=dev --prefix ", { stdout: SBOM_OK, code: 1 })]), ref),
      lancerReel("normal-sbom-version", [], deroule([regle(" ls --all --json --omit=dev --prefix ", { stdout: SBOM_OK.replace("4.19.4", "4.19.3") })]), ref),
      lancerReel("normal-audit-illisible", [], deroule([regle(" audit --omit=dev --json$", { stdout: "npm ERR! [synthétique]\n", code: 1 })]), ref),
      lancerReel("normal-etiquette-avant", [], deroule([], [regle("^image inspect ", { stdout: `${ID_2}\n`, max: 1 }), regle("^image inspect ", { stdout: `${ID_1}\n` })]), ref),
      lancerReel("normal-etiquette-apres", [], deroule([], [regle("^image inspect ", { stdout: `${ID_2}\n`, max: 2 }), regle("^image inspect ", { stdout: `${ID_1}\n` })]), ref),
      lancerReel("journal-cycle-de-vie", [], [VERSION, regle("^build ", { stderr: `${JOURNAL_OK}#5 2.10 > esbuild@0.25.0 postinstall\n` })], ref),
      lancerReel("construction-echec", [], deroule([regle("^build ", { stderr: JOURNAL_PANNE, code: 1 })]), ref),
      lancerReel("identifiant-illisible", [], deroule([regle("^image inspect ", { stdout: "[synthétique] pas un identifiant\n" })]), ref),
      lancerReel("normal-manifeste-code", [], deroule([regle(`--entrypoint ${MANIFESTE_RE} ${ID_2}$`, { stdout: REFERENCE_VALIDE, code: 1 })]), ref),
      lancerReel("normal-save-code", [], deroule([regle("^save --output ", { sortie: SORTIE_SAVE, stderr: "[synthétique] disque plein\n", code: 1 })]), ref),
      lancerReel("amorcage-manifeste-hors-format", ["-AcceptManifest"], [
        VERSION,
        ...CONSTRUCTIONS_AMORCAGE,
        regle(`--entrypoint ${MANIFESTE_RE} `, { stdout: `manifest.sh: [synthétique] ${PREMIERE_RACINE} absent\n` }),
        IMAGE_RM,
      ]),
      lancerReel("docker-muet", [], [regle("^version ", { stderr: "[synthétique] moteur arrêté\n", code: 1 })], ref),
      lancerReel("docker-absent", [], [], { ...ref, sansDocker: true }),
      lancerReel("base-sans-drapeaux", [], deroule(), {
        ...ref,
        baseEnv: regle("^image inspect --format \\{\\{json \\.Config\\.Env\\}\\} ", { stdout: `${JSON.stringify(["PATH=/usr/bin", "OPENCODE_DISABLE_MODELS_FETCH=1"])}\n` }),
      }),
      lancerReel("base-sans-drapeaux-lock", ["-UpdateLock"], lock({ montage: { "package-lock.json": LOCK_REGENERE } }), {
        baseEnv: regle("^image inspect --format \\{\\{json \\.Config\\.Env\\}\\} ", { stdout: `${JSON.stringify(["PATH=/usr/bin"])}\n` }),
      }),
      lancerReel("base-introuvable", [], deroule(), { ...ref, baseEnv: regle("^image inspect --format \\{\\{json \\.Config\\.Env\\}\\} ", { stderr: "Error: No such image\n", code: 1 }) }),
      lancerReel("selftest-mutation-acceptee", ["-SelfTest"], selfTest({ "valeur-retiree": { stderr: JOURNAL_OK } })),
      lancerReel("selftest-vert", ["-SelfTest"], selfTest()),
      lancerReel("selftest-temoin-casse", ["-SelfTest"], selfTest({}, 1)),
      lancerReel("selftest-panne", ["-SelfTest"], selfTest({ "hook-faux": { stderr: JOURNAL_PANNE, code: 1 } })),
      lancerReel("lock-ok", ["-UpdateLock"], lock({ montage: { "package-lock.json": LOCK_REGENERE } })),
      lancerReel("lock-premier", ["-UpdateLock"], lock({ montage: { "package-lock.json": LOCK_REGENERE } }), { lock: null }),
      lancerReel("lock-refuse", ["-UpdateLock"], lock({ montage: { "package-lock.json": lockfile({ integrity: undefined }) } })),
      lancerReel("lock-package-modifie", ["-UpdateLock"], lock({ montage: { "package.json": `${PACKAGE_JSON} ` } })),
      lancerReel("lock-echec", ["-UpdateLock"], lock({ montage: { "package-lock.json": LOCK_REGENERE }, stderr: "[synthétique] npm error\n", code: 1 })),
      lancerReel("lock-rien", ["-UpdateLock"], lock({}), { lock: null }),
    ]);
  });

  after(() => {
    if (racine) fs.rmSync(racine, { recursive: true, force: true });
  });

  const res = (nom: string): ExecutionReelle => {
    const r = resultats.get(nom);
    assert.ok(r, `scénario ${nom} absent`);
    return r;
  };
  const appel = (r: ExecutionReelle, motif: RegExp): string[][] => r.appels.filter((a) => motif.test(a.join(" ")));
  const arret = (nom: string, motif: RegExp): ExecutionReelle => {
    const r = res(nom);
    assert.equal(r.code, 1, r.sortie);
    assert.match(r.sortie, motif);
    return r;
  };
  const fichiers = (...suffixes: string[]): string[] => suffixes.map((s) => `opencode-cockpit-omo-4.19.4-<date>.${s}`).sort();

  it("tout scénario : aucun envoi ni connexion à un registre ; tout conteneur de l'image construite sans réseau ni capacité", () => {
    for (const [nom, r] of resultats) {
      for (const a of r.appels) {
        assert.equal(["push", "login", "tag"].includes(a[0] ?? ""), false, `${nom} : ${a.join(" ")}`);
        if (a[0] !== "run") continue;
        assert.deepEqual(a.slice(0, 2), ["run", "--rm"], nom);
        assert.ok(a.join(" ").includes("--cap-drop ALL --security-opt no-new-privileges:true"), `${nom} : ${a.join(" ")}`);
        if (!a.includes(BASE)) assert.deepEqual(a.slice(2, 4), ["--network", "none"], `${nom} : ${a.join(" ")}`);
        if (a.includes("audit")) assert.match(a[a.indexOf("-v") + 1] ?? "", /:\/omo-audit:ro$/, "lockfile monté en lecture seule pour l'audit");
      }
      for (const b of appel(r, /^build /)) {
        assert.deepEqual(b.slice(0, 6), ["build", "--no-cache", "--progress=plain", "--provenance=false", "--build-arg", `OPENCODE_BASE=${BASE}`], nom);
      }
    }
  });

  it("succès : archive gzip de la sortie de docker save, .sha256 (archive, image-id, image) vérifié, .tar retiré, journaux rangés", () => {
    const r = res("normal-succes");
    assert.equal(r.code, 0, r.sortie);
    assert.match(r.sortie, /== Termine/);
    assert.deepEqual(r.sortieFichiers, fichiers("audit.json", "construction.log", "sbom.json", "tar.gz", "tar.gz.sha256", "validation.log"));
    const [archive] = fs.readdirSync(r.dossierSortie).filter((f) => f.endsWith(".tar.gz"));
    assert.ok(archive);
    const octets = fs.readFileSync(path.join(r.dossierSortie, archive));
    assert.equal(zlib.gunzipSync(octets).toString("utf8"), SORTIE_SAVE);
    const empreinte = crypto.createHash("sha256").update(octets).digest("hex");
    const tag = archive.replace(/^opencode-cockpit-omo-4\.19\.4-/, "opencode-cockpit/opencode-omo:4.19.4-").replace(/\.tar\.gz$/, "");
    assert.equal(fs.readFileSync(path.join(r.dossierSortie, `${archive}.sha256`), "utf8"), `${empreinte}  ${archive}\nimage-id ${ID_2}\nimage ${tag}\n`);
    // D7 b : un « image inspect » de plus, celui de l'ENV de la base ; l'identifiant, lui, est toujours relu trois fois.
    assert.equal(appel(r, /^image inspect --format \{\{\.Id\}\} /).length, 3, "identifiant relu après la construction, avant et après docker save");
    assert.equal(appel(r, /^image inspect --format \{\{json \.Config\.Env\}\} /).length, 1, "ENV de la base lu une fois");
    assert.equal(r.reference, REFERENCE_VALIDE);
  });

  it("-AcceptManifest : manifestes différents entre les deux constructions → arrêt, référence précédente restaurée, rien d'autre lancé", () => {
    const r = arret("amorcage-ecart", /ARRET : Manifestes differents entre les deux constructions/);
    assert.match(r.sortie, /reference precedente restauree/);
    assert.equal(r.reference, "# amorce\n");
    assert.equal(appel(r, /^build /).length, 2);
    assert.equal(appel(r, / audit | save |--entrypoint node /).length, 0);
    assert.equal(appel(r, /^image rm \S+-construction1$/).length, 1, "image intermédiaire retirée");
  });

  it("-AcceptManifest : référence écrite puis gardée si les deux constructions concordent ; alerte haute nouvelle → arrêt avant SBOM et validation", () => {
    const r = arret("amorcage-audit", /ARRET : Alerte haute nouvelle : construction arretee/);
    assert.match(r.sortie, /exemple GHSA-abcd-efgh-ijkm \(high\)/);
    const lignesRef = r.reference.split("\n");
    assert.match(lignesRef[0] ?? "", /^# Reference du manifeste de l image opencode-omo 4\.19\.4 \(D-2b-32\)/);
    assert.equal(lignesRef[1], `# Image de base : ${BASE}`);
    assert.equal(lignesRef.slice(2).join("\n"), REFERENCE_VALIDE);
    assert.equal(appel(r, /--entrypoint cat sha256:2{64} /).length, 1, "référence copiée dans l'image comparée");
    assert.equal(appel(r, / ls --all |--entrypoint node | save /).length, 0);
    assert.deepEqual(r.sortieFichiers, fichiers("audit.json", "construction.log", "construction1.log"));
  });

  it("déroulé normal : chaque contrôle après la construction arrête avant l'archive", () => {
    const cas: Array<[string, RegExp]> = [
      ["normal-ecart", /ARRET : Manifeste de l image different de la reference commitee/],
      ["normal-reference-embarquee", /ARRET : La reference copiee dans l image \(\/etc\/omo-reference\/omo-manifest\.sha256\) differe/],
      ["normal-validation", /ARRET : Validation en echec \(code 1\)/],
      ["normal-sbom-code", /ARRET : npm ls signale un arbre incoherent/],
      ["normal-sbom-version", /ARRET : SBOM sans oh-my-openagent 4\.19\.4/],
      ["normal-audit-illisible", /ARRET : Audit npm inexploitable : rapport illisible/],
      ["normal-etiquette-avant", /ARRET : L etiquette ne designe plus l image verifiee/],
    ];
    for (const [nom, motif] of cas) {
      const r = arret(nom, motif);
      assert.equal(appel(r, /^save /).length, 0, nom);
      assert.equal(r.sortieFichiers.some((f) => f.includes(".tar")), false, nom);
    }
    assert.equal(appel(res("normal-validation"), new RegExp(`--entrypoint ${MANIFESTE_RE} `)).length, 0, "validation avant le manifeste");
  });

  it("étiquette déplacée pendant docker save, ou docker save en échec → arrêt, aucun fichier d'archive laissé", () => {
    for (const [nom, motif] of [
      ["normal-etiquette-apres", /ARRET : L etiquette a change pendant docker save/],
      ["normal-save-code", /ARRET : docker save en echec \(code 1\)/],
    ] as const) {
      const r = arret(nom, motif);
      assert.equal(appel(r, /^save /).length, 1, nom);
      assert.equal(r.sortieFichiers.some((f) => f.includes(".tar")), false, `${nom} : ${JSON.stringify(r.sortieFichiers)}`);
    }
  });

  it("journal de construction avec un script de cycle de vie → arrêt juste après la construction", () => {
    const r = arret("journal-cycle-de-vie", /ARRET : Journal de npm ci refuse/);
    assert.match(r.sortie, /script de cycle de vie au journal/);
    // D7 b : l'ENV de la base est lu entre la version et la construction.
    assert.deepEqual(r.appels.map((a) => a[0]), ["version", "image", "build"]);
  });

  it("D7 b : base sans les drapeaux de la 1.0.6 → arrêt avant toute construction et avant le lockfile ; base absente du poste → arrêt, docker pull conseillé", () => {
    const sans = arret("base-sans-drapeaux", /ARRET : -BaseImage refusee : l image de base ne porte pas les drapeaux de la 1\.0\.6/);
    assert.match(sans.sortie, /npm_config_offline=true absent de l ENV de l image de base/);
    assert.deepEqual(sans.appels.map((a) => a.slice(0, 2).join(" ")), ["version --format", "image inspect"]);
    assert.deepEqual(sans.sortieFichiers, []);
    const lock = arret("base-sans-drapeaux-lock", /ARRET : -BaseImage refusee : l image de base ne porte pas les drapeaux de la 1\.0\.6/);
    assert.equal(appel(lock, / install --package-lock-only /).length, 0, "aucun npm lancé");
    const introuvable = arret("base-introuvable", /ARRET : Image de base introuvable sur ce poste : docker pull /);
    assert.equal(appel(introuvable, /^build /).length, 0);
  });

  it("D7 a : lockfile régénéré dans un conteneur de la base où npm n'est plus hors ligne (-e npm_config_offline=false), ENV de la base intact", () => {
    const r = res("lock-ok");
    assert.equal(r.code, 0, r.sortie);
    const run = appel(r, / install --package-lock-only /)[0] ?? [];
    const e = run.indexOf("-e");
    assert.ok(e > 0 && run[e + 1] === "npm_config_offline=false", run.join(" "));
    assert.ok(e < run.indexOf("--entrypoint"), "variable posée pour ce seul conteneur, avant l'image");
  });

  it("arrêts sans archive : Docker absent ou muet, construction en échec, identifiant d'image illisible, calcul du manifeste en échec", () => {
    const absent = arret("docker-absent", /ARRET : Docker introuvable/);
    assert.deepEqual(absent.appels, []);
    assert.deepEqual(arret("docker-muet", /ARRET : Docker ne repond pas/).appels.map((a) => a[0]), ["version"]);
    const construction = arret("construction-echec", /ARRET : Construction opencode-cockpit\/opencode-omo:4\.19\.4-\d{8}-\d{6} en echec \(code 1\)/);
    // D7 b : l'ENV de la base est lu (« image inspect ») entre la version et la construction.
    assert.deepEqual(construction.appels.map((a) => a[0]), ["version", "image", "build"]);
    arret("identifiant-illisible", /ARRET : Identifiant d image illisible : opencode-cockpit\/opencode-omo:4\.19\.4-/);
    const manifeste = arret("normal-manifeste-code", /ARRET : Calcul du manifeste en echec \(code 1\)/);
    for (const r of [construction, res("identifiant-illisible"), manifeste]) assert.equal(appel(r, /^save /).length, 0);
  });

  it("-AcceptManifest : manifeste de la construction 1 hors format → arrêt avant d'écrire la référence, sans seconde construction", () => {
    const r = arret("amorcage-manifeste-hors-format", /ARRET : Manifeste de l image hors format ou hors du perimetre du contrat/);
    assert.match(r.sortie, /ligne hors format : manifest\.sh: /);
    assert.equal(r.reference, "# amorce\n");
    assert.equal(appel(r, /^build /).length, 1);
    assert.equal(appel(r, /^image rm \S+-construction1$/).length, 1, "image intermédiaire retirée");
  });

  it("-SelfTest (G14) : chaque contexte porte sa mutation ; refus exigé à l'étape de validation ; mutation acceptée, témoin cassé ou panne → échec", () => {
    const acceptee = arret("selftest-mutation-acceptee", /ARRET : G14 en echec : construction acceptee malgre la mutation : valeur-retiree/);
    for (const ligne of ["temoin : accepte", "hook-faux : refuse par la validation", "cle-inconnue : refuse par la validation", "valeur-retiree : accepte"]) {
      assert.ok(acceptee.sortie.includes(ligne), ligne);
    }
    assert.equal(appel(acceptee, /^image rm /).length, 2, "images des constructions réussies (témoin, valeur-retiree) retirées");
    const vert = res("selftest-vert");
    assert.equal(vert.code, 0, vert.sortie);
    assert.match(vert.sortie, /G14 vert : temoin accepte ; hook faux, cle inconnue et valeur epinglee retiree refuses par la validation de la construction/);
    const validations = appel(vert, /--entrypoint node /);
    assert.equal(validations.length, 1, "seul le témoin est validé après sa construction");
    assert.match(validations[0]?.join(" ") ?? "", new RegExp(`--entrypoint node \\S+:selftest-\\d{8}-\\d{6}-temoin ${VALIDER.replaceAll(".", "\\.")} --construction$`));
    const temoin = arret("selftest-temoin-casse", /ARRET : Temoin en echec : l auto-test ne prouve rien/);
    assert.ok(temoin.sortie.includes("temoin : validation en echec"));
    const panne = arret("selftest-panne", /ARRET : Auto-test non concluant : echec hors de l etape de validation, ou sans message citant la mutation : hook-faux\r?$/m);
    assert.ok(panne.sortie.includes("hook-faux : echec hors de la validation"));
    const origine = jsoncSynthetique();
    for (const r of [acceptee, vert, temoin, panne]) {
      assert.equal(r.omoJsoncIntact, true, "mutations faites dans des copies temporaires seulement");
      assert.deepEqual(
        r.contextes.map((c) => c.omoJsonc),
        [origine, muter(origine, "hook-faux"), muter(origine, "cle-inconnue"), muter(origine, "valeur-retiree")],
      );
      for (const { contexte } of r.contextes) {
        assert.match(path.basename(path.dirname(contexte)), /^opencode-omo-build-selftest-[0-9a-f]{32}$/);
        assert.equal(fs.existsSync(contexte), false, `copie temporaire retirée : ${contexte}`);
      }
    }
  });

  it("-UpdateLock : lockfile produit contrôlé puis recopié ; lockfile douteux ou package.json modifié → dépôt inchangé", () => {
    const ok = res("lock-ok");
    assert.equal(ok.code, 0, ok.sortie);
    assert.equal(ok.lock, LOCK_REGENERE);
    assert.match(ok.sortie, /lockfile ecrit : .* \(sha256 [0-9a-f]{64}\)/);
    const refuse = arret("lock-refuse", /ARRET : Lockfile produit refuse : docker\\opencode-omo\\package-lock\.json inchange/);
    assert.match(refuse.sortie, /integrite sha512 absente/);
    assert.equal(refuse.lock, lockfile());
    const modifie = arret("lock-package-modifie", /ARRET : npm a modifie package\.json : lockfile refuse/);
    assert.equal(modifie.lock, lockfile());
    const premier = res("lock-premier");
    assert.equal(premier.code, 0, premier.sortie);
    assert.equal(premier.lock, LOCK_REGENERE, "premier lockfile, dépôt sans lockfile");
    const echec = arret("lock-echec", /ARRET : npm install --package-lock-only en echec \(code 1\)/);
    assert.equal(echec.lock, lockfile(), "npm en échec : lockfile du dépôt inchangé, même si un fichier a été écrit");
    const rien = arret("lock-rien", /ARRET : npm n a produit aucun package-lock\.json/);
    assert.equal(rien.lock, null);
    for (const r of [ok, refuse, modifie, premier, echec, rien]) {
      const montage = appel(r, / install --package-lock-only /)[0] ?? [];
      const hote = (montage[montage.indexOf("-v") + 1] ?? "").replace(/:\/omo-lock$/, "");
      assert.match(path.basename(hote), /^opencode-omo-build-lockfile-[0-9a-f]{32}$/);
      assert.equal(fs.existsSync(hote), false, "copie temporaire retirée");
    }
  });
}

// --- Harnais PowerShell : fonctions du script définies depuis leur arbre syntaxique, jamais le corps du script ----------------------

const HARNAIS = [
  "param([string]$Script, [string]$Cases, [string]$ResultFile)",
  "Set-StrictMode -Version Latest",
  "$ErrorActionPreference = 'Stop'",
  "$tokens = $null",
  "$errors = $null",
  "$ast = [System.Management.Automation.Language.Parser]::ParseFile($Script, [ref]$tokens, [ref]$errors)",
  "$names = New-Object System.Collections.Generic.List[string]",
  "foreach ($statement in $ast.EndBlock.Statements) {",
  "    if ($statement -is [System.Management.Automation.Language.FunctionDefinitionAst]) { . ([scriptblock]::Create($statement.Extent.Text)); $names.Add($statement.Name) }",
  "}",
  "$DryRun = $false",
  "$TempPrefix = 'opencode-omo-build-'",
  "function Invoke-Cas([scriptblock]$Block) { try { return [string](& $Block) } catch { return 'ERREUR: ' + $_.Exception.Message } }",
  "$c = ConvertFrom-Json ([System.IO.File]::ReadAllText($Cases, (New-Object System.Text.UTF8Encoding $false)))",
  "$out = @{ parseErrors = @($errors).Count; functions = ($names -join ',') }",
  "$contract = Read-OmoContract ([System.IO.File]::ReadAllText($c.contractFile))",
  "$out['contract'] = [ordered]@{ valider = $contract.Valider; manifeste = $contract.Manifeste; extension = $contract.Extension; reference = $contract.Reference; perimetre = [object[]]$contract.Perimetre }",
  "$out['contractBad'] = @(foreach ($v in @($c.contractBad)) { Invoke-Cas { Read-OmoContract $v | Out-Null; 'accepte' } })",
  "$out['baseImage'] = @(foreach ($v in @($c.baseImage)) { [bool](Test-OmoBaseImage $v) })",
  "$out['baseFlags'] = @(foreach ($v in @($c.baseFlags)) { (@(Get-OmoBaseFlagProblems $v) -join ' | ') })",
  "$out['inside'] = @(foreach ($v in @($c.inside)) { [bool](Test-OmoInside $v.path $v.root) })",
  "$out['argText'] = @(foreach ($v in @($c.argText)) { [string](ConvertTo-OmoArgText $v) })",
  "$out['safeText'] = @(foreach ($v in @($c.safeText)) { [string](Get-OmoSafeText $v 20) })",
  "$out['hide'] = @(foreach ($v in @($c.hide)) { [string](Hide-OmoSecrets $v) })",
  "$out['manifestCompare'] = @(foreach ($v in @($c.manifestCompare)) { [string](Compare-OmoManifest $v.current $v.reference) })",
  "$out['amorce'] = @(foreach ($v in @($c.amorce)) { [bool](Test-OmoAmorce $v) })",
  "$out['manifestProblems'] = @(foreach ($v in @($c.manifestProblems)) { (@(Get-OmoManifestProblems $v $contract.Perimetre) -join ' | ') })",
  "$out['buildLog'] = @(foreach ($v in @($c.buildLog)) { (@(Get-OmoBuildLogProblems ([string[]]@($v))) -join ' | ') })",
  "$out['packageJson'] = @(foreach ($v in @($c.packageJson)) { (@(Get-OmoPackageJsonProblems $v 'oh-my-openagent' '4.19.4') -join ' | ') })",
  "$out['lockfile'] = @(foreach ($v in @($c.lockfile)) { (@(Get-OmoLockfileProblems $v 'oh-my-openagent' '4.19.4') -join ' | ') })",
  "$out['baseline'] = @(foreach ($v in @($c.baseline)) { Invoke-Cas { $r = Read-OmoBaseline $v 'oh-my-openagent' '4.19.4'; 'accepte:' + @($r).Count } })",
  "$out['audit'] = @(foreach ($v in @($c.audit)) {",
  "    $verdict = Get-OmoAuditVerdict $v.json ([object[]]@($v.accepted))",
  "    [ordered]@{ probleme = [string]$verdict.Probleme; nouvelles = (@($verdict.Nouvelles) -join ' | '); acceptees = (@($verdict.Acceptees) -join ' | '); mineures = [int]$verdict.Mineures }",
  "})",
  "$out['mutation'] = @(foreach ($v in @($c.mutation)) { Invoke-Cas { Set-OmoSelfTestMutation $v.text $v.cas } })",
  "$out['selfTestMarker'] = @(foreach ($v in @($c.selfTestMarker)) { Invoke-Cas { Get-OmoSelfTestMarker $v } })",
  "$out['selfTestRefusal'] = @(foreach ($v in @($c.selfTestRefusal)) { [bool](Test-OmoSelfTestRefusal ([string[]]@($v.lines)) $v.valider $v.marker) })",
  "$k = $c.checksum",
  "$out['checksum'] = [string](Format-OmoChecksumFile $k.name $k.sha $k.id $k.tag)",
  "$out['checksumBad'] = @(foreach ($v in @($c.checksumBad)) { Invoke-Cas { Format-OmoChecksumFile $v.name $v.sha $v.id $v.tag } })",
  "$dir = [string]$c.workDir",
  "$src = Join-Path $dir 'source.bin'",
  "$bytes = New-Object byte[] 65536",
  "(New-Object System.Random 42).NextBytes($bytes)",
  "[System.IO.File]::WriteAllBytes($src, $bytes)",
  "$gz = Join-Path $dir 'source.bin.gz'",
  "Compress-OmoGzip $src $gz",
  "$out['gzipOk'] = [bool](Test-OmoGzipRoundTrip $src $gz)",
  "$out['gzipNoOverwrite'] = Invoke-Cas { Compress-OmoGzip $src $gz; 'ecrase' }",
  "$broken = [System.IO.File]::ReadAllBytes($gz)",
  "$broken[30000] = [byte]($broken[30000] -bxor 255)",
  "$bad = Join-Path $dir 'abime.gz'",
  "[System.IO.File]::WriteAllBytes($bad, $broken)",
  "$out['gzipBroken'] = Invoke-Cas { [string](Test-OmoGzipRoundTrip $src $bad) }",
  "$other = Join-Path $dir 'autre.bin'",
  "[System.IO.File]::WriteAllBytes($other, [byte[]](1..100))",
  "Compress-OmoGzip $other (Join-Path $dir 'autre.bin.gz')",
  "$out['gzipOther'] = Invoke-Cas { [string](Test-OmoGzipRoundTrip $src (Join-Path $dir 'autre.bin.gz')) }",
  "$copy = Join-Path $dir 'copie.bin'",
  "$out['verified'] = Invoke-Cas { Copy-OmoFileVerified $src $copy; Write-OmoFileVerified (Join-Path $dir 'ecrit.txt') 'abc'; 'ok' }",
  "# Espion homonyme : Get-FileHash rend une empreinte fausse pour les fichiers '*-corrompu.bin', comme une ecriture abimee.",
  "function Get-FileHash { param([string]$LiteralPath, [System.IO.Stream]$InputStream, [string]$Algorithm = 'SHA256')",
  "    if ($LiteralPath -and $LiteralPath.EndsWith('-corrompu.bin')) { return [pscustomobject]@{ Hash = ('0' * 64) } }",
  "    if ($LiteralPath) { return Microsoft.PowerShell.Utility\\Get-FileHash -LiteralPath $LiteralPath -Algorithm $Algorithm }",
  "    return Microsoft.PowerShell.Utility\\Get-FileHash -InputStream $InputStream -Algorithm $Algorithm",
  "}",
  "$out['copyCorrupt'] = Invoke-Cas { Copy-OmoFileVerified $src (Join-Path $dir 'copie-corrompu.bin'); 'copie' }",
  "$out['writeCorrupt'] = Invoke-Cas { Write-OmoFileVerified (Join-Path $dir 'ecrit-corrompu.bin') 'abc'; 'ecrit' }",
  "Remove-Item -LiteralPath function:Get-FileHash",
  "Remove-OmoWorkDirs @((Join-Path $dir 'tmp-harnais\\opencode-omo-build-a'), (Join-Path $dir 'tmp-harnais\\autre'), (Join-Path $dir 'opencode-omo-build-dehors')) | Out-Null",
  "$out['workDirs'] = @((Test-Path -LiteralPath (Join-Path $dir 'tmp-harnais\\opencode-omo-build-a')), (Test-Path -LiteralPath (Join-Path $dir 'tmp-harnais\\autre')), (Test-Path -LiteralPath (Join-Path $dir 'opencode-omo-build-dehors')))",
  "[System.IO.File]::WriteAllText((Join-Path $dir 'deja.tar.gz.sha256'), 'a garder')",
  "$out['saveExisting'] = Invoke-Cas { Save-OmoArchive 'opencode-cockpit/opencode-omo:x' 'sha256:x' 'deja' $dir | Out-Null; 'ecrase' }",
  "$out['saveExistingKept'] = [System.IO.File]::ReadAllText((Join-Path $dir 'deja.tar.gz.sha256'))",
  "$target = Join-Path $dir 'cible'",
  "$tree = Join-Path $dir 'arbre'",
  "[void][System.IO.Directory]::CreateDirectory($target)",
  "[System.IO.File]::WriteAllText((Join-Path $target 'garde.txt'), 'a garder')",
  "[void][System.IO.Directory]::CreateDirectory($tree)",
  "[void](New-Item -ItemType Junction -Path (Join-Path $tree 'lien') -Value $target)",
  "$out['copyLink'] = Invoke-Cas { Copy-OmoContext $tree (Join-Path $dir 'copie-arbre'); 'copie' }",
  "try { Remove-OmoTree $tree } finally { $junction = Join-Path $tree 'lien'; if (Test-Path -LiteralPath $junction) { [System.IO.Directory]::Delete($junction, $false) } }",
  "if ((Test-Path -LiteralPath $tree) -or -not (Test-Path -LiteralPath (Join-Path $target 'garde.txt'))) { $out['removeLink'] = 'cible touchee ou arbre garde' } else { $out['removeLink'] = 'cible intacte' }",
  "# Espions homonymes (en dernier) : docker save ecrit un .tar, la compression rend une archive gzip valide d un autre contenu.",
  "$realCompress = ${function:Compress-OmoGzip}",
  "function Get-OmoImageId([string]$Reference) { return 'sha256:' + ('1' * 64) }",
  "function Invoke-OmoDocker { param([string[]]$Arguments, [switch]$Stream) [System.IO.File]::WriteAllText($Arguments[2], 'sortie de docker save'); return [pscustomobject]@{ ExitCode = 0; StdOut = ''; Lines = [string[]]@() } }",
  "function Compress-OmoGzip([string]$Source, [string]$Destination) { & $realCompress $other $Destination }",
  "$out['saveBadGzip'] = Invoke-Cas { Save-OmoArchive 'opencode-cockpit/opencode-omo:x' ('sha256:' + ('1' * 64)) 'abime-save' $dir | Out-Null; 'archive' }",
  "$out['saveBadGzipLeft'] = @(Get-ChildItem -LiteralPath $dir -Filter 'abime-save*').Count",
  "[System.IO.File]::WriteAllText($ResultFile, (ConvertTo-Json -InputObject $out -Depth 6 -Compress), (New-Object System.Text.UTF8Encoding $false))",
];

// Les deux suites lancent chacune leurs powershell.exe en parallèle ; elles tournent en même temps pour borner la durée ajoutée.
describe("L15b : Windows PowerShell 5.1 réel", { skip: SAUT_PS, concurrency: true }, () => {
  describe("ParseFile, fonctions pures, -DryRun", suiteDryRun);
  describe("déroulé réel, faux docker scripté (aucun Docker réel)", suiteFauxDocker);
});
