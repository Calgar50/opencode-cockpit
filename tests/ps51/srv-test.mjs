// srv-test.mjs - serveur de test du banc PowerShell 5.1 (Node 24, aucune dependance). Contrat : tests/ps51/README.md.
// Usage : node srv-test.mjs <config.json>. Ecoute 127.0.0.1 seulement, port 0 par defaut (7777 refuse).
// Annonce une ligne JSON {"ready":true,"ports":{"<nom>":<port>}} sur stdout. S'arrete quand stdin se ferme.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import crypto from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const HEX64 = /^[0-9a-f]{64}$/;

function readEnvFile(file) {
  const values = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (/^\s*#/.test(line) || !line.includes("=")) continue;
    const at = line.indexOf("=");
    values[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return values;
}

// Jeton et schema attendus : relus a chaque requete dans le .env de test si envFile est donne, sinon SRV_TEST_TOKEN.
function expected() {
  if (config.envFile) {
    const env = existsSync(config.envFile) ? readEnvFile(config.envFile) : {};
    const scheme = (env.COCKPIT_LOCAL_SCHEME ?? "").trim();
    return { token: env.COCKPIT_TOKEN ?? "", scheme: scheme === "" ? "https" : scheme };
  }
  return { token: process.env.SRV_TEST_TOKEN ?? "", scheme: null };
}

// Comportement : celui de l'ecouteur, complete par behaviorFile (relu a chaque requete) sous la cle du nom de l'ecouteur.
function behaviorOf(listener) {
  let behavior = { ...(listener.behavior ?? {}) };
  if (config.behaviorFile && existsSync(config.behaviorFile)) {
    const all = JSON.parse(readFileSync(config.behaviorFile, "utf8"));
    if (all[listener.name]) behavior = { ...behavior, ...all[listener.name] };
  }
  return behavior;
}

function handler(listener, secure) {
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const behavior = behaviorOf(listener);
    const exp = expected();
    const challenge = url.searchParams.get("challenge");
    // Demande de ticket : comme le serveur, seulement signee par le jeton (HMAC du defi, prefixe auth-ticket-request).
    const ticketRequest = url.searchParams.get("ticket");
    const ticketAsked = ticketRequest !== null;
    const ticketSigned = ticketAsked && challenge !== null && HEX64.test(exp.token) &&
      ticketRequest === crypto.createHmac("sha256", exp.token).update("opencode-cockpit/auth-ticket-request/v1\n" + challenge).digest("hex");
    if (config.logFile) {
      // Jamais de valeur : ni defi, ni jeton, ni demande, ni ticket.
      const entry = { listener: listener.name, path: url.pathname, challenge: challenge !== null, ticket: ticketAsked, ticketSigned, t: url.searchParams.has("t"), k: url.searchParams.has("k") };
      appendFileSync(config.logFile, JSON.stringify(entry) + "\n");
    }
    // /redirige : reponse de sante normale, cible de behavior.redirect (un client qui suit les redirections y arrive).
    const redirected = url.pathname === "/redirige";
    if (url.pathname !== "/api/health" && !redirected) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("404");
      return;
    }
    if (behavior.redirect && !redirected) {
      res.writeHead(302, { location: `/redirige${url.search}` });
      res.end();
      return;
    }
    const status = behavior.status ?? 200;
    if (behavior.raw !== undefined) {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(String(behavior.raw));
      return;
    }
    const body = { ok: true, version: behavior.version ?? "1.0.5" };
    const scheme = behavior.scheme ?? exp.scheme ?? (secure ? "https" : "http");
    if (scheme !== "none") body.scheme = scheme;
    if (challenge !== null) {
      if (!HEX64.test(challenge)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid" }));
        return;
      }
      const proof = behavior.proof ?? (HEX64.test(exp.token) ? "good" : "null");
      const mac = crypto.createHmac("sha256", exp.token).update("opencode-cockpit/health-proof/v1\n" + challenge).digest("hex");
      if (proof === "good") body.proof = mac;
      else if (proof === "upper") body.proof = mac.toUpperCase();
      else if (proof === "bad") body.proof = "0".repeat(64);
      else if (proof === "null") body.proof = null;
      if (ticketAsked && proof === "good") {
        if (!ticketSigned) {
          res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ error: "ticket-refused" }));
          return;
        }
        const ticket = behavior.ticket ?? "good";
        if (ticket === "good") body.ticket = crypto.randomBytes(32).toString("hex");
        else if (ticket === "bad") body.ticket = "pas-un-ticket";
      }
    }
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
}

function listen(server, listener, ports) {
  return new Promise((resolve, reject) => {
    const port = listener.port ?? 0;
    if (port === 7777) {
      reject(new Error("port 7777 refuse : il appartient au cockpit reel"));
      return;
    }
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      ports[listener.name] = server.address().port;
      resolve();
    });
  });
}

const ports = {};
for (const listener of config.listeners) {
  let server;
  if (listener.kind === "https") {
    const options = {
      key: readFileSync(join(config.certDir, `${listener.cert}.key`)),
      cert: readFileSync(join(config.certDir, `${listener.cert}.crt`)),
    };
    if (listener.maxVersion) options.maxVersion = listener.maxVersion;
    server = https.createServer(options, handler(listener, true));
    server.on("tlsClientError", () => {});
  } else if (listener.kind === "http") {
    server = http.createServer(handler(listener, false));
  } else if (listener.kind === "close") {
    server = net.createServer((socket) => socket.destroy());
  } else if (listener.kind === "hang") {
    // Accepte et ne repond jamais : seul le delai du client termine l'essai.
    server = net.createServer((socket) => socket.on("error", () => {}));
  } else {
    throw new Error(`type d'ecouteur inconnu : ${listener.kind}`);
  }
  await listen(server, listener, ports);
}
process.stdout.write(`${JSON.stringify({ ready: true, ports })}\n`);
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
setTimeout(() => process.exit(0), (config.maxMinutes ?? 30) * 60_000).unref();
