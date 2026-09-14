import { serve } from "@hono/node-server";
import { ArchiveService } from "./archive.ts";
import { AssistantService, knownDirectories, probeSessionsBusy } from "./assistants.ts";
import { ModelCatalog } from "./catalog.ts";
import { Classifier } from "./classifier.ts";
import { canBill, ConfigWriteQueue } from "./config-queue.ts";
import { ControlService } from "./control.ts";
import { CopilotApi } from "./copilot.ts";
import { openDb } from "./db.ts";
import { type AppEnv, loadEnv } from "./env.ts";
import { createApp } from "./http.ts";
import { EventHub } from "./hub.ts";
import { Ledger } from "./ledger.ts";
import { createLogger, errorMessage } from "./log.ts";
import { CopilotConfigSync, resyncOnIdle, resyncOnReconnect } from "./oc-copilot-config.ts";
import { OcLookup } from "./oc-lookup.ts";
import { OpencodeClient } from "./opencode.ts";
import { EventProcessor } from "./processor.ts";
import { ProjectsService } from "./projects.ts";
import { QuotaSync } from "./quota.ts";
import { registerAiRoutes, registerAssistantRoutes } from "./routes-assistants.ts";
import { SessionTracker } from "./sessions.ts";
import { SettingsStore } from "./settings.ts";
import { StudioService } from "./studio.ts";
import { TierService } from "./tiers.ts";
import { trustCorporateCertificates } from "./tls-trust.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const log = createLogger();

let env: AppEnv;
try {
  env = loadEnv();
} catch (err) {
  log.error(`configuration invalide : ${errorMessage(err)}`);
  process.exit(1);
}

// Appels sortants du cockpit (GitHub, Copilot) derrière un proxy qui inspecte le HTTPS : autorités de certs/ ajoutées.
const trust = trustCorporateCertificates(env.certsDir);
if (trust.certificates > 0) log.info("certificats d'entreprise chargés", { files: trust.files, certificates: trust.certificates });
if (trust.errors.length > 0 || trust.rejected > 0) {
  log.warn("certificats d'entreprise en partie ignorés", { certificates: trust.certificates, rejected: trust.rejected, errors: trust.errors.slice(0, 10) });
}
// Même secours que le superviseur d'opencode (exactement « 1 ») : bandeau rouge dans l'interface.
if (env.tlsInsecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const db = openDb(env.dataDir);
const settings = new SettingsStore(db);
const client = new OpencodeClient(env);
const copilot = new CopilotApi({
  opencodeDataDir: env.opencodeDataDir,
  githubEnterpriseDomain: env.githubEnterpriseDomain,
  copilotApiUrl: env.copilotApiUrl,
  version: env.version,
});
const catalog = new ModelCatalog(client, { copilot });
const sessions = new SessionTracker(db, client);
const ledger = new Ledger({ db, settings, catalog });
const hub = new EventHub();
const projects = new ProjectsService(env);
const control = new ControlService({ env, client, log });
// Une seule file d'écriture de la configuration d'opencode : API (profils de permissions, fichier brut, correctif du mode Avancé,
// redémarrage depuis Diagnostic), Studio et adresse Copilot. Pendant une application ou un redémarrage, puis jusqu'à la synchro
// qui revérifie l'adresse de l'API Copilot (« synchro due »), aucune demande facturée ne part.
const configQueue = new ConfigWriteQueue();
const copilotConfig = new CopilotConfigSync({
  client,
  catalog,
  copilot,
  hub,
  log,
  queue: configQueue,
  control,
  directories: () => knownDirectories({ projects, db }),
  busy: () => probeSessionsBusy({ client, projects, db }),
  // Adresse imposée par .env : « synchro due » posée dès maintenant, avant l'écoute du serveur HTTP, sans soupape tant qu'opencode n'a
  // jamais répondu, levée par la première synchro qui vérifie ou corrige l'adresse (gardée tant qu'elles rendent « en-attente »).
  targetImposed: env.copilotApiUrl !== null,
});
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
  allowedProviders: env.allowedProviders,
  // Classement automatique reporté pendant une application de configuration, un redémarrage d'opencode ou une synchro due.
  canBill: () => canBill({ queue: configQueue, control, copilotConfig }),
});
// Avec le catalogue : une IA absente du compte Copilot (ou catalogue jamais lu) est refusée à l'enregistrement. Libérations et
// redémarrages dans la file partagée, adresse de l'API Copilot revérifiée après chacun.
const studio = new StudioService({ env, client, projects, control, log, catalog, queue: configQueue, copilotConfig });
// Agents et raccourcis vus par opencode (cache 15 s, invalidé par studio.changed, opencode.config.changed, ai.changed).
const lookup = new OcLookup({ client, env, hub, log });
const tiers = new TierService({ settings, catalog, ledger, env });
const assistants = new AssistantService({ db, env, client, studio, lookup, tiers, ledger, settings, catalog, projects, hub, log });
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

// Les niveaux d'IA se résolvent sur le catalogue : une liste des IA qui change les fait recalculer côté interface,
// et l'adresse de l'API Copilot imposée à opencode est réalignée.
catalog.onChange(() => {
  hub.cockpit("ai.changed", { reason: "catalog" });
  void copilotConfig.sync().then((status) => {
    if (status.state === "echec") log.warn("réglages Copilot d'opencode non alignés", { error: status.message });
  });
});

// Tout redémarrage d'opencode (page Diagnostic, fichier brut, profils de permissions, retours arrière, Studio, relance par le
// superviseur) coupe son flux d'événements : « synchro due » dès la coupure, adresse de l'API Copilot revérifiée dans chaque
// dossier à la reconnexion.
resyncOnReconnect(hub, copilotConfig);
// Adresse fausse relue pendant une réponse (« correction différée ») : synchro relancée dès qu'une conversation passe au repos.
resyncOnIdle(hub, copilotConfig);

const routeDeps = { assistants, tiers, settings, hub, log };
const app = createApp({
  env,
  log,
  db,
  client,
  catalog,
  ledger,
  archive,
  classifier,
  studio,
  projects,
  control,
  quota,
  processor,
  settings,
  hub,
  lookup,
  tiers,
  assistants,
  copilot,
  copilotConfig,
  configQueue,
  routes: [(app) => registerAssistantRoutes(app, routeDeps), (app) => registerAiRoutes(app, routeDeps)],
});

const server = serve({ fetch: app.fetch, hostname: env.host, port: env.port }, (info) => {
  log.info("cockpit à l'écoute", { host: env.host, port: info.port, version: env.version, tlsInsecure: env.tlsInsecure });
});

// La liste des IA et le solde Copilot ne dépendent pas d'opencode : lus dès le démarrage, même s'il ne répond pas.
catalog.startAutoRefresh(15 * 60_000, (err) => log.warn("catalogue des modèles indisponible", { error: err.message }));
quota.start();

// Démarrage progressif : opencode peut mettre plusieurs secondes à répondre.
void (async () => {
  for (let attempt = 0; ; attempt++) {
    if ((await client.health(3_000))?.healthy) break;
    if (attempt % 10 === 0) log.warn("opencode injoignable, nouvelle tentative dans 3 s", { url: env.opencodeUrl });
    await sleep(3_000);
  }
  log.info("opencode joignable");
  // opencode répond : soupape de nouveau appliquée aux poses de démarrage (aucune pendant l'attente : opencode peut accepter une
  // demande avant que cette boucle le voie). Adresse imposée par .env : « synchro due » de démarrage reposée, levée par la synchro de
  // démarrage qui suit ; un seul appel, jamais dans la boucle d'attente.
  copilotConfig.markStartup();
  await catalog.refresh().catch((err) => log.warn("catalogue des modèles indisponible", { error: errorMessage(err) }));
  await copilotConfig.sync();
  await studio.ensureClassifierAgent().catch((err) => log.warn("agent de classement non installé", { error: errorMessage(err) }));
  processor.start();
})();

let stopping = false;
const shutdown = (signal: string) => {
  if (stopping) return;
  stopping = true;
  log.info("arrêt du cockpit", { signal });
  processor.stop();
  catalog.stop();
  copilotConfig.stop();
  lookup.close();
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
