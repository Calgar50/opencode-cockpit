// Tests de croisement du train de V2 de la Salle OMO (plan d'exécution 2 bis-2 ter §2.3, §5.2 ; propriété de l'intégrateur) :
// T3b (câblage, harnais, squelettes), T3c (signatures, environnement, migration 6), L16b (compose et app/Dockerfile),
// L15c (install.ps1, CockpitTls.ps1, cockpit.ps1, suites PowerShell).
// Ce que la vague doit prouver ENSEMBLE, et qu'aucun paquet ne peut prouver seul :
//   1. harnais complet (option `omo` + tous les modules) = salle coupée : toute route /api/omo/* refuse « salle-coupee », et
//      AUCUN fichier n'apparaît dans les trois volumes de la salle, démarrage 1.1 compris ;
//   2. l'intégrateur a relié `env.omo` (T3c) aux dossiers de contrôle de `omoControl` (T3b) dans main.ts : COCKPIT_OMO absent ou
//      « off » → port neutre (aucun dossier, aucun fichier) ; « on » → service réel, inerte tant que SALLE_OUVERTE est fausse ;
//   3. la garde d'instance d'app-factory.ts lit l'ENVELOPPE du hub (T3c), pas la donnée, et un événement 1.0.x reste 1.0.x ;
//   4. noms lus par env.ts (T3c) ⊆ environnement du service `cockpit` du compose (L16b) ⊆ $CockpitComposeEnvNames (L15c),
//      et tous égaux aux `variables.cockpit` du contrat de la salle (T3a) ;
//   5. adresses et chemins d'office d'env.ts = valeurs posées par le compose (une salle installée n'a rien à régler) ;
//   6. chaque volume nommé de la salle écrit par `node` (services `cockpit` et `egress`) est créé et donné à `node` par
//      app/Dockerfile, et `omo-state`, lu seul, reste à root ;
//   7. omo-projets.json écrit par install.ps1 = format OmoPreparedProjects de T3a, clé par clé ;
//   8. le préfixe des tests conteneur est une variable DE TEST, bornée aux préfixes des exécutions de la salle.
// Aucun conteneur, aucun réseau, aucune pause fixe : lecture de fichiers et harnais en mémoire seulement.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { parse as parseYaml } from "yaml";
import { createCockpitApp } from "./app-factory.ts";
import type { OmoControlDirs } from "./contracts-11.ts";
import {
  loadEnv,
  OMO_AUTH_DIR_DEFAUT,
  OMO_CONTROL_DIR_DEFAUT,
  OMO_COUPEE,
  OMO_EGRESS_JOURNAL_DEFAUT,
  OMO_STATE_DIR_DEFAUT,
  OMO_URL_DEFAUT,
  omoOf,
  parseOmo,
} from "./env.ts";
import { EventHub } from "./hub.ts";
import { createOmoControl } from "./omo-control.ts";
import { OMO_FICHIER_PROJETS } from "./shared/omo-control-protocol.ts";
import type { OmoPreparedProjects } from "./shared/omo-types.ts";
import { startCockpit } from "./test-support/cockpit-harness.ts";

const RACINE = path.resolve(import.meta.dirname, "..", "..");
const lire = (...morceaux: string[]) => fs.readFileSync(path.join(RACINE, ...morceaux), "utf8");
const lireServeur = (nom: string) => fs.readFileSync(path.join(import.meta.dirname, nom), "utf8");

/** Contrat machine de la salle (T3a), source unique des noms de variables et des volumes. */
const CONTRAT = JSON.parse(lire("docker", "opencode-omo", "contrat-salle.json")) as {
  variables: { cockpit: string[]; salle: string[] };
  volumes: { nom: string; proprietaire?: string; ecrivain?: string }[];
};

// --- 1. Harnais complet : la salle reste coupée ---------------------------------------------------------------------------------

describe("croisement V2 : harnais complet (omo + tous les modules) = salle coupée", () => {
  it("toute route /api/omo/* refuse « salle-coupee », et les volumes de la salle restent VIDES après le démarrage 1.1", async (t: TestContext) => {
    const h = await startCockpit(t, { modules: "tous", omo: true });
    assert.notEqual(h.omo, null);
    // Démarrage 1.1 réel : c'est lui qui appelle publishAuth() puis readState() du service de contrôle.
    await h.cockpit.startup();

    const routes: Array<[string, string]> = [
      ["GET", "/api/omo/status"],
      ["GET", "/api/omo/precheck?projet=demo"],
      ["POST", "/api/omo/rooms"],
      ["POST", "/api/omo/rooms/r-1/stop"],
      ["GET", "/api/omo/inconnue"],
    ];
    for (const [methode, chemin] of routes) {
      const res = await h.call(methode, chemin, { headers: h.headers.confirmed, ...(methode === "POST" ? { body: {} } : {}) });
      assert.equal(res.status, 403, `${methode} ${chemin}`);
      assert.equal(res.json<{ error?: string }>().error, "salle-coupee", `${methode} ${chemin}`);
    }
    // Ni battement, ni precheck-ok, ni guard-state.json, ni auth.json : les trois dossiers de la salle sont restés vides.
    assert.deepEqual(h.omo?.fichiers(), []);
    h.assertNoGlobalRestart();
  });

  it("les volumes de la salle restent vides même après un arrêt demandé et un état relu (ports réels, salle coupée)", async (t: TestContext) => {
    const h = await startCockpit(t, { modules: "tous", omo: true });
    await h.cockpit.startup();
    const port = h.cockpit.c11.ports.omoControl;
    await port.writePrecheckOk("s-1", []).catch(() => undefined);
    await port.writeGuardState({ version: 1, at: 0, bloquer: ["task"] }).catch(() => undefined);
    port.startHeartbeat();
    port.stopHeartbeat();
    assert.deepEqual(h.omo?.fichiers(), []);
  });
});

// --- 2. main.ts : env.omo (T3c) relié aux dossiers de omoControl (T3b) -----------------------------------------------------------

/** Mapping posé par l'intégrateur dans main.ts, rejoué ici sur le MÊME chemin de lecture (`omoOf`). */
function dossiersDepuisEnv(env: ReturnType<typeof loadEnv>): OmoControlDirs | null {
  const omo = omoOf(env);
  return omo.enabled
    ? {
        controlDir: omo.controlDir,
        stateDir: omo.stateDir,
        authDir: omo.authDir,
        opencodeDataDir: env.opencodeDataDir,
        projectsFile: omo.projectsFile,
      }
    : null;
}

/** Environnement minimal d'un cockpit réel ; les valeurs de la salle sont ajoutées par chaque cas. */
function environnement(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    COCKPIT_TOKEN: "x".repeat(40),
    OPENCODE_SERVER_PASSWORD: "y".repeat(40),
    COCKPIT_LOCAL_SCHEME: "http",
    COCKPIT_LOCAL_HTTP_CONFIRMED: "2026-01-01T00:00:00Z",
    ...extra,
  };
}

describe("croisement V2 : main.ts relie env.omo (T3c) aux dossiers de omoControl (T3b)", () => {
  it("main.ts construit bien les dossiers depuis omoOf(env), et ne les laisse plus à null", () => {
    const source = lireServeur("main.ts");
    assert.match(source, /const omoEnv = omoOf\(env\);/);
    assert.match(source, /const omoControlDirs: OmoControlDirs \| null = omoEnv\.enabled/);
    for (const ligne of [/controlDir: omoEnv\.controlDir,/, /stateDir: omoEnv\.stateDir,/, /authDir: omoEnv\.authDir,/, /opencodeDataDir: env\.opencodeDataDir,/, /projectsFile: omoEnv\.projectsFile,/]) {
      assert.match(source, ligne);
    }
    assert.match(source, /^\s*omoControlDirs,$/m);
    assert.doesNotMatch(source, /omoControlDirs: null/);
    // La salle ne s'ouvre jamais par l'environnement : main.ts lit env.omo, pas process.env (§2.7).
    assert.doesNotMatch(source, /process\.env\.COCKPIT_OMO/);
  });

  it("COCKPIT_OMO absent ou « off » : aucun dossier remis au module, donc port neutre et aucun fichier possible", () => {
    for (const valeur of [{}, { COCKPIT_OMO: "off" }, { COCKPIT_OMO: "" }]) {
      assert.equal(dossiersDepuisEnv(loadEnv(environnement(valeur))), null, JSON.stringify(valeur));
    }
  });

  it("COCKPIT_OMO=on : les cinq dossiers viennent des variables du contrat, jamais d'une valeur inventée", () => {
    const env = loadEnv(
      environnement({
        COCKPIT_OMO: "on",
        OPENCODE_OMO_PASSWORD: "z".repeat(40),
        COCKPIT_OMO_CONTROL_DIR: "/control-omo",
        COCKPIT_OMO_STATE_DIR: "/omo-state",
        COCKPIT_OMO_AUTH_DIR: "/omo-auth",
        COCKPIT_OMO_PROJECTS_FILE: "/control-omo/omo-projets.json",
        COCKPIT_OC_DATA_DIR: "/oc-data",
      }),
    );
    // Chemins du conteneur, résolus par env.ts comme tous les autres dossiers du cockpit (sous Windows, la racine du disque).
    assert.deepEqual(dossiersDepuisEnv(env), {
      controlDir: path.resolve("/control-omo"),
      stateDir: path.resolve("/omo-state"),
      authDir: path.resolve("/omo-auth"),
      opencodeDataDir: path.resolve("/oc-data"),
      projectsFile: path.resolve("/control-omo/omo-projets.json"),
    });
  });

  it("dossiers remis ET salle coupée : le service réel est construit, il retire l'auth.json d'un cockpit précédent et n'écrit RIEN", async (t: TestContext) => {
    const racine = fs.mkdtempSync(path.join(os.tmpdir(), "croisement-2bis-v2-"));
    t.after(() => fs.rmSync(racine, { recursive: true, force: true }));
    const dossier = (nom: string) => {
      const chemin = path.join(racine, nom);
      fs.mkdirSync(chemin, { recursive: true });
      return chemin;
    };
    const control = dossier("control");
    const state = dossier("state");
    const auth = dossier("auth");
    fs.writeFileSync(path.join(auth, "auth.json"), "{}");

    const h = await startCockpit(t, { modules: ["omoControl"] });
    // Deuxième cockpit monté à la main sur les mêmes services, avec les dossiers que main.ts remettrait.
    assert.notEqual(h.deps.configQueue, undefined);
    const app = createCockpitApp({
      ...h.deps,
      sessions: h.sessions,
      configQueue: h.deps.configQueue as NonNullable<typeof h.deps.configQueue>,
      omoControlDirs: { controlDir: control, stateDir: state, authDir: auth, opencodeDataDir: dossier("oc-data") },
    });
    t.after(() => app.close());
    await app.startup();

    assert.equal(fs.existsSync(path.join(auth, "auth.json")), false, "la copie d'auth.json d'avant doit être retirée");
    for (const [nom, chemin] of [
      ["control", control],
      ["state", state],
      ["auth", auth],
    ] as const) {
      assert.deepEqual(fs.readdirSync(chemin), [], `${nom} : la salle coupée n'écrit rien`);
    }
  });
});

// --- 3. Garde d'instance : l'étiquette vit sur l'enveloppe (T3c) -----------------------------------------------------------------

describe("croisement V2 : la garde d'instance d'app-factory lit l'enveloppe du hub (T3c)", () => {
  it("app-factory lit event.instance, jamais event.data.instance", () => {
    const source = lireServeur("app-factory.ts");
    assert.match(source, /function instanceDeLEvenement\(event: BrowserEvent\): SessionInstance/);
    assert.match(source, /instanceDeLEvenement\(event\)/);
    assert.doesNotMatch(source, /instanceDeLEvenement\(event\.data\)/);
  });

  it("hub.cockpit sans instance publie exactement l'objet 1.0.x : aucun champ « instance », même à undefined", () => {
    const hub = new EventHub();
    const vus: unknown[] = [];
    hub.subscribe((event) => vus.push(event));
    hub.cockpit("usage.updated", { monthSpentUsd: 1, percent: 2 });
    hub.cockpit("omo.connection", { connected: true, error: null }, "omo");
    assert.deepEqual(vus[0], { kind: "cockpit", type: "usage.updated", data: { monthSpentUsd: 1, percent: 2 } });
    assert.equal(Object.hasOwn(vus[0] as object, "instance"), false);
    assert.equal((vus[1] as { instance?: string }).instance, "omo");
  });
});

// --- 4 et 5. Noms et valeurs d'office : env.ts ⊆ compose ⊆ CockpitTls.ps1 ---------------------------------------------------------

/** Noms lus par `parseOmo` dans env.ts, extraits de la source : la liste ne peut pas se désynchroniser du code. */
function nomsLusParEnv(): string[] {
  const source = lireServeur("env.ts");
  const debut = source.indexOf("export function parseOmo(");
  assert.ok(debut > 0, "parseOmo introuvable dans env.ts");
  const corps = source.slice(debut, source.indexOf("\n}", debut));
  // Deux formes de lecture dans parseOmo : `env.NOM` et `absolutePath(env, "NOM", …)`. Un nom cité au milieu d'un message
  // d'erreur ne compte pas : la chaîne entière doit être le nom.
  const noms = [...corps.matchAll(/env\.([A-Z][A-Z0-9_]+)/g), ...corps.matchAll(/"((?:COCKPIT|OPENCODE)_[A-Z0-9_]+)"/g)].map((m) => m[1] as string);
  return [...new Set(noms)].sort();
}

/** Bloc `environment:` du service demandé, lu dans docker-compose.yml (indentation fixe du dépôt). */
function environnementDuService(service: string): Map<string, string> {
  const compose = lire("docker-compose.yml");
  const lignes = compose.split("\n");
  const debut = lignes.findIndex((l) => l === `  ${service}:`);
  assert.ok(debut >= 0, `service ${service} introuvable`);
  const fin = lignes.findIndex((l, i) => i > debut && /^ {2}\S/.test(l));
  const bloc = lignes.slice(debut, fin === -1 ? lignes.length : fin);
  const iEnv = bloc.findIndex((l) => l === "    environment:");
  assert.ok(iEnv >= 0, `environment: introuvable dans ${service}`);
  const valeurs = new Map<string, string>();
  for (const ligne of bloc.slice(iEnv + 1)) {
    if (/^ {0,4}\S/.test(ligne)) break;
    const m = /^ {6}([A-Z][A-Z0-9_]*): (.*)$/.exec(ligne);
    if (m) valeurs.set(m[1] as string, (m[2] as string).trim());
  }
  return valeurs;
}

/** $CockpitComposeEnvNames de CockpitTls.ps1. */
function nomsDeCockpitTls(): string[] {
  const source = lire("CockpitTls.ps1");
  const debut = source.indexOf("$CockpitComposeEnvNames = @(");
  assert.ok(debut > 0);
  const bloc = source.slice(debut, source.indexOf(")\n", debut));
  return [...new Set([...bloc.matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1] as string))].sort();
}

describe("croisement V2 : noms de la salle, env.ts ⊆ compose ⊆ CockpitTls.ps1 = contrat", () => {
  const lus = nomsLusParEnv();
  const compose = environnementDuService("cockpit");
  const tls = nomsDeCockpitTls();
  const contrat = [...CONTRAT.variables.cockpit].sort();

  it("parseOmo lit exactement les neuf variables de la salle du contrat", () => {
    assert.deepEqual(lus, contrat.filter((nom) => nom !== "COCKPIT_AUTONOMY").sort());
  });

  it("chaque nom lu par env.ts est posé au service cockpit du compose (L16b)", () => {
    for (const nom of lus) assert.ok(compose.has(nom), `${nom} manque au service cockpit du compose`);
  });

  it("chaque variable de la salle du compose est connue de $CockpitComposeEnvNames (L15c)", () => {
    for (const nom of [...compose.keys()].filter((n) => /OMO|EGRESS/.test(n))) {
      assert.ok(tls.includes(nom), `${nom} manque à $CockpitComposeEnvNames`);
    }
    for (const nom of contrat) assert.ok(tls.includes(nom), `${nom} (contrat) manque à $CockpitComposeEnvNames`);
  });

  it("adresses et chemins d'office d'env.ts = valeurs posées par le compose : une salle installée n'a rien à régler", () => {
    assert.equal(compose.get("OPENCODE_OMO_URL"), OMO_URL_DEFAUT);
    assert.equal(compose.get("COCKPIT_OMO_CONTROL_DIR"), OMO_CONTROL_DIR_DEFAUT);
    assert.equal(compose.get("COCKPIT_OMO_STATE_DIR"), OMO_STATE_DIR_DEFAUT);
    assert.equal(compose.get("COCKPIT_OMO_AUTH_DIR"), OMO_AUTH_DIR_DEFAUT);
    assert.equal(compose.get("COCKPIT_EGRESS_JOURNAL"), OMO_EGRESS_JOURNAL_DEFAUT);
    // COCKPIT_OMO d'office « off » dans le compose : la salle reste coupée après une installation neuve.
    assert.equal(compose.get("COCKPIT_OMO"), "${COCKPIT_OMO:-off}");
    assert.equal(parseOmo({ ...environnement({}) }).enabled, false);
    assert.equal(OMO_COUPEE.enabled, false);
  });

  it("le mot de passe de la salle du compose ne vient jamais de celui de l'instance principale", () => {
    const salle = environnementDuService("opencode-omo");
    assert.equal(salle.get("OPENCODE_SERVER_PASSWORD"), "${OPENCODE_OMO_PASSWORD:-}");
    // Demande (C) de L15a, tranchée au train de V2 : l'adresse de l'API Copilot n'est JAMAIS vide dans la salle.
    assert.equal(salle.get("COCKPIT_COPILOT_API_URL"), "${COCKPIT_COPILOT_API_URL:-https://api.githubcopilot.com}");
  });
});

// --- 6. Volumes écrits par node = dossiers créés et donnés à node par app/Dockerfile ----------------------------------------------

describe("croisement V2 : volumes de la salle écrits par node (L16b) créés et donnés à node par app/Dockerfile", () => {
  it("chaque volume nommé monté en écriture dans cockpit ou egress est créé et chown node dans app/Dockerfile", () => {
    const compose = lire("docker-compose.yml");
    const dockerfile = lire("app", "Dockerfile");
    const nomsDeVolumes = new Set(CONTRAT.volumes.map((v) => v.nom));
    // Services servis par l'image du cockpit (app/Dockerfile) : eux seuls y trouvent leurs points de montage.
    const lignes = compose.split("\n");
    const blocDe = (service: string): string => {
      const debut = lignes.indexOf(`  ${service}:`);
      assert.ok(debut >= 0, `service ${service} introuvable`);
      const fin = lignes.findIndex((l, i) => i > debut && /^ {0,2}\S/.test(l));
      return lignes.slice(debut, fin === -1 ? lignes.length : fin).join("\n");
    };
    const montages = [...`${blocDe("cockpit")}\n${blocDe("egress")}`.matchAll(/^ {6}- ([a-z][a-z0-9-]*):(\/[^:\s]+)(:ro)?$/gm)];
    const ecrits = montages.filter(([, nom, , ro]) => nomsDeVolumes.has(nom as string) && ro === undefined).map(([, , cible]) => cible as string);
    assert.ok(ecrits.length > 0, "aucun volume de la salle monté en écriture : lecture du compose cassée");
    // Le RUN du Dockerfile est écrit sur plusieurs lignes : les continuations sont repliées avant la lecture.
    const replie = dockerfile.replaceAll(/\\\r?\n\s*/g, " ");
    const chemins = (commande: string): string[] => {
      const bloc = new RegExp(`${commande} ([^&\\n]+)`).exec(replie)?.[1] ?? "";
      return bloc.trim().split(/\s+/);
    };
    const mkdir = chemins("mkdir -p");
    const chown = chemins("chown node:node");
    for (const cible of new Set(ecrits)) {
      // Cibles du HOME de la salle (image opencode-omo) : hors d'app/Dockerfile, préparées par omo-init.
      if (cible.startsWith("/home/") || cible === "/workspace" || cible === "/omo-config") continue;
      assert.ok(mkdir.includes(cible), `${cible} n'est pas créé par app/Dockerfile`);
      assert.ok(chown.includes(cible), `${cible} n'est pas donné à node par app/Dockerfile`);
    }
    // omo-state est LU par le cockpit (:ro) : il est créé, mais reste à root — jamais chown node.
    assert.ok(mkdir.includes("/omo-state"));
    assert.equal(chown.includes("/omo-state"), false);
  });
});

// --- 7. omo-projets.json écrit par install.ps1 = format de T3a --------------------------------------------------------------------

describe("croisement V2 : omo-projets.json (L15c) = format OmoPreparedProjects (T3a)", () => {
  it("install.ps1 écrit exactement les quatre clés du type, et les deux formes de chaque entrée", () => {
    const source = lire("install.ps1");
    const type = lireServeur(path.join("shared", "omo-types.ts"));
    const declaration = /export interface OmoPreparedProjects \{([\s\S]*?)\n\}/.exec(type)?.[1] ?? "";
    const clesDuType = [...declaration.matchAll(/^\s{2}(?:\/\*[\s\S]*?\*\/\s*)?([a-zA-Z]+)[?]?:/gm)].map((m) => m[1] as string);
    assert.deepEqual([...clesDuType].sort(), ["genereLe", "gitProteges", "projets", "version"]);
    for (const cle of clesDuType) assert.ok(source.includes(`"${cle}"`), `install.ps1 n'écrit pas la clé ${cle}`);
    assert.match(source, /"version": 1,/);
    // Formes acceptées par le type, écrites telles quelles par le script.
    for (const forme of ["dossier", "absent", "fichier"]) assert.ok(source.includes(`'${forme}'`), `forme ${forme} absente d'install.ps1`);
    // Le type est bien celui que lira la salle : une valeur littérale doit le satisfaire.
    const exemple: OmoPreparedProjects = { version: 1, genereLe: "2026-09-21T00:00:00.000Z", projets: [{ chemin: "demo", git: "dossier" }], gitProteges: [{ chemin: "demo/.git", forme: "dossier" }] };
    assert.equal(exemple.version, 1);
  });

  it("source == destination : la liste n'atteint JAMAIS la salle, et le cockpit efface sa propre copie", async (t: TestContext) => {
    const racine = fs.mkdtempSync(path.join(os.tmpdir(), "croisement-2bis-v2-projets-"));
    t.after(() => fs.rmSync(racine, { recursive: true, force: true }));
    const controlDir = path.join(racine, "control-omo");
    fs.mkdirSync(controlDir, { recursive: true });
    const journal: string[] = [];
    // `projectsFile` pointé SUR la destination, comme le ferait `COCKPIT_OMO_PROJECTS_FILE = COCKPIT_OMO_CONTROL_DIR + '/' + …`.
    const depose = path.join(controlDir, OMO_FICHIER_PROJETS);
    const ctl = createOmoControl({
      controlDir,
      stateDir: path.join(racine, "omo-state"),
      authDir: path.join(racine, "omo-auth"),
      opencodeDataDir: path.join(racine, "oc-data"),
      cockpitDataDir: path.join(racine, "donnees"),
      projectsFile: depose,
      actif: () => true,
      log: { info: () => undefined, warn: (message: string) => void journal.push(message) },
    });
    t.after(async () => {
      ctl.stopHeartbeat();
      await ctl.settled();
    });
    // Installation neuve : la source est le fichier que le cockpit n'a pas encore écrit.
    assert.equal(await ctl.publishProjects(), "absent");
    assert.equal(fs.existsSync(depose), false);
    // Pire cas : une liste déjà déposée (ou mal formée) est SUPPRIMÉE au lieu d'être remplacée, sans pouvoir être régénérée.
    fs.writeFileSync(depose, "{ mal formé");
    assert.equal(await ctl.publishProjects(), "invalide");
    assert.equal(fs.existsSync(depose), false);
    assert.ok(journal.includes("salle : liste des projets préparés non déposée"));

    // Donc le compose ne doit JAMAIS poser cette égalité : c'est cette ligne qui a laissé passer le défaut.
    const env = (parseYaml(lire("docker-compose.yml")) as { services: Record<string, { environment?: Record<string, string> }> }).services.cockpit?.environment ?? {};
    assert.notEqual(String(env.COCKPIT_OMO_PROJECTS_FILE), `${String(env.COCKPIT_OMO_CONTROL_DIR)}/${OMO_FICHIER_PROJETS}`);
    assert.ok(!String(env.COCKPIT_OMO_PROJECTS_FILE).startsWith(`${String(env.COCKPIT_OMO_CONTROL_DIR)}/`));
    // Et install.ps1 doit monter la source, sinon le conteneur ne la voit pas du tout.
    assert.match(lire("install.ps1"), /\$OmoCibleProjetsSource = '([^']+)'/);
    assert.equal(/\$OmoCibleProjetsSource = '([^']+)'/.exec(lire("install.ps1"))?.[1], String(env.COCKPIT_OMO_PROJECTS_FILE));
  });
});

// --- 8. Préfixes des tests conteneur -----------------------------------------------------------------------------------------------

describe("croisement V2 : préfixe des tests conteneur, variable DE TEST bornée", () => {
  it("omo-supervisor.test.ts et omo-guard.test.ts lisent OMO_TESTS_PREFIXE et bornent sa valeur", () => {
    for (const fichier of ["omo-supervisor.test.ts", "omo-guard.test.ts"]) {
      const source = lireServeur(fichier);
      assert.match(source, /process\.env\.OMO_TESTS_PREFIXE/, fichier);
      assert.match(source, /\^sal11-\|\^omo11-/, fichier);
    }
  });
});
