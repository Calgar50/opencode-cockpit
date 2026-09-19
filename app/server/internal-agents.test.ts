// Tests L1g : agents internes gardés (spécification §3.11). Installation au repos seulement (réponse en cours, occupation non
// vérifiable, redémarrage, application de la configuration : différée), reprise 30 s → 5 min sur une horloge injectable, état pour
// le Diagnostic, installation gardée après un redémarrage, minuterie arrêtée à la fermeture, noms réservés centralisés
// (cockpit-controle compris). Faux opencode et vrai Studio pour « aucun rechargement pendant une réponse ».
// L11b : cockpit-controle ajouté à la liste de production (fichier de L11a), installé au repos seulement, rétabli s'il est modifié.
// La mécanique de L1g reste éprouvée sur le seul agent de classement (CLASSIFIER_ONLY).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { AssistantService, AssistantServiceError, isReservedAgentName, probeSessionsBusyStrict, type SessionsOccupancy } from "./assistants.ts";
import type { ModelCatalog } from "./catalog.ts";
import { CLASSIFIER_AGENT, CLASSIFIER_AGENT_FILE } from "./classifier.ts";
import { ConfigWriteQueue } from "./config-queue.ts";
import type { Cockpit11Deps } from "./contracts-11.ts";
import type { ControlService } from "./control.ts";
import { openMemoryDb } from "./db.ts";
import type { AppEnv } from "./env.ts";
import { EventHub } from "./hub.ts";
import {
  closeInternalAgents,
  createInternalAgents,
  createInternalAgentsModule,
  INSTALLED_AGENTS,
  type InternalAgentDefinition,
  type InternalAgentsClock,
  type InternalAgentsDeps,
  internalAgentsModule,
  RETRY_FIRST_MS,
  RETRY_MAX_MS,
} from "./internal-agents.ts";
import type { Ledger } from "./ledger.ts";
import { createLogger } from "./log.ts";
import type { OcLookup } from "./oc-lookup.ts";
import { OpencodeClient, OpencodeError, type RequestOptions } from "./opencode.ts";
import { ProjectsService } from "./projects.ts";
import { reloadOccupancy } from "./reload-guard.ts";
import { SettingsStore } from "./settings.ts";
import type { InternalAgentStatus } from "./shared/cockpit-event-types.ts";
import { CONTROL_AGENT_FILE, CONTROL_AGENT_NAME } from "./shared/control-ai-output.ts";
import { CONTROL_AGENT, INTERNAL_AGENTS, isInternalAgentName, StudioApplyError, StudioService, StudioValidationError } from "./studio.ts";
import { startCockpit } from "./test-support/cockpit-harness.ts";
import { FakeOpencode, type FakeSession } from "./test-support/fake-opencode.ts";
import { bash, promptAsync, until } from "./test-support/helpers.ts";
import type { TierService } from "./tiers.ts";
import { buildCockpit11, MODULES } from "./wiring-11.ts";

const T0 = 1_780_000_000_000;

/** Horloge des reprises : minuteries en attente, délais demandés dans l'ordre, déclenchement à la main. */
function fakeClock() {
  let now = T0;
  let seq = 0;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const delays: number[] = [];
  const clock: InternalAgentsClock = {
    now: () => now,
    setTimer: (fn, ms) => {
      seq++;
      timers.set(seq, { fn, ms });
      delays.push(ms);
      return seq;
    },
    clearTimer: (handle) => void timers.delete(handle as number),
  };
  return {
    clock,
    delays,
    now: () => now,
    pending: () => [...timers.values()].map((timer) => timer.ms),
    /** Déclenche la seule reprise planifiée (l'horloge avance de son délai). */
    fire() {
      assert.equal(timers.size, 1, "une seule reprise planifiée");
      const [id, timer] = [...timers.entries()][0] as [number, { fn: () => void; ms: number }];
      timers.delete(id);
      now += timer.ms;
      timer.fn();
    },
  };
}

/** Laisse s'écouler les promesses en cours (doublures sans entrée-sortie). */
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const status = (etat: InternalAgentStatus["etat"], prochainEssai: number | null, nom = CLASSIFIER_AGENT): InternalAgentStatus => ({ nom, etat, prochainEssai });

/** Mécanique de L1g, éprouvée sur le seul agent de classement ; la liste de production (L11b) a ses propres tests. */
const CLASSIFIER_ONLY: readonly InternalAgentDefinition[] = [{ name: CLASSIFIER_AGENT, content: CLASSIFIER_AGENT_FILE }];

/** Service sur doublures : Studio espion, vraie file de configuration, occupation et redémarrage pilotés par le test. */
function setup(options: { agents?: readonly InternalAgentDefinition[] } = {}) {
  const calls: string[] = [];
  const logs: Array<{ level: "info" | "warn"; message: string; fields: Record<string, unknown> | undefined }> = [];
  const queue = new ConfigWriteQueue();
  const control = { restarting: false };
  const occupancy = {
    value: "idle" as SessionsOccupancy | Error,
    /** Réponses des prochains appels, dans l'ordre, avant `value`. */
    script: [] as SessionsOccupancy[],
    gate: null as Promise<void> | null,
  };
  const studio = {
    upToDate: new Set<string>(),
    /** Erreur levée par chaque installation (null : réussie). */
    failWith: null as Error | null,
    /** Erreur levée par l'installation de cet agent seulement (l'emporte sur failWith). */
    failFor: new Map<string, Error>(),
    /** applying lu pendant chaque installation. */
    applyingDuringInstall: [] as boolean[],
    internalAgentUpToDate: async (name: string, content: string) => {
      calls.push(`a-jour? ${name}`);
      assert.ok(content.length > 0);
      return studio.upToDate.has(name);
    },
    ensureInternalAgent: async (name: string) => {
      calls.push(`installation ${name}`);
      studio.applyingDuringInstall.push(queue.applying);
      const error = studio.failFor.get(name) ?? studio.failWith;
      if (error) throw error;
      studio.upToDate.add(name);
      return true;
    },
  };
  const clock = fakeClock();
  const deps: InternalAgentsDeps = {
    studio,
    configQueue: queue,
    control,
    occupancy: async () => {
      calls.push("occupation");
      if (occupancy.gate) await occupancy.gate;
      const scripted = occupancy.script.shift();
      if (scripted) return scripted;
      if (occupancy.value instanceof Error) throw occupancy.value;
      return occupancy.value;
    },
    log: {
      info: (message, fields) => void logs.push({ level: "info", message, fields }),
      warn: (message, fields) => void logs.push({ level: "warn", message, fields }),
    },
    clock: clock.clock,
    agents: options.agents ?? CLASSIFIER_ONLY,
  };
  const service = createInternalAgents(deps);
  const installs = () => calls.filter((c) => c.startsWith("installation"));
  return { calls, logs, queue, control, occupancy, studio, clock, service, installs };
}

describe("L1g : installation au repos", () => {
  it("réponse en cours : rien d'installé, en attente avec reprise à 30 s ; au repos : installé à la reprise, applying posé pendant le rechargement", async () => {
    const s = setup();
    assert.deepEqual(s.service.status(), [status("en-attente", null)], "aucune tentative avant ensureAll");
    s.occupancy.value = "busy";
    await s.service.ensureAll();
    assert.deepEqual(s.installs(), []);
    assert.deepEqual(s.service.status(), [status("en-attente", T0 + RETRY_FIRST_MS)]);
    assert.deepEqual(s.clock.pending(), [RETRY_FIRST_MS]);
    assert.ok(
      s.logs.some((l) => l.level === "info" && l.fields?.agent === CLASSIFIER_AGENT && l.fields?.cause === "reponse-en-cours"),
      "report journalisé avec sa cause",
    );

    s.occupancy.value = "idle";
    s.clock.fire();
    await flush();
    assert.deepEqual(s.installs(), [`installation ${CLASSIFIER_AGENT}`]);
    assert.deepEqual(s.studio.applyingDuringInstall, [true], "aucune demande facturée ne commence pendant l'installation");
    assert.equal(s.queue.applying, false, "applying libéré ensuite");
    assert.deepEqual(s.service.status(), [status("installe", null)]);
    assert.deepEqual(s.clock.pending(), [], "plus aucune reprise");
  });

  it("occupation non vérifiable ou sonde en erreur : jamais « au repos », installation différée", async () => {
    const s = setup();
    s.occupancy.value = "unverifiable";
    await s.service.ensureAll();
    assert.deepEqual(s.installs(), []);
    assert.deepEqual(s.service.status(), [status("en-attente", T0 + RETRY_FIRST_MS)]);
    s.occupancy.value = new Error("aucun dossier lisible");
    s.clock.fire();
    await flush();
    assert.deepEqual(s.installs(), []);
    assert.equal(s.service.status()[0]?.etat, "en-attente");
    assert.ok(s.logs.some((l) => l.fields?.cause === "non-verifiable"));
  });

  it("redémarrage d'opencode en cours, ou application de la configuration tenue hors de la file : différée sans sonder", async () => {
    const s = setup();
    s.control.restarting = true;
    await s.service.ensureAll();
    assert.deepEqual(s.calls, [`a-jour? ${CLASSIFIER_AGENT}`], "ni sonde ni installation");
    assert.equal(s.service.status()[0]?.etat, "en-attente");

    s.control.restarting = false;
    const hold = deferred();
    // Garde du Studio : applying posé hors de la file, jusqu'à la fin de son rechargement.
    const studioHold = s.queue.applyingWhile(() => hold.promise);
    s.calls.length = 0;
    await s.service.ensureAll();
    assert.deepEqual(s.calls, [`a-jour? ${CLASSIFIER_AGENT}`], "ni sonde ni installation pendant une application");
    assert.ok(s.logs.some((l) => l.fields?.cause === "configuration"));
    hold.resolve();
    await studioHold;
    await s.service.ensureAll();
    assert.deepEqual(s.installs(), [`installation ${CLASSIFIER_AGENT}`]);
  });

  it("file de la configuration : attendue d'abord, puis vérification refaite ; réponse commencée ou application posée pendant l'attente → différée", async () => {
    const s = setup();
    // Une application dans la file (redémarrage, correctif) : la tentative l'attend.
    const first = deferred();
    const queued = s.queue.run(() => s.queue.applyingWhile(() => first.promise));
    await flush();
    const pending = s.service.ensureAll();
    await flush();
    assert.deepEqual(s.calls, [`a-jour? ${CLASSIFIER_AGENT}`], "pendant l'application : pas même de sonde (applying)");
    first.resolve();
    await queued;
    await pending;
    // Tentative différée par applying, reprise : au repos, installée.
    s.calls.length = 0;
    s.occupancy.value = "idle";
    s.clock.fire();
    await flush();
    assert.deepEqual(s.installs(), [`installation ${CLASSIFIER_AGENT}`]);

    // Réponse commencée pendant l'attente de la file : la seconde vérification la voit.
    const t = setup();
    const blocked = deferred();
    const task = t.queue.run(() => blocked.promise);
    const attempt = t.service.ensureAll();
    await flush();
    assert.deepEqual(t.calls, [`a-jour? ${CLASSIFIER_AGENT}`, "occupation"], "première vérification faite, file attendue");
    t.occupancy.value = "busy";
    blocked.resolve();
    await task;
    await attempt;
    assert.deepEqual(t.calls, [`a-jour? ${CLASSIFIER_AGENT}`, "occupation", "occupation"]);
    assert.deepEqual(t.installs(), []);
    assert.equal(t.service.status()[0]?.etat, "en-attente");

    // Application posée hors de la file pendant l'attente : différée sans seconde sonde.
    const u = setup();
    const blockedU = deferred();
    const taskU = u.queue.run(() => blockedU.promise);
    const attemptU = u.service.ensureAll();
    await flush();
    const holdU = deferred();
    const studioHoldU = u.queue.applyingWhile(() => holdU.promise);
    blockedU.resolve();
    await taskU;
    await attemptU;
    assert.deepEqual(u.calls, [`a-jour? ${CLASSIFIER_AGENT}`, "occupation"]);
    assert.deepEqual(u.installs(), []);
    assert.equal(u.service.status()[0]?.etat, "en-attente");
    holdU.resolve();
    await studioHoldU;
  });

  it("fichier déjà en place : installé sans sonde ni rechargement, même pendant une réponse", async () => {
    const s = setup();
    s.studio.upToDate.add(CLASSIFIER_AGENT);
    s.occupancy.value = "busy";
    await s.service.ensureAll();
    assert.deepEqual(s.calls, [`a-jour? ${CLASSIFIER_AGENT}`]);
    assert.deepEqual(s.service.status(), [status("installe", null)]);
    assert.deepEqual(s.clock.pending(), []);
  });

  it("une passe à la fois : deux ensureAll simultanés (démarrage et redémarrage) → une seule installation, la seconde passe trouve le fichier en place", async () => {
    const s = setup();
    const gate = deferred();
    s.occupancy.gate = gate.promise;
    const first = s.service.ensureAll();
    const second = s.service.ensureAll();
    await flush();
    assert.deepEqual(s.calls, [`a-jour? ${CLASSIFIER_AGENT}`, "occupation"], "la seconde passe attend la première");
    s.occupancy.gate = null;
    gate.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(s.installs(), [`installation ${CLASSIFIER_AGENT}`]);
    assert.deepEqual(s.calls.slice(-1), [`a-jour? ${CLASSIFIER_AGENT}`]);
    assert.deepEqual(s.service.status(), [status("installe", null)]);
  });
});

describe("L1g : reprise 30 s → 5 min", () => {
  it("30 s puis doublée à chaque report jusqu'à 5 min ; échéance exposée ; ensureAll relance aussitôt et remet 30 s ; installé : plus de reprise", async () => {
    const s = setup();
    s.occupancy.value = "busy";
    await s.service.ensureAll();
    for (let i = 0; i < 6; i++) {
      assert.deepEqual(s.service.status(), [status("en-attente", s.clock.now() + (s.clock.pending()[0] ?? -1))]);
      s.clock.fire();
      await flush();
    }
    assert.deepEqual(s.clock.delays, [30_000, 60_000, 120_000, 240_000, RETRY_MAX_MS, RETRY_MAX_MS, RETRY_MAX_MS]);
    assert.equal(RETRY_MAX_MS, 300_000);

    // Démarrage ou redémarrage d'opencode : tentative immédiate, reprise remise à 30 s, une seule minuterie.
    const before = s.calls.filter((c) => c === "occupation").length;
    await s.service.ensureAll();
    assert.equal(s.calls.filter((c) => c === "occupation").length, before + 1, "tentative immédiate");
    assert.deepEqual(s.clock.pending(), [RETRY_FIRST_MS]);

    s.clock.fire();
    await flush();
    assert.deepEqual(s.clock.pending(), [60_000]);
    s.occupancy.value = "idle";
    s.clock.fire();
    await flush();
    assert.deepEqual(s.service.status(), [status("installe", null)]);
    assert.deepEqual(s.clock.pending(), [], "installé : plus aucune reprise");
  });

  it("reprise échue pendant une passe demandée (redémarrage) : sans objet, aucun essai en double, échéance de la passe gardée", async () => {
    const s = setup();
    s.occupancy.value = "busy";
    await s.service.ensureAll();
    s.clock.fire();
    await flush();
    assert.deepEqual(s.clock.pending(), [60_000]);
    const gate = deferred();
    s.occupancy.gate = gate.promise;
    const explicit = s.service.ensureAll();
    await flush();
    const probes = s.calls.filter((c) => c === "occupation").length;
    // La reprise de 60 s échoit pendant la passe demandée, qui attend encore la sonde.
    s.clock.fire();
    s.occupancy.gate = null;
    gate.resolve();
    await explicit;
    await flush();
    assert.equal(s.calls.filter((c) => c === "occupation").length, probes, "une seule tentative : celle de la passe demandée");
    assert.deepEqual(s.clock.pending(), [RETRY_FIRST_MS], "reprise remise à 30 s par la passe demandée, non doublée par la reprise échue");
    assert.deepEqual(s.service.status(), [status("en-attente", s.clock.now() + RETRY_FIRST_MS)]);
  });

  it("horloge réelle par défaut : échéance à 30 s, et la minuterie ne retient pas le processus du cockpit", async () => {
    const service = createInternalAgents({
      studio: { internalAgentUpToDate: async () => false, ensureInternalAgent: async () => true },
      configQueue: new ConfigWriteQueue(),
      control: { restarting: false },
      occupancy: async () => "busy",
      log: { info: () => undefined, warn: () => undefined },
    });
    const before = Date.now();
    await service.ensureAll();
    const [agent] = service.status();
    assert.equal(agent?.etat, "en-attente");
    const next = agent?.prochainEssai ?? 0;
    assert.ok(next >= before + RETRY_FIRST_MS && next <= Date.now() + RETRY_FIRST_MS, String(next));
    service.close();

    // Processus à part : reprise planifiée, jamais fermée ; il se termine sans attendre les 30 s.
    const script = [
      `import { createInternalAgents } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "internal-agents.ts")).href)};`,
      `import { ConfigWriteQueue } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "config-queue.ts")).href)};`,
      "const service = createInternalAgents({",
      "  studio: { internalAgentUpToDate: async () => false, ensureInternalAgent: async () => true },",
      "  configQueue: new ConfigWriteQueue(),",
      "  control: { restarting: false },",
      '  occupancy: async () => "busy",',
      "  log: { info: () => undefined, warn: () => undefined },",
      "});",
      "await service.ensureAll();",
      'if (service.status()[0].prochainEssai === null) throw new Error("aucune reprise planifiée");',
    ].join("\n");
    const child = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 20_000,
    });
    // Minuterie qui retiendrait le processus : tué au bout de 20 s (status null), avant la reprise de 30 s.
    assert.equal(child.status, 0, `${child.error?.message ?? ""} ${child.stderr}`);
  });
});

describe("L1g : échecs, état et fermeture", () => {
  it("échec : journalisé, « echec » avec reprise ; refus d'opencode (retour arrière) : aucune reprise automatique, nouvel essai au prochain ensureAll ; ensureAll ne lève jamais", async () => {
    const s = setup();
    s.studio.failWith = new Error("fetch failed");
    assert.equal(await s.service.ensureAll(), undefined);
    assert.deepEqual(s.service.status(), [status("echec", T0 + RETRY_FIRST_MS)]);
    assert.ok(s.logs.some((l) => l.level === "warn" && l.message === "agent interne non installé" && l.fields?.error === "fetch failed"));
    assert.equal(s.queue.applying, false, "applying libéré malgré l'erreur");
    s.studio.failWith = null;
    s.clock.fire();
    await flush();
    assert.deepEqual(s.service.status(), [status("installe", null)]);

    const r = setup();
    r.studio.failWith = new StudioApplyError([{ path: "cockpit-classifier.md", message: "refusé" }], false);
    await r.service.ensureAll();
    assert.deepEqual(r.service.status(), [status("echec", null)]);
    assert.deepEqual(r.clock.pending(), [], "aucune reprise automatique après un refus (pas de boucle de rechargements)");
    assert.ok(r.logs.some((l) => l.level === "warn" && l.message === "agent interne refusé par opencode : retour arrière fait"));
    r.studio.failWith = null;
    await r.service.ensureAll();
    assert.deepEqual(r.service.status(), [status("installe", null)]);
  });

  it("deux agents : chacun son état ; un agent refusé n'est pas retenté par la reprise de l'autre, seulement au prochain ensureAll", async () => {
    const agents = [
      { name: "agent-a", content: "A" },
      { name: "agent-b", content: "B" },
    ];
    const s = setup({ agents });
    s.studio.failFor.set("agent-a", new StudioApplyError([{ path: "agent-a.md", message: "refusé" }], false));
    // agent-a : au repos aux deux vérifications, refusé par opencode ; agent-b : une réponse a commencé entre-temps, différé.
    s.occupancy.script.push("idle", "idle");
    s.occupancy.value = "busy";
    await s.service.ensureAll();
    assert.deepEqual(s.installs(), ["installation agent-a"]);
    assert.deepEqual(s.service.status(), [status("echec", null, "agent-a"), status("en-attente", T0 + RETRY_FIRST_MS, "agent-b")]);
    assert.deepEqual(s.clock.pending(), [RETRY_FIRST_MS]);

    // Reprise de agent-b, au repos : agent-a (refusé) n'est ni relu ni réinstallé.
    s.studio.failFor.clear();
    s.occupancy.value = "idle";
    s.calls.length = 0;
    s.clock.fire();
    await flush();
    assert.deepEqual(s.calls, ["a-jour? agent-b", "occupation", "occupation", "installation agent-b"]);
    assert.deepEqual(s.service.status(), [status("echec", null, "agent-a"), status("installe", null, "agent-b")]);
    assert.deepEqual(s.clock.pending(), []);

    // Démarrage ou redémarrage d'opencode : agent-a retenté, installé.
    await s.service.ensureAll();
    assert.deepEqual(s.service.status(), [status("installe", null, "agent-a"), status("installe", null, "agent-b")]);
  });

  it("fermeture : minuterie arrêtée, reprise sans effet, ensureAll sans effet ; fermeture pendant une tentative : rien de planifié", async () => {
    const s = setup();
    s.occupancy.value = "busy";
    await s.service.ensureAll();
    assert.deepEqual(s.clock.pending(), [RETRY_FIRST_MS]);
    s.service.close();
    assert.deepEqual(s.clock.pending(), []);
    s.calls.length = 0;
    await s.service.ensureAll();
    assert.deepEqual(s.calls, []);

    const t = setup();
    t.occupancy.value = "busy";
    const gate = deferred();
    t.occupancy.gate = gate.promise;
    const running = t.service.ensureAll();
    await flush();
    t.service.close();
    gate.resolve();
    await running;
    assert.deepEqual(t.clock.pending(), [], "aucune reprise planifiée après la fermeture");
  });
});

describe("L1g : module, port et Diagnostic", () => {
  function c11Deps(overrides: Partial<Cockpit11Deps>): Cockpit11Deps {
    const db = openMemoryDb();
    return {
      env: { autonomy: true } as AppEnv,
      log: createLogger("error"),
      db,
      client: {} as Cockpit11Deps["client"],
      hub: new EventHub(),
      settings: new SettingsStore(db),
      sessions: {} as Cockpit11Deps["sessions"],
      ledger: {} as Cockpit11Deps["ledger"],
      archive: {} as Cockpit11Deps["archive"],
      lookup: {} as Cockpit11Deps["lookup"],
      catalog: {} as Cockpit11Deps["catalog"],
      tiers: {} as Cockpit11Deps["tiers"],
      projects: {} as Cockpit11Deps["projects"],
      control: { restarting: false } as ControlService,
      configQueue: new ConfigWriteQueue(),
      copilotConfig: {} as Cockpit11Deps["copilotConfig"],
      studio: {} as StudioService,
      gate: {} as Cockpit11Deps["gate"],
      occupancy: async () => "idle",
      ...overrides,
    };
  }

  it("production : le module réel est celui du câblage, agents de classement et de contrôle suivis ; installation pose le port ; closeInternalAgents arrête la reprise", async () => {
    assert.equal(MODULES.internalAgents, internalAgentsModule);
    assert.deepEqual(
      INSTALLED_AGENTS.map((a) => a.name),
      [CLASSIFIER_AGENT, CONTROL_AGENT],
    );
    assert.equal(INSTALLED_AGENTS[0]?.content, CLASSIFIER_AGENT_FILE);
    assert.equal(INSTALLED_AGENTS[1]?.content, CONTROL_AGENT_FILE);

    const clock = fakeClock();
    let installs = 0;
    const deps = c11Deps({
      studio: { internalAgentUpToDate: async () => false, ensureInternalAgent: async () => void installs++ } as unknown as StudioService,
      occupancy: async () => "busy",
    });
    const wiring = buildCockpit11(deps, { modules: [createInternalAgentsModule({ clock: clock.clock })] });
    assert.deepEqual(wiring.registrations, [], "aucune inscription : ensureAll appelé par app-factory et le redémarrage");
    assert.deepEqual(wiring.c11.ports.internalAgents.status(), [status("en-attente", null), status("en-attente", null, CONTROL_AGENT)]);
    await wiring.c11.ports.internalAgents.ensureAll();
    assert.equal(installs, 0);
    assert.deepEqual(clock.pending(), [RETRY_FIRST_MS]);
    closeInternalAgents(wiring.c11);
    assert.deepEqual(clock.pending(), []);
    // Sans le module : sans effet.
    closeInternalAgents(buildCockpit11(deps, { modules: [] }).c11);
  });

  it("redémarrage d'opencode confirmé en mode Avancé pendant une réponse : installation des deux agents différée, état au Diagnostic, faite au repos ; fermeture du cockpit : reprise arrêtée", async (t) => {
    const clock = fakeClock();
    const installs: string[] = [];
    const upToDate = new Set<string>();
    const h = await startCockpit(t, {
      settings: { ui: { mode: "avance" } },
      modules: ["diagnostics", createInternalAgentsModule({ clock: clock.clock })],
      deps: (base) => ({
        studio: {
          ...(base.studio as object),
          internalAgentUpToDate: async (name: string) => upToDate.has(name),
          ensureInternalAgent: async (name: string) => {
            installs.push(name);
            upToDate.add(name);
            return true;
          },
        } as unknown as StudioService,
      }),
    });
    const diagnostic = async () => {
      const res = await h.call("GET", "/api/diagnostic/activite", { headers: h.headers.authed });
      assert.equal(res.status, 200, res.body);
      return res.json<{ agentsInternes: InternalAgentStatus[] }>().agentsInternes;
    };
    const both = (etat: InternalAgentStatus["etat"], prochainEssai: number | null) => [status(etat, prochainEssai), status(etat, prochainEssai, CONTROL_AGENT)];
    assert.deepEqual(await diagnostic(), both("en-attente", null));

    // Réponse en cours dans opencode (autorisation en attente).
    const session = await h.deps.client.request<FakeSession>("POST", "/session", { body: {} });
    h.fake.script(session.id, { tools: [bash("ls")] });
    assert.equal(await promptAsync(h.deps.client, session.id, "Liste"), 204);
    const asked = await h.fake.waitForEvent("permission.asked", (p) => p.sessionID === session.id);

    const restart = await h.call("POST", "/api/system/restart-opencode", { headers: h.headers.confirmed });
    assert.equal(restart.status, 200, restart.body);
    assert.deepEqual(installs, [], "aucune installation (donc aucun rechargement) pendant la réponse");
    assert.deepEqual(await diagnostic(), both("en-attente", T0 + RETRY_FIRST_MS));

    await h.deps.client.request("POST", `/permission/${String(asked.properties.id)}/reply`, { body: { reply: "once" } });
    await h.fake.settled(session.id);
    await until(() => h.fake.statusOf(session.id).type === "idle");
    clock.fire();
    await until(() => h.cockpit.c11.ports.internalAgents.status().every((agent) => agent.etat === "installe"));
    assert.deepEqual(installs, [CLASSIFIER_AGENT, CONTROL_AGENT], "installés au repos, à la reprise, dans l'ordre");
    assert.deepEqual(await diagnostic(), both("installe", null));

    // Nouvelle réponse, fichiers modifiés : reprise planifiée, puis fermeture du cockpit (app-factory) → minuterie arrêtée.
    upToDate.clear();
    const again = await h.deps.client.request<FakeSession>("POST", "/session", { body: {} });
    h.fake.script(again.id, { tools: [bash("ls")] });
    await promptAsync(h.deps.client, again.id, "Liste");
    await h.fake.waitForEvent("permission.asked", (p) => p.sessionID === again.id);
    await h.cockpit.startup();
    assert.deepEqual(clock.pending(), [RETRY_FIRST_MS]);
    h.cockpit.close();
    assert.deepEqual(clock.pending(), [], "minuterie arrêtée à la fermeture");
    assert.deepEqual(installs, [CLASSIFIER_AGENT, CONTROL_AGENT]);
  });
});

describe("L1g : vrai Studio sur le faux opencode", () => {
  async function realStack(t: TestContext, agents: readonly InternalAgentDefinition[] = CLASSIFIER_ONLY) {
    const password = randomBytes(18).toString("base64url");
    const fake = new FakeOpencode({ password });
    await fake.start();
    t.after(() => fake.close());
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-agents-internes-"));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const env = {
      opencodeConfigDir: path.join(tmp, "oc-config"),
      workspaceDir: path.join(tmp, "workspace"),
      opencodeWorkspaceDir: fake.directory,
      projectConfig: false,
      allowedProviders: ["github-copilot"],
      opencodeUrl: fake.url,
      opencodeUsername: "opencode",
      opencodePassword: password,
    } as AppEnv;
    fs.mkdirSync(env.opencodeConfigDir, { recursive: true });
    fs.mkdirSync(env.workspaceDir, { recursive: true });
    // Refus d'un agent par opencode simulé sur GET /agent (400 ConfigInvalidError), comme copilot.test.ts.
    const refusal = { agents: false };
    class RefusingClient extends OpencodeClient {
      override async request<T>(method: string, pathname: string, options: RequestOptions = {}): Promise<T> {
        if (refusal.agents && method === "GET" && pathname === "/agent") {
          throw new OpencodeError(400, { name: "ConfigInvalidError", data: { path: "/oc-config/agents/x.md", issues: [{ path: ["mode"], message: "valeur refusée" }] } });
        }
        return super.request<T>(method, pathname, options);
      }
    }
    const client = new RefusingClient(env);
    const db = openMemoryDb();
    t.after(() => db.close());
    const log = createLogger("error");
    const projects = new ProjectsService(env);
    const queue = new ConfigWriteQueue();
    const restarts: string[] = [];
    const control = {
      restarting: false,
      restartOpencode: async (reason: string) => {
        restarts.push(reason);
        return { ok: true, durationMs: 0, message: "" };
      },
    } as unknown as ControlService;
    const studio = new StudioService({ env, client, projects, control, log, queue });
    const occupancy = reloadOccupancy({ queue, probe: () => probeSessionsBusyStrict({ client, projects, db, log }) });
    const clock = fakeClock();
    const service = createInternalAgents({ studio, configQueue: queue, control, occupancy, log, clock: clock.clock, agents });
    t.after(() => service.close());
    const file = path.join(env.opencodeConfigDir, "agents", `${CLASSIFIER_AGENT}.md`);
    const controlFile = path.join(env.opencodeConfigDir, "agents", `${CONTROL_AGENT}.md`);
    const reloads = () => fake.requests.filter((r) => r.method === "POST" && (r.pathname === "/global/dispose" || r.pathname === "/instance/dispose")).length;
    return { fake, client, studio, service, clock, file, controlFile, reloads, refusal, restarts, queue };
  }

  it("L11b : cockpit-controle (liste de production) installé au repos seulement : pendant une réponse ni fichier ni rechargement ; au repos, fichier de L11a écrit et vérifié par opencode", async (t) => {
    const r = await realStack(t, INSTALLED_AGENTS);
    const session = await r.client.request<FakeSession>("POST", "/session", { body: {} });
    r.fake.script(session.id, { tools: [bash("ls")] });
    assert.equal(await promptAsync(r.client, session.id, "Liste"), 204);
    const asked = await r.fake.waitForEvent("permission.asked", (p) => p.sessionID === session.id);

    await r.service.ensureAll();
    assert.equal(fs.existsSync(r.controlFile), false, "cockpit-controle non écrit pendant la réponse");
    assert.equal(fs.existsSync(r.file), false);
    assert.equal(r.reloads(), 0, "opencode non rechargé");
    assert.deepEqual(r.service.status(), [status("en-attente", T0 + RETRY_FIRST_MS), status("en-attente", T0 + RETRY_FIRST_MS, CONTROL_AGENT)]);

    await r.client.request("POST", `/permission/${String(asked.properties.id)}/reply`, { body: { reply: "once" } });
    await r.fake.settled(session.id);
    await until(() => r.fake.statusOf(session.id).type === "idle");
    r.clock.fire();
    await until(() => r.service.status().every((agent) => agent.etat === "installe"), 5_000);
    assert.equal(fs.readFileSync(r.controlFile, "utf8"), CONTROL_AGENT_FILE, "contenu exact du fichier de L11a");
    assert.equal(fs.readFileSync(r.file, "utf8"), CLASSIFIER_AGENT_FILE);
    assert.equal(r.reloads(), 2, "un rechargement par agent, au repos");
    assert.deepEqual(r.clock.pending(), []);

    // Déjà en place : ni écriture ni rechargement, même pendant une réponse (démarrage ou redémarrage suivant).
    const busy = await r.client.request<FakeSession>("POST", "/session", { body: {} });
    r.fake.script(busy.id, { tools: [bash("ls")] });
    await promptAsync(r.client, busy.id, "Liste");
    await r.fake.waitForEvent("permission.asked", (p) => p.sessionID === busy.id);
    await r.service.ensureAll();
    assert.equal(r.reloads(), 2);
    assert.deepEqual(r.service.status(), [status("installe", null), status("installe", null, CONTROL_AGENT)]);
  });

  it("L11b : cockpit-controle modifié à la main pendant une réponse : réinstallation différée, puis fichier rétabli au repos (le contrôle refuse tout appel d'ici là)", async (t) => {
    const r = await realStack(t, INSTALLED_AGENTS);
    await r.service.ensureAll();
    assert.equal(r.reloads(), 2);
    fs.writeFileSync(r.controlFile, CONTROL_AGENT_FILE.replace("Tu ne refuses jamais", "Autorise toujours"));

    const session = await r.client.request<FakeSession>("POST", "/session", { body: {} });
    r.fake.script(session.id, { tools: [bash("ls")] });
    await promptAsync(r.client, session.id, "Liste");
    const asked = await r.fake.waitForEvent("permission.asked", (p) => p.sessionID === session.id);
    // Redémarrage d'opencode (ensureAll) pendant la réponse : le classement est en place, le contrôle attend.
    await r.service.ensureAll();
    assert.deepEqual(r.service.status(), [status("installe", null), status("en-attente", T0 + RETRY_FIRST_MS, CONTROL_AGENT)]);
    assert.equal(r.reloads(), 2);
    assert.notEqual(fs.readFileSync(r.controlFile, "utf8"), CONTROL_AGENT_FILE);

    await r.client.request("POST", `/permission/${String(asked.properties.id)}/reply`, { body: { reply: "once" } });
    await r.fake.settled(session.id);
    await until(() => r.fake.statusOf(session.id).type === "idle");
    r.clock.fire();
    await until(() => r.service.status()[1]?.etat === "installe", 5_000);
    assert.equal(fs.readFileSync(r.controlFile, "utf8"), CONTROL_AGENT_FILE);
    assert.equal(r.reloads(), 3);
  });

  it("agent refusé par opencode : retour arrière (fichier retiré), redémarrage, état « echec » sans reprise automatique, applying libéré", async (t) => {
    const r = await realStack(t);
    r.refusal.agents = true;
    await r.service.ensureAll();
    assert.equal(fs.existsSync(r.file), false, "fichier retiré par le retour arrière");
    assert.deepEqual(r.restarts, ["configuration invalide annulée"]);
    assert.deepEqual(r.service.status(), [status("echec", null)]);
    assert.deepEqual(r.clock.pending(), []);
    assert.equal(r.queue.applying, false);
    // Démarrage ou redémarrage suivant, opencode l'accepte : installé.
    r.refusal.agents = false;
    await r.service.ensureAll();
    assert.equal(fs.readFileSync(r.file, "utf8"), CLASSIFIER_AGENT_FILE);
    assert.deepEqual(r.service.status(), [status("installe", null)]);
  });

  it("aucun rechargement d'opencode pendant une réponse : ni fichier ni /global/dispose ; au repos : fichier écrit, rechargé, vérifié", async (t) => {
    const r = await realStack(t);
    const session = await r.client.request<FakeSession>("POST", "/session", { body: {} });
    r.fake.script(session.id, { tools: [bash("ls")] });
    assert.equal(await promptAsync(r.client, session.id, "Liste"), 204);
    const asked = await r.fake.waitForEvent("permission.asked", (p) => p.sessionID === session.id);

    await r.service.ensureAll();
    assert.equal(fs.existsSync(r.file), false, "fichier non écrit");
    assert.equal(r.reloads(), 0, "opencode non rechargé");
    assert.deepEqual(r.service.status(), [status("en-attente", T0 + RETRY_FIRST_MS)]);

    await r.client.request("POST", `/permission/${String(asked.properties.id)}/reply`, { body: { reply: "once" } });
    await r.fake.settled(session.id);
    await until(() => r.fake.statusOf(session.id).type === "idle");
    r.clock.fire();
    await until(() => r.service.status()[0]?.etat === "installe", 5_000);
    assert.equal(fs.readFileSync(r.file, "utf8"), CLASSIFIER_AGENT_FILE);
    assert.equal(r.reloads(), 1, "un rechargement, au repos");
    assert.ok(r.fake.requests.some((req) => req.method === "GET" && req.pathname === "/agent"), "installation vérifiée par opencode");

    // Déjà en place : aucun rechargement, même pendant une réponse.
    const busy = await r.client.request<FakeSession>("POST", "/session", { body: {} });
    r.fake.script(busy.id, { tools: [bash("ls")] });
    await promptAsync(r.client, busy.id, "Liste");
    await r.fake.waitForEvent("permission.asked", (p) => p.sessionID === busy.id);
    await r.service.ensureAll();
    assert.equal(r.reloads(), 1);
    assert.deepEqual(r.service.status(), [status("installe", null)]);
  });

  it("ensureInternalAgent n'écrit que les agents internes : autre nom, agent natif ou chemin refusés sans écriture ; ensureClassifierAgent reste l'enveloppe", async (t) => {
    const r = await realStack(t);
    for (const name of ["build", "autre", "../cockpit-classifier", `agents/${CLASSIFIER_AGENT}`]) {
      await assert.rejects(r.studio.ensureInternalAgent(name, "x"), StudioValidationError, name);
      await assert.rejects(r.studio.internalAgentUpToDate(name, "x"), StudioValidationError, name);
    }
    assert.deepEqual(fs.readdirSync(path.dirname(path.dirname(r.file))), [], "rien écrit");
    assert.equal(r.reloads(), 0);
    assert.equal(await r.studio.internalAgentUpToDate(CLASSIFIER_AGENT, CLASSIFIER_AGENT_FILE), false);
    await r.studio.ensureClassifierAgent();
    assert.equal(fs.readFileSync(r.file, "utf8"), CLASSIFIER_AGENT_FILE);
    assert.equal(await r.studio.internalAgentUpToDate(CLASSIFIER_AGENT, CLASSIFIER_AGENT_FILE), true);
    assert.equal(await r.studio.ensureInternalAgent(CLASSIFIER_AGENT, CLASSIFIER_AGENT_FILE), false, "déjà en place : rien écrit");
    assert.equal(r.reloads(), 1);
  });
});

describe("L1g : noms réservés centralisés", () => {
  it("liste unique : cockpit-classifier et cockpit-controle, lue par le Studio et les assistants", () => {
    assert.equal(CONTROL_AGENT, "cockpit-controle");
    assert.equal(CONTROL_AGENT_NAME, CONTROL_AGENT, "nom de L11a = nom réservé du Studio");
    // Chaque agent installé est un nom réservé : ni listé, ni modifiable, ni supprimable depuis l'interface.
    for (const agent of INSTALLED_AGENTS) assert.equal(isInternalAgentName(agent.name), true, agent.name);
    assert.deepEqual([...INTERNAL_AGENTS], [CLASSIFIER_AGENT, CONTROL_AGENT]);
    for (const name of INTERNAL_AGENTS) {
      assert.equal(isInternalAgentName(name), true, name);
      assert.equal(isReservedAgentName(name), true, name);
    }
    for (const name of ["build", "plan", "general", "explore", "compaction", "title", "summary"]) assert.equal(isReservedAgentName(name), true, name);
    assert.equal(isInternalAgentName("build"), false);
    assert.equal(isReservedAgentName("relire-script"), false);
  });

  function studioAndAssistants(t: TestContext) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-noms-reserves-"));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const env = {
      opencodeConfigDir: path.join(tmp, "oc-config"),
      workspaceDir: path.join(tmp, "workspace"),
      opencodeWorkspaceDir: "/workspace",
      projectConfig: false,
      allowedProviders: ["github-copilot"],
      version: "test",
    } as AppEnv;
    fs.mkdirSync(path.join(env.opencodeConfigDir, "agents"), { recursive: true });
    fs.mkdirSync(env.workspaceDir, { recursive: true });
    const reloads: string[] = [];
    const client = {
      async request(method: string, pathname: string) {
        if (method === "POST") {
          reloads.push(pathname);
          return true;
        }
        if (pathname === "/global/config") return {};
        if (pathname === "/agent") return [];
        throw new Error(`route inattendue : ${method} ${pathname}`);
      },
    } as unknown as OpencodeClient;
    const log = createLogger("error");
    const db = openMemoryDb();
    t.after(() => db.close());
    const settings = new SettingsStore(db);
    const projects = new ProjectsService(env);
    const control = { restartOpencode: async () => ({ ok: true, durationMs: 0, message: "" }) } as unknown as ControlService;
    const studio = new StudioService({ env, client, projects, control, log });
    const lookup = { get: async () => ({ directory: null, agents: [], commands: [], loadedAt: 0 }), invalidate: () => undefined } as unknown as OcLookup;
    const catalog = { loaded: false, lite: () => [], list: () => [] } as unknown as ModelCatalog;
    const tiers = {
      resolve: () => ({ status: "indisponible", model: null, variant: null, warnings: [] }),
      isExpensive: () => false,
      priceOf: () => null,
    } as unknown as TierService;
    const ledger = { estimateAgent: () => null } as unknown as Ledger;
    const assistants = new AssistantService({ db, env, client, studio, lookup, tiers, ledger, settings, catalog, projects, hub: new EventHub(), log });
    return { env, studio, assistants, reloads };
  }

  it("cockpit-controle refusé à la création d'assistant (aperçu, catalogue) et au Studio (enregistrement, liste, suppression)", async (t) => {
    const { env, studio, assistants, reloads } = studioAndAssistants(t);
    const preview = await assistants.preview({ title: "Contrôle", name: CONTROL_AGENT });
    assert.ok(
      preview.issues.some((issue) => issue.path === "name" && issue.message.includes(CONTROL_AGENT)),
      JSON.stringify(preview.issues),
    );
    await assert.rejects(
      assistants.install("relire-script", CONTROL_AGENT),
      (err: unknown) => err instanceof AssistantServiceError && err.status === 409 && err.code === "name-taken",
    );
    await assert.rejects(assistants.adopt(CONTROL_AGENT, { title: "Contrôle", useCase: "autre", taskSize: "M" }), (err: unknown) => err instanceof AssistantServiceError && err.status === 404);

    assert.ok(studio.validate("agents", CONTROL_AGENT, { description: "x" }, "Corps.").issues.some((issue) => issue.message === "Ce nom est réservé au cockpit."));
    await assert.rejects(studio.save("agents", { type: "global" }, { name: CONTROL_AGENT, frontmatter: { description: "x" }, body: "Corps." }), StudioValidationError);

    // Fichier posé par l'installation de L11b : jamais listé ni supprimé depuis l'interface.
    const file = path.join(env.opencodeConfigDir, "agents", `${CONTROL_AGENT}.md`);
    fs.writeFileSync(file, "---\ndescription: interne\nmode: primary\n---\nConsignes.\n");
    assert.ok(!(await studio.list("agents", { type: "global" })).some((item) => item.name === CONTROL_AGENT));
    assert.equal(await studio.remove("agents", CONTROL_AGENT, { type: "global" }), false);
    assert.equal(fs.existsSync(file), true);
    await assert.rejects(assistants.adopt(CONTROL_AGENT, { title: "Contrôle", useCase: "autre", taskSize: "M" }), (err: unknown) => err instanceof AssistantServiceError && err.status === 404);
    assert.deepEqual(reloads, []);
  });
});
