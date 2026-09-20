// Healthcheck Docker du cockpit (1.0.5), sans défi ni jeton : code de sortie 0 seulement si /api/health répond 200 avec le
// schéma de COCKPIT_LOCAL_SCHEME.
// - HTTPS : autorité = feuille publique seule, vérification exigée, empreinte comparée au fichier public : ni
//   NODE_TLS_REJECT_UNAUTHORIZED=0 ni un autre certificat servi ne passent.
// - HTTP : aucun accès au volume TLS.
// agent: false dans les deux modes : aucun proxy de l'environnement (NODE_USE_ENV_PROXY) n'est utilisé.
// Aucun process.exit : le code est posé dans process.exitCode et le processus se termine de lui-même. Sous Windows (Node 24.15),
// un process.exit peu après le chargement des modules TypeScript plante par intermittence (0xC0000409) [mesuré].
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import type { TLSSocket } from "node:tls";
import { type LocalAccess, parseLocalAccess } from "./env.ts";

const TIMEOUT_MS = 4_000;
const MAX_BODY_BYTES = 16_000;
const FINGERPRINT = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;

let settled = false;
let request: http.ClientRequest | null = null;
let deadline: NodeJS.Timeout | null = null;

/** Code de sortie posé une seule fois ; requête et délai libérés pour que le processus se termine. */
function finish(code: 0 | 1): void {
  if (settled) return;
  settled = true;
  process.exitCode = code;
  if (deadline !== null) clearTimeout(deadline);
  request?.destroy();
}

function localPort(): number | null {
  const port = Number(process.env.COCKPIT_PORT ?? 7777);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/** Réponse : 200, corps JSON borné, `ok` et schéma attendus, contrôle du pair (empreinte en HTTPS). */
function check(res: http.IncomingMessage, scheme: LocalAccess["localScheme"], peerOk: boolean): void {
  const chunks: Buffer[] = [];
  let size = 0;
  res.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return finish(1);
    chunks.push(chunk);
  });
  res.on("error", () => finish(1));
  res.on("end", () => {
    if (res.statusCode !== 200 || !peerOk) return finish(1);
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { ok?: unknown; scheme?: unknown };
      finish(body.ok === true && body.scheme === scheme ? 0 : 1);
    } catch {
      finish(1);
    }
  });
}

function main(): void {
  let access: LocalAccess;
  try {
    access = parseLocalAccess(process.env);
  } catch {
    return finish(1);
  }
  const port = localPort();
  if (port === null) return finish(1);
  // Délai global : une réponse lente ou goutte à goutte ne retient pas le healthcheck au-delà du délai de Docker.
  deadline = setTimeout(() => finish(1), TIMEOUT_MS + 500);

  let req: http.ClientRequest;
  if (access.localScheme === "http") {
    req = http.get({ host: "127.0.0.1", port, path: "/api/health", agent: false, timeout: TIMEOUT_MS }, (res) => check(res, "http", true));
  } else {
    let ca: string;
    let expected: string;
    try {
      const tlsDir = process.env.COCKPIT_TLS_DIR?.trim() || "/tls";
      if (!path.isAbsolute(tlsDir)) return finish(1);
      ca = fs.readFileSync(path.join(tlsDir, "public", "cockpit.crt"), "utf8");
      const info = JSON.parse(fs.readFileSync(path.join(tlsDir, "public", "cockpit-tls.json"), "utf8")) as { sha256?: unknown };
      if (typeof info.sha256 !== "string" || !FINGERPRINT.test(info.sha256)) return finish(1);
      expected = info.sha256;
    } catch {
      return finish(1);
    }
    try {
      req = https.get(
        { host: "127.0.0.1", port, path: "/api/health", ca, rejectUnauthorized: true, agent: false, timeout: TIMEOUT_MS },
        (res) => {
          const peer = (res.socket as TLSSocket).getPeerX509Certificate?.();
          check(res, "https", peer?.fingerprint256 === expected);
        },
      );
    } catch {
      // Feuille publique illisible : exception synchrone à la création du contexte TLS.
      return finish(1);
    }
  }
  request = req;
  req.on("timeout", () => finish(1));
  req.on("error", () => finish(1));
}

main();
