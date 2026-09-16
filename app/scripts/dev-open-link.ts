// Lien de connexion pour le développement web (npm run dev:link) : hors de l'image (le Dockerfile ne copie que server, dist et
// node_modules), jamais utilisé par les scripts d'installation.
//
// Même vérification que .\cockpit.ps1 open, en plus court : défi aléatoire, preuve du jeton comparée en temps constant, puis
// ticket de connexion à usage unique, demandé avec la signature du défi par le jeton. Le jeton permanent n'est jamais affiché ni
// placé dans une adresse (I11).
import crypto from "node:crypto";
import http from "node:http";
import { authTicketMac, authTicketRequestMac, healthProof, isGeneratedToken } from "../server/security.ts";

/** Serveur de développement de Vite (vite.config.ts : port 5173, strictPort). */
const WEB_ORIGIN = "http://localhost:5173";
const TIMEOUT_MS = 4_000;
const HEX64 = /^[0-9a-f]{64}$/;

function fail(message: string): never {
  console.error(`dev:link : ${message}`);
  process.exit(1);
}

function readPort(): number {
  const raw = process.env.COCKPIT_PORT?.trim();
  if (raw === undefined || raw === "") return 7777;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) fail("COCKPIT_PORT : numéro de port attendu.");
  return port;
}

/** GET http://127.0.0.1:<port><path> sans proxy (agent: false), corps limité : le serveur de développement est local. */
function getJson(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path, agent: false, timeout: TIMEOUT_MS }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        text += chunk;
        if (text.length > 64_000) request.destroy(new Error("réponse trop longue"));
      });
      response.on("end", () => {
        try {
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) });
        } catch {
          reject(new Error("réponse illisible (JSON attendu)"));
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error(`aucune réponse en ${TIMEOUT_MS} ms`)));
    request.on("error", reject);
  });
}

const token = process.env.COCKPIT_TOKEN?.trim() ?? "";
if (token === "") fail("COCKPIT_TOKEN absent : renseignez-le dans app/.env.dev (jamais versionné).");
// La preuve n'est servie que pour un jeton au format généré par install.ps1 (pas d'oracle contre un jeton choisi à la main).
if (!isGeneratedToken(token)) fail("COCKPIT_TOKEN hors format : 64 caractères hexadécimaux minuscules attendus.");

const port = readPort();
const challenge = crypto.randomBytes(32).toString("hex");
const health = await getJson(port, `/api/health?challenge=${challenge}&ticket=${authTicketRequestMac(token, challenge)}`).catch((err: unknown): never =>
  fail(`cockpit injoignable sur 127.0.0.1:${port} (${err instanceof Error ? err.message : "erreur inconnue"}). Lancez npm run dev:server.`),
);

if (health.status !== 200) fail(`/api/health a répondu ${health.status}.`);
const body = health.body as { scheme?: unknown; version?: unknown; proof?: unknown; ticket?: unknown };
if (typeof body.proof !== "string") fail("aucune preuve du jeton : ce serveur n'est pas le cockpit attendu, ou son jeton diffère.");

const expected = healthProof(token, challenge);
const proof = Buffer.from(body.proof, "utf8");
const reference = Buffer.from(expected, "utf8");
if (proof.length !== reference.length || !crypto.timingSafeEqual(proof, reference)) {
  fail("preuve du jeton invalide : le programme qui occupe ce port ne connaît pas COCKPIT_TOKEN.");
}
if (typeof body.ticket !== "string" || !HEX64.test(body.ticket)) fail("ticket de connexion absent ou mal formé.");

const link = `${WEB_ORIGIN}/auth?k=${body.ticket}.${authTicketMac(token, body.ticket)}`;
console.log(`cockpit ${typeof body.version === "string" ? body.version : "?"} en ${typeof body.scheme === "string" ? body.scheme : "?"} sur 127.0.0.1:${port}`);
console.log("Lien de connexion à usage unique (valable 10 minutes) :");
console.log(link);
