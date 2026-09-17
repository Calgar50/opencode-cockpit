// Scène néon pure (spécification §5.7.1, §5.7.3, §5.7.4, P12, JP-8, JP-13 ; plan d'exécution, fiche L5a) : positions jamais
// réorganisées ; mode Simple à un seul assistant ; aucune taille liée à une grandeur ; « différé = direct » sur p1 ; faisceaux
// figés sur `statut {cause: arret}` ; attente, décisions, terminé, échec ; zoom 3 ; honnêteté du dessin (chaque signe référence
// des faits) ; textes de la carte ; pureté.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { dedupeFacts, EventMemory, type FactContext, FactDeduper, type FactEvent, factsFromEvent, type FactSession, mergeFacts } from "./shared/activity-facts.ts";
import type { ActivityFact, ActivityFactKind, FactValue } from "./shared/activity-types.ts";
import { NEON_GRAMMAIRE, NEON_SIGNE_FAISCEAU, type NeonSign } from "./shared/neon-palette.ts";
import {
  moments,
  NEON_CADRE,
  NEON_OUTILS,
  NEON_PLACES,
  NEON_SECTEURS,
  NEON_TAILLES,
  type NeonMarkedOrigin,
  type NeonNodeState,
  type NeonScene,
  type NeonSceneOptions,
  type NeonStationId,
  scene,
  visibleCount,
} from "./shared/neon-scene.ts";
import {
  carnetVide,
  libelleBouton,
  libelleEtat,
  libelleOrigine,
  libelleOutil,
  libelleSecteur,
  libelleSigne,
  libelleStation,
  remplir,
  TEXTES,
  titreBande,
} from "./shared/neon-texts.ts";
import { readCapture } from "./test-support/fake-opencode.ts";

const ROOT = "ses_f618ff214ffevi6gfuGx6TvpTP";
/** Enfants de p1 : E1 (analyste-journaux) et E2 (analyste-changements). */
const P1_E1 = "ses_f618fc47effewRlFGgpRFi51pw";
const P1_E2 = "ses_f618fbb91ffepC06O3owB9ayZ7";
/** Messages envoyés par le cockpit dans les captures (demande de p1, commande de p2, demande de p6). */
const SENT_BY_COCKPIT = new Set(["msg_09e702c4e001phPA6LcfC9t4WK", "msg_09e70de68001w3xwbgF26JxZPW", "msg_09e75b36c001x5Cehfmxl57pRZ"]);
const CAPTURES = ["p1-delegation-parallele.jsonl", "p2-commande-subtask.jsonl", "p6-arret-global.jsonl", "p7-autorisation-orpheline.jsonl"] as const;

const AVANCE: NeonSceneOptions = { zoom: 2, mode: "avance" };
const SIMPLE: NeonSceneOptions = { zoom: 2, mode: "simple" };
const ALL_OPTIONS: readonly NeonSceneOptions[] = [
  SIMPLE,
  AVANCE,
  { zoom: 3, mode: "simple" },
  { zoom: 3, mode: "avance" },
  { zoom: 3, mode: "avance", focus: P1_E2 },
];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// --- Faits des captures (même chemin que le magasin : factsFromEvent puis FactDeduper) ---------------------------------------------

interface LiveStep {
  /** Faits gardés jusqu'à cet événement compris. */
  facts: ActivityFact[];
}

/** Rejoue une capture comme le direct : faits dérivés événement par événement, doublons écartés ; un pas par événement qui en ajoute. */
function live(name: string, sent: ReadonlySet<string> = SENT_BY_COCKPIT): LiveStep[] {
  const sessions = new Map<string, FactSession>([[ROOT, { rootId: ROOT, parentId: null, purpose: "chat", instance: "principale" }]]);
  const memory = new EventMemory();
  const deduper = new FactDeduper();
  const resolve = (id: string, info?: Readonly<Record<string, unknown>>): FactSession | null => {
    const known = sessions.get(id);
    if (known) return known;
    if (!info || info.id !== id) return null;
    const parentId = typeof info.parentID === "string" ? info.parentID : null;
    const parent = parentId === null ? undefined : sessions.get(parentId);
    if (parentId !== null && !parent) return null;
    return { rootId: parent ? parent.rootId : id, parentId, purpose: "chat", instance: "principale" };
  };
  const kept: ActivityFact[] = [];
  const steps: LiveStep[] = [];
  for (const { recv, wire } of readCapture(name)) {
    const event = wire.payload as FactEvent;
    memory.observe(event);
    const info = event.properties?.info;
    if ((event.type === "session.created" || event.type === "session.updated") && isRecord(info) && typeof info.id === "string") {
      const session = resolve(info.id, info);
      if (session) sessions.set(info.id, session);
    }
    const ctx: FactContext = {
      receivedAt: recv,
      session: resolve,
      messageRole: (id) => memory.messageRole(id),
      promptKind: (id) => (sent.has(id) ? "message" : null),
      firstUserMessage: (id) => memory.firstUserMessage(id),
      userMessageParts: (id) => memory.userMessageParts(id),
      unansweredUserMessages: (id) => memory.unansweredUserMessages(id),
    };
    const added = factsFromEvent(event, ctx).filter((fact) => deduper.accept(fact));
    if (added.length === 0) continue;
    kept.push(...added);
    steps.push({ facts: [...kept] });
  }
  return steps;
}

const replay = (name: string, sent?: ReadonlySet<string>): ActivityFact[] => live(name, sent).at(-1)?.facts ?? [];

/** Faits relus comme depuis la base : data sérialisé en JSON, puis relu. */
const stored = (facts: readonly ActivityFact[]): ActivityFact[] =>
  facts.map((f, i) => ({ id: i + 1, rootId: f.rootId, sessionId: f.sessionId, kind: f.kind, ref: f.ref, data: JSON.parse(JSON.stringify(f.data)), at: f.at }));

// --- Histoires synthétiques ------------------------------------------------------------------------------------------------------

const R = "ses_racine";

class Story {
  readonly facts: ActivityFact[] = [];
  readonly rootId: string;
  #at = 1_000;

  constructor(rootId = R) {
    this.rootId = rootId;
  }

  add(sessionId: string, kind: ActivityFactKind, data: Record<string, FactValue>, ref: string | null = null): number {
    this.#at += 10;
    this.facts.push({ rootId: this.rootId, sessionId, kind, ref, data, at: this.#at });
    return this.facts.length - 1;
  }

  demande(messageId: string) {
    return this.add(this.rootId, "origine", { origine: "demande", cas: 1, messageId }, messageId);
  }
  occupee(sessionId: string) {
    return this.add(sessionId, "statut", { etat: "occupee" });
  }
  repos(sessionId: string) {
    return this.add(sessionId, "statut", { etat: "repos" });
  }
  erreur(sessionId: string, erreur: string) {
    return this.add(sessionId, "statut", { etat: "erreur", erreur });
  }
  creee(sessionId: string, parent: string, agent: string | null) {
    return this.add(sessionId, "statut", { etat: "creee", role: "delegation", parent, agent, instance: "principale" });
  }
  prepare(sessionId: string, callId: string, messageId: string) {
    return this.add(sessionId, "consigne", { etat: "prepare", callId, messageId }, callId);
  }
  envoyee(sessionId: string, callId: string, messageId: string | null, enfant: string, agent: string | null) {
    return this.add(sessionId, "consigne", { etat: "envoyee", callId, messageId, enfant, agent, source: "ia", commande: null, reprise: false }, callId);
  }
  resultat(sessionId: string, callId: string, enfant: string | null, etat: "rendu" | "echec" | "interrompu") {
    return this.add(sessionId, "resultat", { etat, callId, messageId: "msg_x", enfant }, callId);
  }
  /** Préparation, création, envoi, puis l'enfant se met au travail. */
  delegate(parent: string, callId: string, messageId: string, enfant: string, agent: string) {
    this.prepare(parent, callId, messageId);
    this.creee(enfant, parent, agent);
    this.envoyee(parent, callId, messageId, enfant, agent);
    return this.occupee(enfant);
  }
  outil(sessionId: string, callId: string, outil: string, phase: string, fichier: string | null = null, dossier: string | null = null) {
    return this.add(sessionId, "statut", { etat: "outil", outil, nom: outil, phase, callId, messageId: "msg_o", fichier, dossier }, callId);
  }
  attente(sessionId: string, permissionId: string, callId: string, permission: string) {
    return this.add(sessionId, "attente", { permission, messageId: "msg_o", callId, agent: null }, permissionId);
  }
  reponse(sessionId: string, permissionId: string, reponse: "once" | "reject") {
    return this.add(sessionId, "reponse", { reponse }, permissionId);
  }
  decision(sessionId: string, permissionId: string, verdict: string, regle = "E1") {
    return this.add(sessionId, "decision", { verdict, regle, par: "regles" }, permissionId);
  }
  arret(cause = "arret") {
    return this.add(this.rootId, "statut", { cause });
  }
}

const nodeOf = (s: NeonScene, sessionId: string) => s.noeuds.find((n) => n.sessionId === sessionId);
const beamsOf = (s: NeonScene) => s.faisceaux.map((b) => `${b.kind}:${b.de}>${b.vers ?? "?"}${b.fige ? ":fige" : ""}`);

// --- Signes et références (P12) -----------------------------------------------------------------------------------------------------

interface SignRef {
  quoi: string;
  /** Sessions dont au moins un fait référencé doit venir ; vide : un fait de la conversation suffit. */
  sessions: string[];
  /** Natures permises pour le premier fait référencé, celui qui fait apparaître le signe. */
  premier: readonly ActivityFactKind[];
  faits: readonly number[];
}

const ACTIVITY: readonly ActivityFactKind[] = ["statut", "origine", "consigne", "resultat", "attente", "reponse", "decision"];
const BEAM_OPENERS: Readonly<Record<string, readonly ActivityFactKind[]>> = { demande: ["origine"], preparation: ["consigne"], consigne: ["consigne"], resultat: ["resultat"] };

function signsOf(s: NeonScene): SignRef[] {
  const out: SignRef[] = [];
  for (const n of s.noeuds) {
    out.push({ quoi: `assistant ${n.sessionId}`, sessions: [n.sessionId], premier: ACTIVITY, faits: n.faits });
    if (n.dernierAppel) out.push({ quoi: `appel ${n.sessionId}`, sessions: [n.sessionId], premier: ["statut"], faits: n.dernierAppel.faits });
    if (n.taches) out.push({ quoi: `tâches ${n.sessionId}`, sessions: [n.sessionId], premier: ["statut"], faits: n.taches.faits });
    if (n.memoireResumee) out.push({ quoi: `mémoire ${n.sessionId}`, sessions: [n.sessionId], premier: ["statut"], faits: n.memoireResumee.faits });
  }
  for (const b of s.faisceaux) {
    out.push({ quoi: `faisceau ${b.id}`, sessions: [b.de, b.vers ?? ""].filter((id) => id !== "vous" && id !== ""), premier: BEAM_OPENERS[b.kind] ?? [], faits: b.faits });
  }
  for (const w of s.attentes) out.push({ quoi: `attente ${w.permissionId}`, sessions: [w.sessionId], premier: ["attente"], faits: w.faits });
  for (const d of s.decisions) out.push({ quoi: `décision ${d.permissionId}`, sessions: [d.sessionId], premier: ["decision"], faits: d.faits });
  for (const p of s.impulsions) out.push({ quoi: `impulsion ${p.messageId}`, sessions: [p.sessionId], premier: ["statut"], faits: p.faits });
  for (const o of s.origines) out.push({ quoi: `origine ${o.messageId}`, sessions: [o.sessionId], premier: ["origine"], faits: o.faits });
  if (s.arret) out.push({ quoi: "arrêt", sessions: [], premier: ["statut"], faits: s.arret.faits });
  const d = s.detail;
  if (d) {
    for (const slot of [...d.outils, { ...d.autresOutils, categorie: "autres" }]) {
      const counted = slot.enCours + slot.termines + slot.echecs + slot.interrompus;
      if (counted > 0) out.push({ quoi: `outil ${slot.categorie}`, sessions: [d.sessionId], premier: ["statut", "consigne"], faits: slot.faits });
      else assert.deepEqual(slot.faits, [], `outil ${slot.categorie} sans compte : aucune référence`);
    }
    for (const folder of d.dossiers) {
      for (const tile of folder.tuiles) out.push({ quoi: `tuile ${tile.fichier}`, sessions: [d.sessionId], premier: ["statut", "attente"], faits: tile.faits });
    }
    const { consigne, actions, resultat, reponse } = d.panneau;
    if (consigne) out.push({ quoi: "panneau consigne", sessions: [d.sessionId], premier: ["origine"], faits: consigne.faits });
    if (reponse) out.push({ quoi: "panneau réponse", sessions: [d.sessionId], premier: ["statut"], faits: reponse.faits });
    if (resultat) out.push({ quoi: "panneau résultat", sessions: [], premier: ["resultat"], faits: resultat.faits });
    if (actions.termines > 0) out.push({ quoi: "panneau actions", sessions: [d.sessionId], premier: ["statut", "consigne"], faits: actions.faits });
    else assert.deepEqual(actions.faits, []);
  }
  return out;
}

function assertHonest(s: NeonScene, facts: readonly ActivityFact[], visible: number, label: string): void {
  for (const sign of signsOf(s)) {
    assert.ok(sign.faits.length > 0, `${label} : ${sign.quoi} sans fait`);
    for (const i of sign.faits) {
      assert.ok(Number.isInteger(i) && i >= 0 && i < visible, `${label} : ${sign.quoi} référence ${i} hors des ${visible} faits visibles`);
      assert.equal(facts[i]?.rootId, s.rootId, `${label} : ${sign.quoi} référence un fait d'une autre conversation`);
    }
    const opener = facts[sign.faits[0] ?? -1];
    assert.ok(opener !== undefined && sign.premier.includes(opener.kind), `${label} : ${sign.quoi} ouvert par un fait « ${opener?.kind} »`);
    if (opener?.kind === "statut" && sign.quoi === "arrêt") assert.equal(opener.data.cause, "arret", `${label} : arrêt sans fait d'arrêt`);
    if (sign.sessions.length > 0) {
      assert.ok(
        sign.faits.some((i) => sign.sessions.includes(facts[i]?.sessionId ?? "")),
        `${label} : ${sign.quoi} ne référence aucun fait de ${sign.sessions.join(", ")}`,
      );
    }
  }
}

/** Clés de tout l'arbre d'une valeur. */
function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keysOf(item, out);
  else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      out.add(key);
      keysOf(item, out);
    }
  }
  return out;
}

/** Copie sans les champs de valeur affichée (heures, coûts, tentatives, tâches) : il reste le dessin. */
function drawingOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(drawingOf);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !["depuis", "at", "cout", "tentative", "faites", "total"].includes(key)).map(([key, item]) => [key, drawingOf(item)]));
}

// --- Tests ------------------------------------------------------------------------------------------------------------------------

describe("scène néon sur p1 : deux délégations en même temps (§5.7.1, §5.7.3)", () => {
  const facts = replay("p1-delegation-parallele.jsonl");
  const at = (pred: (f: ActivityFact) => boolean) => facts.findIndex(pred);

  it("consigne rose en préparation, attente d'accord posée sur elle, puis deux consignes « en même temps » sur l'anneau 1", () => {
    const iWait = at((f) => f.kind === "attente");
    const waiting = scene(facts.slice(0, iWait + 1), null, AVANCE);
    assert.equal(nodeOf(waiting, ROOT)?.etat, "attente-accord");
    assert.equal(waiting.attentes.length, 1);
    const prep = waiting.faisceaux.find((b) => b.kind === "preparation");
    assert.ok(prep);
    assert.equal(waiting.attentes[0]?.faisceau, prep.id);
    assert.equal(prep.vers, null);
    assert.deepEqual(beamsOf(waiting), [`demande:vous>${ROOT}`, `consigne:${ROOT}>${P1_E1}`, `preparation:${ROOT}>?`]);

    const iSecond = at((f) => f.kind === "consigne" && f.data.etat === "envoyee" && f.data.enfant === P1_E2);
    const both = scene(facts.slice(0, iSecond + 1), null, AVANCE);
    assert.deepEqual(beamsOf(both), [`demande:vous>${ROOT}`, `consigne:${ROOT}>${P1_E1}`, `consigne:${ROOT}>${P1_E2}`]);
    assert.ok(both.faisceaux.filter((b) => b.kind === "consigne").every((b) => b.enMemeTemps));
    assert.equal(both.attentes.length, 0);
    for (const child of [P1_E1, P1_E2]) {
      const node = nodeOf(both, child);
      assert.equal(node?.anneau, 1);
      assert.equal(node?.secteur, "autres");
      assert.deepEqual(both.faisceaux.find((b) => b.vers === child)?.arrivee, node?.position);
    }
    assert.deepEqual([nodeOf(both, P1_E1)?.place, nodeOf(both, P1_E2)?.place], [0, 1]);
    assert.deepEqual(nodeOf(both, ROOT)?.position, { x: 280, y: 110 });
    assert.deepEqual(both.faisceaux[0]?.depart, both.stations.find((st) => st.id === "vous")?.position);
  });

  it("résultat bleu à losanges du premier enfant pendant que le second travaille, puis fin : tout est terminé, plus aucun faisceau", () => {
    const iFirst = at((f) => f.kind === "resultat");
    const first = scene(facts.slice(0, iFirst + 1), null, AVANCE);
    assert.deepEqual(beamsOf(first), [`demande:vous>${ROOT}`, `consigne:${ROOT}>${P1_E2}`, `resultat:${P1_E1}>${ROOT}`]);
    assert.equal(nodeOf(first, P1_E1)?.etat, "termine");
    assert.equal(nodeOf(first, P1_E2)?.etat, "travaille");
    assert.equal(NEON_GRAMMAIRE[NEON_SIGNE_FAISCEAU.resultat].forme, "pointille-losanges");
    assert.equal(NEON_GRAMMAIRE[NEON_SIGNE_FAISCEAU.consigne].forme, "trait-plein-chevrons");

    const end = scene(facts, null, AVANCE);
    assert.deepEqual(end.noeuds.map((n) => n.etat), ["termine", "termine", "termine"]);
    assert.deepEqual([end.faisceaux, end.attentes, end.impulsions, end.decisions], [[], [], [], []]);
    assert.equal(end.arret, null);
  });

  it("appel d'IA : impulsion vers « GitHub Copilot » tant qu'il court ; le coût n'apparaît qu'à l'arrivée", () => {
    const iCall = at((f) => f.data.etat === "appel");
    const calling = scene(facts.slice(0, iCall + 1), null, AVANCE);
    assert.equal(calling.impulsions.length, 1);
    assert.deepEqual(calling.impulsions[0]?.arrivee, calling.stations.find((st) => st.id === "copilot")?.position);
    assert.equal(nodeOf(calling, ROOT)?.dernierAppel, null);

    const st = new Story();
    st.demande("msg_d");
    st.occupee(R);
    st.add(R, "statut", { etat: "appel", messageId: "msg_a" }, "msg_a");
    const running = scene(st.facts, null, AVANCE);
    assert.equal(nodeOf(running, R)?.dernierAppel, null);
    const done = st.add(R, "statut", { etat: "appel-fini", messageId: "msg_a", cout: 0.42, raison: "stop" }, "msg_a");
    const arrived = scene(st.facts, null, AVANCE);
    assert.deepEqual(arrived.impulsions, []);
    assert.deepEqual(nodeOf(arrived, R)?.dernierAppel, { at: st.facts[done]?.at, cout: 0.42, faits: [2, done] });
  });
});

describe("positions attribuées une fois, jamais réorganisées", () => {
  /** Chaque signe placé garde sa position dans toutes les scènes suivantes (assistants, tuiles). */
  function assertStable(facts: readonly ActivityFact[], options: NeonSceneOptions, label: string) {
    const placed = new Map<string, string>();
    for (let k = 1; k <= facts.length; k++) {
      const s = scene(facts.slice(0, k), null, options);
      for (const n of s.noeuds) {
        const where = JSON.stringify([n.secteur, n.anneau, n.place, n.empile, n.position, n.parentId]);
        const before = placed.get(`noeud ${n.sessionId}`);
        if (before !== undefined) assert.equal(where, before, `${label} : ${n.sessionId} déplacé au fait ${k - 1}`);
        placed.set(`noeud ${n.sessionId}`, where);
      }
      for (const folder of s.detail?.dossiers ?? []) {
        for (const tile of folder.tuiles) {
          const key = `tuile ${s.detail?.sessionId} ${folder.dossier} ${tile.fichier}`;
          const where = JSON.stringify([folder.colonne, tile.position]);
          const before = placed.get(key);
          if (before !== undefined) assert.equal(where, before, `${label} : ${key} déplacée au fait ${k - 1}`);
          placed.set(key, where);
        }
      }
      assert.deepEqual(s.stations.map((st) => st.position), scene([], null, options).stations.map((st) => st.position));
      assert.deepEqual(s.secteurs, scene([], null, options).secteurs);
    }
  }

  it("p1, p2, p6 et p7 : dans les deux modes et les deux zooms, à chaque fait ajouté", () => {
    for (const name of CAPTURES) for (const options of ALL_OPTIONS) assertStable(replay(name), options, `${name} ${JSON.stringify(options)}`);
  });

  it("secteurs, anneaux, vagues, empilement, sous-délégation et nouvelle réponse : ordre d'apparition, jamais l'ordre alphabétique", () => {
    const st = new Story();
    st.demande("msg_d1");
    st.occupee(R);
    // Vague 1 (un message) : quatre « explore » dans Chercher, puis un assistant inconnu dans Autres.
    for (const i of [1, 2, 3, 4]) st.delegate(R, `call_a${i}`, "msg_a", `ses_c${i}`, "explore");
    st.delegate(R, "call_a5", "msg_a", "ses_z", "zeta");
    // Un résultat revient : le message suivant ouvre la vague 2 ; « aardvark » arrive après « zeta ».
    st.repos("ses_c1");
    st.resultat(R, "call_a1", "ses_c1", "rendu");
    st.delegate(R, "call_b1", "msg_b", "ses_aa", "aardvark");
    st.delegate(R, "call_b2", "msg_b", "ses_c5", "explore");
    // Sous-délégation depuis un enfant de l'anneau 1.
    st.delegate("ses_c2", "call_s1", "msg_s", "ses_s1", "plan");
    // Raccourci sans préparation (création avant l'envoi) après un nouveau résultat : vague 3.
    st.repos("ses_aa");
    st.resultat(R, "call_b1", "ses_aa", "rendu");
    st.creee("ses_r1", R, "zeta");
    st.envoyee(R, "call_r1", "msg_r", "ses_r1", "zeta");
    st.repos(R);
    // Nouvelle réponse : les vagues repartent de 1, les places continuent.
    st.demande("msg_d2");
    st.occupee(R);
    st.delegate(R, "call_c1", "msg_c", "ses_n1", "explore");

    const end = scene(st.facts, null, AVANCE);
    const table = end.noeuds.map((n) => [n.sessionId, n.secteur, n.anneau, n.place, n.empile]);
    assert.deepEqual(table, [
      [R, null, 0, 0, false],
      ["ses_c1", "chercher", 1, 0, false],
      ["ses_c2", "chercher", 1, 1, false],
      ["ses_c3", "chercher", 1, 2, false],
      ["ses_c4", "chercher", 1, 3, true],
      ["ses_z", "autres", 1, 0, false],
      ["ses_aa", "autres", 2, 0, false],
      ["ses_c5", "chercher", 2, 0, false],
      ["ses_s1", "planifier", 2, 0, false],
      ["ses_r1", "autres", 3, 0, false],
      ["ses_n1", "chercher", 1, 4, true],
    ]);
    assert.equal(NEON_PLACES, 3);
    // Empilées sur la dernière place de leur anneau.
    assert.deepEqual(nodeOf(end, "ses_c4")?.position, nodeOf(end, "ses_c3")?.position);
    assert.deepEqual(nodeOf(end, "ses_n1")?.position, nodeOf(end, "ses_c3")?.position);
    // Secteur donné par l'appelant (rôles de la Salle OMO) ; valeur inconnue : Autres.
    const roles = scene(st.facts, null, { ...AVANCE, secteurs: { zeta: "verifier", aardvark: "inconnu" as never } });
    assert.equal(nodeOf(roles, "ses_z")?.secteur, "verifier");
    assert.equal(nodeOf(roles, "ses_aa")?.secteur, "autres");
    assertStable(st.facts, AVANCE, "histoire");
    assertStable(st.facts, { zoom: 3, mode: "avance", focus: "ses_c2" }, "histoire zoom 3");
  });

  it("création avant l'envoi, après un résultat tardif de la vague précédente : la délégation reste dans la vague de sa préparation", () => {
    const st = new Story();
    st.occupee(R);
    st.delegate(R, "call_1", "msg_a", "ses_1", "zeta");
    st.delegate(R, "call_2", "msg_a", "ses_2", "zeta");
    st.repos("ses_1");
    st.resultat(R, "call_1", "ses_1", "rendu");
    st.prepare(R, "call_3", "msg_b");
    // Résultat de la vague 1 rangé après la préparation de la vague 2 (inversion d'heure bornée, M15).
    st.repos("ses_2");
    st.resultat(R, "call_2", "ses_2", "rendu");
    st.creee("ses_3", R, "zeta");
    st.envoyee(R, "call_3", "msg_b", "ses_3", "zeta");
    assert.deepEqual(scene(st.facts, null, AVANCE).noeuds.map((n) => [n.sessionId, n.anneau]), [[R, 0], ["ses_1", 1], ["ses_2", 1], ["ses_3", 2]]);
  });

  it("un statut « occupée » répété dans la même réponse ne relance pas les vagues", () => {
    const st = new Story();
    st.occupee(R);
    st.delegate(R, "call_1", "msg_a", "ses_1", "zeta");
    st.occupee(R);
    st.delegate(R, "call_2", "msg_b", "ses_2", "zeta");
    assert.deepEqual(scene(st.facts, null, AVANCE).noeuds.map((n) => n.anneau), [0, 1, 2]);
  });
});

describe("mode Simple : un seul assistant (décision n° 4)", () => {
  it("p1 : à chaque fait, seulement l'assistant de la conversation et le faisceau de votre demande ; délégations comptées", () => {
    for (const step of live("p1-delegation-parallele.jsonl")) {
      const s = scene(step.facts, null, SIMPLE);
      assert.ok(s.noeuds.every((n) => n.sessionId === ROOT) && s.noeuds.length <= 1);
      assert.ok(s.faisceaux.every((b) => b.kind === "demande"));
      for (const sign of [...s.attentes, ...s.decisions, ...s.impulsions, ...s.origines]) assert.equal(sign.sessionId, ROOT);
      assert.ok(s.attentes.every((w) => w.faisceau === null));
    }
    const facts = replay("p1-delegation-parallele.jsonl");
    assert.equal(scene(facts, null, SIMPLE).delegationsMasquees, 2);
    assert.equal(scene(facts, null, AVANCE).noeuds.length, 3);
    assert.equal(scene(facts, null, AVANCE).delegationsMasquees, 0);
  });

  it("zoom 3 : le détail reste celui de la conversation en Simple, même si une délégation est demandée", () => {
    const facts = replay("p1-delegation-parallele.jsonl");
    assert.equal(scene(facts, null, { zoom: 3, mode: "simple", focus: P1_E2 }).detail?.sessionId, ROOT);
    assert.equal(scene(facts, null, { zoom: 3, mode: "avance", focus: P1_E2 }).detail?.sessionId, P1_E2);
    // Focus inconnu en Avancé : la conversation, avec ses propres outils.
    const unknown = scene(facts, null, { zoom: 3, mode: "avance", focus: "ses_inconnue" });
    assert.equal(unknown.detail?.sessionId, ROOT);
    assert.deepEqual(unknown.detail, scene(facts, null, { zoom: 3, mode: "avance" }).detail);
  });

  it("mode inconnu : Simple (défaut) ; zoom inconnu : 2, sans détail", () => {
    const facts = replay("p1-delegation-parallele.jsonl");
    const odd = scene(facts, null, { zoom: 7 as never, mode: "expert" as never, focus: P1_E1 });
    assert.equal(odd.mode, "simple");
    assert.equal(odd.zoom, 2);
    assert.equal(odd.detail, null);
    assert.deepEqual(odd, scene(facts, null, SIMPLE));
  });
});

describe("aucune taille ni épaisseur liée à une grandeur (§5.7.1)", () => {
  it("la scène ne porte ni taille, ni épaisseur, ni rayon, ni opacité, ni échelle ; les tailles sont des constantes", () => {
    const keys = new Set<string>();
    for (const name of CAPTURES) for (const options of ALL_OPTIONS) keysOf(scene(replay(name), null, options), keys);
    const forbidden = [...keys].filter((key) => /taille|epaisseur|rayon|largeur|hauteur|echelle|opacit|intensit|poids|size|width|height|radius|scale|weight|thick|stroke|glow|halo/i.test(key));
    assert.deepEqual(forbidden, []);
    assert.ok(Object.isFrozen(NEON_TAILLES));
    assert.ok(Object.values(NEON_TAILLES).every((v) => typeof v === "number"));
    assert.deepEqual(NEON_CADRE, { largeur: 560, hauteur: 220 });
  });

  it("coûts, durées, tentatives et tâches multipliés : même dessin, seules les valeurs affichées changent", () => {
    const base = replay("p1-delegation-parallele.jsonl");
    const t0 = base[0]?.at ?? 0;
    const extra = (tentative: number, faites: number, total: number, at: number): ActivityFact[] => [
      { rootId: ROOT, sessionId: P1_E2, kind: "statut", ref: null, data: { etat: "nouvelle-tentative", tentative }, at },
      { rootId: ROOT, sessionId: P1_E2, kind: "statut", ref: null, data: { etat: "taches", faites, total }, at: at + 1 },
    ];
    const cut = base.findIndex((f) => f.kind === "resultat");
    const small = [...base.slice(0, cut), ...extra(1, 1, 2, base[cut]?.at ?? 0), ...base.slice(cut)];
    const big = small.map((f) => ({
      ...f,
      at: t0 + (f.at - t0) * 37,
      data: { ...f.data, ...(typeof f.data.cout === "number" ? { cout: f.data.cout + 123.45 } : {}), ...(typeof f.data.tentative === "number" ? { tentative: 97 } : {}), ...(f.data.etat === "taches" ? { faites: 450, total: 900 } : {}) },
    }));
    for (const options of ALL_OPTIONS) {
      for (const k of [cut + 2, big.length]) {
        const a = scene(small.slice(0, k), null, options);
        const b = scene(big.slice(0, k), null, options);
        assert.notDeepEqual(a, b);
        assert.deepEqual(drawingOf(b), drawingOf(a), `${JSON.stringify(options)} k=${k}`);
      }
    }
  });
});

describe("différé = direct (P12, JP-8)", () => {
  it("p1 : à chaque pas du direct, la scène relue depuis la base au même moment est identique, dans tous les modes et zooms", () => {
    const steps = live("p1-delegation-parallele.jsonl");
    const reread = stored(steps.at(-1)?.facts ?? []);
    const cuts = new Set(moments(reread));
    let compared = 0;
    for (const step of steps) {
      const t = step.facts.at(-1)?.at ?? 0;
      if (!cuts.has(t) || visibleCount(reread, t) !== step.facts.length) continue;
      compared += 1;
      for (const options of ALL_OPTIONS) assert.deepEqual(scene(reread, t, options), scene(step.facts, null, options), `t=${t} ${JSON.stringify(options)}`);
    }
    assert.ok(compared >= 45, `pas comparés : ${compared} sur ${steps.length}`);
    for (const options of ALL_OPTIONS) assert.deepEqual(scene(reread, null, options), scene(steps.at(-1)?.facts ?? [], null, options));
  });

  it("recouvrement du différé et du direct (mergeFacts) : même scène que le direct seul", () => {
    const direct = replay("p1-delegation-parallele.jsonl");
    const reread = stored(direct);
    for (const [k, m] of [[20, 35], [0, direct.length], [30, 30], [direct.length - 1, direct.length]] as const) {
      const merged = mergeFacts(stored(reread.slice(0, m)), direct.slice(k));
      for (const options of ALL_OPTIONS) assert.deepEqual(scene(merged, null, options), scene(direct, null, options), `k=${k} m=${m}`);
    }
  });

  it("moments : coupures nettes seulement ; deux faits à la même heure restent ensemble ; avant le premier fait, scène vide", () => {
    const facts = replay("p6-arret-global.jsonl");
    const cuts = moments(facts);
    assert.deepEqual(cuts, [...new Set(facts.map((f) => f.at))].sort((a, b) => a - b));
    const twin = facts.findIndex((f, i) => i > 0 && f.at === facts[i - 1]?.at);
    assert.ok(twin > 0);
    assert.equal(visibleCount(facts, facts[twin]?.at ?? 0), twin + 1);
    assert.equal(visibleCount(facts, (facts[0]?.at ?? 0) - 1), 0);
    const before = scene(facts, (facts[0]?.at ?? 0) - 1, AVANCE);
    assert.deepEqual(before, { ...scene([], null, AVANCE), rootId: ROOT });
    // Heure inversée entre deux faits (borne M15) : aucun moment ne coupe entre eux.
    const swapped = facts.map((f, i) => (i === 3 ? { ...f, at: (facts[4]?.at ?? 0) + 100 } : f));
    assert.ok(!moments(swapped).includes(facts[3]?.at ?? 0));
    assert.ok(!moments(swapped).includes(facts[4]?.at ?? 0));
    // Propriété : à chaque moment, les faits visibles ont tous une heure au plus égale, les suivants une heure postérieure.
    const unordered = [10, 20, 10, 30].map((at, i): ActivityFact => ({ rootId: R, sessionId: R, kind: "statut", ref: null, data: { etat: i % 2 ? "repos" : "occupee" }, at }));
    assert.deepEqual(moments(unordered), [20, 30]);
    for (const list of [...CAPTURES.map((name) => replay(name)), swapped, unordered]) {
      for (const m of moments(list)) {
        const n = visibleCount(list, m);
        assert.ok(list.slice(0, n).every((f) => f.at <= m) && list.slice(n).every((f) => f.at > m), `moment ${m}`);
      }
    }
  });
});

describe("arrêt : faisceaux figés en gris sur `statut {cause: arret}`", () => {
  const p6 = replay("p6-arret-global.jsonl");
  const iAbort = p6.findIndex((f) => f.data.erreur === "MessageAbortedError");
  const stopFact = (at: number): ActivityFact => ({ rootId: ROOT, sessionId: ROOT, kind: "statut", ref: null, data: { cause: "arret" }, at });

  it("p6, fait d'arrêt avant l'interruption : demande, consigne et préparation figées ; rien avant le fait", () => {
    const facts = [...p6.slice(0, iAbort), stopFact(p6[iAbort]?.at ?? 0), ...p6.slice(iAbort)];
    const before = scene(facts.slice(0, iAbort), null, AVANCE);
    assert.equal(before.arret, null);
    assert.ok(before.faisceaux.every((b) => !b.fige));
    const atStop = scene(facts.slice(0, iAbort + 1), null, AVANCE);
    assert.deepEqual(atStop.arret?.faits, [iAbort]);
    assert.deepEqual(beamsOf(atStop).sort(), [`consigne:${ROOT}>ses_f618a447fffeYFrtWmM6ByLKgD:fige`, `demande:vous>${ROOT}:fige`, `preparation:${ROOT}>?:fige`]);
    assert.ok(atStop.faisceaux.every((b) => b.fin === null), "figés encore ouverts");
    const end = scene(facts, null, AVANCE);
    assert.deepEqual(beamsOf(end).sort(), beamsOf(atStop).sort());
    assert.ok(end.faisceaux.every((b) => b.fige && b.fin !== null));
    assert.deepEqual(end.noeuds.map((n) => n.etat), ["arrete", "arrete"]);
    assert.deepEqual(end.attentes, []);
    // Mode Simple : seule la demande, figée.
    assert.deepEqual(beamsOf(scene(facts, null, SIMPLE)), [`demande:vous>${ROOT}:fige`]);
  });

  it("p6, fait d'arrêt écrit après la fin de la réponse interrompue : mêmes faisceaux figés", () => {
    const early = [...p6.slice(0, iAbort), stopFact(p6[iAbort]?.at ?? 0), ...p6.slice(iAbort)];
    const late = [...p6, stopFact((p6.at(-1)?.at ?? 0) + 5)];
    assert.deepEqual(beamsOf(scene(late, null, AVANCE)).sort(), beamsOf(scene(early, null, AVANCE)).sort());
    assert.deepEqual(scene(late, null, AVANCE).arret?.faits, [late.length - 1]);
  });

  it("une nouvelle demande garde l'arrêt affiché, sans figer son faisceau ; la nouvelle réponse efface l'arrêt", () => {
    const facts = [...p6, stopFact((p6.at(-1)?.at ?? 0) + 5)];
    const t = (p6.at(-1)?.at ?? 0) + 10;
    const demand: ActivityFact = { rootId: ROOT, sessionId: ROOT, kind: "origine", ref: "msg_nouveau", data: { origine: "demande", cas: 1, messageId: "msg_nouveau" }, at: t };
    const asked = scene([...facts, demand], null, AVANCE);
    assert.notEqual(asked.arret, null);
    assert.deepEqual(asked.faisceaux.filter((b) => !b.fige).map((b) => b.id), ["demande:msg_nouveau"]);
    assert.equal(asked.faisceaux.filter((b) => b.fige).length, 3);
    const busy: ActivityFact = { rootId: ROOT, sessionId: ROOT, kind: "statut", ref: null, data: { etat: "occupee" }, at: t + 1 };
    const resumed = scene([...facts, demand, busy], null, AVANCE);
    assert.equal(resumed.arret, null);
    assert.deepEqual(beamsOf(resumed), [`demande:vous>${ROOT}`]);
  });

  it("seule la cause « arret » fige : plafond, non-contrôle et interrompue ne figent rien", () => {
    for (const cause of ["plafond", "non-controle", "interrompue"]) {
      const facts = [...p6.slice(0, iAbort), { ...stopFact(p6[iAbort]?.at ?? 0), data: { cause } }, ...p6.slice(iAbort)];
      const atStop = scene(facts.slice(0, iAbort + 1), null, AVANCE);
      assert.equal(atStop.arret, null, cause);
      assert.ok(atStop.faisceaux.every((b) => !b.fige), cause);
      assert.deepEqual(scene(facts, null, AVANCE).faisceaux, [], cause);
    }
  });

  it("réponse terminée normalement, puis nouvelle demande arrêtée avant de commencer : seule la nouvelle demande est figée", () => {
    const st = new Story();
    st.demande("msg_d1");
    st.occupee(R);
    st.delegate(R, "call_1", "msg_a", "ses_1", "zeta");
    st.repos("ses_1");
    st.resultat(R, "call_1", "ses_1", "rendu");
    st.repos(R);
    st.demande("msg_d2");
    st.arret();
    const s = scene(st.facts, null, AVANCE);
    assert.deepEqual(beamsOf(s), [`demande:vous>${R}:fige`]);
    assert.equal(s.faisceaux[0]?.id, "demande:msg_d2");
  });

  it("arrêt sans réponse en cours ni réponse interrompue : signalé, rien de figé ; sans assistant, l'arrêt reste signalé", () => {
    const facts = [...replay("p1-delegation-parallele.jsonl")];
    facts.push(stopFact((facts.at(-1)?.at ?? 0) + 1));
    const s = scene(facts, null, AVANCE);
    assert.deepEqual(s.arret?.faits, [facts.length - 1]);
    assert.deepEqual(s.faisceaux, []);
    const alone = scene([stopFact(5)], null, AVANCE);
    assert.deepEqual(alone.arret?.faits, [0]);
    assert.deepEqual(alone.noeuds, []);
  });
});

describe("signes : attente, décisions, terminé, échec, origine", () => {
  it("décision : bouclier pour « auto », croix pour un refus, rien pour « attente » ni « non-controle » ; la dernière remplace la précédente ; effacée à la fin", () => {
    const st = new Story();
    st.demande("msg_d");
    st.occupee(R);
    st.attente(R, "per_1", "call_1", "bash");
    const auto = st.decision(R, "per_1", "auto", "A-grep");
    let s = scene(st.facts, null, AVANCE);
    assert.deepEqual(s.decisions.map((d) => [d.signe, d.regle, d.permissionId, d.faits]), [["auto", "A-grep", "per_1", [auto]]]);
    assert.deepEqual(s.decisions[0]?.position, nodeOf(s, R)?.position);
    st.reponse(R, "per_1", "once");
    st.attente(R, "per_2", "call_2", "bash");
    st.decision(R, "per_2", "attente");
    st.decision(R, "per_2", "non-controle");
    s = scene(st.facts, null, AVANCE);
    assert.deepEqual(s.decisions.map((d) => [d.signe, d.faits]), [["auto", [auto]]], "attente et non-controle ne dessinent rien");
    assert.equal(s.attentes.length, 1);
    const refus = st.decision(R, "per_2", "refus-auto", "B01");
    s = scene(st.facts, null, AVANCE);
    assert.deepEqual(s.decisions.map((d) => [d.signe, d.faits]), [["refus", [refus]]]);
    st.decision(R, "per_3", "refus-interdit");
    assert.deepEqual(scene(st.facts, null, AVANCE).decisions.map((d) => d.signe), ["refus"]);
    assert.equal(NEON_GRAMMAIRE.auto.forme, "bouclier-coche");
    assert.equal(NEON_GRAMMAIRE.refus.forme, "croix");
    st.repos(R);
    s = scene(st.facts, null, AVANCE);
    assert.deepEqual([s.decisions, s.attentes], [[], []]);
  });

  it("terminé, échec et arrêté : résultat rendu, en échec ou interrompu ; erreur de l'assistant ; un repos ne masque ni l'échec ni l'arrêt", () => {
    const st = new Story();
    st.demande("msg_d");
    st.occupee(R);
    for (const [call, child] of [["call_1", "ses_ok"], ["call_2", "ses_ko"], ["call_3", "ses_stop"], ["call_4", "ses_err"]] as const) st.delegate(R, call, "msg_a", child, "zeta");
    st.repos("ses_ok");
    st.resultat(R, "call_1", "ses_ok", "rendu");
    st.resultat(R, "call_2", "ses_ko", "echec");
    st.resultat(R, "call_3", "ses_stop", "interrompu");
    st.erreur("ses_err", "ProviderAuthError");
    st.repos("ses_err");
    const s = scene(st.facts, null, AVANCE);
    assert.deepEqual(
      s.noeuds.map((n) => [n.sessionId, n.etat]),
      [[R, "travaille"], ["ses_ok", "termine"], ["ses_ko", "echec"], ["ses_stop", "arrete"], ["ses_err", "echec"]],
    );
    // Résultat bleu pour « rendu » et « échec », aucun pour « interrompu » (sa consigne se ferme) ; la consigne de l'enfant en erreur
    // reste tant que la conversation n'a pas reçu son résultat.
    assert.deepEqual(s.faisceaux.filter((b) => b.kind === "resultat").map((b) => b.de), ["ses_ok", "ses_ko"]);
    assert.deepEqual(s.faisceaux.filter((b) => b.kind === "consigne").map((b) => b.vers), ["ses_err"]);
    // Une nouvelle réponse après l'échec, puis un repos : terminé.
    st.occupee("ses_err");
    st.repos("ses_err");
    assert.equal(nodeOf(scene(st.facts, null, AVANCE), "ses_err")?.etat, "termine");
  });

  it("marques d'origine : la dernière de chaque assistant ; « demande » et « consigne » n'en font pas ; origine inconnue dite inconnue", () => {
    const p2 = scene(replay("p2-commande-subtask.jsonl"), null, AVANCE);
    assert.deepEqual(p2.origines.map((o) => [o.sessionId, o.origine, o.cas]), [[ROOT, "interne-opencode", 6]]);
    // p1 sans la liste des messages envoyés : la demande n'est pas crue, aucun faisceau « Vous », origine non identifiée.
    const steps = live("p1-delegation-parallele.jsonl", new Set());
    const s = scene(steps.at(-1)?.facts ?? [], null, AVANCE);
    assert.deepEqual(s.origines.map((o) => [o.sessionId, o.origine, o.cas]), [[ROOT, "origine-inconnue", 7]]);
    for (const step of steps) assert.ok(scene(step.facts, null, AVANCE).faisceaux.every((b) => b.kind !== "demande"));
    const st = new Story();
    st.add(R, "origine", { origine: "interne-opencode", cas: 6, messageId: "msg_1" }, "msg_1");
    const last = st.add(R, "origine", { origine: "origine-inconnue", cas: 7, messageId: "msg_2" }, "msg_2");
    st.add(R, "origine", { origine: "consigne", cas: 3, messageId: "msg_3" }, "msg_3");
    assert.deepEqual(scene(st.facts, null, AVANCE).origines.map((o) => [o.origine, o.faits]), [["origine-inconnue", [last]]]);
  });
});

describe("zoom 3 : outils, tuiles de fichiers et panneau (§5.7.4)", () => {
  const facts = replay("p1-delegation-parallele.jsonl");

  it("p1, second enfant : lectures et recherches comptées, tuiles lues groupées par dossier, consigne reçue et résultat rendu", () => {
    const s = scene(facts, null, { zoom: 3, mode: "avance", focus: P1_E2 });
    const d = s.detail;
    assert.ok(d);
    assert.deepEqual(d.outils.map((o) => o.categorie), [...NEON_OUTILS]);
    assert.deepEqual(d.outils.map((o) => [o.categorie, o.enCours, o.termines, o.echecs]), [
      ["lire", 0, 4, 0],
      ["chercher", 0, 1, 0],
      ["modifier", 0, 0, 0],
      ["commande", 0, 0, 0],
      ["confier", 0, 0, 0],
      ["question", 0, 0, 0],
    ]);
    assert.deepEqual(
      d.dossiers.map((f) => [f.dossier, f.colonne, f.tuiles.map((tile) => [tile.fichier, tile.lu, tile.modifie, tile.refuse, tile.enCours, tile.position.x, tile.position.y])]),
      [
        ["2a0c975ea951efdf", 0, [["c1a2c0efeaf5d6e4", true, false, false, false, 230, 28]]],
        [
          "c1a2c0efeaf5d6e4",
          1,
          [
            ["87d1e3880ce7b8d9", true, false, false, false, 294, 28],
            ["c1cc61afe5e580b0", true, false, false, false, 294, 54],
            ["90f2edb224bdfc3f", true, false, false, false, 294, 80],
          ],
        ],
      ],
    );
    const consigne = facts.findIndex((f) => f.sessionId === P1_E2 && f.kind === "origine");
    const resultat = facts.findIndex((f) => f.kind === "resultat" && f.data.enfant === P1_E2);
    const reponse = facts.findIndex((f) => f.sessionId === P1_E2 && f.data.etat === "redige");
    assert.deepEqual(d.panneau.consigne?.faits, [consigne]);
    assert.deepEqual(d.panneau.resultat, { callId: "call_397a867685754eee8591b009", etat: "rendu", faits: [resultat] });
    assert.deepEqual(d.panneau.reponse?.faits, [reponse]);
    assert.equal(d.panneau.actions.termines, 5);
  });

  it("p1, conversation : « confier » compte les deux délégations rendues ; la consigne reçue est votre demande", () => {
    const d = scene(facts, null, { zoom: 3, mode: "avance" }).detail;
    assert.deepEqual(d?.outils.find((o) => o.categorie === "confier"), {
      categorie: "confier",
      position: d?.outils[4]?.position,
      enCours: 0,
      termines: 2,
      echecs: 0,
      interrompus: 0,
      faits: facts.flatMap((f, i) => (f.sessionId === ROOT && (f.kind === "resultat" || (f.kind === "consigne" && f.data.etat === "envoyee")) ? [i] : [])),
    });
    assert.deepEqual(d?.panneau.consigne?.faits, [facts.findIndex((f) => f.kind === "origine" && f.data.origine === "demande")]);
    assert.equal(d?.panneau.resultat, null);
    // Pendant le travail des enfants : deux délégations en cours.
    const iBusy = facts.findIndex((f) => f.sessionId === P1_E2 && f.data.etat === "occupee");
    assert.equal(scene(facts.slice(0, iBusy + 1), null, { zoom: 3, mode: "avance" }).detail?.outils[4]?.enCours, 2);
  });

  it("fichier modifié, refusé (réponse « reject » ou décision de refus), en cours ; dossiers et tuiles au-delà du dessin comptés", () => {
    const st = new Story();
    st.demande("msg_d");
    st.occupee(R);
    st.outil(R, "call_m1", "modifier", "en-cours", "f1", "d1");
    st.outil(R, "call_m1", "modifier", "termine", "f1", "d1");
    const ask2 = st.attente(R, "per_2", "call_m2", "edit");
    const reject = st.reponse(R, "per_2", "reject");
    const err2 = st.outil(R, "call_m2", "modifier", "erreur", "f2", "d1");
    const ask3 = st.attente(R, "per_3", "call_m3", "edit");
    const refus = st.decision(R, "per_3", "refus-auto", "E2");
    const err3 = st.outil(R, "call_m3", "modifier", "erreur", "f3", "d1");
    st.outil(R, "call_l1", "lire", "en-cours", "f4", "d1");
    st.outil(R, "call_q", "question", "termine");
    st.outil(R, "call_t", "autre", "termine");
    st.outil(R, "call_i", "commande", "interrompu");
    for (const j of [2, 3, 4, 5, 6]) st.outil(R, `call_d${j}`, "lire", "termine", `g${j}`, `d${j}`);
    for (const j of [1, 2, 3, 4, 5, 6, 7, 8]) st.outil(R, `call_e${j}`, "lire", "termine", `h${j}`, "d2");
    const d = scene(st.facts, null, { zoom: 3, mode: "avance" }).detail;
    assert.ok(d);
    assert.deepEqual(
      d.dossiers[0]?.tuiles.map((tile) => [tile.fichier, tile.lu, tile.modifie, tile.refuse, tile.enCours]),
      [
        ["f1", false, true, false, false],
        ["f2", false, false, true, false],
        ["f3", false, false, true, false],
        ["f4", false, false, false, true],
      ],
    );
    assert.deepEqual(d.dossiers[0]?.tuiles[1]?.faits, [ask2, reject, err2]);
    assert.deepEqual(d.dossiers[0]?.tuiles[2]?.faits, [ask3, refus, err3]);
    assert.deepEqual(d.dossiers.map((f) => [f.dossier, f.tuiles.length, f.enPlus]), [["d1", 4, 0], ["d2", 7, 2], ["d3", 1, 0], ["d4", 1, 0], ["d5", 1, 0]]);
    assert.equal(d.dossiersEnPlus, 1);
    assert.deepEqual(
      d.outils.map((o) => [o.categorie, o.enCours, o.termines, o.echecs, o.interrompus]),
      [
        ["lire", 1, 13, 0, 0],
        ["chercher", 0, 0, 0, 0],
        ["modifier", 0, 1, 2, 0],
        ["commande", 0, 0, 0, 1],
        ["confier", 0, 0, 0, 0],
        ["question", 0, 1, 0, 0],
      ],
    );
    assert.deepEqual([d.autresOutils.termines, d.panneau.actions.termines], [1, 16]);
  });
});

describe("honnêteté du dessin (P12) : aucun signe sans fait", () => {
  it("p1, p2, p6 et p7 : à chaque pas du direct, chaque signe référence des faits visibles de la conversation, de la bonne session", () => {
    for (const name of CAPTURES) {
      for (const step of live(name)) {
        for (const options of ALL_OPTIONS) assertHonest(scene(step.facts, null, options), step.facts, step.facts.length, `${name} ${JSON.stringify(options)}`);
      }
    }
  });

  it("histoires synthétiques (arrêt, décisions, zoom 3) : chaque signe référence ses faits", () => {
    const p6 = replay("p6-arret-global.jsonl");
    const withStop: ActivityFact[] = [...p6, { rootId: ROOT, sessionId: ROOT, kind: "statut", ref: null, data: { cause: "arret" }, at: (p6.at(-1)?.at ?? 0) + 1 }];
    const st = new Story();
    st.demande("msg_d");
    st.occupee(R);
    st.delegate(R, "call_1", "msg_a", "ses_1", "zeta");
    st.attente("ses_1", "per_1", "call_x", "edit");
    st.decision("ses_1", "per_1", "refus-auto");
    st.outil("ses_1", "call_x", "modifier", "erreur", "f1", "d1");
    st.add("ses_1", "statut", { etat: "taches", faites: 1, total: 3 });
    st.add("ses_1", "statut", { etat: "memoire-resumee" });
    st.add("ses_1", "statut", { etat: "appel-fini", messageId: "msg_z", cout: 0.1, raison: "stop" }, "msg_z");
    for (const facts of [withStop, st.facts]) {
      for (let k = 0; k <= facts.length; k++) {
        for (const options of [...ALL_OPTIONS, { zoom: 3 as const, mode: "avance" as const, focus: "ses_1" }]) {
          assertHonest(scene(facts.slice(0, k), null, options), facts, k, `k=${k} ${JSON.stringify(options)}`);
        }
      }
    }
  });

  it("sans fait d'activité, aucun signe : liste vide, faits d'affichage, de choix, de carnet, de détection, de réveil ou de reprise ; autre conversation ignorée", () => {
    const empty = scene([], null, AVANCE);
    assert.deepEqual([empty.noeuds, empty.faisceaux, empty.attentes, empty.decisions, empty.impulsions, empty.origines, empty.arret, empty.detail], [[], [], [], [], [], [], null, null]);
    assert.deepEqual(empty.carnet, { vide: true, tuiles: [] });
    assert.deepEqual(empty.stations.map((st) => st.id).sort(), ["carnet", "copilot", "vous"]);
    assert.deepEqual(empty.secteurs.map((s) => s.id), [...NEON_SECTEURS]);
    const st = new Story();
    for (const kind of ["affichage", "choix", "carnet", "detection", "reveil", "reprise"] as const) st.add(R, kind, { etat: "x" });
    for (const options of ALL_OPTIONS) {
      const s = scene(st.facts, null, options);
      assert.deepEqual([s.noeuds, s.faisceaux, s.origines, s.detail?.dossiers ?? []], [[], [], [], []]);
      assert.deepEqual(s.carnet, { vide: true, tuiles: [] });
    }
    // Faits d'une autre conversation après la première : ignorés. Une demande sur un enfant : aucun faisceau.
    const mixed = new Story();
    mixed.demande("msg_d");
    mixed.occupee(R);
    mixed.facts.push({ rootId: "ses_autre", sessionId: "ses_autre", kind: "origine", ref: "msg_o", data: { origine: "demande", cas: 1, messageId: "msg_o" }, at: 5_000 });
    mixed.facts.push({ rootId: "ses_autre", sessionId: "ses_autre", kind: "statut", ref: null, data: { etat: "occupee" }, at: 5_001 });
    // Même identifiant de session rangé sous une autre conversation : ignoré aussi.
    mixed.facts.push({ rootId: "ses_autre", sessionId: R, kind: "origine", ref: "msg_p", data: { origine: "demande", cas: 1, messageId: "msg_p" }, at: 5_002 });
    mixed.delegate(R, "call_1", "msg_a", "ses_1", "zeta");
    mixed.add("ses_1", "origine", { origine: "demande", cas: 1, messageId: "msg_e" }, "msg_e");
    const s = scene(mixed.facts, null, AVANCE);
    assert.deepEqual(s.noeuds.map((n) => n.sessionId), [R, "ses_1"]);
    assert.deepEqual(beamsOf(s), [`demande:vous>${R}`, `consigne:${R}>ses_1`]);
    // Faits mal formés : ignorés sans erreur, en tête (la conversation est celle du premier fait valide) comme en queue.
    const junk = [null, 3, { rootId: "ses_x" }, { rootId: "ses_x", sessionId: "ses_x", kind: "statut", data: null, at: 1 }] as unknown as ActivityFact[];
    assert.deepEqual(scene([...mixed.facts, ...junk], null, AVANCE), s);
    const shifted = scene([...junk, ...mixed.facts], null, AVANCE);
    assert.equal(shifted.rootId, R);
    assert.deepEqual(beamsOf(shifted), beamsOf(s));
    assert.deepEqual(shifted.noeuds.map((n) => n.faits.map((i) => i - junk.length)), s.noeuds.map((n) => n.faits));
  });
});

describe("pureté des modules néon", () => {
  it("ni module node, ni process, ni horloge, ni aléa, ni réseau ; imports voisins seulement", () => {
    for (const file of ["neon-scene.ts", "neon-palette.ts", "neon-texts.ts"]) {
      const source = fs.readFileSync(path.join(import.meta.dirname, "shared", file), "utf8");
      assert.equal(source.includes('"node:'), false, file);
      assert.equal(/\bprocess\./.test(source), false, file);
      assert.equal(/\bDate\.now\b|new Date\b|Math\.random|\bfetch\s*\(|\bsetTimeout\b|\bsetInterval\b|\bperformance\.|\bcrypto\./.test(source), false, file);
      const imports = [...source.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1] ?? "");
      for (const spec of imports) assert.match(spec, /^\.\/[\w.-]+\.ts$/, `${file} : ${spec}`);
      assert.equal(/^\s*import (?!type\b)/m.test(source), false, `${file} : import de valeur`);
    }
  });

  it("même entrée, même scène ; la liste des faits n'est jamais modifiée", () => {
    const facts = replay("p1-delegation-parallele.jsonl");
    const frozen = facts.map((f) => Object.freeze({ ...f, data: Object.freeze({ ...f.data }) }));
    Object.freeze(frozen);
    const copy = JSON.stringify(frozen);
    for (const options of ALL_OPTIONS) {
      assert.deepEqual(scene(frozen, null, options), scene(facts, null, options));
      assert.deepEqual(scene(frozen, frozen[20]?.at ?? 0, options), scene(frozen, frozen[20]?.at ?? 0, options));
    }
    assert.equal(JSON.stringify(frozen), copy);
  });
});

describe("textes de la carte (neon-texts.ts)", () => {
  it("chaque secteur, outil, station, état, signe et origine dessinés a son libellé ; la salle et l'extension absentes du mode Simple", () => {
    for (const secteur of NEON_SECTEURS) assert.ok(libelleSecteur(secteur).length > 0);
    for (const outil of [...NEON_OUTILS, "autres" as const]) assert.ok(libelleOutil(outil).length > 0);
    for (const station of ["vous", "copilot", "carnet"] as NeonStationId[]) assert.ok(libelleStation(station).length > 0);
    const etats: NeonNodeState[] = ["pas-commence", "travaille", "attente-accord", "termine", "echec", "arrete"];
    assert.deepEqual(etats.map(libelleEtat), ["pas encore commencé", "travaille", "en attente de votre accord", "terminé", "échec", "arrêté"]);
    for (const signe of Object.keys(NEON_GRAMMAIRE) as NeonSign[]) {
      assert.ok((libelleSigne(signe, "avance") ?? "").length > 0, signe);
      assert.equal(libelleSigne(signe, "simple") === null, signe === "extension", signe);
    }
    const origines: NeonMarkedOrigin[] = ["cockpit", "reveil-sans-reponse", "relance-extension", "interne-extension", "interne-opencode", "origine-inconnue"];
    for (const origine of origines) {
      assert.ok((libelleOrigine(origine, "avance") ?? "").length > 0, origine);
      assert.equal(libelleOrigine(origine, "simple") === null, ["reveil-sans-reponse", "relance-extension", "interne-extension"].includes(origine), origine);
    }
    assert.equal(libelleOrigine("origine-inconnue", "simple"), "Message non écrit par vous (origine non identifiée)");
    assert.equal(TEXTES.simple.resume, "Une seule IA travaille sur cette demande.");
    assert.equal(TEXTES.simple.demonstration, "Voir une démonstration : deux assistants en même temps");
    assert.equal(TEXTES.partout.commandes.figer, "Figer l'affichage (le travail continue)");
    assert.equal(TEXTES.partout.rattrape, "Affichage rattrapé");
    assert.equal(TEXTES.partout.demonstrationEnregistree, "Démonstration enregistrée : aucune IA n'est appelée");
    assert.deepEqual([titreBande("simple"), titreBande("avance")], ["Travail en direct", "Carte des agents en direct"]);
    assert.deepEqual([carnetVide("simple"), carnetVide("avance")], ["Vide pour cette conversation.", "Vide hors de la Salle OMO."]);
    assert.ok(!JSON.stringify(TEXTES.simple).includes("OMO"));
  });

  it("gabarits « {nom} » : remplis par valeur, un nom absent reste visible", () => {
    assert.equal(remplir(TEXTES.partout.taches, { faites: 4, total: 7 }), "Tâches : 4/7");
    assert.equal(remplir(TEXTES.partout.tentative, {}), "nouvelle tentative ({n})");
    assert.equal(remplir("{a}{a}", { a: "{a}" }), "{a}{a}");
    assert.equal(libelleBouton(null, "attente-accord"), "Assistant de la conversation, en attente de votre accord");
    assert.equal(libelleBouton("analyste-journaux", "termine"), "analyste-journaux, terminé");
  });
});
