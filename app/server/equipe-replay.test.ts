// « Différé = direct » sur une équipe (spécification §7.1 l.1085, P12 ; plan d'exécution it4, fiche L37b).
//
// La fixture `test-support/fixtures/equipe-avis.jsonl` est une capture du flux `/global/event` d'un avis de bout en bout joué
// sur le FAUX opencode du dépôt avec le vrai runner d'équipes (script `execution/mesures/L37b-capture-equipe-avis.ts` du
// chantier ; aucune IA réelle, aucun jeton). Une ligne JSON par bloc, `{"recv": <ms>, "event": <bloc>}`, relue par
// `readCapture()`. Les jumeaux « sync » n'y sont pas : ils doublent le poids et sont déjà couverts par la capture p6 de
// l'itération 1.
//
// Ce que ce fichier tient :
// - la capture ne contient aucun secret ni chemin d'hôte (`leaks()`, mêmes motifs que les captures de l'itération 1) ;
// - elle contient bien un avis d'équipe : quatre sessions d'étape filles de la racine, sous plancher ETAPE, et les DEUX
//   messages injectés en `noReply` dans la racine (demande et résultat), sans aucun appel d'IA pour eux ;
// - rejouée en différé (faits sérialisés relus, puis `replayMessages` sur les sessions et les messages), elle donne les mêmes
//   lignes, le même Déroulé, les mêmes totaux et le même état qu'en direct.
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import {
  type ActivityState,
  activityStatus,
  applyEvent,
  emptyActivity,
  liveRows,
  replayFacts,
  replayMessages,
  timeline,
  totals,
} from "./shared/activity.ts";
import { EventMemory, type FactContext, FactDeduper, type FactEvent, type FactSession, factsFromEvent } from "./shared/activity-facts.ts";
import type { ActivityFact } from "./shared/activity-types.ts";
import { readCapture } from "./test-support/fake-opencode.ts";
import { leaks } from "./test-support/helpers.ts";

const CAPTURE = "equipe-avis.jsonl";
/** Marqueurs des deux messages que le cockpit injecte dans la racine (D-eq-14, `injectionText`). */
const MARQUEURS = ["<!-- cockpit:equipe-demande run=", "<!-- cockpit:equipe-resultat run="] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const factEvent = (data: ActivityFact) => ({ kind: "cockpit" as const, type: "activite.fait", data });

const rows = () => readCapture(CAPTURE);
const events = (): FactEvent[] => rows().map((row) => row.wire.payload as FactEvent);

/** Texte des parties « text » d'un message de la capture. */
const textOf = (parts: unknown): string =>
  Array.isArray(parts)
    ? parts
        .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("")
    : "";

/** Racine de la capture : la seule session créée sans parent. */
function rootOf(list: readonly FactEvent[]): string {
  for (const event of list) {
    const info = event.properties?.info;
    if (event.type === "session.created" && isRecord(info) && typeof info.id === "string" && !info.parentID) return info.id;
  }
  throw new Error("capture sans racine");
}

/**
 * Côté serveur (L4a, L4b) pendant le direct : sessions connues du cockpit, mémoire du flux, faits gardés par le magasin. Le
 * genre d'un message injecté est reconnu à son marqueur : le cockpit, lui, le tient de `prompts.kind` (L37b, `markPromptKind`).
 */
class Server {
  readonly sessions: Map<string, FactSession>;
  readonly memory = new EventMemory();
  readonly store = new FactDeduper();
  readonly stored: ActivityFact[] = [];
  readonly promptKinds = new Map<string, string>();
  readonly rootId: string;

  constructor(rootId: string) {
    this.rootId = rootId;
    this.sessions = new Map([[rootId, { rootId, parentId: null, purpose: "chat", instance: "principale" }]]);
  }

  resolve(id: string, info?: Readonly<Record<string, unknown>>): FactSession | null {
    const known = this.sessions.get(id);
    if (known) return known;
    if (!info || info.id !== id) return null;
    const parentId = typeof info.parentID === "string" ? info.parentID : null;
    const parent = parentId === null ? undefined : this.sessions.get(parentId);
    if (parentId !== null && !parent) return null;
    const cockpit = isRecord(info.metadata) ? info.metadata.cockpit : undefined;
    const sticky = parent && ["classifier", "equipe", "controle"].includes(parent.purpose) ? parent.purpose : null;
    const purpose = sticky ?? (cockpit === "controle" || cockpit === "equipe" || cockpit === "classifier" ? cockpit : "chat");
    return { rootId: parent ? parent.rootId : id, parentId, purpose: purpose as FactSession["purpose"], instance: parent ? parent.instance : "principale" };
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
    };
  }

  accept(event: FactEvent, receivedAt: number): ActivityFact[] {
    this.memory.observe(event);
    const info = event.properties?.info;
    if ((event.type === "session.created" || event.type === "session.updated") && isRecord(info) && typeof info.id === "string") {
      const session = this.resolve(info.id, info);
      if (session) this.sessions.set(info.id, session);
    }
    if (event.type === "message.part.updated" && isRecord(event.properties?.part)) {
      const part = event.properties.part as Record<string, unknown>;
      const texte = typeof part.text === "string" ? part.text : "";
      const messageId = typeof part.messageID === "string" ? part.messageID : null;
      const marqueur = MARQUEURS.find((entry) => texte.startsWith(entry));
      if (messageId !== null && marqueur !== undefined) this.promptKinds.set(messageId, marqueur.includes("demande") ? "equipe-demande" : "equipe-resultat");
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
  direct: ActivityState;
  stored: ActivityFact[];
  events: FactEvent[];
  rootId: string;
  now: number;
}

/** Direct : chaque bloc passe au navigateur, puis la dérivation synchrone publie ses faits (§3.10 point 1). */
function play(): Played {
  const list = events();
  const rootId = rootOf(list);
  const server = new Server(rootId);
  let direct = emptyActivity(rootId);
  let now = 0;
  for (const { recv, wire } of rows()) {
    const event = wire.payload as FactEvent;
    now = Math.max(now, recv);
    direct = applyEvent(direct, { kind: "opencode", event });
    for (const fact of server.accept(event, recv)) direct = applyEvent(direct, factEvent(fact));
  }
  return { direct, stored: server.stored, events: list, rootId, now: now + 1_000 };
}

/** Lignes d'`activity_facts` relues comme par GET …/facts (aller-retour par JSON, comme en base). */
function reread(stored: readonly ActivityFact[]): unknown[] {
  const lignes = stored.map((fact) => ({
    id: fact.id,
    root_id: fact.rootId,
    session_id: fact.sessionId,
    kind: fact.kind,
    ref: fact.ref,
    data: JSON.stringify(fact.data),
    at: fact.at,
  }));
  return (JSON.parse(JSON.stringify(lignes)) as Array<Record<string, unknown>>).map((row) => ({
    id: row.id,
    rootId: row.root_id,
    sessionId: row.session_id,
    kind: row.kind,
    ref: row.ref,
    data: JSON.parse(String(row.data)) as unknown,
    at: row.at,
  }));
}

/** GET /session/:id/children et GET /session/:id/message rebâtis depuis la capture (dernière version de chaque élément). */
function snapshot(list: readonly FactEvent[]): { sessions: unknown[]; messages: unknown[] } {
  const sessions = new Map<string, unknown>();
  const infos = new Map<string, Record<string, unknown>>();
  const parts = new Map<string, Map<string, unknown>>();
  for (const event of list) {
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
  return {
    sessions: [...sessions.values()],
    messages: [...infos.values()].map((info) => ({ info, parts: [...(parts.get(String(info.id))?.values() ?? [])] })),
  };
}

describe("capture d'une équipe : contenu et analyse de secrets", () => {
  it("lisible, sans secret ni chemin d'hôte, quatre étapes sous plancher ETAPE filles de la racine, deux injections noReply", () => {
    const texte = fs.readFileSync(new URL(`./test-support/fixtures/${CAPTURE}`, import.meta.url), "utf8");
    assert.deepEqual(leaks(texte), [], CAPTURE);
    assert.ok(Buffer.byteLength(texte) <= 150_000, `capture trop lourde : ${Buffer.byteLength(texte)} octets`);

    const list = events();
    const rootId = rootOf(list);
    const creees = list.filter((event) => event.type === "session.created").map((event) => event.properties?.info as Record<string, unknown>);
    const etapes = creees.filter((info) => (isRecord(info.metadata) ? info.metadata.cockpit : null) === "equipe");
    assert.equal(creees.length, 5, "la racine et ses quatre étapes");
    assert.equal(etapes.length, 4);
    for (const info of etapes) {
      assert.equal(info.parentID, rootId, "session d'étape fille de la racine");
      const regles = info.permission as Array<{ action?: string }> | undefined;
      assert.ok(Array.isArray(regles) && regles.length > 0, "plancher ETAPE posé à la création");
      const metadata = info.metadata as Record<string, unknown>;
      assert.deepEqual([typeof metadata.run, typeof metadata.etape, typeof metadata.tentative], ["string", "string", "number"]);
    }

    // Les deux messages injectés sont des messages d'utilisateur de la racine, portés par leur marqueur ; aucune réponse d'IA
    // ne leur est associée (spéc. §6 l.1035 : « recopié ici par le cockpit, sans appel d'IA »).
    const { messages } = snapshot(list);
    const racine = messages.filter((entry) => ((entry as { info: Record<string, unknown> }).info.sessionID as string) === rootId);
    assert.equal(racine.length, 2, "deux messages dans la racine");
    const textes = racine.map((entry) => textOf((entry as { parts: unknown }).parts));
    assert.equal(racine.every((entry) => (entry as { info: Record<string, unknown> }).info.role === "user"), true, "aucun message d'assistant dans la racine");
    assert.ok(textes[0]?.startsWith(MARQUEURS[0]), "la demande porte son marqueur");
    assert.ok(textes[1]?.startsWith(MARQUEURS[1]), "le résultat porte son marqueur");
    assert.ok(textes[1]?.includes("Synthèse : corriger les jointures"), "le résultat recopié est celui de la synthèse");
  });
});

describe("différé = direct sur une équipe (spéc. §7.1 l.1085)", () => {
  it("lignes, Déroulé, totaux et état identiques en direct et relus depuis les faits sérialisés et les messages", () => {
    const { direct, stored, events: list, rootId, now } = play();
    assert.ok(stored.length > 0, "des faits ont été publiés");

    const deferred = replayMessages(replayFacts(emptyActivity(rootId), reread(stored)), snapshot(list));
    assert.deepEqual(liveRows(deferred, now), liveRows(direct, now));
    assert.deepEqual(timeline(deferred), timeline(direct));
    assert.deepEqual(totals(deferred), totals(direct));
    assert.deepEqual(activityStatus(deferred), activityStatus(direct));

    // La racine et ses quatre étapes sont bien là, et seules les étapes ont coûté (les injections ne sont jamais facturées).
    const lignes = liveRows(direct, now);
    assert.equal(lignes.length, 5, "la racine et ses quatre étapes");
    assert.equal(lignes.filter((row) => row.depth === 1).length, 4);
    const racine = lignes.find((row) => row.key === rootId);
    assert.equal(racine?.calls, 0, "aucun appel d'IA dans la racine");
    assert.ok(totals(direct).cost > 0, "les étapes ont coûté");
    assert.equal(totals(direct).cost, totals(deferred).cost);
  });

  it("relecture seule (aucun fait gardé) : mêmes lignes qu'en direct, comme à l'ouverture d'une conversation d'avant la 1.1", () => {
    const { direct, events: list, rootId, now } = play();
    const relu = replayMessages(emptyActivity(rootId), snapshot(list));
    assert.deepEqual(
      liveRows(relu, now).map((row) => [row.key, row.depth, row.calls]),
      liveRows(direct, now).map((row) => [row.key, row.depth, row.calls]),
    );
    assert.equal(totals(relu).cost, totals(direct).cost);
  });
});
