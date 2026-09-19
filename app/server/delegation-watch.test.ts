// Tests L1e : surveillance des délégations lancées sans demande (delegation-watch.ts ; spécification §3.14, §3.8, §3.9, §3.6,
// §4.8.1 ; plan d'exécution, fiche L1e ; mesure MX1 §7).
// Unitaires : événements écrits à la main, base en mémoire, registre emitted réel, coût et arrêt en espions, arrêt différé
// injecté : 6e délégation, coût, demande, exclusions par usage (usage forcé par le serveur compris), délégations après une demande
// accordée (flux, registre, partie, tables), refus inscrit au registre, course entre deux appels, reprise par task_id, demande
// expirée et demande accordée close à la libération, arrêts répétés, événements mal formés, aucun réseau.
// Intégration : faux opencode et harnais du cockpit (modules facts, delegationWatch, stopTree) : agent Studio `task: allow` dans les
// deux modes, coût dépassé, 6 contrôles de sécurité, délégation accordée par le proxy, demande expirée (M14), capture p1 rejouée
// sans réseau ; P6 dans chaque scénario.
import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { openMemoryDb } from "./db.ts";
import { createDelegationWatch, type DelegationWatch, WATCH_COUNTED_MAX } from "./delegation-watch.ts";
import { EventHub } from "./hub.ts";
import { createLogger, type Logger } from "./log.ts";
import type { OcGlobalEvent, OcSession, OpencodeClient } from "./opencode.ts";
import { emittedRegistry } from "./permission-gate.ts";
import { sessionIdOf } from "./processor.ts";
import { SessionTracker } from "./sessions.ts";
import { SettingsStore } from "./settings.ts";
import type { StopResult } from "./shared/cockpit-event-types.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import { createId, type FakePermissionRequest, type FakeSession, type FakeToolScript, readCapture } from "./test-support/fake-opencode.ts";
import { until, within } from "./test-support/helpers.ts";

const ROOT = "ses_racine";
const DIR = "/workspace/projet";
const MODEL = { providerID: "github-copilot", modelID: "gpt-5-mini" };

// --- Unitaires ------------------------------------------------------------------------------------------------------------------

interface UnitOptions {
  maxPerRequest?: number;
  maxUsdPerRequest?: number;
}

function unit(t: TestContext, caps: UnitOptions = {}) {
  const db = openMemoryDb();
  t.after(() => db.close());
  // Client jamais appelé : la surveillance ne fait aucune requête (toute lecture d'une propriété lève).
  const client = new Proxy(
    {},
    {
      get: () => {
        throw new Error("réseau interdit dans la surveillance des délégations");
      },
    },
  ) as unknown as OpencodeClient;
  const sessions = new SessionTracker(db, client);
  const settings = new SettingsStore(db);
  settings.update({ budget: { delegation: { maxPerRequest: caps.maxPerRequest ?? 5, maxUsdPerRequest: caps.maxUsdPerRequest ?? 1 } } });
  const ledger = {
    spent: 0,
    calls: [] as Array<[string, number]>,
    spentSince(rootId: string, since: number): number {
      this.calls.push([rootId, since]);
      return this.spent;
    },
  };
  const emitted = emittedRegistry();
  const hub = new EventHub();
  const events: Array<{ type: string; data: unknown }> = [];
  hub.subscribe((event) => {
    if (event.kind === "cockpit") events.push({ type: event.type, data: event.data });
  });
  const warnings: string[] = [];
  const log: Logger = { ...createLogger("error"), warn: (message: string) => void warnings.push(message) };
  const stops: string[] = [];
  const stopper = {
    impl: async (rootId: string): Promise<unknown> => {
      stops.push(rootId);
      return null;
    },
  };
  const deferred: Array<() => void> = [];
  let clock = 5_000_000;
  const make = (): DelegationWatch =>
    createDelegationWatch(
      { db, sessions, settings, ledger, gate: { emitted }, hub, log, stop: (rootId) => stopper.impl(rootId) },
      { now: () => clock, defer: (fn) => void deferred.push(fn) },
    );
  let watch = make();

  const add = (id: string, parentID?: string, extra: { metadata?: Record<string, unknown>; instance?: string } = {}) => {
    const info: OcSession = {
      id,
      ...(parentID ? { parentID } : {}),
      projectID: "global",
      directory: DIR,
      title: id,
      ...(extra.metadata ? { metadata: extra.metadata } : {}),
      time: { created: 1_000, updated: 1_000 },
    };
    sessions.upsert(info);
    if (extra.instance) db.prepare("UPDATE sessions SET instance = ? WHERE id = ?").run(extra.instance, id);
  };
  /** Envoi relayé par le proxy : ligne chat_turns de la racine (début de la demande). */
  const send = (rootId = ROOT, createdAt = clock) =>
    Number(db.prepare("INSERT INTO chat_turns (session_id, created_at, kind, agent) VALUES (?, ?, 'message', 'build')").run(rootId, createdAt).lastInsertRowid);
  const ev = (type: string, properties: Record<string, unknown>, directory = DIR): OcGlobalEvent => ({ directory, payload: { id: createId("evt"), type, properties } });
  const on = (event: OcGlobalEvent) => watch.onEvent(event);
  const created = (id: string, parentID?: string, metadata?: Record<string, unknown>) =>
    on(ev("session.created", { info: { id, ...(parentID ? { parentID } : {}), directory: DIR, title: `${id} (@general subagent)`, ...(metadata ? { metadata } : {}) } }));
  const part = (sessionID: string, callID: string, status: string, child?: string, input: Record<string, unknown> = {}) =>
    on(
      ev("message.part.updated", {
        sessionID,
        part: {
          id: createId("prt"),
          sessionID,
          messageID: "msg_appel",
          type: "tool",
          tool: "task",
          callID,
          state: { status, input: { subagent_type: "general", ...input }, ...(child ? { metadata: { sessionId: child } } : {}) },
        },
      }),
    );
  /** Délégation lancée sans demande, dans l'ordre des captures p1 et p6 : l'enfant d'abord, puis la partie qui le nomme. */
  const delegate = (child: string, callID: string, parent = ROOT) => {
    part(parent, callID, "pending");
    created(child, parent);
    part(parent, callID, "running", child);
  };
  const asked = (id: string, sessionID: string, callID: string, directory = DIR) =>
    on(ev("permission.asked", { id, sessionID, permission: "task", patterns: ["general"], metadata: {}, always: ["*"], tool: { messageID: "msg_appel", callID } }, directory));
  const replied = (id: string, sessionID: string, reply: "once" | "always" | "reject") => on(ev("permission.replied", { sessionID, requestID: id, reply }));
  const run = async () => {
    while (deferred.length > 0) deferred.shift()?.();
    await new Promise((resolve) => setImmediate(resolve));
  };
  const of = (type: string) => events.filter((e) => e.type === type).map((e) => e.data);

  add(ROOT);
  return {
    db,
    sessions,
    settings,
    ledger,
    emitted,
    events,
    warnings,
    stops,
    stopper,
    deferred,
    get watch() {
      return watch;
    },
    /** Nouvelle surveillance sur la même base (redémarrage du cockpit : mémoire perdue, tables gardées). */
    restart() {
      watch = make();
    },
    tick(ms: number) {
      clock += ms;
    },
    add,
    send,
    ev,
    on,
    created,
    part,
    delegate,
    asked,
    replied,
    run,
    of,
  };
}

describe("L1e : surveillance des délégations lancées sans demande (unitaires)", () => {
  it("agent `task: allow` : 5 délégations → rien ; la 6e → delegation.plafond « nombre » puis arrêt hors de l'appel ; une seule fois par délégation vue deux fois (enfant, partie)", async (t) => {
    const u = unit(t);
    const turn = u.send();
    for (let i = 1; i <= 5; i++) u.delegate(`ses_enfant${i}`, `call_${i}`);
    assert.deepEqual(u.watch.snapshot(ROOT), { request: `envoi:${turn}`, since: 5_000_000, delegations: 5, stops: 0, notified: [] });
    assert.deepEqual([u.events, u.deferred.length], [[], 0]);

    u.delegate("ses_enfant6", "call_6");
    assert.deepEqual(u.of("delegation.plafond"), [{ rootId: ROOT, kind: "nombre" }]);
    assert.deepEqual(u.stops, [], "aucun arrêt pendant onEvent");
    assert.equal(u.deferred.length, 1);
    // Pendant l'arrêt : une 7e délégation ne relance rien.
    u.delegate("ses_enfant7", "call_7");
    assert.equal(u.deferred.length, 1);
    await u.run();
    assert.deepEqual(u.stops, [ROOT]);
    assert.deepEqual(u.watch.snapshot(ROOT)?.notified, ["nombre"]);
    // Mises à jour répétées d'une même partie (running, completed) : aucun nouveau compte.
    u.part(ROOT, "call_1", "running", "ses_enfant1");
    u.part(ROOT, "call_1", "completed", "ses_enfant1");
    assert.equal(u.watch.snapshot(ROOT)?.delegations, 7);
  });

  it("partie seule (session.created manqué) ou enfant seul (aucune partie) : chacun compte une délégation ; l'enfant compté d'avance change seulement de clé", async (t) => {
    const u = unit(t, { maxPerRequest: 2 });
    u.send();
    u.part(ROOT, "call_seule", "running", "ses_sans_creation");
    u.created("ses_sans_partie", ROOT);
    assert.equal(u.watch.snapshot(ROOT)?.delegations, 2);
    // La partie arrive ensuite pour l'enfant déjà compté : même délégation.
    u.part(ROOT, "call_tardive", "running", "ses_sans_partie");
    assert.equal(u.watch.snapshot(ROOT)?.delegations, 2);
    assert.deepEqual(u.events, []);
    u.delegate("ses_troisieme", "call_3");
    assert.deepEqual(u.of("delegation.plafond"), [{ rootId: ROOT, kind: "nombre" }]);
  });

  it("délégations imbriquées : un enfant qui délègue compte pour la même demande de la racine", async (t) => {
    const u = unit(t, { maxPerRequest: 2 });
    u.send();
    u.delegate("ses_enfant", "call_1");
    u.delegate("ses_petit_enfant", "call_2", "ses_enfant");
    assert.equal(u.watch.snapshot(ROOT)?.delegations, 2);
    u.delegate("ses_arriere", "call_3", "ses_petit_enfant");
    assert.deepEqual(u.of("delegation.plafond"), [{ rootId: ROOT, kind: "nombre" }]);
    await u.run();
    assert.deepEqual(u.stops, [ROOT]);

    // Une demande accordée de la racine, restée sans enfant, ne couvre pas le petit-enfant qu'un enfant lance sans demande.
    const g = unit(t, { maxPerRequest: 1 });
    g.send();
    g.delegate("ses_enfant", "call_1");
    g.asked("per_racine", ROOT, "call_2");
    g.replied("per_racine", ROOT, "once");
    g.created("ses_petit_enfant", "ses_enfant");
    assert.deepEqual(g.of("delegation.plafond"), [{ rootId: ROOT, kind: "nombre" }]);
  });

  it("coût de la demande : surveillé dès la première délégation comptée, puis par usage.updated ; jamais sans délégation ; coût nul jamais ; début = envoi", async (t) => {
    const u = unit(t, { maxUsdPerRequest: 0.05 });
    const sentAt = 4_900_000;
    u.send(ROOT, sentAt);
    // Demande coûteuse sans délégation lancée sans demande : rien n'est surveillé.
    u.ledger.spent = 2;
    u.watch.onUsage({ sessionId: ROOT, rootId: ROOT, monthSpentUsd: 2, percent: 1 });
    assert.deepEqual([u.ledger.calls, u.events], [[], []]);

    u.ledger.spent = 0.01;
    u.delegate("ses_enfant", "call_1");
    assert.deepEqual(u.ledger.calls, [[ROOT, sentAt]], "coût relu dès la délégation, depuis l'envoi");
    u.ledger.spent = 0.049;
    u.watch.onUsage({ sessionId: "ses_enfant", rootId: ROOT, monthSpentUsd: 1, percent: 1 });
    assert.deepEqual(u.events, []);
    // Autre conversation : sans effet.
    u.ledger.spent = 5;
    u.watch.onUsage({ sessionId: "ses_autre", rootId: "ses_autre", monthSpentUsd: 1, percent: 1 });
    assert.deepEqual(u.events, []);
    // Plafond atteint (égalité) : « cout ».
    u.ledger.spent = 0.05;
    u.watch.onUsage({ sessionId: "ses_enfant", rootId: ROOT, monthSpentUsd: 1, percent: 1 });
    assert.deepEqual(u.of("delegation.plafond"), [{ rootId: ROOT, kind: "cout" }]);
    await u.run();
    assert.deepEqual(u.stops, [ROOT]);

    // Plafond à 0 : un coût nul (IA gratuite) n'arrête jamais ; le premier coût non nul, si.
    const z = unit(t, { maxUsdPerRequest: 0 });
    z.send();
    z.delegate("ses_enfant", "call_1");
    z.watch.onUsage({ rootId: ROOT, monthSpentUsd: 0, percent: 0 });
    assert.deepEqual(z.events, []);
    z.ledger.spent = 0.0001;
    z.watch.onUsage({ rootId: ROOT, monthSpentUsd: 0, percent: 0 });
    assert.deepEqual(z.of("delegation.plafond"), [{ rootId: ROOT, kind: "cout" }]);

    // Délégation comptée d'avance, puis reconnue comme lancée après une demande (réponse manquée, partie qui nomme son appel) :
    // plus aucune délégation lancée sans demande, le coût n'est plus surveillé.
    const k = unit(t, { maxUsdPerRequest: 0.05 });
    k.send();
    k.asked("per_1", ROOT, "call_1");
    k.created("ses_1", ROOT);
    assert.equal(k.watch.snapshot(ROOT)?.delegations, 1);
    k.part(ROOT, "call_1", "running", "ses_1");
    assert.equal(k.watch.snapshot(ROOT)?.delegations, 0);
    k.ledger.spent = 5;
    k.watch.onUsage({ rootId: ROOT, monthSpentUsd: 1, percent: 1 });
    assert.deepEqual(k.events, []);
  });

  it("coût déjà dépassé à la première délégation : arrêt tout de suite ; usage.updated sans racine (rattrapage) : toutes les demandes suivies relues", async (t) => {
    const u = unit(t, { maxUsdPerRequest: 0.5 });
    u.send();
    u.ledger.spent = 0.6;
    u.delegate("ses_enfant", "call_1");
    assert.deepEqual(u.of("delegation.plafond"), [{ rootId: ROOT, kind: "cout" }]);

    const r = unit(t, { maxUsdPerRequest: 0.5 });
    r.add("ses_autre");
    r.send();
    r.send("ses_autre");
    r.delegate("ses_enfant", "call_1");
    r.delegate("ses_enfant_autre", "call_2", "ses_autre");
    r.ledger.spent = 0.7;
    r.watch.onUsage({ monthSpentUsd: 1, percent: 1 });
    assert.deepEqual(
      r.of("delegation.plafond"),
      [
        { rootId: ROOT, kind: "cout" },
        { rootId: "ses_autre", kind: "cout" },
      ],
    );
  });

  it("demande : un nouvel envoi remet les compteurs à zéro (l'ancien coût n'est plus relu, une partie répétée n'y est pas comptée) ; sans envoi connu, la fenêtre s'ouvre à la première délégation", async (t) => {
    const u = unit(t, { maxPerRequest: 5, maxUsdPerRequest: 0.5 });
    const first = u.send();
    for (let i = 1; i <= 5; i++) u.delegate(`ses_a${i}`, `call_a${i}`);
    u.tick(10);
    const second = u.send();
    assert.notEqual(first, second);
    // Coût élevé de la demande précédente : usage.updated sans effet, sa demande est close.
    const reads = u.ledger.calls.length;
    u.ledger.spent = 3;
    u.watch.onUsage({ rootId: ROOT, monthSpentUsd: 1, percent: 1 });
    assert.deepEqual([u.events, u.ledger.calls.length], [[], reads]);
    // Fin d'une délégation de la demande précédente (partie répétée, « completed ») : elle ne compte pas dans la nouvelle.
    u.part(ROOT, "call_a1", "completed", "ses_a1");
    assert.equal(u.watch.snapshot(ROOT)?.delegations, 5, "demande précédente, telle quelle");
    assert.deepEqual(u.events, []);
    u.ledger.spent = 0;
    for (let i = 1; i <= 5; i++) u.delegate(`ses_b${i}`, `call_b${i}`);
    assert.deepEqual(u.watch.snapshot(ROOT), { request: `envoi:${second}`, since: 5_000_010, delegations: 5, stops: 0, notified: [] });
    assert.deepEqual(u.events, []);
    u.delegate("ses_b6", "call_b6");
    assert.deepEqual(u.of("delegation.plafond"), [{ rootId: ROOT, kind: "nombre" }]);

    const n = unit(t);
    n.tick(7);
    n.delegate("ses_enfant", "call_1");
    assert.deepEqual(n.watch.snapshot(ROOT), { request: "sans-envoi", since: 5_000_007, delegations: 1, stops: 0, notified: [] });
  });

  it("exclusions par usage : 6 contrôles de sécurité, étapes d'équipe, enfants d'un contrôle, classement ; racine d'équipe, de la Salle OMO, inconnue ou enfant → rien", async (t) => {
    const u = unit(t, { maxPerRequest: 0 });
    u.send();
    for (let i = 1; i <= 6; i++) u.created(`ses_controle${i}`, ROOT, { cockpit: "controle" });
    u.created("ses_etape", ROOT, { cockpit: "equipe" });
    u.created("ses_sous_controle", "ses_controle1");
    u.part("ses_controle1", "call_c", "running", "ses_sous_controle");
    // Usage hérité sur toute la descendance d'un contrôle (petit-enfant sans métadonnées).
    u.delegate("ses_petit_controle", "call_pc", "ses_sous_controle");
    u.created("ses_classement", ROOT, { cockpit: "classifier" });
    // Contrôle enregistré par le serveur avec son usage forcé (L11b) avant son session.created, ici sans métadonnées.
    u.sessions.upsert({ id: "ses_controle_force", parentID: ROOT, projectID: "global", directory: DIR, title: "Contrôle", time: { created: 1, updated: 1 } }, "controle");
    u.created("ses_controle_force", ROOT);
    u.created("ses_sous_force", "ses_controle_force");
    assert.deepEqual([u.events, u.watch.snapshot(ROOT)], [[], null]);

    u.add("ses_racine_equipe", undefined, { metadata: { cockpit: "equipe" } });
    u.delegate("ses_enfant_equipe", "call_e", "ses_racine_equipe");
    u.add("ses_salle", undefined, { instance: "omo" });
    u.delegate("ses_enfant_salle", "call_s", "ses_salle");
    u.delegate("ses_enfant_inconnue", "call_i", "ses_inconnue");
    u.add("ses_rattachee", ROOT);
    // Une session d'une conversation n'est pas une racine : sa propre « demande » n'existe pas.
    u.add("ses_orpheline", "ses_parent_absent");
    u.delegate("ses_enfant_orpheline", "call_o", "ses_orpheline");
    // Racine vue « chat » par son session.created, puis enregistrée par le serveur avec un usage forcé (classement) : la table
    // fait foi.
    u.created("ses_racine_forcee");
    u.sessions.upsert({ id: "ses_racine_forcee", projectID: "global", directory: DIR, title: "Classement", time: { created: 1, updated: 1 } }, "classifier");
    u.delegate("ses_enfant_forcee", "call_f", "ses_racine_forcee");
    // Ligne incohérente (racine d'elle-même, mais avec un parent) : jamais prise pour une racine suivie.
    u.add("ses_incoherente", ROOT);
    u.db.prepare("UPDATE sessions SET root_id = id WHERE id = 'ses_incoherente'").run();
    u.delegate("ses_enfant_incoherente", "call_x", "ses_incoherente");
    assert.deepEqual(u.events, []);
    assert.equal(u.watch.snapshot("ses_racine_equipe"), null);
    assert.equal(u.watch.snapshot("ses_salle"), null);

    // Témoin : une délégation de l'IA dans la conversation suivie est bien comptée.
    u.delegate("ses_enfant", "call_1");
    assert.deepEqual(u.of("delegation.plafond"), [{ rootId: ROOT, kind: "nombre" }]);
  });

  it("enfant titré « [cockpit] … » par l'IA (description du task, opencode tool/task.ts:160) : compté dès session.created, sans sa partie ; racine « [cockpit] » sans métadonnées : classement, jamais suivie", async (t) => {
    const u = unit(t, { maxPerRequest: 0 });
    u.send();
    // Racine de classement titrée par le serveur, métadonnées non rendues : usage « classement », ni elle ni sa descendance suivies.
    u.on(u.ev("session.created", { info: { id: "ses_classement", directory: DIR, title: "[cockpit] classement" } }));
    u.delegate("ses_sous_classement", "call_k", "ses_classement");
    assert.deepEqual([u.events, u.watch.snapshot("ses_classement")], [[], null]);

    // Le titre d'un enfant vient de la description écrite par l'IA : il ne le fait jamais passer pour une session du cockpit.
    u.on(u.ev("session.created", { info: { id: "ses_piege", parentID: ROOT, directory: DIR, title: "[cockpit] résumé (@general subagent)" } }));
    assert.deepEqual(u.of("delegation.plafond"), [{ rootId: ROOT, kind: "nombre" }]);
    assert.equal(u.watch.snapshot(ROOT)?.delegations, 1);
  });

  it("délégation lancée après une demande accordée : jamais comptée (permission.replied, registre emitted avant l'événement, sous-agent sans partie p7, « always ») ; une demande en attente ou refusée ne couvre pas un enfant lancé sans demande", async (t) => {
    const u = unit(t, { maxPerRequest: 0 });
    u.send();
    // Accordée, vue dans le flux, puis enfant et partie.
    u.part(ROOT, "call_1", "pending");
    u.asked("per_1", ROOT, "call_1");
    u.part(ROOT, "call_1", "running");
    u.replied("per_1", ROOT, "once");
    u.created("ses_1", ROOT);
    u.part(ROOT, "call_1", "running", "ses_1");
    // Accordée par le cockpit : inscrite au registre avant l'envoi, l'enfant arrive avant permission.replied.
    u.asked("per_2", ROOT, "call_2");
    u.emitted.record({ requestId: "per_2", reply: "once", by: "vous", at: 1 });
    u.created("ses_2", ROOT);
    u.replied("per_2", ROOT, "once");
    u.part(ROOT, "call_2", "running", "ses_2");
    // « once » tardif (capture p7) : sous-agent détaché, aucune partie.
    u.asked("per_3", ROOT, "call_3");
    u.replied("per_3", ROOT, "once");
    u.created("ses_3", ROOT);
    // « always » (refusé par le proxy, P4) : lancé après une demande, donc pas « sans demande ».
    u.asked("per_4", ROOT, "call_4");
    u.replied("per_4", ROOT, "always");
    u.created("ses_4", ROOT);
    assert.deepEqual([u.events, u.watch.snapshot(ROOT)], [[], null]);

    // Refusée (même inscrite au registre) puis en attente : un enfant lancé sans demande dans le même parent reste compté.
    u.asked("per_5", ROOT, "call_5");
    u.emitted.record({ requestId: "per_5", reply: "reject", by: "cockpit", at: 2 });
    u.replied("per_5", ROOT, "reject");
    u.asked("per_6", ROOT, "call_6");
    u.delegate("ses_libre", "call_libre");
    assert.equal(u.watch.snapshot(ROOT)?.delegations, 1);
    assert.deepEqual(u.of("delegation.plafond"), [{ rootId: ROOT, kind: "nombre" }]);
  });

  it("refus inscrit au registre avant son envoi : l'enfant sans partie rattaché entre-temps est compté dès permission.replied « reject » ; accordée ensuite par une autre demande, non", async (t) => {
    const u = unit(t, { maxPerRequest: 0 });
    u.send();
    u.asked("per_refus", ROOT, "call_refus");
    // Le registre ne dit que « répondue » : l'enfant arrivé pendant l'envoi du refus lui est rattaché par supposition.
    u.emitted.record({ requestId: "per_refus", reply: "reject", by: "vous", at: 1 });
    u.created("ses_sans_partie", ROOT);
    assert.deepEqual([u.events, u.watch.snapshot(ROOT)], [[], null]);
    u.replied("per_refus", ROOT, "reject");
    assert.deepEqual(u.of("delegation.plafond"), [{ rootId: ROOT, kind: "nombre" }]);
    assert.equal(u.watch.snapshot(ROOT)?.delegations, 1);

    // Une autre demande accordée du même parent, restée sans enfant, le reprend : rien n'est compté.
    const v = unit(t, { maxPerRequest: 0 });
    v.send();
    v.asked("per_refus", ROOT, "call_refus");
    v.emitted.record({ requestId: "per_refus", reply: "reject", by: "vous", at: 1 });
    v.created("ses_sans_partie", ROOT);
    v.asked("per_ok", ROOT, "call_ok");
    v.replied("per_ok", ROOT, "once");
    v.replied("per_refus", ROOT, "reject");
    assert.deepEqual([v.events, v.watch.snapshot(ROOT)], [[], null]);
  });

  it("course entre un appel accordé et un appel lancé sans demande du même parent : la demande revient à son enfant, le compte reste juste à chaque instant", async (t) => {
    const u = unit(t, { maxPerRequest: 1 });
    u.send();
    u.asked("per_a", ROOT, "call_a");
    u.replied("per_a", ROOT, "once");
    // L'enfant de l'appel sans demande est créé le premier et prend, à tort, la demande accordée.
    u.created("ses_b", ROOT);
    u.created("ses_a", ROOT);
    assert.equal(u.watch.snapshot(ROOT)?.delegations, 1);
    // La partie de l'appel sans demande corrige : ses_a reprend la demande, ses_b est compté ; jamais 2.
    u.part(ROOT, "call_b", "running", "ses_b");
    assert.equal(u.watch.snapshot(ROOT)?.delegations, 1);
    u.part(ROOT, "call_a", "running", "ses_a");
    assert.equal(u.watch.snapshot(ROOT)?.delegations, 1);
    assert.deepEqual(u.events, []);
    // Ordre inverse des parties : même résultat.
    const v = unit(t, { maxPerRequest: 1 });
    v.send();
    v.asked("per_a", ROOT, "call_a");
    v.replied("per_a", ROOT, "once");
    v.created("ses_b", ROOT);
    v.created("ses_a", ROOT);
    v.part(ROOT, "call_a", "running", "ses_a");
    assert.equal(v.watch.snapshot(ROOT)?.delegations, 1);
    v.part(ROOT, "call_b", "running", "ses_b");
    assert.equal(v.watch.snapshot(ROOT)?.delegations, 1);
    assert.deepEqual(v.events, []);
    // Deux demandes accordées, enfants rattachés en croix par session.created : les parties rétablissent chaque demande, rien
    // n'est compté.
    const w = unit(t, { maxPerRequest: 0 });
    w.send();
    w.asked("per_1", ROOT, "call_1");
    w.replied("per_1", ROOT, "once");
    w.asked("per_2", ROOT, "call_2");
    w.replied("per_2", ROOT, "once");
    w.created("ses_x", ROOT);
    w.created("ses_y", ROOT);
    w.part(ROOT, "call_2", "running", "ses_x");
    w.part(ROOT, "call_1", "running", "ses_y");
    assert.deepEqual([w.events, w.watch.snapshot(ROOT)], [[], null]);
    // Témoin : une délégation de plus dépasse le plafond.
    u.delegate("ses_c", "call_c");
    assert.deepEqual(u.of("delegation.plafond"), [{ rootId: ROOT, kind: "nombre" }]);
  });

  it("reprise par task_id : un nouvel appel sur un enfant déjà lancé est une nouvelle délégation ; repris après une demande accordée, non", async (t) => {
    const u = unit(t, { maxPerRequest: 2 });
    u.send();
    u.delegate("ses_enfant", "call_1");
    u.part(ROOT, "call_2", "running", "ses_enfant", { task_id: "ses_enfant" });
    assert.equal(u.watch.snapshot(ROOT)?.delegations, 2);
    u.asked("per_3", ROOT, "call_3");
    u.replied("per_3", ROOT, "once");
    u.part(ROOT, "call_3", "running", "ses_enfant", { task_id: "ses_enfant" });
    assert.equal(u.watch.snapshot(ROOT)?.delegations, 2);
    u.part(ROOT, "call_4", "running", "ses_enfant", { task_id: "ses_enfant" });
    assert.deepEqual(u.of("delegation.plafond"), [{ rootId: ROOT, kind: "nombre" }]);
  });

  it("redémarrage du cockpit : la demande d'un appel est relue dans les tables (delegations, permission_waits) ; délégation jamais comptée", async (t) => {
    const u = unit(t, { maxPerRequest: 0 });
    u.send();
    const insertDelegation = u.db.prepare(
      "INSERT INTO delegations (root_id, parent_session_id, call_id, agent, source, state, permission_id, created_at) VALUES (?, ?, ?, 'general', 'ia', 'attente-accord', ?, 1)",
    );
    const insertWait = u.db.prepare("INSERT INTO permission_waits (permission_id, session_id, root_id, permission, asked_at) VALUES (?, ?, ?, 'task', 1)");
    insertDelegation.run(ROOT, ROOT, "call_1", "per_1");
    insertWait.run("per_1", ROOT, ROOT);
    insertDelegation.run(ROOT, ROOT, "call_2", "per_2");
    insertWait.run("per_2", ROOT, ROOT);
    u.restart();
    // « once » tardif après le redémarrage : l'enfant arrive sans partie (p7).
    u.replied("per_1", ROOT, "once");
    u.created("ses_1", ROOT);
    // Partie d'un appel dont la demande n'a jamais été vue par cette surveillance.
    u.part(ROOT, "call_2", "running", "ses_2");
    assert.deepEqual([u.events, u.watch.snapshot(ROOT)], [[], null]);
    // Demande d'une autre nature (bash), vue dans le flux ou relue dans les tables : ne couvre aucun enfant.
    u.on(u.ev("permission.asked", { id: "per_bash_flux", sessionID: ROOT, permission: "bash", patterns: ["ls"], metadata: {}, always: ["ls"], tool: { messageID: "msg_appel", callID: "call_bash" } }));
    u.replied("per_bash_flux", ROOT, "once");
    u.db.prepare("INSERT INTO permission_waits (permission_id, session_id, root_id, permission, asked_at) VALUES ('per_bash', ?, ?, 'bash', 1)").run(ROOT, ROOT);
    u.replied("per_bash", ROOT, "once");
    u.created("ses_3", ROOT);
    assert.deepEqual(u.of("delegation.plafond"), [{ rootId: ROOT, kind: "nombre" }]);
  });

  it("demande expirée : libération de son instance (M14) → delegation.expiree une fois, sans compter ni arrêter ; autre dossier, demande accordée, refusée ou qui a déjà lancé son enfant : rien ; global.disposed : toutes ; ni l'expirée ni l'accordée restée sans enfant ne couvrent un enfant ensuite", async (t) => {
    const u = unit(t, { maxPerRequest: 0 });
    u.send();
    u.asked("per_ici", ROOT, "call_1");
    u.asked("per_ailleurs", ROOT, "call_2", "/workspace/autre");
    // Réponse inscrite au registre, enfant lancé, permission.replied pas encore reçu : elle n'a pas expiré.
    u.asked("per_lancee", ROOT, "call_5");
    u.emitted.record({ requestId: "per_lancee", reply: "once", by: "vous", at: 1 });
    u.created("ses_lancee", ROOT);
    u.asked("per_accordee", ROOT, "call_3");
    u.replied("per_accordee", ROOT, "once");
    u.asked("per_refusee", ROOT, "call_4");
    u.replied("per_refusee", ROOT, "reject");
    u.on(u.ev("server.instance.disposed", { directory: DIR }, DIR));
    assert.deepEqual(u.of("delegation.expiree"), [{ rootId: ROOT, permissionId: "per_ici" }]);
    u.on(u.ev("server.instance.disposed", { directory: DIR }, DIR));
    u.on(u.ev("server.instance.disposed", {}, DIR));
    assert.equal(u.of("delegation.expiree").length, 1);
    u.on({ directory: "global", payload: { id: createId("evt"), type: "global.disposed", properties: {} } });
    assert.deepEqual(u.of("delegation.expiree"), [
      { rootId: ROOT, permissionId: "per_ici" },
      { rootId: ROOT, permissionId: "per_ailleurs" },
    ]);
    assert.deepEqual([u.of("delegation.plafond"), u.deferred.length, u.watch.snapshot(ROOT)], [[], 0, null]);
    // Expirée : elle ne couvre plus un enfant, même inscrite ensuite au registre ; l'accordée sans enfant est close (son appel a
    // été arrêté avant la libération).
    u.emitted.record({ requestId: "per_ici", reply: "once", by: "vous", at: 3 });
    u.created("ses_apres", ROOT);
    assert.deepEqual(u.of("delegation.plafond"), [{ rootId: ROOT, kind: "nombre" }]);
    assert.equal(u.watch.snapshot(ROOT)?.delegations, 1);
  });

  it("après un arrêt : un appel en vol qui se termine ne relance rien ; une nouvelle délégation, si (une seule annonce par nature) ; arrêt en échec journalisé, surveillance reprise", async (t) => {
    const u = unit(t, { maxUsdPerRequest: 0.05 });
    u.send();
    u.delegate("ses_enfant", "call_1");
    u.ledger.spent = 0.06;
    u.watch.onUsage({ rootId: ROOT, monthSpentUsd: 1, percent: 1 });
    await u.run();
    assert.deepEqual(u.stops, [ROOT]);
    u.ledger.spent = 0.09;
    u.watch.onUsage({ rootId: ROOT, monthSpentUsd: 1, percent: 1 });
    await u.run();
    assert.deepEqual(u.stops, [ROOT], "appel en vol clos après l'arrêt : aucun nouvel arrêt");
    u.delegate("ses_enfant2", "call_2");
    await u.run();
    assert.deepEqual(u.stops, [ROOT, ROOT]);
    assert.deepEqual(u.of("delegation.plafond"), [{ rootId: ROOT, kind: "cout" }]);
    assert.equal(u.watch.snapshot(ROOT)?.stops, 2);

    // Arrêt en échec (racine disparue, port absent) : journalisé, puis une délégation suivante relance l'arrêt.
    const f = unit(t, { maxPerRequest: 0 });
    f.send();
    f.stopper.impl = () => Promise.reject(new Error("arrêt impossible"));
    f.delegate("ses_enfant", "call_1");
    await f.run();
    assert.ok(f.warnings.some((w) => w.includes("arrêt en échec")), f.warnings.join(" | "));
    f.stopper.impl = () => {
      throw new Error("port absent");
    };
    f.delegate("ses_enfant2", "call_2");
    assert.equal(f.deferred.length, 1, "surveillance reprise après l'échec");
    await f.run();
    assert.equal(f.warnings.filter((w) => w.includes("arrêt en échec")).length, 2);
    f.stopper.impl = async (rootId) => void f.stops.push(rootId);
    f.delegate("ses_enfant3", "call_3");
    await f.run();
    assert.deepEqual(f.stops, [ROOT]);
  });

  it("réglages lus à chaque décision ; plafond à 0 : la première délégation lancée sans demande (raccourci subtask compris) arrête", async (t) => {
    const u = unit(t, { maxPerRequest: 5 });
    u.send();
    u.delegate("ses_enfant", "call_1", ROOT);
    u.delegate("ses_enfant2", "call_2", ROOT);
    assert.deepEqual(u.events, []);
    u.settings.update({ budget: { delegation: { maxPerRequest: 2 } } });
    u.delegate("ses_enfant3", "call_3", ROOT);
    assert.deepEqual(u.of("delegation.plafond"), [{ rootId: ROOT, kind: "nombre" }]);

    const r = unit(t, { maxPerRequest: 0 });
    r.send();
    r.part(ROOT, "call_cmd", "running", undefined, { command: "revue-croisee" });
    r.created("ses_sous_tache", ROOT);
    assert.deepEqual(r.of("delegation.plafond"), [{ rootId: ROOT, kind: "nombre" }]);
  });

  it("événements mal formés ou étrangers : ignorés sans erreur ni compte ; mémoire bornée", async (t) => {
    const u = unit(t, { maxPerRequest: 0 });
    u.send();
    const bad: unknown[] = [
      null,
      {},
      { payload: null },
      { payload: { type: 42 } },
      { payload: { type: "session.created" } },
      { payload: { type: "session.created", properties: { info: "x" } } },
      { payload: { type: "session.created", properties: { info: { id: "ses bad", parentID: ROOT } } } },
      { payload: { type: "session.created", properties: { info: { id: "ses_x", parentID: "../evil" } } } },
      { payload: { type: "session.created", properties: { info: { id: "ses_y", parentID: 12 } } } },
      { payload: { type: "message.part.updated", properties: { part: { type: "tool", tool: "task", sessionID: ROOT, callID: "", state: { metadata: { sessionId: "ses_z" } } } } } },
      { payload: { type: "message.part.updated", properties: { part: { type: "tool", tool: "task", sessionID: ROOT, callID: "c".repeat(513), state: { metadata: { sessionId: "ses_z" } } } } } },
      { payload: { type: "message.part.updated", properties: { part: { type: "tool", tool: "task", sessionID: ROOT, callID: "call_z", state: { metadata: { sessionId: ROOT } } } } } },
      { payload: { type: "message.part.updated", properties: { part: { type: "tool", tool: "bash", sessionID: ROOT, callID: "call_b", state: { metadata: { sessionId: "ses_w" } } } } } },
      { payload: { type: "message.part.updated", properties: { part: { type: "tool", tool: "task", sessionID: ROOT, callID: "call_v", state: "x" } } } },
      { payload: { type: "permission.asked", properties: { id: "per bad", sessionID: ROOT, permission: "task" } } },
      { payload: { type: "permission.asked", properties: { id: "per_bash", sessionID: ROOT, permission: "bash", tool: { callID: "call_q" } } } },
      { payload: { type: "permission.replied", properties: { requestID: "per_inconnue", reply: "once" } } },
      { payload: { type: "permission.replied", properties: { requestID: "per_bash", reply: "peut-etre" } } },
      { payload: { type: "server.instance.disposed", properties: { directory: 3 } } },
      { payload: { type: "session.status", properties: { sessionID: ROOT, status: { type: "busy" } } } },
    ];
    for (const event of bad) u.watch.onEvent(event as OcGlobalEvent);
    assert.deepEqual([u.events, u.watch.snapshot(ROOT), u.deferred.length], [[], null, 0]);

    // Plafond du nombre de délégations gardées par demande : au-delà, plus rien n'est ajouté (l'arrêt est déjà parti).
    const m = unit(t, { maxPerRequest: 50 });
    m.send();
    for (let i = 0; i < WATCH_COUNTED_MAX + 5; i++) m.part(ROOT, `call_${i}`, "running", `ses_e${i}`);
    assert.equal(m.watch.snapshot(ROOT)?.delegations, WATCH_COUNTED_MAX);
    assert.equal(m.of("delegation.plafond").length, 1);
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

/** Envoi par le proxy : ligne chat_turns (début de la demande), puis relais. */
async function sendThroughProxy(h: CockpitHarness, sessionId: string, text: string): Promise<void> {
  const sent = await h.call("POST", `/api/oc/session/${sessionId}/prompt_async`, {
    headers: h.headers.mutating,
    body: { agent: "build", model: MODEL, parts: [{ type: "text", text }] },
  });
  assert.equal(sent.status, 204, sent.body);
}

type ChildScript = NonNullable<FakeToolScript["child"]>;

/** Délégation d'un agent du Studio avec `task: allow` : la règle de l'agent l'autorise, aucune demande n'est posée. */
const allowTask = (description: string, child: Partial<ChildScript> = {}): FakeToolScript => ({
  tool: "task",
  input: { description, prompt: `Consigne : ${description}`, subagent_type: "general" },
  ask: { permission: "task", patterns: ["general"], metadata: { description, subagent_type: "general" } },
  agentRules: [{ permission: "task", pattern: "*", action: "allow" }],
  child: { agent: "general", workMs: 60_000, ...child },
});

/** Délégation qui demande votre accord (aucune règle : « ask »). */
const askedTask = (description: string, child: Partial<ChildScript> = {}): FakeToolScript => ({
  tool: "task",
  input: { description, prompt: `Consigne : ${description}`, subagent_type: "general" },
  ask: { permission: "task", patterns: ["general"], metadata: { description, subagent_type: "general" } },
  child: { agent: "general", workMs: 20, ...child },
});

const eventsOf = (h: CockpitHarness, type: string) => h.cockpitEvents().filter((e) => e.type === type).map((e) => e.data);

/** Attend la fin de tout le travail de la racine et de ses sous-agents, puis vérifie qu'aucune session ne travaille. */
async function settledTree(h: CockpitHarness, rootId: string): Promise<void> {
  const tree = [rootId, ...h.sessions.descendants(rootId)];
  await within(Promise.all(tree.map((id) => h.fake.settled(id))), "arbre au repos", 5_000);
  assert.deepEqual(await h.deps.client.request("GET", "/session/status"), {}, "aucune session occupée");
}

describe("L1e : surveillance sur le faux opencode", () => {
  for (const mode of ["simple", "avance"] as const) {
    it(`agent Studio \`task: allow\`, mode ${mode === "simple" ? "Simple" : "Avancé"} : 5 délégations → aucun arrêt ; envoi suivant, 6e délégation → delegation.plafond, arrêt de tout l'arbre (plafond-delegations), fait statut {cause: plafond} ; P6`, async (t) => {
      const h = await startCockpit(t, { modules: ["facts", "delegationWatch", "stopTree"], settings: { ui: { mode } } });
      const root = await trackedRoot(h, `Délégations ${mode}`);
      h.fake.script(root.id, { tools: Array.from({ length: 5 }, (_, i) => allowTask(`Analyse ${i + 1}`, { workMs: 20 })) });
      await sendThroughProxy(h, root.id, "Analyse en cinq morceaux.");
      await until(() => h.fake.messages(root.id).some((m) => m.info.role === "assistant" && m.parts.some((p) => p.type === "text")), 5_000);
      await settledTree(h, root.id);
      assert.equal(h.sessions.descendants(root.id).length, 5);
      assert.deepEqual([eventsOf(h, "delegation.plafond"), eventsOf(h, "conversation.arretee")], [[], []]);

      // Nouvel envoi : nouvelle demande, compteurs à zéro ; la 6e délégation de cette demande arrête tout.
      h.fake.script(root.id, { tools: Array.from({ length: 6 }, (_, i) => allowTask(`Lot ${i + 1}`)) });
      await sendThroughProxy(h, root.id, "Analyse en six morceaux.");
      const stopped = await until(() => eventsOf(h, "conversation.arretee")[0], 10_000);
      assert.deepEqual(stopped, { rootId: root.id, cause: "plafond-delegations", unconfirmed: [] });
      assert.deepEqual(eventsOf(h, "delegation.plafond"), [{ rootId: root.id, kind: "nombre" }]);
      await settledTree(h, root.id);
      assert.equal(h.sessions.descendants(root.id).length, 11);
      const facts = h.db.prepare("SELECT data FROM activity_facts WHERE session_id = ? AND kind = 'statut' AND data LIKE '%cause%'").all(root.id) as Array<{
        data: string;
      }>;
      assert.deepEqual(
        facts.map((f) => JSON.parse(f.data) as Record<string, unknown>).map(({ cause, motif, nonConfirmees }) => ({ cause, motif, nonConfirmees })),
        [{ cause: "plafond", motif: "plafond-delegations", nonConfirmees: 0 }],
      );
      h.assertNoGlobalRestart();
    });
  }

  it("coût de la demande dépassé par un sous-agent lancé sans demande → delegation.plafond « cout » et arrêt ; P6", async (t) => {
    const h = await startCockpit(t, { modules: ["delegationWatch", "stopTree"], settings: { budget: { delegation: { maxUsdPerRequest: 0.05 } } } });
    const root = await trackedRoot(h, "Délégation coûteuse");
    h.fake.script(root.id, {
      tools: [
        allowTask("Analyse coûteuse", {
          turn: { cost: 0.06, tokens: { input: 20_000, output: 500 }, tools: [{ tool: "glob", input: { pattern: "*.log" }, output: "" }], followUp: { cost: 0.01 }, stepMs: 400 },
        }),
      ],
    });
    await sendThroughProxy(h, root.id, "Analyse coûteuse.");
    const stopped = await until(() => eventsOf(h, "conversation.arretee")[0], 10_000);
    assert.deepEqual(stopped, { rootId: root.id, cause: "plafond-delegations", unconfirmed: [] });
    assert.deepEqual(eventsOf(h, "delegation.plafond"), [{ rootId: root.id, kind: "cout" }]);
    assert.ok(h.ledger.spentSince(root.id, 0) >= 0.05);
    await settledTree(h, root.id);
    h.assertNoGlobalRestart();
  });

  it("délégation dont la description, écrite par l'IA, commence par « [cockpit] » : enfant d'usage chat, jamais caché, faits « délégation », événements relayés, coût compté, rattrapage compris ; racine « [cockpit] » sans métadonnées : classement caché, hors rattrapage ; P12", async (t) => {
    const h = await startCockpit(t, { modules: ["facts", "delegationWatch"] });
    // Événements relayés au navigateur ; session.created passe avant que la file n'enregistre la session : pas une preuve.
    const relayed = new Set<string>();
    t.after(
      h.hub.subscribe((event) => {
        if (event.kind === "opencode" && event.event.type !== "session.created") relayed.add(`${event.event.type} ${sessionIdOf(event.event)}`);
      }),
    );
    const root = await trackedRoot(h, "Délégation au titre piégé");
    h.fake.script(root.id, { tools: [allowTask("[cockpit] résumé", { workMs: 20, cost: 0.02 })] });
    await sendThroughProxy(h, root.id, "Résume le journal.");
    await until(() => h.fake.messages(root.id).some((m) => m.info.role === "assistant" && m.parts.some((p) => p.type === "text")), 5_000);
    await settledTree(h, root.id);
    const [child] = h.sessions.descendants(root.id);
    assert.ok(child, "enfant suivi");
    assert.equal(h.fake.session(child)?.title, "[cockpit] résumé (@general subagent)");
    assert.deepEqual([h.sessions.get(child)?.purpose, h.sessions.isHidden(child)], ["chat", false]);
    const created = await until(() =>
      (h.db.prepare("SELECT data FROM activity_facts WHERE session_id = ? AND kind = 'statut'").all(child) as Array<{ data: string }>)
        .map((row) => JSON.parse(row.data) as Record<string, unknown>)
        .find((data) => data.etat === "creee"),
    );
    assert.deepEqual([created.role, created.parent], ["delegation", root.id]);
    assert.ok(relayed.has(`message.updated ${child}`), [...relayed].join("\n"));
    const usage = h.db.prepare("SELECT purpose, cost FROM usage WHERE session_id = ?").all(child) as Array<{ purpose: string; cost: number }>;
    // Coût d'un sous-agent (ledger.ts, usagePurpose), jamais celui du classement, exclu des coûts.
    assert.ok(usage.length > 0, "coût de l'enfant enregistré");
    assert.deepEqual([...new Set(usage.map((row) => row.purpose))], ["subagent"]);

    // Racine de classement titrée comme le serveur, sans métadonnées : toujours cachée.
    const classement = await h.deps.client.request<FakeSession>("POST", "/session", { body: { title: "[cockpit] classement" } });
    await until(() => h.sessions.get(classement.id));
    assert.deepEqual([h.sessions.get(classement.id)?.purpose, h.sessions.isHidden(classement.id)], ["classifier", true]);

    // Rattrapage après une coupure du flux : l'enfant est relu comme toute session de la conversation, la racine de classement non.
    h.db.prepare("DELETE FROM sessions WHERE id IN (?, ?)").run(child, classement.id);
    await h.processor.backfill();
    assert.deepEqual([h.sessions.get(child)?.purpose, h.sessions.get(child)?.root_id, h.sessions.isHidden(child)], ["chat", root.id, false]);
    assert.equal(h.sessions.get(classement.id), undefined, "racine de classement hors rattrapage");
    h.assertNoGlobalRestart();
  });

  it("conversation titrée « [cockpit] … » par l'IA de titre d'opencode (session/prompt.ts, ensureTitle) : reste « chat », visible, arrêtable ; la 6e délégation lancée sans demande arrête tout ; relue par le rattrapage ; titre « [cockpit] … » refusé par le proxy ; P12", async (t) => {
    const h = await startCockpit(t, { modules: ["facts", "delegationWatch", "stopTree"] });
    const relayed = new Set<string>();
    t.after(
      h.hub.subscribe((event) => {
        if (event.kind === "opencode" && event.event.type !== "session.created") relayed.add(`${event.event.type} ${sessionIdOf(event.event)}`);
      }),
    );
    // Créée sans titre, comme l'interface (api.ts, createSession) : opencode pose « New session - <date> ».
    const created = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: {} });
    assert.equal(created.status, 200, created.body);
    const root = created.json<FakeSession>();
    assert.match(root.title, /^New session - /);
    await until(() => h.sessions.get(root.id));
    // Titre écrit par l'IA de titre d'opencode d'après le premier message, hors du proxy : session.updated.
    const title = "[cockpit] Bouton Arrêter inopérant";
    await h.deps.client.request("PATCH", `/session/${root.id}`, { body: { title } });
    await until(() => h.sessions.get(root.id)?.title === title);
    assert.deepEqual([h.sessions.get(root.id)?.purpose, h.sessions.isHidden(root.id)], ["chat", false]);

    // Le proxy refuse un titre « [cockpit] … » à la création comme au renommage : rien n'est relayé.
    for (const [method, path] of [
      ["POST", "/api/oc/session"],
      ["PATCH", `/api/oc/session/${root.id}`],
    ] as const) {
      const refused = await h.call(method, path, { headers: h.headers.mutating, body: { title: "[cockpit] classement" } });
      assert.equal(refused.status, 403, refused.body);
      assert.equal(refused.json<{ error: string }>().error, "forbidden-body");
    }
    assert.equal(h.fake.session(root.id)?.title, title);

    // Plafond de délégations toujours appliqué : la 6e lancée sans demande arrête tout l'arbre.
    h.fake.script(root.id, { tools: Array.from({ length: 6 }, (_, i) => allowTask(`Lot ${i + 1}`)) });
    await sendThroughProxy(h, root.id, "Analyse en six morceaux.");
    const stopped = await until(() => eventsOf(h, "conversation.arretee")[0], 10_000);
    assert.deepEqual(stopped, { rootId: root.id, cause: "plafond-delegations", unconfirmed: [] });
    assert.deepEqual(eventsOf(h, "delegation.plafond"), [{ rootId: root.id, kind: "nombre" }]);
    await settledTree(h, root.id);
    assert.ok(relayed.has(`message.updated ${root.id}`), [...relayed].join("\n"));
    // « Arrêter » : arrêt de l'arbre par le cockpit (200), jamais le repli sur l'arrêt 1.0 (404).
    const stop = await h.call("POST", `/api/conversations/${root.id}/stop`, { headers: h.headers.mutating });
    assert.equal(stop.status, 200, stop.body);

    // Rattrapage après une coupure du flux : relue comme une conversation, jamais écartée comme une racine de classement.
    h.db.prepare("DELETE FROM sessions WHERE id = ?").run(root.id);
    await h.processor.backfill();
    assert.deepEqual([h.sessions.get(root.id)?.purpose, h.sessions.isHidden(root.id)], ["chat", false]);
    h.assertNoGlobalRestart();
  });

  it("6 contrôles de sécurité créés par le serveur sous la conversation : aucune délégation comptée ; témoin : 2 délégations lancées sans demande dépassent le plafond de 1", async (t) => {
    const h = await startCockpit(t, { modules: ["delegationWatch", "stopTree"], settings: { budget: { delegation: { maxPerRequest: 1 } } } });
    const root = await trackedRoot(h, "Contrôles");
    h.fake.script(root.id, { tools: [allowTask("Seule délégation", { workMs: 400 })] });
    await sendThroughProxy(h, root.id, "Une délégation.");
    for (let i = 1; i <= 6; i++) {
      const control = await h.deps.client.request<FakeSession>("POST", "/session", {
        body: { parentID: root.id, title: "Contrôle de sécurité", metadata: { cockpit: "controle", demande: `d${i}` } },
      });
      await until(() => h.sessions.get(control.id)?.purpose === "controle");
    }
    await settledTree(h, root.id);
    assert.deepEqual([eventsOf(h, "delegation.plafond"), eventsOf(h, "conversation.arretee")], [[], []]);

    h.fake.script(root.id, { tools: [allowTask("Un"), allowTask("Deux")] });
    await sendThroughProxy(h, root.id, "Deux délégations.");
    await until(() => eventsOf(h, "conversation.arretee")[0], 10_000);
    assert.deepEqual(eventsOf(h, "delegation.plafond"), [{ rootId: root.id, kind: "nombre" }]);
    await settledTree(h, root.id);
    h.assertNoGlobalRestart();
  });

  it("délégation accordée « once » par le proxy (registre emitted) : non comptée, même avec un plafond à 0 ; demande suivante sans demande d'accord : arrêt", async (t) => {
    const h = await startCockpit(t, { modules: ["delegationWatch", "stopTree"], settings: { budget: { delegation: { maxPerRequest: 0 } } } });
    const root = await trackedRoot(h, "Délégation accordée");
    h.fake.script(root.id, { tools: [askedTask("Analyse accordée")] });
    await sendThroughProxy(h, root.id, "Analyse avec accord.");
    const asked = (await h.fake.waitForEvent("permission.asked", (p) => p.sessionID === root.id)).properties as unknown as FakePermissionRequest;
    const reply = await h.call("POST", `/api/oc/permission/${asked.id}/reply`, { headers: h.headers.mutating, body: { reply: "once" } });
    assert.equal(reply.status, 200, reply.body);
    assert.equal(h.cockpit.gate.emitted.has(asked.id), true);
    await until(() => h.fake.messages(root.id).some((m) => m.info.role === "assistant" && m.parts.some((p) => p.type === "text")), 5_000);
    await settledTree(h, root.id);
    assert.equal(h.sessions.descendants(root.id).length, 1, "le sous-agent accordé a bien travaillé");
    assert.deepEqual([eventsOf(h, "delegation.plafond"), eventsOf(h, "conversation.arretee")], [[], []]);

    h.fake.script(root.id, { tools: [allowTask("Sans demande")] });
    await sendThroughProxy(h, root.id, "Analyse sans accord.");
    await until(() => eventsOf(h, "conversation.arretee")[0], 10_000);
    assert.deepEqual(eventsOf(h, "delegation.plafond"), [{ rootId: root.id, kind: "nombre" }]);
    await settledTree(h, root.id);
    h.assertNoGlobalRestart();
  });

  it("demande de délégation en attente, instance libérée (M14) → delegation.expiree {rootId, permissionId}, sans arrêt ; P6", async (t) => {
    const h = await startCockpit(t, { modules: ["delegationWatch", "stopTree"], settings: { budget: { delegation: { maxPerRequest: 0 } } } });
    const root = await trackedRoot(h, "Demande expirée");
    h.fake.script(root.id, { tools: [askedTask("En attente")] });
    await sendThroughProxy(h, root.id, "Analyse en attente.");
    const asked = (await h.fake.waitForEvent("permission.asked", (p) => p.sessionID === root.id)).properties as unknown as FakePermissionRequest;
    await until(() => eventsOf(h, "delegation.expiree").length === 0 && h.fake.pendingPermissions().length === 1);
    h.fake.emitInstanceDisposed(h.fake.session(root.id)?.directory ?? h.fake.directory);
    await until(() => eventsOf(h, "delegation.expiree")[0], 5_000);
    assert.deepEqual(eventsOf(h, "delegation.expiree"), [{ rootId: root.id, permissionId: asked.id }]);
    assert.deepEqual([eventsOf(h, "delegation.plafond"), eventsOf(h, "conversation.arretee")], [[], []]);
    // Arrêt demandé par vous : la demande (restée en attente chez le faux) est refusée ; rien n'est relancé.
    const res = await h.call("POST", `/api/conversations/${root.id}/stop`, { headers: h.headers.mutating });
    assert.equal(res.status, 200, res.body);
    assert.equal(res.json<StopResult>().rejected, 1);
    await settledTree(h, root.id);
    h.assertNoGlobalRestart();
  });

  it("onEvent sans réseau : capture réelle p1 rejouée (un `task` lancé sans demande, un accordé « once ») → une délégation comptée, arrêt lancé après l'appel", async (t) => {
    const h = await startCockpit(t, { modules: [], settings: { budget: { delegation: { maxPerRequest: 0 } } } });
    const rows = readCapture("p1-delegation-parallele.jsonl");
    const rootInfo = rows.map((r) => r.wire.payload).find((p) => p.type === "session.created" && "properties" in p && !(p.properties?.info as FakeSession).parentID);
    assert.ok(rootInfo && "properties" in rootInfo);
    const info = rootInfo.properties.info as FakeSession;
    h.sessions.upsert(info);
    h.db.prepare("INSERT INTO chat_turns (session_id, created_at, kind, agent) VALUES (?, ?, 'message', 'build')").run(info.id, rows[0]?.recv ?? 0);
    const stops: string[] = [];
    const c11 = h.cockpit.c11;
    const watch = createDelegationWatch({
      db: c11.db,
      sessions: c11.sessions,
      settings: c11.settings,
      ledger: c11.ledger,
      gate: c11.gate,
      hub: c11.hub,
      log: c11.log,
      stop: async (rootId) => void stops.push(rootId),
    });
    // Espion réseau : toute requête du client opencode ou tout fetch pendant onEvent est relevé.
    const client = h.deps.client;
    const spy = { inside: false, during: [] as string[] };
    const raw = client.raw.bind(client);
    client.raw = ((method: string, url: URL, init?: Parameters<typeof raw>[2]) => {
      if (spy.inside) spy.during.push(`${method} ${url.pathname}`);
      return raw(method, url, init);
    }) as typeof client.raw;
    const fetch = globalThis.fetch;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      if (spy.inside) spy.during.push("fetch");
      return fetch(...args);
    }) as typeof fetch;
    t.after(() => {
      Reflect.deleteProperty(client, "raw");
      globalThis.fetch = fetch;
    });
    for (const { wire } of rows) {
      if (wire.payload.type === "sync") continue;
      spy.inside = true;
      try {
        watch.onEvent(wire as OcGlobalEvent);
      } finally {
        spy.inside = false;
      }
      assert.deepEqual(stops, [], "aucun arrêt pendant onEvent");
    }
    assert.deepEqual(spy.during, []);
    assert.equal(watch.snapshot(info.id)?.delegations, 1, "call2 (sans demande) compté, call5 (accordé « once ») exclu");
    assert.deepEqual(eventsOf(h, "delegation.plafond"), [{ rootId: info.id, kind: "nombre" }]);
    await until(() => stops.length === 1);
    assert.deepEqual(stops, [info.id]);
    h.assertNoGlobalRestart();
  });
});
