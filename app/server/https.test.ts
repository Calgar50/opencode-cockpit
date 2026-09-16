// HTTPS local 1.0.5 avec openssl réel : main.ts de bout en bout, écoute TLS en processus, healthcheck HTTPS en sous-processus.
// Sauté en local quand openssl manque ; COCKPIT_TEST_REQUIRE_OPENSSL=1 (CI) le rend obligatoire. Jetons de test publics.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import tls from "node:tls";
import { pathToFileURL } from "node:url";
import { Hono } from "hono";
import type { Logger } from "./log.ts";
import { type LocalServer, startLocalServer } from "./server-start.ts";
import { ensureServerCertificate, normalizeSanHosts, type ServerCertificate, TlsRefusals, TlsSetupError } from "./tls.ts";

const OPENSSL = process.env.COCKPIT_OPENSSL?.trim() || "/usr/bin/openssl";
const REQUIRE_OPENSSL = process.env.COCKPIT_TEST_REQUIRE_OPENSSL === "1";
const SKIP_OPENSSL = !REQUIRE_OPENSSL && !fs.existsSync(OPENSSL) ? "SKIP openssl absent" : false;
const POSIX = process.platform !== "win32";
const SKIP_SIGNALS = SKIP_OPENSSL || (POSIX ? false : "SKIP signaux POSIX (Windows)");

const SERVER_DIR = import.meta.dirname;
const APP_DIR = path.dirname(SERVER_DIR);
/** Jeton de test public, au format généré par install.ps1. */
const TOKEN = "6e".repeat(32);
const VERSION = "1.0.5-test";
const FAUX_JETON = `faux-jeton-${"7".repeat(40)}`;
// Bloc piégé assemblé à l'exécution : aucune étiquette de clé privée en clair dans le dépôt.
const PIEGE_B64 = Buffer.from("piege de test https : ceci n'est pas une vraie cle, rien ne doit en sortir").toString("base64");
const PIEGE_PEM = [["-----BEGIN", "PRIVATE", "KEY-----"].join(" "), PIEGE_B64, ["-----END", "PRIVATE", "KEY-----"].join(" ")].join("\n");
const INITIAL_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
// CSP de la 1.0.4, recopiées : elles ne changent pas d'un octet avec le mode.
const CSP_PAGE =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const CSP_API = "default-src 'none'; frame-ancestors 'none'; sandbox";

const roots: string[] = [];
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-https-"));
  roots.push(dir);
  return dir;
}

/** Volume /tls simulé : dossier 0700 à l'utilisateur courant. */
function freshTlsDir(): string {
  const dir = path.join(tempDir(), "tls");
  fs.mkdirSync(dir, { mode: 0o700 });
  if (POSIX) fs.chmodSync(dir, 0o700);
  return dir;
}

const LISTEN_SPY = path.join(tempDir(), "espion-listen.mjs");
fs.writeFileSync(
  LISTEN_SPY,
  [
    'import net from "node:net";',
    "const listen = net.Server.prototype.listen;",
    'net.Server.prototype.listen = function (...args) { process.stderr.write("ESPION-LISTEN\\n"); return listen.apply(this, args); };',
    "",
  ].join("\n"),
);

function captureLog(): { log: Logger; lines: Array<{ level: string; message: string; fields: Record<string, unknown> | undefined }>; text: () => string } {
  const lines: Array<{ level: string; message: string; fields: Record<string, unknown> | undefined }> = [];
  const write = (level: string) => (message: string, fields?: Record<string, unknown>) => {
    lines.push({ level, message, fields });
  };
  return { log: { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") }, lines, text: () => JSON.stringify(lines) };
}

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
  logs: Array<Record<string, unknown>>;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<number | null>;
}

function spawnNode(args: string[], env: NodeJS.ProcessEnv): NodeRun {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", ...args], { cwd: APP_DIR, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  /** Empreinte SHA-256 du certificat présenté par le serveur. */
  peer: string | undefined;
  protocol: string | null;
}

interface TlsCallOptions {
  /** Autorité : la feuille publique ; null = magasin par défaut de Node. */
  ca: string | null;
  headers?: Record<string, string>;
  body?: string;
  maxVersion?: tls.SecureVersion;
}

function tlsCall(port: number, method: string, pathname: string, o: TlsCallOptions): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: pathname,
        agent: false,
        rejectUnauthorized: true,
        ...(o.ca === null ? {} : { ca: o.ca }),
        ...(o.maxVersion === undefined ? {} : { maxVersion: o.maxVersion }),
        headers: { host: `127.0.0.1:${port}`, ...o.headers },
      },
      (res) => {
        const socket = res.socket as tls.TLSSocket;
        const peer = socket.getPeerX509Certificate()?.fingerprint256;
        const protocol = socket.getProtocol();
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data, peer, protocol }));
      },
    );
    req.on("error", reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

/** HTTP en clair envoyé sur le port TLS : octets reçus avant la fermeture. */
function plainBytes(port: number, payload: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const socket = net.connect(port, "127.0.0.1", () => socket.write(payload));
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("connexion en clair toujours ouverte"));
    }, 10_000);
    socket.on("data", (chunk: Buffer) => (bytes += chunk.length));
    socket.on("error", () => undefined);
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(bytes);
    });
  });
}

const tokenMac = (usage: "health-proof" | "auth-ticket" | "auth-ticket-request", value: string): string =>
  crypto.createHmac("sha256", TOKEN).update(`opencode-cockpit/${usage}/v1\n${value}`).digest("hex");
const newChallenge = (): string => crypto.randomBytes(32).toString("hex");
const setCookiesOf = (reply: { headers: http.IncomingHttpHeaders }): string[] => reply.headers["set-cookie"] ?? [];
const normalizePem = (pem: string): string => pem.replace(/\s+/g, "");

async function healthcheck(env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string; ms: number }> {
  const started = Date.now();
  const run = spawnNode([path.join(SERVER_DIR, "healthcheck.ts")], cleanEnv(env));
  try {
    const code = await exitCode(run, 20_000);
    return { code, stderr: run.stderr(), ms: Date.now() - started };
  } finally {
    await stop(run);
  }
}

// --- main.ts de bout en bout ----------------------------------------------------------------------------------------------

describe("HTTPS de bout en bout (main.ts réel, openssl)", { skip: SKIP_OPENSSL }, () => {
  let run: NodeRun | undefined;
  let port = 0;
  let tlsDir = "";
  let ca = "";
  let info: Record<string, unknown> = {};
  let sessionCookie = "";
  /** Valeurs envoyées au serveur qui ne doivent apparaître ni dans le journal, ni dans l'API, ni dans public/. */
  const secrets = [TOKEN, FAUX_JETON, PIEGE_B64];

  before(async () => {
    const root = tempDir();
    const [cockpitPort, deadPort] = await freePorts(2);
    port = cockpitPort ?? 0;
    for (const name of ["archives", "workspace", "oc-config", "oc-data", "control", "certs", "web"]) fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, "web", "index.html"), "<!doctype html><title>cockpit</title>");
    tlsDir = freshTlsDir();
    run = spawnNode(
      ["--import", pathToFileURL(LISTEN_SPY).href, path.join(SERVER_DIR, "main.ts")],
      cleanEnv({
        COCKPIT_TOKEN: TOKEN,
        OPENCODE_SERVER_PASSWORD: "p".repeat(24),
        COCKPIT_HOST: "127.0.0.1",
        COCKPIT_PORT: String(port),
        COCKPIT_DATA_DIR: path.join(root, "data"),
        COCKPIT_ARCHIVE_DIR: path.join(root, "archives"),
        COCKPIT_WORKSPACE_DIR: path.join(root, "workspace"),
        COCKPIT_OC_CONFIG_DIR: path.join(root, "oc-config"),
        COCKPIT_OC_DATA_DIR: path.join(root, "oc-data"),
        COCKPIT_CONTROL_DIR: path.join(root, "control"),
        COCKPIT_CERTS_DIR: path.join(root, "certs"),
        COCKPIT_WEB_DIR: path.join(root, "web"),
        OPENCODE_URL: `http://127.0.0.1:${deadPort}`,
        COCKPIT_TLS_DIR: tlsDir,
        COCKPIT_OPENSSL: OPENSSL,
        COCKPIT_VERSION: VERSION,
        COCKPIT_LOG_LEVEL: "info",
      }),
    );
    const current = run;
    await waitFor(
      () => {
        if (current.child.exitCode !== null) throw new Error(`main.ts arrêté (${current.child.exitCode}) : ${current.stdout()} ${current.stderr()}`);
        return current.logs.find((line) => line.msg === "cockpit à l'écoute");
      },
      60_000,
      "cockpit à l'écoute",
    );
    ca = fs.readFileSync(path.join(tlsDir, "public", "cockpit.crt"), "utf8");
    info = JSON.parse(fs.readFileSync(path.join(tlsDir, "public", "cockpit-tls.json"), "utf8")) as Record<string, unknown>;
  });

  after(async () => {
    if (run) await stop(run);
  });

  const main = (): NodeRun => {
    assert.ok(run);
    return run;
  };

  it("une seule écoute, en HTTPS ; journal : schéma, version, empreinte et échéance", () => {
    assert.equal(main().stderr().split("\n").filter((line) => line.trim() === "ESPION-LISTEN").length, 1, main().stderr());
    const line = main().logs.find((l) => l.msg === "cockpit à l'écoute");
    assert.equal(line?.scheme, "https");
    assert.equal(line?.version, VERSION);
    assert.equal(line?.sha256, info.sha256);
    assert.equal(line?.notAfter, info.notAfter);
    assert.equal(main().logs.some((l) => String(l.msg).includes("mode HTTP")), false);
  });

  it("/api/health : feuille comme autorité ; refus sans autorité ; client TLS 1.2 accepté ; schéma https ; preuve du jeton", async () => {
    const health = await tlsCall(port, "GET", "/api/health", { ca });
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { ok: true, version: VERSION, scheme: "https" });
    assert.equal(health.peer, info.sha256);
    await assert.rejects(tlsCall(port, "GET", "/api/health", { ca: null }), (err: NodeJS.ErrnoException) => err.code === "DEPTH_ZERO_SELF_SIGNED_CERT");
    const tls12 = await tlsCall(port, "GET", "/api/health", { ca, maxVersion: "TLSv1.2" });
    assert.equal(tls12.status, 200);
    assert.equal(tls12.protocol, "TLSv1.2");
    const challenge = newChallenge();
    secrets.push(challenge);
    const proved = JSON.parse((await tlsCall(port, "GET", `/api/health?challenge=${challenge}`, { ca })).body) as Record<string, unknown>;
    assert.equal(proved.proof, tokenMac("health-proof", challenge));
    assert.equal(proved.ticket, undefined);
  });

  it("HTTP en clair sur le port TLS : 0 octet puis fermeture ; http.request → ECONNRESET ; HTTPS toujours servi", async () => {
    assert.equal(await plainBytes(port, `GET /auth?t=${FAUX_JETON} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`), 0);
    await assert.rejects(
      new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, path: `/auth?t=${FAUX_JETON}`, agent: false }, resolve);
        req.on("error", reject);
        req.end();
      }),
      (err: NodeJS.ErrnoException) => err.code === "ECONNRESET",
    );
    assert.equal((await tlsCall(port, "GET", "/api/health", { ca })).status, 200);
  });

  it("ticket : lien → cookie __Host- exact ; lien rejoué refusé ; /auth?t= → ancien-lien sans cookie ; saisie du jeton inchangée en HTTPS", async () => {
    const challenge = newChallenge();
    const unsigned = await tlsCall(port, "GET", `/api/health?challenge=${challenge}&ticket=1`, { ca });
    assert.equal(unsigned.status, 403);
    assert.equal((JSON.parse(unsigned.body) as { ticket?: string }).ticket, undefined);
    const request = tokenMac("auth-ticket-request", challenge);
    const health = JSON.parse((await tlsCall(port, "GET", `/api/health?challenge=${challenge}&ticket=${request}`, { ca })).body) as { proof?: string; ticket?: string };
    assert.equal(health.proof, tokenMac("health-proof", challenge));
    const ticket = health.ticket ?? "";
    assert.match(ticket, /^[0-9a-f]{64}$/);
    secrets.push(challenge, request, ticket);
    const link = `/auth?k=${ticket}.${tokenMac("auth-ticket", ticket)}`;
    const opened = await tlsCall(port, "GET", link, { ca, headers: { "sec-fetch-site": "none", "sec-fetch-dest": "document" } });
    assert.equal(opened.status, 303);
    assert.equal(opened.headers.location, "/");
    const cookies = setCookiesOf(opened);
    assert.match(cookies[0] ?? "", /^__Host-cockpit_session=\d+\.[A-Za-z0-9_-]{43}; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
    assert.equal(cookies[1], "cockpit_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict");
    assert.equal(cookies.length, 2);
    sessionCookie = (cookies[0] ?? "").split(";")[0] ?? "";

    const replay = await tlsCall(port, "GET", link, { ca });
    assert.equal(replay.headers.location, "/?auth=failed");
    assert.deepEqual(setCookiesOf(replay), []);
    const legacy = await tlsCall(port, "GET", `/auth?t=${TOKEN}`, { ca });
    assert.equal(legacy.status, 303);
    assert.equal(legacy.headers.location, "/?auth=ancien-lien");
    assert.deepEqual(setCookiesOf(legacy), []);

    const json = { "x-cockpit-csrf": "1", "content-type": "application/json" };
    assert.equal((await tlsCall(port, "POST", "/api/login", { ca, headers: json, body: JSON.stringify({ token: FAUX_JETON }) })).status, 401);
    assert.equal((await tlsCall(port, "POST", "/api/login", { ca, headers: json, body: JSON.stringify({ token: PIEGE_PEM }) })).status, 401);
    const typed = await tlsCall(port, "POST", "/api/login", { ca, headers: json, body: JSON.stringify({ token: TOKEN }) });
    assert.equal(typed.status, 200, typed.body);
    assert.match(setCookiesOf(typed)[0] ?? "", /^__Host-cockpit_session=/);
  });

  it("état et bootstrap : schéma https, certificat servi ; magasin d'autorités de Node intact ; NODE_TLS_REJECT_UNAUTHORIZED inchangé", async () => {
    assert.ok(sessionCookie, "session ouverte par le test précédent");
    const status = await tlsCall(port, "GET", "/api/system/status", { ca, headers: { cookie: sessionCookie } });
    assert.equal(status.status, 200, status.body);
    const security = (JSON.parse(status.body) as { security: Record<string, unknown> }).security;
    assert.equal(security.localScheme, "https");
    assert.equal(security.localHttpConfirmedAt, null);
    const served = security.tls as Record<string, unknown>;
    assert.equal(served.sha256, status.peer);
    for (const key of ["source", "sha256", "spkiSha256Base64", "notBefore", "notAfter", "san", "ignoredHosts", "generatedAt", "previousSha256"]) {
      assert.deepEqual(served[key], info[key], key);
    }
    assert.ok(typeof served.daysLeft === "number" && served.daysLeft >= 395 && served.daysLeft <= 397, String(served.daysLeft));
    assert.ok(typeof served.refusals24h === "number" && served.refusals24h >= 2, String(served.refusals24h));
    assert.equal(served.internalTraffic, "http-docker");

    const bootstrap = await tlsCall(port, "GET", "/api/bootstrap", { ca, headers: { cookie: sessionCookie } });
    const boot = (JSON.parse(bootstrap.body) as { security: Record<string, unknown> }).security;
    assert.equal(boot.localScheme, "https");
    assert.deepEqual(boot.tls, { sha256: info.sha256, notAfter: info.notAfter, daysLeft: served.daysLeft });

    assert.equal(tls.getCACertificates("default").some((pem) => normalizePem(pem) === normalizePem(ca)), false);
    assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, INITIAL_REJECT_UNAUTHORIZED);
  });

  it("anti-CSRF : origine http du même hôte refusée en HTTPS, origine https acceptée", async () => {
    const put = (origin: string) =>
      tlsCall(port, "PUT", "/api/settings", {
        ca,
        headers: { cookie: sessionCookie, "x-cockpit-csrf": "1", "content-type": "application/json", origin },
        body: "{}",
      });
    assert.equal((await put(`http://127.0.0.1:${port}`)).status, 403);
    assert.equal((await put(`https://127.0.0.1:${port}`)).status, 200);
    assert.equal((await put(`https://localhost:${port}`)).status, 403);
  });

  it("SSE : hello et en-têtes ; aucun HSTS ; CSP identiques à la 1.0.4", async () => {
    const page = await tlsCall(port, "GET", "/", { ca });
    assert.equal(page.headers["content-security-policy"], CSP_PAGE);
    const health = await tlsCall(port, "GET", "/api/health", { ca });
    assert.equal(health.headers["content-security-policy"], CSP_API);
    const redirect = await tlsCall(port, "GET", `/auth?k=${"0".repeat(64)}.${"0".repeat(64)}`, { ca });
    assert.equal(redirect.status, 303);
    for (const reply of [page, health, redirect]) assert.equal(reply.headers["strict-transport-security"], undefined);

    const events = await new Promise<{ req: http.ClientRequest; res: http.IncomingMessage }>((resolve, reject) => {
      const req = https.get(
        { host: "127.0.0.1", port, path: "/api/events", agent: false, ca, headers: { host: `127.0.0.1:${port}`, cookie: sessionCookie } },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            text += chunk;
            if (text.includes("event: hello")) resolve({ req, res });
          });
        },
      );
      req.on("error", reject);
    });
    try {
      assert.equal(events.res.statusCode, 200);
      assert.match(String(events.res.headers["content-type"]), /^text\/event-stream/);
      assert.equal(events.res.headers["content-security-policy"], CSP_API);
      assert.equal(events.res.headers["strict-transport-security"], undefined);
    } finally {
      events.req.destroy();
    }
  });

  it("healthcheck du serveur réel : 0", async () => {
    const result = await healthcheck({ COCKPIT_PORT: String(port), COCKPIT_TLS_DIR: tlsDir });
    assert.equal(result.code, 0, result.stderr);
  });

  it("jeton, faux jeton, faux bloc PEM, défi et ticket absents du journal, de /api/system/status et de public/", async () => {
    const status = await tlsCall(port, "GET", "/api/system/status", { ca, headers: { cookie: sessionCookie } });
    const publicDir = path.join(tlsDir, "public");
    const published = fs
      .readdirSync(publicDir)
      .map((name) => fs.readFileSync(path.join(publicDir, name), "utf8"))
      .join("\n");
    assert.equal(published.includes("PRIVATE KEY"), false);
    const journal = main().stdout() + main().stderr();
    for (const secret of secrets) {
      assert.equal(journal.includes(secret), false, "journal");
      assert.equal(status.body.includes(secret), false, "état");
      assert.equal(published.includes(secret), false, "public/");
    }
    assert.equal(journal.includes("PRIVATE KEY"), false);
  });

  it("arrêt : SIGTERM avec deux flux SSE ouverts, sortie en moins d'une seconde ; poignées refusées journalisées par code", { skip: SKIP_SIGNALS }, async () => {
    const openStream = () =>
      new Promise<http.ClientRequest>((resolve, reject) => {
        const req = https.get(
          { host: "127.0.0.1", port, path: "/api/events", agent: false, ca, headers: { host: `127.0.0.1:${port}`, cookie: sessionCookie } },
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
              text += chunk;
              if (text.includes("event: hello")) resolve(req);
            });
            res.on("error", () => undefined);
          },
        );
        req.on("error", (err) => reject(err));
      });
    const streams = [await openStream(), await openStream()];
    for (const stream of streams) stream.on("error", () => undefined);
    const current = main();
    const started = performance.now();
    current.child.kill("SIGTERM");
    const code = await exitCode(current, 10_000);
    const elapsed = performance.now() - started;
    for (const stream of streams) stream.destroy();
    assert.equal(code, 0, current.stdout());
    assert.ok(elapsed < 1_000, `${Math.round(elapsed)} ms`);
    assert.ok(current.logs.some((line) => line.msg === "arrêt du cockpit" && line.signal === "SIGTERM"));
    const refused = current.logs.find((line) => line.msg === "connexions TLS refusées sur la boucle locale");
    const codes = refused?.codes as Record<string, number> | undefined;
    assert.ok((codes?.ERR_SSL_HTTP_REQUEST ?? 0) >= 2, current.stdout());
  });
});

// --- Écoute TLS en processus et healthcheck HTTPS ------------------------------------------------------------------------

describe("écoute TLS en processus et healthcheck HTTPS (openssl)", { skip: SKIP_OPENSSL }, () => {
  const BASE = normalizeSanHosts([]).entries;
  let pairA: ServerCertificate;
  let pairB: ServerCertificate;
  let dirA = "";

  before(async () => {
    dirA = freshTlsDir();
    pairA = await ensureServerCertificate({ tlsDir: dirA, entries: BASE, opensslPath: OPENSSL, log: captureLog().log });
    pairB = await ensureServerCertificate({ tlsDir: freshTlsDir(), entries: BASE, opensslPath: OPENSSL, log: captureLog().log });
    assert.notEqual(pairA.info.sha256, pairB.info.sha256);
  });

  const appOf = () => {
    const app = new Hono();
    app.get("/api/health", (c) => c.json({ ok: true, version: VERSION, scheme: "https" }));
    return app;
  };

  async function listenTls(pair: ServerCertificate, refusals: TlsRefusals): Promise<{ server: LocalServer; port: number }> {
    let onPort: (port: number) => void = () => undefined;
    const listening = new Promise<number>((resolve) => {
      onPort = resolve;
    });
    const server = startLocalServer({
      app: appOf(),
      hostname: "127.0.0.1",
      port: 0,
      listen: { scheme: "https", tls: { key: pair.key, cert: pair.cert, refusals } },
      onListening: (port) => onPort(port),
    });
    return { server, port: await listening };
  }

  async function closeServer(server: http.Server | https.Server): Promise<void> {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }

  it("TLS 1.2 minimum explicite, même quand le minimum par défaut de Node est abaissé (NODE_OPTIONS=--tls-min-v1.0)", async () => {
    const saved = tls.DEFAULT_MIN_VERSION;
    tls.DEFAULT_MIN_VERSION = "TLSv1";
    try {
      const { server, port } = await listenTls(pairA, new TlsRefusals({ log: captureLog().log }));
      try {
        assert.equal((server as https.Server & { minVersion?: string }).minVersion, "TLSv1.2");
        const reply = await tlsCall(port, "GET", "/api/health", { ca: pairA.cert, maxVersion: "TLSv1.2" });
        assert.equal(reply.status, 200);
      } finally {
        await closeServer(server);
      }
    } finally {
      tls.DEFAULT_MIN_VERSION = saved;
    }
  });

  it("poignée refusée (HTTP en clair) : code filtré compté, jamais le contenu reçu", async () => {
    const capture = captureLog();
    const refusals = new TlsRefusals({ log: capture.log });
    const { server, port } = await listenTls(pairA, refusals);
    try {
      assert.equal(await plainBytes(port, `GET /auth?t=${FAUX_JETON} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n${PIEGE_PEM}`), 0);
      await waitFor(() => (refusals.count24h() >= 1 ? true : undefined), 5_000, "poignée refusée comptée");
      refusals.flush(true);
      const line = capture.lines.find((l) => l.message === "connexions TLS refusées sur la boucle locale");
      assert.deepEqual(line?.fields, { total: 1, codes: { ERR_SSL_HTTP_REQUEST: 1 } });
      assert.equal(capture.text().includes(FAUX_JETON), false);
      assert.equal(capture.text().includes(PIEGE_B64), false);
    } finally {
      await closeServer(server);
    }
  });

  it("paire incohérente : TlsSetupError avant toute écoute", () => {
    const prototype = net.Server.prototype as unknown as { listen: (...args: unknown[]) => unknown };
    const original = prototype.listen;
    let calls = 0;
    prototype.listen = function (this: unknown, ...args: unknown[]) {
      calls++;
      return original.apply(this, args);
    };
    try {
      assert.throws(
        () =>
          startLocalServer({
            app: appOf(),
            hostname: "127.0.0.1",
            port: 0,
            listen: { scheme: "https", tls: { key: pairA.key, cert: pairB.cert, refusals: new TlsRefusals({ log: captureLog().log }) } },
            onListening: () => undefined,
          }),
        (err: unknown) => err instanceof TlsSetupError && err.reason === "cle-certificat-incoherents" && !/PRIVATE|-----/.test(err.message),
      );
      assert.equal(calls, 0);
    } finally {
      prototype.listen = original;
    }
  });

  /** Serveur HTTPS de test (paire donnée) qui répond `handler`. */
  async function fakeTls(pair: ServerCertificate, handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
    const server = https.createServer({ key: pair.key, cert: pair.cert }, handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { port: (server.address() as AddressInfo).port, close: () => closeServer(server) };
  }

  /** Dossier public forgé : feuille `certPem` et empreinte annoncée `sha256`. */
  function publicDir(certPem: string, sha256: unknown): string {
    const dir = path.join(tempDir(), "tls");
    fs.mkdirSync(path.join(dir, "public"), { recursive: true });
    fs.writeFileSync(path.join(dir, "public", "cockpit.crt"), certPem);
    fs.writeFileSync(path.join(dir, "public", "cockpit-tls.json"), JSON.stringify({ schema: 1, sha256 }));
    return dir;
  }

  const reply =
    (scheme: string, status = 200): http.RequestListener =>
    (_req, res) => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, version: VERSION, scheme }));
    };

  it("healthcheck HTTPS : bonne empreinte → 0 ; autre empreinte annoncée → 1 ; autre certificat servi → 1, même avec NODE_TLS_REJECT_UNAUTHORIZED=0", async () => {
    const servedA = await fakeTls(pairA, reply("https"));
    const servedB = await fakeTls(pairB, reply("https"));
    try {
      const check = (serverPort: number, tlsDir: string, extra: NodeJS.ProcessEnv = {}) =>
        healthcheck({ COCKPIT_PORT: String(serverPort), COCKPIT_TLS_DIR: tlsDir, ...extra });
      const leafA = fs.readFileSync(path.join(dirA, "public", "cockpit.crt"), "utf8");
      const ok = await check(servedA.port, dirA);
      assert.equal(ok.code, 0, ok.stderr);
      // Même feuille, empreinte annoncée différente.
      assert.equal((await check(servedA.port, publicDir(leafA, pairB.info.sha256))).code, 1);
      // Autre certificat servi, fichiers publics de A.
      assert.equal((await check(servedB.port, dirA)).code, 1);
      assert.equal((await check(servedB.port, dirA, { NODE_TLS_REJECT_UNAUTHORIZED: "0" })).code, 1);
      // Autre certificat servi dont l'empreinte est annoncée, mais feuille publique de A : la vérification par l'autorité refuse.
      const forged = publicDir(leafA, pairB.info.sha256);
      assert.equal((await check(servedB.port, forged)).code, 1);
      assert.equal((await check(servedB.port, forged, { NODE_TLS_REJECT_UNAUTHORIZED: "0" })).code, 1);
      // Empreinte annoncée mal formée.
      assert.equal((await check(servedA.port, publicDir(leafA, "abc"))).code, 1);
    } finally {
      await Promise.all([servedA.close(), servedB.close()]);
    }
  });

  it("healthcheck HTTPS : 503 → 1 ; schéma http → 1 ; serveur muet → 1 dans le délai ; COCKPIT_LOCAL_SCHEME=http sans date → 1", async () => {
    const unavailable = await fakeTls(pairA, reply("https", 503));
    const wrongScheme = await fakeTls(pairA, reply("http"));
    const silent = await fakeTls(pairA, () => undefined);
    try {
      assert.equal((await healthcheck({ COCKPIT_PORT: String(unavailable.port), COCKPIT_TLS_DIR: dirA })).code, 1);
      assert.equal((await healthcheck({ COCKPIT_PORT: String(wrongScheme.port), COCKPIT_TLS_DIR: dirA })).code, 1);
      const slow = await healthcheck({ COCKPIT_PORT: String(silent.port), COCKPIT_TLS_DIR: dirA });
      assert.equal(slow.code, 1);
      assert.ok(slow.ms < 8_000, `${slow.ms} ms`);
      assert.equal((await healthcheck({ COCKPIT_PORT: String(wrongScheme.port), COCKPIT_TLS_DIR: dirA, COCKPIT_LOCAL_SCHEME: "http" })).code, 1);
    } finally {
      await Promise.all([unavailable.close(), wrongScheme.close(), silent.close()]);
    }
  });
});
