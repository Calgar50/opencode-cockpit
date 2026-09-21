import { ArchiveService } from "./archive.ts";
import { createCockpitApp } from "./app-factory.ts";
import { AssistantService, knownDirectories, probeSessionsBusy } from "./assistants.ts";
import { ModelCatalog } from "./catalog.ts";
import { Classifier } from "./classifier.ts";
import { canBill, ConfigWriteQueue } from "./config-queue.ts";
import { ControlService } from "./control.ts";
import { CopilotApi } from "./copilot.ts";
import { openDb } from "./db.ts";
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
import { AuthTickets } from "./security.ts";
import { type LocalServer, logHttpsFailure, prepareStartup, startLocalServer } from "./server-start.ts";
import { SessionTracker } from "./sessions.ts";
import { SettingsStore } from "./settings.ts";
import { StudioService } from "./studio.ts";
import { TierService } from "./tiers.ts";
import { TLS_RENEW_BEFORE_DAYS } from "./tls.ts";
import { trustCorporateCertificates } from "./tls-trust.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const DAY_MS = 86_400_000;
const log = createLogger();

// Configuration (mode d'accès local compris), puis certificat du serveur en HTTPS : sortie 1 avant la base et avant toute écoute.
const { env, listen, tls } = await prepareStartup({
  processEnv: process.env,
  log,
  exit: (code) => process.exit(code),
  afterEnv: (env) => {
    // Appels sortants du cockpit (GitHub, Copilot) derrière un proxy qui inspecte le HTTPS : autorités de certs/ ajoutées.
    const trust = trustCorporateCertificates(env.certsDir);
    if (trust.certificates > 0) log.info("certificats d'entreprise chargés", { files: trust.files, certificates: trust.certificates });
    if (trust.errors.length > 0 || trust.rejected > 0) {
      log.warn("certificats d'entreprise en partie ignorés", { certificates: trust.certificates, rejected: trust.rejected, errors: trust.errors.slice(0, 10) });
    }
    // Même secours que le superviseur d'opencode (exactement « 1 ») : bandeau rouge dans l'interface.
    if (env.tlsInsecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  },
});

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
// Garde du réalignement : même prédicat que la garde de rechargement (décision en examen lue sur le câblage 1.1, branchée plus bas).
let reloadBusy: () => boolean = () => false;
const assistants = new AssistantService({
  db,
  env,
  client,
  studio,
  lookup,
  tiers,
  ledger,
  settings,
  catalog,
  projects,
  hub,
  log,
  queue: configQueue,
  reloadBusy: () => reloadBusy(),
});
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

// Tickets de connexion à usage unique (/api/health puis /auth?k=) : en mémoire, invalidés par un redémarrage.
const tickets = new AuthTickets();
const routeDeps = { assistants, tiers, settings, hub, log };
// Application 1.1 : portillon partagé, câblage de tous les modules (dérivations, abonnements, démarrage, routes), puis createApp.
const cockpit = createCockpitApp({
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
  sessions,
  tls,
  tickets,
  // Salle OMO coupée (plan 2 bis §2.7) : le routeur d'instances est construit avec omo: null — aucun client, aucun processeur,
  // aucune inscription de la salle. Aucune lecture de COCKPIT_OMO ici : le branchement réel arrive au train de V3.
  omo: null,
  // Dossiers de contrôle de la salle : relié à env.omo (T3c) par l'intégrateur au train de V2. Null : le service réel de L17b
  // n'est pas construit, donc aucun fichier n'est écrit dans les volumes de la salle.
  omoControlDirs: null,
  routes: [(app) => registerAssistantRoutes(app, routeDeps), (app) => registerAiRoutes(app, routeDeps)],
});
reloadBusy = () => cockpit.c11.reloadBusy();
const { app } = cockpit;

// Écoute unique : HTTPS (défaut) ou HTTP explicite, jamais les deux.
let server: LocalServer;
try {
  server = startLocalServer({
    app,
    hostname: env.host,
    port: env.port,
    listen,
    onListening: (port) => {
      log.info("cockpit à l'écoute", {
        host: env.host,
        port,
        scheme: env.localScheme,
        version: env.version,
        tlsInsecure: env.tlsInsecure,
        ...(tls === null ? {} : { sha256: tls.info.sha256, notAfter: tls.info.notAfter }),
      });
    },
  });
} catch (err) {
  logHttpsFailure(log, err);
  db.close();
  process.exit(1);
}
tls?.refusals.start();

// Rappel quotidien, sans jamais recharger le certificat à chaud (un flux SSE en cours serait coupé) : échéance proche en HTTPS,
// mode HTTP en HTTP.
setInterval(() => {
  if (tls !== null) {
    const daysLeft = Math.floor((Date.parse(tls.info.notAfter) - Date.now()) / DAY_MS);
    if (daysLeft < TLS_RENEW_BEFORE_DAYS) {
      log.warn("certificat TLS local proche de l'échéance : renouvelé au prochain démarrage", {
        notAfter: tls.info.notAfter,
        daysLeft,
        remede: ".\\cockpit.ps1 restart",
      });
    }
  } else {
    log.warn("rappel : mode HTTP local choisi à l'installation, trafic non chiffré sur la boucle locale", { confirmedAt: env.localHttpConfirmedAt });
  }
}, DAY_MS).unref();

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
  // Démarrage 1.1 : retour des choix, agents internes (ports.internalAgents.ensureAll), reprises.
  await cockpit.startup();
  processor.start();
})();

let stopping = false;
const shutdown = (signal: string) => {
  if (stopping) return;
  stopping = true;
  log.info("arrêt du cockpit", { signal });
  processor.stop();
  cockpit.close();
  catalog.stop();
  copilotConfig.stop();
  lookup.close();
  quota.stop();
  tls?.refusals.stop();
  // Filet de sécurité : sortie forcée après 5 s.
  setTimeout(() => process.exit(0), 5_000).unref();
  // Les flux SSE ouverts retiendraient close() jusqu'à leur fin : connexions fermées d'abord (sortie en quelques millisecondes).
  server.closeAllConnections();
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
