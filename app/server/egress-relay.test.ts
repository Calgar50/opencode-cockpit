// Relais de sortie d'opencode (1.0.6) : règle pure (egress-policy.ts) puis relais réel sur des connexions locales (node:net et
// http.request, jamais fetch). Aucune connexion vers Internet : chaque sortie passe par le connecteur injecté, qui la note et la
// dirige vers un serveur local (écho, ou faux proxy d'entreprise). Attentes sur événement, bornées ; horloge injectée.
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import type os from "node:os";
import { describe, it, type TestContext } from "node:test";
import {
  canonicalHostName,
  decideConnect,
  egressAllowedHosts,
  isIpLiteral,
  LOGIN_WINDOW_MS,
  LoginWindow,
  parseEnterpriseDomain,
  splitConnectTarget,
} from "./egress-policy.ts";
import {
  createEgressRelay,
  type EgressRelayOptions,
  findInternalNetwork,
  hostForLog,
  inNetwork,
  RELAY_LIMITS,
  RelayConfigError,
  readUpstreamProxy,
  startEgressRelay,
} from "./egress-relay.ts";
import type { Logger } from "./log.ts";

const COPILOT = "api.githubcopilot.com";
/** Signe kelvin (U+212A) : sa minuscule est « k », il ne doit jamais passer pour un nom ASCII. */
const KELVIN = String.fromCharCode(0x212a);
const ALLOWED: ReadonlySet<string> = new Set([COPILOT]);
const HOUR = 60 * 60_000;
const T0 = Date.UTC(2026, 8, 23, 12, 0, 0);

// --- Aides -------------------------------------------------------------------------------------------------------------------------

interface LogLine {
  level: string;
  msg: string;
  [key: string]: unknown;
}

function testLog(): { log: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const write = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    lines.push({ level, msg, ...fields });
  };
  return { log: { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") }, lines };
}

async function until(probe: () => boolean, what: string, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`délai dépassé : ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const listenLocal = (server: net.Server): Promise<number> =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port)));

interface TcpServer {
  port: number;
  received: () => string;
  connections: number;
}

/** Serveur TCP local : écho, ou comportement donné ; détruit à la fin du test. */
async function tcpServer(t: TestContext, onConnection: (socket: net.Socket, state: { data: string }) => void): Promise<TcpServer> {
  const sockets = new Set<net.Socket>();
  const state = { data: "" };
  let connections = 0;
  const server = net.createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      state.data += chunk.toString("latin1");
    });
    socket.once("close", () => sockets.delete(socket));
    onConnection(socket, state);
  });
  const port = await listenLocal(server);
  t.after(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return {
    port,
    received: () => state.data,
    get connections() {
      return connections;
    },
  };
}

interface Client {
  socket: net.Socket;
  text: () => string;
  closed: () => boolean;
}

function rawClient(t: TestContext, port: number, payload?: string | Buffer): Client {
  const socket = net.connect({ host: "127.0.0.1", port });
  t.after(() => socket.destroy());
  let received = Buffer.alloc(0);
  let closed = false;
  socket.on("data", (chunk: Buffer) => {
    received = Buffer.concat([received, chunk]);
  });
  socket.on("error", () => undefined);
  socket.once("close", () => {
    closed = true;
  });
  if (payload !== undefined) socket.write(payload);
  return { socket, text: () => received.toString("latin1"), closed: () => closed };
}

const connectRequest = (target: string, headers: string[] = [`Host: ${target}`]) => `CONNECT ${target} HTTP/1.1\r\n${headers.map((h) => `${h}\r\n`).join("")}\r\n`;

async function statusLine(c: Client): Promise<string> {
  await until(() => c.text().includes("\r\n\r\n") || c.closed(), "réponse du relais");
  return c.text().split("\r\n")[0] ?? "";
}

interface Bench {
  port: number;
  lines: LogLine[];
  /** Sorties demandées au connecteur (hôte, port). */
  outbound: Array<[string, number]>;
  clock: { now: number };
}

/**
 * Relais réel sur 127.0.0.1. Toute sortie passe par le connecteur, qui la note puis la dirige vers `route` (serveur local), ou la
 * refuse (connexion vers un port fermé) sans route.
 */
async function bench(t: TestContext, options: Partial<EgressRelayOptions> = {}, route: { port: number } | null = null): Promise<Bench> {
  const { log, lines } = testLog();
  const outbound: Array<[string, number]> = [];
  const clock = { now: T0 };
  const relay = createEgressRelay({
    allowedHosts: () => ALLOWED,
    upstream: null,
    log,
    now: () => clock.now,
    connect: (host, port) => {
      outbound.push([host, port]);
      return net.connect({ host: "127.0.0.1", port: route?.port ?? 9 });
    },
    ...options,
  });
  const port = await relay.listen(0, "127.0.0.1");
  t.after(() => relay.close());
  return { port, lines, outbound, clock };
}

const refusals = (lines: LogLine[]) => lines.filter((l) => l.level === "warn" && l.msg.startsWith("sortie d'opencode refusée"));

// --- Règle pure ----------------------------------------------------------------------------------------------------------------------

describe("règle de sortie du relais (egress-policy.ts)", () => {
  it("nom canonique : casse et point final normalisés, tout le reste refusé", () => {
    assert.equal(canonicalHostName("API.GitHubCopilot.COM"), COPILOT);
    assert.equal(canonicalHostName("api.githubcopilot.com."), COPILOT);
    for (const bad of ["", ".", "api.githubcopilot.com..", "localhost", "api_x.githubcopilot.com", "-api.githubcopilot.com", "a".repeat(64) + ".com", `${"a.".repeat(127)}com`, `api.github${KELVIN}opilot.com`, "exa mple.com", "user@api.githubcopilot.com", "api.githubcopilot.com/x"]) {
      assert.equal(canonicalHostName(bad), null, JSON.stringify(bad));
    }
  });

  it("adresses IP écrites en clair, sous toutes leurs formes", () => {
    for (const ip of ["140.82.112.5", "127.1", "2130706433", "0x7f.1", "10.0.0.1.", "[::1]", "::1", "fe80::1%eth0", "api.123"]) assert.equal(isIpLiteral(ip), true, ip);
    for (const name of [COPILOT, "1password.com", "x1.example"]) assert.equal(isIpLiteral(name), false, name);
  });

  it("cible d'un CONNECT : hôte et port tels qu'écrits", () => {
    assert.deepEqual(splitConnectTarget("api.githubcopilot.com:443"), { host: COPILOT, port: 443 });
    assert.deepEqual(splitConnectTarget("[::1]:443"), { host: "[::1]", port: 443 });
    assert.ok(Number.isNaN(splitConnectTarget("api.githubcopilot.com").port));
    assert.ok(Number.isNaN(splitConnectTarget("api.githubcopilot.com:44x").port));
  });

  it("décision : hôte permis (casse et point final compris), sinon raison précise", () => {
    assert.deepEqual(decideConnect("api.githubcopilot.com:443", ALLOWED), { allow: true, host: COPILOT });
    assert.deepEqual(decideConnect("API.GITHUBCOPILOT.COM.:443", ALLOWED), { allow: true, host: COPILOT });
    const cases: Array<[string, string]> = [
      ["api.githubcopilot.com:80", "port"],
      ["api.githubcopilot.com", "port"],
      ["api.githubcopilot.com:0443x", "port"],
      ["140.82.112.5:443", "ip-litterale"],
      ["[2606:50c0::1]:443", "ip-litterale"],
      ["2130706433:443", "ip-litterale"],
      ["user:secret@api.githubcopilot.com:443", "invalide"],
      [":443", "invalide"],
      ["models.opencode.ai:443", "hote"],
      ["registry.npmjs.org:443", "hote"],
      ["api.githubcopilot.com.evil.example:443", "hote"],
      ["evil-api.githubcopilot.com:443", "hote"],
      ["githubcopilot.com:443", "hote"],
    ];
    for (const [target, reason] of cases) {
      const decision = decideConnect(target, ALLOWED);
      assert.equal(decision.allow, false, target);
      assert.equal(decision.allow ? "" : decision.reason, reason, target);
    }
    // api.github.com n'est jamais relayé, même donné comme permis.
    const decision = decideConnect("api.github.com:443", new Set(["api.github.com"]));
    assert.equal(decision.allow, false);
  });

  it("liste fermée : une seule adresse d'API connue, github.com seulement pendant une connexion, jamais api.github.com", () => {
    const base = { copilotApiUrl: null, endpointUrl: null, enterpriseDomain: null, loginOpen: false };
    assert.deepEqual([...egressAllowedHosts(base)], [COPILOT]);
    // Adresse imposée : seule relayée, même si la dernière adresse vérifiée est une autre.
    assert.deepEqual([...egressAllowedHosts({ ...base, copilotApiUrl: "https://api.business.githubcopilot.com", endpointUrl: "https://api.githubcopilot.com" })], ["api.business.githubcopilot.com"]);
    // Adresse de l'abonnement vérifiée : l'adresse d'office, bloquée par le réseau, n'est plus relayée (refus local, aucune alerte).
    assert.deepEqual([...egressAllowedHosts({ ...base, endpointUrl: "https://api.business.githubcopilot.com" })], ["api.business.githubcopilot.com"]);
    // Adresse hors de la liste officielle (auth.json modifié, par exemple) : jamais relayée.
    assert.deepEqual([...egressAllowedHosts({ ...base, endpointUrl: "https://copilot.evil.example" })], []);
    assert.deepEqual([...egressAllowedHosts({ ...base, loginOpen: true })].sort(), [COPILOT, "github.com"]);
    const ghe = egressAllowedHosts({ ...base, enterpriseDomain: "acme.ghe.com", loginOpen: true });
    assert.deepEqual([...ghe].sort(), ["acme.ghe.com", COPILOT, "copilot-api.acme.ghe.com", "github.com"].sort());
    for (const hosts of [egressAllowedHosts(base), ghe]) assert.equal(hosts.has("api.github.com"), false);
  });

  it("domaine GitHub Enterprise : schéma et barre finale retirés, nom DNS d'au moins deux étiquettes", () => {
    assert.equal(parseEnterpriseDomain(""), null);
    assert.equal(parseEnterpriseDomain(undefined), null);
    assert.equal(parseEnterpriseDomain(" https://Acme.GHE.com/ "), "acme.ghe.com");
    for (const bad of ["acme", "10.0.0.1", "acme.ghe.com/login", "*.ghe.com", "user@acme.ghe.com", "acme.ghe.com:8443"]) assert.equal(parseEnterpriseDomain(bad), undefined, bad);
  });

  it("fenêtre de connexion : ouverte 20 minutes, prolongée, puis fermée seule", () => {
    let now = T0;
    const window = new LoginWindow(() => now);
    assert.equal(window.isOpen(), false);
    window.open();
    now += LOGIN_WINDOW_MS - 1;
    assert.equal(window.isOpen(), true);
    now += 1;
    assert.equal(window.isOpen(), false);
    window.open();
    now += 60_000;
    window.open();
    now += LOGIN_WINDOW_MS - 1;
    assert.equal(window.isOpen(), true);
  });
});

// --- Relais réel ---------------------------------------------------------------------------------------------------------------------

describe("relais de sortie (egress-relay.ts)", () => {
  it("hôte permis : 200, tunnel direct vers le nom canonique:443, octets relayés dans les deux sens, rien au journal des refus", async (t) => {
    const echo = await tcpServer(t, (socket) => socket.pipe(socket));
    const b = await bench(t, {}, echo);
    const c = rawClient(t, b.port, connectRequest(`${COPILOT}:443`));
    assert.match(await statusLine(c), /^HTTP\/1\.1 200 /);
    c.socket.write("ping-tls");
    await until(() => c.text().includes("ping-tls"), "écho à travers le tunnel");
    assert.deepEqual(b.outbound, [[COPILOT, 443]]);
    assert.equal(refusals(b.lines).length, 0);
    assert.ok(b.lines.some((l) => l.msg === "relais du cockpit : hôtes permis pour opencode"));
  });

  it("casse et point final : CONNECT API.GITHUBCOPILOT.COM.:443 relayé vers api.githubcopilot.com", async (t) => {
    const echo = await tcpServer(t, (socket) => socket.pipe(socket));
    const b = await bench(t, {}, echo);
    const c = rawClient(t, b.port, connectRequest("API.GITHUBCOPILOT.COM.:443"));
    assert.match(await statusLine(c), /^HTTP\/1\.1 200 /);
    assert.deepEqual(b.outbound, [[COPILOT, 443]]);
  });

  it("hôte refusé : 403 sans AUCUNE connexion sortante ; une ligne par hôte et par heure, avec le nombre de refus", async (t) => {
    const b = await bench(t);
    for (let i = 0; i < 3; i++) {
      const c = rawClient(t, b.port, connectRequest("models.opencode.ai:443"));
      assert.match(await statusLine(c), /^HTTP\/1\.1 403 /);
    }
    const other = rawClient(t, b.port, connectRequest("registry.npmjs.org:443"));
    assert.match(await statusLine(other), /^HTTP\/1\.1 403 /);
    assert.deepEqual(b.outbound, []);
    let lines = refusals(b.lines);
    assert.deepEqual(
      lines.map((l) => [l.hote, l.port, l.raison, l.refus]),
      [
        ["models.opencode.ai", 443, "hote", 1],
        ["registry.npmjs.org", 443, "hote", 1],
      ],
    );
    // Une heure plus tard : nouvelle ligne pour cet hôte, qui compte aussi les refus tus entre-temps.
    b.clock.now += HOUR;
    const later = rawClient(t, b.port, connectRequest("models.opencode.ai:443"));
    assert.match(await statusLine(later), /^HTTP\/1\.1 403 /);
    lines = refusals(b.lines);
    assert.equal(lines.length, 3);
    assert.deepEqual([lines[2]?.hote, lines[2]?.refus], ["models.opencode.ai", 3]);
    assert.deepEqual(b.outbound, []);
  });

  it("adresse IP écrite en clair refusée (ip-litterale), sans connexion sortante", async (t) => {
    const b = await bench(t);
    for (const target of ["140.82.113.21:443", "[::1]:443", "2130706433:443"]) {
      const c = rawClient(t, b.port, connectRequest(target));
      assert.match(await statusLine(c), /^HTTP\/1\.1 403 /, target);
    }
    assert.deepEqual(b.outbound, []);
    assert.deepEqual(new Set(refusals(b.lines).map((l) => l.raison)), new Set(["ip-litterale"]));
  });

  it("port autre que 443 refusé, même vers l'hôte permis", async (t) => {
    const b = await bench(t);
    for (const target of [`${COPILOT}:80`, `${COPILOT}:22`, COPILOT]) {
      const c = rawClient(t, b.port, connectRequest(target));
      assert.match(await statusLine(c), /^HTTP\/1\.1 403 /, target);
    }
    assert.deepEqual(b.outbound, []);
    assert.deepEqual([...new Set(refusals(b.lines).map((l) => l.raison))], ["port"]);
  });

  it("en-tête CONNECT malformé : 400 (ou 403 pour une cible illisible), jamais de connexion sortante", async (t) => {
    const b = await bench(t);
    const garbage = rawClient(t, b.port, Buffer.from([0, 1, 2, 3, 13, 10, 13, 10]));
    assert.match(await statusLine(garbage), /^HTTP\/1\.1 400 /);
    const badHeader = rawClient(t, b.port, `CONNECT ${COPILOT}:443 HTTP/1.1\r\nHost ${COPILOT}\r\n\r\n`);
    assert.match(await statusLine(badHeader), /^HTTP\/1\.1 400 /);
    const lowerMethod = rawClient(t, b.port, `connect ${COPILOT}:443 HTTP/1.1\r\n\r\n`);
    assert.match(await statusLine(lowerMethod), /^HTTP\/1\.1 400 /);
    const credentials = rawClient(t, b.port, connectRequest(`user:secret@${COPILOT}:443`));
    assert.match(await statusLine(credentials), /^HTTP\/1\.1 403 /);
    const tooLong = rawClient(t, b.port, connectRequest(`${COPILOT}:443`, [`Host: ${COPILOT}:443`, `X-Bourrage: ${"a".repeat(RELAY_LIMITS.maxHeaderBytes)}`]));
    assert.match(await statusLine(tooLong), /^HTTP\/1\.1 431 /);
    assert.deepEqual(b.outbound, []);
    // Identifiants jamais recopiés dans le journal.
    assert.equal(JSON.stringify(b.lines).includes("secret"), false);
  });

  it("demande ordinaire (GET http://… par HTTP_PROXY) : 403, raison « methode », sans connexion sortante", async (t) => {
    const b = await bench(t);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: b.port, method: "GET", path: "http://models.opencode.ai/api.json?jeton=abc", agent: false }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.once("error", reject);
      req.end();
    });
    assert.equal(status, 403);
    assert.deepEqual(b.outbound, []);
    const [line] = refusals(b.lines);
    assert.deepEqual([line?.hote, line?.port, line?.raison], ["models.opencode.ai", 80, "methode"]);
    assert.equal(JSON.stringify(b.lines).includes("jeton"), false);
  });

  it("connexion venue d'ailleurs que le réseau interne : coupée, sans connexion sortante", async (t) => {
    const b = await bench(t, { acceptFrom: () => false });
    const c = rawClient(t, b.port, connectRequest(`${COPILOT}:443`));
    await until(() => c.closed(), "coupure de la connexion");
    assert.equal(c.text(), "");
    assert.deepEqual(b.outbound, []);
    assert.equal(refusals(b.lines)[0]?.raison, "origine");
  });

  it("chaîné au proxy de l'entreprise : CONNECT du nom canonique, identifiants seulement vers ce proxy, jamais au journal", async (t) => {
    const upstream = await tcpServer(t, (socket, state) => {
      const answer = () => {
        if (!state.data.includes("\r\n\r\n")) return;
        socket.off("data", answer);
        socket.write("HTTP/1.1 200 Connection established\r\nVia: proxy\r\n\r\n");
        socket.on("data", (chunk: Buffer) => socket.write(chunk));
      };
      socket.on("data", answer);
    });
    const b = await bench(t, { upstream: readUpstreamProxy({ HTTPS_PROXY: "http://agent%40banque:mot-de-passe@proxy.banque.example:3128" }) }, upstream);
    const c = rawClient(t, b.port, connectRequest(`${COPILOT.toUpperCase()}:443`, [`Host: ${COPILOT}:443`, "User-Agent: Bun/1.3"]));
    assert.match(await statusLine(c), /^HTTP\/1\.1 200 /);
    assert.deepEqual(b.outbound, [["proxy.banque.example", 3128]]);
    const sent = upstream.received();
    assert.match(sent, /^CONNECT api\.githubcopilot\.com:443 HTTP\/1\.1\r\nHost: api\.githubcopilot\.com:443\r\nUser-Agent: Bun\/1\.3\r\n/);
    assert.ok(sent.includes(`Proxy-Authorization: Basic ${Buffer.from("agent@banque:mot-de-passe").toString("base64")}`));
    c.socket.write("hello");
    await until(() => c.text().endsWith("hello"), "octets relayés par le proxy de l'entreprise");
    assert.equal(JSON.stringify(b.lines).includes("mot-de-passe"), false);
  });

  it("proxy de l'entreprise qui refuse (503) ou ne répond pas : 502 au client, une ligne « en échec en amont »", async (t) => {
    const refusing = await tcpServer(t, (socket) => socket.end("HTTP/1.1 503 Service Unavailable\r\nX-Detail: interne\r\n\r\n"));
    const b = await bench(t, { upstream: { host: "proxy.banque.example", port: 3128, authorization: null } }, refusing);
    const c = rawClient(t, b.port, connectRequest(`${COPILOT}:443`));
    assert.match(await statusLine(c), /^HTTP\/1\.1 502 /);
    const failure = b.lines.find((l) => l.msg === "sortie d'opencode permise, en échec en amont");
    assert.equal(failure?.motif, "proxy de l'entreprise : réponse 503");
    assert.equal(JSON.stringify(b.lines).includes("interne"), false);

    const silent = await tcpServer(t, () => undefined);
    const slow = await bench(t, { upstream: { host: "proxy.banque.example", port: 3128, authorization: null }, limits: { upstreamTimeoutMs: 100 } }, silent);
    const d = rawClient(t, slow.port, connectRequest(`${COPILOT}:443`));
    assert.match(await statusLine(d), /^HTTP\/1\.1 502 /);
  });

  it("proxy de l'entreprise illisible : 502, aucune sortie directe", async (t) => {
    const b = await bench(t, { upstream: new RelayConfigError("HTTPS_PROXY : adresse illisible.") });
    const c = rawClient(t, b.port, connectRequest(`${COPILOT}:443`));
    assert.match(await statusLine(c), /^HTTP\/1\.1 502 /);
    assert.deepEqual(b.outbound, []);
  });

  it("bornes : connexions simultanées plafonnées, tunnel inactif fermé", async (t) => {
    const echo = await tcpServer(t, (socket) => socket.pipe(socket));
    const b = await bench(t, { limits: { maxConnections: 1, idleTimeoutMs: 150 } }, echo);
    const first = rawClient(t, b.port, connectRequest(`${COPILOT}:443`));
    assert.match(await statusLine(first), /^HTTP\/1\.1 200 /);
    const second = rawClient(t, b.port, connectRequest(`${COPILOT}:443`));
    await until(() => second.closed(), "seconde connexion refusée par le plafond");
    assert.equal(second.text(), "");
    await until(() => first.closed(), "tunnel inactif fermé", 3_000);
    assert.equal(b.outbound.length, 1);
  });

  it("écoute : jamais sur toutes les interfaces", async () => {
    const { log } = testLog();
    const relay = createEgressRelay({ allowedHosts: () => ALLOWED, upstream: null, log });
    await assert.rejects(relay.listen(0, "0.0.0.0"), RelayConfigError);
    await assert.rejects(relay.listen(0, "::"), RelayConfigError);
    await assert.rejects(relay.listen(0, "opencode"), RelayConfigError);
    await relay.close();
  });
});

describe("configuration du relais", () => {
  it("proxy de l'entreprise : http:// seulement, identifiants en Basic, messages sans la valeur", () => {
    assert.equal(readUpstreamProxy({}), null);
    assert.deepEqual(readUpstreamProxy({ https_proxy: "proxy.lan:8080" }), { host: "proxy.lan", port: 8080, authorization: null });
    assert.deepEqual(readUpstreamProxy({ HTTPS_PROXY: "http://proxy.lan" }), { host: "proxy.lan", port: 80, authorization: null });
    assert.equal(readUpstreamProxy({ HTTPS_PROXY: "http://a:b@proxy.lan:3128" })?.authorization, `Basic ${Buffer.from("a:b").toString("base64")}`);
    for (const bad of ["https://secret@proxy.lan", "http://proxy.lan/chemin", "http://secret@:80", "socks5://proxy.lan"]) {
      assert.throws(
        () => readUpstreamProxy({ HTTPS_PROXY: bad }),
        (err: Error) => err instanceof RelayConfigError && !err.message.includes("secret"),
        bad,
      );
    }
  });

  it("hôte pour le journal : sans identifiants ni chemin, ASCII visible, borné", () => {
    assert.equal(hostForLog("user:pw@Example.COM/chemin?x=1"), "example.com");
    assert.equal(hostForLog(""), "(vide)");
    assert.equal(hostForLog("é\u0000x"), "??x");
    assert.equal(hostForLog("a".repeat(400)).length, 253);
  });

  it("réseau interne : interface qui partage le sous-réseau du pair, adresses distantes filtrées", () => {
    const interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
      lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }],
      eth0: [{ address: "172.20.0.3", netmask: "255.255.0.0", family: "IPv4", mac: "02:42:ac:14:00:03", internal: false, cidr: "172.20.0.3/16" }],
      eth1: [{ address: "172.21.0.2", netmask: "255.255.0.0", family: "IPv4", mac: "02:42:ac:15:00:02", internal: false, cidr: "172.21.0.2/16" }],
    };
    const network = findInternalNetwork(["172.21.0.3"], interfaces);
    assert.deepEqual(network && { address: network.address, cidr: network.cidr }, { address: "172.21.0.2", cidr: "172.21.0.0/16" });
    assert.ok(network);
    assert.equal(inNetwork("172.21.0.3", network), true);
    assert.equal(inNetwork("::ffff:172.21.0.3", network), true);
    assert.equal(inNetwork("172.20.0.9", network), false);
    assert.equal(inNetwork("::1", network), false);
    assert.equal(inNetwork(undefined, network), false);
    assert.equal(findInternalNetwork(["10.9.9.9"], interfaces), null);
    assert.equal(findInternalNetwork(["172.21.0.3"], { eth0: [{ address: "172.21.0.2", netmask: "0.0.0.0", family: "IPv4", mac: "", internal: false, cidr: null }] }), null);
  });

  it("démarrage : attend le réseau interne, écoute sur son adresse seulement, s'arrête proprement", async () => {
    const { log, lines } = testLog();
    let lookups = 0;
    const handle = startEgressRelay({
      port: 0,
      peer: "opencode",
      allowedHosts: () => ALLOWED,
      processEnv: {},
      log,
      retryMs: 20,
      lookup: async () => {
        lookups++;
        if (lookups < 3) throw new Error("getaddrinfo ENOTFOUND opencode");
        return ["127.0.0.1"];
      },
      interfaces: () => ({ lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "", internal: true, cidr: "127.0.0.1/8" }] }),
    });
    try {
      await until(() => handle.listening() !== null, "écoute du relais");
      assert.equal(handle.listening()?.address, "127.0.0.1");
      assert.equal(lines.filter((l) => l.msg.startsWith("relais du cockpit en attente")).length, 1);
      assert.ok(lines.some((l) => l.msg === "relais du cockpit à l'écoute pour opencode (réseau interne seulement)" && l.reseau === "127.0.0.0/8"));
    } finally {
      await handle.stop();
    }
    assert.equal(handle.listening(), null);
  });
});
