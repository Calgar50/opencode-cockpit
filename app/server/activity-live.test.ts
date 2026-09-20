// « Qui travaille ? » dans le navigateur (plan d'exécution, fiche L5b ; spécification §3.10 point 4, §5.1, §5.4, §5.5, §5.6) :
// magasin d'activité (web/lib/useActivity.ts, sans React ni DOM : source et horloge factices), annonceur de la page
// (web/lib/announcer.ts) et textes (server/shared/activity-texts.ts).
// Gardes prouvées (chacune tuée par une mutation, hors dépôt) : au plus 4 rendus par seconde ; rien d'une session hors de l'arbre ;
// relecture à l'ouverture et sur stream.reconnected, la plus récente l'emporte, rien après l'arrêt ; ce qu'une relecture révèle
// n'est pas annoncé ; au plus une annonce toutes les 2 s, rien dit ni gardé quand les annonces sont coupées ; arbre au travail
// (« Arrêter » visible) ; bandeau jamais pour la seule IA ; premier bandeau écrit une fois ; [Voir le travail] jamais sur le
// contrôle de sécurité ; détail d'outil masqué, raccourci, jamais une commande.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Announcer, ANNOUNCE_MAX_PENDING } from "../web/lib/announcer.ts";
import {
  type ActivityClock,
  type ActivitySource,
  ActivityStore,
  bannerVisible,
  DURATION_TICK_MS,
  demandeEnAttente,
  mainRow,
  ONBOARDING_KEY,
  onboardingToSave,
  opensWork,
  RENDER_MIN_INTERVAL_MS,
  replierPendantLaDemande,
  SEEN_ONBOARDING_MAX,
  seenOnboardingWith,
  treeWorking,
} from "../web/lib/useActivity.ts";
import type { BrowserEvent } from "../web/lib/types.ts";
import { type ActivityAnnouncement, ANNOUNCE_MIN_INTERVAL_MS, activityStatus, emptyActivity, type LiveRow, liveRows, replayFacts } from "./shared/activity.ts";
import { detailOutil, libelleEnPlus, libelleEtatActeur, nomActeur, phraseAnnonce, phrasesAnnonces, TEXTES } from "./shared/activity-texts.ts";
import type { ActivityFact, ActorState, FactsResponse, FactValue } from "./shared/activity-types.ts";

const ROOT = "ses_racine0000000000000001";
const CHILD = "ses_enfant0000000000000002";
const OTHER = "ses_ailleurs00000000000003";
const CONTROL = "ses_controle00000000000004";
const DIR = "/workspace/projet";
const T0 = 1_790_000_000_000;

// --- Aides ------------------------------------------------------------------------------------------------------------------------

function fact(sessionId: string, kind: ActivityFact["kind"], at: number, data: Record<string, FactValue>, ref: string | null = null): ActivityFact {
  return { rootId: ROOT, sessionId, kind, ref, data, at };
}

const occupee = (sessionId: string, at: number) => fact(sessionId, "statut", at, { etat: "occupee" });
const repos = (sessionId: string, at: number) => fact(sessionId, "statut", at, { etat: "repos" });
const creee = (sessionId: string, at: number, agent = "general") =>
  fact(sessionId, "statut", at, { etat: "creee", role: "delegation", parent: ROOT, agent, instance: "principale" });
const attente = (sessionId: string, at: number, permissionId: string) =>
  fact(sessionId, "attente", at, { permission: "bash", messageId: "msg_1", callId: "call_b", agent: null }, permissionId);

const factEvent = (data: ActivityFact): BrowserEvent => ({ kind: "cockpit", type: "activite.fait", data });
const opencode = (type: string, properties: Record<string, unknown>): BrowserEvent => ({ kind: "opencode", event: { type, properties } });
const toolPart = (sessionID: string, callID: string, tool: string, status: string, input: Record<string, unknown>) =>
  opencode("message.part.updated", { part: { type: "tool", sessionID, messageID: "msg_1", callID, tool, state: { status, input } } });

/** Horloge manuelle : `advance` exécute les minuteries échues dans l'ordre. */
class FakeClock implements ActivityClock {
  t = T0;
  #seq = 0;
  timers: Array<{ id: number; at: number; fn: () => void }> = [];
  readonly now = () => this.t;
  readonly setTimer = (fn: () => void, ms: number) => {
    const id = ++this.#seq;
    this.timers.push({ id, at: this.t + ms, fn });
    return id;
  };
  readonly clearTimer = (handle: unknown) => {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  };
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.t = due.at;
      due.fn();
    }
    this.t = end;
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((ok, ko) => {
    resolve = ok;
    reject = ko;
  });
  return { promise, resolve, reject };
}

/**
 * Source factice : chaque lecture des faits attend sa réponse (`pending`) ; informations, enfants et messages par session
 * (asSource). Informations d'une session non déclarée : son identifiant seul ; une Error déclarée : lecture en échec.
 */
class FakeSource {
  pending: Array<Deferred<FactsResponse>> = [];
  sessions = new Map<string, unknown>();
  children = new Map<string, unknown[]>();
  messages = new Map<string, unknown[]>();
  calls: string[] = [];
  readonly facts = (rootId: string) => {
    this.calls.push(`facts:${rootId}`);
    const next = deferred<FactsResponse>();
    this.pending.push(next);
    return next.promise;
  };
  readonly sessionOf = async (sessionId: string) => {
    this.calls.push(`session:${sessionId}`);
    const info = this.sessions.get(sessionId) ?? { id: sessionId };
    if (info instanceof Error) throw info;
    return info;
  };
  readonly childrenOf = async (sessionId: string) => {
    this.calls.push(`children:${sessionId}`);
    return this.children.get(sessionId) ?? [];
  };
  readonly messagesOf = async (sessionId: string) => {
    this.calls.push(`messages:${sessionId}`);
    return this.messages.get(sessionId) ?? [];
  };
  asSource(): ActivitySource {
    return { facts: this.facts, session: this.sessionOf, children: this.childrenOf, messages: this.messagesOf };
  }
}

/** Laisse passer les promesses en cours (relecture : faits, enfants niveau par niveau, messages). */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function setup(options: { announce?: (items: readonly ActivityAnnouncement[]) => void } = {}) {
  const clock = new FakeClock();
  const source = new FakeSource();
  const store = new ActivityStore(ROOT, DIR, source.asSource(), clock, options.announce);
  let renders = 0;
  const renderTimes: number[] = [];
  store.subscribe(() => {
    renders++;
    renderTimes.push(clock.t);
  });
  return { clock, source, store, renders: () => renders, renderTimes };
}

/** Ouvre la conversation avec des faits persistés et laisse la relecture finir. */
async function opened(facts: ActivityFact[], options: { announce?: (items: readonly ActivityAnnouncement[]) => void } = {}) {
  const env = setup(options);
  env.store.start();
  env.source.pending.shift()?.resolve({ facts, partial: false });
  await flush();
  env.clock.advance(RENDER_MIN_INTERVAL_MS);
  return env;
}

const rowOf = (store: ActivityStore, sessionId: string) => store.getSnapshot().rows.find((row) => row.sessionId === sessionId && !row.sansSession);

// --- Magasin ----------------------------------------------------------------------------------------------------------------------

describe("useActivity : relecture", () => {
  it("à l'ouverture : faits persistés, titres de l'arbre, titre et assistant de la conversation elle-même ; aucun message lu pour une conversation qui a des faits", async () => {
    const env = setup();
    // GET /session/:id d'opencode 1.18.30 : titre et assistant de la dernière demande (ceux que session.updated donne en direct).
    env.source.sessions.set(ROOT, { id: ROOT, title: "Analyse des journaux", agent: "orchestrateur" });
    env.source.children.set(ROOT, [{ id: CHILD, parentID: ROOT, title: "Recherche" }]);
    env.store.start();
    assert.equal(env.store.getSnapshot().loaded, false);
    env.source.pending.shift()?.resolve({ facts: [occupee(ROOT, T0 - 5_000), creee(CHILD, T0 - 4_000), occupee(CHILD, T0 - 4_000)], partial: false });
    await flush();
    env.clock.advance(RENDER_MIN_INTERVAL_MS);
    const view = env.store.getSnapshot();
    assert.equal(view.loaded, true);
    assert.equal(view.failed, false);
    assert.deepEqual(
      view.rows.map((row) => [row.sessionId, row.state, row.title]),
      [
        [ROOT, "travaille", "Analyse des journaux"],
        [CHILD, "travaille", "Recherche"],
      ],
    );
    assert.equal(rowOf(env.store, ROOT)?.agent, "orchestrateur");
    assert.equal(view.working, true);
    assert.deepEqual(env.source.calls, [`facts:${ROOT}`, `session:${ROOT}`, `children:${ROOT}`, `children:${CHILD}`]);
  });

  it("rouvert = direct pour la conversation elle-même : même titre et même assistant qu'un onglet ouvert avant (session.updated, message.updated)", async () => {
    const info = { id: ROOT, title: "Analyse des journaux", agent: "orchestrateur" };
    const persisted = [occupee(ROOT, T0 - 5_000)];
    const live = await opened([]);
    live.store.push(opencode("session.updated", { info }));
    live.store.push(opencode("message.updated", { info: { id: "msg_u", sessionID: ROOT, role: "user", agent: "orchestrateur", time: { created: T0 - 5_000 } } }));
    for (const fact of persisted) live.store.push(factEvent(fact));
    live.clock.advance(RENDER_MIN_INTERVAL_MS);
    const env = setup();
    env.source.sessions.set(ROOT, info);
    env.store.start();
    env.source.pending.shift()?.resolve({ facts: persisted, partial: false });
    await flush();
    env.clock.advance(RENDER_MIN_INTERVAL_MS);
    const strip = (rows: readonly LiveRow[]) => rows.map(({ durationMs: _durationMs, ...row }) => row);
    assert.deepEqual(strip(env.store.getSnapshot().rows), strip(live.store.getSnapshot().rows));
    assert.deepEqual([rowOf(env.store, ROOT)?.title, rowOf(env.store, ROOT)?.agent], ["Analyse des journaux", "orchestrateur"]);
  });

  it("informations de la conversation illisibles : seulement sautées (ni échec ni [Réessayer]), comme les titres de l'arbre", async (t) => {
    const warn = t.mock.method(console, "warn", () => undefined);
    const env = setup();
    env.source.sessions.set(ROOT, new Error("opencode ne répond pas"));
    env.source.children.set(ROOT, [{ id: CHILD, parentID: ROOT, title: "Recherche" }]);
    env.store.start();
    env.source.pending.shift()?.resolve({ facts: [occupee(ROOT, T0 - 5_000), creee(CHILD, T0 - 4_000)], partial: false });
    await flush();
    env.clock.advance(RENDER_MIN_INTERVAL_MS);
    const view = env.store.getSnapshot();
    assert.deepEqual([view.loaded, view.failed], [true, false]);
    assert.deepEqual(view.rows.map((row) => [row.sessionId, row.title]), [
      [ROOT, ""],
      [CHILD, "Recherche"],
    ]);
    assert.equal(warn.mock.callCount(), 1);
  });

  it("conversation sans faits (avant la 1.1) : reconstruite depuis les messages de la racine et des sessions déléguées", async () => {
    const env = setup();
    env.source.children.set(ROOT, [{ id: CHILD, parentID: ROOT, title: "Recherche", time: { created: T0 - 9_000 } }]);
    const assistant = (sessionID: string, id: string, created: number, completed: number) => ({
      info: { id, sessionID, role: "assistant", time: { created, completed } },
      parts: [{ type: "step-start" }, { type: "step-finish", cost: 0.01, reason: "stop" }],
    });
    env.source.messages.set(ROOT, [assistant(ROOT, "msg_r", T0 - 10_000, T0 - 2_000)]);
    env.source.messages.set(CHILD, [assistant(CHILD, "msg_c", T0 - 9_000, T0 - 3_000)]);
    env.store.start();
    env.source.pending.shift()?.resolve({ facts: [], partial: false });
    await flush();
    env.clock.advance(RENDER_MIN_INTERVAL_MS);
    const view = env.store.getSnapshot();
    assert.equal(view.state.source, "messages");
    assert.deepEqual(view.rows.map((row) => [row.sessionId, row.state]), [
      [ROOT, "termine"],
      [CHILD, "termine"],
    ]);
    assert.ok(env.source.calls.includes(`messages:${ROOT}`) && env.source.calls.includes(`messages:${CHILD}`));
  });

  it("arbre lu sur 3 niveaux et 50 sessions au plus", async () => {
    const listedWith = async (children: Map<string, unknown[]>) => {
      const env = setup();
      env.source.children = children;
      env.store.start();
      env.source.pending.shift()?.resolve({ facts: [occupee(ROOT, T0)], partial: false });
      await flush();
      return env.source.calls.filter((c) => c.startsWith("children:"));
    };
    const chain = [ROOT, "ses_n1", "ses_n2", "ses_n3", "ses_n4"];
    const deep = await listedWith(new Map(chain.slice(0, -1).map((id, i) => [id, [{ id: chain[i + 1], parentID: id }]])));
    assert.deepEqual(deep, [`children:${ROOT}`, "children:ses_n1", "children:ses_n2"], "le 4e niveau n'est jamais lu");
    const wide = await listedWith(new Map([[ROOT, Array.from({ length: 60 }, (_, i) => ({ id: `ses_large${i}`, parentID: ROOT }))]]));
    assert.equal(wide.length, 1 + 50, "50 sessions au plus");
  });

  it("stream.reconnected : nouvelle relecture ; les faits arrivés pendant la coupure apparaissent", async () => {
    const env = await opened([occupee(ROOT, T0 - 1_000)]);
    env.store.push({ kind: "cockpit", type: "stream.reconnected", data: null });
    assert.equal(env.source.calls.filter((c) => c.startsWith("facts:")).length, 2);
    env.source.pending.shift()?.resolve({ facts: [occupee(ROOT, T0 - 1_000), repos(ROOT, T0 - 500)], partial: false });
    await flush();
    env.clock.advance(RENDER_MIN_INTERVAL_MS);
    assert.equal(rowOf(env.store, ROOT)?.state, "termine");
    assert.equal(env.store.getSnapshot().working, false);
  });

  it("une relecture dépassée par une plus récente est ignorée", async () => {
    const env = await opened([]);
    env.store.push({ kind: "cockpit", type: "stream.reconnected", data: null });
    env.store.push({ kind: "cockpit", type: "stream.reconnected", data: null });
    const [older, newer] = env.source.pending.splice(0, 2);
    newer?.resolve({ facts: [occupee(ROOT, T0 - 1_000), repos(ROOT, T0 - 500)], partial: false });
    await flush();
    older?.resolve({ facts: [occupee(ROOT, T0 - 1_000), fact(ROOT, "statut", T0 - 400, { etat: "erreur", erreur: "ProviderError" })], partial: true });
    await flush();
    env.clock.advance(RENDER_MIN_INTERVAL_MS);
    const view = env.store.getSnapshot();
    assert.equal(rowOf(env.store, ROOT)?.state, "termine");
    assert.equal(view.partial, false);
    assert.equal(view.state.facts.some((f) => f.data.etat === "erreur"), false);
  });

  it("stop : relecture en cours ignorée, minuteries arrêtées, flux ignoré ; start relit", async () => {
    const env = setup();
    env.store.start();
    env.store.stop();
    env.source.pending.shift()?.resolve({ facts: [occupee(ROOT, T0 - 1_000)], partial: false });
    await flush();
    env.clock.advance(5_000);
    assert.equal(env.renders(), 0);
    assert.equal(env.store.getSnapshot().loaded, false);
    env.store.push(factEvent(occupee(ROOT, T0)));
    assert.equal(env.clock.timers.length, 0);
    env.store.start();
    assert.equal(env.source.calls.filter((c) => c.startsWith("facts:")).length, 2);
    env.source.pending.shift()?.resolve({ facts: [], partial: false });
    await flush();
    env.clock.advance(RENDER_MIN_INTERVAL_MS);
    assert.equal(env.store.getSnapshot().loaded, true);
    assert.equal(env.store.getSnapshot().state.facts.length, 0, "un fait reçu pendant l'arrêt n'est jamais appliqué");
  });

  it("faits illisibles : échec dit ([Réessayer]), le direct continue ; une relecture réussie efface l'échec", async (t) => {
    t.mock.method(console, "warn", () => undefined);
    const env = setup();
    env.store.start();
    env.source.pending.shift()?.reject(new Error("Le cockpit ne répond pas"));
    await flush();
    env.clock.advance(RENDER_MIN_INTERVAL_MS);
    assert.equal(env.store.getSnapshot().failed, true);
    assert.equal(env.store.getSnapshot().loaded, true);
    env.store.push(factEvent(occupee(ROOT, T0)));
    env.clock.advance(RENDER_MIN_INTERVAL_MS);
    assert.equal(rowOf(env.store, ROOT)?.state, "travaille");
    void env.store.reload();
    env.source.pending.shift()?.resolve({ facts: [occupee(ROOT, T0)], partial: false });
    await flush();
    env.clock.advance(RENDER_MIN_INTERVAL_MS);
    assert.equal(env.store.getSnapshot().failed, false);
  });
});

describe("useActivity : rendus et flux", () => {
  it("au plus 4 rendus par seconde, sans perdre un seul fait", async () => {
    const env = await opened([occupee(ROOT, T0 - 1_000)]);
    const before = env.renders();
    const start = env.clock.t;
    for (let i = 0; i < 40; i++) {
      env.store.push(factEvent(fact(ROOT, "statut", T0 + i, { etat: "appel", messageId: `msg_${i}` }, `msg_${i}`)));
      env.clock.advance(25);
    }
    env.clock.advance(RENDER_MIN_INTERVAL_MS);
    const times = env.renderTimes.slice(before);
    for (const at of times) {
      const inWindow = times.filter((other) => other >= at && other < at + 1_000).length;
      assert.ok(inWindow <= 4, `${inWindow} rendus en une seconde à partir de ${at - start} ms`);
    }
    assert.ok(times.length >= 4, "les rendus continuent pendant la rafale");
    assert.equal(rowOf(env.store, ROOT)?.calls, 40);
  });

  it("rien d'une session hors de l'arbre ; deltas jamais lus", async () => {
    const env = await opened([occupee(ROOT, T0 - 1_000)]);
    const before = env.renders();
    const state = env.store.getSnapshot().state;
    env.store.push(opencode("message.part.delta", { sessionID: ROOT, messageID: "msg_1", partID: "prt_1", field: "text", delta: "Bonjour" }));
    env.store.push(toolPart(OTHER, "call_x", "read", "running", { filePath: `${DIR}/secret.txt` }));
    env.store.push(opencode("session.created", { info: { id: OTHER, parentID: "ses_inconnue", title: "Ailleurs" } }));
    env.store.push(opencode("message.updated", { info: { id: "msg_u", sessionID: OTHER, role: "user", agent: "build", time: { created: T0 } } }));
    env.store.push(factEvent({ ...occupee(OTHER, T0), rootId: OTHER }));
    env.clock.advance(5_000);
    assert.equal(env.store.getSnapshot().state, state);
    assert.equal(env.store.getSnapshot().details.size, 0);
    // Seuls les rendus des durées (arbre au travail) : aucun rendu de plus que le rythme d'une seconde.
    assert.ok(env.renders() - before <= 5_000 / DURATION_TICK_MS);
  });

  it("durées : un rendu par seconde tant que l'arbre travaille, aucun ensuite", async () => {
    const env = await opened([occupee(ROOT, T0 - 1_000)]);
    const first = rowOf(env.store, ROOT)?.durationMs ?? 0;
    env.clock.advance(3 * DURATION_TICK_MS);
    assert.ok((rowOf(env.store, ROOT)?.durationMs ?? 0) >= first + 3 * DURATION_TICK_MS - RENDER_MIN_INTERVAL_MS);
    env.store.push(factEvent(repos(ROOT, env.clock.t)));
    env.clock.advance(DURATION_TICK_MS);
    const settled = env.renders();
    env.clock.advance(10 * DURATION_TICK_MS);
    assert.equal(env.renders(), settled);
    assert.equal(env.clock.timers.length, 0);
  });

  it("détail de « travaille » : relu dans la partie d'outil de l'arbre, relatif au dossier, masqué ; oublié à la fin de l'outil", async () => {
    const env = await opened([occupee(ROOT, T0 - 1_000)]);
    env.store.push(factEvent(fact(ROOT, "statut", T0, { etat: "outil", outil: "lire", nom: "read", callId: "call_r", messageId: "msg_1", phase: "en-cours" }, "call_r")));
    env.store.push(toolPart(ROOT, "call_r", "read", "running", { filePath: `${DIR}/src/app.ts` }));
    env.clock.advance(RENDER_MIN_INTERVAL_MS);
    const row = rowOf(env.store, ROOT);
    assert.equal(row?.outilCallId, "call_r");
    const detail = env.store.getSnapshot().details.get("call_r") ?? null;
    assert.equal(detail, "src/app.ts");
    assert.equal(libelleEtatActeur(row as LiveRow, detail, false), "travaille · lit src/app.ts");
    env.store.push(toolPart(ROOT, "call_r", "read", "completed", { filePath: `${DIR}/src/app.ts` }));
    env.clock.advance(RENDER_MIN_INTERVAL_MS);
    assert.equal(env.store.getSnapshot().details.has("call_r"), false);
  });
});

describe("useActivity : annonces", () => {
  it("ce que la relecture révèle (attente déjà ouverte, travail en cours) n'est jamais annoncé", async () => {
    const said: ActivityAnnouncement[][] = [];
    const env = await opened([occupee(ROOT, T0 - 2_000), attente(ROOT, T0 - 1_000, "per_1")], { announce: (items) => said.push([...items]) });
    env.clock.advance(5_000);
    assert.equal(rowOf(env.store, ROOT)?.state, "attente-accord");
    assert.deepEqual(said, []);
  });

  it("fait reçu en direct avant la fin de la première relecture : jamais annoncé", async () => {
    const said: ActivityAnnouncement[][] = [];
    const env = setup({ announce: (items) => said.push([...items]) });
    env.store.start();
    env.store.push(factEvent(occupee(ROOT, T0)));
    env.store.push(factEvent(attente(ROOT, T0 + 1, "per_1")));
    env.clock.advance(5_000);
    env.source.pending.shift()?.resolve({ facts: [occupee(ROOT, T0), attente(ROOT, T0 + 1, "per_1")], partial: false });
    await flush();
    env.clock.advance(5_000);
    assert.equal(rowOf(env.store, ROOT)?.state, "attente-accord");
    assert.deepEqual(said, []);
  });

  it("transitions en direct : annoncées, au plus une fois toutes les 2 s, la file vidée à l'échéance", async () => {
    const said: Array<{ at: number; codes: string[] }> = [];
    const env = await opened([occupee(ROOT, T0 - 2_000)], { announce: (items) => said.push({ at: env.clock.t, codes: items.map((a) => `${a.code}:${a.key}`) }) });
    env.store.push(factEvent(creee(CHILD, env.clock.t)));
    env.store.push(factEvent(occupee(CHILD, env.clock.t)));
    env.clock.advance(RENDER_MIN_INTERVAL_MS);
    env.store.push(factEvent(attente(ROOT, env.clock.t, "per_2")));
    env.clock.advance(RENDER_MIN_INTERVAL_MS);
    env.store.push(factEvent(repos(CHILD, env.clock.t)));
    env.clock.advance(3 * ANNOUNCE_MIN_INTERVAL_MS);
    assert.deepEqual(
      said.map((s) => s.codes),
      [[`commence:${CHILD}`], [`attente-accord:${ROOT}`, `termine:${CHILD}`]],
    );
    const [first, second] = said;
    assert.ok(first && second && second.at - first.at >= ANNOUNCE_MIN_INTERVAL_MS);
  });
});

describe("useActivity : vue du bandeau", () => {
  const rowsOf = (facts: ActivityFact[], now = T0 + 10_000) => liveRows(replayFacts(emptyActivity(ROOT), facts), now);
  const view = (facts: ActivityFact[]) => {
    const state = replayFacts(emptyActivity(ROOT), facts);
    return bannerVisible(state, liveRows(state, T0 + 10_000), activityStatus(state));
  };

  it("apparaît dès un second acteur, une attente ou une demande automatique ; jamais pour la seule IA de la conversation", () => {
    assert.equal(view([occupee(ROOT, T0)]), false);
    assert.equal(view([occupee(ROOT, T0), repos(ROOT, T0 + 1_000)]), false);
    assert.equal(view([occupee(ROOT, T0), creee(CHILD, T0 + 10), occupee(CHILD, T0 + 10)]), true);
    assert.equal(view([occupee(ROOT, T0), attente(ROOT, T0 + 10, "per_1")]), true);
    // L'attente passée garde le bandeau (replié en fin de demande).
    assert.equal(view([occupee(ROOT, T0), attente(ROOT, T0 + 10, "per_1"), fact(ROOT, "reponse", T0 + 20, { reponse: "once" }, "per_1"), repos(ROOT, T0 + 30)]), true);
    assert.equal(view([occupee(ROOT, T0), fact(ROOT, "choix", T0 + 5, { choix: "autonome", cause: "clic" })]), true);
    assert.equal(view([occupee(ROOT, T0), fact(ROOT, "choix", T0 + 5, { choix: "demander", cause: "clic" })]), false);
  });

  it("arbre au travail (« Arrêter » visible) : travail, attente de votre accord, contrôle ; jamais pour un arbre au repos", () => {
    assert.equal(treeWorking(rowsOf([occupee(ROOT, T0)])), true);
    assert.equal(treeWorking(rowsOf([occupee(ROOT, T0), repos(ROOT, T0 + 5), creee(CHILD, T0 + 1), occupee(CHILD, T0 + 1)])), true);
    assert.equal(treeWorking(rowsOf([occupee(ROOT, T0), attente(ROOT, T0 + 10, "per_1")])), true);
    assert.equal(treeWorking(rowsOf([occupee(ROOT, T0), repos(ROOT, T0 + 5)])), false);
    assert.equal(treeWorking(rowsOf([])), false);
  });

  it("repli pendant une demande (clôture de l'itération 1) : en mode Simple seulement ; jamais en Avancé, quelle que soit la demande (modification, commande, délégation)", () => {
    // La correction de la répétition générale repliait la carte des agents et « Qui travaille ? » à chaque demande, dans les deux
    // modes : en Avancé, l'attente de votre accord et la préparation (§5.7.1, §5.7.3) ne se voyaient plus sans clic (rg-reel-7).
    const demandes: Array<[string, ActivityFact[]]> = [
      ["modification", [occupee(ROOT, T0), fact(ROOT, "attente", T0 + 10, { permission: "edit", messageId: "msg_1", callId: "call_e", agent: null }, "per_e")]],
      ["commande", [occupee(ROOT, T0), attente(ROOT, T0 + 10, "per_b")]],
      [
        "délégation",
        [
          occupee(ROOT, T0),
          fact(ROOT, "consigne", T0 + 3, { etat: "prepare", callId: "call_t", messageId: "msg_1", agent: "general" }, "call_t"),
          fact(ROOT, "attente", T0 + 4, { permission: "task", messageId: "msg_1", callId: "call_t", agent: "general" }, "per_t"),
        ],
      ],
    ];
    for (const [nom, faits] of demandes) {
      const rows = rowsOf(faits);
      assert.equal(demandeEnAttente(rows), true, `${nom} : une ligne porte [Répondre]`);
      assert.equal(replierPendantLaDemande(true, rows), false, `${nom} : jamais de repli en Avancé`);
      assert.equal(replierPendantLaDemande(false, rows), true, `${nom} : repli en Simple`);
    }
    // Sans demande : aucun repli, dans les deux modes (travail délégué en cours, arbre au repos).
    for (const faits of [[occupee(ROOT, T0), creee(CHILD, T0 + 1), occupee(CHILD, T0 + 1)], [occupee(ROOT, T0), repos(ROOT, T0 + 5)]]) {
      const rows = rowsOf(faits);
      assert.equal(demandeEnAttente(rows), false);
      assert.equal(replierPendantLaDemande(false, rows), false);
      assert.equal(replierPendantLaDemande(true, rows), false);
    }
  });

  it("ligne résumée : l'attente de votre accord d'abord, puis un acteur délégué au travail, puis la conversation", () => {
    const working = rowsOf([occupee(ROOT, T0), creee(CHILD, T0 + 1), occupee(CHILD, T0 + 1)]);
    assert.equal(mainRow(working)?.sessionId, CHILD);
    const waiting = rowsOf([occupee(ROOT, T0), creee(CHILD, T0 + 1), occupee(CHILD, T0 + 1), attente(ROOT, T0 + 2, "per_1")]);
    assert.equal(mainRow(waiting)?.permissionId, "per_1");
    assert.equal(mainRow(rowsOf([occupee(ROOT, T0), repos(ROOT, T0 + 1)]))?.sessionId, ROOT);
    assert.equal(mainRow([]), null);
  });

  it("premier bandeau : identifiant ajouté une fois, les plus anciens oubliés à la borne du schéma des réglages", () => {
    assert.deepEqual(seenOnboardingWith([], ONBOARDING_KEY), [ONBOARDING_KEY]);
    assert.deepEqual(seenOnboardingWith([ONBOARDING_KEY, "autre"], ONBOARDING_KEY), ["autre", ONBOARDING_KEY]);
    const full = Array.from({ length: SEEN_ONBOARDING_MAX }, (_, i) => `vu-${i}`);
    const next = seenOnboardingWith(full, ONBOARDING_KEY);
    assert.equal(next.length, SEEN_ONBOARDING_MAX);
    assert.equal(next.at(-1), ONBOARDING_KEY);
    assert.equal(next.includes("vu-0"), false);
    assert.ok(next.every((key) => /^[a-z0-9-]{1,40}$/.test(key)));
  });

  it("premier bandeau : écrit seulement quand le bandeau se montre et que la phrase d'accueil n'a jamais été vue", () => {
    assert.equal(onboardingToSave(false, []), null, "bandeau caché : rien d'écrit");
    assert.equal(onboardingToSave(true, ["autre", ONBOARDING_KEY]), null, "déjà vu : rien d'écrit");
    assert.deepEqual(onboardingToSave(true, ["autre"]), ["autre", ONBOARDING_KEY]);
  });

  it("[Voir le travail] : une conversation déléguée seulement, jamais le contrôle de sécurité ni une délégation sans session", () => {
    const rows = rowsOf([
      occupee(ROOT, T0),
      creee(CHILD, T0 + 1),
      occupee(CHILD, T0 + 1),
      fact(CONTROL, "statut", T0 + 2, { etat: "creee", role: "controle", parent: ROOT, agent: "cockpit-controle", instance: "principale" }),
      occupee(CONTROL, T0 + 2),
      fact(ROOT, "consigne", T0 + 3, { etat: "prepare", callId: "call_t", messageId: "msg_1", agent: "explore" }, "call_t"),
      fact(ROOT, "attente", T0 + 4, { permission: "task", messageId: "msg_1", callId: "call_t", agent: "explore" }, "per_t"),
    ]);
    const opens = new Map(rows.map((row) => [row.key, opensWork(row)]));
    assert.deepEqual([...opens], [
      [ROOT, false],
      [CHILD, true],
      [CONTROL, false],
      [`appel:${ROOT}:call_t`, false],
    ]);
  });
});

// --- Annonceur ------------------------------------------------------------------------------------------------------------------

describe("annonceur de la page", () => {
  function announcerEnv() {
    const clock = new FakeClock();
    const written: Array<{ at: number; text: string }> = [];
    const announcer = new Announcer({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, write: (text) => written.push({ at: clock.t, text }) });
    return { clock, written, announcer };
  }

  it("au plus une annonce toutes les 2 s : les messages arrivés entre-temps sont dits ensemble à l'échéance", () => {
    const { clock, written, announcer } = announcerEnv();
    announcer.say("A : commence à travailler.");
    clock.advance(100);
    announcer.say("B : terminé.");
    clock.advance(100);
    announcer.say("C : en attente de votre accord.");
    clock.advance(5_000);
    assert.deepEqual(
      written.map((w) => [w.at - T0, w.text]),
      [
        [0, "A : commence à travailler."],
        [ANNOUNCE_MIN_INTERVAL_MS, "B : terminé. C : en attente de votre accord."],
      ],
    );
    for (let i = 0; i < 20; i++) {
      announcer.say(`message ${i}`);
      clock.advance(150);
    }
    clock.advance(5_000);
    for (let i = 1; i < written.length; i++) assert.ok((written[i]?.at ?? 0) - (written[i - 1]?.at ?? 0) >= ANNOUNCE_MIN_INTERVAL_MS);
  });

  it("file bornée aux derniers messages, doublons fusionnés, textes vides ignorés", () => {
    const { clock, written, announcer } = announcerEnv();
    announcer.say("premier");
    for (const text of ["un", "deux", "un", "trois", "quatre", "   "]) announcer.say(text);
    clock.advance(ANNOUNCE_MIN_INTERVAL_MS);
    assert.equal(written.length, 2);
    assert.equal(written[1]?.text.split(" ").length, ANNOUNCE_MAX_PENDING);
    assert.equal(written[1]?.text, "un trois quatre");
  });

  it("annonces coupées (ui.activityAnnouncements) : les messages en attente sont oubliés, rien n'est dit tant qu'elles le restent", () => {
    const { clock, written, announcer } = announcerEnv();
    assert.equal(announcer.enabled, true, "activées par défaut, comme le réglage");
    announcer.say("premier");
    announcer.say("second");
    announcer.setEnabled(false);
    clock.advance(10_000);
    assert.deepEqual(written.map((w) => w.text), ["premier"]);
    assert.equal(clock.timers.length, 0);
    announcer.say("pendant la coupure");
    clock.advance(10_000);
    assert.deepEqual(written.map((w) => w.text), ["premier"]);
    // Réactivées plus tard : seul le nouveau message est dit, jamais un message d'avant ou de pendant la coupure.
    announcer.setEnabled(true);
    announcer.say("troisième");
    clock.advance(10_000);
    assert.deepEqual(written.map((w) => w.text), ["premier", "troisième"]);
  });

  it("clear (page quittée) : la file est oubliée sans couper les annonces suivantes", () => {
    const { clock, written, announcer } = announcerEnv();
    announcer.say("premier");
    announcer.say("second");
    announcer.clear();
    clock.advance(10_000);
    announcer.say("troisième");
    clock.advance(10_000);
    assert.deepEqual(written.map((w) => w.text), ["premier", "troisième"]);
  });
});

// --- Textes -------------------------------------------------------------------------------------------------------------------

describe("textes de « Qui travaille ? »", () => {
  const base = { role: "delegation" as const, depth: 1, agent: "general", activity: null, attempt: null, cause: null, erreur: null };
  const STATES: ActorState[] = [
    "pas-commence",
    "prepare-delegation",
    "travaille",
    "redige",
    "attend-delegation",
    "attente-accord",
    "controle",
    "attend-verification",
    "nouvelle-tentative",
    "termine",
    "echec",
    "arrete",
    "jamais-demarre",
    "non-choisi",
  ];

  it("chaque état a son libellé, gabarits remplis ; « travaille », jamais « réfléchit »", () => {
    for (const state of STATES) {
      for (const avance of [false, true]) {
        const label = libelleEtatActeur({ ...base, state }, null, avance);
        assert.ok(label.length > 0 && !/[{}]/.test(label), `${state} : ${label}`);
      }
    }
    assert.equal(libelleEtatActeur({ ...base, state: "travaille" }, null, false), "travaille");
    assert.equal(libelleEtatActeur({ ...base, state: "nouvelle-tentative", attempt: 3 }, null, false), "nouvelle tentative (3)");
  });

  it("détail de « travaille » : lit, cherche, modifie avec leur détail ; une commande n'est jamais recopiée", () => {
    const at = (kind: "lit" | "cherche" | "modifie" | "commande", detail: string | null) => libelleEtatActeur({ ...base, state: "travaille", activity: { kind, detail: null } }, detail, false);
    assert.equal(at("lit", null), "travaille · lit un fichier");
    assert.equal(at("cherche", "TODO"), "travaille · cherche « TODO »");
    assert.equal(at("modifie", "src/a.ts"), "travaille · modifie src/a.ts");
    assert.equal(at("commande", "rm -rf /"), "travaille · lance une commande");
  });

  it("arrêt avec sa cause ; code d'erreur d'opencode seulement en mode Avancé", () => {
    assert.equal(libelleEtatActeur({ ...base, state: "arrete", cause: "plafond" }, null, false), "arrêté : plafond atteint");
    assert.equal(libelleEtatActeur({ ...base, state: "arrete" }, null, false), "arrêté");
    assert.equal(libelleEtatActeur({ ...base, state: "echec", erreur: "ProviderAuthError" }, null, false), "échec");
    assert.equal(libelleEtatActeur({ ...base, state: "echec", erreur: "ProviderAuthError" }, null, true), "échec (ProviderAuthError)");
  });

  it("noms : la conversation, le contrôle de sécurité, l'assistant délégué", () => {
    assert.equal(nomActeur({ role: "conversation", depth: 0, agent: "build" }), TEXTES.partout.noms.conversation);
    assert.equal(nomActeur({ role: "controle", depth: 1, agent: "cockpit-controle" }), "Contrôle de sécurité");
    assert.equal(nomActeur({ role: "delegation", depth: 1, agent: "explore" }), "explore");
    assert.equal(nomActeur({ role: "delegation", depth: 1, agent: null }), "Travail délégué");
  });

  it("annonces : phrases des transitions, durée formatée, retour à « Demander à chaque fois » avec sa cause", () => {
    const annonce = (over: Partial<ActivityAnnouncement>): ActivityAnnouncement => ({ code: "commence", key: CHILD, role: "delegation", agent: "explore", title: "", durationMs: null, cause: null, ...over });
    const duree = (ms: number) => `${ms / 1000} s`;
    assert.equal(phraseAnnonce(annonce({}), duree), "explore : commence à travailler.");
    assert.equal(phraseAnnonce(annonce({ code: "termine", durationMs: 42_000 }), duree), "explore : terminé en 42 s.");
    assert.equal(phraseAnnonce(annonce({ code: "arrete", cause: "plafond" }), duree), "explore : arrêté : plafond atteint.");
    assert.equal(phraseAnnonce(annonce({ code: "attente-accord", role: "conversation", agent: null }), duree), "Assistant de la conversation : en attente de votre accord.");
    assert.equal(
      phraseAnnonce(annonce({ code: "retour-demander", key: "choix", role: "conversation", cause: "plafond-cout" }), duree),
      "Autonomie revenue à « Demander à chaque fois » : plafond de coût atteint.",
    );
    assert.equal(phrasesAnnonces([annonce({}), annonce({ code: "echec" })], duree), "explore : commence à travailler. explore : échec.");
  });

  it("« +2 » à 400 px, avec un nom accessible", () => {
    assert.deepEqual(libelleEnPlus(2), { court: "+2", accessible: "et 2 de plus" });
  });

  it("detailOutil : relatif au dossier, secrets masqués, fin gardée au-delà de 80 caractères, commandes et adresses jamais lues", () => {
    assert.equal(detailOutil("read", { filePath: `${DIR}/src/a.ts` }, DIR), "src/a.ts");
    assert.equal(detailOutil("edit", { filePath: "C:\\workspace\\projet\\b.ts" }, "C:\\workspace\\projet"), "b.ts");
    assert.equal(detailOutil("read", { filePath: `${DIR}/c.ts` }, `${DIR}//`), "c.ts", "dossier terminé par des barres");
    assert.equal(detailOutil("grep", { pattern: "  TODO   fix " }, DIR), "TODO fix");
    const token = `ghp_${"a".repeat(36)}`;
    const masked = detailOutil("read", { filePath: `${DIR}/${token}.txt` }, DIR) ?? "";
    assert.equal(masked.includes(token), false);
    const long = detailOutil("read", { filePath: `${DIR}/${"d/".repeat(60)}fin.ts` }, DIR) ?? "";
    assert.equal(long.length, 80);
    assert.ok(long.startsWith("…") && long.endsWith("fin.ts"));
    assert.equal(detailOutil("bash", { command: "cat .env" }, DIR), null);
    assert.equal(detailOutil("webfetch", { url: "https://exemple.test/?token=x" }, DIR), null);
    assert.equal(detailOutil("read", "pas un objet", DIR), null);
    assert.equal(detailOutil("read", { filePath: "   " }, DIR), null);
  });
});
