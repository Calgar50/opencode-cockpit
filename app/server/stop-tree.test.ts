// Tests L1c : arrêt unique de l'arbre (stop-tree.ts), route POST /api/conversations/:rootId/stop et crochet d'arrêt du proxy
// (spécification §3.12, §3.9, §6 « Arrêter », I14 ; plan d'exécution, fiche L1c).
// Unitaires : opencode scripté (journal des appels), portillon réel, horloge et pauses injectées : ordre des 6 étapes, sonde
// 500 ms / 10 s puis « arrêt non confirmé », « once » tardif refusé, échéance de la file, P6, étape 1 limitée à la demande.
// Intégration : faux opencode et harnais du cockpit (module stopTree seul) : route (400, 401, 403 CSRF, 404), relais 1.0 hors
// racine suivie, enfant occupé après l'arrêt de la racine, scénario de la capture p6, faits et marques (espions sur ports.facts).
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { describe, it, type TestContext } from "node:test";
import type { FactsPort, PermissionGate, RequestsPort, StopTreePort } from "./contracts-11.ts";
import { openMemoryDb } from "./db.ts";
import { EventHub } from "./hub.ts";
import { createLogger, type Logger } from "./log.ts";
import { type OpencodeClient, OpencodeError } from "./opencode.ts";
import { createPermissionGate } from "./permission-gate.ts";
import { SessionTracker } from "./sessions.ts";
import type { ActivityFact, DelegationState } from "./shared/activity-types.ts";
import type { RepliedBy } from "./shared/autonomy-types.ts";
import type { StopCause, StopResult } from "./shared/cockpit-event-types.ts";
import {
  createStopTree,
  REQUEST_END_OF_STOP,
  RUNNING_DELEGATION_STATES,
  STATUT_CAUSE_OF_STOP,
  STOP_PHASE_BUDGET_MS,
  STOP_PROBE_INTERVAL_MS,
  STOP_PROBE_WINDOW_MS,
  StopRootUnknownError,
  stoppableRoot,
} from "./stop-tree.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import { type FakePermissionRequest, type FakeSession, readCapture } from "./test-support/fake-opencode.ts";
import { assertSubsequence, promptAsync, trace, until, within } from "./test-support/helpers.ts";

const ROOT = "ses_racine";
const CHILD = "ses_enfant";
const CONTROL = "ses_controle";
const FOUND = "ses_trouvee";
const OTHER = "ses_autre";
const MODEL = { providerID: "github-copilot", modelID: "gpt-5-mini" };

// --- Unitaires : opencode scripté ---------------------------------------------------------------------------------------------

interface StubOptions {
  /** Sessions qui travaillent au départ. */
  busy: string[];
  pending: Array<{ id: string; sessionID: string }>;
  /** GET /session/:id/children. */
  children?: Record<string, string[]>;
  /** Sous-agents « task » arrêtés avec leur parent (run-state.ts) ; les autres enfants ne le sont pas. */
  withParent?: Record<string, string[]>;
  /** Sessions qu'un arrêt ne met pas au repos. */
  stubborn?: string[];
  statusFails?: boolean;
  /** Appelé à chaque requête, avant la réponse ; peut lever (délai dépassé). */
  onRequest?: (method: string, path: string) => void;
  onAbort?: (id: string) => void;
}

function stubOpencode(options: StubOptions) {
  const journal: string[] = [];
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const busy = new Set(options.busy);
  const pending = options.pending.map((p) => ({ ...p }));
  const request = async (method: string, path: string, init: { body?: unknown } = {}): Promise<unknown> => {
    journal.push(`${method} ${path}`);
    calls.push({ method, path, body: init.body });
    options.onRequest?.(method, path);
    if (method === "GET" && path === "/permission") return pending.map((p) => ({ ...p }));
    if (method === "GET" && path === "/session/status") {
      if (options.statusFails) throw new Error("états illisibles");
      return Object.fromEntries([...busy].map((id) => [id, { type: "busy" }]));
    }
    const children = /^\/session\/([^/]+)\/children$/.exec(path);
    if (method === "GET" && children) return (options.children?.[children[1] ?? ""] ?? []).map((id) => ({ id, directory: "/workspace" }));
    const reply = /^\/permission\/([^/]+)\/reply$/.exec(path);
    if (method === "POST" && reply) {
      const found = pending.find((p) => p.id === reply[1]);
      if (!found) throw new OpencodeError(404, { _tag: "PermissionNotFoundError" });
      // F-c : un refus retire toutes les demandes de la même session.
      for (let i = pending.length - 1; i >= 0; i--) if (pending[i]?.sessionID === found.sessionID) pending.splice(i, 1);
      return true;
    }
    const abort = /^\/session\/([^/]+)\/abort$/.exec(path);
    if (method === "POST" && abort) {
      const id = abort[1] ?? "";
      if (!options.stubborn?.includes(id)) {
        busy.delete(id);
        for (const child of options.withParent?.[id] ?? []) busy.delete(child);
      }
      options.onAbort?.(id);
      return true;
    }
    throw new Error(`route inattendue : ${method} ${path}`);
  };
  return { client: { request } as unknown as OpencodeClient, journal, calls, busy, pending };
}

/** Portillon réel dont la file est notée au journal (prise, rendue) avec l'heure de l'horloge injectée. */
function journaledGate(gate: PermissionGate, journal: string[], now: () => number, times: Array<[string, number]>): PermissionGate {
  return {
    ...gate,
    acquire: async () => {
      const release = await gate.acquire();
      journal.push("file:prise");
      times.push(["prise", now()]);
      let done = false;
      return () => {
        if (!done) {
          done = true;
          journal.push("file:rendue");
          times.push(["rendue", now()]);
        }
        release();
      };
    },
  };
}

interface Mark {
  callId: string;
  childSessionId: string | null | undefined;
  etat: DelegationState;
  par: RepliedBy | null;
}

function unitSetup(t: TestContext, stubOptions: StubOptions) {
  const db = openMemoryDb();
  t.after(() => db.close());
  const stub = stubOpencode(stubOptions);
  const sessions = new SessionTracker(db, stub.client);
  const at = 1_000;
  const add = (id: string, parentID?: string, metadata?: Record<string, unknown>) =>
    sessions.upsert({ id, ...(parentID ? { parentID } : {}), projectID: "global", directory: "/workspace", title: id, ...(metadata ? { metadata } : {}), time: { created: at, updated: at } });
  add(ROOT);
  add(CHILD, ROOT);
  add(CONTROL, ROOT, { cockpit: "controle" });
  add(OTHER);

  let clock = 1_000_000;
  const now = () => clock;
  const advance = (ms: number) => {
    clock += ms;
  };
  const warns: Array<{ message: string; fields: Record<string, unknown> | undefined }> = [];
  const log: Logger = { ...createLogger("error"), warn: (message, fields) => warns.push({ message, fields }) };
  const events: Array<{ type: string; data: unknown }> = [];
  const facts: ActivityFact[] = [];
  const marks: Mark[] = [];
  const interrupts: Array<[string, string]> = [];
  let interrupt: RequestsPort["interrupt"] = (rootId, fin) => {
    stub.journal.push(`interruption ${rootId} ${fin}`);
    interrupts.push([rootId, fin]);
  };
  const facts_: FactsPort = {
    append: (list) => {
      for (const fact of list) {
        stub.journal.push(`fait ${fact.kind} ${String(fact.data.cause)}`);
        facts.push(fact);
      }
    },
    since: () => ({ facts: [], partial: false }),
    work: {
      markDelegation: (delegation, etat, par) => {
        stub.journal.push(`marque ${delegation.callId} ${etat} ${par}`);
        marks.push({ callId: delegation.callId, childSessionId: delegation.childSessionId, etat, par });
        return true;
      },
      markWait: () => false,
    },
  };
  const requests: RequestsPort = { current: () => null, spent: () => 0, interrupt: (rootId, fin) => interrupt(rootId, fin) };
  const times: Array<[string, number]> = [];
  const gate = journaledGate(createPermissionGate({ client: stub.client, db, log: createLogger("error"), hub: new EventHub(), sessions }), stub.journal, now, times);
  const sleeps: number[] = [];
  const stopTree = createStopTree(
    {
      client: stub.client,
      sessions,
      gate,
      db,
      log,
      hub: {
        cockpit: (type: string, data: unknown) => {
          stub.journal.push(`evenement ${type}`);
          events.push({ type, data });
        },
      },
      ports: () => ({ requests, facts: facts_ }),
    },
    {
      now,
      sleep: async (ms) => {
        sleeps.push(ms);
        stub.journal.push(`pause ${ms}`);
        advance(ms);
      },
    },
  );
  const delegation = (callId: string, rootId: string, child: string | null, state: DelegationState) =>
    db
      .prepare("INSERT INTO delegations (root_id, parent_session_id, child_session_id, call_id, agent, source, state, created_at) VALUES (?, ?, ?, ?, 'general', 'ia', ?, ?)")
      .run(rootId, rootId, child, callId, state, at);
  const totalChanges = (d: DatabaseSync = db) => (d.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
  return {
    ...stub,
    db,
    sessions,
    gate,
    stopTree,
    add,
    now,
    advance,
    warns,
    events,
    facts,
    marks,
    interrupts,
    times,
    sleeps,
    delegation,
    totalChanges,
    setInterrupt: (fn: RequestsPort["interrupt"]) => {
      interrupt = fn;
    },
  };
}

/** Indice de la première entrée du journal égale à `entry` (à partir de `from`) ; échoue si absente. */
function indexOf(journal: string[], entry: string, from = 0): number {
  const index = journal.indexOf(entry, from);
  assert.ok(index >= 0, `absent du journal : ${entry}\n${journal.join("\n")}`);
  return index;
}

const abortsOf = (journal: string[], id: string) => journal.filter((e) => e === `POST /session/${id}/abort`).length;

describe("L1c : arrêt de l'arbre (unitaires)", () => {
  it("ordre des 6 étapes : demande marquée → file prise → refus de toutes les demandes de l'arbre → racine puis descendants occupés → file rendue → sonde → « once » tardif → marques, fait, événement", async (t) => {
    const s = unitSetup(t, {
      busy: [ROOT, CHILD, CONTROL, FOUND, OTHER],
      pending: [
        { id: "per_racine", sessionID: ROOT },
        { id: "per_enfant_a", sessionID: CHILD },
        { id: "per_enfant_b", sessionID: CHILD },
        { id: "per_trouvee", sessionID: FOUND },
        { id: "per_autre", sessionID: OTHER },
      ],
      // FOUND : sous-session pas encore suivie par le cockpit, trouvée par /children.
      children: { [ROOT]: [CHILD, CONTROL, FOUND] },
      // CHILD est un sous-agent « task » de la racine ; CONTROL (session de contrôle) n'est pas arrêtée avec elle.
      withParent: { [ROOT]: [CHILD] },
    });
    s.delegation("call_enfant", ROOT, CHILD, "travaille");
    s.delegation("call_trouvee", ROOT, FOUND, "autorisee");
    s.delegation("call_fini", ROOT, null, "terminee");
    s.delegation("call_autre", OTHER, null, "travaille");
    const changes = s.totalChanges();

    const result = await s.stopTree.run(ROOT, "vous");
    const j = s.journal;

    // 1. Demande d'autonomie marquée, avant toute prise de la file.
    const marked = indexOf(j, "interruption ses_racine vous");
    const taken = indexOf(j, "file:prise");
    assert.ok(marked < taken, "étape 1 avant la file");
    assert.deepEqual(s.interrupts, [[ROOT, "vous"]]);

    // 2. Dans la file : toutes les demandes de l'arbre refusées (suivies ou trouvées par /children), jamais celle d'une autre conversation.
    const released = indexOf(j, "file:rendue");
    const replies = j.map((e, i) => [e, i] as const).filter(([e]) => e.startsWith("POST /permission/"));
    assert.deepEqual(
      replies.map(([e]) => e),
      ["POST /permission/per_racine/reply", "POST /permission/per_enfant_a/reply", "POST /permission/per_enfant_b/reply", "POST /permission/per_trouvee/reply"],
    );
    assert.ok(replies.every(([, i]) => i > taken && i < released));
    for (const id of ["per_racine", "per_enfant_a", "per_enfant_b", "per_trouvee"]) assert.equal(s.gate.emitted.has(id), true, `${id} inscrite avant l'envoi`);
    assert.equal(s.gate.emitted.has("per_autre"), false);
    assert.deepEqual(s.pending, [{ id: "per_autre", sessionID: OTHER }]);

    // 3. Racine d'abord, après tous les refus ; puis chaque descendant encore occupé (contrôle et sous-session trouvée), dans la file.
    const rootAbort = indexOf(j, `POST /session/${ROOT}/abort`);
    assert.ok(replies.every(([, i]) => i < rootAbort), "refus avant les arrêts");
    for (const id of [CONTROL, FOUND]) {
      const index = indexOf(j, `POST /session/${id}/abort`);
      assert.ok(rootAbort < index && index < released, `${id} arrêtée après la racine, dans la file`);
    }
    assert.equal(abortsOf(j, CHILD), 0, "sous-agent déjà arrêté avec la racine : pas d'arrêt inutile");
    assert.equal(abortsOf(j, OTHER), 0, "autre conversation jamais arrêtée");
    assert.equal(j.slice(0, released).filter((e) => e.endsWith("/children")).length, 4, "sessions hors de l'arbre recherchées une seule fois");

    // 4. Sonde après la file ; tout est au repos : ni pause ni nouvel arrêt.
    const probe = indexOf(j, "GET /session/status", released);
    assert.deepEqual(s.sleeps, []);
    assert.equal(abortsOf(j, ROOT), 1);

    // 5. Nettoyage 1.0 dans la file, après la sonde.
    const cleanup = indexOf(j, "file:prise", probe);
    const cleanupList = indexOf(j, "GET /permission", cleanup);
    const cleanupReleased = indexOf(j, "file:rendue", cleanupList);

    // 6. Délégations en cours marquées, fait statut {cause: arret}, puis conversation.arretee en dernier.
    const firstMark = indexOf(j, "marque call_enfant arretee vous");
    indexOf(j, "marque call_trouvee arretee vous");
    const fact = indexOf(j, "fait statut arret");
    const event = indexOf(j, "evenement conversation.arretee");
    assert.ok(cleanupReleased < firstMark && firstMark < fact && fact < event && event === j.length - 1);
    assert.deepEqual(
      s.marks.map((m) => [m.callId, m.childSessionId, m.etat, m.par]),
      [
        ["call_enfant", CHILD, "arretee", "vous"],
        ["call_trouvee", FOUND, "arretee", "vous"],
      ],
    );
    // `debut` : heure du début de l'arrêt, pour dire « arrêtée » une session close par un refus, sans MessageAbortedError (L4c, L5a).
    assert.deepEqual(s.facts, [
      { rootId: ROOT, sessionId: ROOT, kind: "statut", ref: null, data: { cause: "arret", motif: "vous", nonConfirmees: 0, debut: s.now() - result.durationMs }, at: s.now() },
    ]);
    assert.deepEqual(s.events, [{ type: "conversation.arretee", data: { rootId: ROOT, cause: "vous", unconfirmed: [] } }]);

    // F-c : la seconde demande de la même session répond 404 et compte comme refusée.
    assert.equal(result.rejected, 4);
    assert.equal(result.rootId, ROOT);
    assert.equal(result.aborted[0], ROOT);
    assert.deepEqual([...result.aborted.slice(1)].sort(), [CONTROL, FOUND].sort());
    assert.deepEqual(result.unconfirmed, []);
    assert.equal(result.durationMs, 0);

    // P6 et écrivain unique : aucune route de configuration ni de libération, seulement des refus, aucune écriture directe en base.
    assert.deepEqual(
      s.calls.filter((c) => /^\/(global|instance)\b/.test(c.path)),
      [],
    );
    assert.ok(s.calls.filter((c) => c.path.startsWith("/permission/")).every((c) => JSON.stringify(c.body) === JSON.stringify({ reply: "reject" })));
    assert.equal(s.totalChanges(), changes, "aucune écriture directe : marques et faits passent par ports.facts, aucune table d'équipe (I14)");
  });

  it("sonde : toutes les 500 ms pendant 10 s, un seul nouvel arrêt, puis « arrêt non confirmé » ; délégation encore occupée non marquée", async (t) => {
    const s = unitSetup(t, { busy: [ROOT, CONTROL], pending: [], stubborn: [CONTROL] });
    s.delegation("call_controle", ROOT, CONTROL, "travaille");
    s.delegation("call_racine", ROOT, null, "travaille");
    const result = await s.stopTree.run(ROOT, "plafond-cout");

    assert.equal(STOP_PROBE_INTERVAL_MS, 500);
    assert.equal(STOP_PROBE_WINDOW_MS, 10_000);
    assert.deepEqual(s.sleeps, Array(21).fill(500), "20 pauses de sonde, puis une après le nouvel arrêt");
    assert.equal(abortsOf(s.journal, CONTROL), 2, "arrêt puis un seul nouvel arrêt");
    assert.equal(abortsOf(s.journal, ROOT), 1, "racine au repos : pas de nouvel arrêt");
    const secondAbort = s.journal.lastIndexOf(`POST /session/${CONTROL}/abort`);
    const lastProbePause = s.journal.map((e, i) => [e, i] as const).filter(([e]) => e === "pause 500")[19]?.[1] ?? Infinity;
    assert.ok(lastProbePause < secondAbort, "nouvel arrêt après les 10 s de sonde");
    assert.deepEqual(
      s.warns.filter((w) => w.message === "arrêt non confirmé"),
      [{ message: "arrêt non confirmé", fields: { rootId: ROOT, cause: "plafond-cout", sessions: [CONTROL] } }],
    );
    assert.deepEqual(result.unconfirmed, [CONTROL]);
    assert.equal(result.durationMs, 10_500);
    assert.deepEqual(s.events, [{ type: "conversation.arretee", data: { rootId: ROOT, cause: "plafond-cout", unconfirmed: [CONTROL] } }]);
    assert.deepEqual(
      s.marks.map((m) => [m.callId, m.par]),
      [["call_racine", "cockpit"]],
    );
    assert.deepEqual(s.facts[0]?.data, { cause: "plafond", motif: "plafond-cout", nonConfirmees: 1, debut: s.now() - result.durationMs });
    assert.equal(s.facts[0]?.at, s.now(), "le fait est écrit à la fin de l'arrêt, et porte son début");
    assert.deepEqual(s.interrupts, [[ROOT, "plafond-cout"]]);
  });

  it("sonde : repos atteint avant 10 s → la sonde s'arrête, aucun nouvel arrêt", async (t) => {
    let statusCalls = 0;
    const s = unitSetup(t, {
      busy: [ROOT, CONTROL],
      pending: [],
      stubborn: [CONTROL],
      onRequest: (method, path) => {
        if (method === "GET" && path === "/session/status" && ++statusCalls === 3) s.busy.delete(CONTROL);
      },
    });
    const result = await s.stopTree.run(ROOT, "vous");
    assert.deepEqual(s.sleeps, [500]);
    assert.equal(abortsOf(s.journal, CONTROL), 1);
    assert.deepEqual(result.unconfirmed, []);
    assert.equal(s.warns.some((w) => w.message === "arrêt non confirmé"), false);
  });

  it("états illisibles : chaque session de l'arbre est arrêtée dans la file, puis l'arrêt est dit non confirmé", async (t) => {
    const s = unitSetup(t, { busy: [ROOT, CHILD, CONTROL], pending: [], statusFails: true });
    const result = await s.stopTree.run(ROOT, "vous");
    const released = indexOf(s.journal, "file:rendue");
    for (const id of [ROOT, CHILD, CONTROL]) assert.ok(indexOf(s.journal, `POST /session/${id}/abort`) < released, `${id} arrêtée dans la file`);
    assert.deepEqual([...result.unconfirmed].sort(), [ROOT, CHILD, CONTROL].sort());
    assert.ok(s.warns.some((w) => w.message === "arrêt non confirmé"));
  });

  it("« once » tardif : une demande apparue après les refus est refusée par le nettoyage, après la sonde", async (t) => {
    const s = unitSetup(t, {
      busy: [ROOT, CHILD],
      pending: [],
      withParent: { [ROOT]: [CHILD] },
      onAbort: (id) => {
        if (id === ROOT) s.pending.push({ id: "per_tardive", sessionID: CHILD });
      },
    });
    await s.stopTree.run(ROOT, "vous");
    const probe = indexOf(s.journal, "GET /session/status", indexOf(s.journal, "file:rendue"));
    const cleanup = indexOf(s.journal, "file:prise", probe);
    assert.ok(indexOf(s.journal, "POST /permission/per_tardive/reply") > cleanup);
    assert.equal(s.gate.emitted.has("per_tardive"), true);
    assert.deepEqual(s.pending, []);
  });

  it("échéance de la file : refus qui ne répondent pas → arrêtés avant 30 s, la racine est quand même arrêtée dans la file", async (t) => {
    const s = unitSetup(t, {
      busy: [ROOT],
      pending: Array.from({ length: 10 }, (_, i) => ({ id: `per_${i}`, sessionID: ROOT })),
      onRequest: (method, path) => {
        if (method === "POST" && path.startsWith("/permission/")) {
          s.advance(6_000);
          throw new Error("The operation was aborted due to timeout");
        }
      },
    });
    const result = await s.stopTree.run(ROOT, "vous");
    const released = indexOf(s.journal, "file:rendue");
    const sent = s.journal.slice(0, released).filter((e) => e.startsWith("POST /permission/"));
    assert.equal(sent.length, 4, "refus envoyés tant que l'échéance de 20 s n'est pas passée");
    assert.ok(indexOf(s.journal, `POST /session/${ROOT}/abort`) < released, "racine arrêtée malgré l'échéance");
    const [taken, freed] = [s.times.find(([e]) => e === "prise")?.[1] ?? 0, s.times.find(([e]) => e === "rendue")?.[1] ?? Infinity];
    assert.ok(freed - taken < 30_000, `file tenue ${freed - taken} ms (libération d'office à 30 s)`);
    assert.ok(freed - taken >= STOP_PHASE_BUDGET_MS);
    assert.ok(s.warns.some((w) => w.message === "arrêt : appels sautés, échéance de la file des réponses atteinte"));
    assert.equal(result.rejected, 0);
    assert.equal(result.aborted[0], ROOT);
  });

  it("un seul arrêt à la fois par racine : un second appel pendant l'arrêt rend le même résultat ; un appel suivant arrête de nouveau", async (t) => {
    const s = unitSetup(t, { busy: [ROOT], pending: [] });
    const first = s.stopTree.run(ROOT, "vous");
    const second = s.stopTree.run(ROOT, "plafond-cout");
    assert.equal(first, second);
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, b);
    assert.equal(abortsOf(s.journal, ROOT), 1);
    assert.deepEqual(s.interrupts, [[ROOT, "vous"]]);
    await s.stopTree.run(ROOT, "vous");
    assert.equal(abortsOf(s.journal, ROOT), 2);
  });

  it("étape 1 limitée à la demande d'autonomie (I14) : fin selon la cause, aucune fin inventée, échec de marquage sans effet sur l'arrêt", async (t) => {
    assert.deepEqual(REQUEST_END_OF_STOP, {
      vous: "vous",
      "plafond-cout": "plafond-cout",
      "non-controle": "non-controle",
      rechargement: "rechargement",
      "plafond-delegations": null,
      equipe: null,
    });
    assert.deepEqual(STATUT_CAUSE_OF_STOP, {
      vous: "arret",
      "plafond-cout": "plafond",
      "plafond-delegations": "plafond",
      "non-controle": "non-controle",
      rechargement: "interrompue",
      equipe: "arret",
    });
    assert.deepEqual(RUNNING_DELEGATION_STATES, ["autorisee", "travaille"]);

    const s = unitSetup(t, { busy: [ROOT], pending: [] });
    await s.stopTree.run(ROOT, "plafond-delegations");
    assert.deepEqual(s.interrupts, [], "aucune valeur de fin pour cette cause : demande non marquée");
    assert.deepEqual(s.facts[0]?.data, { cause: "plafond", motif: "plafond-delegations", nonConfirmees: 0, debut: s.now() });

    s.setInterrupt(() => {
      throw new Error("demande illisible");
    });
    const result = await s.stopTree.run(ROOT, "non-controle");
    assert.equal(result.aborted[0], ROOT, "arrêt mené malgré l'échec du marquage");
    assert.ok(s.warns.some((w) => w.message === "arrêt : demande d'autonomie non marquée"));
    assert.deepEqual(s.facts[1]?.data, { cause: "non-controle", motif: "non-controle", nonConfirmees: 0, debut: s.now() });
  });

  it("stoppableRoot : racine suivie, sans parent, principale, hors classement ; sinon run() refuse sans appeler opencode", async (t) => {
    const s = unitSetup(t, { busy: [], pending: [] });
    assert.equal(stoppableRoot(s.sessions, ROOT)?.id, ROOT);
    assert.equal(stoppableRoot(s.sessions, "ses_inconnue"), null);
    assert.equal(stoppableRoot(s.sessions, CHILD), null, "enfant");
    // Ligne incohérente (parent renseigné, root_id égal à l'identifiant) : une session qui a un parent n'est jamais une racine.
    s.add("ses_orpheline");
    s.db.prepare("UPDATE sessions SET parent_id = ? WHERE id = ?").run(ROOT, "ses_orpheline");
    assert.equal(stoppableRoot(s.sessions, "ses_orpheline"), null, "session avec un parent");
    assert.equal(stoppableRoot(s.sessions, "ses.point"), null, "identifiant invalide");
    s.add("ses_cachee", undefined, { cockpit: "classifier" });
    assert.equal(stoppableRoot(s.sessions, "ses_cachee"), null, "classement");
    s.add("ses_salle");
    s.db.prepare("UPDATE sessions SET instance = 'omo' WHERE id = ?").run("ses_salle");
    assert.equal(stoppableRoot(s.sessions, "ses_salle"), null, "Salle OMO : stopTreeOmo, pas stopTree");
    await assert.rejects(s.stopTree.run(CHILD, "vous"), StopRootUnknownError);
    assert.deepEqual(s.calls, []);
    assert.deepEqual(s.interrupts, []);
  });
});

// --- Intégration : faux opencode et harnais du cockpit ---------------------------------------------------------------------------

/** Conversation créée par le proxy, suivie par le cockpit. */
async function trackedRoot(h: CockpitHarness, title: string): Promise<FakeSession> {
  const created = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title } });
  assert.equal(created.status, 200, created.body);
  const session = created.json<FakeSession>();
  await until(() => h.sessions.get(session.id));
  return session;
}

/** Sous-session créée par le serveur (contrôle, étape) : un arrêt de la racine ne l'arrête pas. */
async function trackedChild(h: CockpitHarness, parentID: string, metadata?: Record<string, unknown>): Promise<FakeSession> {
  const child = await h.deps.client.request<FakeSession>("POST", "/session", { body: { parentID, title: "Sous-session", ...(metadata ? { metadata } : {}) } });
  await until(() => h.sessions.get(child.id)?.root_id === parentID);
  return child;
}

async function sendThroughProxy(h: CockpitHarness, sessionId: string, text: string): Promise<void> {
  const sent = await h.call("POST", `/api/oc/session/${sessionId}/prompt_async`, {
    headers: h.headers.mutating,
    body: { agent: "build", model: MODEL, parts: [{ type: "text", text }] },
  });
  assert.equal(sent.status, 204, sent.body);
}

const delegate = (description: string, extra: Record<string, unknown> = {}) => ({
  tool: "task",
  input: { description, prompt: `Consigne : ${description}`, subagent_type: "general" },
  child: { agent: "general", workMs: 60_000 },
  ...extra,
});

describe("L1c : route, crochet du proxy et arrêt sur le faux opencode", () => {
  it("route POST /api/conversations/:rootId/stop : 400, 401, 403 CSRF, 404 (inconnue, enfant, classement, Salle OMO), 200 ; crochet : racine suivie → stopTree, sinon relais 1.0", async (t) => {
    const calls: Array<[string, StopCause]> = [];
    const spy: StopTreePort = {
      run: async (rootId, cause) => {
        calls.push([rootId, cause]);
        return { rootId, rejected: 0, aborted: [rootId], unconfirmed: [], durationMs: 1 };
      },
    };
    const h = await startCockpit(t, { modules: ["stopTree"], ports: { stopTree: spy } });
    const root = await trackedRoot(h, "Route");
    const child = await trackedChild(h, root.id);
    const hidden = await trackedRoot(h, "Classement");
    h.db.prepare("UPDATE sessions SET purpose = 'classifier' WHERE id = ?").run(hidden.id);
    const room = await trackedRoot(h, "Salle");
    h.db.prepare("UPDATE sessions SET instance = 'omo' WHERE id = ?").run(room.id);
    const stop = (id: string, headers: Record<string, string> = h.headers.mutating) => h.call("POST", `/api/conversations/${id}/stop`, { headers });

    for (const bad of ["ses.point", "a".repeat(129)]) {
      const res = await stop(bad);
      assert.equal(res.status, 400, res.body);
      assert.deepEqual(res.json(), { error: "invalid", message: "Identifiant de conversation invalide." });
    }
    const noCsrf = await stop(root.id, h.headers.authed);
    assert.equal(noCsrf.status, 403, noCsrf.body);
    assert.equal(noCsrf.json<{ error: string }>().error, "csrf");
    assert.equal((await stop(root.id, {})).status, 401);
    for (const id of ["ses_inconnue", child.id, hidden.id, room.id]) {
      const res = await stop(id);
      assert.equal(res.status, 404, `${id} : ${res.body}`);
      assert.deepEqual(res.json(), { error: "not-found", message: "Conversation introuvable." });
    }
    assert.deepEqual(calls, [], "aucun arrêt pour une demande refusée");

    const ok = await stop(root.id);
    assert.equal(ok.status, 200, ok.body);
    assert.deepEqual(ok.json<StopResult>(), { rootId: root.id, rejected: 0, aborted: [root.id], unconfirmed: [], durationMs: 1 });
    assert.deepEqual(calls, [[root.id, "vous"]]);

    // Proxy : enfant et session non suivie relayés comme en 1.0 ; racine suivie → stopTree, aucun relais direct.
    for (const id of [child.id, "ses_pas_suivie"]) {
      const relayed = await h.call("POST", `/api/oc/session/${id}/abort`, { headers: h.headers.mutating });
      assert.equal(relayed.status, 200, relayed.body);
      assert.equal(relayed.json(), true);
      assert.ok(h.fake.requests.some((r) => r.method === "POST" && r.pathname === `/session/${id}/abort`), `${id} relayé`);
    }
    const hooked = await h.call("POST", `/api/oc/session/${root.id}/abort`, { headers: h.headers.mutating });
    assert.equal(hooked.status, 200, hooked.body);
    assert.equal(hooked.json<StopResult>().rootId, root.id);
    assert.equal(h.fake.requests.some((r) => r.pathname === `/session/${root.id}/abort`), false, "arrêt de la racine confié à stopTree");
    assert.deepEqual(calls, [
      [root.id, "vous"],
      [root.id, "vous"],
    ]);
    h.assertNoGlobalRestart();

    // Sans le module (ports neutres) : route absente → 404, repli du navigateur sur l'arrêt 1.0.
    const neutral = await startCockpit(t);
    const absent = await neutral.call("POST", "/api/conversations/ses_x/stop", { headers: neutral.headers.mutating });
    assert.equal(absent.status, 404, absent.body);
  });

  it("enfant occupé après l'arrêt de la racine : la session de contrôle est arrêtée dans la foulée (sans attendre la sonde) ; demande marquée, délégation marquée et fait écrit (espions sur ports.facts) ; P6", async (t) => {
    const facts: ActivityFact[] = [];
    const marks: Array<{ callId: string; etat: DelegationState; par: RepliedBy | null }> = [];
    const interrupts: Array<[string, string]> = [];
    const h = await startCockpit(t, {
      modules: ["stopTree"],
      ports: {
        facts: {
          append: (list) => facts.push(...list),
          since: () => ({ facts: [], partial: false }),
          work: {
            markDelegation: (d, etat, par) => {
              marks.push({ callId: d.callId, etat, par });
              return true;
            },
            markWait: () => false,
          },
        },
        requests: { current: () => null, spent: () => 0, interrupt: (rootId, fin) => interrupts.push([rootId, fin]) },
      },
    });
    const root = await trackedRoot(h, "Racine occupée");
    h.fake.script(root.id, { tools: [delegate("Analyser les journaux")] });
    await sendThroughProxy(h, root.id, "Analyse.");
    const delegated = ((await h.fake.waitForEvent("session.created", (p) => (p.info as FakeSession).parentID === root.id)).properties.info as FakeSession).id;

    const control = await trackedChild(h, root.id, { cockpit: "controle" });
    h.fake.script(control.id, { tools: [delegate("Vérifier")] });
    assert.equal(await promptAsync(h.deps.client, control.id, "Vérifie."), 204);
    await until(() => h.fake.statusOf(root.id).type === "busy" && h.fake.statusOf(delegated).type === "busy" && h.fake.statusOf(control.id).type === "busy");
    await until(() => h.sessions.get(delegated));
    assert.equal(h.sessions.get(control.id)?.purpose, "controle");
    // Délégation en cours (écrite en production par la dérivation des faits de L4b).
    h.db
      .prepare("INSERT INTO delegations (root_id, parent_session_id, child_session_id, call_id, agent, source, state, created_at) VALUES (?, ?, ?, 'call_journaux', 'general', 'ia', 'travaille', ?)")
      .run(root.id, root.id, delegated, Date.now());

    const since = h.fake.requests.length;
    const res = await h.call("POST", `/api/conversations/${root.id}/stop`, { headers: h.headers.mutating });
    assert.equal(res.status, 200, res.body);
    const result = res.json<StopResult>();
    assert.equal(result.aborted[0], root.id);
    assert.ok(result.aborted.includes(control.id), `contrôle arrêté : ${JSON.stringify(result)}`);
    assert.deepEqual(result.unconfirmed, []);
    assert.ok(result.durationMs < STOP_PROBE_WINDOW_MS, `arrêté dans la file, sans attendre la sonde (${result.durationMs} ms)`);
    const requests = h.fake.requests.slice(since).map((r) => `${r.method} ${r.pathname}`);
    assert.ok(requests.indexOf(`POST /session/${root.id}/abort`) < requests.indexOf(`POST /session/${control.id}/abort`), "racine d'abord");
    assert.equal(requests.filter((r) => r === `POST /session/${control.id}/abort`).length, 1);

    await within(Promise.all([h.fake.settled(root.id), h.fake.settled(delegated), h.fake.settled(control.id)]), "arbre arrêté");
    assert.deepEqual(await h.deps.client.request("GET", "/session/status"), {}, "aucune session occupée");
    assert.deepEqual(interrupts, [[root.id, "vous"]]);
    assert.deepEqual(marks, [{ callId: "call_journaux", etat: "arretee", par: "vous" }]);
    assert.deepEqual(
      facts.map((f) => [f.rootId, f.sessionId, f.kind, f.data.cause]),
      [[root.id, root.id, "statut", "arret"]],
    );
    assert.deepEqual(
      h.cockpitEvents().filter((e) => e.type === "conversation.arretee"),
      [{ type: "conversation.arretee", data: { rootId: root.id, cause: "vous", unconfirmed: [] } }],
    );
    h.assertNoGlobalRestart();
  });

  it("fixture p6 : un arrêt seul laisse la délégation en attente (capture réelle) ; « Arrêter » par le proxy la refuse d'abord, arrête l'enfant puis la racine, et le « once » tardif (p7) est refusé", async (t) => {
    // Capture réelle : arrêt de la racine pendant qu'un enfant travaille et qu'une seconde délégation attend ; aucune réponse à la demande.
    const rows = readCapture("p6-arret-global.jsonl").map((r) => r.wire);
    const created = rows.find((w) => w.payload.type === "session.created");
    const info = created && "properties" in created.payload ? (created.payload.properties?.info as FakeSession) : undefined;
    assert.ok(info?.parentID);
    const captured = trace(rows, { [info.parentID]: "racine", [info.id]: "enfant" });
    assertSubsequence(captured, ["permission.asked@racine", "session.error:MessageAbortedError@enfant", "session.error:MessageAbortedError@racine"]);
    assert.equal(captured.some((e) => e.startsWith("permission.replied")), false, "p6 : la demande reste en attente après l'arrêt");

    // Même scénario sur le faux, par le cockpit.
    const h = await startCockpit(t, { modules: ["stopTree"] });
    const root = await trackedRoot(h, "Arrêt p6");
    h.fake.script(root.id, {
      tools: [
        delegate("Analyser les journaux .log"),
        {
          tool: "task",
          input: { description: "Analyser changements.md", prompt: "Lis changements.md", subagent_type: "general" },
          ask: { permission: "task", patterns: ["general"], metadata: { description: "Analyser changements.md", subagent_type: "general" } },
          child: { agent: "general", text: "Deux changements." },
        },
      ],
    });
    await sendThroughProxy(h, root.id, "Consulte les deux analystes.");
    const asked = (await h.fake.waitForEvent("permission.asked", (p) => p.sessionID === root.id)).properties as unknown as FakePermissionRequest;
    const child = ((await h.fake.waitForEvent("session.created", (p) => (p.info as FakeSession).parentID === root.id)).properties.info as FakeSession).id;
    await until(() => h.fake.statusOf(child).type === "busy" && h.sessions.get(child));

    const since = h.fake.emitted.length;
    const res = await h.call("POST", `/api/oc/session/${root.id}/abort`, { headers: h.headers.mutating });
    assert.equal(res.status, 200, res.body);
    const result = res.json<StopResult>();
    assert.equal(result.rejected, 1);
    assert.equal(result.aborted[0], root.id);
    assert.deepEqual(result.unconfirmed, []);
    const stopped = trace(h.fake.emitted.slice(since), { [root.id]: "racine", [child]: "enfant" });
    assertSubsequence(stopped, ["permission.replied:reject@racine", "session.error:MessageAbortedError@enfant", "session.error:MessageAbortedError@racine"]);
    assert.deepEqual(await h.deps.client.request("GET", "/permission"), [], "aucune demande laissée en attente");
    assert.deepEqual(await h.deps.client.request("GET", "/session/status"), {});
    assert.equal(h.cockpit.gate.emitted.has(asked.id), true);

    const sinceLate = h.fake.emitted.length;
    const late = await h.call("POST", `/api/oc/permission/${asked.id}/reply`, { headers: h.headers.mutating, body: { reply: "once" } });
    assert.equal(late.status, 409, late.body);
    assert.equal(late.json<{ error: string }>().error, "demande-expiree");
    assert.deepEqual(
      h.fake.requests.filter((r) => r.method === "POST" && r.pathname === `/permission/${asked.id}/reply`).map((r) => r.body),
      [{ reply: "reject" }],
    );
    assert.equal(h.fake.emitted.slice(sinceLate).some((w) => w.payload.type === "session.created"), false, "aucun sous-agent détaché (p7)");
    h.assertNoGlobalRestart();
  });
});
