// Tests de cadre du câblage 1.1 (plan d'exécution §2.2, §2.6, §4.4, §4.7 ; T0) : ordre figé vérifié avec des modules factices,
// ports neutres (= 1.0.4), porte I1, route du Diagnostic, salle coupée (D-10), motifs d'identifiants, propriétaires des squelettes.
// Le harnais T1 n'existe pas encore : createApp est monté avec des dépendances minimales, sans réseau (app.request).
// Salle OMO (plan 2 bis §2.7, §4.1.2, §4.2 ; D-2b-40, T3b) : porte SALLE_OUVERTE, ports neutres de la salle, ordre du §4.1.2
// vérifié avec des modules factices, filtre par instance, et test « production » PAR PROPRIÉTÉ — liste exacte pour les modules
// de l'itération 1 et de l'itération 2, propriété (instances et couple de STEP_ORDER) pour ceux de la salle : remplacer un
// squelette de la salle ne touche plus ce fichier, qui est le DERNIER que T3b écrit (aucun paquet ne le modifie après).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { Hono } from "hono";
import { parse as parseYaml } from "yaml";
import { emitCockpit } from "./cockpit-events.ts";
import {
  type Cockpit11Deps,
  type Cockpit11Module,
  type HookStep,
  type ModuleName,
  type PortName,
  PortUnavailableError,
  type ProxyContext,
  type Registrar,
} from "./contracts-11.ts";
import { openMemoryDb } from "./db.ts";
import type { AppEnv } from "./env.ts";
import { createApp } from "./http.ts";
import { type BrowserEvent, EventHub } from "./hub.ts";
import { createLogger, type Logger } from "./log.ts";
import { OMO_MODULE_NAMES, OMO_ORDRE_PROPOSE, type OmoModuleName } from "./omo-contracts.ts";
import { SESSION_COOKIE_NAME, sessionValue } from "./security.ts";
import { SettingsStore } from "./settings.ts";
import type { SessionInstance } from "./shared/activity-types.ts";
import { ID, ID_RE, SESSION_ID_RE } from "./shared/ids.ts";
import { phraseRefusActivation } from "./shared/omo-room-texts.ts";
import type { StudioService } from "./studio.ts";
import {
  ACTIVATION_OUVERTE,
  buildCockpit11,
  type Cockpit11Wiring,
  MODULE_ORDER,
  MODULES,
  NEUTRAL_PORTS,
  type Registration,
  SALLE_OUVERTE,
  servesInstance,
  STEP_ORDER,
} from "./wiring-11.ts";
// <c5:import>
import { CONSTRUCTION_MODULE_ORDER } from "./wiring-construction.ts";
// </c5:import>

/** Modules de la salle (T3a) : le test « production » leur applique une propriété, jamais une liste exacte (D-2b-40). */
const EST_MODULE_SALLE = (name: string): name is OmoModuleName => (OMO_MODULE_NAMES as readonly string[]).includes(name);

/** Modules du cockpit (itérations 1 et 2), dans l'ordre d'installation. */
const MODULES_COCKPIT = MODULE_ORDER.filter((name) => !EST_MODULE_SALLE(name));

/** Jeton de test généré à chaque exécution, jamais imprimé. */
const TOKEN = crypto.randomBytes(36).toString("base64url");

function testEnv(autonomy: boolean): AppEnv {
  return {
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    allowedHosts: ["127.0.0.1"],
    dataDir: "/data",
    archiveDir: "/archives",
    workspaceDir: "/workspace",
    opencodeWorkspaceDir: "/workspace",
    opencodeConfigDir: "/oc-config",
    opencodeDataDir: "/oc-data",
    controlDir: "/control",
    certsDir: "/certs",
    webDir: path.join(import.meta.dirname, "interface-absente"),
    opencodeUrl: "http://opencode:4096",
    opencodeUsername: "opencode",
    opencodePassword: crypto.randomBytes(18).toString("base64url"),
    tlsInsecure: false,
    projectConfig: false,
    githubEnterpriseDomain: null,
    allowedProviders: ["github-copilot"],
    copilotApiUrl: null,
    autonomy,
    // Montage en HTTP (1.0.5) : dossier TLS jamais créé ni lu.
    localScheme: "http",
    localHttpConfirmedAt: "2026-09-15T10:32:00Z",
    tlsDir: "/tls",
    opensslPath: "/usr/bin/openssl",
    version: "test",
    // 1.0.6 : aucun relais de sortie d'opencode dans ce montage.
    relay: null,
  };
}

const stub = <T>(): T => ({}) as T;

function setup(options: { autonomy?: boolean; classifierError?: Error } = {}) {
  const db = openMemoryDb();
  const settings = new SettingsStore(db);
  const warnings: Array<{ message: string; fields: Record<string, unknown> | undefined }> = [];
  const log: Logger = { ...createLogger("error"), warn: (message, fields) => void warnings.push({ message, fields }) };
  const classifier = { calls: 0 };
  const studio = {
    ensureClassifierAgent: async () => {
      classifier.calls++;
      if (options.classifierError) throw options.classifierError;
    },
  } as unknown as StudioService;
  const env = testEnv(options.autonomy ?? true);
  const hub = new EventHub();
  const deps: Cockpit11Deps = {
    env,
    log,
    db,
    client: stub(),
    hub,
    settings,
    sessions: stub(),
    ledger: stub(),
    archive: stub(),
    lookup: stub(),
    catalog: stub(),
    tiers: stub(),
    projects: stub(),
    control: stub(),
    configQueue: stub(),
    copilotConfig: stub(),
    studio,
    gate: stub(),
    occupancy: async () => "idle",
  };
  return { db, settings, warnings, classifier, deps };
}

/** createApp avec des dépendances minimales et les routes 1.1 rendues par le câblage. */
function mount(s: ReturnType<typeof setup>, routes: ReadonlyArray<(app: Hono) => void>) {
  const secret = crypto.randomBytes(32).toString("base64url");
  s.db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('session.secret', ?, ?)").run(secret, Date.now());
  const app = createApp({
    env: s.deps.env,
    log: s.deps.log,
    db: s.db,
    settings: s.settings,
    hub: s.deps.hub,
    studio: s.deps.studio,
    client: stub(),
    catalog: stub(),
    ledger: stub(),
    archive: stub(),
    classifier: stub(),
    projects: stub(),
    control: stub(),
    quota: stub(),
    processor: stub(),
    lookup: stub(),
    tiers: stub(),
    assistants: stub(),
    copilot: stub(),
    copilotConfig: stub(),
    routes: [...routes],
    // Montage en HTTP : aucun certificat.
    tls: null,
  });
  const host = "127.0.0.1:7777";
  const cookie = `${SESSION_COOKIE_NAME}=${sessionValue(TOKEN, secret)}`;
  const request = (method: string, pathname: string, headers: Record<string, string>, body?: string) =>
    app.request(pathname, { method, headers: { host, ...headers }, ...(body === undefined ? {} : { body }) });
  return {
    request,
    authed: { cookie },
    mutating: { cookie, "x-cockpit-csrf": "1", "content-type": "application/json", origin: `http://${host}` },
  };
}

const ROOT = "ses_racine";
const ctx = {} as ProxyContext;

/**
 * Ports neutres : comportement 1.0.4 (aucune action 1.1, codes « a-venir »). `livres` : ports dont le module réel est fusionné,
 * vérifiés par leurs propres tests (ils lisent des dépendances que setup() ne fournit pas).
 */
async function assertNeutralPorts(wiring: Cockpit11Wiring, s: ReturnType<typeof setup>, autonomy = true, livres: readonly PortName[] = []) {
  const p = wiring.c11.ports;
  if (!livres.includes("stopTree")) await assert.rejects(p.stopTree.run(ROOT, "vous"), PortUnavailableError);
  if (!livres.includes("taskGuard")) {
    assert.equal(await p.taskGuard.details(ROOT, "per_1"), null);
    await assert.rejects(p.taskGuard.collectDelegationFacts({ rootId: ROOT, sessionId: ROOT, permissionId: "per_1", directory: null }), PortUnavailableError);
  }
  assert.deepEqual(p.delegationWatch, {});
  if (!livres.includes("floors")) {
    assert.equal(await p.floors.verified(ROOT), false);
    await assert.rejects(p.floors.createWithFloor("CONVERSATION", { directory: "/workspace/app" }), PortUnavailableError);
  }
  if (!livres.includes("facts")) {
    p.facts.append([{ rootId: ROOT, sessionId: ROOT, kind: "statut", ref: null, data: { cause: "arret" }, at: 1 }]);
    assert.deepEqual(p.facts.since(ROOT, 0), { facts: [], partial: false });
    assert.equal(p.facts.work.markDelegation({ rootId: ROOT, parentSessionId: ROOT, callId: "call_1", agent: "explore" }, "travaille", null), false);
    assert.equal(p.facts.work.markWait({ permissionId: "per_1", sessionId: ROOT, rootId: ROOT, permission: "edit" }, "once", "vous"), false);
  }
  const caps = s.settings.get().budget.autonomie;
  const automatic = autonomy ? "a-venir" : "autonomie-coupee";
  if (!livres.includes("conversationAutonomy")) {
    assert.deepEqual(await p.conversationAutonomy.get(ROOT), {
      rootId: ROOT,
      choix: "demander",
      plafonds: {
        plafondUsd: caps.plafondUsd,
        actionsMax: caps.actionsMax,
        delegationsMax: caps.delegationsMax,
        dureeMinutes: caps.dureeMinutes,
        fichiersMax: caps.fichiersMax,
        controlesIaMax: caps.controlesIaMax,
      },
      depuis: null,
      retourCause: null,
      planSourceId: null,
      executionDePlanId: null,
      interrupteur: autonomy,
      disponibles: [
        { choix: "demander", disponible: true, raison: null },
        { choix: "modifications", disponible: false, raison: automatic },
        { choix: "plan", disponible: false, raison: "nouvelle-conversation" },
        { choix: "autonome", disponible: false, raison: automatic },
      ],
      demande: null,
    });
    assert.equal(p.conversationAutonomy.choiceOf(ROOT), "demander");
    assert.deepEqual(await p.conversationAutonomy.put(ROOT, { choix: "autonome" }, { confirmed: true }), {
      ok: false,
      status: 409,
      error: "autonomie-indisponible",
      raison: "a-venir",
    });
  }
  assert.deepEqual(p.plans, {});
  assert.equal(p.autonomy.examining(), false);
  assert.equal(p.requests.current(ROOT), null);
  assert.equal(p.requests.spent("req_1"), 0);
  assert.equal(p.requests.interrupt(ROOT, "interrompue"), undefined);
  // L10d, porte I1 basculée : module réel → la porte est ouverte, le relevé est tenté sur ce client factice et l'assistant
  // n'est pas jugé conforme (« regle-allow », contrôlé par autonomy-activation.test.ts) ; port neutre → « a-venir ».
  const activation = livres.includes("activation") ? "regle-allow" : "a-venir";
  assert.deepEqual(await p.activation.check({ rootId: ROOT, choix: "autonome", agent: "build", directory: "/workspace/app" }), { ok: false, raison: activation });
  // L10e : module réel → les faits de la délégation ne se lisent pas sur ce client factice, la demande attend sans qu'aucun refus
  // parte (X-illisible, contrôlé par autonomy-delegation.test.ts) ; port neutre → attente sans règle.
  const delegation = livres.includes("delegationPolicy") ? "X-illisible" : null;
  assert.deepEqual(await p.delegationPolicy.decide({ rootId: ROOT, sessionId: ROOT, permissionId: "per_1", directory: null, mode: "simple" }), {
    verdict: "attente",
    regle: delegation,
  });
  assert.deepEqual(p.capWatch, {});
  const judge = await p.controlAi.judge({ rootId: ROOT, sessionId: ROOT, requestId: null, command: "jq . a.json", head: "jq", relativeDir: ".", directory: null });
  // L11b : module réel → sans demande autonome, l'IA de contrôle n'est pas consultée (« desactive », aucun appel, contrôlé par
  // control-ai.test.ts) ; port neutre → « a-venir ».
  assert.deepEqual(judge, { decision: "indisponible", raison: livres.includes("controlAi") ? "desactive" : "a-venir" });
  // L1g : module réel installé → agent suivi, en attente du premier ensureAll ; port neutre → « non suivi ». L11b : le module réel
  // suit aussi cockpit-controle.
  const suivi = wiring.modules.includes("internalAgents") ? "en-attente" : "non-suivi";
  const controle = wiring.modules.includes("internalAgents") ? [{ nom: "cockpit-controle", etat: "en-attente", prochainEssai: null }] : [];
  assert.deepEqual(p.internalAgents.status(), [{ nom: "cockpit-classifier", etat: suivi, prochainEssai: null }, ...controle]);
  // L1f : module réel → le client factice ne répond à rien : relevés impossibles, dits par le bandeau « illisible » (train it1 V4) ;
  // port neutre → aucun bandeau.
  const illisible = wiring.modules.includes("diagnostics") ? [{ code: "illisible", noms: ["configuration", "arriere-plan", "agents"] }] : [];
  assert.deepEqual(await p.diagnostics.delegation(), illisible);
  assert.equal(wiring.c11.reloadBusy(), false);
  // Porte I1 basculée au train de la vague 3 (it2) : le cadre porte désormais true, y compris sans aucun module.
  assert.equal(wiring.c11.activationOuverte, true);
  // Porte de la salle : fausse dans le dépôt, sans aucun module comme avec tous.
  assert.equal(wiring.c11.salleOuverte, false);
  await assertOmoPortsNeutres(wiring, autonomy);
}

/** Ports de la salle (T3b) : salle coupée, aucun comportement, aucune écriture, aucune racine dans la salle. */
async function assertOmoPortsNeutres(wiring: Cockpit11Wiring, autonomy = true) {
  const p = wiring.c11.ports;
  assert.deepEqual(await p.omoRoom.open({ projet: "app" }, { mode: "avance", confirmed: true }), {
    ok: false,
    status: 403,
    code: "salle-coupee",
    precheck: null,
  });
  const statut = await p.omoRoom.status();
  assert.deepEqual(statut.interrupteurs, { omo: false, autonomie: autonomy, salleOuverte: false });
  assert.equal(statut.etatSalle, "coupee");
  assert.deepEqual(
    [statut.image.chargee, statut.dernierDemarrage, statut.workspaceGit, statut.authSalle.presente, statut.battement.actif, statut.battement.ageMs],
    [false, null, null, false, false, null],
  );
  assert.deepEqual([statut.listeBlanche, statut.projetsPrepares, statut.sortiesRefusees24h], [[], [], []]);
  assert.deepEqual(p.omoRoom.openProjects(), []);
  assert.equal(p.omoRoom.isRoomRoot(ROOT), false);
  assert.deepEqual(await p.omoPrecheck.check("app"), { ok: false, code: "salle-coupee" });
  assert.deepEqual(await p.omoPrecheck.beforeStart("dem_1"), { ok: false, startId: "dem_1", code: "salle-coupee", resultats: [] });
  assert.equal(await p.omoActivation.view(ROOT), null);
  assert.deepEqual(await p.omoActivation.put(ROOT, { choix: "omo", plafondUsd: "1.00" }, { mode: "avance", confirmed: true }), {
    ok: false,
    status: 409,
    code: "salle-coupee",
  });
  assert.deepEqual(await p.omoActivation.consume(ROOT), { ok: false, code: "salle-coupee" });
  assert.equal(p.omoActivation.activeRequest(), null);
  assert.equal(p.omoActivation.endRequest(ROOT, "interrompue"), undefined);
  await assert.rejects(p.omoStop.run(ROOT, "vous"), PortUnavailableError);
  assert.equal(await p.omoStop.relaunchAfterRequest(ROOT), undefined);
  assert.deepEqual([p.omoDetections, p.omoResponder, p.omoCaps], [{}, {}, {}]);
  // omoControl neutre (dossiers de la salle absents) : rien n'est lu, rien n'est écrit, l'état reste inconnu.
  assert.equal(await p.omoControl.readState(), null);
  assert.equal(p.omoControl.suspended(), false);
  assert.equal(await p.omoControl.publishAuth(), undefined);
  assert.equal(await p.omoControl.writeGuardState({ version: 1, at: 1, bloquer: ["task"] }), undefined);
}

/** Le couple (nature, clé, module) d'une inscription figure-t-il dans STEP_ORDER ? */
function coupleDansStepOrder(r: Registration): boolean {
  switch (r.kind) {
    case "hook":
      return ((STEP_ORDER.hooks as Record<string, readonly string[]>)[r.key] ?? []).includes(r.module);
    case "derivation":
      return (STEP_ORDER.derivations as readonly string[]).includes(r.module);
    case "hub":
      return STEP_ORDER.hub.some(([module, type]) => module === r.module && type === r.key);
    case "startup":
      return (STEP_ORDER.startup as readonly string[]).includes(r.module);
    case "routes":
      return STEP_ORDER.routes.some(([group, module]) => group === r.key && module === r.module);
  }
}

/**
 * Test « production » PAR PROPRIÉTÉ des modules de la salle (D-2b-40), vrai quel que soit le paquet qui aura rempli un port :
 * chaque inscription d'un module `omo*` porte `instances: ["omo"]` et son couple figure dans STEP_ORDER. SEULE EXCEPTION,
 * documentée dans omo-control-module.ts : l'inscription de démarrage d'omoControl tourne côté cockpit (retrait de l'auth.json
 * d'un processus précédent, puis lecture d'état), donc `["principale"]`. Un paquet qui inscrirait une dérivation de salle sans
 * le dire — elle irait alors au processeur du cockpit — fait tomber ce test.
 */
function assertInscriptionsSalle(wiring: Cockpit11Wiring) {
  for (const inscription of wiring.registrations.filter((r) => EST_MODULE_SALLE(r.module))) {
    const repere = `${inscription.kind} ${inscription.key} / ${inscription.module}`;
    const exception = inscription.module === "omoControl" && inscription.kind === "startup";
    assert.deepEqual(inscription.instances, exception ? ["principale"] : ["omo"], `${repere} : instances`);
    assert.ok(coupleDansStepOrder(inscription), `${repere} : couple absent de STEP_ORDER`);
  }
}

function assertNoRegistration(wiring: Cockpit11Wiring) {
  for (const step of Object.keys(wiring.hooks) as HookStep[]) assert.deepEqual(wiring.hooks[step], [], step);
  assert.deepEqual(wiring.derivations, []);
  assert.deepEqual(wiring.subscriptions, []);
  assert.deepEqual(wiring.startup, []);
}

describe("câblage 1.1 : ordre figé", () => {
  // Porte I1 : basculée à true au train de la vague 3 de l'itération 2 (plan §2.6), après vérification de ses conditions.
  // Tant qu'elle valait false, le port d'activation réel répondait comme le port neutre et n'inscrivait aucun crochet.
  it("porte I1 : ACTIVATION_OUVERTE vaut true depuis la bascule du train de la vague 3", () => {
    assert.equal(ACTIVATION_OUVERTE, true);
  });

  // Exactitude des commentaires après la bascule (défaut relevé par la répétition générale de l'itération 2) : plus aucune source
  // du serveur ne peut écrire que la constante « vaut » ou « reste » false. Les tournures conditionnelles, comme « tant
  // qu'ACTIVATION_OUVERTE est fausse », restent permises : elles décrivent la branche fermée, que la fabrique tient toujours.
  it("porte I1 : aucune source du serveur ne donne encore ACTIVATION_OUVERTE pour false", () => {
    const perime = /ACTIVATION_OUVERTE`?\s+(?:vaut|reste|restait|est passée? à)\s+`?(?:false|faux|fausse)/i;
    const fichiers = fs.readdirSync(import.meta.dirname, { encoding: "utf8", recursive: true }).filter((nom) => nom.endsWith(".ts"));
    assert.ok(fichiers.length > 100, `sources parcourues : ${fichiers.length}`);
    for (const nom of fichiers) {
      const trouve = perime.exec(fs.readFileSync(path.join(import.meta.dirname, nom), "utf8"))?.[0];
      assert.equal(trouve, undefined, `${nom} : « ${trouve ?? ""} », alors que la constante vaut true depuis la bascule de la vague 3`);
    }
  });

  it("MODULE_ORDER et STEP_ORDER : ordre du plan §4.4 pour le cockpit, du §4.1.2 pour la salle", () => {
    assert.deepEqual(MODULE_ORDER, [
      "pending", // gf5:d11 : table des attentes (D11), avant le portillon qui la lit
      "gate",
      "floors",
      "facts",
      "conversationAutonomy",
      "plans",
      "activation",
      "requests",
      "taskGuard",
      "delegationWatch",
      "stopTree",
      "autonomy",
      "delegationPolicy",
      "controlAi",
      "capWatch",
      "internalAgents",
      "diagnostics",
      ...OMO_MODULE_NAMES,
      // <c5:ordre>
      "methods",
      "secondReading",
      "chronologie",
      "teamCosts",
      // </c5:ordre>
    ]);
    assert.deepEqual(STEP_ORDER, {
      hooks: {
        createSession: ["floors"],
        sessionCreated: ["floors"],
        beforeBilledSend: ["secondReading", "floors", "plans", "activation", "requests", "omoActivation", "omoCaps"], // c5
        beforeOnceRelay: ["taskGuard"],
        abort: ["stopTree", "omoStop"],
      },
      // gf5:d11 : « pending » en tête des dérivations, et ses deux abonnements (coupure du flux de chaque instance) en tête du hub.
      derivations: ["pending", "gate", "omoDetections", "omoResponder", "facts", "taskGuard", "delegationWatch", "autonomy", "capWatch", "omoCaps"],
      hub: [
        ["pending", "opencode.connection"],
        ["pending", "omo.connection"],
        ["delegationWatch", "usage.updated"],
        ["autonomy", "opencode.connection"],
        ["capWatch", "usage.updated"],
        ["omoCaps", "usage.updated"],
        ["omoDetections", "usage.updated"],
      ],
      startup: ["conversationAutonomy", "internalAgents", "capWatch", "omoControl", "omoStop", "omoRoom", "omoPrecheck"],
      routes: [
        ["conversations", "stopTree"],
        ["delegations", "taskGuard"],
        ["activity", "facts"],
        ["autonomy", "conversationAutonomy"],
        ["plans", "plans"],
        ["diagnostic-11", "diagnostics"],
        // <c5:routes>
        ["construction", "methods"],
        ["construction", "secondReading"],
        ["construction", "chronologie"],
        ["construction", "teamCosts"],
        // </c5:routes>
        ["omo", "omoRoom"],
      ],
    });
  });

  // Une seule table pour les deux instances : chaque ordre doit y rester une SOUS-SUITE, sinon un module verrait ses voisins
  // dans le désordre à l'exécution. L'ordre de la salle est celui que T3a a proposé (OMO_ORDRE_PROPOSE, plan §4.1.2).
  it("STEP_ORDER : l'ordre de la salle (§4.1.2) et celui du cockpit (§4.4) y sont des sous-suites", () => {
    const sousSuite = (attendu: readonly string[], table: readonly string[], quoi: string) => {
      let index = -1;
      for (const nom of attendu) {
        const trouve = table.indexOf(nom, index + 1);
        assert.ok(trouve > index, `${quoi} : « ${nom} » absent ou hors de l'ordre dans STEP_ORDER`);
        index = trouve;
      }
    };
    for (const step of Object.keys(STEP_ORDER.hooks) as HookStep[]) {
      sousSuite(OMO_ORDRE_PROPOSE.hooks[step], STEP_ORDER.hooks[step], `salle ${step}`);
      sousSuite(
        STEP_ORDER.hooks[step].filter((name) => !EST_MODULE_SALLE(name)),
        STEP_ORDER.hooks[step],
        `cockpit ${step}`,
      );
    }
    sousSuite(OMO_ORDRE_PROPOSE.derivations, STEP_ORDER.derivations, "salle dérivations");
    sousSuite(OMO_ORDRE_PROPOSE.startup, STEP_ORDER.startup, "salle démarrage");
    const couple = (entries: ReadonlyArray<readonly [string, string]>) => entries.map(([a, b]) => `${a}/${b}`);
    sousSuite(couple(OMO_ORDRE_PROPOSE.hub), couple(STEP_ORDER.hub), "salle hub");
    sousSuite(couple(OMO_ORDRE_PROPOSE.routes), couple(STEP_ORDER.routes), "salle routes");
    // Le groupe de routes de la salle est monté en dernier (spécification §7.1 : les routes existantes d'abord).
    assert.deepEqual(STEP_ORDER.routes.at(-1), ["omo", "omoRoom"]);
  });

  it("MODULES et NEUTRAL_PORTS : un module réel par nom, un port neutre par module sauf gate", () => {
    assert.deepEqual(Object.keys(MODULES), [...MODULE_ORDER]);
    for (const name of MODULE_ORDER) assert.equal(MODULES[name].name, name);
    // <c5:ports>
    // La construction n'ajoute aucun port (D-5-04) : ses modules n'ont pas de port neutre, comme « gate ».
    const SANS_PORT: readonly ModuleName[] = ["gate", "pending", ...CONSTRUCTION_MODULE_ORDER]; // gf5:d11 : « pending » sans port, comme « gate »
    assert.deepEqual(Object.keys(NEUTRAL_PORTS).sort(), MODULE_ORDER.filter((name) => !SANS_PORT.includes(name)).sort());
    // </c5:ports>
  });

  it("modules factices : crochets, dérivations, abonnements, démarrage et routes rangés par STEP_ORDER", async () => {
    const s = setup();
    const trace: string[] = [];
    const hook = (name: ModuleName) => async () => {
      trace.push(name);
      return null;
    };
    const derivation = (name: ModuleName) => ({ name, onEvent: () => void trace.push(name) });
    const factices: Cockpit11Module[] = [
      // gf5:d11 : table des attentes, dérivation en tête et coupure du flux de l'instance principale.
      {
        name: "pending",
        install: (reg) => {
          reg.derivation(derivation("pending"));
          reg.hub("opencode.connection", () => void trace.push("pending:opencode.connection"));
        },
      },
      { name: "gate", install: (reg) => reg.derivation(derivation("gate")) },
      {
        name: "floors",
        install: (reg) => {
          reg.hook("beforeBilledSend", hook("floors"));
          reg.hook("sessionCreated", hook("floors"));
          reg.hook("createSession", hook("floors"));
        },
      },
      {
        name: "facts",
        install: (reg) => {
          reg.routes("activity", () => void trace.push("activity"));
          reg.derivation(derivation("facts"));
        },
      },
      {
        name: "conversationAutonomy",
        install: (reg) => {
          reg.routes("autonomy", () => void trace.push("autonomy"));
          reg.startup(async () => void trace.push("conversationAutonomy"));
        },
      },
      {
        name: "plans",
        install: (reg) => {
          reg.routes("plans", () => void trace.push("plans"));
          reg.hook("beforeBilledSend", hook("plans"));
        },
      },
      { name: "activation", install: (reg) => reg.hook("beforeBilledSend", hook("activation")) },
      { name: "requests", install: (reg) => reg.hook("beforeBilledSend", hook("requests")) },
      {
        name: "taskGuard",
        install: (reg) => {
          reg.routes("delegations", () => void trace.push("delegations"));
          reg.derivation(derivation("taskGuard"));
          reg.hook("beforeOnceRelay", hook("taskGuard"));
        },
      },
      {
        name: "delegationWatch",
        install: (reg) => {
          reg.hub("usage.updated", () => void trace.push("delegationWatch:usage.updated"));
          reg.derivation(derivation("delegationWatch"));
        },
      },
      {
        name: "stopTree",
        install: (reg) => {
          reg.routes("conversations", () => void trace.push("conversations"));
          reg.hook("abort", hook("stopTree"));
        },
      },
      {
        name: "autonomy",
        install: (reg) => {
          reg.hub("opencode.connection", () => void trace.push("autonomy:opencode.connection"));
          reg.derivation(derivation("autonomy"));
        },
      },
      { name: "delegationPolicy", install: () => undefined },
      { name: "controlAi", install: () => undefined },
      {
        name: "capWatch",
        install: (reg) => {
          reg.startup(async () => void trace.push("capWatch"));
          reg.hub("usage.updated", () => void trace.push("capWatch:usage.updated"));
          reg.derivation(derivation("capWatch"));
        },
      },
      { name: "internalAgents", install: (reg) => reg.startup(async () => void trace.push("internalAgents")) },
      { name: "diagnostics", install: (reg) => reg.routes("diagnostic-11", () => void trace.push("diagnostic-11")) },
      // <c5:factices>
      // Squelettes de la construction (T5a) : déclarés pour que wiring.modules couvre MODULE_ORDER ; ils n'inscrivent rien tant
      // que L44b, L44c, L47b et L46a ne sont pas livrés. Leurs inscriptions arrivent ici au train de la vague qui les apporte.
      { name: "methods", install: () => undefined },
      { name: "secondReading", install: () => undefined },
      { name: "chronologie", install: () => undefined },
      { name: "teamCosts", install: () => undefined },
      // </c5:factices>
    ];
    const wiring = buildCockpit11(s.deps, { modules: [...factices].reverse() });
    // Modules du cockpit seuls : ceux de la salle ont leur propre test d'ordre (§4.1.2), plus bas.
    assert.deepEqual(wiring.modules, MODULES_COCKPIT);

    const run = async (fn: () => Promise<unknown> | unknown) => {
      trace.length = 0;
      await fn();
      return [...trace];
    };
    assert.deepEqual(await run(() => wiring.runHooks("createSession", ctx)), ["floors"]);
    assert.deepEqual(await run(() => wiring.runHooks("sessionCreated", ctx, {})), ["floors"]);
    assert.deepEqual(await run(() => wiring.runHooks("beforeBilledSend", ctx)), ["floors", "plans", "activation", "requests"]);
    assert.deepEqual(await run(() => wiring.runHooks("beforeOnceRelay", ctx, "per_1")), ["taskGuard"]);
    assert.deepEqual(await run(() => wiring.runHooks("abort", ctx, ROOT)), ["stopTree"]);
    const event = { payload: { type: "permission.replied", properties: {} } };
    assert.deepEqual(await run(() => wiring.derivations.forEach((d) => d.onEvent(event))), ["pending", "gate", "facts", "taskGuard", "delegationWatch", "autonomy", "capWatch"]);
    assert.deepEqual(
      await run(() => wiring.subscriptions.forEach((sub) => (sub.fn as (data: unknown) => void)({}))),
      ["pending:opencode.connection", "delegationWatch:usage.updated", "autonomy:opencode.connection", "capWatch:usage.updated"],
    );
    assert.deepEqual(wiring.subscriptions.map((sub) => sub.type), ["opencode.connection", "usage.updated", "opencode.connection", "usage.updated"]);
    assert.deepEqual(
      await run(async () => {
        for (const start of wiring.startup) await start();
      }),
      ["conversationAutonomy", "internalAgents", "capWatch"],
    );
    assert.deepEqual(
      await run(() => wiring.routes.forEach((register) => register(stub<Hono>()))),
      ["conversations", "delegations", "activity", "autonomy", "plans", "diagnostic-11"],
    );
    assert.deepEqual(
      wiring.registrations.filter((r) => r.kind === "hook").map((r) => `${r.key}/${r.module}`),
      [
        "createSession/floors",
        "sessionCreated/floors",
        "beforeBilledSend/floors",
        "beforeBilledSend/plans",
        "beforeBilledSend/activation",
        "beforeBilledSend/requests",
        "beforeOnceRelay/taskGuard",
        "abort/stopTree",
      ],
    );
  });

  it("couple absent de STEP_ORDER : le câblage échoue", () => {
    const s = setup();
    const refused: Cockpit11Module[] = [
      { name: "plans", install: (reg) => reg.hook("abort", async () => null) },
      { name: "floors", install: (reg) => reg.hook("beforeOnceRelay", async () => null) },
      { name: "floors", install: (reg) => reg.hook("etape-inconnue" as HookStep, async () => null) },
      { name: "floors", install: (reg) => reg.derivation({ name: "floors", onEvent: () => undefined }) },
      { name: "autonomy", install: (reg) => reg.hub("usage.updated", () => undefined) },
      { name: "facts", install: (reg) => reg.startup(async () => undefined) },
      { name: "plans", install: (reg) => reg.routes("activity", () => undefined) },
    ];
    for (const module of refused) {
      assert.throws(() => buildCockpit11(s.deps, { modules: [module] }), /couple non prévu dans STEP_ORDER/, String(module.install));
    }
  });

  it("module inconnu, déclaré deux fois ou inscription hors installation : le câblage échoue", () => {
    const s = setup();
    assert.throws(() => buildCockpit11(s.deps, { modules: ["equipes" as ModuleName] }), /module inconnu \(equipes\)/);
    assert.throws(() => buildCockpit11(s.deps, { modules: [{ name: "equipes" as ModuleName, install: () => undefined }] }), /module inconnu/);
    assert.throws(() => buildCockpit11(s.deps, { modules: ["floors", { name: "floors", install: () => undefined }] }), /déclaré deux fois \(floors\)/);
    let kept: Registrar | null = null;
    buildCockpit11(s.deps, {
      modules: [
        {
          name: "capWatch",
          install: (reg) => {
            kept = reg;
          },
        },
      ],
    });
    assert.throws(() => (kept as Registrar | null)?.startup(async () => undefined), /hors de l'installation/);
  });

  // Ordre du §4.1.2 avec des modules factices qui inscrivent TOUS les couples proposés par T3a : les inscriptions qui servent la
  // salle doivent rendre exactement OMO_ORDRE_PROPOSE, dans son ordre, alors que la table STEP_ORDER est commune aux deux
  // instances. Les paquets L18c à L23c n'auront donc pas à toucher ce fichier pour être rangés.
  it("ordre du §4.1.2 : les inscriptions de la salle suivent OMO_ORDRE_PROPOSE", () => {
    const s = setup();
    const salle = { instances: ["omo"] } as const;
    const inscriptions = new Map<ModuleName, Array<(reg: Registrar) => void>>();
    const ajoute = (name: ModuleName, fn: (reg: Registrar) => void) => inscriptions.set(name, [...(inscriptions.get(name) ?? []), fn]);
    for (const step of Object.keys(OMO_ORDRE_PROPOSE.hooks) as HookStep[]) {
      for (const name of OMO_ORDRE_PROPOSE.hooks[step]) ajoute(name, (reg) => reg.hook(step, async () => null, salle));
    }
    for (const name of OMO_ORDRE_PROPOSE.derivations) ajoute(name, (reg) => reg.derivation({ name, instances: ["omo"], onEvent: () => undefined }));
    for (const [name, type] of OMO_ORDRE_PROPOSE.hub) ajoute(name, (reg) => reg.hub(type, () => undefined, salle));
    for (const name of OMO_ORDRE_PROPOSE.startup) ajoute(name, (reg) => reg.startup(async () => undefined, salle));
    for (const [group, name] of OMO_ORDRE_PROPOSE.routes) ajoute(name, (reg) => reg.routes(group, () => undefined, salle));

    const wiring = buildCockpit11(s.deps, {
      modules: [...inscriptions].map(([name, liste]) => ({
        name,
        install: (reg: Registrar) => {
          for (const fn of liste) fn(reg);
        },
      })),
    });
    const salleInscriptions = wiring.registrations.filter((r) => servesInstance(r, "omo"));
    const modulesDe = (kind: Registration["kind"], key?: string) =>
      salleInscriptions.filter((r) => r.kind === kind && (key === undefined || r.key === key)).map((r) => r.module);
    for (const step of Object.keys(OMO_ORDRE_PROPOSE.hooks) as HookStep[]) {
      assert.deepEqual(modulesDe("hook", step), [...OMO_ORDRE_PROPOSE.hooks[step]], step);
    }
    assert.deepEqual(modulesDe("derivation"), [...OMO_ORDRE_PROPOSE.derivations]);
    assert.deepEqual(modulesDe("startup"), [...OMO_ORDRE_PROPOSE.startup]);
    assert.deepEqual(
      salleInscriptions.filter((r) => r.kind === "hub").map((r) => [r.module, r.key]),
      OMO_ORDRE_PROPOSE.hub.map(([name, type]) => [name, type]),
    );
    assert.deepEqual(
      salleInscriptions.filter((r) => r.kind === "routes").map((r) => [r.key, r.module]),
      OMO_ORDRE_PROPOSE.routes.map(([group, name]) => [group, name]),
    );
    // Aucune de ces inscriptions ne touche l'instance principale.
    assert.deepEqual(
      wiring.registrations.filter((r) => servesInstance(r, "principale")),
      [],
    );
  });

  it("couple de la salle absent de STEP_ORDER : le câblage échoue", () => {
    const s = setup();
    const salle = { instances: ["omo"] } as const;
    const refuses: Cockpit11Module[] = [
      { name: "omoRoom", install: (reg) => reg.hook("abort", async () => null, salle) },
      { name: "omoStop", install: (reg) => reg.routes("omo", () => undefined, salle) },
      { name: "omoDetections", install: (reg) => reg.hub("opencode.connection", () => undefined, salle) },
      { name: "omoCaps", install: (reg) => reg.startup(async () => undefined, salle) },
      { name: "omoActivation", install: (reg) => reg.derivation({ name: "omoActivation", instances: ["omo"], onEvent: () => undefined }) },
    ];
    for (const module of refuses) {
      assert.throws(() => buildCockpit11(s.deps, { modules: [module] }), /couple non prévu dans STEP_ORDER/, module.name);
    }
  });

  // Filtre par défaut (plan 2 bis §4.2) : une inscription qui ne déclare rien ne sert que l'instance principale, et garde sa
  // forme exacte (champ `instances` ABSENT) ; les listes exhaustives des tests de croisement restent donc comparables.
  it("filtre par instance : sans « instances », un crochet ne sert que le cockpit ; avec [\"omo\"], il ne sert que la salle", async () => {
    const s = setup();
    const trace: string[] = [];
    const wiring = buildCockpit11(s.deps, {
      modules: [
        {
          name: "plans",
          install: (reg) =>
            reg.hook("beforeBilledSend", async () => {
              trace.push("plans");
              return null;
            }),
        },
        {
          name: "omoCaps",
          install: (reg) =>
            reg.hook(
              "beforeBilledSend",
              async () => {
                trace.push("omoCaps");
                return null;
              },
              { instances: ["omo"] },
            ),
        },
      ],
    });
    assert.deepEqual(wiring.registrations, [
      { kind: "hook", key: "beforeBilledSend", module: "plans" },
      { kind: "hook", key: "beforeBilledSend", module: "omoCaps", instances: ["omo"] },
    ]);
    assert.equal(wiring.hooks.beforeBilledSend.length, 2, "les deux crochets sont câblés ; c'est runHooks qui trie");
    const appels = async (instance?: SessionInstance) => {
      trace.length = 0;
      await wiring.runHooks("beforeBilledSend", (instance === undefined ? {} : { instance }) as ProxyContext);
      return [...trace];
    };
    // Contexte sans instance : proxy 1.0.x de http.ts, donc instance principale.
    assert.deepEqual(await appels(), ["plans"]);
    assert.deepEqual(await appels("principale"), ["plans"]);
    assert.deepEqual(await appels("omo"), ["omoCaps"]);
  });
});

describe("câblage 1.1 : ports neutres", () => {
  it("modules: [] : aucun crochet, dérivation, abonnement, démarrage ni route ; ports neutres", async () => {
    const s = setup();
    const wiring = buildCockpit11(s.deps, { modules: [] });
    assert.deepEqual(wiring.modules, []);
    assert.deepEqual(wiring.registrations, []);
    assertNoRegistration(wiring);
    assert.deepEqual(wiring.routes, []);
    assert.equal(await wiring.runHooks("abort", ctx, ROOT), null);
    await assertNeutralPorts(wiring, s);
    const off = setup({ autonomy: false });
    await assertNeutralPorts(buildCockpit11(off.deps, { modules: [] }), off, false);
  });

  it("production (tous les modules réels) : modules livrés en V2 inscrits (L1c stopTree, L3 plancher, L6a choix d'autonomie, L4b faits), garde du « task once » (L1d), surveillance des délégations (L1e), plans (L6b), demandes et cycle d'autonomie (L10a), plafonds et redémarrages (L10c), délégation en Autonome (L10e), route du Diagnostic ; squelettes T0 restants neutres", async () => {
    const s = setup();
    const wiring = buildCockpit11(s.deps);
    assert.deepEqual(wiring.modules, [...MODULE_ORDER]);
    // Liste EXACTE pour les modules de l'itération 1 et de l'itération 2 (aucune inscription en trop, aucune en moins) ; les
    // modules de la salle sont contrôlés juste après, par propriété (D-2b-40).
    assert.deepEqual(
      wiring.registrations.filter((r) => !EST_MODULE_SALLE(r.module)),
      [
      { kind: "hook", key: "createSession", module: "floors" },
      { kind: "hook", key: "sessionCreated", module: "floors" },
      // <c5:production>
      // Seconde lecture (L44c) : PREMIER crochet de beforeBilledSend, donc avant le plancher et les plans. Il ne refuse jamais
      // et ne fait qu'un UPDATE ; en queue, un refus antérieur le sautait (corrections de la relecture de la vague 3).
      { kind: "hook", key: "beforeBilledSend", module: "secondReading" },
      // </c5:production>
      { kind: "hook", key: "beforeBilledSend", module: "floors" },
      { kind: "hook", key: "beforeBilledSend", module: "plans" },
      // L10d : porte I1 basculée au train de la vague 3 (it2) → le crochet d'activation s'inscrit, entre « plans » et « requests ».
      { kind: "hook", key: "beforeBilledSend", module: "activation" },
      // L10a : la demande autonome s'ouvre à l'envoi, après l'activation (rang « requests » de STEP_ORDER).
      { kind: "hook", key: "beforeBilledSend", module: "requests" },
      { kind: "hook", key: "beforeOnceRelay", module: "taskGuard" },
      { kind: "hook", key: "abort", module: "stopTree" },
      { kind: "derivation", key: "facts", module: "facts" },
      { kind: "derivation", key: "taskGuard", module: "taskGuard" },
      // L1e : surveillance des délégations lancées sans demande (dérivation et abonnement usage.updated), port toujours vide.
      { kind: "derivation", key: "delegationWatch", module: "delegationWatch" },
      // L10a : cycle d'une décision (dérivation permission.asked) et relecture de GET /permission à la reconnexion d'opencode.
      { kind: "derivation", key: "autonomy", module: "autonomy" },
      // L10c : plafonds, « Passé sans contrôle » et redémarrages d'opencode (dérivation, abonnement usage.updated, reprise).
      { kind: "derivation", key: "capWatch", module: "capWatch" },
      { kind: "hub", key: "usage.updated", module: "delegationWatch" },
      { kind: "hub", key: "opencode.connection", module: "autonomy" },
      { kind: "hub", key: "usage.updated", module: "capWatch" },
      { kind: "startup", key: "startup", module: "conversationAutonomy" },
      { kind: "startup", key: "startup", module: "capWatch" },
      { kind: "routes", key: "conversations", module: "stopTree" },
      { kind: "routes", key: "delegations", module: "taskGuard" },
      { kind: "routes", key: "activity", module: "facts" },
      { kind: "routes", key: "autonomy", module: "conversationAutonomy" },
      { kind: "routes", key: "plans", module: "plans" },
      { kind: "routes", key: "diagnostic-11", module: "diagnostics" },
      // <c5:production>
      // Construction (itération 5), en fin de MODULE_ORDER et de STEP_ORDER.routes : L44c inscrit le crochet de la Seconde
      // lecture, PREMIER de beforeBilledSend, et sa route ; L44b et L46a montent les leurs dans le groupe
      // « construction ». Le module `chronologie` monte la sienne depuis L47b (train de V2).
      { kind: "routes", key: "construction", module: "methods" },
      { kind: "routes", key: "construction", module: "secondReading" },
      { kind: "routes", key: "construction", module: "chronologie" },
      { kind: "routes", key: "construction", module: "teamCosts" },
      // </c5:production>
      ],
    );
    // PROPRIÉTÉ des inscriptions de la salle (D-2b-40) : chacune sert l'instance « omo » et son couple figure dans STEP_ORDER.
    // Seule exception, documentée dans omo-control-module.ts : le démarrage d'omoControl tourne côté cockpit (retrait d'un
    // auth.json laissé par un processus précédent, puis lecture d'état), donc `["principale"]`. Aucun paquet n'a donc à
    // modifier ce fichier pour remplacer un squelette de la salle.
    assertInscriptionsSalle(wiring);
    // Dans le dépôt, la salle n'inscrit QUE son groupe de routes (403 salle-coupee) : les dossiers de contrôle sont absents, donc
    // omoControl reste neutre et n'inscrit rien ; les autres modules sont des squelettes.
    assert.deepEqual(
      wiring.registrations.filter((r) => EST_MODULE_SALLE(r.module)),
      [{ kind: "routes", key: "omo", module: "omoRoom", instances: ["omo"] }],
    );
    assert.deepEqual(
      [
        wiring.hooks.createSession.length,
        wiring.hooks.sessionCreated.length,
        wiring.hooks.beforeBilledSend.length,
        wiring.hooks.beforeOnceRelay.length,
        wiring.hooks.abort.length,
      ],
      // <c5:production>
      // beforeBilledSend passe de 4 à 5 : Seconde lecture (L44c) en tête, puis plancher, plans, activation et demandes.
      [1, 1, 5, 1, 1],
      // </c5:production>
    );
    assert.deepEqual(wiring.subscriptions.map((sub) => sub.type), ["usage.updated", "opencode.connection", "usage.updated"]);
    assert.equal(wiring.derivations.length, 5);
    assert.equal(wiring.startup.length, 2);
    // <c5:production>
    // 7 groupes (les six du cockpit, puis « omo »), plus les quatre inscriptions du groupe « construction » (L44b, L44c, L47b,
    // L46a), montées juste avant « omo », qui reste le dernier.
    assert.equal(wiring.routes.length, 11);
    // </c5:production>
    // Ports réels de L6a (le neutre répondrait 409) et de L4b (le neutre n'écrit rien) ; leur comportement est contrôlé par
    // conversation-autonomy.test.ts et fact-store.test.ts. Un choix inconnu reste invalide quelle que soit la salle ; la réponse
    // à « omo » (409 « autonomie-indisponible », raison « racine-hors-salle ») est contrôlée par conversation-autonomy.test.ts (L22c).
    assert.deepEqual(await wiring.c11.ports.conversationAutonomy.put(ROOT, { choix: "inconnu" } as never, { confirmed: true }), {
      ok: false,
      status: 400,
      error: "invalid",
      raison: null,
    });
    wiring.c11.ports.facts.append([{ rootId: ROOT, sessionId: ROOT, kind: "statut", ref: null, data: { etat: "occupee" }, at: 1 }]);
    assert.equal(wiring.c11.ports.facts.since(ROOT, 0).facts.length, 1);
    // L11b et L10e : ports réels de l'IA de contrôle et de la délégation en Autonome (aucune inscription).
    // L10d : porte I1 basculée au train de la vague 3 (it2), le port d'activation réel n'est donc plus inerte.
    await assertNeutralPorts(wiring, s, true, ["stopTree", "floors", "conversationAutonomy", "facts", "taskGuard", "controlAi", "delegationPolicy", "activation"]);
  });

  it("surcharge de ports : l'emporte sur le module installé ; reloadBusy suit ports.autonomy.examining", async () => {
    const s = setup();
    const activationOk: Cockpit11Module = {
      name: "activation",
      install: (_reg, c11) => {
        c11.ports.activation = { check: async () => ({ ok: true }) };
      },
    };
    const installed = buildCockpit11(s.deps, { modules: [activationOk] });
    assert.deepEqual(await installed.c11.ports.activation.check({ rootId: ROOT, choix: "modifications", agent: null, directory: null }), { ok: true });
    const overridden = buildCockpit11(s.deps, {
      modules: [activationOk],
      ports: { activation: { check: async () => ({ ok: false, raison: "regle-allow" }) } },
    });
    assert.deepEqual(await overridden.c11.ports.activation.check({ rootId: ROOT, choix: "modifications", agent: null, directory: null }), {
      ok: false,
      raison: "regle-allow",
    });

    let examining = false;
    const autonomy: Cockpit11Module = {
      name: "autonomy",
      install: (_reg, c11) => {
        c11.ports.autonomy = { examining: () => examining };
      },
    };
    const byModule = buildCockpit11(s.deps, { modules: [autonomy] });
    assert.equal(byModule.c11.reloadBusy(), false);
    examining = true;
    assert.equal(byModule.c11.reloadBusy(), true);
    assert.equal(buildCockpit11(s.deps, { modules: [], ports: { autonomy: { examining: () => true } } }).c11.reloadBusy(), true);
  });

  it("runHooks : la première Response l'emporte, les crochets suivants ne sont pas appelés ; null continue", async () => {
    const s = setup();
    const trace: string[] = [];
    let plansAnswer: Response | null = new Response(null, { status: 409 });
    const module = (name: ModuleName, answer: () => Response | null): Cockpit11Module => ({
      name,
      install: (reg) =>
        reg.hook("beforeBilledSend", async () => {
          trace.push(name);
          return answer();
        }),
    });
    const wiring = buildCockpit11(s.deps, {
      modules: [module("requests", () => null), module("activation", () => null), module("plans", () => plansAnswer), module("floors", () => null)],
    });
    assert.equal((await wiring.runHooks("beforeBilledSend", ctx))?.status, 409);
    assert.deepEqual(trace, ["floors", "plans"]);
    trace.length = 0;
    plansAnswer = null;
    assert.equal(await wiring.runHooks("beforeBilledSend", ctx), null);
    assert.deepEqual(trace, ["floors", "plans", "activation", "requests"]);
  });

  it("internalAgents neutre : agent de classement installé, erreur journalisée comme au démarrage de la 1.0.4", async () => {
    const ok = setup();
    await buildCockpit11(ok.deps, { modules: [] }).c11.ports.internalAgents.ensureAll();
    assert.equal(ok.classifier.calls, 1);
    assert.deepEqual(ok.warnings, []);
    const failing = setup({ classifierError: new Error("écriture refusée") });
    assert.equal(await buildCockpit11(failing.deps, { modules: [] }).c11.ports.internalAgents.ensureAll(), undefined);
    assert.equal(failing.classifier.calls, 1);
    assert.deepEqual(failing.warnings, [{ message: "agent de classement non installé", fields: { error: "écriture refusée" } }]);
  });
});

describe("câblage 1.1 : routes et cadre", () => {
  it("GET /api/diagnostic/activite : montée par le module diagnostics, lit les ports ; absente sans lui", async () => {
    const s = setup();
    const { request, authed } = mount(s, buildCockpit11(s.deps).routes);
    const res = await request("GET", "/api/diagnostic/activite", authed);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      // L1f : client factice sans réponse → relevés impossibles, bandeau « illisible » (train it1 V4).
      delegation: [{ code: "illisible", noms: ["configuration", "arriere-plan", "agents"] }],
      // L1g : module réel des agents internes, aucun ensureAll encore ; L11b : cockpit-controle suivi aussi.
      agentsInternes: [
        { nom: "cockpit-classifier", etat: "en-attente", prochainEssai: null },
        { nom: "cockpit-controle", etat: "en-attente", prochainEssai: null },
      ],
      interrupteur: true,
      controleIa: s.settings.get().budget.autonomie.controleIa,
      // Porte I1 basculée au train de la vague 3 (it2) : le Diagnostic la dit ouverte.
      activationOuverte: true,
    });
    assert.equal((await request("GET", "/api/diagnostic/activite", {})).status, 401);
    const bare = setup();
    const withoutModule = mount(bare, buildCockpit11(bare.deps, { modules: [] }).routes);
    assert.equal((await withoutModule.request("GET", "/api/diagnostic/activite", withoutModule.authed)).status, 404);
  });

  it("salle coupée (D-10, §2.7) : toute route /api/omo/* → 403 salle-coupee ; si le service opencode-omo existe : profiles [omo] et pull_policy never", async () => {
    const s = setup();
    const { request, authed, mutating } = mount(s, buildCockpit11(s.deps).routes);
    const body = JSON.stringify({ projet: "/workspace/app" });
    const attendRefus = async (res: Response, quoi: string) => {
      assert.equal(res.status, 403, quoi);
      assert.deepEqual(await res.json(), { error: "salle-coupee", message: phraseRefusActivation("salle-coupee") }, quoi);
    };
    // Ouverture d'une salle, avec cookie, en-tête anti-CSRF ET confirmation : rien n'ouvre la salle, pas même une demande complète.
    await attendRefus(await request("POST", "/api/omo/rooms", { ...mutating, "x-cockpit-confirm": "1" }, body), "POST /api/omo/rooms");
    await attendRefus(await request("POST", `/api/omo/rooms/${ROOT}/stop`, { ...mutating, "x-cockpit-confirm": "1" }), "arrêt d'une salle");
    await attendRefus(await request("GET", "/api/omo/status", authed), "GET /api/omo/status");
    // Même une route inconnue de la salle : la garde couvre tout /api/omo/*, avant tout port.
    await attendRefus(await request("GET", "/api/omo/inconnue", authed), "route inconnue de la salle");
    // Les en-têtes passent bien la garde anti-CSRF : sans eux, refus avant la route (403 « csrf », pas « salle-coupee »).
    const { "x-cockpit-csrf": _csrf, ...withoutCsrf } = mutating;
    const sansCsrf = await request("POST", "/api/omo/rooms", withoutCsrf, body);
    assert.equal(sansCsrf.status, 403);
    assert.notEqual(((await sansCsrf.json()) as { error: string }).error, "salle-coupee");
    // Sans le module de la salle, aucune route /api/omo/* n'est montée : le 404 de /api/* reprend la main.
    const bare = setup();
    const sansSalle = mount(bare, buildCockpit11(bare.deps, { modules: [] }).routes);
    assert.equal((await sansSalle.request("GET", "/api/omo/status", sansSalle.authed)).status, 404);

    const composeText = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "docker-compose.yml"), "utf8");
    const compose = parseYaml(composeText) as { services: Record<string, unknown> };
    assert.ok(Object.keys(compose.services).includes("cockpit"));
    // Indépendant de l'état de la salle (L16b l'ajoutera) : tant que le service n'existe pas, rien n'est exigé ; dès qu'il existe,
    // il reste derrière son profil et ne tire jamais d'image (spécification P13, « pull_policy: never »).
    const omo = compose.services["opencode-omo"] as { profiles?: unknown; pull_policy?: unknown } | undefined;
    if (omo !== undefined) {
      assert.deepEqual(omo.profiles, ["omo"]);
      assert.equal(omo.pull_policy, "never");
    }
  });

  // Porte de la salle (plan 2 bis §2.7, risque n° 16) : basculée par erreur, elle ouvrirait tout. Deux gardes : la valeur lue
  // par le cadre, et le TEXTE du dépôt — un banc qui bascule la constante dans sa copie jetable fait tomber ce test, c'est
  // exactement ce qu'on veut : la bascule ne doit jamais être commitée.
  it("SALLE_OUVERTE : fausse, et le dépôt porte bien « export const SALLE_OUVERTE = false; »", () => {
    assert.equal(SALLE_OUVERTE, false);
    const source = fs.readFileSync(path.join(import.meta.dirname, "wiring-11.ts"), "utf8");
    assert.match(source, /^export const SALLE_OUVERTE = false;$/m);
    assert.doesNotMatch(source, /^export const SALLE_OUVERTE = true;$/m);
    // Aucune variable d'environnement n'ouvre la salle (§2.7) : la constante est la seule porte, et ni le câblage ni le module
    // de contrôle ne lisent process.env.
    for (const fichier of ["wiring-11.ts", "omo-control-module.ts", "routes-omo.ts", "omo-room.ts"]) {
      assert.doesNotMatch(fs.readFileSync(path.join(import.meta.dirname, fichier), "utf8"), /process\.env/, fichier);
    }
  });

  // Service réel de L17b branché (omo-control-module.ts) mais INERTE : avec les dossiers de la salle, aucun fichier n'est créé.
  it("salle coupée : le service de contrôle réel n'écrit rien dans les volumes de la salle, et son démarrage retire l'auth.json d'avant", async () => {
    const racine = fs.mkdtempSync(path.join(os.tmpdir(), "wiring-omo-"));
    const dossier = (nom: string) => {
      const chemin = path.join(racine, nom);
      fs.mkdirSync(chemin, { recursive: true });
      return chemin;
    };
    const dirs = { controlDir: dossier("control"), stateDir: dossier("state"), authDir: dossier("auth"), opencodeDataDir: dossier("oc-data") };
    const s = setup();
    // Le dossier de données du cockpit sert à la suspension (D-2b-29), hors des volumes de la salle.
    const deps: Cockpit11Deps = { ...s.deps, env: { ...s.deps.env, dataDir: dossier("data") }, omoControlDirs: dirs };
    // Copie laissée par un cockpit précédent : le démarrage doit la RETIRER (demande n° 3 de L17b), sans rien écrire ailleurs.
    fs.writeFileSync(path.join(dirs.authDir, "auth.json"), "{}");
    const wiring = buildCockpit11(deps);
    assertInscriptionsSalle(wiring);
    assert.deepEqual(
      wiring.registrations.filter((r) => EST_MODULE_SALLE(r.module)),
      [
        { kind: "startup", key: "startup", module: "omoControl", instances: ["principale"] },
        { kind: "routes", key: "omo", module: "omoRoom", instances: ["omo"] },
      ],
    );
    for (const start of wiring.startup) await start();
    assert.deepEqual(fs.readdirSync(dirs.authDir), [], "auth.json du processus précédent retiré");
    assert.deepEqual([fs.readdirSync(dirs.controlDir), fs.readdirSync(dirs.stateDir)], [[], []], "aucun battement, aucun precheck-ok");
    assert.deepEqual(fs.readdirSync(dossier("data")), [], "aucune suspension");
    // Écritures demandées une à une, salle coupée : un arrêt n'est jamais refusé (sans battement, l'homme mort suffit) mais
    // n'écrit rien ; precheck-ok et guard-state.json sont refusés, code « salle-coupee », jamais avalés.
    const ctrl = wiring.c11.ports.omoControl;
    await ctrl.requestStop("vous");
    for (const ecriture of [() => ctrl.writePrecheckOk("dem_1", []), () => ctrl.writeGuardState({ version: 1, at: 1, bloquer: ["task"] })]) {
      await assert.rejects(ecriture(), (err: unknown) => (err as { code?: string }).code === "salle-coupee");
    }
    ctrl.startHeartbeat();
    assert.deepEqual(fs.readdirSync(dirs.controlDir), []);
    ctrl.stopHeartbeat();
    fs.rmSync(racine, { recursive: true, force: true });
  });

  it("shared/ids.ts : mêmes motifs que http.ts (tant que http.ts garde sa copie locale)", () => {
    const http = fs.readFileSync(path.join(import.meta.dirname, "http.ts"), "utf8");
    const localId = /^const ID = "([^"]+)";$/m.exec(http);
    const localSession = /^const SESSION_ID_RE = \/(.+)\/([a-z]*);$/m.exec(http);
    if (localId === null && localSession === null) {
      // L1a-1 : copie locale supprimée, http.ts importe les motifs partagés.
      assert.match(http, /from "\.\/shared\/ids\.ts"/);
      return;
    }
    assert.ok(localId && localSession, "ID et SESSION_ID_RE doivent quitter http.ts ensemble");
    assert.equal(ID, localId[1]);
    assert.match(http, /^const ID_RE = new RegExp\(`\^\$\{ID\}\$`\);$/m);
    assert.equal(ID_RE.source, new RegExp(`^${localId[1]}$`).source);
    assert.equal(ID_RE.flags, "");
    assert.equal(SESSION_ID_RE.source, localSession[1]);
    assert.equal(SESSION_ID_RE.flags, localSession[2]);
  });

  it("squelettes : « Propriétaire : Lxx » en première ligne", () => {
    const owners: Record<string, string> = {
      "stop-tree.ts": "L1c",
      "routes-conversations.ts": "L1c",
      "task-once-guard.ts": "L1d",
      "routes-delegations.ts": "L1d",
      "delegation-watch.ts": "L1e",
      "session-floor-service.ts": "L3",
      "fact-store.ts": "L4b",
      "activity-deriver.ts": "L4b",
      "routes-activity.ts": "L4b",
      "conversation-autonomy.ts": "L6a",
      "routes-autonomy.ts": "L6a puis L10d",
      "plans.ts": "L6b",
      "routes-plans.ts": "L6b",
      "autonomy.ts": "L10a",
      "autonomy-requests.ts": "L10a",
      "autonomy-activation.ts": "L10d",
      "autonomy-watch.ts": "L10c",
      "autonomy-delegation.ts": "L10e",
      "control-ai.ts": "L11b",
      "internal-agents.ts": "L1g (classifieur) puis L11b (cockpit-controle)",
      "diagnostics-11.ts": "L1f",
      // Salle OMO : squelettes posés par T3b (plan 2 bis §4.2), plus le branchement du service réel de L17b.
      "omo-control-module.ts": "T3b",
      "instance-runtime.ts": "L18a",
      "instance-router.ts": "L18b",
      "oc-proxy.ts": "L18b",
      "omo-room.ts": "L18c",
      "routes-omo.ts": "L18c",
      "omo-precheck-service.ts": "L19b",
      "omo-activation.ts": "L22c",
      "omo-responder.ts": "L22d",
      "omo-caps.ts": "L22d",
      "omo-stop.ts": "L23b",
      "omo-detections-service.ts": "L23c",
    };
    for (const [file, owner] of Object.entries(owners)) {
      const firstLine = fs.readFileSync(path.join(import.meta.dirname, file), "utf8").split("\n")[0] ?? "";
      assert.equal(firstLine.replace(/\r$/, ""), `// Propriétaire : ${owner}.`, file);
    }
  });

  it("emitCockpit : publie l'événement 1.1 sur le hub", () => {
    const hub = new EventHub();
    const received: BrowserEvent[] = [];
    hub.subscribe((event) => void received.push(event));
    emitCockpit(hub, "delegation.plafond", { rootId: ROOT, kind: "cout" });
    assert.deepEqual(received, [{ kind: "cockpit", type: "delegation.plafond", data: { rootId: ROOT, kind: "cout" } }]);
  });
});
