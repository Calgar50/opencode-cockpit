// Faits d'activité (spécification §3.7, §5.7.3, M15, JP-8, §6 l.1066 ; plan d'exécution, fiche L4a) : heure dans l'identifiant
// (M15) et son repli, captures p1, p2, p6 et p7 → faits attendus, garde « aucun texte dans data » (propriété sur toutes les
// chaînes des captures), rôle « controle », fusion du direct et du différé, pureté.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { ActivityFact, FactValue, SessionInstance } from "./shared/activity-types.ts";
import {
  assertFact,
  dedupeFacts,
  EVENT_TIME_MAX_LAG_MS,
  EventMemory,
  eventSessionId,
  CARNET_CHEMIN_MAX,
  carnetChemin,
  eventTime,
  FACT_DATA_MAX_KEYS,
  type FactContext,
  FactDeduper,
  factDataProblem,
  type FactEvent,
  factKey,
  factProblem,
  factsFromEvent,
  type FactSession,
  idTime,
  isDelegatedWork,
  MEMORY_MAX_PARTS,
  MEMORY_MAX_UNANSWERED,
  mergeFacts,
  pathKey,
  sessionRole,
  toolCategory,
} from "./shared/activity-facts.ts";
import { OMO_INITIATOR_MARKER, type OriginPart, originVerdict } from "./shared/message-origin.ts";
import { readCapture } from "./test-support/fake-opencode.ts";

const CAPTURES = ["p1-delegation-parallele.jsonl", "p2-commande-subtask.jsonl", "p6-arret-global.jsonl", "p7-autorisation-orpheline.jsonl"] as const;
const ROOT = "ses_f618ff214ffevi6gfuGx6TvpTP";
/** Messages envoyés par le cockpit dans les captures (demande de p1, commande de p2, demande de p6). */
const SENT_BY_COCKPIT = new Set(["msg_09e702c4e001phPA6LcfC9t4WK", "msg_09e70de68001w3xwbgF26JxZPW", "msg_09e75b36c001x5Cehfmxl57pRZ"]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Monde d'un test : sessions connues du cockpit, mémoire du flux, messages envoyés par le cockpit (le rôle de L4b). */
class World {
  readonly sessions = new Map<string, FactSession>();
  readonly memory = new EventMemory();
  readonly promptKinds: ReadonlyMap<string, string>;
  readonly instance: SessionInstance;
  /** Messages que l'amont sait déposés sans tour (`noReply`, F-h) : le processeur de la salle est seul à le savoir. */
  readonly noReply = new Set<string>();

  constructor(promptKinds: ReadonlyMap<string, string> = new Map(), roots: readonly string[] = [ROOT], instance: SessionInstance = "principale") {
    this.promptKinds = promptKinds;
    this.instance = instance;
    for (const root of roots) this.sessions.set(root, { rootId: root, parentId: null, purpose: "chat", instance });
  }

  /** Session portée par un événement session.created, sans l'enregistrer. */
  resolve(id: string, info?: Readonly<Record<string, unknown>>): FactSession | null {
    const known = this.sessions.get(id);
    if (known) return known;
    if (!info || info.id !== id) return null;
    const cockpit = isRecord(info.metadata) ? info.metadata.cockpit : undefined;
    const parentId = typeof info.parentID === "string" ? info.parentID : null;
    const parent = parentId ? this.sessions.get(parentId) : undefined;
    if (parentId && !parent) return null;
    const sticky = parent && ["classifier", "equipe", "controle"].includes(parent.purpose) ? parent.purpose : null;
    const purpose = sticky ?? (cockpit === "controle" || cockpit === "equipe" || cockpit === "classifier" ? cockpit : "chat");
    return { rootId: parent ? parent.rootId : id, parentId, purpose, instance: parent ? parent.instance : this.instance };
  }

  ctx(receivedAt: number): FactContext {
    return {
      receivedAt,
      session: (id, info) => this.resolve(id, info),
      messageRole: (id) => this.memory.messageRole(id),
      promptKind: (id) => this.promptKinds.get(id) ?? null,
      firstUserMessage: (id) => this.memory.firstUserMessage(id),
      userMessageParts: (id) => this.memory.userMessageParts(id),
      unansweredUserMessages: (id) => this.memory.unansweredUserMessages(id),
      // Branché partout, y compris sur les captures de l'instance principale : elles prouvent qu'aucune de ces règles ne se
      // déclenche sur un flux ordinaire (aucun `messageID` réutilisé, aucune tâche de fond).
      amont: { ...this.memory.amont(), noReply: (id) => this.noReply.has(id) },
    };
  }

  /** À faire avant factsFromEvent : rôles des messages et sessions créées. */
  observe(event: FactEvent): void {
    this.memory.observe(event);
    const info = event.properties?.info;
    if ((event.type === "session.created" || event.type === "session.updated") && isRecord(info) && typeof info.id === "string") {
      const session = this.resolve(info.id, info);
      if (session) this.sessions.set(info.id, session);
    }
  }
}

const payloadOf = (wire: { payload: unknown }) => wire.payload as FactEvent;

function replay(name: string, world = new World(new Map([...SENT_BY_COCKPIT].map((id) => [id, "message"])))): ActivityFact[] {
  const facts: ActivityFact[] = [];
  for (const { recv, wire } of readCapture(name)) {
    const event = payloadOf(wire);
    world.observe(event);
    facts.push(...factsFromEvent(event, world.ctx(recv)));
  }
  return facts;
}

/** Forme lisible d'un fait : alias de session, nature, état ou origine, puis champs non nuls (identifiants et clés omis). */
function compact(facts: readonly ActivityFact[], exclude: (fact: ActivityFact) => boolean = () => false): string[] {
  const aliases = new Map<string, string>([[ROOT, "R"]]);
  const alias = (id: unknown) => {
    const key = String(id);
    if (!aliases.has(key)) aliases.set(key, `E${aliases.size}`);
    return aliases.get(key);
  };
  const out: string[] = [];
  for (const fact of facts) {
    const who = alias(fact.sessionId);
    if (exclude(fact)) continue;
    const words = [who, fact.kind];
    for (const [key, value] of Object.entries(fact.data)) {
      if (value === null || ["messageId", "callId", "fichier", "dossier"].includes(key)) continue;
      if (key === "etat" || key === "origine" || key === "reponse") words.push(String(value));
      else words.push(`${key}=${key === "enfant" || key === "parent" ? alias(value) : String(value)}`);
    }
    out.push(words.join(" "));
  }
  return out;
}

const DETAIL_ETATS = new Set(["outil", "appel", "appel-fini", "redige"]);
const isDetail = (fact: ActivityFact) => fact.kind === "statut" && DETAIL_ETATS.has(String(fact.data.etat));

/** Identifiant croissant opencode construit pour une heure donnée (même codage que l'Identifier d'opencode). */
function makeId(prefix: string, time: number, counter = 1): string {
  const value = (time * 4096 + counter) % 2 ** 48;
  return `${prefix}_${value.toString(16).padStart(12, "0")}AbCdEfGhIjKlMn`;
}

describe("heure d'un événement (M15)", () => {
  it("captures : l'heure lue dans l'identifiant précède la réception de 0 à 223 ms sur plus de 400 événements, et vaut `time` à 1 ms près", () => {
    let events = 0;
    let maxLag = 0;
    let compared = 0;
    for (const name of CAPTURES) {
      for (const { recv, wire } of readCapture(name)) {
        const event = payloadOf(wire);
        const fromId = idTime(event.id, recv);
        assert.notEqual(fromId, null, `${name} : ${event.type}`);
        const lag = recv - (fromId as number);
        assert.ok(lag >= 0 && lag <= EVENT_TIME_MAX_LAG_MS, `${name} : écart ${lag} ms`);
        assert.equal(eventTime(event.id, recv), fromId);
        maxLag = Math.max(maxLag, lag);
        events++;
        const time = event.properties?.time;
        if (typeof time === "number") {
          assert.ok(Math.abs((fromId as number) - time) <= 1, `${name} : ${event.type} ${fromId} ≠ ${time}`);
          compared++;
        }
      }
    }
    assert.equal(events, 477);
    assert.equal(maxLag, EVENT_TIME_MAX_LAG_MS);
    assert.equal(compared, 138);
  });

  it("repli sur l'heure de réception : écart au-delà de la borne, heure postérieure, identifiant illisible ou décroissant", () => {
    const recv = 1_789_364_522_703;
    assert.equal(eventTime(makeId("evt", recv - 223), recv), recv - 223);
    assert.equal(eventTime(makeId("evt", recv - 224), recv), recv);
    assert.equal(eventTime(makeId("evt", recv - 60_000), recv), recv);
    assert.equal(eventTime(makeId("evt", recv + 1), recv), recv);
    assert.equal(eventTime(makeId("evt", recv), recv), recv);
    for (const id of [undefined, null, 42, "", "evt_09e6fcecc001", "EVT_09e6fcecc0013aWEKXk2SHbNdo", "evt_09E6FCECC0013aWEKXk2SHbNdo", "evt-09e6fcecc0013aWEKXk2SHbNdo", "evt_09e6fcecc0013aWE KXk2SHbNdo", ROOT]) {
      assert.equal(eventTime(id, recv), recv, String(id));
    }
    assert.equal(idTime(makeId("evt", recv - 5), Number.NaN), null);
    assert.equal(idTime(makeId("evt", recv - 5), -1), null);
  });

  it("l'heure est reconstruite par-dessus un retour à zéro des 36 bits gardés", () => {
    const wrap = 2 ** 36 * 26;
    assert.equal(eventTime(makeId("evt", wrap - 5), wrap + 100), wrap - 5);
    assert.equal(eventTime(makeId("prt", wrap + 3), wrap + 10), wrap + 3);
  });
});

describe("garde « aucun texte de message dans data »", () => {
  it("permet codes, identifiants, clés, nombres, booléens et null ; refuse texte, secret, type, clé et taille", () => {
    assert.equal(factDataProblem({ etat: "nouvelle-tentative", callId: "call_d16cb6e832bd48ac81b65537", cout: 0.25, reprise: false, enfant: null, nom: "apply_patch", ia: "github-copilot/claude-sonnet-4.5" }), null);
    const token = ["gh", "p_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");
    const refused: unknown[] = [
      { etat: "deux mots" },
      { etat: "ligne\nligne" },
      { etat: "a".repeat(129) },
      { etat: "« cité »" },
      { etat: token },
      { cout: Number.NaN },
      { cout: Number.POSITIVE_INFINITY },
      { data: { etat: "x" } },
      { liste: ["a"] },
      { "clé libre": "x" },
      { Etat: "x" },
      Object.fromEntries(Array.from({ length: FACT_DATA_MAX_KEYS + 1 }, (_, i) => [`k${i}`, i])),
      null,
      "etat",
      [],
    ];
    for (const data of refused) assert.notEqual(factDataProblem(data), null, JSON.stringify(data));
    assert.equal(factDataProblem(Object.fromEntries(Array.from({ length: FACT_DATA_MAX_KEYS }, (_, i) => [`k${i}`, i]))), null);
  });

  it("factProblem et assertFact : identifiants, nature, référence, heure ; le message d'erreur ne recopie pas le texte", () => {
    const ok: ActivityFact = { rootId: ROOT, sessionId: ROOT, kind: "statut", ref: null, data: { etat: "repos" }, at: 1 };
    assert.equal(factProblem(ok), null);
    assert.equal(assertFact(ok), ok);
    const token = ["gh", "p_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");
    for (const bad of [
      { ...ok, rootId: "racine avec espace" },
      { ...ok, sessionId: "" },
      { ...ok, kind: "inconnu" },
      { ...ok, ref: "ref libre" },
      { ...ok, ref: token },
      { ...ok, at: -1 },
      { ...ok, at: 1.5 },
      { ...ok, data: { etat: "Texte planté ici" } },
    ]) {
      assert.notEqual(factProblem(bad), null, JSON.stringify(bad));
    }
    assert.throws(
      () => assertFact({ ...ok, data: { etat: "Texte planté ici" } }),
      (err: unknown) => err instanceof RangeError && !err.message.includes("planté"),
    );
  });

  it("propriété : une chaîne libre ou en forme de secret plantée dans n'importe quel champ des captures n'entre jamais dans un fait", () => {
    const canaries = ["Texte planté : ne jamais stocker", ["gh", "p_", "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8"].join("")];
    let runs = 0;
    let productive = 0;
    for (const name of CAPTURES) {
      const world = new World(new Map([...SENT_BY_COCKPIT].map((id) => [id, "message"])));
      for (const { recv, wire } of readCapture(name)) {
        const event = payloadOf(wire);
        const ctx = world.ctx(recv);
        const paths: Array<Array<string | number>> = [];
        const walk = (value: unknown, at: Array<string | number>) => {
          if (typeof value === "string") paths.push(at);
          else if (Array.isArray(value)) value.forEach((item, i) => walk(item, [...at, i]));
          else if (isRecord(value)) for (const [key, item] of Object.entries(value)) walk(item, [...at, key]);
        };
        walk(event, []);
        for (const leaf of paths) {
          for (const canary of canaries) {
            const clone = structuredClone(event) as unknown as Record<string | number, unknown>;
            let parent: Record<string | number, unknown> = clone;
            for (const key of leaf.slice(0, -1)) parent = parent[key] as Record<string | number, unknown>;
            parent[leaf.at(-1) as string | number] = canary;
            const facts = factsFromEvent(clone as unknown as FactEvent, ctx);
            runs++;
            if (facts.length > 0) productive++;
            assert.equal(JSON.stringify(facts).includes(canary), false, `${name} : ${leaf.join(".")}`);
            for (const fact of facts) assert.equal(factProblem(fact), null, `${name} : ${leaf.join(".")}`);
          }
        }
        world.observe(event);
        for (const fact of factsFromEvent(event, world.ctx(recv))) assert.equal(factProblem(fact), null, `${name} : ${event.type}`);
      }
    }
    // Non vide : 8 538 essais, dont 2 428 où l'événement planté produit encore des faits (sans le texte planté) au 16/09 ; les
    // réponses de l'assistant, qui closent l'origine du message auquel elles répondent, en font désormais partie.
    assert.ok(runs > 8_000, `${runs} essais`);
    assert.ok(productive > 1_000, `${productive} essais productifs`);
  });

  it("seconde barrière : une valeur venue du contexte hors garde devient null, une racine invalide ne produit rien", () => {
    const created = { id: "evt_x", type: "session.created", properties: { sessionID: "ses_child", info: { id: "ses_child", parentID: ROOT, agent: "analyste journaux" } } };
    const ctx = (session: FactSession | null): FactContext => ({
      receivedAt: 10,
      session: () => session,
      messageRole: () => null,
      promptKind: () => null,
      firstUserMessage: () => null,
      userMessageParts: () => [],
      unansweredUserMessages: () => [],
    });
    const [fact] = factsFromEvent(created, ctx({ rootId: ROOT, parentId: "parent libre", purpose: "chat", instance: "salle principale" as SessionInstance }));
    assert.deepEqual(fact?.data, { etat: "creee", role: "delegation", parent: null, agent: null, instance: null });
    assert.deepEqual(factsFromEvent(created, ctx({ rootId: "racine libre", parentId: ROOT, purpose: "chat", instance: "principale" })), []);
    assert.deepEqual(factsFromEvent(created, ctx(null)), []);
  });
});

describe("faits des captures (§5.7.3)", () => {
  it("p1 : deux délégations en même temps, dont une accordée « once »", () => {
    const facts = dedupeFacts(replay("p1-delegation-parallele.jsonl"));
    assert.deepEqual(compact(facts, isDetail), [
      "R statut creee role=conversation instance=principale",
      "R origine demande cas=1",
      "R statut occupee",
      "R consigne prepare",
      "E1 statut creee role=delegation parent=R agent=analyste-journaux instance=principale",
      "R consigne envoyee enfant=E1 agent=analyste-journaux source=ia reprise=false",
      "E1 origine consigne cas=3",
      "E1 statut occupee",
      "R consigne prepare",
      "R attente permission=task agent=analyste-changements",
      "R reponse once",
      "E2 statut creee role=delegation parent=R agent=analyste-changements instance=principale",
      "R consigne envoyee enfant=E2 agent=analyste-changements source=ia reprise=false",
      "E2 origine consigne cas=3",
      "E2 statut occupee",
      "E1 statut repos",
      "R resultat rendu enfant=E1",
      "E2 statut repos",
      "R resultat rendu enfant=E2",
      "R statut repos",
    ]);
    // Même message pour les deux consignes : même anneau, « en même temps » ; l'attente porte l'appel de la seconde.
    const sent = facts.filter((f) => f.kind === "consigne" && f.data.etat === "envoyee");
    assert.equal(sent.length, 2);
    assert.equal(sent[0]?.data.messageId, sent[1]?.data.messageId);
    const waiting = facts.find((f) => f.kind === "attente");
    assert.equal(waiting?.ref, "per_09e7042aa001xfPstev3QOCjVX");
    assert.equal(waiting?.data.callId, sent[1]?.data.callId);
    assert.equal(facts.find((f) => f.kind === "reponse")?.ref, waiting?.ref);
    // Détail : appels d'IA et outils terminés par session (lecture et recherche, sans chemin ni motif). E1 = ses_…51pw, E2 = ses_…ayZ7.
    const who = (f: ActivityFact) => (f.sessionId === ROOT ? "R" : f.sessionId.endsWith("51pw") ? "E1" : "E2");
    const lines = (pred: (f: ActivityFact) => boolean, label: (f: ActivityFact) => string) => facts.filter(pred).map((f) => `${who(f)}:${label(f)}`).sort();
    assert.deepEqual(lines((f) => f.data.etat === "appel", () => "appel"), ["E1:appel", "E1:appel", "E1:appel", "E2:appel", "E2:appel", "E2:appel", "E2:appel", "R:appel", "R:appel"]);
    assert.deepEqual(lines((f) => f.data.etat === "appel-fini", (f) => String(f.data.raison)), ["E1:stop", "E1:tool-calls", "E1:tool-calls", "E2:stop", "E2:tool-calls", "E2:tool-calls", "E2:tool-calls", "R:stop", "R:tool-calls"]);
    assert.deepEqual(
      lines((f) => f.data.etat === "outil" && f.data.phase === "termine", (f) => `${f.data.outil}:${f.data.nom}`),
      ["E1:chercher:glob", "E1:chercher:grep", "E1:lire:read", "E1:lire:read", "E2:chercher:glob", "E2:lire:read", "E2:lire:read", "E2:lire:read", "E2:lire:read"],
    );
    // Les deux enfants lisent deux mêmes fichiers : mêmes clés, sans le chemin.
    const readKeys = (alias: string) => new Set(facts.filter((f) => who(f) === alias && f.data.nom === "read").map((f) => f.data.fichier));
    assert.equal([...readKeys("E1")].filter((key) => readKeys("E2").has(key)).length, 2);
  });

  it("p2 : raccourci subtask, enfant sans demande, reprise par un message synthétique", () => {
    assert.deepEqual(compact(dedupeFacts(replay("p2-commande-subtask.jsonl")), isDetail), [
      "R origine demande cas=1",
      "R statut occupee",
      "E1 statut creee role=delegation parent=R agent=analyste-changements instance=principale",
      "R consigne envoyee enfant=E1 agent=analyste-changements source=raccourci commande=revue-croisee reprise=false",
      "E1 origine consigne cas=3",
      "E1 statut occupee",
      "E1 statut repos",
      "R resultat rendu enfant=E1",
      "R origine interne-opencode cas=6",
      "R statut repos",
    ]);
  });

  it("p6 : arrêt pendant qu'un enfant travaille et qu'une seconde délégation attend (jamais démarrée)", () => {
    const facts = dedupeFacts(replay("p6-arret-global.jsonl"));
    assert.deepEqual(compact(facts, isDetail), [
      "R origine demande cas=1",
      "R statut occupee",
      "R consigne prepare",
      "E1 statut creee role=delegation parent=R agent=analyste-journaux instance=principale",
      "R consigne envoyee enfant=E1 agent=analyste-journaux source=ia reprise=false",
      "E1 origine consigne cas=3",
      "E1 statut occupee",
      "R consigne prepare",
      "R attente permission=task agent=analyste-changements",
      "E1 statut erreur erreur=MessageAbortedError",
      "E1 statut repos",
      "R statut erreur erreur=MessageAbortedError",
      "R statut repos",
      "R resultat interrompu enfant=E1",
      "R resultat interrompu",
    ]);
    const second = facts.filter((f) => f.kind === "attente")[0]?.data.callId;
    assert.equal(facts.some((f) => f.kind === "consigne" && f.data.etat === "envoyee" && f.data.callId === second), false);
    assert.equal(facts.some((f) => f.kind === "reponse"), false);
  });

  it("p7 : « once » tardif, sous-agent détaché dont le parent n'est jamais repris", () => {
    const facts = dedupeFacts(replay("p7-autorisation-orpheline.jsonl"));
    assert.deepEqual(compact(facts, isDetail), [
      "R reponse once",
      "E1 statut creee role=delegation parent=R agent=analyste-changements instance=principale",
      "E1 origine consigne cas=3",
      "E1 statut occupee",
    ]);
    assert.equal(facts.some((f) => f.kind === "consigne" || f.kind === "resultat"), false);
    assert.equal(facts.filter((f) => f.sessionId === ROOT).length, 1);
  });

  it("§6 l.1066 : un message que le cockpit n'a pas envoyé, sans marque d'opencode, reste « origine non identifiée »", () => {
    const facts = replay("p1-delegation-parallele.jsonl", new World());
    const origins = compact(dedupeFacts(facts).filter((f) => f.kind === "origine"));
    assert.deepEqual(origins, ["R origine origine-inconnue cas=7", "E1 origine consigne cas=3", "E2 origine consigne cas=3"]);
  });

  it("tout fait des captures est permis par la garde, et l'heure d'un fait est celle de son événement", () => {
    for (const name of CAPTURES) {
      for (const fact of replay(name)) assert.equal(factProblem(fact), null, `${name} : ${JSON.stringify(fact)}`);
    }
  });
});

describe("origine classée sur le message entier (§5.7.2)", () => {
  const USER = "msg_origine_mixte";
  type Part = { id: string; type: string; text?: string; synthetic?: boolean };
  const opened: FactEvent = { type: "message.updated", properties: { info: { id: USER, sessionID: ROOT, role: "user", time: { created: 1 } } } };
  const partEvent = (part: Part): FactEvent => ({ type: "message.part.updated", properties: { part: { sessionID: ROOT, messageID: USER, ...part } } });
  const busy: FactEvent = { type: "session.status", properties: { sessionID: ROOT, status: { type: "busy" } } };
  const answered: FactEvent = { type: "message.updated", properties: { info: { id: "msg_reponse_mixte", sessionID: ROOT, role: "assistant", parentID: USER, time: { created: 2 } } } };
  const answeredDone: FactEvent = { type: "message.updated", properties: { info: { id: "msg_reponse_mixte", sessionID: ROOT, role: "assistant", parentID: USER, time: { created: 2, completed: 3 } } } };
  const idle: FactEvent = { type: "session.status", properties: { sessionID: ROOT, status: { type: "idle" } } };

  function permutations<T>(items: readonly T[]): T[][] {
    if (items.length <= 1) return [[...items]];
    return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
  }

  /** Rejoue un message et sa clôture ; rend les faits bruts (sans dédoublonnage) et le monde. */
  function play(parts: readonly Part[], instance: SessionInstance, closing: readonly FactEvent[], promptKinds: ReadonlyMap<string, string> = new Map()) {
    const world = new World(promptKinds, [ROOT], instance);
    const facts: ActivityFact[] = [];
    for (const event of [opened, ...parts.map(partEvent), ...closing]) {
      world.observe(event);
      facts.push(...factsFromEvent(event, world.ctx(1_789_364_600_000)));
    }
    return { facts, world };
  }

  const MIXED: readonly Part[] = [
    { id: "prt_rappel", type: "text", text: "Rappel interne", synthetic: true },
    { id: "prt_reel", type: "text", text: "Texte réel de la demande", synthetic: false },
  ];
  // Forme produite par « opencode run -f » : deux textes synthétiques (appel de lecture, contenu), le fichier, puis le texte réel.
  const RUN_WITH_FILE: readonly Part[] = [
    { id: "prt_appel", type: "text", text: "Called the Read tool with the following input", synthetic: true },
    { id: "prt_contenu", type: "text", text: "contenu du fichier lu", synthetic: true },
    { id: "prt_fichier", type: "file" },
    { id: "prt_demande", type: "text", text: "Texte réel tapé après le fichier" },
  ];
  const ALL_SYNTHETIC: readonly Part[] = [
    { id: "prt_s1", type: "text", text: "Summarize the task tool output above and continue", synthetic: true },
    { id: "prt_s2", type: "text", text: "Second rappel interne", synthetic: true },
    { id: "prt_s3", type: "file" },
  ];
  const MARKED: readonly Part[] = [
    { id: "prt_marque", type: "text", text: `Réveil ${OMO_INITIATOR_MARKER}` },
    { id: "prt_libre", type: "text", text: "Texte libre sans marqueur" },
  ];

  const cases: ReadonlyArray<{ name: string; parts: readonly Part[]; instance: SessionInstance; expected: { origine: string; cas: number } }> = [
    { name: "une partie synthétique et une réelle, principale", parts: MIXED, instance: "principale", expected: { origine: "origine-inconnue", cas: 7 } },
    { name: "une partie synthétique et une réelle, salle", parts: MIXED, instance: "omo", expected: { origine: "origine-inconnue", cas: 7 } },
    { name: "forme de opencode run -f, principale", parts: RUN_WITH_FILE, instance: "principale", expected: { origine: "origine-inconnue", cas: 7 } },
    { name: "forme de opencode run -f, salle", parts: RUN_WITH_FILE, instance: "omo", expected: { origine: "origine-inconnue", cas: 7 } },
    { name: "entièrement synthétique, principale", parts: ALL_SYNTHETIC, instance: "principale", expected: { origine: "interne-opencode", cas: 6 } },
    { name: "entièrement synthétique, salle", parts: ALL_SYNTHETIC, instance: "omo", expected: { origine: "interne-extension", cas: 6 } },
    { name: "marqueur d'initiateur dans une des parties, salle", parts: MARKED, instance: "omo", expected: { origine: "interne-extension", cas: 6 } },
    { name: "marqueur d'initiateur dans une des parties, principale", parts: MARKED, instance: "principale", expected: { origine: "origine-inconnue", cas: 7 } },
  ];

  it("toutes les parties, dans tous les ordres d'arrivée : un seul verdict, celui du message entier, clos par la réponse de l'assistant", () => {
    let orders = 0;
    for (const { name, parts, instance, expected } of cases) {
      // Oracle indépendant : le classement du message entier, toutes parties connues.
      const whole = originVerdict(parts satisfies readonly OriginPart[], { promptKind: null, firstUserOfChild: false, instance, racine: true });
      assert.deepEqual({ origine: whole.origine, cas: whole.cas }, expected, name);
      for (const order of permutations(parts)) {
        const { facts } = play(order, instance, [busy, answered, answeredDone, idle]);
        const label = `${name} : ${order.map((part) => part.id).join(", ")}`;
        const origins = facts.filter((fact) => fact.kind === "origine");
        assert.ok(origins.length > 0, `${label} : aucun fait origine`);
        // Aucun fait brut ne dit autre chose que le message entier : le premier fait gardé ne dépend pas de l'ordre.
        for (const fact of origins) assert.deepEqual(fact.data, { ...expected, messageId: USER }, label);
        assert.deepEqual(dedupeFacts(facts).filter((fact) => fact.kind === "origine").map((fact) => fact.data), [{ ...expected, messageId: USER }], label);
        orders++;
      }
    }
    assert.equal(orders, 2 + 2 + 24 + 24 + 6 + 6 + 2 + 2);
  });

  it("sans réponse de l'assistant (message sans réponse, erreur avant l'appel) : le verdict part quand la session revient au repos", () => {
    for (const order of permutations(MIXED)) {
      const { facts } = play(order, "principale", []);
      assert.deepEqual(facts.filter((fact) => fact.kind === "origine"), [], "aucun verdict tant que des parties peuvent encore arriver");
      const closed = play(order, "principale", [idle]).facts.filter((fact) => fact.kind === "origine");
      assert.deepEqual(closed.map((fact) => fact.data), [{ origine: "origine-inconnue", cas: 7, messageId: USER }]);
    }
  });

  it("cas 1 à 3 : le contexte suffit, le verdict part dès la première partie", () => {
    const { facts } = play([MIXED[0] as Part], "principale", [], new Map([[USER, "message"]]));
    assert.deepEqual(facts.filter((fact) => fact.kind === "origine").map((fact) => fact.data), [{ origine: "demande", cas: 1, messageId: USER }]);
  });

  it("la mémoire du flux ne garde des parties que le type, le drapeau synthetic et les marqueurs, jamais le texte", () => {
    const { world } = play([...MARKED, ...MIXED, ...RUN_WITH_FILE], "omo", []);
    const kept = JSON.stringify(world.memory.userMessageParts(USER));
    for (const part of [...MARKED, ...MIXED, ...RUN_WITH_FILE]) {
      const free = part.text?.replace(OMO_INITIATOR_MARKER, "").trim();
      if (free) assert.equal(kept.includes(free), false, part.id);
    }
    assert.equal(kept.includes(OMO_INITIATOR_MARKER), true);
  });
});

describe("rôles : contrôle de sécurité, délégation, étape, sessions cachées", () => {
  const created = (id: string, info: Record<string, unknown>): FactEvent => ({ id: makeId("evt", 5000), type: "session.created", properties: { sessionID: id, info: { id, ...info } } });

  it("sessionRole et isDelegatedWork", () => {
    assert.equal(sessionRole("chat", null), "conversation");
    assert.equal(sessionRole("chat", ROOT), "delegation");
    assert.equal(sessionRole("controle", ROOT), "controle");
    assert.equal(sessionRole("controle", null), "controle");
    assert.equal(sessionRole("equipe", null), "conversation");
    assert.equal(sessionRole("equipe", ROOT), "etape");
    assert.equal(sessionRole("classifier", null), null);
    assert.equal(sessionRole("autre", ROOT), null);
    assert.equal(isDelegatedWork("delegation"), true);
    for (const role of ["controle", "etape", "conversation", null] as const) assert.equal(isDelegatedWork(role), false);
  });

  it("une session purpose = controle sous une conversation a le rôle controle et n'est jamais une délégation", () => {
    const world = new World();
    const event = created("ses_controle1", { parentID: ROOT, agent: "cockpit-controle", metadata: { cockpit: "controle" } });
    world.observe(event);
    const facts = factsFromEvent(event, world.ctx(5000));
    assert.deepEqual(compact(facts), ["E1 statut creee role=controle parent=R agent=cockpit-controle instance=principale"]);
    assert.equal(isDelegatedWork(facts[0]?.data.role as "controle"), false);
    const child = created("ses_sous_controle", { parentID: "ses_controle1" });
    assert.equal(factsFromEvent(child, world.ctx(5000))[0]?.data.role, "controle");
    const delegated = created("ses_enfant1", { parentID: ROOT, agent: "explore" });
    assert.equal(factsFromEvent(delegated, world.ctx(5000))[0]?.data.role, "delegation");
  });

  it("une conversation cachée (classifier) ne produit aucun fait", () => {
    const world = new World(new Map(), []);
    world.sessions.set("ses_classifier", { rootId: "ses_classifier", parentId: null, purpose: "classifier", instance: "principale" });
    const events: FactEvent[] = [
      { type: "session.status", properties: { sessionID: "ses_classifier", status: { type: "busy" } } },
      { type: "session.error", properties: { sessionID: "ses_classifier", error: { name: "UnknownError" } } },
      { type: "message.part.updated", properties: { part: { id: "prt_1", sessionID: "ses_classifier", messageID: "msg_1", type: "step-start" } } },
      created("ses_classifier_enfant", { parentID: "ses_classifier" }),
    ];
    for (const event of events) assert.deepEqual(factsFromEvent(event, world.ctx(1)), [], event.type);
  });
});

describe("événements isolés", () => {
  const world = () => {
    const w = new World();
    w.memory.observe({ type: "message.updated", properties: { info: { id: "msg_a", sessionID: ROOT, role: "assistant" } } });
    return w;
  };
  const toolEvent = (tool: string, state: Record<string, unknown>, callID: unknown = "call_1"): FactEvent => ({
    type: "message.part.updated",
    properties: { part: { id: "prt_t", sessionID: ROOT, messageID: "msg_a", type: "tool", tool, callID, state } },
  });

  it("outils : catégorie, phase, clés de fichier et de dossier ; ni chemin ni motif ni sortie", () => {
    const facts = factsFromEvent(toolEvent("edit", { status: "completed", input: { filePath: "/workspace/src/app.ts", oldString: "a", newString: "b" }, output: "ok" }), world().ctx(1));
    assert.deepEqual(facts[0]?.data, {
      etat: "outil",
      outil: "modifier",
      nom: "edit",
      phase: "termine",
      callId: "call_1",
      messageId: "msg_a",
      fichier: pathKey("/workspace/src/app.ts"),
      dossier: pathKey("/workspace/src"),
    });
    assert.equal(facts[0]?.ref, "call_1");
    assert.equal(factsFromEvent(toolEvent("bash", { status: "error", input: { command: "rm -rf x" }, error: "aborted", metadata: { interrupted: true } }), world().ctx(1))[0]?.data.phase, "interrompu");
    assert.equal(factsFromEvent(toolEvent("bash", { status: "error", input: { command: "ls" }, error: "Échec" }), world().ctx(1))[0]?.data.phase, "erreur");
    assert.deepEqual(factsFromEvent(toolEvent("read", { status: "pending", input: {} }), world().ctx(1)), []);
    assert.deepEqual(factsFromEvent(toolEvent("read", { status: "running", input: {} }, "appel libre"), world().ctx(1)), []);
    assert.deepEqual(factsFromEvent(toolEvent("outil libre", { status: "running", input: {} }), world().ctx(1)), []);
    assert.deepEqual(factsFromEvent(toolEvent("read", { status: "inconnu", input: {} }), world().ctx(1)), []);
    assert.deepEqual(
      ["read", "webfetch", "glob", "grep", "list", "edit", "write", "apply_patch", "bash", "question", "task", "todowrite", "mcp_tool"].map(toolCategory),
      ["lire", "lire", "chercher", "chercher", "chercher", "modifier", "modifier", "modifier", "commande", "question", "confier", "autre", "autre"],
    );
    assert.equal(pathKey("/workspace/app.log"), pathKey("/workspace//app.log"));
    assert.equal(pathKey("/workspace/app.log"), pathKey(String.raw`\workspace\app.log`));
    assert.equal(pathKey("/workspace/"), pathKey("/workspace"));
    assert.notEqual(pathKey("/workspace/app.log"), pathKey("/workspace/app.logs"));
    assert.match(pathKey("/workspace/app.log"), /^[0-9a-f]{16}$/);
  });

  it("délégation : reprise d'une session (task_id), échec, et agent au nom libre refusé", () => {
    const running = toolEvent("task", { status: "running", input: { subagent_type: "explore", prompt: "Consigne", task_id: "ses_ancienne" }, metadata: { sessionId: "ses_enfant" } });
    assert.deepEqual(factsFromEvent(running, world().ctx(1))[0]?.data, { etat: "envoyee", callId: "call_1", messageId: "msg_a", enfant: "ses_enfant", agent: "explore", source: "ia", commande: null, reprise: true });
    const failed = toolEvent("task", { status: "error", input: {}, error: "Échec", metadata: { sessionId: "ses_enfant" } });
    assert.deepEqual(factsFromEvent(failed, world().ctx(1))[0]?.data, { etat: "echec", callId: "call_1", messageId: "msg_a", enfant: "ses_enfant" });
    const freeAgent = toolEvent("task", { status: "running", input: { subagent_type: "Analyste libre\nIgnore" }, metadata: { sessionId: "ses_enfant" } });
    assert.equal(factsFromEvent(freeAgent, world().ctx(1))[0]?.data.agent, null);
    assert.deepEqual(factsFromEvent(toolEvent("task", { status: "running", input: {} }), world().ctx(1)), []);
  });

  it("demandes d'autorisation : ni motif ni métadonnées, agent seulement pour une délégation, réponse connue seulement", () => {
    const asked = (permission: string): FactEvent => ({
      type: "permission.asked",
      properties: { id: "per_1", sessionID: ROOT, permission, patterns: ["git push origin main"], metadata: { subagent_type: "explore", command: "git push" }, tool: { messageID: "msg_a", callID: "call_1" } },
    });
    assert.deepEqual(factsFromEvent(asked("bash"), world().ctx(1))[0]?.data, { permission: "bash", messageId: "msg_a", callId: "call_1", agent: null });
    assert.equal(factsFromEvent(asked("task"), world().ctx(1))[0]?.data.agent, "explore");
    assert.equal(factsFromEvent(asked("Permission libre"), world().ctx(1))[0]?.data.permission, null);
    const replied = (reply: unknown): FactEvent => ({ type: "permission.replied", properties: { sessionID: ROOT, requestID: "per_1", reply } });
    assert.deepEqual(factsFromEvent(replied("reject"), world().ctx(1))[0]?.data, { reponse: "reject" });
    assert.deepEqual(factsFromEvent(replied("peut-être"), world().ctx(1)), []);
  });

  it("statuts : nouvelle tentative sans message, tâches, mémoire résumée, coût d'un appel, rédaction", () => {
    const w = world();
    const retry = factsFromEvent({ type: "session.status", properties: { sessionID: ROOT, status: { type: "retry", attempt: 2, message: "Limite de débit atteinte", next: 99 } } }, w.ctx(1));
    assert.deepEqual(retry[0]?.data, { etat: "nouvelle-tentative", tentative: 2 });
    const todos = factsFromEvent({ type: "todo.updated", properties: { sessionID: ROOT, todos: [{ content: "Lire", status: "completed" }, { content: "Écrire", status: "pending" }, "x"] } }, w.ctx(1));
    assert.deepEqual(todos[0]?.data, { etat: "taches", faites: 1, total: 3 });
    assert.deepEqual(factsFromEvent({ type: "session.compacted", properties: { sessionID: ROOT } }, w.ctx(1))[0]?.data, { etat: "memoire-resumee" });
    const finish = (cost: unknown) => factsFromEvent({ type: "message.part.updated", properties: { part: { id: "prt_f", sessionID: ROOT, messageID: "msg_a", type: "step-finish", cost, reason: "stop" } } }, w.ctx(1))[0]?.data.cout;
    assert.equal(finish(0.0123), 0.0123);
    assert.equal(finish(-1), null);
    assert.equal(finish(Number.NaN), null);
    const textPart = { type: "message.part.updated", properties: { part: { id: "prt_x", sessionID: ROOT, messageID: "msg_a", type: "text", text: "Voici la réponse" } } };
    assert.deepEqual(factsFromEvent(textPart, w.ctx(1))[0]?.data, { etat: "redige", messageId: "msg_a" });
    assert.deepEqual(factsFromEvent({ ...textPart, properties: { part: { ...textPart.properties.part, messageID: "msg_inconnu" } } }, w.ctx(1)), []);
    assert.deepEqual(factsFromEvent({ type: "sync", properties: undefined }, w.ctx(1)), []);
    assert.deepEqual(factsFromEvent({ type: "session.error", properties: { sessionID: ROOT, error: { name: "Erreur libre", data: { message: "Texte" } } } }, w.ctx(1))[0]?.data, { etat: "erreur", erreur: null });
  });

  it("eventSessionId et EventMemory bornée", () => {
    assert.equal(eventSessionId({ type: "session.created", properties: { info: { id: "ses_a" } } }), "ses_a");
    assert.equal(eventSessionId({ type: "message.updated", properties: { info: { id: "msg_a", sessionID: "ses_b" } } }), "ses_b");
    assert.equal(eventSessionId({ type: "message.part.updated", properties: { part: { sessionID: "ses_c" } } }), "ses_c");
    assert.equal(eventSessionId({ type: "session.status", properties: { sessionID: "ses_d" } }), "ses_d");
    assert.equal(eventSessionId({ type: "session.status", properties: { sessionID: "session libre" } }), null);
    const memory = new EventMemory(2);
    const user = (id: string, sessionID: string, role = "user"): FactEvent => ({ type: "message.updated", properties: { info: { id, sessionID, role } } });
    memory.observe(user("msg_1", "ses_a"));
    memory.observe(user("msg_2", "ses_a"));
    memory.observe(user("msg_3", "ses_b", "assistant"));
    memory.observe(user("msg libre", "ses_c"));
    memory.observe(user("msg_4", "ses_d", "system"));
    assert.equal(memory.firstUserMessage("ses_a"), "msg_1");
    assert.equal(memory.messageRole("msg_1"), null, "le plus ancien est oublié au-delà de la borne");
    assert.equal(memory.messageRole("msg_3"), "assistant");
    assert.equal(memory.messageRole("msg_4"), null);
    assert.equal(memory.firstUserMessage("ses_c"), null);
  });

  it("EventMemory : parties des messages utilisateur et messages sans réponse, bornés", () => {
    const memory = new EventMemory();
    const message = (id: string, role: string, extra: Record<string, unknown> = {}): FactEvent => ({ type: "message.updated", properties: { info: { id, sessionID: "ses_a", role, ...extra } } });
    const part = (messageID: string, id: unknown, synthetic = true, type = "text"): FactEvent => ({ type: "message.part.updated", properties: { part: { id, sessionID: "ses_a", messageID, type, text: "Texte", synthetic } } });
    memory.observe(part("msg_1", "prt_avant"));
    assert.deepEqual(memory.userMessageParts("msg_1"), [], "partie d'un message au rôle encore inconnu : non gardée");
    memory.observe(message("msg_1", "user"));
    memory.observe(message("msg_2", "user"));
    assert.deepEqual(memory.unansweredUserMessages("ses_a"), ["msg_1", "msg_2"]);
    memory.observe(message("msg_r", "assistant", { parentID: "msg_1" }));
    assert.deepEqual(memory.unansweredUserMessages("ses_a"), ["msg_2"]);
    memory.observe(message("msg_1", "user", { summary: { diffs: [] } }));
    assert.deepEqual(memory.unansweredUserMessages("ses_a"), ["msg_2"], "une republication (résumé) n'inscrit pas de nouveau le message");
    memory.observe(part("msg_r", "prt_r"));
    assert.deepEqual(memory.userMessageParts("msg_r"), [], "parties de l'assistant : non gardées");
    memory.observe(part("msg_1", "prt_1", true, "file"));
    memory.observe(part("msg_1", "prt_1"));
    memory.observe(part("msg_1", "prt_1"));
    assert.deepEqual(memory.userMessageParts("msg_1"), [{ type: "text", synthetic: true, text: "" }], "une partie republiée remplace la précédente");
    // Au-delà de la borne, une partie inconnue non synthétique est comptée : le message ne peut plus passer pour synthétique.
    for (let i = 0; i < MEMORY_MAX_PARTS + 3; i++) memory.observe(part("msg_2", `prt_${i}`));
    const kept = memory.userMessageParts("msg_2");
    assert.equal(kept.length, MEMORY_MAX_PARTS + 1);
    assert.deepEqual(kept.at(-1), { type: "text", synthetic: false });
    assert.equal(kept.filter((p) => p.synthetic === false).length, 1);
    for (let i = 0; i < MEMORY_MAX_UNANSWERED + 2; i++) memory.observe(message(`msg_s${i}`, "user"));
    const waiting = memory.unansweredUserMessages("ses_a");
    assert.equal(waiting.length, MEMORY_MAX_UNANSWERED);
    assert.equal(waiting.at(-1), `msg_s${MEMORY_MAX_UNANSWERED + 1}`);
    const small = new EventMemory(1);
    small.observe(message("msg_x", "user"));
    small.observe(part("msg_x", "prt_x"));
    small.observe({ type: "message.updated", properties: { info: { id: "msg_y", sessionID: "ses_b", role: "user" } } });
    small.observe(part("msg_y", "prt_y"));
    assert.deepEqual(small.userMessageParts("msg_x"), [], "le plus ancien message est oublié au-delà de la borne");
    assert.deepEqual(small.unansweredUserMessages("ses_a"), []);
  });
});

describe("fusion du direct et du différé", () => {
  const fact = (over: Partial<ActivityFact>): ActivityFact => ({ rootId: ROOT, sessionId: ROOT, kind: "statut", ref: null, data: { etat: "occupee" }, at: 1, ...over });

  it("factKey : la première origine d'un message l'emporte ; états d'activité sans clé", () => {
    assert.equal(factKey(fact({ kind: "origine", ref: "msg_1", data: { origine: "demande" } })), factKey(fact({ kind: "origine", ref: "msg_1", data: { origine: "origine-inconnue" } })));
    assert.notEqual(factKey(fact({ kind: "consigne", ref: "call_1", data: { etat: "prepare" } })), factKey(fact({ kind: "consigne", ref: "call_1", data: { etat: "envoyee" } })));
    assert.equal(factKey(fact({})), null);
    assert.equal(factKey(fact({ kind: "decision", ref: "per_1", data: { verdict: "auto" } })), null);
  });

  it("FactDeduper : doublons écartés, changements d'état gardés, bornée", () => {
    const d = new FactDeduper();
    assert.equal(d.accept(fact({ kind: "origine", ref: "msg_1", data: { origine: "demande" } })), true);
    assert.equal(d.accept(fact({ kind: "origine", ref: "msg_1", data: { origine: "interne-opencode" } })), false);
    assert.equal(d.accept(fact({})), true);
    assert.equal(d.accept(fact({ at: 2 })), false);
    assert.equal(d.accept(fact({ kind: "statut", ref: "call_1", data: { etat: "outil", phase: "en-cours" } })), true);
    assert.equal(d.accept(fact({ at: 3 })), false, "un outil entre deux « occupée » ne change pas l'état d'activité");
    assert.equal(d.accept(fact({ data: { etat: "repos" } })), true);
    assert.equal(d.accept(fact({})), true);
    assert.equal(d.accept(fact({ sessionId: "ses_autre" })), true);
    assert.equal(d.accept(fact({ data: { etat: "taches", faites: 1, total: 3 } })), true);
    assert.equal(d.accept(fact({ data: { etat: "taches", faites: 1, total: 3 } })), false);
    assert.equal(d.accept(fact({ data: { etat: "taches", faites: 2, total: 3 } })), true);
    assert.equal(d.accept(fact({ kind: "decision", ref: "per_1", data: { verdict: "auto" } })), true);
    assert.equal(d.accept(fact({ kind: "decision", ref: "per_2", data: { verdict: "auto" } })), true);
    const small = new FactDeduper(1);
    assert.equal(small.accept(fact({ kind: "reponse", ref: "per_1", data: { reponse: "once" } })), true);
    assert.equal(small.accept(fact({ kind: "reponse", ref: "per_2", data: { reponse: "once" } })), true);
    assert.equal(small.accept(fact({ kind: "reponse", ref: "per_1", data: { reponse: "once" } })), true, "clé oubliée au-delà de la borne");
  });

  it("différé = direct : faits sérialisés comme en base puis relus, fusionnés avec un direct qui les recouvre", () => {
    const live = replay("p1-delegation-parallele.jsonl");
    const direct = dedupeFacts(live);
    const stored = direct.map((f, i) => ({ id: i + 1, rootId: f.rootId, sessionId: f.sessionId, kind: f.kind, ref: f.ref, data: JSON.stringify(f.data), at: f.at }));
    const reread: ActivityFact[] = stored.map((row) => ({ rootId: row.rootId, sessionId: row.sessionId, kind: row.kind, ref: row.ref, data: JSON.parse(row.data), at: row.at }));
    assert.deepEqual(reread, direct);
    // Le magasin a gardé les faits jusqu'à `m` ; le navigateur a reçu en direct les faits acceptés depuis `k` < `m` (recouvrement).
    for (const [k, m] of [[20, 35], [0, direct.length], [30, 30], [direct.length - 1, direct.length]] as const) {
      const merged = mergeFacts(JSON.parse(JSON.stringify(reread.slice(0, m))), direct.slice(k));
      assert.deepEqual(merged, direct, `k=${k} m=${m}`);
    }
    // Un état revenu après le recouvrement (occupée → au repos → occupée) n'est jamais pris pour un doublon.
    const states = ["occupee", "repos", "occupee", "repos"].map((etat, i) => ({ rootId: ROOT, sessionId: ROOT, kind: "statut" as const, ref: null, data: { etat }, at: 100 + i }));
    assert.deepEqual(mergeFacts(states.slice(0, 3), states.slice(1)), states);
    assert.deepEqual(mergeFacts(states.slice(0, 2), states.slice(2)), states);
  });

  it("mergeFacts dédoublonne par identité seulement, comme le direct : un même état ou un même arrêt à une autre heure est gardé", () => {
    const at = (data: Record<string, FactValue>, t: number): ActivityFact => ({ rootId: ROOT, sessionId: ROOT, kind: "statut", ref: null, data, at: t });
    // Cockpit redémarré : sa mémoire du flux est neuve, le même état « occupée » est écrit deux fois, à deux heures.
    const busyTwice = [at({ etat: "occupee" }, 100), at({ etat: "occupee" }, 200)];
    assert.deepEqual(mergeFacts(busyTwice, []), busyTwice);
    assert.deepEqual(mergeFacts(busyTwice.slice(0, 1), busyTwice.slice(1)), busyTwice);
    const stops = [at({ cause: "arret", motif: "vous", nonConfirmees: 0 }, 300), at({ cause: "arret", motif: "vous", nonConfirmees: 0 }, 900)];
    assert.deepEqual(mergeFacts(stops, []), stops);
    // Fait identique (même heure, mêmes données) : un seul, dans le différé, dans le direct ou entre les deux.
    const copy = (f: ActivityFact): ActivityFact => JSON.parse(JSON.stringify(f));
    assert.deepEqual(mergeFacts([...stops, copy(stops[0] as ActivityFact)], [copy(stops[1] as ActivityFact), copy(stops[1] as ActivityFact)]), stops);
  });
});

// --- Salle OMO (fiche L25a) -------------------------------------------------------------------------------------------------------

const OMO_RACINE = "ses_jp_racine";
const OMO_FOND = "ses_jp_fond";
const OMO_JUNIOR = "ses_jp_junior";
const OMO_FIXTURE = "omo-jp1-jp7.jsonl";

/** Monde de la fixture : une racine de la Salle OMO, dont seule la demande de l'utilisateur figure dans `prompts`. */
const omoWorld = () => new World(new Map([["msg_jp_demande", "message"]]), [OMO_RACINE], "omo");

/** Rejoue la fixture synthétique de la salle et rend les faits dédoublonnés, comme le fait le magasin. */
function rejoueOmo(world = omoWorld()): ActivityFact[] {
  return dedupeFacts(replay(OMO_FIXTURE, world));
}

const faitsDe = (facts: readonly ActivityFact[], kind: string) => facts.filter((fact) => fact.kind === kind);
const faitDe = (facts: readonly ActivityFact[], kind: string, ref: string) => facts.find((fact) => fact.kind === kind && fact.ref === ref);
/** Consigne ENVOYÉE d'un appel (la consigne « prepare » porte la même référence). */
const consigneEnvoyee = (facts: readonly ActivityFact[], ref: string) => facts.find((fact) => fact.kind === "consigne" && fact.ref === ref && fact.data.etat === "envoyee");

describe("Salle OMO : faits de la fixture omo-jp1-jp7 (§5.7.2, §5.7.3, JP-1 à JP-7, JS-13)", () => {
  it("T-L25-a : les sept cas d'origine, dont le réveil (cas 4) et la relance de l'extension (cas 5)", () => {
    const origines = faitsDe(rejoueOmo(), "origine").map((fact) => [fact.sessionId, fact.ref, fact.data.origine, fact.data.cas, fact.data.relance ?? null]);
    assert.deepEqual(origines, [
      [OMO_RACINE, "msg_jp_demande", "demande", 1, null],
      [OMO_FOND, "msg_jp_consigne_fond", "consigne", 3, null],
      [OMO_JUNIOR, "msg_jp_consigne_junior", "consigne", 3, null],
      [OMO_RACINE, "msg_jp_reveil", "reveil-sans-reponse", 4, null],
      [OMO_RACINE, "msg_jp_relance", "relance-extension", 5, "todo-continuation"],
      [OMO_RACINE, "msg_jp_inconnu", "origine-inconnue", 7, null],
    ]);
  });

  it("T-L25-b (JP-2) : un réveil donne un fait « reveil » et AUCUN signe d'appel d'IA ni de coût", () => {
    const facts = rejoueOmo();
    const reveils = faitsDe(facts, "reveil");
    assert.deepEqual(
      reveils.map((fact) => [fact.sessionId, fact.ref, fact.data]),
      [[OMO_RACINE, "msg_jp_reveil", { etat: "depose", messageId: "msg_jp_reveil" }]],
    );
    // Aucun appel d'IA ne porte le message du réveil : un appel ne vient que d'une partie `step-start`.
    const appels = facts.filter((fact) => fact.kind === "statut" && (fact.data.etat === "appel" || fact.data.etat === "appel-fini"));
    assert.deepEqual(appels.map((fact) => fact.data.messageId), ["msg_jp_reponse"]);
    // Aucun coût : ni dans le réveil, ni ailleurs dans la fixture (aucun `step-finish`).
    assert.deepEqual(facts.filter((fact) => fact.data.cout !== undefined && fact.data.cout !== null), []);
  });

  it("T-L25-c (JP-3) : « lancée » n'est pas « rendue » — le résultat d'une tâche de fond arrive au repos de l'enfant", () => {
    const facts = rejoueOmo();
    const consigne = consigneEnvoyee(facts, "call_jp_fond");
    assert.equal(consigne?.data.fond, true);
    const resultat = faitDe(facts, "resultat", "call_jp_fond");
    assert.equal(resultat?.data.etat, "rendu");
    // La partie `task` s'est close à 230 ; le repos de l'enfant est à 500. Le résultat suit l'enfant, jamais la clôture de l'outil.
    const reposEnfant = facts.find((fact) => fact.sessionId === OMO_FOND && fact.kind === "statut" && fact.data.etat === "repos");
    assert.equal(reposEnfant?.at, 500);
    assert.equal(resultat?.at, 500);
    assert.equal(resultat?.sessionId, OMO_RACINE, "le résultat est porté par la session qui a confié le travail");
    assert.ok(facts.indexOf(resultat as ActivityFact) > facts.indexOf(reposEnfant as ActivityFact));
    // La délégation qui ATTEND le résultat, elle, se clôt sur sa propre partie `task` (470), sans attendre le repos de l'enfant (460).
    assert.equal(faitDe(facts, "resultat", "call_jp_junior")?.at, 470);
  });

  it("T-L25-d (JP-4) : la consigne réelle de l'enfant, et le préfixe ajouté par un hook", () => {
    const facts = rejoueOmo();
    assert.equal(faitDe(facts, "origine", "msg_jp_consigne_junior")?.data.hook, true, "consigne préfixée par la directive de carnet");
    assert.equal(faitDe(facts, "origine", "msg_jp_consigne_fond")?.data.hook, false, "consigne sans préfixe de hook");
    // Hors de la salle, la clé n'existe pas : les faits de l'instance principale ne bougent pas.
    const principale = dedupeFacts(replay("p1-delegation-parallele.jsonl"));
    for (const fact of faitsDe(principale, "origine")) assert.equal(fact.data.hook, undefined);
  });

  it("T-L25-e (JP-6) : carnet partagé et plans, en chemin relatif, jamais le contenu", () => {
    const carnets = faitsDe(rejoueOmo(), "carnet").map((fact) => [fact.sessionId, fact.data.etat, fact.data.chemin]);
    assert.deepEqual(carnets, [
      [OMO_JUNIOR, "modifie", ".omo/notepads/plan/learnings.md"],
      [OMO_JUNIOR, "lu", ".omo/plans/plan.md"],
    ]);
    // Hors de la Salle OMO, la station « Carnet partagé et plan » reste vide : aucun fait, même sur le même chemin.
    const hors = new World(new Map(), [ROOT], "principale");
    const event: FactEvent = {
      type: "message.part.updated",
      properties: { part: { sessionID: ROOT, messageID: "msg_a", type: "tool", tool: "write", callID: "call_c", state: { status: "completed", input: { filePath: "/workspace/p/.omo/notepads/x.md" } } } },
    };
    assert.deepEqual(factsFromEvent(event, hors.ctx(1)).filter((fact) => fact.kind === "carnet"), []);
  });

  it("JP-7 : catégorie, IA, compétences et « attend le résultat » ou « en tâche de fond » ; jamais un nom de compétence", () => {
    const facts = rejoueOmo();
    assert.deepEqual(consigneEnvoyee(facts, "call_jp_fond")?.data, {
      etat: "envoyee",
      callId: "call_jp_fond",
      messageId: "msg_jp_reponse",
      enfant: OMO_FOND,
      agent: "explore",
      source: "ia",
      commande: null,
      reprise: false,
      categorie: "quick",
      ia: "github-copilot/claude-sonnet-4.5",
      competences: 2,
      fond: true,
    });
    assert.deepEqual(consigneEnvoyee(facts, "call_jp_junior")?.data, {
      etat: "envoyee",
      callId: "call_jp_junior",
      messageId: "msg_jp_reponse",
      enfant: OMO_JUNIOR,
      agent: "sisyphus-junior",
      source: "ia",
      commande: null,
      reprise: true,
      categorie: "deep",
      ia: "github-copilot/gpt-5.6-luna",
      competences: 1,
      fond: false,
    });
    // Hors de la salle, aucune de ces clés n'est écrite (les captures de l'itération 1 ne bougent pas).
    for (const fact of faitsDe(dedupeFacts(replay("p1-delegation-parallele.jsonl")), "consigne")) {
      for (const cle of ["categorie", "ia", "competences", "fond"]) assert.equal(fact.data[cle], undefined, cle);
    }
  });

  it("fait « reprise » : la tâche reprise est un identifiant, l'enfant n'est pas neuf", () => {
    const reprises = faitsDe(rejoueOmo(), "reprise");
    assert.deepEqual(
      reprises.map((fact) => [fact.sessionId, fact.ref, fact.data]),
      [[OMO_RACINE, "call_jp_junior", { callId: "call_jp_junior", messageId: "msg_jp_reponse", enfant: OMO_JUNIOR, tache: OMO_JUNIOR }]],
    );
    // `session_id` (délégation de l'extension) vaut `task_id` (task d'opencode) ; une chaîne qui n'est pas un identifiant ne compte pas.
    const w = () => new World(new Map(), [ROOT], "omo");
    const task = (input: Record<string, unknown>): FactEvent => ({
      type: "message.part.updated",
      properties: { part: { sessionID: ROOT, messageID: "msg_a", type: "tool", tool: "task", callID: "call_1", state: { status: "running", input, metadata: { sessionId: "ses_e" } } } },
    });
    assert.equal(factsFromEvent(task({ session_id: "ses_ancienne" }), w().ctx(1))[1]?.data.tache, "ses_ancienne");
    assert.equal(factsFromEvent(task({ task_id: "tâche libre" }), w().ctx(1)).length, 1, "un task_id qui n'est pas un identifiant ne donne aucune reprise");
    assert.equal(factsFromEvent(task({ task_id: "" }), w().ctx(1))[0]?.data.reprise, false);
  });

  it("T-L25-j : aucun texte de la fixture n'entre dans un fait, et chaque fait passe la garde", () => {
    const facts = rejoueOmo();
    assert.ok(facts.length > 20, `${facts.length} faits`);
    for (const fact of facts) assert.equal(factProblem(fact), null, JSON.stringify(fact));
    // Propriété : une chaîne libre ou en forme de secret plantée dans n'importe quel champ de la fixture n'entre jamais dans un fait.
    const canaries = ["Texte planté : ne jamais stocker", ["gh", "p_", "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8"].join("")];
    const world = omoWorld();
    let runs = 0;
    for (const { recv, wire } of readCapture(OMO_FIXTURE)) {
      const event = payloadOf(wire);
      const ctx = world.ctx(recv);
      const paths: Array<Array<string | number>> = [];
      const walk = (value: unknown, at: Array<string | number>) => {
        if (typeof value === "string") paths.push(at);
        else if (Array.isArray(value)) value.forEach((item, i) => walk(item, [...at, i]));
        else if (isRecord(value)) for (const [key, item] of Object.entries(value)) walk(item, [...at, key]);
      };
      walk(event, []);
      for (const leaf of paths) {
        for (const canary of canaries) {
          const clone = structuredClone(event) as unknown as Record<string | number, unknown>;
          let parent: Record<string | number, unknown> = clone;
          for (const key of leaf.slice(0, -1)) parent = parent[key] as Record<string | number, unknown>;
          parent[leaf.at(-1) as string | number] = canary;
          const planted = factsFromEvent(clone as unknown as FactEvent, ctx);
          runs++;
          assert.equal(JSON.stringify(planted).includes(canary), false, `${leaf.join(".")}`);
          for (const fact of planted) assert.equal(factProblem(fact), null, `${leaf.join(".")}`);
        }
      }
      world.observe(event);
    }
    assert.ok(runs > 400, `${runs} essais`);
  });
});

describe("Salle OMO : identité des messages (MO-1) et chemins du carnet", () => {
  const message = (id: string, sessionID: string, role = "user", extra: Record<string, unknown> = {}): FactEvent => ({
    type: "message.updated",
    properties: { sessionID, info: { id, sessionID, role, ...extra } },
  });
  const partie = (messageID: string, sessionID: string, id: string, type = "text"): FactEvent => ({
    type: "message.part.updated",
    properties: { sessionID, part: { id, sessionID, messageID, type, text: "Texte" } },
  });

  it("EventMemory : un messageID vu pour une autre session, ou une partie ajoutée à un message clos, rendent l'identité douteuse", () => {
    const memory = new EventMemory();
    memory.observe(message("msg_1", "ses_a"));
    memory.observe(message("msg_2", "ses_a"));
    assert.equal(memory.identiteSuspecte("msg_1"), false);
    // MO-1 c5 : le même identifiant annoncé pour une autre session.
    memory.observe(message("msg_1", "ses_b"));
    assert.equal(memory.identiteSuspecte("msg_1"), true);
    // MO-1 c3 : une partie de contenu ajoutée après la réponse de l'assistant.
    memory.observe(message("msg_r", "ses_a", "assistant", { parentID: "msg_2" }));
    assert.equal(memory.identiteSuspecte("msg_2"), false);
    memory.observe(partie("msg_2", "ses_a", "prt_tard"));
    assert.equal(memory.identiteSuspecte("msg_2"), true);
    // Une partie qui n'est pas du contenu (fichier) après la réponse n'est pas une réécriture de la demande.
    const autre = new EventMemory();
    autre.observe(message("msg_3", "ses_a"));
    autre.observe(message("msg_r3", "ses_a", "assistant", { parentID: "msg_3" }));
    autre.observe(partie("msg_3", "ses_a", "prt_fichier", "file"));
    assert.equal(autre.identiteSuspecte("msg_3"), false);
    // Une partie écrite dans une autre session que celle où le message a été vu.
    autre.observe(message("msg_4", "ses_a"));
    autre.observe(partie("msg_4", "ses_c", "prt_ailleurs"));
    assert.equal(autre.identiteSuspecte("msg_4"), true);
  });

  it("un message à l'identité douteuse tombe en origine-inconnue, même s'il est dans prompts", () => {
    const world = new World(new Map([["msg_1", "message"]]), [ROOT], "omo");
    const events = [message("msg_1", ROOT), partie("msg_1", ROOT, "prt_1"), message("msg_1", "ses_autre")];
    const facts: ActivityFact[] = [];
    for (const event of events) {
      world.observe(event);
      facts.push(...factsFromEvent(event, world.ctx(1)));
    }
    // Avant le doute, le cockpit reconnaît sa propre demande ; après, la clôture du message la classe origine-inconnue.
    assert.equal(facts.find((fact) => fact.kind === "origine")?.data.origine, "demande");
    world.observe({ type: "session.status", properties: { sessionID: ROOT, status: { type: "idle" } } });
    const apres = factsFromEvent({ type: "session.status", properties: { sessionID: ROOT, status: { type: "idle" } } }, world.ctx(2));
    assert.equal(apres.find((fact) => fact.kind === "origine")?.data.origine, "origine-inconnue");
    assert.equal(world.memory.identiteSuspecte("msg_1"), true);
  });

  it("EventMemory : une tâche de fond est retrouvée par la session de son enfant, jamais par « pending »", () => {
    const memory = new EventMemory();
    const task = (metadata: Record<string, unknown>, input: Record<string, unknown> = { run_in_background: true }): FactEvent => ({
      type: "message.part.updated",
      properties: { sessionID: ROOT, part: { sessionID: ROOT, messageID: "msg_a", type: "tool", tool: "task", callID: "call_1", state: { status: "running", input, metadata } } },
    });
    memory.observe(task({ sessionId: "pending" }));
    assert.equal(memory.tacheDeFond("pending"), null);
    memory.observe(task({ sessionId: "ses_enfant" }));
    assert.deepEqual(memory.tacheDeFond("ses_enfant"), { callId: "call_1", messageId: "msg_a", parent: ROOT });
    // Une délégation qui attend son résultat n'est pas une tâche de fond.
    memory.observe(task({ sessionId: "ses_sync" }, { run_in_background: false }));
    assert.equal(memory.tacheDeFond("ses_sync"), null);
    // Un autre outil n'entre pas dans le registre.
    const autre = new EventMemory();
    autre.observe({
      type: "message.part.updated",
      properties: { sessionID: ROOT, part: { sessionID: ROOT, messageID: "msg_a", type: "tool", tool: "call_omo_agent", callID: "call_2", state: { status: "running", input: { run_in_background: true }, metadata: { sessionId: "ses_x" } } } },
    });
    assert.equal(autre.tacheDeFond("ses_x"), null);
  });

  it("carnetChemin : le chemin part du dossier du carnet, jamais avant ; ce qui n'est pas reconnu reste hors du carnet", () => {
    assert.equal(carnetChemin("/workspace/projet/.omo/notepads/plan/learnings.md"), ".omo/notepads/plan/learnings.md");
    assert.equal(carnetChemin("C:\\workspace\\projet\\.omo\\plans\\plan.md"), ".omo/plans/plan.md");
    assert.equal(carnetChemin(".omo/notepads/x.md"), ".omo/notepads/x.md");
    for (const refuse of [
      "/workspace/projet/src/app.ts",
      "/workspace/projet/.omo/boulder.json",
      "/workspace/projet/.omo/notepads/",
      "/workspace/projet/.omo/notepads/../../evasion.md",
      "/workspace/projet/faux.omo/notepads/x.md",
      `/workspace/.omo/notepads/${"a".repeat(CARNET_CHEMIN_MAX)}.md`,
    ]) {
      assert.equal(carnetChemin(refuse), null, refuse);
    }
  });
});

describe("pureté des modules de faits", () => {
  it("ni module node, ni process, ni horloge, ni aléa, ni réseau ; imports permis seulement", () => {
    for (const file of ["activity-facts.ts", "message-origin.ts"]) {
      const source = fs.readFileSync(path.join(import.meta.dirname, "shared", file), "utf8");
      assert.equal(source.includes('"node:'), false, file);
      assert.equal(/\bprocess\./.test(source), false, file);
      assert.equal(/\bDate\.now\b|new Date\b|Math\.random|\bfetch\s*\(|\bsetTimeout\b|\bperformance\./.test(source), false, file);
      const imports = [...source.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1]);
      for (const spec of imports) assert.ok(spec === "../redact.ts" || /^\.\/[\w.-]+\.ts$/.test(spec ?? ""), `${file} : ${spec}`);
    }
  });
});
