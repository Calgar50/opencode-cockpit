// Démarrage et écoute du cockpit sur la boucle locale (1.0.5) : un seul schéma, HTTPS par défaut, HTTP seulement après
// install.ps1 -Http confirmé. Jamais les deux, jamais de redirection, jamais de repli automatique vers HTTP.
// startLocalServer est la seule fonction d'écoute du serveur ; prepareStartup (extrait de main.ts) précède la base et l'écoute.
import type http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import tls from "node:tls";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import { type AppEnv, loadEnv } from "./env.ts";
import { errorMessage, type Logger } from "./log.ts";
import {
  type EnsureCertificateOptions,
  ensureServerCertificate,
  normalizeSanHosts,
  type ServerCertificate,
  type TlsInfo,
  TlsRefusals,
  TlsSetupError,
} from "./tls.ts";

const REMEDY_RENEW = ".\\cockpit.ps1 tls -Renew";

/** Écoute demandée : HTTPS avec la paire vérifiée et le compteur des poignées refusées, ou HTTP explicite. */
export type LocalListen =
  | { scheme: "https"; tls: { key: string; cert: string; refusals: TlsRefusals } }
  | { scheme: "http" };

/** Certificat servi en HTTPS : contenu du fichier public (jamais la clé) et poignées refusées, pour la page Diagnostic. */
export interface LocalTls {
  info: TlsInfo;
  refusals: TlsRefusals;
}

export type LocalServer = http.Server | https.Server;

export interface LocalStartup {
  env: AppEnv;
  listen: LocalListen;
  /** null en mode HTTP. */
  tls: LocalTls | null;
}

export interface StartupOptions {
  processEnv: NodeJS.ProcessEnv;
  log: Logger;
  /** process.exit dans main.ts. */
  exit: (code: number) => never;
  /** Après la lecture de la configuration, avant le certificat : autorités d'entreprise, secours TLS des appels sortants. */
  afterEnv?: (env: AppEnv) => void;
  /** ensureServerCertificate par défaut. */
  ensureCertificate?: (options: EnsureCertificateOptions) => Promise<ServerCertificate>;
}

/** Échec du HTTPS local : raison et remède seulement, jamais un contenu lu, jamais le mode HTTP proposé. */
export function logHttpsFailure(log: Logger, err: unknown): void {
  const setup = err instanceof TlsSetupError ? err : null;
  log.error("HTTPS local impossible", { raison: setup?.reason ?? "inattendue", remede: setup?.remedy ?? REMEDY_RENEW });
}

/**
 * Étapes du démarrage qui précèdent la base et toute écoute (§3.6.2) :
 * 1. configuration, mode d'accès local compris : invalide → journal, sortie 1 ;
 * 2. `afterEnv` ;
 * 3. HTTPS : certificat vérifié ou régénéré dans le volume ; impossible → « HTTPS local impossible », sortie 1.
 *    HTTP : ni certificat, ni compteur, ni accès au volume TLS ; le mode est journalisé.
 */
export async function prepareStartup(o: StartupOptions): Promise<LocalStartup> {
  let env: AppEnv;
  try {
    env = loadEnv(o.processEnv);
  } catch (err) {
    o.log.error(`configuration invalide : ${errorMessage(err)}`);
    return o.exit(1);
  }
  o.afterEnv?.(env);

  if (env.localScheme === "http") {
    o.log.warn("mode HTTP local choisi à l'installation : trafic non chiffré sur la boucle locale", { confirmedAt: env.localHttpConfirmedAt });
    return { env, listen: { scheme: "http" }, tls: null };
  }

  try {
    const san = normalizeSanHosts(env.allowedHosts, o.log);
    const pair = await (o.ensureCertificate ?? ensureServerCertificate)({
      tlsDir: env.tlsDir,
      entries: san.entries,
      ignoredHosts: san.ignored.length,
      opensslPath: env.opensslPath,
      log: o.log,
    });
    const refusals = new TlsRefusals({ log: o.log });
    return { env, listen: { scheme: "https", tls: { key: pair.key, cert: pair.cert, refusals } }, tls: { info: pair.info, refusals } };
  } catch (err) {
    logHttpsFailure(o.log, err);
    return o.exit(1);
  }
}

/**
 * Écoute unique sur `hostname:port`. HTTPS : TLS seul (1.2 minimum explicite, ce qui ignore un NODE_OPTIONS=--tls-min-v1.0 ;
 * TLS 1.2 gardé pour Schannel du client PowerShell 5.1), une requête HTTP en clair reçoit 0 octet et compte une poignée refusée.
 * HTTP : serveur HTTP seul. Une paire incohérente lève TlsSetupError avant toute écoute.
 */
export function startLocalServer(o: {
  app: Hono;
  hostname: string;
  port: number;
  listen: LocalListen;
  onListening: (port: number) => void;
}): LocalServer {
  const listening = (info: AddressInfo) => o.onListening(info.port);
  if (o.listen.scheme === "http") {
    return serve({ fetch: o.app.fetch, hostname: o.hostname, port: o.port }, listening) as http.Server;
  }
  const { key, cert, refusals } = o.listen.tls;
  try {
    // Ceinture : https.createServer lèverait une exception (ERR_OSSL_X509_KEY_VALUES_MISMATCH) au milieu du démarrage.
    tls.createSecureContext({ key, cert });
  } catch {
    throw new TlsSetupError("cle-certificat-incoherents", "cle et certificat TLS refuses par Node", REMEDY_RENEW);
  }
  const server = serve(
    {
      fetch: o.app.fetch,
      hostname: o.hostname,
      port: o.port,
      createServer: https.createServer,
      serverOptions: { key, cert, minVersion: "TLSv1.2" },
    },
    listening,
  ) as https.Server;
  // Code filtré seulement : jamais le message, l'adresse ni les octets reçus.
  server.on("tlsClientError", (err) => refusals.add(err));
  return server;
}
