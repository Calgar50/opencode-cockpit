// Réducteur d'activité (spécification §3.7, §3.10, §5.1, A9-5 ; plan d'exécution, fiche L4c) : captures p1 (fenêtres à ±0,1 s de
// la reconstruction de référence), p2 (repère non facturé), p6 (jamais démarré), p7 (détaché) ; « différé = direct » sur p1, p2,
// p6, p7 et p6 puis p7 ; pied de tour sans le coût des contrôles ; faits synthétiques d'arrêt et de choix ; bornes ; annonces ;
// registre ; pureté.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  ACTIVITY_MAX_DEPTH,
  ACTIVITY_MAX_SESSIONS,
  ACTIVITY_TITLE_MAX,
  type ActivityState,
  activityStatus,
  announcements,
  applyEvent,
  EMPTY_ANNOUNCEMENTS,
  emptyActivity,
  fromLedger,
  type LiveRow,
  liveRows,
  replayFacts,
  replayMessages,
  type TimelineBarKind,
  type TimelineRow,
  timeline,
  totals,
} from "./shared/activity.ts";
import { EventMemory, type FactContext, FactDeduper, type FactEvent, type FactSession, factsFromEvent } from "./shared/activity-facts.ts";
import type { ActivityFact, ActivityResponse, FactValue } from "./shared/activity-types.ts";
import { readCapture } from "./test-support/fake-opencode.ts";

const ROOT = "ses_f618ff214ffevi6gfuGx6TvpTP";
/** Messages envoyés par le cockpit dans les captures (demande de p1, commande de p2, demande de p6). */
const SENT_BY_COCKPIT = new Set(["msg_09e702c4e001phPA6LcfC9t4WK", "msg_09e70de68001w3xwbgF26JxZPW", "msg_09e75b36c001x5Cehfmxl57pRZ"]);
const P1 = "p1-delegation-parallele.jsonl";
const P2 = "p2-commande-subtask.jsonl";
const P6 = "p6-arret-global.jsonl";
const P7 = "p7-autorisation-orpheline.jsonl";
/** Envoi de p1 et de p2 (heure locale de l'envoi, reconstruction de référence « ocgraph », §3 et §9). */
const T0_P1 = 1_789_364_546_597;
const T0_P2 = 1_789_364_592_195;
const E1_P1 = "ses_f618fc47effewRlFGgpRFi51pw";
const E2_P1 = "ses_f618fbb91ffepC06O3owB9ayZ7";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const factEvent = (data: ActivityFact) => ({ kind: "cockpit" as const, type: "activite.fait", data });

/** Côté serveur (L4a, L4b) : sessions connues du cockpit, mémoire du flux, faits gardés par le magasin. */
class Server {
  readonly sessions = new Map<string, FactSession>([[ROOT, { rootId: ROOT, parentId: null, purpose: "chat", instance: "principale" }]]);
  readonly memory = new EventMemory();
  readonly store = new FactDeduper();
  readonly stored: ActivityFact[] = [];

  resolve(id: string, info?: Readonly<Record<string, unknown>>): FactSession | null {
    const known = this.sessions.get(id);
    if (known) return known;
    const parentId = typeof info?.parentID === "string" ? info.parentID : null;
    const parent = parentId === null ? undefined : this.sessions.get(parentId);
    if (!info || info.id !== id || !parent) return null;
    return { rootId: parent.rootId, parentId, purpose: "chat", instance: parent.instance };
  }

  ctx(receivedAt: number): FactContext {
    return {
      receivedAt,
      session: (id, info) => this.resolve(id, info),
      messageRole: (id) => this.memory.messageRole(id),
      promptKind: (id) => (SENT_BY_COCKPIT.has(id) ? "message" : null),
      firstUserMessage: (id) => this.memory.firstUserMessage(id),
      userMessageParts: (id) => this.memory.userMessageParts(id),
      unansweredUserMessages: (id) => this.memory.unansweredUserMessages(id),
    };
  }

  /** Faits d'un événement acceptés par le magasin, avec leur numéro de ligne. */
  accept(event: FactEvent, receivedAt: number): ActivityFact[] {
    this.memory.observe(event);
    const info = event.properties?.info;
    if ((event.type === "session.created" || event.type === "session.updated") && isRecord(info) && typeof info.id === "string") {
      const session = this.resolve(info.id, info);
      if (session) this.sessions.set(info.id, session);
    }
    const out: ActivityFact[] = [];
    for (const fact of factsFromEvent(event, this.ctx(receivedAt))) {
      if (!this.store.accept(fact)) continue;
      const row = { ...fact, id: this.stored.length + 1 };
      this.stored.push(row);
      out.push(row);
    }
    return out;
  }
}

interface Played {
  /** Navigateur : événements opencode relayés et faits `activite.fait`, dans l'ordre du hub. */
  direct: ActivityState;
  /** Navigateur qui ne reçoit que les faits, et ses lignes après chaque fait. */
  factsOnly: ActivityState;
  checkpoints: Array<{ count: number; rows: LiveRow[] }>;
  stored: ActivityFact[];
  events: FactEvent[];
  now: number;
}

function play(names: readonly string[]): Played {
  const server = new Server();
  let direct = emptyActivity(ROOT);
  let factsOnly = emptyActivity(ROOT);
  const checkpoints: Played["checkpoints"] = [];
  const events: FactEvent[] = [];
  let now = 0;
  for (const name of names) {
    for (const { recv, wire } of readCapture(name)) {
      const event = wire.payload as FactEvent;
      events.push(event);
      now = Math.max(now, recv);
      // Le hub diffuse l'événement, puis la dérivation synchrone publie ses faits (§3.10 point 1).
      direct = applyEvent(direct, { kind: "opencode", event });
      for (const fact of server.accept(event, recv)) {
        direct = applyEvent(direct, factEvent(fact));
        factsOnly = applyEvent(factsOnly, factEvent(fact));
        checkpoints.push({ count: server.stored.length, rows: liveRows(factsOnly, recv) });
      }
    }
  }
  return { direct, factsOnly, checkpoints, stored: server.stored, events, now: now + 1_000 };
}

/** Lignes de la table activity_facts (data en JSON), relues comme par GET …/facts. */
function reread(stored: readonly ActivityFact[]): unknown[] {
  const rows = stored.map((fact) => ({ id: fact.id, root_id: fact.rootId, session_id: fact.sessionId, kind: fact.kind, ref: fact.ref, data: JSON.stringify(fact.data), at: fact.at }));
  return JSON.parse(JSON.stringify(rows)).map((row: Record<string, unknown>) => ({
    id: row.id,
    rootId: row.root_id,
    sessionId: row.session_id,
    kind: row.kind,
    ref: row.ref,
    data: JSON.parse(String(row.data)),
    at: row.at,
  }));
}

/** GET /session/:id/children et GET /session/:id/message rebâtis depuis la capture : dernière version de chaque session, message et partie. */
function snapshot(events: readonly FactEvent[]): { sessions: unknown[]; messages: unknown[] } {
  const sessions = new Map<string, unknown>();
  const infos = new Map<string, Record<string, unknown>>();
  const parts = new Map<string, Map<string, unknown>>();
  for (const event of events) {
    const p = event.properties ?? {};
    if ((event.type === "session.created" || event.type === "session.updated") && isRecord(p.info)) sessions.set(String(p.info.id), p.info);
    if (event.type === "message.updated" && isRecord(p.info)) infos.set(String(p.info.id), p.info);
    if (event.type === "message.part.updated" && isRecord(p.part)) {
      const messageId = String(p.part.messageID);
      const byId = parts.get(messageId) ?? new Map<string, unknown>();
      byId.set(String(p.part.id), p.part);
      parts.set(messageId, byId);
    }
  }
  return { sessions: [...sessions.values()], messages: [...infos.values()].map((info) => ({ info, parts: [...(parts.get(String(info.id))?.values() ?? [])] })) };
}

const rowOf = (rows: readonly { key: string }[], key: string) => rows.find((row) => row.key === key);
const barsOf = (row: TimelineRow | undefined, kind: TimelineBarKind) => (row?.bars ?? []).filter((bar) => bar.kind === kind).map((bar) => [bar.start, bar.end]);

/** Barres attendues en secondes depuis l'envoi, à ±0,1 s. */
function assertWindows(row: TimelineRow | undefined, kind: TimelineBarKind, t0: number, expected: ReadonlyArray<readonly [number, number]>, label: string): void {
  const bars = barsOf(row, kind);
  const shown = bars.map(([s, e]) => `[${((Number(s) - t0) / 1000).toFixed(3)}, ${e === null ? "…" : ((Number(e) - t0) / 1000).toFixed(3)}]`).join(" ");
  assert.equal(bars.length, expected.length, `${label} ${kind} : ${shown}`);
  expected.forEach(([start, end], i) => {
    const [s, e] = bars[i] as [number, number | null];
    assert.ok(Math.abs(s - t0 - start * 1000) <= 100, `${label} ${kind} n° ${i + 1} : début ${shown}, attendu ${start} s`);
    assert.ok(e !== null && Math.abs(e - t0 - end * 1000) <= 100, `${label} ${kind} n° ${i + 1} : fin ${shown}, attendu ${end} s`);
  });
}

/** Fenêtres de p1 (reconstruction « ocgraph » §9, secondes depuis l'envoi). */
function assertP1Windows(state: ActivityState, withWaits: boolean): void {
  const rows = timeline(state);
  const root = rowOf(rows, ROOT) as TimelineRow | undefined;
  assertWindows(root, "generation", T0_P1, [[0.06, 5.77], [23.18, 31.52]], "racine");
  assertWindows(root, "attente-delegation", T0_P1, [[3.94, 23.18]], "racine");
  assertWindows(root, "attente-vous", T0_P1, withWaits ? [[5.77, 6.23]] : [], "racine");
  const journaux = rowOf(rows, E1_P1) as TimelineRow | undefined;
  const changements = rowOf(rows, E2_P1) as TimelineRow | undefined;
  assertWindows(journaux, "generation", T0_P1, [[3.93, 17.3]], "analyste-journaux");
  assertWindows(changements, "generation", T0_P1, [[6.22, 23.19]], "analyste-changements");
  for (const child of [journaux, changements]) {
    assert.deepEqual(barsOf(child, "attente-delegation"), []);
    assert.deepEqual(barsOf(child, "attente-vous"), []);
  }
}

const summary = (rows: readonly LiveRow[]) =>
  rows.map((row) => [row.key.replace(ROOT, "R"), row.state, row.depth, row.agent, row.calls, row.source, row.sansSession, row.detache, row.cause, row.permissionId]);

describe("captures : fenêtres, repère, jamais démarré, détaché", () => {
  it("p1 : fenêtres de génération, d'attente du travail délégué et de votre accord à ±0,1 s ; totaux = racine + enfants", () => {
    const { direct, now } = play([P1]);
    assertP1Windows(direct, true);
    assert.deepEqual(summary(liveRows(direct, now)), [
      ["R", "termine", 0, "orchestrateur", 2, null, false, false, null, null],
      [E1_P1, "termine", 1, "analyste-journaux", 3, "ia", false, false, null, null],
      [E2_P1, "termine", 1, "analyste-changements", 4, "ia", false, false, null, null],
    ]);
    assert.deepEqual(totals(direct), { cost: 0, delegatedCost: 0, controlCost: 0, calls: 9, delegatedCalls: 7, controlCalls: 0, wallMs: totals(direct).wallMs });
    const wall = totals(direct).wallMs;
    assert.ok(wall !== null && Math.abs(wall - 31_470) <= 100, `durée murale ${wall}`);
    assert.equal(activityStatus(direct).attentesEnregistrees, true);
  });

  it("p1 relu depuis les messages (avant la 1.1) : mêmes fenêtres, attentes non enregistrées", () => {
    const { events, now, direct } = play([P1]);
    const replayed = replayMessages(emptyActivity(ROOT), snapshot(events));
    assertP1Windows(replayed, false);
    assert.deepEqual(summary(liveRows(replayed, now)), summary(liveRows(direct, now)));
    assert.deepEqual(activityStatus(replayed), { source: "messages", partial: false, attentesEnregistrees: false, choix: null, arret: null });
  });

  it("p2 : le repère du raccourci n'est pas facturé ; délégation lancée sans confirmation ; aucune génération avant la délégation", () => {
    const { direct, events, now } = play([P2]);
    const replayed = replayMessages(emptyActivity(ROOT), snapshot(events));
    const assistantsOfRoot = (snapshot(events).messages as Array<{ info: Record<string, unknown> }>).filter((m) => m.info.sessionID === ROOT && m.info.role === "assistant");
    assert.equal(assistantsOfRoot.length, 2, "repère + reprise : deux messages de l'assistant dans la racine");
    for (const [label, state] of [["faits", direct], ["messages", replayed]] as const) {
      const rows = liveRows(state, now);
      const [root, child] = rows;
      assert.equal(rows.length, 2, label);
      assert.equal(root?.calls, 1, `${label} : un seul appel d'IA facturé dans la racine (la reprise)`);
      assert.deepEqual([child?.state, child?.source, child?.commande, child?.calls, child?.detache], ["termine", "raccourci", "revue-croisee", 2, false], label);
      const line = rowOf(timeline(state), ROOT) as TimelineRow | undefined;
      assertWindows(line, "generation", T0_P2, [[2.89, 7.03]], `${label} racine`);
      assertWindows(line, "attente-delegation", T0_P2, [[0.05, 2.89]], `${label} racine`);
      assertWindows(rowOf(timeline(state), String(child?.key)) as TimelineRow | undefined, "generation", T0_P2, [[0.07, 2.89]], `${label} enfant`);
      assert.equal(totals(state).calls, 3, label);
    }
  });

  it("p6 : arrêt global, l'enfant au travail est arrêté, la délégation en attente n'a jamais démarré", () => {
    const { direct, events, now } = play([P6]);
    const expected = [
      ["R", "arrete", 0, "orchestrateur", 1, null, false, false, null, null],
      ["ses_f618a447fffeYFrtWmM6ByLKgD", "arrete", 1, "analyste-journaux", 1, "ia", false, false, null, null],
      ["appel:R:call_cc4e219c5a1f477691e18551", "jamais-demarre", 1, "analyste-changements", 0, null, true, false, null, null],
    ];
    assert.deepEqual(summary(liveRows(direct, now)), expected);
    const root = rowOf(timeline(direct), ROOT) as TimelineRow | undefined;
    assert.equal(barsOf(root, "attente-vous").every(([, end]) => end !== null), true, "l'attente de votre accord est close");
    // Juste avant la fin de l'appel : la délégation attend encore votre accord, avec la demande à laquelle répondre.
    const before = replayFacts(emptyActivity(ROOT), play([P6]).stored.filter((fact) => fact.kind !== "resultat"));
    const waiting = liveRows(before, now).find((row) => row.sansSession);
    assert.deepEqual([waiting?.state, waiting?.permissionId], ["attente-accord", "per_09e75c074001Zcyc08PMlS5EU2"]);
    const replayed = replayMessages(emptyActivity(ROOT), snapshot(events));
    assert.deepEqual(summary(liveRows(replayed, now)), expected);
  });

  it("p7 : l'accord tardif lance un sous-agent détaché, seul ou après l'arrêt de p6", () => {
    const alone = play([P7]);
    const child = liveRows(alone.direct, alone.now).find((row) => row.depth === 1);
    assert.deepEqual([child?.state, child?.detache, child?.parentId, child?.callId, child?.agent], ["redige", true, ROOT, null, "analyste-changements"]);
    const after = play([P6, P7]);
    const rows = liveRows(after.direct, after.now);
    assert.deepEqual(
      summary(rows).map((row) => row.slice(0, 2).concat(row.slice(6, 8))),
      [
        ["R", "arrete", false, false],
        ["ses_f618a447fffeYFrtWmM6ByLKgD", "arrete", false, false],
        ["appel:R:call_cc4e219c5a1f477691e18551", "jamais-demarre", true, false],
        [String(child?.key), "redige", false, true],
      ],
    );
    assert.equal(totals(after.direct).calls, 5);
  });
});

describe("différé = direct", () => {
  for (const names of [[P1], [P2], [P6], [P7], [P6, P7]]) {
    it(`${names.join(" puis ")} : lignes, Déroulé, totaux et état identiques en direct et relus depuis les faits sérialisés`, () => {
      const { direct, factsOnly, checkpoints, stored, events, now } = play(names);
      assert.ok(stored.length > 0);
      // Relu comme à l'ouverture : faits persistés, sessions et messages.
      const deferred = replayMessages(replayFacts(emptyActivity(ROOT), reread(stored)), snapshot(events));
      assert.deepEqual(liveRows(deferred, now), liveRows(direct, now));
      assert.deepEqual(timeline(deferred), timeline(direct));
      assert.deepEqual(totals(deferred), totals(direct));
      assert.deepEqual(activityStatus(deferred), activityStatus(direct));
      // À chaque fait : le direct, fait par fait, vaut la relecture des faits déjà persistés.
      for (const { count, rows } of checkpoints) {
        assert.deepEqual(liveRows(replayFacts(emptyActivity(ROOT), reread(stored.slice(0, count))), now), rowsAt(rows, now), `${count} faits`);
      }
      // Ouverture pendant le direct : direct reçu de k à `ahead`, faits persistés jusqu'à m < ahead, puis le reste avec recouvrement.
      const k = Math.floor(stored.length / 3);
      const m = Math.floor((2 * stored.length) / 3);
      const ahead = Math.min(stored.length, m + 3);
      let opened = stored.slice(k, ahead).reduce((state, fact) => applyEvent(state, factEvent(fact)), emptyActivity(ROOT));
      opened = replayFacts(opened, reread(stored.slice(0, m)));
      assert.deepEqual(liveRows(opened, now), liveRows(replayFacts(emptyActivity(ROOT), reread(stored.slice(0, ahead))), now), "direct en avance gardé");
      opened = stored.slice(k).reduce((state, fact) => applyEvent(state, factEvent(fact)), opened);
      assert.deepEqual(liveRows(opened, now), liveRows(factsOnly, now));
      assert.deepEqual(timeline(opened), timeline(factsOnly));
    });
  }
});

/** Lignes relevées au fil du direct, recalculées à la même heure que la relecture (seules les durées dépendent de l'heure). */
function rowsAt(rows: readonly LiveRow[], now: number): LiveRow[] {
  return rows.map((row) => ({ ...row, durationMs: row.since === null ? null : Math.max(0, (row.until ?? now) - row.since) }));
}

// --- Faits synthétiques ----------------------------------------------------------------------------------------------------------

const R = "ses_racine";
const D = "ses_delegue";
const C = "ses_controle";

const fact = (sessionId: string, kind: ActivityFact["kind"], at: number, data: Record<string, FactValue>, ref: string | null = null, rootId = R): ActivityFact => ({
  rootId,
  sessionId,
  kind,
  ref,
  data,
  at,
});
const facts = (state: ActivityState, list: readonly ActivityFact[]) => list.reduce((s, f) => applyEvent(s, factEvent(f)), state);
const busy = (sessionId: string, at: number) => fact(sessionId, "statut", at, { etat: "occupee" });
const idle = (sessionId: string, at: number) => fact(sessionId, "statut", at, { etat: "repos" });
const created = (sessionId: string, parent: string, at: number, role = "delegation", agent: string | null = "explore") =>
  fact(sessionId, "statut", at, { etat: "creee", role, parent, agent, instance: "principale" });
const call = (sessionId: string, messageId: string, start: number, end: number | null, cout: number): ActivityFact[] => [
  fact(sessionId, "statut", start, { etat: "appel", messageId }, messageId),
  ...(end === null ? [] : [fact(sessionId, "statut", end, { etat: "appel-fini", messageId, cout, raison: "stop" }, messageId)]),
];
const sent = (parent: string, callId: string, child: string, at: number, messageId = "msg_r") =>
  fact(parent, "consigne", at, { etat: "envoyee", callId, messageId, enfant: child, agent: "explore", source: "ia", commande: null, reprise: false }, callId);

describe("contrôle de sécurité et pied de tour", () => {
  it("la ligne du contrôle a le rôle controle ; son coût compte dans la demande, jamais dans le travail délégué", () => {
    const working = facts(emptyActivity(R), [
      busy(R, 100),
      ...call(R, "msg_r", 110, 200, 0.1),
      created(D, R, 210),
      sent(R, "call_1", D, 211),
      busy(D, 212),
      ...call(D, "msg_d", 220, 300, 0.05),
      idle(D, 301),
      fact(R, "resultat", 302, { etat: "rendu", callId: "call_1", messageId: "msg_r", enfant: D }, "call_1"),
      created(C, R, 310, "controle", "cockpit-controle"),
      busy(C, 311),
      ...call(C, "msg_c", 312, null, 0),
    ]);
    const control = liveRows(working, 400).find((row) => row.key === C);
    assert.deepEqual([control?.role, control?.state, control?.depth, control?.detache], ["controle", "controle", 1, false]);
    const done = facts(working, [...call(C, "msg_c", 312, 320, 0.01), idle(C, 321), idle(R, 400)]);
    assert.deepEqual(totals(done), { cost: 0.16, delegatedCost: 0.05, controlCost: 0.01, calls: 3, delegatedCalls: 1, controlCalls: 1, wallMs: 300 });
    assert.deepEqual(liveRows(done, 500).map((row) => [row.key, row.role, row.state, row.cost]), [
      [R, "conversation", "termine", 0.1],
      [D, "delegation", "termine", 0.05],
      [C, "controle", "termine", 0.01],
    ]);
    // Pied d'une demande : appels commencés dans la fenêtre.
    assert.deepEqual(totals(done, { from: 305, to: null }), { cost: 0.01, delegatedCost: 0, controlCost: 0.01, calls: 1, delegatedCalls: 0, controlCalls: 1, wallMs: 95 });
    assert.deepEqual(totals(done, { from: 0, to: 250 }).delegatedCost, 0.05);
  });
});

describe("faits d'arrêt et de choix", () => {
  const started = () =>
    facts(emptyActivity(R), [
      busy(R, 100),
      ...call(R, "msg_r", 110, null, 0),
      fact(R, "consigne", 120, { etat: "prepare", callId: "call_1", messageId: "msg_r" }, "call_1"),
      created(D, R, 130),
      sent(R, "call_1", D, 131),
      busy(D, 132),
      fact(R, "consigne", 140, { etat: "prepare", callId: "call_2", messageId: "msg_r" }, "call_2"),
      fact(R, "attente", 150, { permission: "task", messageId: "msg_r", callId: "call_2", agent: "general" }, "per_1"),
    ]);

  it("plafond : sessions arrêtées par opencode puis fait {cause} ; délégation en attente jamais démarrée, attente close", () => {
    const before = started();
    assert.deepEqual(summary(liveRows(before, 200)), [
      [R, "attend-delegation", 0, null, 1, null, false, false, null, null],
      [D, "travaille", 1, "explore", 0, "ia", false, false, null, null],
      ["appel:ses_racine:call_2", "attente-accord", 1, "general", 0, null, true, false, null, "per_1"],
    ]);
    const stopped = facts(before, [
      fact(D, "statut", 160, { etat: "erreur", erreur: "MessageAbortedError" }),
      idle(D, 160),
      fact(R, "statut", 161, { etat: "erreur", erreur: "MessageAbortedError" }),
      idle(R, 161),
      fact(R, "resultat", 170, { etat: "interrompu", callId: "call_1", messageId: "msg_r", enfant: D }, "call_1"),
      fact(R, "statut", 180, { cause: "plafond", motif: "plafond-cout", nonConfirmees: 0 }),
    ]);
    assert.deepEqual(summary(liveRows(stopped, 200)), [
      [R, "arrete", 0, null, 1, null, false, false, "plafond", null],
      [D, "arrete", 1, "explore", 0, "ia", false, false, "plafond", null],
      ["appel:ses_racine:call_2", "jamais-demarre", 1, "general", 0, null, true, false, "plafond", null],
    ]);
    assert.deepEqual(activityStatus(stopped).arret, { cause: "plafond", at: 180, nonConfirmees: 0 });
    assert.deepEqual(barsOf(rowOf(timeline(stopped), R) as TimelineRow | undefined, "attente-vous"), [[150, 180]]);
    // Nouvelle demande après l'arrêt : la racine travaille de nouveau, sans cause.
    const again = liveRows(facts(stopped, [busy(R, 300)]), 400)[0];
    assert.deepEqual([again?.state, again?.cause], ["travaille", null]);
    // Un arrêt suivant ne réattribue pas sa cause aux sessions arrêtées avant le premier.
    const second = facts(stopped, [fact(R, "statut", 400, { cause: "non-controle", motif: "non-controle", nonConfirmees: 0 })]);
    assert.equal(liveRows(second, 500)[1]?.cause, "plafond");
  });

  it("opencode relancé (interrompue) : les sessions encore occupées sont arrêtées ; un arrêt non confirmé laisse voir le travail", () => {
    const interrupted = facts(started(), [fact(R, "statut", 200, { cause: "interrompue", motif: "rechargement", nonConfirmees: 0 })]);
    assert.deepEqual(liveRows(interrupted, 300).map((row) => [row.key, row.state, row.cause, row.until]), [
      [R, "arrete", "interrompue", 200],
      [D, "arrete", "interrompue", 200],
      ["appel:ses_racine:call_2", "jamais-demarre", "interrompue", 200],
    ]);
    const unconfirmed = facts(started(), [fact(R, "statut", 200, { cause: "arret", motif: "vous", nonConfirmees: 1 })]);
    assert.deepEqual(liveRows(unconfirmed, 300).map((row) => [row.key, row.state]), [
      [R, "attend-delegation"],
      [D, "travaille"],
      ["appel:ses_racine:call_2", "jamais-demarre"],
    ]);
    assert.equal(activityStatus(unconfirmed).arret?.nonConfirmees, 1);
    // Un fait {cause} d'une session enfant ou d'une cause inconnue n'arrête rien.
    for (const bad of [fact(D, "statut", 200, { cause: "arret" }), fact(R, "statut", 200, { cause: "inconnue" })]) {
      assert.equal(activityStatus(facts(started(), [bad])).arret, null);
    }
  });

  it("choix : le dernier fait de la racine fait foi ; retour à « Demander » sans clic annoncé ; valeurs inconnues ignorées", () => {
    const chosen = facts(emptyActivity(R), [fact(R, "choix", 100, { choix: "autonome", cause: "clic" })]);
    assert.deepEqual(activityStatus(chosen).choix, { choix: "autonome", cause: "clic", at: 100 });
    const back = facts(chosen, [fact(R, "choix", 200, { choix: "demander", cause: "plafond-cout" })]);
    assert.deepEqual(activityStatus(back).choix, { choix: "demander", cause: "plafond-cout", at: 200 });
    assert.deepEqual(announcements(chosen, back, 1_000).say?.map((a) => [a.code, a.cause]), [["retour-demander", "plafond-cout"]]);
    const clicked = facts(chosen, [fact(R, "choix", 200, { choix: "demander", cause: "clic" })]);
    assert.equal(announcements(chosen, clicked, 1_000).say, null);
    for (const bad of [
      fact(R, "choix", 300, { choix: "omo", cause: "clic" }),
      fact(R, "choix", 300, { choix: "demander", cause: "au-hasard" }),
      fact(D, "choix", 300, { choix: "demander", cause: "clic" }),
    ]) {
      assert.deepEqual(activityStatus(facts(back, [created(D, R, 250), bad])).choix, { choix: "demander", cause: "plafond-cout", at: 200 });
    }
  });
});

describe("attentes d'une commande, délégation close sans résultat, relecture des rôles", () => {
  const bash = (at: number, phase: string) =>
    fact(R, "statut", at, { etat: "outil", outil: "commande", nom: "bash", phase, callId: "call_b", messageId: "msg_r", fichier: null, dossier: null }, "call_b");

  it("commande en attente de votre accord : la session attend, la génération s'interrompt le temps de l'attente", () => {
    const waiting = facts(emptyActivity(R), [
      busy(R, 100),
      ...call(R, "msg_r", 110, null, 0),
      bash(150, "en-cours"),
      fact(R, "attente", 150, { permission: "bash", messageId: "msg_r", callId: "call_b", agent: null }, "per_b"),
    ]);
    const [root] = liveRows(waiting, 180);
    assert.deepEqual([root?.state, root?.permissionId, root?.activity, root?.outilCallId], ["attente-accord", "per_b", { kind: "commande", detail: null }, "call_b"]);
    assert.deepEqual(liveRows(waiting, 180).length, 1, "aucune ligne de délégation pour une commande");
    const answered = facts(waiting, [fact(R, "reponse", 200, { reponse: "once" }, "per_b"), bash(260, "termine"), ...call(R, "msg_r", 110, 290, 0.02), idle(R, 300)]);
    const line = rowOf(timeline(answered), R) as TimelineRow | undefined;
    assert.deepEqual(barsOf(line, "generation"), [[100, 150], [200, 300]]);
    assert.deepEqual(barsOf(line, "attente-vous"), [[150, 200]]);
    const [done] = liveRows(answered, 400);
    assert.deepEqual([done?.state, done?.permissionId, done?.activity, done?.cost], ["termine", null, null, 0.02]);
    // Commande interrompue avant votre réponse : l'attente est close avec elle.
    const interrupted = facts(waiting, [bash(170, "interrompu")]);
    assert.deepEqual([liveRows(interrupted, 180)[0]?.state, barsOf(rowOf(timeline(interrupted), R) as TimelineRow | undefined, "attente-vous")], ["travaille", [[150, 170]]]);
  });

  it("états de la session qui délègue : prépare, nouvelle tentative ; délégation refusée ; enfant détaché seulement si la session parente ne travaillait plus", () => {
    const preparing = facts(emptyActivity(R), [busy(R, 100), ...call(R, "msg_r", 110, null, 0), fact(R, "consigne", 120, { etat: "prepare", callId: "call_1", messageId: "msg_r" }, "call_1")]);
    assert.deepEqual(liveRows(preparing, 130).map((row) => [row.key, row.state]), [[R, "prepare-delegation"]], "aucune ligne tant que l'appel s'écrit");
    // p1 entre 3,99 s et 5,77 s : un enfant travaille pendant que le second appel s'écrit encore.
    const mixed = facts(emptyActivity(R), [busy(R, 100), ...call(R, "msg_r", 110, null, 0), created(D, R, 112), sent(R, "call_0", D, 113), busy(D, 114)]);
    assert.equal(liveRows(mixed, 130)[0]?.state, "attend-delegation");
    const writing = facts(mixed, [fact(R, "consigne", 120, { etat: "prepare", callId: "call_1", messageId: "msg_r" }, "call_1")]);
    assert.equal(liveRows(writing, 130)[0]?.state, "prepare-delegation", "un appel encore en écriture l'emporte sur l'attente");
    const retrying = facts(preparing, [fact(R, "statut", 125, { etat: "nouvelle-tentative", tentative: 3 })]);
    assert.deepEqual([liveRows(retrying, 130)[0]?.state, liveRows(retrying, 130)[0]?.attempt], ["nouvelle-tentative", 3]);
    const asked = facts(preparing, [fact(R, "attente", 130, { permission: "task", messageId: "msg_r", callId: "call_1", agent: "general" }, "per_1")]);
    const refused = facts(asked, [fact(R, "reponse", 140, { reponse: "reject" }, "per_1")]);
    assert.deepEqual(liveRows(refused, 150).map((row) => [row.key, row.state, row.permissionId]), [
      [R, "prepare-delegation", null],
      ["appel:ses_racine:call_1", "jamais-demarre", null],
    ]);
    // Enfant pas encore lié à sa délégation (session.created avant la partie task) : jamais dit détaché si la session parente travaille.
    const early = facts(preparing, [created(D, R, 150)]);
    assert.deepEqual([liveRows(early, 160)[1]?.key, liveRows(early, 160)[1]?.detache], [D, false]);
    const orphan = facts(emptyActivity(R), [busy(R, 100), idle(R, 200), created(D, R, 300), busy(D, 301)]);
    assert.equal(liveRows(orphan, 400)[1]?.detache, true);
  });

  it("message qui délègue clos sans résultat reçu : la délégation ne retient plus la session", () => {
    const waiting = facts(emptyActivity(R), [busy(R, 100), ...call(R, "msg_r", 110, null, 0), created(D, R, 120), sent(R, "call_1", D, 121), busy(D, 122), idle(D, 200)]);
    assert.equal(liveRows(waiting, 250)[0]?.state, "attend-delegation");
    const closed = facts(waiting, [...call(R, "msg_r", 110, 210, 0), ...call(R, "msg_r2", 220, null, 0)]);
    assert.equal(liveRows(closed, 250)[0]?.state, "travaille");
  });

  it("relecture des messages : session de contrôle lue dans metadata.cockpit, session cachée jamais suivie", () => {
    const assistant = (id: string, sessionID: string, created: number, completed: number, cost: number) => ({
      info: { id, sessionID, role: "assistant", time: { created, completed } },
      parts: [{ id: `prt_${id}_debut`, type: "step-start" }, { id: `prt_${id}_fin`, type: "step-finish", cost, reason: "stop" }],
    });
    const state = replayMessages(emptyActivity(R), {
      sessions: [
        { id: R, title: "Conversation" },
        { id: C, parentID: R, title: "Contrôle de sécurité", metadata: { cockpit: "controle" }, time: { created: 150 } },
        { id: "ses_cachee", parentID: R, title: "Cachée", metadata: { cockpit: "classifier" } },
      ],
      messages: [assistant("msg_r", R, 100, 300, 0.1), assistant("msg_c", C, 160, 170, 0.01), assistant("msg_h", "ses_cachee", 180, 190, 5)],
    });
    assert.deepEqual(liveRows(state, 400).map((row) => [row.key, row.role, row.state, row.title, row.cost]), [
      [R, "conversation", "termine", "Conversation", 0.1],
      [C, "controle", "termine", "Contrôle de sécurité", 0.01],
    ]);
    assert.deepEqual(totals(state), { cost: 0.11, delegatedCost: 0, controlCost: 0.01, calls: 2, delegatedCalls: 0, controlCalls: 1, wallMs: 200 });
  });
});

describe("bornes : 3 niveaux et 50 sessions", () => {
  it("au-delà de 50 sessions, les suivantes ne sont ni montrées ni comptées : « Déroulé partiel »", () => {
    const list: ActivityFact[] = [busy(R, 1)];
    for (let i = 0; i < 60; i++) {
      const id = `ses_enfant_${String(i).padStart(2, "0")}`;
      list.push(created(id, R, 10 + i), busy(id, 10 + i), ...call(id, `msg_${i}`, 10 + i, 11 + i, 0.001));
    }
    const state = facts(emptyActivity(R), list);
    const rows = liveRows(state, 100);
    assert.equal(rows.length, ACTIVITY_MAX_SESSIONS);
    assert.equal(rows.at(-1)?.key, "ses_enfant_48");
    assert.equal(totals(state).calls, ACTIVITY_MAX_SESSIONS - 1);
    assert.equal(activityStatus(state).partial, true);
    assert.equal(activityStatus(facts(emptyActivity(R), list.slice(0, 1 + 3 * 49))).partial, false);
  });

  it("au-delà de 3 niveaux sous la racine : non suivi ; une boucle de parents ne suit rien et ne bloque pas", () => {
    const chain = ["ses_n1", "ses_n2", "ses_n3", "ses_n4", "ses_n5"];
    const list = chain.map((id, i) => created(id, i === 0 ? R : (chain[i - 1] as string), 10 + i));
    const state = facts(emptyActivity(R), list);
    assert.deepEqual(liveRows(state, 100).map((row) => [row.key, row.depth]), [[R, 0], ["ses_n1", 1], ["ses_n2", 2], ["ses_n3", 3]]);
    assert.equal(ACTIVITY_MAX_DEPTH, 3);
    assert.equal(activityStatus(state).partial, true);
    const loop = facts(emptyActivity(R), [created("ses_x", "ses_y", 1), created("ses_y", "ses_x", 2)]);
    assert.deepEqual(liveRows(loop, 10).map((row) => row.key), [R]);
    assert.equal(activityStatus(loop).partial, false);
    const marked = facts(emptyActivity(R), [busy(R, 1), fact(R, "affichage", 2, { etat: "deroule-partiel" })]);
    assert.equal(activityStatus(marked).partial, true);
  });
});

describe("applyEvent", () => {
  it("fait refusé par la garde, d'une autre racine ou d'un autre événement du cockpit, delta, doublon : même état", () => {
    const state = facts(emptyActivity(R), [busy(R, 1)]);
    const same = [
      factEvent(fact(R, "statut", 2, { etat: "Texte planté" })),
      factEvent(fact(R, "statut", 2, { etat: "repos" }, null, "ses_autre")),
      factEvent({ ...fact(R, "statut", 2, { etat: "repos" }), kind: "inconnu" as ActivityFact["kind"] }),
      { kind: "cockpit" as const, type: "autonomie.choix", data: { rootId: R, choix: "demander", cause: "clic" } },
      { kind: "opencode" as const, event: { type: "message.part.delta", properties: { sessionID: R, messageID: "msg_1", partID: "prt_1", field: "text", delta: "texte" } } },
      { kind: "opencode" as const, event: { type: "message.part.updated", properties: { part: { sessionID: R, type: "step-start", messageID: "msg_1" } } } },
      factEvent(busy(R, 1)),
      factEvent({ ...busy(R, 1), id: 99 }),
    ];
    for (const event of same) assert.equal(applyEvent(state, event), state, JSON.stringify(event));
    assert.equal(replayFacts(state, [fact(R, "statut", 3, { etat: "repos" }, null, "ses_autre"), { etat: "repos" }]).facts.length, 1);
    // Le fait gardé est une copie : modifier l'objet reçu ne change pas l'état.
    const received = busy(R, 1);
    const copied = applyEvent(emptyActivity(R), factEvent(received));
    (received.data as Record<string, FactValue>).etat = "repos";
    assert.equal(liveRows(copied, 10)[0]?.state, "travaille");
  });

  it("l'état précédent n'est jamais modifié ; prolonger une version plus ancienne ne perd ni ne duplique aucun fait", () => {
    const s1 = facts(emptyActivity(R), [busy(R, 1)]);
    const rows1 = liveRows(s1, 10);
    const s2 = facts(s1, [idle(R, 5)]);
    const branch = facts(s1, [fact(R, "statut", 3, { etat: "nouvelle-tentative", tentative: 2 })]);
    assert.equal(s1.facts.length, 1);
    assert.deepEqual(liveRows(s1, 10), rows1);
    assert.deepEqual([s2.facts.length, branch.facts.length], [2, 2]);
    assert.equal(liveRows(branch, 10)[0]?.attempt, 2);
    const joined = facts(branch, [idle(R, 5)]);
    assert.equal(joined.facts.length, 3, "le fait de l'autre version n'est pas pris pour un doublon");
    assert.equal(facts(joined, [idle(R, 5)]), joined);
  });

  it("sessions et messages : titre borné, parent hors de l'arbre ignoré, message utilisateur dédoublonné par (id, time.completed)", () => {
    const state = facts(emptyActivity(R), [busy(R, 1), created(D, R, 2)]);
    const session = (info: Record<string, unknown>) => ({ kind: "opencode" as const, event: { type: "session.updated", properties: { info } } });
    const titled = applyEvent(state, session({ id: R, title: "x".repeat(ACTIVITY_TITLE_MAX + 50) }));
    assert.equal(liveRows(titled, 10)[0]?.title.length, ACTIVITY_TITLE_MAX);
    assert.equal(applyEvent(titled, session({ id: "ses_ailleurs", parentID: "ses_inconnue", title: "Autre" })), titled);
    assert.equal(applyEvent(titled, session({ id: R, title: "x".repeat(ACTIVITY_TITLE_MAX + 50) })), titled);
    const message = (id: string, completed: number | undefined, agent = "build", role = "user", created = 5, sessionID = R) => ({
      kind: "opencode" as const,
      event: { type: "message.updated", properties: { info: { id, sessionID, role, agent, time: { created, completed } } } },
    });
    const first = applyEvent(titled, message("msg_u1", undefined));
    assert.equal(liveRows(first, 10)[0]?.agent, "build");
    assert.equal(applyEvent(first, message("msg_u1", undefined)), first, "même (id, time.completed)");
    assert.notEqual(applyEvent(first, message("msg_u1", 9)), first);
    assert.equal(applyEvent(first, message("msg_a1", 9, "plan", "assistant")), first, "message de l'assistant : jamais lu (repère d'un raccourci)");
    assert.equal(applyEvent(first, message("msg_u2", undefined, "Assistant libre\nx")), first);
    assert.equal(applyEvent(first, message("msg_u0", undefined, "plan", "user", 1)), first, "message plus ancien que le dernier lu");
    assert.equal(liveRows(applyEvent(first, message("msg_u3", undefined, "plan", "user", 10)), 10)[0]?.agent, "plan");
    // Informations de session bornées : au-delà, ni session ni assistant de plus ne sont retenus.
    let flooded = facts(emptyActivity(R), [busy(R, 1), created(D, R, 2, "delegation", null)]);
    for (let i = 0; i < 150; i++) flooded = applyEvent(flooded, session({ id: `ses_info_${String(i).padStart(3, "0")}`, parentID: R, title: "Titre" }));
    assert.equal(flooded.sessions.size, ACTIVITY_MAX_SESSIONS * 2);
    assert.equal(applyEvent(flooded, message("msg_d1", undefined, "plan", "user", 5, D)), flooded);
    assert.equal(liveRows(flooded, 10).length, ACTIVITY_MAX_SESSIONS);
    assert.equal(activityStatus(flooded).partial, true);
  });
});

describe("annonces", () => {
  it("transitions seulement, fusionnées par ligne, au plus une toutes les 2 s ; rien pour un état final déjà atteint à l'ouverture", () => {
    const s1 = facts(emptyActivity(R), [busy(R, 0)]);
    let out = announcements(emptyActivity(R), s1, 1_000);
    assert.deepEqual(out.say?.map((a) => [a.code, a.key]), [["commence", R]]);
    const s2 = facts(s1, [created(D, R, 10), sent(R, "call_1", D, 11), busy(D, 12)]);
    out = announcements(s1, s2, 1_500, out.queue);
    assert.equal(out.say, null);
    assert.deepEqual(out.queue.pending.map((a) => [a.code, a.key]), [["commence", D]]);
    const s3 = facts(s2, [idle(D, 1_400), fact(R, "resultat", 1_401, { etat: "rendu", callId: "call_1", messageId: "msg_r", enfant: D }, "call_1")]);
    out = announcements(s2, s3, 1_900, out.queue);
    assert.equal(out.say, null);
    out = announcements(s3, s3, 2_999, out.queue);
    assert.equal(out.say, null, "moins de 2 s depuis la dernière annonce");
    out = announcements(s3, s3, 3_000, out.queue);
    assert.deepEqual(out.say?.map((a) => [a.code, a.key, a.durationMs]), [["termine", D, 1_388]]);
    assert.deepEqual(out.queue, { pending: [], lastAt: 3_000 });
    assert.equal(announcements(s3, s3, 9_000, out.queue).say, null, "file vide : rien à dire");
    // Ouverture : un état final relu n'est pas annoncé ; une attente de votre accord l'est.
    const waiting = facts(s3, [fact(R, "consigne", 1_500, { etat: "prepare", callId: "call_2", messageId: "msg_r" }, "call_2"), fact(R, "attente", 1_501, { permission: "task", messageId: "msg_r", callId: "call_2", agent: "general" }, "per_2")]);
    assert.deepEqual(announcements(emptyActivity(R), waiting, 1_000).say?.map((a) => [a.code, a.key]), [
      ["commence", R],
      ["attente-accord", "appel:ses_racine:call_2"],
    ]);
    // Autre conversation : la file est vidée, rien n'est annoncé.
    const other = facts(emptyActivity("ses_autre"), [fact("ses_autre", "statut", 1, { etat: "occupee" }, null, "ses_autre")]);
    assert.deepEqual(announcements(s3, other, 5_000, { pending: out.queue.pending, lastAt: 4_000 }), { say: null, queue: { pending: [], lastAt: null } });
    assert.equal(EMPTY_ANNOUNCEMENTS.pending.length, 0);
  });
});

describe("registre (Archives)", () => {
  it("appels, délégations et attentes du registre : mêmes lignes et totaux ; session inconnue ignorée ; contrôle hors travail délégué", () => {
    const response: ActivityResponse = {
      runs: [],
      delegations: [
        { id: 1, rootId: R, parentSessionId: R, childSessionId: D, callId: "call_1", agent: "explore", command: null, source: "ia", sansConfirmation: false, state: "terminee", permissionId: "per_1", createdAt: 150, startedAt: 160, endedAt: 400 },
        { id: 2, rootId: R, parentSessionId: R, childSessionId: null, callId: "call_2", agent: "general", command: null, source: "ia", sansConfirmation: false, state: "jamais-demarree", permissionId: null, createdAt: 170, startedAt: null, endedAt: 180 },
        { id: 3, rootId: "ses_autre", parentSessionId: R, childSessionId: null, callId: "call_3", agent: "general", command: null, source: "ia", sansConfirmation: false, state: "refusee", permissionId: null, createdAt: 170, startedAt: null, endedAt: 180 },
      ],
      waits: [
        { permissionId: "per_1", sessionId: R, rootId: R, permission: "task", target: null, askedAt: 140, repliedAt: 155, reply: "once", repliedBy: "vous" },
        { permissionId: "per_2", sessionId: R, rootId: "ses_autre", permission: "bash", target: null, askedAt: 300, repliedAt: null, reply: null, repliedBy: null },
      ],
      decisions: [],
      requests: [],
      usageSpans: [
        { sessionId: R, messageId: "msg_r1", start: 100, end: 450, cost: 0.2 },
        { sessionId: D, messageId: "msg_d1", start: 170, end: 390, cost: 0.05 },
        { sessionId: C, messageId: "msg_c1", start: 460, end: 470, cost: 0.01 },
        { sessionId: "ses_inconnue", messageId: "msg_x", start: 100, end: 110, cost: 9 },
      ],
    };
    const state = fromLedger(R, response, [
      { id: R, parentId: null, purpose: "chat", title: "Conversation" },
      { id: D, parentId: R, purpose: "chat" },
      { id: C, parentId: R, purpose: "controle" },
    ]);
    assert.deepEqual(liveRows(state, 1_000).map((row) => [row.key, row.role, row.state, row.agent, row.cost, row.title]), [
      [R, "conversation", "termine", null, 0.2, "Conversation"],
      [D, "delegation", "termine", "explore", 0.05, ""],
      ["appel:ses_racine:call_2", "delegation", "jamais-demarre", "general", 0, ""],
      [C, "controle", "termine", null, 0.01, ""],
    ]);
    assert.deepEqual(totals(state), { cost: 0.26, delegatedCost: 0.05, controlCost: 0.01, calls: 3, delegatedCalls: 1, controlCalls: 1, wallMs: 370 });
    const root = rowOf(timeline(state), R) as TimelineRow | undefined;
    assert.deepEqual(barsOf(root, "attente-vous"), [[140, 155]]);
    assert.deepEqual(barsOf(root, "attente-delegation"), [[140, 400]]);
    assert.deepEqual(barsOf(root, "generation"), [[100, 140], [400, 450]]);
    assert.deepEqual(activityStatus(state), { source: "registre", partial: false, attentesEnregistrees: false, choix: null, arret: null });
    // Faits persistés relus ensuite : ils remplacent la reconstruction.
    assert.equal(replayFacts(state, [busy(R, 1)]).facts.length, 1);
  });
});

describe("pureté du réducteur", () => {
  it("ni module node, ni process, ni horloge, ni aléa, ni réseau ; imports permis seulement", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "shared", "activity.ts"), "utf8");
    assert.equal(source.includes('"node:'), false);
    assert.equal(/\bprocess\./.test(source), false);
    assert.equal(/\bDate\.now\b|new Date\b|Math\.random|\bfetch\s*\(|\bsetTimeout\b|\bsetInterval\b|\bperformance\.|\bconsole\./.test(source), false);
    const imports = [...source.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1]);
    for (const spec of imports) assert.ok(/^\.\/[\w.-]+\.ts$/.test(spec ?? ""), String(spec));
  });
});
