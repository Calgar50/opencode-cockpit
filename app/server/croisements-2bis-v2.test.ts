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
// PUIS, au train de la MÊME vague côté itération 2 ter (A15), avec L22b, L25a, L26a et L26b :
//   9.  DiagnosticsPage (L26b) branchée sur getOmoStatus() (L26a), lecture gardée par l'interrupteur et abandonnée au démontage ;
//   10. chemins de clés du filet de L24 ⊆ interdits absolus de L22b, avec l'arbitrage écrit du reste L24 n° 3 (famille .env*) ;
//   11. motifs refusés d'opencode.jsonc ⊇ clés et .env* de L22b ;
//   12. demande MO-1 de L25a : activity-deriver.ts passe bien `amont` au contexte des faits ;
//   13. toute l'interface de la salle est livrée, et la salle reste coupée.
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
import { EventMemory, type FactUpstream } from "./shared/activity-facts.ts";
import { classifyOmoPermission } from "./shared/omo-forbidden.ts";
import { OMO_FICHIER_PROJETS } from "./shared/omo-control-protocol.ts";
import type { OmoPreparedProjects } from "./shared/omo-types.ts";
import { startCockpit } from "./test-support/cockpit-harness.ts";
import * as garde from "../../docker/opencode-omo/guard/cockpit-guard.js";

const RACINE = path.resolve(import.meta.dirname, "..", "..");
const lire = (...morceaux: string[]) => fs.readFileSync(path.join(RACINE, ...morceaux), "utf8");
const lireServeur = (nom: string) => fs.readFileSync(path.join(import.meta.dirname, nom), "utf8");

/** Contrat machine de la salle (T3a), source unique des noms de variables et des volumes. */
const CONTRAT = JSON.parse(lire("docker", "opencode-omo", "contrat-salle.json")) as {
  variables: { cockpit: string[]; salle: string[] };
  volumes: { nom: string; proprietaire?: string; ecrivain?: string }[];
};

/** Projet ouvert des croisements de la 2 ter : chemin ABSOLU dans le conteneur, comme la salle le publie (L22b). */
const PROJET_OUVERT = "/workspace/mon-projet";

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

// =================================================================================================================================
// TRAIN DE LA VAGUE 2, PARTIE « ITÉRATION 2 TER » (A15) : L22b (interdits absolus), L25a (faits OMO), L26a (page, activation,
// bandeau) et L26b (Diagnostic, Journal) rejoignent la branche. Les quatre croisements que la décision A15 doit à ces paquets,
// plus l'arbitrage du reste L24 n° 3 et la demande MO-1, sont tenus ici — aucun paquet ne peut les prouver seul.
//   9.  DiagnosticsPage (L26b) est branchée sur getOmoStatus() (L26a) par l'intégrateur ;
//   10. chemins de clés du filet de L24 ⊆ interdits de L22b, avec l'arbitrage du reste L24 n° 3 (famille .env*) ;
//   11. motifs refusés d'opencode.jsonc ⊇ clés et .env* de L22b ;
//   12. demande MO-1 de L25a : activity-deriver.ts (L18a) passe bien `amont` au contexte des faits ;
//   13. la salle reste coupée alors même que toute l'interface de la salle est là.
// =================================================================================================================================

// --- 9. L26b branchée sur L26a (A15) ---------------------------------------------------------------------------------------------

describe("croisement V2 (2 ter) : le Diagnostic de L26b est alimenté par getOmoStatus() de L26a", () => {
  it("la page lit l'état par le client de L26a, et le composant n'en sait toujours rien", () => {
    const page = lire("app", "web", "pages", "DiagnosticsPage.tsx");
    // La PAGE fait la lecture : c'est elle qui relie les deux paquets de la vague.
    assert.match(page, /import \{ getOmoStatus \} from "\.\.\/lib\/api-omo\.ts";/, "DiagnosticsPage lit getOmoStatus (L26a)");
    assert.match(page, /<OmoDiagnostics statut=\{omoStatut\} \/>/, "la carte de L26b reçoit l'état par propriétés");
    // Le COMPOSANT de L26b reste pur : alimenté par propriétés, il n'a ni appel réseau ni dépendance à L26a.
    // Le contrôle porte sur les IMPORTS, pas sur le texte entier : l'en-tête du composant CITE api-omo.ts pour dire
    // précisément qu'il ne l'importe pas, et une recherche naïve prendrait ce commentaire pour une infraction.
    const composant = lire("app", "web", "pages", "diagnostics", "OmoDiagnostics.tsx");
    const imports = composant.split("\n").filter((ligne) => /^\s*import\b/.test(ligne));
    assert.equal(/fetch\(|XMLHttpRequest|EventSource/.test(composant), false, "aucun appel réseau dans le composant");
    assert.deepEqual(imports.filter((ligne) => ligne.includes("api-omo")), [], "le composant n'importe pas le client de L26a");
    assert.deepEqual(imports.filter((ligne) => ligne.includes("pages/omo")), [], "le composant n'importe rien de pages/omo/** (L26a)");
  });

  it("la lecture est gardée par l'interrupteur : salle coupée, aucune requête et aucune carte", () => {
    const page = lire("app", "web", "pages", "DiagnosticsPage.tsx");
    const corps = /function useOmoStatus\(refreshKey: number \| null\): OmoStatusResponse \| null \{([\s\S]*?)\n\}/.exec(page)?.[1];
    assert.ok(corps !== undefined, "le crochet garde sa signature");
    assert.match(corps, /boot\.omo\?\.enabled === true/, "COCKPIT_OMO=off : rien n'est demandé");
    assert.match(corps, /if \(!actif\)/, "l'interrupteur coupe AVANT la requête, pas après");
    assert.match(corps, /getOmoStatus\(controller\.signal\)/, "lecture abandonnable");
    assert.match(corps, /return \(\) => controller\.abort\(\)/, "abandonnée au démontage");
    assert.match(corps, /setStatut\(null\)/, "un échec — 403 salle-coupee compris — n'invente aucun état (P3)");
  });
});

// --- 10. Filet de L24 ⊆ interdits de L22b, et arbitrage du reste L24 n° 3 ---------------------------------------------------------

/**
 * ARBITRAGE DU RESTE L24 n° 3 (famille `.env*`), rendu par l'intégrateur au train de V2, comme le plan le prévoit.
 *
 * CONSTAT de L22b : `classifyOmoPermission` applique « .env* » à CHAQUE segment d'un chemin, alors que le filet
 * `docker/opencode-omo/guard/cockpit-guard.js` n'applique ses motifs qu'au NOM D'ENTRÉE. `config/.env.d/valeurs.txt` est donc
 * refusé par le cockpit et passe le filet.
 *
 * DÉCISION : l'écart est GARDÉ tel quel, et c'est la bonne relation. Trois raisons :
 *   1. les deux couches n'ont pas le même métier. L22b est le JUGE : il répond aux demandes d'autorisation de la salle et doit
 *      être fermé en cas de doute. L24 est un FILET, dernier recours dans le conteneur, volontairement minuscule (ESM sans
 *      dépendance) ; il se trompe du côté sûr en refusant moins, jamais en autorisant ce que le juge refuse ;
 *   2. la seule relation dangereuse serait l'inverse — un filet plus large que le juge —, parce qu'elle voudrait dire que le
 *      cockpit accorde une permission que le conteneur refuse ensuite, sans que personne ne l'explique à l'utilisateur. C'est
 *      cette relation, et non l'égalité, que le test ci-dessous interdit ;
 *   3. élargir le filet MAINTENANT coûterait une image : `guard/cockpit-guard.js` est copié octet pour octet dans l'image et
 *      entre dans `perimetreManifeste` (`docker/opencode-omo/omo-manifest.sha256`). Le modifier périme le manifeste et demande
 *      une reconstruction avec `-AcceptManifest`, qui est un travail de la VAGUE 4 (reste R-5 de `constats-salle-2bis.md`).
 *      Le faire ici ferait tomber la porte du manifeste sans rien rendre de plus sûr.
 * Le filet n'est donc PAS modifié par ce train. La relation « ⊆ » est désormais tenue par un test, et non plus par une lecture.
 */
describe("croisement V2 (2 ter) : chemins de clés du filet (L24) ⊆ interdits absolus (L22b)", () => {
  /** Une demande d'écriture sur ce chemin, telle que la salle la publie. */
  const ecriture = (chemin: string) =>
    classifyOmoPermission({ permission: "edit", metadata: { filePath: `${PROJET_OUVERT}/${chemin}` } }, { projetOuvert: PROJET_OUVERT });
  /** Une demande bash qui lit ce chemin. */
  const lecture = (chemin: string) => classifyOmoPermission({ permission: "bash", metadata: { command: `cat ${chemin}` } }, { projetOuvert: PROJET_OUVERT });

  it("tout nom d'entrée refusé par le filet est refusé par le juge, en lecture comme en écriture", () => {
    for (const nom of garde.TEMOINS_CLE) {
      assert.equal(garde.estNomCle(nom), true, `le filet doit refuser son propre témoin : ${nom}`);
      assert.equal(ecriture(nom).verdict, "interdit", `L22b doit refuser à l'écriture ce que le filet refuse : ${nom}`);
      assert.equal(lecture(nom).verdict, "interdit", `L22b doit refuser à la commande ce que le filet refuse : ${nom}`);
    }
  });

  it("aucun témoin ordinaire du filet n'est refusé à l'écriture par le juge (pas de refus gratuit)", () => {
    for (const nom of garde.TEMOINS_ORDINAIRES) {
      if (nom === "src") continue; // dossier, pas un fichier : la demande d'écriture n'a pas de sens.
      assert.equal(garde.estNomCle(nom), false, `le filet laisse passer : ${nom}`);
      assert.equal(ecriture(nom).verdict, "once", `L22b ne doit pas refuser un fichier ordinaire : ${nom}`);
    }
  });

  it("sur un NOM D'ENTRÉE seul, filet et juge disent exactement la même chose (aucune dérive silencieuse)", () => {
    // Le corpus de noms couvre les deux listes du filet ; l'égalité doit tenir nom par nom, dans les deux sens.
    for (const nom of [...garde.TEMOINS_CLE, ...garde.TEMOINS_ORDINAIRES, ".env.example", "service.env.example", ".env-prod", "prod.env"]) {
      if (nom === "src") continue;
      const refuseParLeJuge = ecriture(nom).verdict === "interdit";
      assert.equal(refuseParLeJuge, garde.estNomCle(nom), `désaccord filet / juge sur le nom « ${nom} »`);
    }
  });

  it("arbitrage L24 n° 3 : le juge est PLUS LARGE sur un chemin, et jamais l'inverse", () => {
    // L'écart assumé : un segment intermédiaire « .env* » est vu par le juge, pas par le filet.
    const ecart = "config/.env.d/valeurs.txt";
    assert.equal(garde.estCheminCle(ecart), false, "le filet ne regarde que le nom d'entrée");
    assert.equal(ecriture(ecart).verdict, "interdit", "le juge regarde le chemin entier");
    // La relation interdite, elle, doit rester vide : aucun chemin refusé par le filet et accordé par le juge.
    const vecteurs = [
      ".env",
      ".envrc",
      "prod.env",
      "src/.env.local",
      "a/b/c/id_ed25519",
      "deploy/cert.pem",
      "infra/terraform.tfstate",
      ".kube/config",
      "config/.env.d/valeurs.txt",
      "src/index.ts",
      "docs/README.md",
      ".env.example",
      "paquet/service.env.example",
    ];
    const filetSeul = vecteurs.filter((c) => garde.estCheminCle(c) && ecriture(c).verdict === "once");
    assert.deepEqual(filetSeul, [], "le filet refuserait ce que le cockpit accorde : relation interdite");
  });

  it(".env.example reste permis des deux côtés, y compris préfixé", () => {
    for (const permis of [".env.example", "service.env.example", "paquet/service.env.example"]) {
      assert.equal(garde.estCheminCle(permis), false, permis);
      assert.equal(ecriture(permis).verdict, "once", permis);
    }
  });
});

// --- 11. opencode.jsonc ⊇ clés et .env* de L22b (A15) -----------------------------------------------------------------------------

describe("croisement V2 (2 ter) : motifs refusés d'opencode.jsonc ⊇ clés et .env* de L22b", () => {
  /** Motifs « deny » de la section `permission.edit` d'opencode.jsonc, commentaires JSONC retirés. */
  const motifsRefuses = (): string[] => {
    const brut = lire("docker", "opencode-omo", "opencode.jsonc").replace(/^\s*\/\/.*$/gm, "");
    const config = JSON.parse(brut) as { permission?: { edit?: Record<string, string> } };
    return Object.entries(config.permission?.edit ?? {})
      .filter(([, verdict]) => verdict === "deny")
      .map(([motif]) => motif);
  };
  /** Motif d'opencode (wildcardMatch : « * » traverse les dossiers), casse ignorée — comme le fait opencode. */
  const correspond = (motif: string, chemin: string) =>
    new RegExp(`^${motif.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "iu").test(chemin);

  it("chaque chemin de clé ou de .env que L22b refuse est aussi refusé par opencode.jsonc", () => {
    const motifs = motifsRefuses();
    assert.ok(motifs.length > 20, `motifs deny trouvés : ${motifs.length}`);
    const cles = [
      ".env",
      ".env.local",
      ".env.production",
      ".envrc",
      "prod.env",
      "src/.env",
      "config/.env.d/valeurs.txt",
      "id_rsa",
      "id_ed25519",
      "deploy/server.key",
      "deploy/cert.pem",
      "client.p12",
      "store.pfx",
      "app.jks",
      "coffre.kdbx",
      "terraform.tfstate",
      "prod.tfvars",
      "cle.asc",
      "cle.gpg",
      "acces.ovpn",
      "cle.p8",
      "cert.crt",
      "cert.cer",
      "cert.der",
      ".kube/config",
    ];
    const manquants = cles.filter((chemin) => {
      assert.equal(
        classifyOmoPermission({ permission: "edit", metadata: { filePath: `${PROJET_OUVERT}/${chemin}` } }, { projetOuvert: PROJET_OUVERT }).verdict,
        "interdit",
        `L22b doit refuser ${chemin}`,
      );
      return !motifs.some((motif) => correspond(motif, chemin));
    });
    assert.deepEqual(manquants, [], "chemins refusés par le cockpit mais accordés par opencode.jsonc");
  });

  it("opencode.jsonc rend .env.example à l'action de base, comme L22b", () => {
    const brut = lire("docker", "opencode-omo", "opencode.jsonc").replace(/^\s*\/\/.*$/gm, "");
    const edit = (JSON.parse(brut) as { permission?: { edit?: Record<string, string> } }).permission?.edit ?? {};
    assert.notEqual(edit["*.env.example"], "deny", "le témoin permis ne doit pas être refusé par la couche opencode");
  });
});

// --- 12. Demande MO-1 de L25a : l'amont est branché (A15) --------------------------------------------------------------------------

describe("croisement V2 (2 ter) : activity-deriver passe l'amont au contexte des faits (demande MO-1 de L25a)", () => {
  it("le contexte porte `amont`, alimenté par la mémoire du flux", () => {
    const source = lireServeur("activity-deriver.ts");
    assert.match(source, /amont: memory\.amont\(\)/, "sans ce branchement, MO-1 et JP-3 restent muettes pour toujours");
  });

  it("les règles qui dépendent de l'amont se TAISENT quand il manque, elles n'inventent rien", () => {
    // Toutes les entrées de FactUpstream sont facultatives : un contexte sans amont ne doit produire aucun doute ni aucune tâche.
    const sansAmont: FactUpstream = {};
    assert.equal(sansAmont.identiteSuspecte?.("msg_1") ?? false, false, "aucune identité douteuse inventée");
    assert.equal(sansAmont.tacheDeFond?.("ses_1") ?? null, null, "aucune tâche de fond inventée");
    assert.equal(sansAmont.noReply?.("msg_1") ?? false, false, "aucun réveil inventé");
    // Et la mémoire du flux, elle, fournit bien les deux qu'elle connaît (noReply reste au processeur de la salle, L23c en V4).
    const amont = new EventMemory(8).amont();
    assert.equal(typeof amont.identiteSuspecte, "function");
    assert.equal(typeof amont.tacheDeFond, "function");
    assert.equal(amont.noReply, undefined, "noReply est fourni par la salle, pas par la mémoire générique");
  });
});

// --- 13. Toute l'interface de la salle est là, et la salle reste coupée -------------------------------------------------------------

describe("croisement V2 (2 ter) : l'interface de la salle est livrée, la salle reste coupée", () => {
  it("SALLE_OUVERTE est toujours fausse dans le dépôt, page et Diagnostic compris", () => {
    assert.match(lireServeur("wiring-11.ts"), /export const SALLE_OUVERTE = false;/, "la salle est livrée coupée");
  });

  it("l'entrée « Salle OMO » de App.tsx demande le mode Avancé ET les deux interrupteurs", () => {
    const app = lire("app", "web", "app", "App.tsx");
    const visible = /function salleVisible\(boot: Bootstrap\): boolean \{([\s\S]*?)\n\}/.exec(app)?.[1];
    assert.ok(visible !== undefined, "l'entrée de la salle a sa propre règle de visibilité");
    assert.match(visible, /omo\?\.enabled === true/, "interrupteur du cockpit");
    assert.match(visible, /omo\.imageChargee/, "image réellement chargée sur ce poste");
    assert.match(app, /id: "salle".*advancedOnly: true.*omoOnly: true/, "mode Avancé seulement, et sous les deux interrupteurs");
  });
});
