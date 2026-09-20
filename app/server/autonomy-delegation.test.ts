// Tests L10e : délégation en « Autonome avec contrôle » (spécification §4.7 D1-D7, §4.8.1, §3.14 ; décisions n° 4 et n° 9 ;
// §6 ligne « En mode Simple, l'IA ne délègue pas » ; plan d'exécution, fiche L10e).
// Deux étages :
// - DOUBLURES : le port seul, faits et portillon simulés — chaque règle D qui échoue, le refus Simple (message exact, attente
//   close, fait « reponse »), le refus retenu ou en échec qui n'écrit rien, les bornes, les faits et plafonds illisibles ;
// - INTÉGRATION : cycle (L10a), garde des délégations (L1d), faits (L4b), portillon et faux opencode réels — délégations
//   parallèles automatiques sous plafond, 6e délégation refusée en Simple et en attente avec carte en Avancé, D1 à D5 et D7 par
//   les vrais faits, enfants qui suivent le choix de la racine.
// Ce que ces tests prouvent aussi : aucun `allow`, `ask` ni `always` n'est envoyé, et le seul refus jamais envoyé est celui du
// mode Simple, avec le texte de L1d ; ACTIVATION_OUVERTE n'est jamais touchée (port `activation` surchargé) ; P6 partout.
// Aucun appel facturé : faux opencode seulement (porte des exécutions facturées FERMÉE ; M9 reste une recette EN ATTENTE).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { createDelegationPolicy, delegationPolicyModuleWith, FAITS_ILLISIBLES_RULE, REFUS_EN_COURS_MAX } from "./autonomy-delegation.ts";
import type { ActivationPort, Cockpit11, ConversationAutonomyPort, DelegationPolicyInput, PermissionGate, WaitUpsert } from "./contracts-11.ts";
import { openMemoryDb } from "./db.ts";
import type { AppDeps } from "./http.ts";
import { createLogger } from "./log.ts";
import { createPermissionGate } from "./permission-gate.ts";
import { SessionTracker } from "./sessions.ts";
import type { ActivityFact } from "./shared/activity-types.ts";
import type { UiMode } from "./shared/assistant-rules.ts";
import { DELEGATION_AUTO_RULE, DELEGATION_RULE_ORDER, type DelegationRule } from "./shared/autonomy-rules.ts";
import type { AutonomyCaps, AutonomyChoice, AutonomyRequestView, DelegationFacts, RelayOutcome } from "./shared/autonomy-types.ts";
import { messageRefusSimple } from "./shared/delegation-texts.ts";
import { REPLI_ATTENTE_SIMPLE } from "./task-once-guard.ts";
import { type CockpitHarness, type CockpitHarnessOptions, startCockpit } from "./test-support/cockpit-harness.ts";
import { type FakeAgent, type FakePermissionRequest, type FakeSession, type FakeToolScript, nativeAgents } from "./test-support/fake-opencode.ts";
import { until, within } from "./test-support/helpers.ts";

const MODEL = { providerID: "github-copilot", modelID: "gpt-5-mini" };
const DOSSIER = "/workspace/proj";
const FIN = "Synthèse du faux opencode.";
const NL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const BQ = String.fromCharCode(96);
const DQ = String.fromCharCode(34);
/** Consigne sans aucun risque (ni @, ni !`, ni adresse, ni ~, ni .., ni chemin absolu). */
const PROMPT = "Lis le fichier des changements et résume-le en trois points.";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// --- Doublures ------------------------------------------------------------------------------------------------------------------

/** Faits d'une délégation conforme (D1 à D7 tiennent). */
const FAITS: DelegationFacts = {
  target: { name: "general", mode: "subagent", internal: false },
  taskIdInTree: null,
  promptRisk: null,
  modelAllowed: true,
  guardAccepts: true,
  delegationsSoFar: 0,
  estimateUsd: 0.01,
  remainingUsd: 1,
};

const PLAFONDS: AutonomyCaps = { plafondUsd: 1, actionsMax: 60, delegationsMax: 5, dureeMinutes: 30, fichiersMax: 25, controlesIaMax: 20 };

const DEMANDE = { id: "req_a", plafonds: PLAFONDS, endedAt: null, fin: null } as unknown as AutonomyRequestView;

const entree = (over: Partial<DelegationPolicyInput> = {}): DelegationPolicyInput => ({
  rootId: "ses_racine",
  sessionId: "ses_racine",
  permissionId: "per_a",
  directory: DOSSIER,
  mode: "simple",
  ...over,
});

interface StubOptions {
  facts?: Partial<DelegationFacts>;
  /** Faits illisibles (opencode muet, demande disparue). */
  collectFails?: boolean;
  /** Demande autonome en cours ; `null` : plafonds lus dans la conversation ; « leve » : plafonds illisibles. */
  demande?: AutonomyRequestView | null | "leve";
  reject?: (requestId: string) => Promise<RelayOutcome | "retenu">;
  repli?: boolean;
}

function stubPolicy(options: StubOptions = {}) {
  const calls = {
    collected: [] as string[],
    rejects: [] as Array<{ requestId: string; sessionId: string; directory: string | null; message: string; by: string }>,
    waits: [] as Array<{ wait: WaitUpsert; etat: string; par: string | null }>,
    facts: [] as ActivityFact[],
    relais: 0,
  };
  /** Travail différé retenu : les tests le lancent quand ils veulent observer le refus. */
  const differe: Array<() => void> = [];
  const c11 = {
    db: openMemoryDb(),
    log: createLogger("error"),
    settings: { get: () => ({ budget: { autonomie: { ...PLAFONDS, plafondMaxUsd: 5, controleIa: true } } }) },
    gate: {
      relayOnce: async () => {
        calls.relais++;
        return "ok";
      },
      rejectWhenAlone: async (requestId: string, sessionId: string, directory: string | null, message: string, by: string) => {
        calls.rejects.push({ requestId, sessionId, directory, message, by });
        return options.reject ? options.reject(requestId) : "ok";
      },
    },
    ports: {
      taskGuard: {
        collectDelegationFacts: async (ref: { permissionId: string }) => {
          calls.collected.push(ref.permissionId);
          if (options.collectFails === true) throw new Error("demande d'autorisation plus en attente");
          return { ...FAITS, ...(options.facts ?? {}) };
        },
      },
      facts: {
        append: (facts: ActivityFact[]) => calls.facts.push(...facts),
        work: {
          markWait: (wait: WaitUpsert, etat: string, par: string | null) => {
            calls.waits.push({ wait, etat, par });
            return true;
          },
        },
      },
      requests: {
        current: () => {
          if (options.demande === "leve") throw new Error("demande illisible");
          return options.demande === undefined ? DEMANDE : options.demande;
        },
        spent: () => 0,
      },
    },
  } as unknown as Cockpit11;
  const service = createDelegationPolicy(c11, {
    now: () => 1_000,
    repliAttenteSimple: options.repli ?? false,
    defer: (fn) => differe.push(fn),
  });
  /** Lance le travail différé et laisse les promesses se dénouer. */
  const vider = async (): Promise<void> => {
    for (const fn of differe.splice(0)) fn();
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  return { service, calls, vider, differe };
}

describe("L10e : règles D1 à D7 sur doublures", () => {
  it("délégation conforme → « auto » (A-task) : aucun refus, aucun « once » envoyé par ce module", async () => {
    const stub = stubPolicy();
    assert.deepEqual(await stub.service.port.decide(entree()), { verdict: "auto", regle: DELEGATION_AUTO_RULE });
    await stub.vider();
    assert.deepEqual([stub.calls.rejects, stub.calls.relais, stub.calls.facts], [[], 0, []]);
    assert.deepEqual(stub.calls.collected, ["per_a"], "les faits viennent de collectDelegationFacts (L1d)");
  });

  it("chaque règle qui échoue décide : Avancé → attente avec son code ; Simple → refus, dans l'ordre D1…D7", async () => {
    const cas: Array<[DelegationRule, Partial<DelegationFacts>]> = [
      ["D1", { target: { name: "build", mode: "primary", internal: false } }],
      ["D2", { taskIdInTree: false }],
      ["D3", { promptRisk: "arobase-fichier" }],
      ["D4", { modelAllowed: false }],
      ["D5", { guardAccepts: false }],
      ["D6", { delegationsSoFar: 5 }],
      ["D7", { estimateUsd: 2 }],
    ];
    assert.deepEqual(
      cas.map(([regle]) => regle),
      [...DELEGATION_RULE_ORDER],
      "toutes les règles du §4.7 sont couvertes, dans leur ordre",
    );
    for (const [regle, facts] of cas) {
      const avance = stubPolicy({ facts });
      assert.deepEqual(await avance.service.port.decide(entree({ mode: "avance" })), { verdict: "attente", regle }, `${regle} en Avancé`);
      await avance.vider();
      assert.deepEqual(avance.calls.rejects, [], `${regle} : aucun refus en Avancé`);

      const simple = stubPolicy({ facts });
      assert.deepEqual(await simple.service.port.decide(entree()), { verdict: "refus", regle }, `${regle} en Simple`);
      await simple.vider();
      assert.equal(simple.calls.rejects.length, 1, `${regle} : refus envoyé en Simple`);
    }
    // Cible interne ou absente : D1 aussi ; une cible « all » reste délégable.
    for (const target of [null, { name: "cockpit-controle", mode: "subagent", internal: true }]) {
      const stub = stubPolicy({ facts: { target } });
      assert.deepEqual(await stub.service.port.decide(entree({ mode: "avance" })), { verdict: "attente", regle: "D1" }, JSON.stringify(target));
    }
    const tout = stubPolicy({ facts: { target: { name: "tout", mode: "all", internal: false } } });
    assert.equal((await tout.service.port.decide(entree({ mode: "avance" }))).verdict, "auto");
    // D7 : l'estimation compare le reste du plafond, pas le plafond entier.
    const juste = stubPolicy({ facts: { estimateUsd: 0.5, remainingUsd: 0.5 } });
    assert.equal((await juste.service.port.decide(entree({ mode: "avance" }))).verdict, "auto", "estimation égale au reste");
  });

  it("un mode illisible attend : jamais de refus envoyé sans certitude", async () => {
    const stub = stubPolicy({ facts: { modelAllowed: false } });
    assert.deepEqual(await stub.service.port.decide(entree({ mode: "SIMPLE" as unknown as UiMode })), { verdict: "attente", regle: "D4" });
    await stub.vider();
    assert.deepEqual(stub.calls.rejects, []);
  });
});

describe("L10e : refus Simple (décision n° 4)", () => {
  it("message de L1d, par le cockpit, hors de l'appel ; attente close et fait « reponse » une fois parti", async () => {
    const stub = stubPolicy({ facts: { delegationsSoFar: 5 } });
    const sorts: Array<[string, string | null]> = [];
    const verdict = await stub.service.port.decide(
      entree({ permissionId: "per_b", sessionId: "ses_enfant", onRefusalSettled: (relais, regle) => void sorts.push([relais, regle]) }),
    );
    assert.deepEqual(verdict, { verdict: "refus", regle: "D6" });
    assert.deepEqual([stub.calls.rejects, stub.calls.waits, stub.calls.facts], [[], [], []], "rien pendant l'appel");
    assert.deepEqual(sorts, [], "le sort du refus n'est pas rendu avant l'envoi");
    assert.deepEqual(stub.service.refusEnCours(), ["per_b"]);
    await stub.vider();
    assert.deepEqual(stub.calls.rejects, [
      { requestId: "per_b", sessionId: "ses_enfant", directory: DOSSIER, message: messageRefusSimple(), by: "cockpit" },
    ]);
    assert.deepEqual(stub.calls.waits, [
      { wait: { permissionId: "per_b", sessionId: "ses_enfant", rootId: "ses_racine", permission: "task", target: "general" }, etat: "reject", par: "cockpit" },
    ]);
    assert.deepEqual(
      stub.calls.facts.map((f) => [f.kind, f.ref, f.rootId, f.sessionId, f.data]),
      [["reponse", "per_b", "ses_racine", "ses_enfant", { reponse: "reject", par: "cockpit" }]],
    );
    assert.deepEqual(stub.service.refusEnCours(), [], "refus terminé");
    assert.deepEqual(sorts, [["ok", "D6"]], "le sort du refus est rendu au cycle, une seule fois, avec sa règle");
  });

  it("refus retenu, expiré, déjà répondu ou en échec : rien n'est écrit au nom du cockpit, et le cycle l'apprend", async () => {
    for (const outcome of ["retenu", "deja-repondu", "expiree", "echec"] as const) {
      const stub = stubPolicy({ facts: { guardAccepts: false }, reject: async () => outcome });
      const sorts: Array<[string, string | null]> = [];
      assert.equal((await stub.service.port.decide(entree({ onRefusalSettled: (relais, regle) => void sorts.push([relais, regle]) }))).verdict, "refus", outcome);
      await stub.vider();
      assert.equal(stub.calls.rejects.length, 1, outcome);
      assert.deepEqual([stub.calls.waits, stub.calls.facts], [[], []], outcome);
      // Sans ce rappel, le cycle laisserait au Journal une ligne « Refusé automatiquement » pour un refus qui n'est pas parti.
      assert.deepEqual(sorts, [[outcome, "D5"]], outcome);
    }
    // Refus qui lève : le travail différé ne casse pas le cockpit, rien n'est écrit, et le cycle apprend l'échec.
    const casse = stubPolicy({
      facts: { guardAccepts: false },
      reject: async () => {
        throw new Error("portillon en erreur");
      },
    });
    const sorts: Array<[string, string | null]> = [];
    assert.equal((await casse.service.port.decide(entree({ onRefusalSettled: (relais, regle) => void sorts.push([relais, regle]) }))).verdict, "refus");
    await casse.vider();
    assert.deepEqual([casse.calls.waits, casse.calls.facts, casse.service.refusEnCours()], [[], [], []]);
    assert.deepEqual(sorts, [["echec", "D5"]], "un portillon en erreur rend « echec », jamais rien");
  });

  it("un rappel qui lève ne change rien à ce que le refus a fait (le cycle est dit, jamais propagé)", async () => {
    const stub = stubPolicy({ facts: { delegationsSoFar: 5 } });
    assert.equal(
      (
        await stub.service.port.decide(
          entree({
            onRefusalSettled: () => {
              throw new Error("cycle en erreur");
            },
          }),
        )
      ).verdict,
      "refus",
    );
    await stub.vider();
    assert.equal(stub.calls.rejects.length, 1, "le refus est bien parti");
    assert.equal(stub.calls.waits.length, 1, "l'attente d'accord est close");
    assert.equal(stub.calls.facts.length, 1, "le fait « reponse » est écrit");
    assert.deepEqual(stub.service.refusEnCours(), [], "le refus est retiré des refus en cours");
  });

  it("une même demande ne lance qu'un refus ; au-delà de REFUS_EN_COURS_MAX la délégation attend votre accord", async () => {
    const stub = stubPolicy({ facts: { promptRisk: "url" } });
    const sorts: Array<[string, string | null]> = [];
    for (let i = 0; i < 3; i++) {
      assert.equal((await stub.service.port.decide(entree({ onRefusalSettled: (relais, regle) => void sorts.push([relais, regle]) }))).verdict, "refus", `essai ${i}`);
    }
    assert.deepEqual([stub.differe.length, stub.service.refusEnCours()], [1, ["per_a"]], "un seul refus lancé");
    await stub.vider();
    // Chaque examen a écrit sa ligne « attente » : chacun doit apprendre le sort, sans quoi une ligne resterait orpheline.
    assert.deepEqual(sorts, [["ok", "D3"], ["ok", "D3"], ["ok", "D3"]], "les trois examens apprennent le même sort");
    assert.equal(stub.calls.rejects.length, 1, "un seul refus envoyé");

    const borne = stubPolicy({ facts: { promptRisk: "url" } });
    for (let i = 0; i < REFUS_EN_COURS_MAX; i++) {
      assert.equal((await borne.service.port.decide(entree({ permissionId: `per_${i}` }))).verdict, "refus", `refus ${i}`);
    }
    assert.equal(borne.service.refusEnCours().length, REFUS_EN_COURS_MAX);
    assert.deepEqual(await borne.service.port.decide(entree({ permissionId: "per_trop" })), { verdict: "attente", regle: "D3" }, "borne atteinte");
    await borne.vider();
    assert.equal(borne.calls.rejects.length, REFUS_EN_COURS_MAX, "aucun refus au-delà de la borne");
    assert.equal(
      borne.calls.rejects.some((r) => r.requestId === "per_trop"),
      false,
    );
  });

  it("repli M9 (réglage interne de L1d, désactivé par défaut) : la délégation attend votre accord, aucun refus d'office", async () => {
    assert.equal(REPLI_ATTENTE_SIMPLE, false, "repli interne désactivé");
    const stub = stubPolicy({ facts: { taskIdInTree: false }, repli: true });
    assert.deepEqual(await stub.service.port.decide(entree()), { verdict: "attente", regle: "D2" });
    await stub.vider();
    assert.deepEqual([stub.calls.rejects, stub.differe], [[], []]);
  });
});

describe("L10e : faits et plafonds illisibles", () => {
  it("faits illisibles → attente X-illisible, aucun refus, aucune lecture de plafonds", async () => {
    const stub = stubPolicy({ collectFails: true });
    assert.deepEqual(await stub.service.port.decide(entree()), { verdict: "attente", regle: FAITS_ILLISIBLES_RULE });
    await stub.vider();
    assert.deepEqual(stub.calls.rejects, []);
  });

  it("plafonds illisibles → attente X-illisible ; sans demande en cours, les plafonds sont ceux de la conversation", async () => {
    const leve = stubPolicy({ demande: "leve", facts: { delegationsSoFar: 99 } });
    assert.deepEqual(await leve.service.port.decide(entree()), { verdict: "attente", regle: FAITS_ILLISIBLES_RULE });
    await leve.vider();
    assert.deepEqual(leve.calls.rejects, [], "jamais un refus sur une lecture manquée");

    // Plafonds de la conversation (réglages) : delegationsMax = 5.
    const conversation = stubPolicy({ demande: null, facts: { delegationsSoFar: 5 } });
    assert.deepEqual(await conversation.service.port.decide(entree({ mode: "avance" })), { verdict: "attente", regle: "D6" });
    const sous = stubPolicy({ demande: null, facts: { delegationsSoFar: 4 } });
    assert.equal((await sous.service.port.decide(entree({ mode: "avance" }))).verdict, "auto");

    // Plafonds de la demande autonome en cours : ils l'emportent sur ceux de la conversation.
    const serree = stubPolicy({ demande: { ...DEMANDE, plafonds: { ...PLAFONDS, delegationsMax: 1 } }, facts: { delegationsSoFar: 1 } });
    assert.deepEqual(await serree.service.port.decide(entree({ mode: "avance" })), { verdict: "attente", regle: "D6" });
  });
});

// --- Intégration : cycle, garde, portillon et faux opencode réels ------------------------------------------------------------------

/** Workspace réel monté en /workspace : `proj` = dossier de la conversation, avec un dépôt git et un fichier `a.txt`. */
function workspace(t: TestContext): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-l10e-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const proj = path.join(root, "proj");
  for (const dir of ["src", ".git/objects", ".git/refs"]) fs.mkdirSync(path.join(proj, ...dir.split("/")), { recursive: true });
  const files: Record<string, string> = {
    "a.txt": `ligne 1${NL}ligne 2${NL}`,
    "src/app.ts": `export {};${NL}`,
    ".git/HEAD": `ref: refs/heads/main${NL}`,
    ".git/config": ["[core]", `${TAB}repositoryformatversion = 0`, `[remote ${DQ}origin${DQ}]`, `${TAB}url = https://exemple.invalid/d.git`, ""].join(NL),
  };
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(proj, ...name.split("/")), content);
  return root;
}

/** Port `activation` ouvert par surcharge (ACTIVATION_OUVERTE reste false : la constante n'est jamais touchée). */
const PERMIS: ActivationPort = { check: async () => ({ ok: true }) };

function choicePort(choices: Map<string, AutonomyChoice>): ConversationAutonomyPort {
  return {
    get: async () => null,
    choiceOf: (id) => choices.get(id) ?? "demander",
    put: async () => ({ ok: false, status: 409, error: "autonomie-indisponible", raison: "a-venir" }),
  };
}

/** Modules de l'itération 2 nécessaires à la délégation en Autonome, dans l'ordre de MODULE_ORDER. */
const MODULES: NonNullable<CockpitHarnessOptions["modules"]> = ["gate", "floors", "facts", "requests", "taskGuard", "autonomy", "delegationPolicy"];

interface BenchOptions {
  mode?: UiMode;
  settings?: Record<string, unknown>;
  modules?: CockpitHarnessOptions["modules"];
  agents?: FakeAgent[];
  /** Sort imposé au refus du portillon (retenue F-c, échec) ; absent : le vrai portillon envoie le refus. */
  rejet?: RelayOutcome | "retenu";
}

interface Bench {
  h: CockpitHarness;
  choices: Map<string, AutonomyChoice>;
}

async function startBench(t: TestContext, options: BenchOptions = {}): Promise<Bench> {
  const root = workspace(t);
  const choices = new Map<string, AutonomyChoice>();
  const rejet = options.rejet;
  const h = await startCockpit(t, {
    modules: options.modules ?? MODULES,
    env: { workspaceDir: root },
    settings: { ui: { mode: options.mode ?? "simple" }, ...(options.settings ?? {}) },
    ports: { conversationAutonomy: choicePort(choices), activation: PERMIS },
    // Portillon réel dont le seul refus rend le sort imposé : la retenue F-c (jusqu'à 45 s) et l'échec sont autrement
    // inobservables sur le faux opencode, alors qu'ils décident de ce que le Journal a le droit d'écrire.
    ...(rejet === undefined
      ? {}
      : {
          gate: (deps: AppDeps): PermissionGate => {
            const real = createPermissionGate({ client: deps.client, db: deps.db, log: deps.log, hub: deps.hub, sessions: new SessionTracker(deps.db, deps.client) });
            return { ...real, rejectWhenAlone: async () => rejet };
          },
        }),
  });
  if (options.agents) h.fake.setAgents([...nativeAgents(), ...options.agents]);
  return { h, choices };
}

interface TaskOptions {
  description?: string;
  prompt?: string;
  taskId?: string;
  beforeAsk?: () => Promise<void>;
  child?: FakeToolScript["child"];
}

/** Appel `task` qui demande une autorisation (tool/task.ts : patterns = [subagent_type], metadata {description, subagent_type}). */
function task(agent: string, options: TaskOptions = {}): FakeToolScript {
  const description = options.description ?? `Déléguer à ${agent}`;
  return {
    tool: "task",
    input: { description, prompt: options.prompt ?? PROMPT, subagent_type: agent, ...(options.taskId === undefined ? {} : { task_id: options.taskId }) },
    ask: { permission: "task", patterns: [agent], metadata: { description, subagent_type: agent } },
    ...(options.beforeAsk ? { beforeAsk: options.beforeAsk } : {}),
    child: options.child ?? { agent, text: "Résumé du sous-agent." },
  };
}

async function conversation(h: CockpitHarness, title: string, directory = DOSSIER): Promise<FakeSession> {
  const created = await h.call("POST", `/api/oc/session?directory=${encodeURIComponent(directory)}`, { headers: h.headers.mutating, body: { title } });
  assert.equal(created.status, 200, created.body);
  const session = created.json<FakeSession>();
  await until(() => h.sessions.get(session.id));
  return session;
}

async function send(h: CockpitHarness, session: FakeSession, tools: FakeToolScript[], headers: Record<string, string> = h.headers.mutating): Promise<void> {
  h.fake.script(session.id, { tools, followUp: { text: FIN } });
  const sent = await h.call("POST", `/api/oc/session/${session.id}/prompt_async?directory=${encodeURIComponent(session.directory)}`, {
    headers,
    body: { agent: "build", model: MODEL, parts: [{ type: "text", text: "Travaille." }] },
  });
  assert.equal(sent.status, 204, sent.body);
}

interface DecisionRow {
  root_id: string;
  session_id: string;
  permission_id: string | null;
  permission: string;
  regle: string;
  verdict: string;
  par: string;
  relais: string | null;
}

const decisions = (h: CockpitHarness): DecisionRow[] => h.db.prepare("SELECT * FROM autonomy_decisions ORDER BY id").all() as unknown as DecisionRow[];

const decisionOf = (h: CockpitHarness, permissionId: string): Promise<DecisionRow> =>
  until(() => decisions(h).find((row) => row.permission_id === permissionId));

/** Toutes les lignes de Journal d'une demande d'autorisation, dans l'ordre d'écriture. */
const lignesDe = (h: CockpitHarness, permissionId: string): DecisionRow[] => decisions(h).filter((row) => row.permission_id === permissionId);

/** Réponses d'autorisation réellement envoyées à opencode. */
const replies = (h: CockpitHarness): Array<{ id: string; body: unknown }> =>
  h.fake.requests
    .filter((r) => r.method === "POST" && r.pathname.startsWith("/permission/"))
    .map((r) => ({ id: r.pathname.split("/")[2] ?? "", body: r.body }));

const repliesTo = (h: CockpitHarness, permissionId: string): unknown[] => replies(h).filter((r) => r.id === permissionId).map((r) => r.body);

/** P4 : jamais « allow », « ask » ni « always » ; le seul refus possible est celui du mode Simple, avec le texte de L1d. */
function assertNeverForbidden(h: CockpitHarness): void {
  for (const reply of replies(h)) {
    const body = isRecord(reply.body) ? reply.body : {};
    if (body.reply === "once") continue;
    assert.deepEqual(body, { reply: "reject", message: messageRefusSimple() }, `réponse interdite envoyée : ${JSON.stringify(reply.body)}`);
  }
}

/** Les `count` demandes de la conversation, toutes posées. */
async function asked(h: CockpitHarness, sessionId: string, count: number): Promise<FakePermissionRequest[]> {
  return until(() => {
    const list = h.fake.pendingPermissions().filter((p) => p.sessionID === sessionId);
    return list.length === count ? list : null;
  }, 5_000);
}

/** Demande posée par l'appel d'outil de cette description, qu'elle attende encore ou qu'elle ait déjà été autorisée. */
async function askedFor(h: CockpitHarness, sessionId: string, description: string, since: number): Promise<FakePermissionRequest> {
  const event = await h.fake.waitForEvent(
    "permission.asked",
    (p) => p.sessionID === sessionId && isRecord(p.metadata) && p.metadata.description === description,
    { since },
  );
  return event.properties as unknown as FakePermissionRequest;
}

async function flush(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe("L10e : délégation en Autonome, intégration", () => {
  it("délégations parallèles sous plafond : chacune est autorisée seule (A-task), comptée dans la demande ; aucun refus", async (t) => {
    const { h, choices } = await startBench(t);
    const session = await conversation(h, "Délégations parallèles");
    choices.set(session.id, "autonome");
    const labels = ["une", "deux", "trois"];
    await send(
      h,
      session,
      labels.map((label) => task("general", { description: label })),
    );
    await within(h.fake.settled(session.id), "tour terminé");
    const lignes = await until(() => {
      const rows = decisions(h).filter((row) => row.permission === "task");
      return rows.length === labels.length ? rows : null;
    });
    for (const row of lignes) {
      assert.deepEqual([row.verdict, row.regle, row.par, row.relais, row.root_id], ["auto", DELEGATION_AUTO_RULE, "regles", "ok", session.id], row.permission_id ?? "");
      assert.deepEqual(repliesTo(h, row.permission_id ?? ""), [{ reply: "once" }]);
    }
    const vue = await until(() => {
      const res = h.cockpit.c11.ports.requests.current(session.id);
      return res !== null && res.delegations === labels.length ? res : null;
    });
    assert.deepEqual([vue.delegations, vue.auto, vue.refus], [3, 3, 0], "compteurs de la demande autonome");
    assertNeverForbidden(h);
    h.assertNoGlobalRestart();
  });

  it("6e délégation (D6) : refus avec message en Simple, l'IA continue seule ; attente avec carte en Avancé", async (t) => {
    for (const mode of ["simple", "avance"] as UiMode[]) {
      const { h, choices } = await startBench(t, { mode });
      const session = await conversation(h, `Plafond ${mode}`);
      choices.set(session.id, "autonome");
      // Les cinq délégations du plafond sont lancées pendant le tour, avant que la demande d'autorisation soit posée.
      const cinq = async (): Promise<void> => {
        for (let i = 0; i < 5; i++) {
          assert.equal(
            h.cockpit.c11.ports.facts.work.markDelegation({ rootId: session.id, parentSessionId: session.id, callId: `call_${i}`, agent: "general" }, "travaille", null),
            true,
          );
        }
      };
      await send(h, session, [task("general", { description: "sixième", beforeAsk: cinq })]);
      const [request] = await asked(h, session.id, 1);
      assert.ok(request);
      const ligne = await decisionOf(h, request.id);
      assert.equal(ligne.regle, "D6", mode);

      if (mode === "simple") {
        // Le refus part HORS de l'appel : à cet instant son sort est inconnu, le Journal dit donc l'attente, qui est vraie.
        assert.equal(ligne.verdict, "attente", "rien n'est journalisé « refusé » avant que le refus soit parti");
        await within(h.fake.settled(session.id), "tour terminé");
        assert.deepEqual(repliesTo(h, request.id), [{ reply: "reject", message: messageRefusSimple() }]);
        // Refus parti : la décision définitive est écrite (décision n° 4, l'IA continue seule), avec son relais.
        const definitive = await until(() => lignesDe(h, request.id).find((row) => row.verdict === "refus-auto"));
        assert.deepEqual([definitive.regle, definitive.par, definitive.relais], ["D6", "cockpit", "ok"]);
        assert.deepEqual(
          lignesDe(h, request.id).map((row) => row.verdict),
          ["attente", "refus-auto"],
          "le Journal garde les deux temps, dans l'ordre",
        );
        const compteurs = await until(() => {
          const vue = h.cockpit.c11.ports.requests.current(session.id);
          return vue !== null && vue.refus === 1 ? vue : null;
        });
        assert.deepEqual([compteurs.refus, compteurs.attentes], [1, 0], "l'attente est devenue un refus, jamais les deux");
        const attente = await until(
          () => h.db.prepare("SELECT reply, replied_by FROM permission_waits WHERE permission_id = ?").get(request.id) as { reply: string; replied_by: string } | undefined,
        );
        assert.deepEqual({ ...attente }, { reply: "reject", replied_by: "cockpit" });
      } else {
        assert.equal(ligne.verdict, "attente", "mode Avancé : votre accord");
        await flush();
        assert.deepEqual(repliesTo(h, request.id), [], "rien n'est envoyé en Avancé");
        const carte = await h.call("GET", `/api/conversations/${session.id}/delegations/${request.id}`, { headers: h.headers.authed });
        assert.equal(carte.status, 200, carte.body);
        const vue = carte.json<{ cible: { nom: string } | null; compteurs: { delegations: number; delegationsMax: number } }>();
        assert.equal(vue.cible?.nom, "general", "carte détaillée disponible");
        assert.equal(vue.compteurs.delegations, 5);
      }
      assertNeverForbidden(h);
      h.assertNoGlobalRestart();
      await h.close();
    }
  });

  it("refus retenu (F-c) ou en échec : le Journal ne dit JAMAIS « Refusé automatiquement », la délégation attend votre accord", async (t) => {
    for (const rejet of ["retenu", "echec"] as const) {
      const { h, choices } = await startBench(t, { rejet });
      const session = await conversation(h, `Refus ${rejet}`);
      choices.set(session.id, "autonome");
      const cinq = async (): Promise<void> => {
        for (let i = 0; i < 5; i++) {
          h.cockpit.c11.ports.facts.work.markDelegation({ rootId: session.id, parentSessionId: session.id, callId: `call_${i}`, agent: "general" }, "travaille", null);
        }
      };
      await send(h, session, [task("general", { description: "sixième", beforeAsk: cinq })]);
      const [request] = await asked(h, session.id, 1);
      assert.ok(request);
      const ligne = await decisionOf(h, request.id);
      assert.deepEqual([ligne.regle, ligne.verdict], ["D6", "attente"], rejet);
      await flush();

      // Rien n'est parti : le Journal, trace de référence du §4.12, ne doit pas dire un refus qui n'a pas eu lieu.
      assert.deepEqual(lignesDe(h, request.id).map((row) => row.verdict), ["attente"], `${rejet} : aucune ligne « refus-auto »`);
      const vue = h.cockpit.c11.ports.requests.current(session.id);
      assert.deepEqual([vue?.refus, vue?.attentes], [0, 1], `${rejet} : compteur de refus inchangé`);
      // La demande attend toujours l'utilisateur chez opencode, et aucun fait « reponse » n'a été écrit au nom du cockpit.
      assert.deepEqual(repliesTo(h, request.id), [], rejet);
      assert.ok(h.fake.pendingPermissions().some((p) => p.id === request.id), `${rejet} : la demande attend toujours votre accord`);
      assert.deepEqual(
        h.db.prepare("SELECT kind FROM activity_facts WHERE ref = ? AND kind = 'reponse'").all(request.id),
        [],
        `${rejet} : aucun fait « reponse »`,
      );
      assertNeverForbidden(h);
      await h.close();
    }
  });

  it("repli M9 posé sur le module (delegationPolicyModuleWith) : en Simple la 6e délégation attend votre accord, rien n'est envoyé", async (t) => {
    const repli = delegationPolicyModuleWith({ repliAttenteSimple: true });
    const { h, choices } = await startBench(t, { modules: [...MODULES.slice(0, -1), repli] });
    const session = await conversation(h, "Repli M9");
    choices.set(session.id, "autonome");
    const cinq = async (): Promise<void> => {
      for (let i = 0; i < 5; i++) {
        h.cockpit.c11.ports.facts.work.markDelegation({ rootId: session.id, parentSessionId: session.id, callId: `call_${i}`, agent: "general" }, "travaille", null);
      }
    };
    await send(h, session, [task("general", { description: "sixième", beforeAsk: cinq })]);
    const [request] = await asked(h, session.id, 1);
    assert.ok(request);
    const ligne = await decisionOf(h, request.id);
    assert.deepEqual([ligne.regle, ligne.verdict], ["D6", "attente"]);
    await flush();
    assert.deepEqual(repliesTo(h, request.id), []);
    assertNeverForbidden(h);
  });

  it("D1 à D4 par les vrais faits, en Avancé : cible principale ou interne, task_id hors de l'arbre, consigne à risque, IA hors catalogue", async (t) => {
    const ailleurs: FakeAgent = { name: "analyste-ailleurs", mode: "subagent", options: {}, permission: [], model: { providerID: "openai", modelID: "gpt-x" } };
    const { h, choices } = await startBench(t, { mode: "avance", agents: [ailleurs] });
    const autre = await conversation(h, "Autre conversation");
    const session = await conversation(h, "Règles D");
    choices.set(session.id, "autonome");
    const risques: Array<[string, string]> = [
      ["fichier", "Résume @a.txt en trois points."],
      ["commande", `Lance !${BQ}ls${BQ} puis résume.`],
      ["adresse", "Lis https://exemple.invalid/doc puis résume."],
      ["tilde", "Regarde ~/notes et résume."],
      ["absolu", "Lis /etc/hosts et résume."],
      ["parent", "Remonte dans ../autre et résume."],
    ];
    const since = h.fake.emitted.length;
    await send(h, session, [
      task("build", { description: "principale" }),
      task("title", { description: "interne" }),
      task("inconnu", { description: "inconnue" }),
      task("general", { description: "task_id hors arbre", taskId: autre.id }),
      ...risques.map(([label, prompt]) => task("general", { description: label, prompt })),
      task("analyste-ailleurs", { description: "IA hors catalogue" }),
      task("general", { description: "témoin" }),
    ]);
    const attendu: Array<[string, string]> = [
      ["principale", "D1"],
      ["interne", "D1"],
      ["inconnue", "D1"],
      ["task_id hors arbre", "D2"],
      ...risques.map(([label]): [string, string] => [label, "D3"]),
      ["IA hors catalogue", "D4"],
    ];
    for (const [label, regle] of attendu) {
      const request = await askedFor(h, session.id, label, since);
      const ligne = await decisionOf(h, request.id);
      assert.deepEqual([ligne.regle, ligne.verdict], [regle, "attente"], label);
      assert.deepEqual(repliesTo(h, request.id), [], label);
    }
    const temoin = await askedFor(h, session.id, "témoin", since);
    const ligneTemoin = await decisionOf(h, temoin.id);
    assert.deepEqual([ligneTemoin.regle, ligneTemoin.verdict], [DELEGATION_AUTO_RULE, "auto"], "témoin conforme");
    assertNeverForbidden(h);
    h.assertNoGlobalRestart();
  });

  it("D5 : le garde-fou budgétaire refuse → attente, aucun appel facturé (P5, aucune confirmation)", async (t) => {
    const { h, choices } = await startBench(t, {
      mode: "avance",
      settings: { budget: { guard: { enabled: true, fromPercent: 0, maxOutputPricePerM: 1, blockAtLimit: true } } },
    });
    const session = await conversation(h, "Garde-fou");
    choices.set(session.id, "autonome");
    // Votre envoi est confirmé par vous (x-cockpit-confirm) ; la délégation, elle, n'est JAMAIS confirmée par l'autonomie (P5).
    await send(h, session, [task("general")], h.headers.confirmed);
    const [request] = await asked(h, session.id, 1);
    assert.ok(request);
    const ligne = await decisionOf(h, request.id);
    assert.deepEqual([ligne.regle, ligne.verdict], ["D5", "attente"]);
    assert.deepEqual(repliesTo(h, request.id), []);
    assertNeverForbidden(h);
    h.assertNoGlobalRestart();
  });

  it("D7 : estimation au-dessus du reste du plafond → attente", async (t) => {
    const { h, choices } = await startBench(t, { mode: "avance", settings: { budget: { delegation: { maxUsdPerRequest: 0.000001, maxPerRequest: 5 } } } });
    const session = await conversation(h, "Estimation");
    choices.set(session.id, "autonome");
    assert.ok((h.deps.tiers.taskCost("github-copilot/gpt-5-mini")?.M ?? 0) > 0.000001, "l'estimation dépasse bien le reste");
    await send(h, session, [task("general")]);
    const [request] = await asked(h, session.id, 1);
    assert.ok(request);
    const ligne = await decisionOf(h, request.id);
    assert.deepEqual([ligne.regle, ligne.verdict], ["D7", "attente"]);
    assert.deepEqual(repliesTo(h, request.id), []);
    assertNeverForbidden(h);
  });

  it("les enfants suivent le choix de la racine : délégation d'un enfant automatique en Autonome, en attente quand la racine vous demande", async (t) => {
    const { h, choices } = await startBench(t, { mode: "avance" });
    const session = await conversation(h, "Racine autonome");
    choices.set(session.id, "autonome");
    // L'enfant délègue à son tour : sa demande est décidée sur le choix de la RACINE, pas sur le sien.
    await send(h, session, [
      task("general", {
        description: "racine",
        child: { agent: "general", turn: { tools: [task("explore", { description: "enfant" })], followUp: { text: "Fait." } } },
      }),
    ]);
    const enfant = await until(() => decisions(h).find((row) => row.permission === "task" && row.session_id !== session.id));
    assert.deepEqual([enfant.root_id, enfant.verdict, enfant.regle], [session.id, "auto", DELEGATION_AUTO_RULE], "l'enfant suit la racine");
    assert.deepEqual(repliesTo(h, enfant.permission_id ?? ""), [{ reply: "once" }]);

    // Même arbre, choix de la racine revenu à « Demander à chaque fois » : plus rien n'est automatique pour l'enfant.
    choices.set(session.id, "demander");
    const avant = decisions(h).length;
    const suite = await conversation(h, "Racine qui demande");
    choices.set(suite.id, "autonome");
    await send(h, session, [task("general", { description: "après le resserrement" })]);
    const [request] = await asked(h, session.id, 1);
    assert.ok(request);
    await flush();
    assert.equal(decisions(h).length, avant, "aucune décision d'autonomie hors du choix de la racine");
    assert.deepEqual(repliesTo(h, request.id), [], "la demande attend votre accord");
    assertNeverForbidden(h);
    h.assertNoGlobalRestart();
  });
});
