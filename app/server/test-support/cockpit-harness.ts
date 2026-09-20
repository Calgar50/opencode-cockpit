// Harnais du cockpit pour les tests : faux opencode, base en mémoire, app-factory (createApp, câblage 1.1) et EventProcessor réels,
// serveur HTTP sur un port accepté par fetch. Services qui écriraient hors du test ou appelleraient GitHub (Studio, redémarrage,
// Copilot, solde, classement) : doublures inspirées d'integration.test.ts, remplaçables par `deps`. Modules 1.1 : seulement ceux
// que le test déclare (`modules`), les autres gardent leur port neutre même quand leur code réel est fusionné (plan §2.2) ;
// `ports` surcharge un port (espion ou faux).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { createAdaptorServer } from "@hono/node-server";
import { type CockpitApp, createCockpitApp } from "../app-factory.ts";
import { ArchiveService } from "../archive.ts";
import { AssistantService } from "../assistants.ts";
import { ModelCatalog } from "../catalog.ts";
import type { Classifier } from "../classifier.ts";
import { ConfigWriteQueue } from "../config-queue.ts";
import type { PermissionGate } from "../contracts-11.ts";
import type { ControlService, RestartResult } from "../control.ts";
import { openMemoryDb } from "../db.ts";
import type { AppEnv } from "../env.ts";
import type { AppDeps } from "../http.ts";
import { EventHub } from "../hub.ts";
import { Ledger } from "../ledger.ts";
import { createLogger } from "../log.ts";
import { OcLookup } from "../oc-lookup.ts";
import { OpencodeClient } from "../opencode.ts";
import { EventProcessor } from "../processor.ts";
import { ProjectsService } from "../projects.ts";
import type { QuotaSync } from "../quota.ts";
import { CONFIRM_HEADER, CSRF_HEADER, SESSION_COOKIE_NAME, sessionValue } from "../security.ts";
import { SessionTracker } from "../sessions.ts";
import { SettingsStore } from "../settings.ts";
import type { StudioService } from "../studio.ts";
import { TierService } from "../tiers.ts";
import type { BuildCockpit11Options } from "../wiring-11.ts";
import { FakeOpencode } from "./fake-opencode.ts";
import { listenFetchable, until } from "./helpers.ts";
// --- équipes (it4) : début ---
import type { CockpitAppDeps } from "../app-factory.ts";
import type { BuildEquipesOptions } from "../wiring-eq.ts";
// --- équipes (it4) : fin ---

export interface CockpitHarnessOptions {
  /** Réglages appliqués avant createApp (SettingsStore.update) ; sans rien : réglages par défaut, mode Simple. */
  settings?: Record<string, unknown>;
  /** Variables du cockpit remplacées (l'adresse et le mot de passe du faux opencode sont posés par le harnais). */
  env?: Partial<AppEnv>;
  /**
   * Dépendances de createApp remplacées, à partir de celles du harnais. EventProcessor est reconstruit sur les dépendances finales
   * (db, client, ledger, archive, classifier, hub, log) ; SessionTracker garde la base et le client du harnais.
   */
  deps?: (base: AppDeps) => Partial<Omit<AppDeps, "processor">>;
  /**
   * Modules 1.1 installés (noms ou modules factices). Absent : aucun (ports neutres). « tous » : réservé aux tests de croisement et
   * aux e2e.
   */
  modules?: BuildCockpit11Options["modules"] | "tous";
  /** Surcharges de ports 1.1, posées après l'installation des modules. */
  ports?: BuildCockpit11Options["ports"];
  /** Portillon remplacé (espion), construit sur les dépendances finales ; absent : createPermissionGate. */
  gate?: (deps: AppDeps) => PermissionGate;
  // --- équipes (it4) : début ---
  /**
   * Modules d'équipes installés (noms ou modules factices). Absent : aucun (ports neutres, comportement 1.1). « tous » : réservé
   * aux tests de croisement et aux e2e.
   */
  equipes?: BuildEquipesOptions["modules"] | "tous";
  /** Surcharges des ports d'équipes, posées après l'installation des modules. */
  eqPorts?: BuildEquipesOptions["ports"];
  // --- équipes (it4) : fin ---
}

export interface CallResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  json<T = unknown>(): T;
}

export interface CockpitHarness {
  fake: FakeOpencode;
  db: DatabaseSync;
  hub: EventHub;
  settings: SettingsStore;
  sessions: SessionTracker;
  ledger: Ledger;
  /** EventProcessor réel, abonné au faux opencode, connecté et rattrapage terminé au retour de startCockpit. */
  processor: EventProcessor;
  deps: AppDeps;
  /** Application 1.1 (app-factory) : câblage, c11, portillon partagé, démarrage 1.1 (non lancé par le harnais). */
  cockpit: CockpitApp;
  /** Requête HTTP au cockpit (en-tête Host posé ; corps objet envoyé en JSON). Réponses finies seulement, pas le flux /api/events. */
  call(method: string, pathname: string, init?: { headers?: Record<string, string>; body?: unknown }): Promise<CallResult>;
  /** authed : cookie de session ; mutating : + en-tête anti-CSRF ; confirmed : + x-cockpit-confirm. */
  headers: { authed: Record<string, string>; mutating: Record<string, string>; confirmed: Record<string, string> };
  /** Événements du cockpit publiés sur le hub depuis le démarrage, dans l'ordre. */
  cockpitEvents(): Array<{ type: string; data: unknown }>;
  /**
   * P6 (« ne redémarre jamais opencode ») : échoue si le faux a reçu PATCH /global/config, POST /global/dispose ou POST
   * /instance/dispose, ou si un redémarrage a été demandé à la doublure du contrôle.
   */
  assertNoGlobalRestart(): void;
  /** Arrêt et nettoyage (aussi fait par t.after) ; idempotent. */
  close(): Promise<void>;
}

const RELOAD_ROUTES = new Set(["PATCH /global/config", "POST /global/dispose", "POST /instance/dispose"]);

export async function startCockpit(t: TestContext, options: CockpitHarnessOptions = {}): Promise<CockpitHarness> {
  // Nettoyages dans l'ordre inverse de la mise en place ; enregistrés au fur et à mesure : un démarrage qui échoue est nettoyé aussi.
  const cleanups: Array<() => unknown> = [];
  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      const errors: unknown[] = [];
      for (const cleanup of cleanups.reverse()) {
        try {
          await cleanup();
        } catch (err) {
          errors.push(err);
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, "harnais du cockpit : nettoyage en échec");
    })();
    return closing;
  };
  t.after(close);

  const password = randomBytes(18).toString("base64url");
  const fake = new FakeOpencode({ password });
  cleanups.push(() => fake.close());
  await fake.start();

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-harnais-"));
  cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const dir = (name: string) => {
    const full = path.join(tmp, name);
    fs.mkdirSync(full, { recursive: true });
    return full;
  };
  const webDir = dir("web");
  fs.writeFileSync(path.join(webDir, "index.html"), "<!doctype html><title>cockpit</title>");
  const env: AppEnv = {
    host: "127.0.0.1",
    port: 0,
    token: randomBytes(32).toString("base64url"),
    allowedHosts: ["localhost", "127.0.0.1"],
    dataDir: dir("data"),
    archiveDir: dir("archives"),
    workspaceDir: dir("workspace"),
    opencodeWorkspaceDir: fake.directory,
    opencodeConfigDir: dir("oc-config"),
    opencodeDataDir: dir("oc-data"),
    controlDir: dir("control"),
    certsDir: dir("certs"),
    webDir,
    opencodeUrl: fake.url,
    opencodeUsername: "opencode",
    opencodePassword: password,
    tlsInsecure: false,
    projectConfig: false,
    githubEnterpriseDomain: null,
    allowedProviders: ["github-copilot"],
    copilotApiUrl: null,
    autonomy: true,
    // Harnais en HTTP (1.0.5, createAdaptorServer sans TLS) : dossier TLS jamais créé ni lu.
    localScheme: "http",
    localHttpConfirmedAt: "2026-09-15T10:32:00Z",
    tlsDir: path.join(tmp, "tls"),
    opensslPath: "/usr/bin/openssl",
    version: "test",
    ...options.env,
  };

  const db = openMemoryDb();
  cleanups.push(() => db.close());
  // Secret de session posé avant createApp : le cookie des en-têtes est calculé sans passer par /auth.
  const sessionSecret = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('session.secret', ?, ?)").run(sessionSecret, Date.now());
  const settings = new SettingsStore(db);
  if (options.settings) settings.update(options.settings);

  const log = createLogger("error");
  const client = new OpencodeClient(env);
  const catalog = new ModelCatalog(client);
  cleanups.push(() => catalog.stop());
  await catalog.refresh();
  const sessions = new SessionTracker(db, client);
  const ledger = new Ledger({ db, settings, catalog });
  const hub = new EventHub();
  const events: Array<{ type: string; data: unknown }> = [];
  const unsubscribe = hub.subscribe((event) => {
    if (event.kind === "cockpit") events.push({ type: event.type, data: event.data });
  });
  cleanups.push(unsubscribe);
  const lookup = new OcLookup({ client, env, hub, log });
  cleanups.push(() => lookup.close());
  const projects = new ProjectsService(env);
  const tiers = new TierService({ settings, catalog, ledger, env });
  // Studio simulé (comme integration.test.ts) : aucune écriture de configuration, aucun rechargement d'opencode.
  const studio = {
    save: async (kind: string, _scope: unknown, input: { name: string; frontmatter: Record<string, unknown>; body: string }) => ({
      kind,
      name: input.name,
      scope: "global",
      project: null,
      file: `${kind}/${input.name}.md`,
      frontmatter: input.frontmatter,
      body: input.body,
      error: null,
      files: [],
      updatedAt: Date.now(),
    }),
    remove: async () => true,
    ensureClassifierAgent: async () => undefined,
  } as unknown as StudioService;
  // File de la configuration et décision en examen partagées avec la garde, comme dans main.ts (une file remplacée par `deps`
  // n'est pas vue par cet AssistantService : remplacer aussi `assistants` dans ce cas).
  const configQueue = new ConfigWriteQueue();
  let cockpitRef: CockpitApp | null = null;
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
    reloadBusy: () => cockpitRef?.c11.reloadBusy() ?? false,
  });
  const archive = new ArchiveService({ db, client, settings, ledger, sessions, archiveDir: env.archiveDir, opencodeWorkspaceDir: env.opencodeWorkspaceDir, log });
  // Classement simulé : aucune demande facturée, aucun minuteur qui survivrait au test.
  const classifier = { onIdle: () => undefined, onBusy: () => undefined } as unknown as Classifier;
  const restarts: string[] = [];
  const control = {
    caFilesCount: async () => 0,
    supervisorPresent: async () => false,
    restarting: false,
    restartOpencode: async (reason: string): Promise<RestartResult> => {
      restarts.push(reason);
      return { ok: true, durationMs: 0, message: "opencode a redémarré." };
    },
  } as unknown as ControlService;

  const makeProcessor = (d: Omit<AppDeps, "processor">) =>
    new EventProcessor({ db: d.db, client: d.client, sessions, ledger: d.ledger, archive: d.archive, classifier: d.classifier, hub: d.hub, log: d.log });
  const base: Omit<AppDeps, "processor"> = {
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
    quota: { copilotConnected: async () => true, latest: () => null } as unknown as QuotaSync,
    settings,
    hub,
    lookup,
    tiers,
    assistants,
    copilot: {
      status: { connected: false, endpoint: null, lastTried: null, modelsAt: 0, models: 0, error: null, discoveryError: null },
      probeHosts: async () => [],
      resetDiscovery: () => undefined,
    },
    copilotConfig: {
      status: { state: "inactif", message: null, at: 0, details: { checked: [] } },
      syncDue: false,
      dueReason: null,
      markDue: () => false,
      sync: async () => ({ state: "inactif", message: null, at: 0, details: { checked: [] } }),
    },
    configQueue,
    // Harnais en HTTP : aucun certificat.
    tls: null,
  };
  const merged ={ ...base, ...options.deps?.({ ...base, processor: makeProcessor(base) }) };
  const processor = makeProcessor(merged);
  const deps: AppDeps = { ...merged, processor };

  // --- équipes (it4) : début ---
  // AssistantService du harnais (ou celui qu'un test a mis dans `deps`) : l'installation des exemples d'équipe appelle install.
  const eqAssistants = deps.assistants as CockpitAppDeps["assistants"];
  const cockpit = createCockpitApp(
    { ...deps, assistants: eqAssistants, configQueue: deps.configQueue ?? configQueue, sessions, ...(options.gate ? { gate: options.gate(deps) } : {}) },
    {
      modules: options.modules === "tous" ? undefined : (options.modules ?? []),
      ports: options.ports,
      equipes: options.equipes === "tous" ? undefined : (options.equipes ?? []),
      eqPorts: options.eqPorts,
    },
  );
  // --- équipes (it4) : fin ---
  cockpitRef = cockpit;
  cleanups.push(() => cockpit.close());
  const server = createAdaptorServer({ fetch: cockpit.app.fetch }) as http.Server;
  const port = await listenFetchable(server, "127.0.0.1");
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );

  processor.start();
  cleanups.push(() => processor.stop());
  await until(() => processor.status.connected && !processor.status.backfilling, 5_000);

  const cookie = `${SESSION_COOKIE_NAME}=${sessionValue(env.token, sessionSecret)}`;
  const headers = {
    authed: { cookie },
    mutating: { cookie, [CSRF_HEADER]: "1" },
    confirmed: { cookie, [CSRF_HEADER]: "1", [CONFIRM_HEADER]: "1" },
  };

  const call: CockpitHarness["call"] = (method, pathname, init = {}) =>
    new Promise((resolve, reject) => {
      const json = init.body !== undefined && typeof init.body !== "string";
      const payload = init.body === undefined ? undefined : json ? JSON.stringify(init.body) : String(init.body);
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          method,
          path: pathname,
          headers: { host: `127.0.0.1:${port}`, ...(json ? { "content-type": "application/json" } : {}), ...init.headers },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: <T>() => JSON.parse(body) as T });
          });
        },
      );
      req.on("error", reject);
      req.end(payload);
    });

  const assertNoGlobalRestart = () => {
    const reloads = fake.requests.map((r) => `${r.method} ${r.pathname}`).filter((route) => RELOAD_ROUTES.has(route));
    const found = [...reloads, ...restarts.map((reason) => `redémarrage demandé (${reason})`)];
    assert.ok(found.length === 0, `opencode rechargé ou redémarré : ${found.join(", ")}`);
  };

  return {
    fake,
    db,
    hub,
    settings,
    sessions,
    ledger,
    processor,
    deps,
    cockpit,
    call,
    headers,
    cockpitEvents: () => events.map((event) => ({ ...event })),
    assertNoGlobalRestart,
    close,
  };
}
