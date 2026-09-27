// Déploiement 1.0.6 : opencode n'a pas d'autre sortie que le relais du cockpit, et ne tente même plus ses sorties connues.
// Fige ce que la preuve au proxy espion a mesuré : docker-compose.yml, image opencode, superviseur, préinstallation de
// @opencode-ai/plugin et son amorce (docker/opencode/plugin-seed.mjs, exécutée ici sur des dossiers jetables).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { parse as parseYaml } from "yaml";

const ROOT = path.join(import.meta.dirname, "..", "..");
const read = (...parts: string[]) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

interface ComposeService {
  networks?: string[];
  environment?: Record<string, string>;
  ports?: unknown[];
}
interface Compose {
  services: Record<string, ComposeService>;
  networks: Record<string, { internal?: boolean } | null>;
}

describe("déploiement 1.0.6 : opencode ne sort que par le relais du cockpit", () => {
  const compose = parseYaml(read("docker-compose.yml"), { merge: true }) as Compose;

  it("docker-compose.yml : opencode seul sur le réseau interne, sans port publié", () => {
    assert.equal(compose.networks.interne?.internal, true);
    assert.deepEqual(compose.services.opencode?.networks, ["interne"]);
    // Grande fusion (GF1) : le cockpit rejoint aussi le réseau fermé de la salle (omo-internal) ; « interne » reste à lui et à opencode.
    assert.deepEqual([...(compose.services.cockpit?.networks ?? [])].sort(), ["default", "interne", "omo-internal"]);
    const surInterne = Object.entries(compose.services)
      .filter(([, service]) => (service?.networks ?? []).includes("interne"))
      .map(([nom]) => nom)
      .sort();
    assert.deepEqual(surInterne, ["cockpit", "opencode"]);
    assert.equal(compose.services.opencode?.ports, undefined);
  });

  it("docker-compose.yml : proxys d'opencode = relais du cockpit, 0.0.0.0 hors proxy, jamais le proxy de l'entreprise", () => {
    const oc = compose.services.opencode?.environment ?? {};
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) assert.equal(oc[key], "http://cockpit:3128", key);
    for (const key of ["NO_PROXY", "no_proxy"]) {
      const list = String(oc[key]).split(",");
      for (const host of ["0.0.0.0", "localhost", "127.0.0.1", "opencode", "cockpit"]) assert.ok(list.includes(host), `${key} : ${host}`);
    }
    // Aucune valeur de .env pour les proxys d'opencode : ni ${HTTP_PROXY}, ni ${HTTPS_PROXY}, ni ${NO_PROXY}.
    assert.equal(/\$\{(HTTPS?_PROXY|NO_PROXY)/.test(JSON.stringify(oc)), false);
    const cockpit = compose.services.cockpit?.environment ?? {};
    assert.equal(cockpit.COCKPIT_RELAY_PORT, "3128");
    assert.equal(cockpit.COCKPIT_RELAY_PEER, "opencode");
    assert.match(String(cockpit.HTTPS_PROXY), /\$\{HTTPS_PROXY/);
  });

  it("image opencode : drapeaux posés après les étapes npm, préinstallation par npm ci sans script", () => {
    const dockerfile = read("docker", "opencode", "Dockerfile");
    for (const flag of [
      "OPENCODE_DISABLE_MODELS_FETCH=1",
      "OPENCODE_MODELS_URL=http://127.0.0.1:9",
      "npm_config_offline=true",
      "OPENCODE_DISABLE_AUTOUPDATE=1",
      "OPENCODE_DISABLE_SHARE=1",
      "OPENCODE_DISABLE_LSP_DOWNLOAD=1",
    ]) {
      assert.ok(dockerfile.includes(flag), flag);
    }
    assert.match(dockerfile, /npm ci --ignore-scripts --omit=optional --omit=dev/);
    // Posés avant, ils mettraient npm ci hors ligne pendant la construction.
    assert.ok(dockerfile.indexOf("npm_config_offline=true") > dockerfile.lastIndexOf("npm ci "), "drapeaux après npm ci");
    // Jamais ces variables, qui ouvriraient d'autres sorties.
    for (const variable of ["OPENCODE_ENABLE_EXA", "OPENCODE_EXPERIMENTAL=", "OPENCODE_DISABLE_EMBEDDED_WEB_UI", "OTEL_EXPORTER_OTLP_ENDPOINT="]) {
      assert.equal(dockerfile.includes(variable), false, variable);
    }
  });

  it("superviseur : 0.0.0.0 hors proxy, amorce de l'extension avant opencode, serve --no-mdns", () => {
    const entrypoint = read("docker", "opencode", "entrypoint.sh");
    const internal = /^internal="([^"]*)"$/m.exec(entrypoint)?.[1] ?? "";
    assert.ok(internal.split(",").includes("0.0.0.0"), internal);
    const seed = entrypoint.indexOf("plugin-seed.mjs");
    const serve = entrypoint.indexOf("opencode serve ");
    assert.ok(seed > 0 && serve > seed, "amorce avant le lancement d'opencode");
    assert.match(entrypoint.slice(serve, entrypoint.indexOf("\n", serve)), /--no-mdns/);
  });

  it("préinstallation : même version que le binaire d'opencode, chaque paquet verrouillé par une empreinte", () => {
    const version = /^ARG OPENCODE_VERSION=(\S+)$/m.exec(read("docker", "opencode", "Dockerfile"))?.[1];
    const pkg = JSON.parse(read("docker", "opencode", "plugin-seed", "package.json")) as { dependencies: Record<string, string> };
    const lock = JSON.parse(read("docker", "opencode", "plugin-seed", "package-lock.json")) as {
      packages: Record<string, { version?: string; integrity?: string; dependencies?: Record<string, string>; optional?: boolean; hasInstallScript?: boolean }>;
    };
    assert.deepEqual(pkg.dependencies, { "@opencode-ai/plugin": version });
    assert.deepEqual(lock.packages[""]?.dependencies, pkg.dependencies);
    assert.equal(lock.packages["node_modules/@opencode-ai/plugin"]?.version, version);
    for (const [name, entry] of Object.entries(lock.packages)) {
      if (name === "") continue;
      assert.match(entry.integrity ?? "", /^sha512-/, name);
      // Un script d'installation n'est toléré que sur un paquet optionnel, écarté par --omit=optional (et --ignore-scripts).
      if (entry.hasInstallScript) assert.equal(entry.optional, true, name);
    }
  });
});

describe("amorce de @opencode-ai/plugin (docker/opencode/plugin-seed.mjs)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-amorce-"));
  const script = path.join(ROOT, "docker", "opencode", "plugin-seed.mjs");
  const PLUGIN = "@opencode-ai/plugin";
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  /** Préinstallation factice, comme celle de l'image (npm ci) : package.json, verrou et node_modules. */
  const seedDir = path.join(tmp, "image");
  fs.mkdirSync(path.join(seedDir, "node_modules", "@opencode-ai", "plugin"), { recursive: true });
  fs.writeFileSync(path.join(seedDir, "package.json"), JSON.stringify({ private: true, dependencies: { [PLUGIN]: "1.18.30" } }));
  fs.writeFileSync(path.join(seedDir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { [PLUGIN]: "1.18.30" } } } }));
  fs.writeFileSync(path.join(seedDir, "node_modules", "@opencode-ai", "plugin", "package.json"), JSON.stringify({ name: PLUGIN, version: "1.18.30" }));

  const run = (configDir: string) => execFileSync(process.execPath, [script, configDir, seedDir], { encoding: "utf8" }).trim();
  const installed = (configDir: string) => fs.existsSync(path.join(configDir, "node_modules", "@opencode-ai", "plugin", "package.json"));

  it("volume d'une 1.0.5 (aucun node_modules) : recopie, puis « présente » au démarrage suivant sans rien toucher", () => {
    const config = path.join(tmp, "config-105");
    fs.mkdirSync(config);
    fs.writeFileSync(path.join(config, "opencode.jsonc"), "{}");
    assert.match(run(config), /recopiée depuis l'image/);
    assert.equal(installed(config), true);
    const before = fs.statSync(path.join(config, "node_modules")).mtimeMs;
    assert.match(run(config), /présente/);
    assert.equal(fs.statSync(path.join(config, "node_modules")).mtimeMs, before);
    assert.equal(fs.readFileSync(path.join(config, "opencode.jsonc"), "utf8"), "{}");
  });

  it("node_modules présent mais verrou sans l'extension (installation interrompue) : recopie", () => {
    const config = path.join(tmp, "config-verrou");
    fs.mkdirSync(path.join(config, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(config, "package-lock.json"), JSON.stringify({ packages: { "": {} } }));
    assert.match(run(config), /recopiée depuis l'image/);
    assert.equal(installed(config), true);
  });

  it("package.json qui déclare d'autres paquets : laissé tel quel, avertissement", () => {
    const config = path.join(tmp, "config-autres");
    fs.mkdirSync(config);
    const own = JSON.stringify({ dependencies: { "paquet-ajoute-a-la-main": "1.0.0" } });
    fs.writeFileSync(path.join(config, "package.json"), own);
    assert.match(run(config), /^ATTENTION : .*1 autre\(s\) paquet\(s\), laissé tel quel/);
    assert.equal(fs.readFileSync(path.join(config, "package.json"), "utf8"), own);
    assert.equal(installed(config), false);
  });
});
