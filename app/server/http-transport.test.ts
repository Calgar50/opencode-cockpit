// Transport local 1.0.5 sans openssl : démarrage extrait (server-start.ts), ordre du démarrage de main.ts, mode HTTP de bout en
// bout sur le vrai main.ts, tickets de connexion, healthcheck HTTP en sous-processus. Jetons de test publics, aucun secret réel.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import tls from "node:tls";
import { pathToFileURL } from "node:url";
import { Hono } from "hono";
import type { Logger } from "./log.ts";
import {
  AUTH_TICKET_CHALLENGES_MAX,
  AUTH_TICKET_TTL_MS,
  AUTH_TICKETS_MAX,
  AuthTickets,
  attemptTicketLogin,
  authTicketMac,
  authTicketRequestMac,
  healthProof,
  LoginLimiter,
} from "./security.ts";
import * as serverStart from "./server-start.ts";
import { type ExecFileRunner, ensureServerCertificate } from "./tls.ts";

const SERVER_DIR = import.meta.dirname;
const APP_DIR = path.dirname(SERVER_DIR);
const POSIX = process.platform !== "win32";
const SKIP_POSIX = POSIX ? false : "SKIP droits POSIX (Windows)";
/** Jeton de test public, au format généré par install.ps1 (64 hexadécimaux). */
const TOKEN = "3c".repeat(32);
const CONFIRMED_AT = "2026-09-15T10:32:00Z";
const VERSION = "1.0.5-test";
const HTTP_ENV = { COCKPIT_LOCAL_SCHEME: "http", COCKPIT_LOCAL_HTTP_CONFIRMED: CONFIRMED_AT };
// CSP de la 1.0.4, recopiées : elles ne changent pas d'un octet avec le mode.
const CSP_PAGE =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const CSP_API = "default-src 'none'; frame-ancestors 'none'; sandbox";

const roots: string[] = [];
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-transport-"));
  roots.push(dir);
  return dir;
}

// --- Espions préchargés dans les sous-processus (--import), jamais dans le produit ----------------------------------------

const SPIES = tempDir();
/** Chaque mise en écoute d'un serveur (net, http, https) est signalée sur stderr. */
const LISTEN_SPY = path.join(SPIES, "espion-listen.mjs");
fs.writeFileSync(
  LISTEN_SPY,
  [
    'import net from "node:net";',
    "const listen = net.Server.prototype.listen;",
    'net.Server.prototype.listen = function (...args) { process.stderr.write("ESPION-LISTEN\\n"); return listen.apply(this, args); };',
    "",
  ].join("\n"),
);
/** Tout appel fs qui vise ESPION_TLS_DIR (ou un fichier dessous) est signalé sur stderr. */
const FS_SPY = path.join(SPIES, "espion-fs.mjs");
fs.writeFileSync(
  FS_SPY,
  [
    'import fs from "node:fs";',
    'import { syncBuiltinESMExports } from "node:module";',
    'import path from "node:path";',
    'import { fileURLToPath } from "node:url";',
    'const dir = path.resolve(process.env.ESPION_TLS_DIR ?? "/espion-sans-dossier");',
    "const hits = (arg) => {",
    "  let file = null;",
    "  try {",
    "    if (arg instanceof URL) file = fileURLToPath(arg);",
    '    else if (typeof arg === "string" || Buffer.isBuffer(arg)) file = path.resolve(String(arg));',
    "  } catch { file = null; }",
    "  return file !== null && (file === dir || file.startsWith(dir + path.sep));",
    "};",
    "const wrap = (target, names, label) => {",
    "  for (const name of names) {",
    "    const original = target[name];",
    '    if (typeof original !== "function") continue;',
    "    target[name] = function (...args) {",
    '      if (hits(args[0])) process.stderr.write("ESPION-TLS " + label + name + "\\n");',
    "      return original.apply(this, args);",
    "    };",
    "  }",
    "};",
    'wrap(fs, ["readFileSync", "readFile", "openSync", "open", "statSync", "stat", "lstatSync", "lstat", "existsSync", "accessSync", "access", "readdirSync", "readdir", "createReadStream", "opendirSync"], "");',
    'wrap(fs.promises, ["readFile", "open", "stat", "lstat", "access", "readdir", "opendir"], "promises.");',
    "syncBuiltinESMExports();",
    "",
  ].join("\n"),
);

// --- Outils communs --------------------------------------------------------------------------------------------------------

/** Environnement minimal des sous-processus : aucun proxy, aucun NODE_OPTIONS ni variable du cockpit hérités. */
function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...extra };
}

async function freePorts(count: number): Promise<number[]> {
  const servers = await Promise.all(
    Array.from({ length: count }, () => new Promise<net.Server>((resolve) => {
      const server = net.createServer();
      server.listen(0, "127.0.0.1", () => resolve(server));
    })),
  );
  const ports = servers.map((server) => (server.address() as AddressInfo).port);
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  return ports;
}

async function waitFor<T>(probe: () => T | undefined, ms: number, what: string): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`délai dépassé : ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

interface NodeRun {
  child: ChildProcess;
  /** Lignes JSON du journal (stdout). */
  logs: Array<Record<string, unknown>>;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<number | null>;
}

function spawnNode(args: string[], env: NodeJS.ProcessEnv): NodeRun {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ...args], {
    cwd: APP_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let out = "";
  let err = "";
  let pending = "";
  const logs: Array<Record<string, unknown>> = [];
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    out += chunk;
    pending += chunk;
    for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
      const line = pending.slice(0, at);
      pending = pending.slice(at + 1);
      if (line.startsWith("{")) logs.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    err += chunk;
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, logs, stdout: () => out, stderr: () => err, exited };
}

async function exitCode(run: NodeRun, ms: number): Promise<number | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`processus toujours actif après ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stop(run: NodeRun): Promise<void> {
  if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill();
  await run.exited;
}

const listenCalls = (run: NodeRun): number => run.stderr().split("\n").filter((line) => line.trim() === "ESPION-LISTEN").length;
const listeningLine = (run: NodeRun) => run.logs.find((line) => line.msg === "cockpit à l'écoute");

interface Cockpit {
  dataDir: string;
  tlsDir: string;
  port: number;
  env: NodeJS.ProcessEnv;
}

/** Dossiers et variables d'un cockpit réel lancé par main.ts ; opencode injoignable (port fermé), aucun auth.json. */
async function cockpitSetup(extra: NodeJS.ProcessEnv = {}): Promise<Cockpit> {
  const root = tempDir();
  const [port, deadPort] = await freePorts(2);
  for (const name of ["archives", "workspace", "oc-config", "oc-data", "control", "certs", "web"]) fs.mkdirSync(path.join(root, name));
  fs.writeFileSync(path.join(root, "web", "index.html"), "<!doctype html><title>cockpit</title>");
  const dataDir = path.join(root, "data");
  const tlsDir = path.join(root, "tls");
  return {
    dataDir,
    tlsDir,
    port: port ?? 0,
    env: cleanEnv({
      COCKPIT_TOKEN: TOKEN,
      OPENCODE_SERVER_PASSWORD: "p".repeat(24),
      COCKPIT_HOST: "127.0.0.1",
      COCKPIT_PORT: String(port),
      COCKPIT_DATA_DIR: dataDir,
      COCKPIT_ARCHIVE_DIR: path.join(root, "archives"),
      COCKPIT_WORKSPACE_DIR: path.join(root, "workspace"),
      COCKPIT_OC_CONFIG_DIR: path.join(root, "oc-config"),
      COCKPIT_OC_DATA_DIR: path.join(root, "oc-data"),
      COCKPIT_CONTROL_DIR: path.join(root, "control"),
      COCKPIT_CERTS_DIR: path.join(root, "certs"),
      COCKPIT_WEB_DIR: path.join(root, "web"),
      OPENCODE_URL: `http://127.0.0.1:${deadPort}`,
      COCKPIT_TLS_DIR: tlsDir,
      COCKPIT_OPENSSL: path.join(root, "openssl-absent"),
      COCKPIT_VERSION: VERSION,
      COCKPIT_LOG_LEVEL: "info",
      ...extra,
    }),
  };
}

function startMain(cockpit: Cockpit, token = TOKEN): NodeRun {
  return spawnNode(["--import", pathToFileURL(LISTEN_SPY).href, path.join(SERVER_DIR, "main.ts")], { ...cockpit.env, COCKPIT_TOKEN: token });
}

async function waitListening(run: NodeRun): Promise<Record<string, unknown>> {
  return waitFor(
    () => {
      if (run.child.exitCode !== null) throw new Error(`main.ts arrêté (${run.child.exitCode}) : ${run.stdout()} ${run.stderr()}`);
      return listeningLine(run);
    },
    60_000,
    "cockpit à l'écoute",
  );
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(port: number, method: string, pathname: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: pathname, agent: false, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const setCookiesOf = (reply: Reply): string[] => reply.headers["set-cookie"] ?? [];
const newChallenge = (): string => crypto.randomBytes(32).toString("hex");
/** HMAC du jeton recalculé sans le code du cockpit (préfixes du contrat 1.0.5). */
const tokenMac = (token: string, usage: "health-proof" | "auth-ticket" | "auth-ticket-request", value: string): string =>
  crypto.createHmac("sha256", token).update(`opencode-cockpit/${usage}/v1\n${value}`).digest("hex");
/** Demande de ticket signée par le jeton, comme les scripts : /api/health?challenge=<défi>&ticket=<MAC du défi>. */
const ticketQuery = (challenge: string, token: string = TOKEN): string =>
  `/api/health?challenge=${challenge}&ticket=${tokenMac(token, "auth-ticket-request", challenge)}`;

async function ticketLink(port: number): Promise<string> {
  const challenge = newChallenge();
  const health = await request(port, "GET", ticketQuery(challenge));
  assert.equal(health.status, 200, health.body);
  const body = JSON.parse(health.body) as { proof?: string | null; ticket?: string };
  assert.equal(body.proof, tokenMac(TOKEN, "health-proof", challenge));
  const ticket = body.ticket ?? "";
  assert.match(ticket, /^[0-9a-f]{64}$/);
  return `/auth?k=${ticket}.${tokenMac(TOKEN, "auth-ticket", ticket)}`;
}

class ExitCalled extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`sortie ${code}`);
    this.code = code;
  }
}
const exitThrows = (code: number): never => {
  throw new ExitCalled(code);
};
const exitedWith = (code: number) => (err: unknown) => err instanceof ExitCalled && err.code === code;

function captureLog(): { log: Logger; lines: Array<{ level: string; message: string; fields: Record<string, unknown> | undefined }>; text: () => string } {
  const lines: Array<{ level: string; message: string; fields: Record<string, unknown> | undefined }> = [];
  const write = (level: string) => (message: string, fields?: Record<string, unknown>) => {
    lines.push({ level, message, fields });
  };
  return { log: { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") }, lines, text: () => JSON.stringify(lines) };
}

const baseEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ COCKPIT_TOKEN: TOKEN, OPENCODE_SERVER_PASSWORD: "p".repeat(24), ...extra });

/** Exécuteur d'openssl qui ne doit jamais être appelé. */
function forbiddenRunner(): { run: ExecFileRunner; calls: () => number } {
  let calls = 0;
  return {
    run: (_file, _args, _options, callback) => {
      calls++;
      setImmediate(() => callback(Object.assign(new Error("openssl ne doit pas être lancé"), { code: 1 }), "", ""));
    },
    calls: () => calls,
  };
}

// --- Démarrage extrait --------------------------------------------------------------------------------------------------

describe("démarrage extrait (server-start.ts) : configuration et certificat avant la base et toute écoute", () => {
  it(".env invalide : sortie 1, ni afterEnv ni certificat", async () => {
    for (const extra of [{ COCKPIT_LOCAL_SCHEME: "HTTP", COCKPIT_LOCAL_HTTP_CONFIRMED: CONFIRMED_AT }, { COCKPIT_LOCAL_SCHEME: "http" }]) {
      const capture = captureLog();
      let ensured = 0;
      let afterEnv = 0;
      await assert.rejects(
        serverStart.prepareStartup({
          processEnv: baseEnv(extra),
          log: capture.log,
          exit: exitThrows,
          afterEnv: () => afterEnv++,
          ensureCertificate: async () => {
            ensured++;
            throw new Error("jamais appelé");
          },
        }),
        exitedWith(1),
      );
      assert.equal(ensured, 0);
      assert.equal(afterEnv, 0);
      assert.equal(capture.lines.length, 1);
      assert.equal(capture.lines[0]?.level, "error");
      assert.match(capture.lines[0]?.message ?? "", /^configuration invalide : COCKPIT_LOCAL_/);
    }
  });

  it("HTTPS, volume TLS absent : sortie 1, « HTTPS local impossible » (raison, remède), openssl jamais lancé, jamais -Http", async () => {
    const tlsDir = path.join(tempDir(), "tls-absent");
    const runner = forbiddenRunner();
    const capture = captureLog();
    let afterEnv = 0;
    await assert.rejects(
      serverStart.prepareStartup({
        processEnv: baseEnv({ COCKPIT_TLS_DIR: tlsDir }),
        log: capture.log,
        exit: exitThrows,
        afterEnv: () => afterEnv++,
        ensureCertificate: (options) => ensureServerCertificate({ ...options, run: runner.run }),
      }),
      exitedWith(1),
    );
    assert.equal(afterEnv, 1);
    assert.equal(runner.calls(), 0);
    assert.equal(fs.existsSync(tlsDir), false);
    const failure = capture.lines.find((line) => line.message === "HTTPS local impossible");
    assert.equal(failure?.level, "error");
    assert.deepEqual(failure?.fields, { raison: "volume-absent", remede: "relancez .\\install.ps1" });
    assert.doesNotMatch(capture.text(), /-Http\b/);
  });

  it("HTTPS, /tls en 0755 : sortie 1 sans rien écrire dans le volume", { skip: SKIP_POSIX }, async () => {
    const tlsDir = path.join(tempDir(), "tls");
    fs.mkdirSync(tlsDir, { mode: 0o755 });
    fs.chmodSync(tlsDir, 0o755);
    const runner = forbiddenRunner();
    const capture = captureLog();
    await assert.rejects(
      serverStart.prepareStartup({
        processEnv: baseEnv({ COCKPIT_TLS_DIR: tlsDir }),
        log: capture.log,
        exit: exitThrows,
        ensureCertificate: (options) => ensureServerCertificate({ ...options, run: runner.run }),
      }),
      exitedWith(1),
    );
    assert.equal(runner.calls(), 0);
    assert.deepEqual(fs.readdirSync(tlsDir), []);
    assert.equal(capture.lines.find((line) => line.message === "HTTPS local impossible")?.fields?.raison, "droits-volume");
    assert.doesNotMatch(capture.text(), /-Http\b/);
  });

  it("paire refusée par ensureServerCertificate (exception quelconque) : sortie 1, raison « inattendue »", async () => {
    const capture = captureLog();
    await assert.rejects(
      serverStart.prepareStartup({
        processEnv: baseEnv(),
        log: capture.log,
        exit: exitThrows,
        ensureCertificate: async () => {
          throw new Error(["-----BEGIN", "PRIVATE", "KEY----- piège"].join(" "));
        },
      }),
      exitedWith(1),
    );
    assert.deepEqual(capture.lines.find((line) => line.message === "HTTPS local impossible")?.fields, {
      raison: "inattendue",
      remede: ".\\cockpit.ps1 tls -Renew",
    });
    assert.doesNotMatch(capture.text(), /PRIVATE|piège/);
  });

  it("mode HTTP : ensureServerCertificate jamais appelé, dossier TLS non créé, mode journalisé ; écoute HTTP seule", async () => {
    const tlsDir = path.join(tempDir(), "tls-jamais-cree");
    const capture = captureLog();
    let ensured = 0;
    const ready = await serverStart.prepareStartup({
      processEnv: baseEnv({ ...HTTP_ENV, COCKPIT_TLS_DIR: tlsDir }),
      log: capture.log,
      exit: exitThrows,
      ensureCertificate: async () => {
        ensured++;
        throw new Error("jamais en HTTP");
      },
    });
    assert.equal(ensured, 0);
    assert.deepEqual(ready.listen, { scheme: "http" });
    assert.equal(ready.tls, null);
    assert.equal(ready.env.localScheme, "http");
    assert.equal(fs.existsSync(tlsDir), false);
    assert.deepEqual(capture.lines, [
      { level: "warn", message: "mode HTTP local choisi à l'installation : trafic non chiffré sur la boucle locale", fields: { confirmedAt: CONFIRMED_AT } },
    ]);

    const app = new Hono();
    app.get("/ping", (c) => c.text("pong"));
    let onPort: (port: number) => void = () => undefined;
    const listening = new Promise<number>((resolve) => {
      onPort = resolve;
    });
    const server = serverStart.startLocalServer({ app, hostname: "127.0.0.1", port: 0, listen: ready.listen, onListening: (port) => onPort(port) });
    try {
      const port = await listening;
      assert.equal((await request(port, "GET", "/ping")).body, "pong");
      // Pas de double écoute : une poignée TLS sur ce port échoue.
      const handshake = await new Promise<string>((resolve) => {
        const socket = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false });
        socket.once("secureConnect", () => {
          socket.destroy();
          resolve("secureConnect");
        });
        socket.once("error", () => resolve("error"));
        socket.once("close", () => resolve("close"));
      });
      assert.notEqual(handshake, "secureConnect");
      assert.equal(fs.existsSync(tlsDir), false);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("une seule fonction d'écoute (server-start.ts), appelée une fois par main.ts", () => {
    assert.deepEqual(Object.keys(serverStart).sort(), ["logHttpsFailure", "prepareStartup", "startLocalServer"]);
    const sources = fs
      .readdirSync(SERVER_DIR, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .map((file) => file.replaceAll("\\", "/"))
      // Outillage de test 1.1 (harnais, faux opencode) : retiré de l'image par app/Dockerfile, jamais chargé par main.ts.
      .filter((file) => !file.startsWith("test-support/"));
    const listeners = sources.filter((file) =>
      /from "@hono\/node-server"|\bcreateServer\b|createSecureServer|\.listen\(/.test(fs.readFileSync(path.join(SERVER_DIR, file), "utf8")),
    );
    assert.deepEqual(listeners, ["server-start.ts"]);
    const main = fs.readFileSync(path.join(SERVER_DIR, "main.ts"), "utf8");
    assert.equal(main.match(/\bstartLocalServer\(/g)?.length, 1);
    // Certificat préparé avant la base, base ouverte avant l'écoute.
    const order = ["prepareStartup(", "openDb(", "startLocalServer("].map((marker) => main.indexOf(marker));
    assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > (order[i - 1] ?? 0))), JSON.stringify(order));
  });
});

// --- main.ts réel : échec avant toute écoute ------------------------------------------------------------------------------

describe("main.ts : configuration invalide ou HTTPS impossible → sortie 1 avant la base et avant toute écoute", () => {
  const assertNoStart = (run: NodeRun, cockpit: Cockpit) => {
    assert.equal(listenCalls(run), 0, run.stderr());
    assert.equal(listeningLine(run), undefined);
    assert.equal(fs.existsSync(cockpit.dataDir), false, "base ouverte avant l'échec");
  };

  it("COCKPIT_LOCAL_SCHEME invalide", async () => {
    const cockpit = await cockpitSetup({ COCKPIT_LOCAL_SCHEME: "Https" });
    const run = startMain(cockpit);
    try {
      assert.equal(await exitCode(run, 60_000), 1, run.stdout() + run.stderr());
    } finally {
      await stop(run);
    }
    assertNoStart(run, cockpit);
    assert.ok(run.logs.some((line) => line.level === "error" && String(line.msg).startsWith("configuration invalide : COCKPIT_LOCAL_SCHEME")), run.stdout());
  });

  it("HTTPS avec volume TLS absent : « HTTPS local impossible », volume non créé, jamais -Http", async () => {
    const cockpit = await cockpitSetup();
    const run = startMain(cockpit);
    try {
      assert.equal(await exitCode(run, 60_000), 1, run.stdout() + run.stderr());
    } finally {
      await stop(run);
    }
    assertNoStart(run, cockpit);
    const failure = run.logs.find((line) => line.msg === "HTTPS local impossible");
    assert.equal(failure?.raison, "volume-absent", run.stdout());
    assert.equal(fs.existsSync(cockpit.tlsDir), false);
    assert.doesNotMatch(run.stdout(), /-Http\b/);
  });

  it("HTTPS avec /tls en 0755 : aucune écoute ni HTTP ni HTTPS, volume intact", { skip: SKIP_POSIX }, async () => {
    const cockpit = await cockpitSetup();
    fs.mkdirSync(cockpit.tlsDir, { mode: 0o755 });
    fs.chmodSync(cockpit.tlsDir, 0o755);
    const run = startMain(cockpit);
    try {
      assert.equal(await exitCode(run, 60_000), 1, run.stdout() + run.stderr());
    } finally {
      await stop(run);
    }
    assertNoStart(run, cockpit);
    assert.equal(run.logs.find((line) => line.msg === "HTTPS local impossible")?.raison, "droits-volume", run.stdout());
    assert.deepEqual(fs.readdirSync(cockpit.tlsDir), []);
    assert.doesNotMatch(run.stdout(), /-Http\b/);
  });
});

// --- Mode HTTP de bout en bout --------------------------------------------------------------------------------------------

describe("mode HTTP de bout en bout (main.ts réel)", () => {
  let cockpit: Cockpit;
  let run: NodeRun | undefined;
  let port = 0;

  before(async () => {
    cockpit = await cockpitSetup(HTTP_ENV);
    port = cockpit.port;
    run = startMain(cockpit);
    await waitListening(run);
  });

  after(async () => {
    if (run) await stop(run);
  });

  const main = (): NodeRun => {
    assert.ok(run);
    return run;
  };

  it("une seule écoute, en HTTP ; volume TLS jamais créé ; mode journalisé", () => {
    assert.equal(listenCalls(main()), 1, main().stderr());
    const line = listeningLine(main());
    assert.equal(line?.scheme, "http");
    assert.equal(line?.port, port);
    assert.equal(line?.version, VERSION);
    assert.equal(line !== undefined && "sha256" in line, false);
    assert.ok(
      main().logs.some(
        (l) => l.level === "warn" && l.msg === "mode HTTP local choisi à l'installation : trafic non chiffré sur la boucle locale" && l.confirmedAt === CONFIRMED_AT,
      ),
    );
    assert.equal(fs.existsSync(cockpit.tlsDir), false);
  });

  it("TLS sur le port HTTP : poignée refusée (pas de double écoute)", async () => {
    const outcome = await new Promise<string>((resolve) => {
      const socket = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false });
      socket.once("secureConnect", () => {
        socket.destroy();
        resolve("secureConnect");
      });
      socket.once("error", () => resolve("error"));
      socket.once("close", () => resolve("close"));
    });
    assert.notEqual(outcome, "secureConnect");
    assert.equal((await request(port, "GET", "/api/health")).status, 200);
  });

  it("/api/health : schéma http ; preuve seulement avec un défi valide ; ticket seulement avec un défi valide et sa demande signée par le jeton", async () => {
    const plain = await request(port, "GET", "/api/health");
    assert.deepEqual(JSON.parse(plain.body), { ok: true, version: VERSION, scheme: "http" });
    const challenge = newChallenge();
    assert.deepEqual(JSON.parse((await request(port, "GET", `/api/health?challenge=${challenge}`)).body), {
      ok: true,
      version: VERSION,
      scheme: "http",
      proof: tokenMac(TOKEN, "health-proof", challenge),
    });
    assert.deepEqual(JSON.parse((await request(port, "GET", "/api/health?ticket=1")).body), { ok: true, version: VERSION, scheme: "http" });
    const withTicket = JSON.parse((await request(port, "GET", ticketQuery(challenge))).body) as Record<string, unknown>;
    assert.match(String(withTicket.ticket), /^[0-9a-f]{64}$/);
    assert.equal(withTicket.proof, tokenMac(TOKEN, "health-proof", challenge));
    for (const invalid of [challenge.toUpperCase(), challenge.slice(1), `${challenge}0`, "g".repeat(64), ""]) {
      const res = await request(port, "GET", `/api/health?challenge=${invalid}&ticket=${tokenMac(TOKEN, "auth-ticket-request", invalid)}`);
      assert.equal(res.status, 400, invalid);
      assert.deepEqual(JSON.parse(res.body), { error: "invalid", message: "challenge : 64 caractères hexadécimaux attendus." });
    }
  });

  it("demande de ticket sans preuve du jeton : 403, aucun ticket, aucun ticket en attente évincé (page web, conteneur opencode)", async () => {
    // Le script obtient son ticket, puis un appelant qui ne connaît pas le jeton demande plus de AUTH_TICKETS_MAX tickets.
    const link = await ticketLink(port);
    const challenge = newChallenge();
    const other = newChallenge();
    const unsigned = [
      "1",
      "0".repeat(64),
      tokenMac(TOKEN, "auth-ticket-request", challenge).toUpperCase(),
      tokenMac("4d".repeat(32), "auth-ticket-request", challenge),
      tokenMac(TOKEN, "auth-ticket-request", other),
      tokenMac(TOKEN, "health-proof", challenge),
      tokenMac(TOKEN, "auth-ticket", challenge),
      `${tokenMac(TOKEN, "auth-ticket-request", challenge)}0`,
      "",
    ];
    for (let round = 0; round < 2; round++) {
      for (const ticket of unsigned) {
        const res = await request(port, "GET", `/api/health?challenge=${challenge}&ticket=${ticket}`);
        assert.equal(res.status, 403, ticket);
        const body = JSON.parse(res.body) as Record<string, unknown>;
        assert.deepEqual(body, { error: "ticket-refused", message: "Ticket de connexion refusé : demande non signée par le jeton." }, ticket);
      }
    }
    assert.ok(unsigned.length * 2 > AUTH_TICKETS_MAX);
    const opened = await request(port, "GET", link, { "sec-fetch-site": "none", "sec-fetch-dest": "document" });
    assert.equal(opened.status, 303);
    assert.equal(opened.headers.location, "/");
    assert.match(setCookiesOf(opened)[0] ?? "", /^__Host-cockpit_session=/);
  });

  it("demande de ticket rejouée (défi et signature déjà servis, lus sur la boucle locale) : 403, rien d'émis ni d'évincé", async () => {
    const challenge = newChallenge();
    const first = await request(port, "GET", ticketQuery(challenge));
    assert.equal(first.status, 200, first.body);
    const ticket = (JSON.parse(first.body) as { ticket?: string }).ticket ?? "";
    assert.match(ticket, /^[0-9a-f]{64}$/);
    for (let i = 0; i <= AUTH_TICKETS_MAX; i++) {
      const replay = await request(port, "GET", ticketQuery(challenge));
      assert.equal(replay.status, 403);
      assert.deepEqual(JSON.parse(replay.body), { error: "ticket-refused", message: "Ticket de connexion refusé : défi déjà utilisé." });
    }
    const opened = await request(port, "GET", `/auth?k=${ticket}.${tokenMac(TOKEN, "auth-ticket", ticket)}`, { "sec-fetch-site": "none", "sec-fetch-dest": "document" });
    assert.equal(opened.status, 303);
    assert.equal(opened.headers.location, "/");
    // Un nouveau défi signé obtient toujours un ticket.
    assert.equal((await request(port, "GET", ticketQuery(newChallenge()))).status, 200);
  });

  it("K1-4 login-disabled : POST /api/login refusé avant le corps et le limiteur ; 30 appels n'épuisent pas le limiteur", async () => {
    const json = { "x-cockpit-csrf": "1", "content-type": "application/json" };
    const good = await request(port, "POST", "/api/login", json, JSON.stringify({ token: TOKEN }));
    assert.equal(good.status, 403);
    assert.deepEqual(JSON.parse(good.body), { error: "login-disabled", message: "Mode HTTP local : ouvrez le cockpit avec .\\cockpit.ps1 open." });
    assert.deepEqual(setCookiesOf(good), []);
    // Corps illisible ou trop gros : le refus précède la lecture.
    assert.equal((await request(port, "POST", "/api/login", json, "{pas du json")).status, 403);
    assert.equal((await request(port, "POST", "/api/login", json, JSON.stringify({ token: "x".repeat(8_000) }))).status, 403);
    const started = Date.now();
    for (let i = 0; i < 30; i++) {
      const res = await request(port, "POST", "/api/login", json, JSON.stringify({ token: `mauvais-${i}` }));
      assert.equal(res.status, 403);
    }
    // Aucun échec compté ni ralenti (400 ms chacun sinon).
    assert.ok(Date.now() - started < 6_000, `${Date.now() - started} ms`);
    const wrong = await request(port, "GET", `/auth?k=${"0".repeat(64)}.${"0".repeat(64)}`);
    assert.equal(wrong.headers.location, "/?auth=failed");
    const opened = await request(port, "GET", await ticketLink(port));
    assert.equal(opened.status, 303);
    assert.equal(opened.headers.location, "/");
  });

  it("ticket : cookie __Host- exact et ancien nom effacé ; lien rejoué refusé ; /auth?t= → ancien-lien sans cookie", async () => {
    const link = await ticketLink(port);
    const opened = await request(port, "GET", link, { "sec-fetch-site": "none", "sec-fetch-dest": "document" });
    assert.equal(opened.status, 303);
    assert.equal(opened.headers.location, "/");
    const cookies = setCookiesOf(opened);
    assert.equal(cookies.length, 2);
    assert.match(cookies[0] ?? "", /^__Host-cockpit_session=\d+\.[A-Za-z0-9_-]{43}; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
    assert.equal(cookies[1], "cockpit_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict");
    const cookie = (cookies[0] ?? "").split(";")[0] ?? "";
    assert.equal((await request(port, "GET", "/api/settings", { cookie })).status, 200);

    const replay = await request(port, "GET", link);
    assert.equal(replay.status, 303);
    assert.equal(replay.headers.location, "/?auth=failed");
    assert.deepEqual(setCookiesOf(replay), []);

    const legacy = await request(port, "GET", `/auth?t=${TOKEN}`);
    assert.equal(legacy.status, 303);
    assert.equal(legacy.headers.location, "/?auth=ancien-lien");
    assert.deepEqual(setCookiesOf(legacy), []);

    // Signature d'un autre jeton : refusée, le ticket reste utilisable avec la bonne signature.
    const health = JSON.parse((await request(port, "GET", ticketQuery(newChallenge()))).body) as { ticket: string };
    const forged = await request(port, "GET", `/auth?k=${health.ticket}.${tokenMac("4d".repeat(32), "auth-ticket", health.ticket)}`);
    assert.equal(forged.headers.location, "/?auth=failed");
    const genuine = await request(port, "GET", `/auth?k=${health.ticket}.${tokenMac(TOKEN, "auth-ticket", health.ticket)}`);
    assert.equal(genuine.headers.location, "/");
  });

  it("SSE : hello et en-têtes ; CSP identiques à la 1.0.4 ; aucun HSTS", async () => {
    const opened = await request(port, "GET", await ticketLink(port));
    const cookie = (setCookiesOf(opened)[0] ?? "").split(";")[0] ?? "";
    const page = await request(port, "GET", "/");
    assert.equal(page.status, 200);
    assert.equal(page.headers["content-security-policy"], CSP_PAGE);
    const health = await request(port, "GET", "/api/health");
    assert.equal(health.headers["content-security-policy"], CSP_API);
    for (const reply of [page, health, opened]) assert.equal(reply.headers["strict-transport-security"], undefined);

    const events = await new Promise<{ req: http.ClientRequest; res: http.IncomingMessage; text: string }>((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/api/events", agent: false, headers: { host: `127.0.0.1:${port}`, cookie } }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
          if (text.includes("event: hello")) resolve({ req, res, text });
        });
      });
      req.on("error", reject);
    });
    try {
      assert.equal(events.res.statusCode, 200);
      assert.match(String(events.res.headers["content-type"]), /^text\/event-stream/);
      assert.equal(events.res.headers["content-security-policy"], CSP_API);
      assert.equal(events.res.headers["strict-transport-security"], undefined);
      assert.match(events.text, new RegExp(`"version":"${VERSION.replaceAll(".", "\\.")}"`));
    } finally {
      events.req.destroy();
    }
  });

  it("anti-CSRF : origine http du même hôte acceptée en HTTP, origine https refusée", async () => {
    const opened = await request(port, "GET", await ticketLink(port));
    const cookie = (setCookiesOf(opened)[0] ?? "").split(";")[0] ?? "";
    const put = (origin: string) =>
      request(port, "PUT", "/api/settings", { cookie, "x-cockpit-csrf": "1", "content-type": "application/json", origin }, "{}");
    assert.equal((await put(`http://127.0.0.1:${port}`)).status, 200);
    assert.equal((await put(`https://127.0.0.1:${port}`)).status, 403);
  });

  it("état et bootstrap : schéma http, date de confirmation, aucun certificat", async () => {
    const opened = await request(port, "GET", await ticketLink(port));
    const cookie = (setCookiesOf(opened)[0] ?? "").split(";")[0] ?? "";
    const status = JSON.parse((await request(port, "GET", "/api/system/status", { cookie })).body) as { security: Record<string, unknown> };
    assert.equal(status.security.localScheme, "http");
    assert.equal(status.security.localHttpConfirmedAt, CONFIRMED_AT);
    assert.equal(status.security.tls, null);
    const bootstrap = JSON.parse((await request(port, "GET", "/api/bootstrap", { cookie })).body) as { security: Record<string, unknown> };
    assert.equal(bootstrap.security.localScheme, "http");
    assert.equal(bootstrap.security.localHttpConfirmedAt, CONFIRMED_AT);
    assert.equal(bootstrap.security.tls, null);
  });

  it("healthcheck du serveur réel : 0", async () => {
    const result = await healthcheck({ ...HTTP_ENV, COCKPIT_PORT: String(port) });
    assert.equal(result.code, 0, result.stderr);
  });
});

describe("jeton hors du format généré : aucune preuve, jamais de ticket", () => {
  let run: NodeRun | undefined;
  let port = 0;

  before(async () => {
    const cockpit = await cockpitSetup(HTTP_ENV);
    port = cockpit.port;
    run = startMain(cockpit, "t".repeat(40));
    await waitListening(run);
  });

  after(async () => {
    if (run) await stop(run);
  });

  it("proof: null avec un défi valide, sans ticket même avec une demande signée par ce jeton ; défi invalide toujours refusé", async () => {
    const challenge = newChallenge();
    for (const ticket of ["1", tokenMac("t".repeat(40), "auth-ticket-request", challenge)]) {
      const body = JSON.parse((await request(port, "GET", `/api/health?challenge=${challenge}&ticket=${ticket}`)).body) as Record<string, unknown>;
      assert.deepEqual(body, { ok: true, version: VERSION, scheme: "http", proof: null }, ticket);
    }
    assert.equal((await request(port, "GET", "/api/health?challenge=abc")).status, 400);
  });
});

// --- Tickets (unitaires) --------------------------------------------------------------------------------------------------

describe("tickets de connexion à usage unique (AuthTickets, attemptTicketLogin)", () => {
  const manualClock = () => {
    let now = 1_000;
    return { now: () => now, advance: (ms: number) => void (now += ms) };
  };
  const link = (token: string, nonce: string) => `${nonce}.${authTicketMac(token, nonce)}`;

  it("usage unique ; valable 10 minutes sur l'horloge injectée", () => {
    assert.equal(AUTH_TICKET_TTL_MS, 600_000);
    const clock = manualClock();
    const tickets = new AuthTickets({ now: clock.now });
    const first = tickets.issue();
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(tickets.consume(first), true);
    assert.equal(tickets.consume(first), false);
    const second = tickets.issue();
    clock.advance(AUTH_TICKET_TTL_MS - 1);
    assert.equal(tickets.consume(second), true);
    const third = tickets.issue();
    clock.advance(AUTH_TICKET_TTL_MS);
    assert.equal(tickets.consume(third), false);
    assert.equal(tickets.consume("0".repeat(64)), false);
    assert.notEqual(tickets.issue(), tickets.issue());
  });

  it("demande de ticket : signée par le jeton seulement ; défi rejoué refusé ; aucune demande refusée n'émet ni n'évince", () => {
    const token = "3c".repeat(32);
    const tickets = new AuthTickets({ now: manualClock().now });
    const challenge = "a1".repeat(32);
    const kept = tickets.request(token, challenge, authTicketRequestMac(token, challenge));
    assert.equal(kept.ok, true);
    const ticket = kept.ok ? kept.ticket : "";
    assert.match(ticket, /^[0-9a-f]{64}$/);
    const other = "c3".repeat(32);
    const forged = [
      "1",
      "",
      "0".repeat(64),
      authTicketRequestMac("4d".repeat(32), other),
      authTicketRequestMac(token, challenge),
      authTicketMac(token, other),
      healthProof(token, other),
      authTicketRequestMac(token, other).toUpperCase(),
      `${authTicketRequestMac(token, other)}0`,
    ];
    for (const mac of forged) {
      for (let i = 0; i <= AUTH_TICKETS_MAX; i++) assert.deepEqual(tickets.request(token, other, mac), { ok: false, reason: "unsigned" }, mac);
    }
    for (let i = 0; i <= AUTH_TICKETS_MAX; i++) {
      assert.deepEqual(tickets.request(token, challenge, authTicketRequestMac(token, challenge)), { ok: false, reason: "replayed" });
    }
    assert.equal(tickets.pending, 1);
    assert.equal(tickets.consume(ticket), true);
    // Un défi refusé faute de signature n'est pas consommé : la demande signée passe ensuite.
    assert.equal(tickets.request(token, other, authTicketRequestMac(token, other)).ok, true);
  });

  it("défis déjà servis : 256 mémorisés au plus, les plus anciens oubliés", () => {
    assert.equal(AUTH_TICKET_CHALLENGES_MAX, 256);
    const token = "3c".repeat(32);
    const tickets = new AuthTickets({ now: manualClock().now });
    const signed = (challenge: string) => tickets.request(token, challenge, authTicketRequestMac(token, challenge));
    const challenges = Array.from({ length: AUTH_TICKET_CHALLENGES_MAX + 1 }, (_, i) => i.toString(16).padStart(64, "0"));
    for (const challenge of challenges) assert.equal(signed(challenge).ok, true, challenge);
    for (const challenge of challenges.slice(1)) assert.deepEqual(signed(challenge), { ok: false, reason: "replayed" }, challenge);
    assert.equal(signed(challenges[0] ?? "").ok, true);
  });

  it("8 tickets en attente au plus : le neuvième évince le plus ancien", () => {
    assert.equal(AUTH_TICKETS_MAX, 8);
    const tickets = new AuthTickets({ now: manualClock().now });
    const issued = Array.from({ length: AUTH_TICKETS_MAX + 1 }, () => tickets.issue());
    assert.equal(tickets.pending, AUTH_TICKETS_MAX);
    assert.equal(tickets.consume(issued[0] ?? ""), false);
    for (const nonce of issued.slice(1)) assert.equal(tickets.consume(nonce), true);
    assert.equal(tickets.pending, 0);
  });

  it("signature fausse ou d'un autre jeton : refusée et comptée, ticket non consommé ; ticket valide même limiteur épuisé, une fois", async () => {
    const token = "3c".repeat(32);
    const tickets = new AuthTickets();
    const limiter = new LoginLimiter(2);
    const nonce = tickets.issue();
    assert.equal(await attemptTicketLogin(limiter, `${nonce}.${"0".repeat(64)}`, token, tickets, 0), "refused");
    assert.equal(await attemptTicketLogin(limiter, link("4d".repeat(32), nonce), token, tickets, 0), "refused");
    assert.equal(limiter.blocked(), true);
    assert.equal(await attemptTicketLogin(limiter, "pas-un-lien", token, tickets, 0), "blocked");
    assert.equal(await attemptTicketLogin(limiter, link(token, nonce).toUpperCase(), token, tickets, 0), "blocked");
    assert.equal(tickets.pending, 1);
    assert.equal(await attemptTicketLogin(limiter, link(token, nonce), token, tickets, 0), "ok");
    assert.equal(await attemptTicketLogin(limiter, link(token, nonce), token, tickets, 0), "blocked");
  });

  it("échec ralenti ; ticket expiré refusé", async () => {
    const clock = manualClock();
    const tickets = new AuthTickets({ now: clock.now });
    const token = "3c".repeat(32);
    const nonce = tickets.issue();
    clock.advance(AUTH_TICKET_TTL_MS);
    const started = performance.now();
    assert.equal(await attemptTicketLogin(new LoginLimiter(), link(token, nonce), token, tickets, 60), "refused");
    assert.ok(performance.now() - started >= 50);
  });
});

// --- Healthcheck HTTP (sous-processus) ------------------------------------------------------------------------------------

async function healthcheck(env: NodeJS.ProcessEnv, preload: string[] = []): Promise<{ code: number | null; stderr: string; ms: number }> {
  const started = Date.now();
  const run = spawnNode([...preload.flatMap((file) => ["--import", pathToFileURL(file).href]), path.join(SERVER_DIR, "healthcheck.ts")], cleanEnv(env));
  try {
    const code = await exitCode(run, 20_000);
    return { code, stderr: run.stderr(), ms: Date.now() - started };
  } finally {
    await stop(run);
  }
}

async function fakeServer(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const healthReply =
  (scheme: string, status = 200): http.RequestListener =>
  (_req, res) => {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, version: "x", scheme }));
  };

describe("healthcheck en mode HTTP (sous-processus)", () => {
  it("200 et schéma http → 0 ; schéma https → 1 ; 503 → 1 ; http sans date → 1", async () => {
    const good = await fakeServer(healthReply("http"));
    const wrongScheme = await fakeServer(healthReply("https"));
    const unavailable = await fakeServer(healthReply("http", 503));
    try {
      assert.equal((await healthcheck({ ...HTTP_ENV, COCKPIT_PORT: String(good.port) })).code, 0);
      assert.equal((await healthcheck({ ...HTTP_ENV, COCKPIT_PORT: String(wrongScheme.port) })).code, 1);
      assert.equal((await healthcheck({ ...HTTP_ENV, COCKPIT_PORT: String(unavailable.port) })).code, 1);
      assert.equal((await healthcheck({ COCKPIT_LOCAL_SCHEME: "http", COCKPIT_PORT: String(good.port) })).code, 1);
      assert.equal((await healthcheck({ ...HTTP_ENV, COCKPIT_LOCAL_HTTP_CONFIRMED: "2026-02-30T00:00:00Z", COCKPIT_PORT: String(good.port) })).code, 1);
    } finally {
      await Promise.all([good.close(), wrongScheme.close(), unavailable.close()]);
    }
  });

  it("serveur muet : 1 dans le délai", async () => {
    const silent = await fakeServer(() => undefined);
    try {
      const result = await healthcheck({ ...HTTP_ENV, COCKPIT_PORT: String(silent.port) });
      assert.equal(result.code, 1);
      assert.ok(result.ms < 8_000, `${result.ms} ms`);
    } finally {
      await silent.close();
    }
  });

  it("aucun accès au volume TLS (espion fs) ; témoin : le même espion voit les lectures en HTTPS", async () => {
    const tlsDir = path.join(tempDir(), "tls");
    fs.mkdirSync(path.join(tlsDir, "public"), { recursive: true });
    fs.writeFileSync(path.join(tlsDir, "public", "cockpit.crt"), "pas un certificat");
    fs.writeFileSync(path.join(tlsDir, "public", "cockpit-tls.json"), "{}");
    const server = await fakeServer(healthReply("http"));
    try {
      const env = { COCKPIT_PORT: String(server.port), COCKPIT_TLS_DIR: tlsDir, ESPION_TLS_DIR: tlsDir };
      const http = await healthcheck({ ...env, ...HTTP_ENV }, [FS_SPY]);
      assert.equal(http.code, 0, http.stderr);
      assert.doesNotMatch(http.stderr, /ESPION-TLS/);
      const https = await healthcheck(env, [FS_SPY]);
      assert.equal(https.code, 1);
      assert.match(https.stderr, /ESPION-TLS readFileSync/);
    } finally {
      await server.close();
    }
  });

  it("NODE_USE_ENV_PROXY=1 et proxy mort : 0 (agent sans proxy) ; témoin : l'agent par défaut passe par le proxy et échoue", async () => {
    const server = await fakeServer(healthReply("http"));
    const [deadProxy] = await freePorts(1);
    const proxy = `http://127.0.0.1:${deadProxy}`;
    const env = { ...HTTP_ENV, COCKPIT_PORT: String(server.port), NODE_USE_ENV_PROXY: "1", HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy };
    try {
      const result = await healthcheck(env);
      assert.equal(result.code, 0, result.stderr);
      const witness = spawnNode(
        [
          "--input-type=module",
          "-e",
          'import http from "node:http"; http.get({ host: "127.0.0.1", port: Number(process.env.COCKPIT_PORT), path: "/api/health", timeout: 4000 }, (res) => { res.resume(); process.exit(res.statusCode === 200 ? 0 : 1); }).on("error", () => process.exit(1)).on("timeout", () => process.exit(1));',
        ],
        cleanEnv(env),
      );
      try {
        assert.equal(await exitCode(witness, 20_000), 1, "le témoin a joint le serveur sans passer par le proxy : test sans objet");
      } finally {
        await stop(witness);
      }
    } finally {
      await server.close();
    }
  });
});
