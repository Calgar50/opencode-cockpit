// Chronologie (plan d'exécution it5, fiche L47a, D-5-09 ; spécification §2.1 l.63, §5.1 l.883-884, §5.5 l.920) : captures p1
// (appels par session, jetons tirés de lignes `usage` synthétiques, repères d'outils), p2 (message repère jamais compté), p6
// (jamais démarré : aucun appel, aucun repère) et p7 (curseur en direct) ; faits synthétiques pour les repères, les groupes de
// délégations, le curseur, les bornes et « Déroulé partiel » ; ligne `usage` absente ou d'une autre session → jetons null ; fait
// d'une autre racine écarté ; pureté ; déterminisme.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { type ActivityState, applyEvent, emptyActivity, timeline } from "./shared/activity.ts";
import { EventMemory, type FactContext, FactDeduper, type FactEvent, type FactSession, factsFromEvent } from "./shared/activity-facts.ts";
import type { ActivityFact, FactValue } from "./shared/activity-types.ts";
import { ATTENTE_CODE, chronologie, type ChronologieRow, type ChronologieUsageRow, type ChronologieView } from "./shared/chronologie.ts";
import { readCapture } from "./test-support/fake-opencode.ts";

const ROOT = "ses_f618ff214ffevi6gfuGx6TvpTP";
const P1 = "p1-delegation-parallele.jsonl";
const P2 = "p2-commande-subtask.jsonl";
const P6 = "p6-arret-global.jsonl";
const P7 = "p7-autorisation-orpheline.jsonl";
/** Envoi de p1 (reconstruction de référence « ocgraph », §9), pour lire les bornes en secondes. */
const T0_P1 = 1_789_364_546_597;
const E1_P1 = "ses_f618fc47effewRlFGgpRFi51pw";
const E2_P1 = "ses_f618fbb91ffepC06O3owB9ayZ7";
/** p2 : message de l'assistant qui ne porte que la partie `task` du raccourci (ni step-start, ni step-finish, 0 jeton). */
const REPERE_P2 = "msg_09e70de6f001K8ACuHCuLBlbdL";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// --- Captures ---------------------------------------------------------------------------------------------------------------------

/** Côté serveur (L4a, L4b) : sessions connues du cockpit, mémoire du flux, faits gardés par le magasin. */
class Server {
  readonly sessions = new Map<string, FactSession>([[ROOT, { rootId: ROOT, parentId: null, purpose: "chat", instance: "principale" }]]);
  readonly memory = new EventMemory();
  readonly store = new FactDeduper();

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
      promptKind: () => null,
      firstUserMessage: (id) => this.memory.firstUserMessage(id),
      userMessageParts: (id) => this.memory.userMessageParts(id),
      unansweredUserMessages: (id) => this.memory.unansweredUserMessages(id),
    };
  }

  accept(event: FactEvent, receivedAt: number): ActivityFact[] {
    this.memory.observe(event);
    const info = event.properties?.info;
    if ((event.type === "session.created" || event.type === "session.updated") && isRecord(info) && typeof info.id === "string") {
      const session = this.resolve(info.id, info);
      if (session) this.sessions.set(info.id, session);
    }
    return factsFromEvent(event, this.ctx(receivedAt)).filter((fact) => this.store.accept(fact));
  }
}

/** Capture rejouée comme en direct : événements du flux relayés, puis les faits que le magasin accepte. */
function play(name: string): { state: ActivityState; now: number } {
  const server = new Server();
  let state = emptyActivity(ROOT);
  let now = 0;
  for (const { recv, wire } of readCapture(name)) {
    const event = wire.payload as FactEvent;
    now = Math.max(now, recv);
    state = applyEvent(state, { kind: "opencode", event });
    for (const fact of server.accept(event, recv)) state = applyEvent(state, { kind: "cockpit", type: "activite.fait", data: fact });
  }
  return { state, now: now + 1_000 };
}

/** Une ligne `usage` par appel du Déroulé, aux jetons reconnaissables : entrée 100 i / sortie 10 i / cache 5 i + 2 i / réflexion i. */
function usageOf(state: ActivityState): ChronologieUsageRow[] {
  const out: ChronologieUsageRow[] = [];
  for (const row of timeline(state)) {
    for (const call of row.calls) {
      const i = out.length + 1;
      out.push({
        messageId: call.messageId,
        sessionId: row.sessionId,
        agent: "orchestrateur",
        providerId: "github-copilot",
        modelId: `ia-${i}`,
        variant: i % 2 === 0 ? "haute" : null,
        tokensInput: 100 * i,
        tokensOutput: 10 * i,
        tokensReasoning: i,
        tokensCacheRead: 5 * i,
        tokensCacheWrite: 2 * i,
        cost: 0.5 * i,
        createdAt: call.start,
        completedAt: call.end,
      });
    }
  }
  return out;
}

const rowOf = (view: ChronologieView, key: string): ChronologieRow => {
  const row = view.rows.find((candidate) => candidate.key === key);
  assert.ok(row !== undefined, `ligne ${key} absente`);
  return row;
};
const codes = (row: ChronologieRow, genre: string) => row.ticks.filter((tick) => tick.genre === genre).map((tick) => tick.code);
/** Jetons attendus pour le i-ième appel de `usageOf` : entrée + cache, sortie + réflexion, cache, réflexion. */
const jetons = (i: number) => [107 * i, 11 * i, 7 * i, i];
const jetonsOf = (row: ChronologieRow) => row.calls.map((call) => [call.tokensIn, call.tokensOut, call.tokensCache, call.tokensReasoning]);

describe("chronologie : captures p1, p2, p6 et p7", () => {
  it("p1 : appels par session, jetons des lignes `usage`, repères d'outils, bornes et aucun groupe", () => {
    const { state, now } = play(P1);
    const view = chronologie(state, usageOf(state), now);
    assert.deepEqual(view.rows.map((row) => [row.key.replace(ROOT, "R"), row.role, row.state, row.calls.length]), [
      ["R", "conversation", "termine", 2],
      [E1_P1, "delegation", "termine", 3],
      [E2_P1, "delegation", "termine", 4],
    ]);
    assert.deepEqual(jetonsOf(rowOf(view, ROOT)), [jetons(1), jetons(2)]);
    assert.deepEqual(jetonsOf(rowOf(view, E1_P1)), [jetons(3), jetons(4), jetons(5)]);
    assert.deepEqual(jetonsOf(rowOf(view, E2_P1)), [jetons(6), jetons(7), jetons(8), jetons(9)]);
    assert.deepEqual(rowOf(view, ROOT).calls.map((call) => [call.model, call.variant]), [["ia-1", null], ["ia-2", "haute"]]);
    // Le coût reste celui du Déroulé (fait « appel-fini »), jamais celui de la ligne `usage` (0,5 i ici).
    assert.deepEqual(rowOf(view, ROOT).calls.map((call) => call.cost), [0, 0]);
    // Repères d'outils : la racine délègue (faits consigne et resultat), les enfants lisent et cherchent.
    assert.deepEqual(codes(rowOf(view, ROOT), "outil"), []);
    assert.deepEqual([...new Set(codes(rowOf(view, E1_P1), "outil"))].sort(), ["chercher", "lire"]);
    assert.deepEqual([codes(rowOf(view, E1_P1), "outil").length, codes(rowOf(view, E2_P1), "outil").length], [4, 5]);
    assert.deepEqual(codes(rowOf(view, ROOT), "attente"), [ATTENTE_CODE]);
    assert.deepEqual(view.groupes, []);
    assert.equal(view.curseur, null, "tout est terminé : aucun curseur");
    assert.ok(view.start !== null && Math.abs(view.start - (T0_P1 - 7_737)) <= 100, `début ${view.start}`);
    assert.ok(view.end !== null && Math.abs(view.end - (T0_P1 + 31_520)) <= 100, `fin ${view.end}`);
    assert.equal(view.partiel, false);
  });

  it("p2 : le message repère du raccourci n'est jamais un appel, même avec une ligne `usage`", () => {
    const { state, now } = play(P2);
    const usage = usageOf(state);
    assert.equal(usage.some((row) => row.messageId === REPERE_P2), false, "le repère n'a pas d'appel dans le Déroulé");
    const repere: ChronologieUsageRow = { ...(usage[0] as ChronologieUsageRow), messageId: REPERE_P2, sessionId: ROOT, tokensInput: 0, tokensOutput: 0, tokensReasoning: 0, tokensCacheRead: 0, tokensCacheWrite: 0 };
    const view = chronologie(state, [repere, ...usage], now);
    const racine = rowOf(view, ROOT);
    assert.equal(racine.calls.length, 1, "un seul appel facturé dans la racine (la reprise)");
    assert.equal(racine.calls.some((call) => call.messageId === REPERE_P2), false);
    assert.equal(view.rows.reduce((sum, row) => sum + row.calls.length, 0), 3);
  });

  it("p6 : la délégation jamais démarrée n'a ni appel ni repère ; les repères de la session qui délègue restent sur sa ligne", () => {
    const { state, now } = play(P6);
    const view = chronologie(state, usageOf(state), now);
    const jamais = view.rows.find((row) => row.state === "jamais-demarre");
    assert.ok(jamais !== undefined);
    assert.deepEqual([jamais.calls, jamais.ticks], [[], []]);
    assert.equal(jamais.sessionId, ROOT, "la ligne sans session porte la session qui délègue");
    assert.deepEqual(codes(rowOf(view, ROOT), "attente"), [ATTENTE_CODE]);
    assert.equal(view.curseur, null, "après l'arrêt global, plus rien n'est en cours");
  });

  it("p7 : le curseur suit le direct tant qu'une ligne travaille ; les quatre captures passent sans exception", () => {
    const { state, now } = play(P7);
    const view = chronologie(state, usageOf(state), now);
    assert.equal(view.curseur, now);
    assert.equal(view.end, now, "la borne de fin suit le curseur");
    for (const name of [P1, P2, P6, P7]) {
      const capture = play(name);
      const vue = chronologie(capture.state, usageOf(capture.state), capture.now);
      assert.ok(vue.rows.length > 0, name);
      assert.equal(chronologie(capture.state, usageOf(capture.state), null).curseur, null, `${name} : hors direct, aucun curseur`);
    }
  });
});

// --- Faits synthétiques -----------------------------------------------------------------------------------------------------------

const R = "ses_racine";
const D1 = "ses_d1";
const D2 = "ses_d2";
const D3 = "ses_d3";

const fact = (sessionId: string, kind: ActivityFact["kind"], at: number, data: Record<string, FactValue>, ref: string | null = null, rootId = R): ActivityFact => ({
  rootId,
  sessionId,
  kind,
  ref,
  data,
  at,
});
const build = (list: readonly ActivityFact[], rootId = R): ActivityState =>
  list.reduce((state, data) => applyEvent(state, { kind: "cockpit", type: "activite.fait", data }), emptyActivity(rootId));
const busy = (sessionId: string, at: number) => fact(sessionId, "statut", at, { etat: "occupee" });
const idle = (sessionId: string, at: number) => fact(sessionId, "statut", at, { etat: "repos" });
const created = (sessionId: string, parent: string, at: number, agent: string) =>
  fact(sessionId, "statut", at, { etat: "creee", role: "delegation", parent, agent, instance: "principale" });
const call = (sessionId: string, messageId: string, start: number, end: number | null, cout = 0): ActivityFact[] => [
  fact(sessionId, "statut", start, { etat: "appel", messageId }, messageId),
  ...(end === null ? [] : [fact(sessionId, "statut", end, { etat: "appel-fini", messageId, cout, raison: "stop" }, messageId)]),
];
const outil = (sessionId: string, callId: string, at: number, nom: string, phase = "en-cours") =>
  fact(sessionId, "statut", at, { etat: "outil", outil: "autre", nom, phase, callId, messageId: "msg_1", fichier: null, dossier: null }, callId);
const ligneUsage = (messageId: string, sessionId: string, jeu: Partial<ChronologieUsageRow> = {}): ChronologieUsageRow => ({
  messageId,
  sessionId,
  agent: "explore",
  providerId: "github-copilot",
  modelId: "gpt-5",
  variant: null,
  tokensInput: 10,
  tokensOutput: 3,
  tokensReasoning: 2,
  tokensCacheRead: 4,
  tokensCacheWrite: 1,
  cost: 0.25,
  createdAt: 0,
  completedAt: null,
  ...jeu,
});

describe("chronologie : jetons d'une ligne `usage`", () => {
  const state = build([busy(R, 10), ...call(R, "msg_1", 10, 20, 0.5), ...call(R, "msg_2", 21, 30, 0.75), idle(R, 30)]);

  it("entrée = input + cache lu + cache écrit ; sortie = output + réflexion ; cache et réflexion à part", () => {
    const view = chronologie(state, [ligneUsage("msg_1", R, { modelId: "gpt-5", variant: "haute" })], 40);
    const [premier, second] = rowOf(view, R).calls;
    assert.deepEqual([premier?.tokensIn, premier?.tokensOut, premier?.tokensCache, premier?.tokensReasoning], [15, 5, 5, 2]);
    assert.deepEqual([premier?.model, premier?.variant], ["gpt-5", "haute"]);
    assert.deepEqual([premier?.start, premier?.end, premier?.cost], [10, 20, 0.5]);
    // Appel sans ligne `usage` : jetons non enregistrés, jamais 0.
    assert.deepEqual([second?.tokensIn, second?.tokensOut, second?.tokensCache, second?.tokensReasoning], [null, null, null, null]);
    assert.deepEqual([second?.model, second?.variant], [null, null]);
  });

  it("une ligne `usage` d'une autre session ne donne jamais ses jetons à l'appel", () => {
    const view = chronologie(state, [ligneUsage("msg_1", D1)], 40);
    assert.deepEqual(jetonsOf(rowOf(view, R))[0], [null, null, null, null]);
  });

  it("deux lignes `usage` du même message : la première l'emporte", () => {
    const view = chronologie(state, [ligneUsage("msg_1", R, { tokensInput: 10 }), ligneUsage("msg_1", R, { tokensInput: 1_000 })], 40);
    assert.equal(rowOf(view, R).calls[0]?.tokensIn, 15);
  });
});

describe("chronologie : repères", () => {
  it("outils par catégorie de `activity-facts.ts`, une seule fois par appel d'outil", () => {
    const state = build([
      busy(R, 10),
      outil(R, "call_a", 11, "read"),
      outil(R, "call_a", 12, "read", "termine"),
      outil(R, "call_b", 13, "grep"),
      outil(R, "call_c", 14, "bash"),
      idle(R, 20),
    ]);
    assert.deepEqual(codes(rowOf(chronologie(state, [], null), R), "outil"), ["lire", "chercher", "commande"]);
  });

  it("nouvelle tentative : un repère par tentative, avec son rang", () => {
    const state = build([busy(R, 10), fact(R, "statut", 11, { etat: "nouvelle-tentative", tentative: 2 }), fact(R, "statut", 12, { etat: "nouvelle-tentative", tentative: 3 }), idle(R, 20)]);
    assert.deepEqual(codes(rowOf(chronologie(state, [], null), R), "tentative"), ["2", "3"]);
  });

  it("décisions par leur verdict ; un verdict inconnu ou un doublon de demande est écarté", () => {
    const state = build([
      busy(R, 10),
      fact(R, "decision", 11, { verdict: "auto", regle: "lecture", par: "regles" }, "per_1"),
      fact(R, "decision", 12, { verdict: "auto", regle: "lecture", par: "regles" }, "per_1"),
      fact(R, "decision", 13, { verdict: "refus-interdit", regle: "shell", par: "regles" }, "per_2"),
      fact(R, "decision", 14, { verdict: "verdict-invente", regle: "shell", par: "regles" }, "per_3"),
      idle(R, 20),
    ]);
    assert.deepEqual(codes(rowOf(chronologie(state, [], null), R), "decision"), ["auto", "refus-interdit"]);
  });

  it("attente de votre accord : un repère par barre `attente-vous`, dans l'ordre du temps", () => {
    const state = build([
      busy(R, 10),
      fact(R, "attente", 12, { permission: "bash", messageId: "msg_1", callId: null, agent: null }, "per_1"),
      fact(R, "reponse", 14, { reponse: "once" }, "per_1"),
      outil(R, "call_a", 11, "read"),
      idle(R, 20),
    ]);
    const row = rowOf(chronologie(state, [], null), R);
    assert.deepEqual(row.ticks.map((tick) => [tick.at, tick.genre, tick.code]), [[11, "outil", "lire"], [12, "attente", ATTENTE_CODE]]);
  });

  it("une délégation sans session ne reprend jamais les repères de la session qui délègue", () => {
    const state = build([
      busy(R, 10),
      outil(R, "call_a", 11, "read"),
      fact(R, "consigne", 12, { etat: "prepare", callId: "call_t", messageId: "msg_1", agent: "explore" }, "call_t"),
      fact(R, "attente", 13, { permission: "task", messageId: "msg_1", callId: "call_t", agent: "explore" }, "per_t"),
    ]);
    const view = chronologie(state, [], 30);
    const sansSession = view.rows.find((row) => row.key.startsWith("appel:"));
    assert.ok(sansSession !== undefined, "la délégation en attente de votre accord a sa ligne");
    assert.deepEqual([sansSession.sessionId, sansSession.ticks, sansSession.calls], [R, [], []]);
    assert.deepEqual(codes(rowOf(view, R), "outil"), ["lire"]);
  });

  it("un fait d'une autre racine est écarté", () => {
    const facts = [busy(R, 10), outil(R, "call_a", 11, "read"), idle(R, 20)];
    const propre = build(facts);
    const pollue: ActivityState = { ...propre, facts: [...propre.facts, fact(R, "statut", 12, { etat: "outil", outil: "autre", nom: "bash", phase: "en-cours", callId: "call_z", messageId: "msg_1", fichier: null, dossier: null }, "call_z", "ses_ailleurs")] };
    assert.deepEqual(chronologie(pollue, [], null), chronologie(propre, [], null));
  });
});

describe("chronologie : groupes de délégations", () => {
  const trois = [
    busy(R, 10),
    created(D1, R, 11, "explore"),
    created(D2, R, 12, "explore"),
    created(D3, R, 13, "explore"),
    fact("ses_d4", "statut", 14, { etat: "creee", role: "delegation", parent: R, agent: "revue", instance: "principale" }),
    idle(R, 20),
  ];

  it("au moins deux délégations du même assistant sous le même parent forment un groupe ×n ; les lignes sont marquées", () => {
    const view = chronologie(build(trois), [], null);
    assert.deepEqual(view.groupes, [{ key: `groupe:${R}:explore`, agent: "explore", count: 3, rowKeys: [D1, D2, D3] }]);
    assert.deepEqual(view.rows.map((row) => row.groupe), [null, `groupe:${R}:explore`, `groupe:${R}:explore`, `groupe:${R}:explore`, null]);
  });

  it("une seule délégation d'un assistant ne forme pas de groupe", () => {
    const view = chronologie(build(trois.filter((f) => f.sessionId !== D2 && f.sessionId !== D3)), [], null);
    assert.deepEqual(view.groupes, []);
    assert.deepEqual(view.rows.map((row) => row.groupe), [null, null, null]);
  });

  it("le même assistant sous un autre parent reste hors du groupe", () => {
    const view = chronologie(build([busy(R, 10), created(D1, R, 11, "explore"), created(D2, R, 12, "explore"), created(D3, D1, 13, "explore"), idle(R, 20)]), [], null);
    assert.deepEqual(view.groupes, [{ key: `groupe:${R}:explore`, agent: "explore", count: 2, rowKeys: [D1, D2] }]);
    assert.equal(rowOf(view, D3).groupe, null);
  });
});

describe("chronologie : curseur, bornes et Déroulé partiel", () => {
  const ouvert = build([busy(R, 10), ...call(R, "msg_1", 10, null)]);
  const clos = build([busy(R, 10), ...call(R, "msg_1", 10, 20, 0.5), idle(R, 25)]);

  it("curseur = now tant qu'une ligne travaille, null à la clôture et hors du direct", () => {
    assert.equal(chronologie(ouvert, [], 99).curseur, 99);
    assert.equal(chronologie(ouvert, [], null).curseur, null);
    assert.equal(chronologie(clos, [], 99).curseur, null);
  });

  it("bornes : début le plus tôt, fin la plus tardive, ou `now` quand une ligne est encore ouverte", () => {
    assert.deepEqual([chronologie(clos, [], 99).start, chronologie(clos, [], 99).end], [10, 25]);
    assert.deepEqual([chronologie(ouvert, [], 99).start, chronologie(ouvert, [], 99).end], [10, 99]);
    assert.deepEqual([chronologie(build([]), [], 99).start, chronologie(build([]), [], 99).end], [null, null]);
  });

  it("`partiel` reprend l'état « Déroulé partiel » de l'itération 1", () => {
    assert.equal(chronologie(clos, [], null).partiel, false);
    const partiel = build([busy(R, 10), fact(R, "affichage", 11, { etat: "deroule-partiel" }), idle(R, 20)]);
    assert.equal(chronologie(partiel, [], null).partiel, true);
  });
});

describe("chronologie : pureté et déterminisme", () => {
  it("ni module node, ni process, ni horloge, ni aléa, ni réseau ; imports permis seulement", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "shared", "chronologie.ts"), "utf8");
    assert.equal(source.includes('"node:'), false);
    assert.equal(/\bprocess\./.test(source), false);
    assert.equal(/\bDate\.now\b|new Date\b|Math\.random|\bfetch\s*\(|\bsetTimeout\b|\bsetInterval\b|\bperformance\.|\bconsole\./.test(source), false);
    const imports = [...source.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1]);
    assert.ok(imports.length > 0);
    for (const spec of imports) assert.ok(/^\.\/[\w.-]+\.ts$/.test(spec ?? ""), String(spec));
  });

  it("deux appels sur le même état rendent des objets égaux et distincts", () => {
    const { state, now } = play(P1);
    const usage = usageOf(state);
    const a = chronologie(state, usage, now);
    const b = chronologie(state, usage, now);
    assert.notEqual(a, b);
    assert.deepEqual(a, b);
    assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
    // L'état n'est jamais modifié : les faits restent ceux du réducteur.
    const avant = state.facts.length;
    chronologie(state, usage, now);
    assert.equal(state.facts.length, avant);
  });
});
