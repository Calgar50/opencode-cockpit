import { serve } from "@hono/node-server";
import { ArchiveService } from "./archive.ts";
import { ModelCatalog } from "./catalog.ts";
import { Classifier } from "./classifier.ts";
import { ControlService } from "./control.ts";
import { openDb } from "./db.ts";
import { type AppEnv, loadEnv } from "./env.ts";
import { createApp } from "./http.ts";
import { EventHub } from "./hub.ts";
import { Ledger } from "./ledger.ts";
import { createLogger, errorMessage } from "./log.ts";
import { OpencodeClient } from "./opencode.ts";
import { EventProcessor } from "./processor.ts";
import { ProjectsService } from "./projects.ts";
import { QuotaSync } from "./quota.ts";
import { SessionTracker } from "./sessions.ts";
import { SettingsStore } from "./settings.ts";
import { StudioService } from "./studio.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const log = createLogger();

let env: AppEnv;
try {
  env = loadEnv();
} catch (err) {
  log.error(`configuration invalide : ${errorMessage(err)}`);
  process.exit(1);
}

const db = openDb(env.dataDir);
const settings = new SettingsStore(db);
const client = new OpencodeClient(env);
const catalog = new ModelCatalog(client);
const sessions = new SessionTracker(db, client);
const ledger = new Ledger({ db, settings, catalog });
const hub = new EventHub();
const projects = new ProjectsService(env);
const control = new ControlService({ env, client, log });
const archive = new ArchiveService({
  db,
  client,
  settings,
  ledger,
  sessions,
  archiveDir: env.archiveDir,
  opencodeWorkspaceDir: env.opencodeWorkspaceDir,
  log,
});
const classifier = new Classifier({
  client,
  settings,
  catalog,
  archive,
  sessions,
  ledger,
  hub,
  log,
  opencodeWorkspaceDir: env.opencodeWorkspaceDir,
});
const studio = new StudioService({ env, client, projects, control, log });
const quota = new QuotaSync({
  db,
  settings,
  hub,
  log,
  opencodeDataDir: env.opencodeDataDir,
  githubEnterpriseDomain: env.githubEnterpriseDomain,
});
const processor = new EventProcessor({ db, client, sessions, ledger, archive, classifier, hub, log });

let pricingSignature = JSON.stringify(settings.get().pricing);
settings.onChange((next) => {
  const signature = JSON.stringify(next.pricing);
  if (signature !== pricingSignature) {
    pricingSignature = signature;
    const updated = ledger.recompute();
    log.info("tarification modifiée : coûts du mois recalculés", { updated });
  }
  hub.cockpit("settings.updated", next);
});

const app = createApp({ env, log, db, client, catalog, ledger, archive, classifier, studio, projects, control, quota, processor, settings, hub });

const server = serve({ fetch: app.fetch, hostname: env.host, port: env.port }, (info) => {
  log.info("cockpit à l'écoute", { host: env.host, port: info.port, version: env.version, tlsInsecure: env.tlsInsecure });
});

// Démarrage progressif : opencode peut mettre plusieurs secondes à répondre.
void (async () => {
  for (let attempt = 0; ; attempt++) {
    if ((await client.health(3_000))?.healthy) break;
    if (attempt % 10 === 0) log.warn("opencode injoignable, nouvelle tentative dans 3 s", { url: env.opencodeUrl });
    await sleep(3_000);
  }
  log.info("opencode joignable");
  catalog.startAutoRefresh(15 * 60_000, (err) => log.warn("catalogue des modèles indisponible", { error: err.message }));
  await studio.ensureClassifierAgent().catch((err) => log.warn("agent de classement non installé", { error: errorMessage(err) }));
  processor.start();
  quota.start();
})();

let stopping = false;
const shutdown = (signal: string) => {
  if (stopping) return;
  stopping = true;
  log.info("arrêt du cockpit", { signal });
  processor.stop();
  catalog.stop();
  quota.stop();
  // Les flux SSE ouverts retiennent le serveur : arrêt forcé après 5 s.
  setTimeout(() => process.exit(0), 5_000).unref();
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
