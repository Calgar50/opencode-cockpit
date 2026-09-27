// Scène néon pure (spécification §5.7.1, §5.7.3, §5.7.4, P12, JP-8, JP-13 ; plan d'exécution, fiche L5a) : positions jamais
// réorganisées ; mode Simple à un seul assistant ; aucune taille liée à une grandeur ; « différé = direct » sur p1 ; faisceaux
// figés sur `statut {cause: arret}` ; attente, décisions, terminé, échec ; zoom 3 ; honnêteté du dessin (chaque signe référence
// des faits) ; textes de la carte ; pureté.
// Salle OMO (fiche L25b) : enceinte (mode Avancé, statique), rôles par clé (T-L25-f), tâche de fond (JP-3), réveil (JP-2),
// actions de l'extension, carnet partagé (JP-6), métadonnées JP-7 et leur échappement dans NeonBand.tsx (rendu serveur React du
// vrai composant, transformé par vite sans rien écrire), bornes de l'arbre dessiné, orange du script JP-14.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { ACTIVITY_MAX_DEPTH, ACTIVITY_MAX_SESSIONS } from "./shared/activity.ts";
import { dedupeFacts, EventMemory, type FactContext, FactDeduper, type FactEvent, factsFromEvent, type FactSession, mergeFacts } from "./shared/activity-facts.ts";
import type { ActivityFact, ActivityFactKind, FactValue } from "./shared/activity-types.ts";
import {
  colorDistance,
  contrastRatio,
  NEON_DECOR,
  NEON_GRAMMAIRE,
  NEON_MEME_FORME_SALLE,
  NEON_PALETTES,
  NEON_SIGNE_FAISCEAU,
  type NeonSign,
  type NeonTheme,
  neonColorProblems,
  paletteProblems,
  SEUIL_ECART,
  SEUIL_TRAIT,
  VISIONS,
} from "./shared/neon-palette.ts";
import {
  moments,
  NEON_CADRE,
  NEON_CARNET_TUILES,
  NEON_OUTILS,
  NEON_PLACES,
  NEON_PROFONDEUR_MAX,
  NEON_SECTEURS,
  NEON_SESSIONS_MAX,
  NEON_TAILLES,
  type NeonConsigneSalle,
  type NeonMarkedOrigin,
  type NeonNodeState,
  type NeonScene,
  type NeonSceneOptions,
  type NeonSector,
  type NeonStationId,
  scene,
  visibleCount,
} from "./shared/neon-scene.ts";
import { type OmoRole, roleDeAgent } from "./shared/omo-roles.ts";
import { TEXTES as OMO_TEXTES } from "./shared/omo-room-texts.ts";
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
/** Faits que seule la Salle OMO écrit : l'un d'eux justifie l'enceinte. */
const SALLE_OPENERS: readonly ActivityFactKind[] = ["statut", "consigne", "carnet", "reveil", "origine", "decision"];
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
  // Salle OMO (L25b) : enceinte, boucles de l'extension, tuiles et liens du carnet, métadonnées de la consigne.
  if (s.enceinte) out.push({ quoi: "enceinte", sessions: [], premier: SALLE_OPENERS, faits: s.enceinte.faits });
  for (const e of s.extensions) out.push({ quoi: `extension ${e.sessionId}`, sessions: [e.sessionId], premier: ["decision"], faits: e.faits });
  for (const t of s.carnet.tuiles) out.push({ quoi: `carnet ${t.fichier}`, sessions: t.sessions, premier: ["carnet"], faits: t.faits });
  for (const l of s.carnet.liens) out.push({ quoi: `lien du carnet ${l.sessionId}`, sessions: [l.sessionId], premier: ["carnet"], faits: l.faits });
  if (s.detail?.panneau.metadonnees) out.push({ quoi: "panneau métadonnées", sessions: [], premier: ["consigne"], faits: s.detail.panneau.metadonnees.faits });
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

  it("arrêt pendant une attente d'accord (refus, sans MessageAbortedError) : la réponse close depuis le début de l'arrêt est figée, l'assistant « arrete » ; close avant, ou refus seul : « termine », rien de figé", () => {
    const waiting = () => {
      const st = new Story();
      st.demande("msg_d1");
      st.occupee(R);
      st.outil(R, "call_b", "commande", "en-cours");
      st.attente(R, "per_b", "call_b", "bash");
      return st;
    };
    const refuse = (st: Story) => {
      st.reponse(R, "per_b", "reject");
      st.outil(R, "call_b", "commande", "erreur");
      return st.repos(R);
    };
    const st = waiting();
    const debut = (st.facts.at(-1)?.at ?? 0) + 5;
    const idle = refuse(st);
    const stop = st.add(R, "statut", { cause: "arret", motif: "vous", nonConfirmees: 0, debut });
    const s = scene(st.facts, null, AVANCE);
    assert.deepEqual(s.arret?.faits, [stop]);
    assert.deepEqual(beamsOf(s), [`demande:vous>${R}:fige`]);
    assert.equal(s.faisceaux[0]?.fin, "repos");
    assert.deepEqual([nodeOf(s, R)?.etat, nodeOf(s, R)?.depuis, nodeOf(s, R)?.faits], ["arrete", st.facts[idle]?.at, [0, idle, stop]]);
    assertHonest(s, st.facts, st.facts.length, "arrêt pendant une attente");
    assert.deepEqual(beamsOf(scene(st.facts, null, SIMPLE)), [`demande:vous>${R}:fige`]);
    assert.equal(nodeOf(scene(st.facts, null, SIMPLE), R)?.etat, "arrete");
    // Avant le fait d'arrêt : la réponse est « terminée », rien de figé.
    assert.deepEqual([nodeOf(scene(st.facts.slice(0, stop), null, AVANCE), R)?.etat, scene(st.facts.slice(0, stop), null, AVANCE).faisceaux], ["termine", []]);

    // Réponse close avant le début de l'arrêt : arrêt signalé, rien de figé, « termine ».
    const late = waiting();
    const lateIdle = refuse(late);
    const lateStop = late.add(R, "statut", { cause: "arret", motif: "vous", nonConfirmees: 0, debut: (late.facts[lateIdle]?.at ?? 0) + 5 });
    const ls = scene(late.facts, null, AVANCE);
    assert.deepEqual([ls.arret?.faits, ls.faisceaux, nodeOf(ls, R)?.etat], [[lateStop], [], "termine"]);
    // Témoin : « Refuser » sans message, sans arrêt.
    const alone = waiting();
    refuse(alone);
    const as = scene(alone.facts, null, AVANCE);
    assert.deepEqual([as.arret, as.faisceaux, nodeOf(as, R)?.etat], [null, [], "termine"]);
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
    assert.deepEqual(empty.carnet, { vide: true, tuiles: [], liens: [] });
    assert.deepEqual(empty.stations.map((st) => st.id).sort(), ["carnet", "copilot", "vous"]);
    assert.deepEqual(empty.secteurs.map((s) => s.id), [...NEON_SECTEURS]);
    const st = new Story();
    for (const kind of ["affichage", "choix", "carnet", "detection", "reveil", "reprise"] as const) st.add(R, kind, { etat: "x" });
    for (const options of ALL_OPTIONS) {
      const s = scene(st.facts, null, options);
      assert.deepEqual([s.noeuds, s.faisceaux, s.origines, s.detail?.dossiers ?? []], [[], [], [], []]);
      assert.deepEqual(s.carnet, { vide: true, tuiles: [], liens: [] });
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
      assert.equal(libelleSigne(signe, "simple") === null, signe === "extension" || signe === "enceinte", signe);
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

// --- Salle OMO (fiche L25b) ---------------------------------------------------------------------------------------------------------

/** Les secteurs de la carte sont les rôles de la salle : un rôle ajouté d'un seul côté ne compile plus. */
type Memes<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const SECTEURS_EGAUX_ROLES: Memes<NeonSector, OmoRole> = true;

/** Histoire d'une conversation de la Salle OMO : racine et assistants de l'instance `omo`, consignes à métadonnées (L25a). */
class SalleStory extends Story {
  racine(agent = "sisyphus") {
    return this.add(this.rootId, "statut", { etat: "creee", role: "conversation", parent: null, agent, instance: "omo" });
  }
  creeeSalle(sessionId: string, parent: string, agent: string | null) {
    return this.add(sessionId, "statut", { etat: "creee", role: "delegation", parent, agent, instance: "omo" });
  }
  envoyeeSalle(parent: string, callId: string, messageId: string | null, enfant: string, agent: string | null, meta: Record<string, FactValue>) {
    return this.add(parent, "consigne", { etat: "envoyee", callId, messageId, enfant, agent, source: "ia", commande: null, reprise: false, ...meta }, callId);
  }
  /** Préparation, création, envoi avec métadonnées, puis l'enfant se met au travail. */
  delegueSalle(parent: string, callId: string, messageId: string, enfant: string, agent: string, meta: Record<string, FactValue>) {
    this.prepare(parent, callId, messageId);
    this.creeeSalle(enfant, parent, agent);
    this.envoyeeSalle(parent, callId, messageId, enfant, agent, meta);
    return this.occupee(enfant);
  }
  carnet(sessionId: string, callId: string, etat: string, chemin: string, fichier: string) {
    return this.add(sessionId, "carnet", { etat, chemin, fichier, dossier: "00000000000000d0", callId, messageId: "msg_c" }, callId);
  }
  extension(sessionId: string, callId: string, verdict = "auto") {
    return this.add(sessionId, "decision", { verdict, regle: "A-grep", par: "extension" }, callId);
  }
}

const SALLE: NeonSceneOptions = { zoom: 2, mode: "avance", roleSalle: roleDeAgent };
const META_FOND = { categorie: "quick", ia: "github-copilot/claude-sonnet-4.5", competences: 2, fond: true };
const META_ATTEND = { categorie: "deep", ia: "github-copilot/gpt-5.6-luna", competences: 1, fond: false };

describe("Salle OMO : enceinte (JP-10, JP-13)", () => {
  it("dès le premier fait propre à la salle, en mode Avancé seulement ; jamais hors de la salle ni sur un fait mal formé", () => {
    const st = new SalleStory();
    st.demande("msg_d");
    st.occupee(R);
    const racine = st.racine();
    st.repos(R);
    assert.equal(scene(st.facts.slice(0, racine), null, SALLE).enceinte, null, "avant le fait de la salle : aucune enceinte");
    assert.deepEqual(scene(st.facts, null, SALLE).enceinte, { depuis: st.facts[racine]?.at, faits: [racine] });
    assert.equal(scene(st.facts, null, { ...SALLE, mode: "simple" }).enceinte, null, "salle réservée au mode Avancé");
    // Chaque fait que seule la salle écrit suffit ; le même fait ailleurs ou mal formé, jamais.
    const seul = (kind: ActivityFactKind, data: Record<string, FactValue>, sessionId = R) => {
      const s = new Story();
      s.demande("msg_d");
      s.add(sessionId, kind, data, "ref_1");
      return scene(s.facts, null, SALLE).enceinte?.faits ?? null;
    };
    assert.deepEqual(seul("statut", { etat: "creee", role: "conversation", parent: null, agent: null, instance: "omo" }), [1]);
    assert.deepEqual(seul("consigne", { etat: "envoyee", callId: "c", messageId: "m", enfant: "ses_e", agent: null, fond: false }), [1]);
    assert.deepEqual(seul("carnet", { etat: "lu", chemin: ".omo/plans/p.md", fichier: "0123456789abcdef" }), [1]);
    assert.deepEqual(seul("reveil", { etat: "depose", messageId: "m" }), [1]);
    assert.deepEqual(seul("origine", { origine: "relance-extension", cas: 5, messageId: "m" }), [1]);
    assert.deepEqual(seul("decision", { verdict: "auto", regle: "A-grep", par: "extension" }), [1]);
    for (const [kind, data] of [
      ["statut", { etat: "creee", role: "conversation", parent: null, agent: null, instance: "principale" }],
      ["consigne", { etat: "envoyee", callId: "c", messageId: "m", enfant: "ses_e", agent: null }],
      ["carnet", { etat: "x" }],
      ["carnet", { etat: "lu", chemin: ".omo/plans/../../secret", fichier: "0123456789abcdef" }],
      ["reveil", { etat: "x" }],
      ["origine", { origine: "origine-inconnue", cas: 7, messageId: "m" }],
      ["decision", { verdict: "auto", regle: "E1", par: "regles" }],
    ] as const) {
      assert.equal(seul(kind, data), null, `${kind} ${JSON.stringify(data)}`);
    }
    // Les captures de l'instance principale n'ont jamais d'enceinte.
    for (const name of CAPTURES) for (const options of ALL_OPTIONS) assert.equal(scene(replay(name), null, options).enceinte, null, name);
  });

  it("statique : la même enceinte à chaque fait suivant (aucune heure qui avance, aucune clé qui change)", () => {
    const st = new SalleStory();
    const racine = st.racine();
    st.demande("msg_d");
    st.occupee(R);
    st.delegueSalle(R, "call_1", "msg_a", "ses_1", "explore", META_FOND);
    st.repos(R);
    st.repos("ses_1");
    const premiere = scene(st.facts.slice(0, racine + 1), null, SALLE).enceinte;
    for (let k = racine + 1; k <= st.facts.length; k++) assert.deepEqual(scene(st.facts.slice(0, k), null, SALLE).enceinte, premiere, `k=${k}`);
  });
});

describe("Salle OMO : rôles par clé de configuration (T-L25-f)", () => {
  it("secteur lu par la clé (casse ignorée) dans la salle ; inconnu, « athena », « council-member » ou clé d'Object → Autres", () => {
    assert.equal(SECTEURS_EGAUX_ROLES, true);
    const agents = ["sisyphus", "oracle", "librarian", "momus", "sisyphus-junior", "OPENCODE-BUILDER", "athena", "council-member", "constructor", "__proto__", "explore"];
    const attendus: NeonSector[] = ["planifier", "conseiller", "chercher", "verifier", "executer", "executer", "autres", "autres", "autres", "autres", "chercher"];
    const st = new SalleStory();
    st.racine();
    st.demande("msg_d");
    st.occupee(R);
    agents.forEach((agent, i) => st.delegueSalle(R, `call_${i}`, `msg_${i}`, `ses_${i}`, agent, META_ATTEND));
    const s = scene(st.facts, null, SALLE);
    assert.deepEqual(
      agents.map((_, i) => nodeOf(s, `ses_${i}`)?.secteur),
      attendus,
    );
    // Hors de la salle, la même histoire garde les secteurs ordinaires (seul « explore » est rangé par opencode).
    const hors = new Story();
    hors.demande("msg_d");
    hors.occupee(R);
    agents.forEach((agent, i) => hors.delegate(R, `call_${i}`, `msg_${i}`, `ses_${i}`, agent));
    const h = scene(hors.facts, null, SALLE);
    assert.deepEqual(
      agents.map((_, i) => nodeOf(h, `ses_${i}`)?.secteur),
      agents.map((agent) => (agent === "explore" ? "chercher" : "autres")),
    );
    // Sans `roleSalle`, la salle garde les secteurs ordinaires ; une réponse qui n'est pas un secteur vaut « autres ».
    assert.equal(nodeOf(scene(st.facts, null, { zoom: 2, mode: "avance" }), "ses_0")?.secteur, "autres");
    assert.equal(nodeOf(scene(st.facts, null, { ...SALLE, roleSalle: () => "partout" }), "ses_10")?.secteur, "autres");
    // roleDeAgent (L20) rendait ce qu'Object hérite pour « constructor » (constat de L25b) ; corrigé au train de V4 : clés propres
    // de la table seulement. La scène garde sa propre garde (« partout » ci-dessus).
    for (const cle of ["constructor", "__proto__", "toString", "hasOwnProperty"]) assert.equal(roleDeAgent(cle), "autres", cle);
  });
});

describe("Salle OMO : tâche de fond (JP-3), réveil (JP-2) et actions de l'extension", () => {
  it("la consigne rose d'une tâche de fond reste tendue jusqu'à la fin de l'enfant, même au repos de celui qui l'a confiée ; le bleu part du résultat", () => {
    for (const fond of [true, false]) {
      const st = new SalleStory();
      st.racine();
      st.demande("msg_d");
      st.occupee(R);
      st.delegueSalle(R, "call_f", "msg_a", "ses_f", "explore", fond ? META_FOND : META_ATTEND);
      st.repos(R);
      const auRepos = scene(st.facts, null, SALLE);
      assert.deepEqual(beamsOf(auRepos), fond ? [`consigne:${R}>ses_f`] : [], `fond=${fond} : racine au repos`);
      assert.equal(nodeOf(auRepos, R)?.etat, "termine", "le vrai statut de la racine, jamais une attente supposée");
      if (!fond) continue;
      st.repos("ses_f");
      const resultat = st.resultat(R, "call_f", "ses_f", "rendu");
      const rendu = scene(st.facts, null, SALLE);
      assert.deepEqual(beamsOf(rendu), [`resultat:ses_f>${R}`], "le faisceau bleu part à la fin de l'enfant");
      assert.equal(rendu.faisceaux[0]?.faits[0], resultat);
      assert.equal(nodeOf(rendu, "ses_f")?.etat, "termine");
      // Réveil de la racine sans tour (JP-2) : ni impulsion, ni coût, ni reprise du travail ; seule la marque « résultat déposé ».
      const avant = scene(st.facts, null, SALLE);
      st.add(R, "origine", { origine: "reveil-sans-reponse", cas: 4, messageId: "msg_reveil" }, "msg_reveil");
      st.add(R, "reveil", { etat: "depose", messageId: "msg_reveil" }, "msg_reveil");
      const reveil = scene(st.facts, null, SALLE);
      assert.deepEqual(reveil.impulsions, []);
      assert.deepEqual([nodeOf(reveil, R)?.etat, nodeOf(reveil, R)?.dernierAppel], [nodeOf(avant, R)?.etat, nodeOf(avant, R)?.dernierAppel]);
      assert.deepEqual(
        reveil.origines.map((o) => [o.sessionId, o.origine]),
        [[R, "reveil-sans-reponse"]],
      );
      // Le prochain tour de la racine lit le résultat : le faisceau bleu s'éteint à la fin de ce tour.
      st.occupee(R);
      st.repos(R);
      assert.deepEqual(beamsOf(scene(st.facts, null, SALLE)), []);
    }
  });

  it("action de l'extension sans demande : boucle comptée par appel, gardée après le repos, jamais un bouclier ni une croix ; rien en mode Simple", () => {
    const st = new SalleStory();
    st.racine();
    st.demande("msg_d");
    st.occupee(R);
    st.delegueSalle(R, "call_1", "msg_a", "ses_1", "librarian", META_ATTEND);
    const a = st.extension("ses_1", "call_g");
    st.extension("ses_1", "call_g");
    const c = st.extension("ses_1", "call_h", "refus-interdit");
    st.repos("ses_1");
    const s = scene(st.facts, null, SALLE);
    assert.deepEqual(s.decisions, [], "le cockpit n'a rien décidé");
    assert.deepEqual(
      s.extensions.map((e) => [e.sessionId, e.actions, e.faits]),
      [["ses_1", 2, [a, a + 1, c]]],
    );
    assert.deepEqual(s.extensions[0]?.position, nodeOf(s, "ses_1")?.position);
    // Mode Simple : aucune boucle, même sur la conversation, seul assistant dessiné (salle réservée au mode Avancé).
    st.extension(R, "call_r");
    assert.deepEqual(
      scene(st.facts, null, SALLE).extensions.map((e) => e.sessionId),
      [R, "ses_1"],
    );
    assert.deepEqual(scene(st.facts, null, { ...SALLE, mode: "simple" }).extensions, []);
    // Une décision ordinaire du cockpit garde son bouclier.
    st.decision("ses_1", "per_1", "auto");
    assert.deepEqual(
      scene(st.facts, null, SALLE).decisions.map((d) => d.signe),
      ["auto"],
    );
  });

  it("carnet partagé et plans (JP-6) : une tuile par fichier, lue ou modifiée, reliée aux assistants dessinés ; au-delà de la rangée, comptée", () => {
    const st = new SalleStory();
    st.racine();
    st.demande("msg_d");
    st.occupee(R);
    st.delegueSalle(R, "call_1", "msg_a", "ses_1", "sisyphus-junior", META_ATTEND);
    const m = st.carnet("ses_1", "call_c1", "modifie", ".omo/notepads/plan/learnings.md", "00000000000000a1");
    const l = st.carnet(R, "call_c2", "lu", ".omo/notepads/plan/learnings.md", "00000000000000a1");
    st.carnet(R, "call_c3", "lu", ".omo/plans/plan.md", "00000000000000a2");
    st.carnet(R, "call_c4", "lu", ".omo/plans/../../../etc/passwd", "00000000000000a3");
    for (let i = 0; i < NEON_CARNET_TUILES; i++) st.carnet(R, `call_d${i}`, "lu", `.omo/plans/p${i}.md`, `00000000000000b${i}`);
    const s = scene(st.facts, null, SALLE);
    assert.equal(s.carnet.vide, false);
    assert.deepEqual(
      s.carnet.tuiles.slice(0, 2).map((t) => [t.chemin, t.lu, t.modifie, t.sessions, t.faits]),
      [
        [".omo/notepads/plan/learnings.md", true, true, ["ses_1", R], [m, l]],
        [".omo/plans/plan.md", true, false, [R], [l + 1]],
      ],
    );
    assert.equal(s.carnet.tuiles.length, 2 + NEON_CARNET_TUILES, "le chemin qui remonte n'est pas une tuile");
    assert.deepEqual(
      s.carnet.tuiles.map((t) => t.position !== null),
      s.carnet.tuiles.map((_, i) => i < NEON_CARNET_TUILES),
    );
    assert.deepEqual(
      s.carnet.liens.map((lien) => [lien.sessionId, lien.arrivee]),
      [
        ["ses_1", nodeOf(s, "ses_1")?.position],
        [R, nodeOf(s, R)?.position],
      ],
    );
    // Mode Simple : aucune tuile (salle réservée au mode Avancé) ; hors de la salle, aucun fait de carnet n'existe (L25a).
    assert.deepEqual(scene(st.facts, null, { ...SALLE, mode: "simple" }).carnet, { vide: true, tuiles: [], liens: [] });
  });
});

describe("Salle OMO : métadonnées de la consigne dans le zoom 3 (JP-7)", () => {
  it("catégorie, IA choisie, compétences, « en tâche de fond » ou « attend le résultat » ; tout texte qui n'a pas la forme d'un code : null", () => {
    const st = new SalleStory();
    st.racine();
    st.demande("msg_d");
    st.occupee(R);
    const fond = st.delegueSalle(R, "call_f", "msg_a", "ses_f", "explore", META_FOND) - 1;
    const balises = st.delegueSalle(
      R,
      "call_b",
      "msg_a",
      "ses_b",
      "oracle",
      { categorie: '<img src=x onerror="alert(1)">', ia: "</dd><script>alert(2)</script>", competences: -1, fond: false },
    ) - 1;
    const detail = (focus: string) => scene(st.facts, null, { ...SALLE, zoom: 3, focus }).detail?.panneau.metadonnees;
    assert.deepEqual(detail("ses_f"), { categorie: "quick", ia: "github-copilot/claude-sonnet-4.5", competences: 2, attente: "fond", faits: [fond] });
    assert.deepEqual(detail("ses_b"), { categorie: null, ia: null, competences: null, attente: "resultat", faits: [balises] });
    assert.equal(detail(R), null, "la conversation n'a pas reçu de consigne");
    // Hors de la salle : aucune clé de la salle dans la consigne, aucune métadonnée.
    const hors = new Story();
    hors.demande("msg_d");
    hors.occupee(R);
    hors.delegate(R, "call_1", "msg_a", "ses_1", "explore");
    assert.equal(scene(hors.facts, null, { zoom: 3, mode: "avance", focus: "ses_1" }).detail?.panneau.metadonnees, null);
  });
});

describe("bornes de l'arbre dessiné (§3.10 : 3 niveaux, 50 assistants)", () => {
  it("mêmes bornes que le réducteur ; au-delà, ni dessiné ni relié, compté avec ses descendants", () => {
    assert.deepEqual([NEON_PROFONDEUR_MAX, NEON_SESSIONS_MAX], [ACTIVITY_MAX_DEPTH, ACTIVITY_MAX_SESSIONS]);
    const large = new SalleStory();
    large.racine();
    large.demande("msg_d");
    large.occupee(R);
    for (let i = 0; i < 60; i++) large.delegueSalle(R, `call_${i}`, "msg_a", `ses_${String(i).padStart(2, "0")}`, "explore", META_FOND);
    const l = scene(large.facts, null, SALLE);
    assert.equal(l.noeuds.length, NEON_SESSIONS_MAX);
    assert.equal(l.horsBornes, 61 - NEON_SESSIONS_MAX);
    assert.ok(l.faisceaux.every((f) => f.vers === null || nodeOf(l, f.vers) !== undefined), "aucun faisceau vers un assistant non dessiné");
    const chaine = new SalleStory();
    chaine.racine();
    chaine.demande("msg_d");
    chaine.occupee(R);
    const ids = ["ses_n1", "ses_n2", "ses_n3", "ses_n4", "ses_n5", "ses_n6"];
    ids.forEach((id, i) => chaine.delegueSalle(i === 0 ? R : (ids[i - 1] as string), `call_${i}`, `msg_${i}`, id, "explore", META_ATTEND));
    const c = scene(chaine.facts, null, SALLE);
    assert.deepEqual(
      c.noeuds.map((n) => n.sessionId),
      [R, "ses_n1", "ses_n2", "ses_n3"],
    );
    assert.equal(c.horsBornes, 3, "ses_n4 au-delà, ses_n5 et ses_n6 comptés avec lui");
    for (const options of ALL_OPTIONS) assertHonest(scene(chaine.facts, null, options), chaine.facts, chaine.facts.length, JSON.stringify(options));
    // Un descendant d'un assistant hors bornes est compté par l'un ou l'autre fait qui le fait connaître : sa création seule, ou la
    // consigne seule.
    const creation = new SalleStory();
    creation.facts.push(...chaine.facts.slice(0, chaine.facts.findIndex((f) => f.sessionId === "ses_n5")));
    creation.creeeSalle("ses_x5", "ses_n4", "explore");
    assert.equal(scene(creation.facts, null, SALLE).horsBornes, 2, "ses_n4 et ses_x5 (création seule)");
    const consigne = new SalleStory();
    consigne.facts.push(...chaine.facts.slice(0, chaine.facts.findIndex((f) => f.sessionId === "ses_n5")));
    consigne.envoyeeSalle("ses_n4", "call_y", "msg_y", "ses_y5", "explore", META_ATTEND);
    assert.equal(scene(consigne.facts, null, SALLE).horsBornes, 2, "ses_n4 et ses_y5 (consigne seule)");
  });
});

describe("Salle OMO : aucun signe sans fait (P12) et différé = direct", () => {
  it("à chaque fait d'une histoire de la salle, dans les deux modes et au zoom 3, chaque signe référence ses faits ; relue depuis la base, même scène", () => {
    const st = new SalleStory();
    st.racine();
    st.demande("msg_d");
    st.occupee(R);
    st.delegueSalle(R, "call_f", "msg_a", "ses_f", "explore", META_FOND);
    st.delegueSalle(R, "call_j", "msg_a", "ses_j", "sisyphus-junior", META_ATTEND);
    st.carnet("ses_j", "call_c", "modifie", ".omo/notepads/n.md", "00000000000000c1");
    st.extension("ses_j", "call_g");
    st.repos("ses_j");
    st.resultat(R, "call_j", "ses_j", "rendu");
    st.repos(R);
    st.repos("ses_f");
    st.resultat(R, "call_f", "ses_f", "rendu");
    st.add(R, "origine", { origine: "reveil-sans-reponse", cas: 4, messageId: "msg_r" }, "msg_r");
    st.add(R, "reveil", { etat: "depose", messageId: "msg_r" }, "msg_r");
    const options: NeonSceneOptions[] = [SALLE, { ...SALLE, mode: "simple" }, { ...SALLE, zoom: 3 }, { ...SALLE, zoom: 3, focus: "ses_j" }, { ...SALLE, zoom: 3, focus: "ses_f" }];
    const relus = stored(st.facts);
    for (let k = 0; k <= st.facts.length; k++) {
      for (const o of options) {
        const direct = scene(st.facts.slice(0, k), null, o);
        assertHonest(direct, st.facts, k, `k=${k} ${JSON.stringify({ ...o, roleSalle: undefined })}`);
        assert.deepEqual(scene(relus.slice(0, k), null, o), direct, `différé k=${k}`);
      }
    }
  });
});

describe("script couleurs JP-14 : l'orange de l'extension", () => {
  it("l'orange passe : trait 3:1 contre le fond et la grille, en vision normale, deutéranopie et protanopie, dans les deux thèmes ; écart de 15 avec le cyan de même forme", () => {
    assert.deepEqual(neonColorProblems(), []);
    assert.deepEqual(
      NEON_MEME_FORME_SALLE.map(([a, b]) => `${a}/${b}`),
      ["extension/territoire", "extension/acteur"],
    );
    for (const theme of ["sombre", "clair"] as NeonTheme[]) {
      const palette = NEON_PALETTES[theme];
      for (const vision of VISIONS) {
        for (const decor of NEON_DECOR) assert.ok(contrastRatio(palette.extension, palette[decor], vision) >= SEUIL_TRAIT, `${theme} ${vision} ${decor}`);
        for (const [a, b] of NEON_MEME_FORME_SALLE) assert.ok(colorDistance(palette[a], palette[b], vision) >= SEUIL_ECART, `${theme} ${vision} ${a}/${b}`);
      }
    }
    assert.equal(NEON_GRAMMAIRE.enceinte.trait, "extension");
    const formes = Object.values(NEON_GRAMMAIRE).map((style) => style.forme);
    assert.equal(new Set(formes).size, formes.length, "l'enceinte a sa propre forme");
  });

  it("un orange trop proche du cyan, ou trop sombre, fait échouer le script", () => {
    const proche = paletteProblems({ ...NEON_PALETTES.sombre, extension: "#2ED8F0" }, "sombre");
    assert.ok(proche.some((p) => p.mesure === "ecart" && p.jeton === "extension" && p.contre === "acteur"));
    assert.ok(proche.some((p) => p.mesure === "ecart" && p.jeton === "extension" && p.contre === "territoire"));
    const sombre = paletteProblems({ ...NEON_PALETTES.clair, extension: "#F0B080" }, "clair");
    assert.ok(sombre.some((p) => p.mesure === "contraste" && p.jeton === "extension"));
  });
});

// --- Bande de la salle : le vrai composant NeonBand.tsx rendu côté serveur -------------------------------------------------------

interface BandeRendue {
  MetadonneesConsigne: (props: { meta: NeonConsigneSalle }) => unknown;
  NeonCarte: (props: { vue: NeonScene }) => unknown;
  NeonTableau: (props: { vue: NeonScene }) => unknown;
}

const BAND_FILE = path.join(import.meta.dirname, "..", "web", "pages", "chat", "activity", "NeonBand.tsx");
let bandeChargee: Promise<{ bande: BandeRendue; rendre: (composant: unknown, props: object) => string }> | null = null;

/**
 * NeonBand.tsx transformé en mémoire par vite (transformWithOxc, déjà installé), sans rien écrire : feuille de style retirée,
 * imports relatifs et React en adresses absolues, module chargé depuis une adresse data:. Rendu par renderToStaticMarkup.
 */
function chargerBande() {
  bandeChargee ??= (async () => {
    const { transformWithOxc } = (await import("vite")) as unknown as { transformWithOxc: (code: string, file: string, options: object) => Promise<{ code: string }> };
    const { code } = await transformWithOxc(fs.readFileSync(BAND_FILE, "utf8"), BAND_FILE, { lang: "tsx", jsx: { runtime: "automatic" } });
    const dossier = path.dirname(BAND_FILE);
    const absolu = code
      .replace(/^import\s+["']\.\/[\w.-]+\.css["'];?[ \t]*$/m, "")
      .replace(/(\bfrom\s+)["'](\.{1,2}\/[^"']+)["']/g, (_m, tete: string, spec: string) => `${tete}${JSON.stringify(pathToFileURL(path.resolve(dossier, spec)).href)}`)
      .replace(/(\bfrom\s+)["'](react|react\/jsx-runtime)["']/g, (_m, tete: string, spec: string) => `${tete}${JSON.stringify(import.meta.resolve(spec))}`);
    assert.equal(/\bfrom\s+["'](?!file:)/.test(absolu), false, "un import resté relatif ou nu ne se chargerait pas");
    const bande = (await import(`data:text/javascript;base64,${Buffer.from(absolu).toString("base64")}`)) as BandeRendue;
    const react = (await import(import.meta.resolve("react"))) as { createElement: (type: unknown, props: object) => unknown };
    const serveur = (await import("react-dom/server")) as unknown as { renderToStaticMarkup: (element: unknown) => string };
    return { bande, rendre: (composant: unknown, props: object) => serveur.renderToStaticMarkup(react.createElement(composant, props)) };
  })();
  return bandeChargee;
}

describe("bande de la salle (NeonBand.tsx) : textes échappés, enceinte statique", () => {
  it("JP-7 : un texte à balises venu de l'IA reste du texte — jamais une balise dans le HTML rendu", async () => {
    const { bande, rendre } = await chargerBande();
    const html = rendre(bande.MetadonneesConsigne, {
      meta: { categorie: '<img src=x onerror="alert(1)">', ia: "</dd><script>alert(2)</script>", competences: 3, attente: "fond", faits: [0] },
    });
    assert.equal(/<img|<script|<\/dd><script/i.test(html), false, html);
    assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"), html);
    assert.ok(html.includes("&lt;/dd&gt;&lt;script&gt;alert(2)&lt;/script&gt;"), html);
    for (const texte of [TEXTES.avance.consigneSalle.titre, TEXTES.avance.consigneSalle.categorie, TEXTES.avance.consigneSalle.ia, TEXTES.avance.consigneSalle.tacheDeFond, "3"]) {
      assert.ok(html.includes(texte.replaceAll("'", "&#x27;")), texte);
    }
    // Valeur refusée par la scène (null) : « non enregistré », et « attend le résultat ».
    const vide = rendre(bande.MetadonneesConsigne, { meta: { categorie: null, ia: null, competences: null, attente: "resultat", faits: [0] } });
    assert.equal(vide.split(TEXTES.partout.nonEnregistre).length - 1, 3);
    assert.ok(vide.includes(TEXTES.avance.consigneSalle.attendResultat));
  });

  it("carte de la salle : enceinte sans clé de transition ni animation ; boucle et tuiles dessinées ; nom à balises écrit en texte dans le tableau", async () => {
    const { bande, rendre } = await chargerBande();
    const st = new SalleStory();
    st.racine();
    st.demande("msg_d");
    st.occupee(R);
    st.delegueSalle(R, "call_1", "msg_a", "ses_1", "librarian", META_ATTEND);
    st.extension("ses_1", "call_g");
    st.carnet("ses_1", "call_c", "lu", ".omo/plans/plan.md", "00000000000000c1");
    const vue = scene(st.facts, null, SALLE);
    const carte = rendre(bande.NeonCarte, { vue });
    const enceinte = /<g class="neon-enceinte">([\s\S]*?)<\/g>/.exec(carte);
    assert.ok(enceinte, "enceinte dessinée");
    assert.equal(/data-neon|style=|<animate/i.test(enceinte?.[0] ?? ""), false, "enceinte statique : aucune transition possible");
    assert.ok(enceinte?.[1]?.includes("Salle OMO · extension active"));
    assert.ok(/<g class="neon-extension"[^>]*data-neon-cle="x:ses_1"/.test(carte), "boucle de l'extension");
    assert.ok(carte.includes('class="neon-carnet-tuile is-lu"'), "tuile lue du carnet");
    assert.ok(carte.includes('class="neon-lien-carnet"'), "lien du carnet vers l'assistant");
    // Hors de la salle : aucune enceinte, aucune boucle.
    const hors = rendre(bande.NeonCarte, { vue: scene(replay("p1-delegation-parallele.jsonl"), null, AVANCE) });
    assert.equal(/neon-enceinte|neon-extension|neon-carnet-tuile/.test(hors), false);
    // Tableau : actions de l'extension et carnet en toutes lettres ; une valeur à balises glissée dans la scène reste du texte.
    const tableau = rendre(bande.NeonTableau, { vue });
    assert.ok(tableau.includes("Par l&#x27;extension (1) · non contrôlé avant exécution"), tableau);
    assert.ok(tableau.includes("Carnet partagé et plan : 1"), tableau);
    const piegee: NeonScene = { ...vue, noeuds: vue.noeuds.map((n) => (n.sessionId === "ses_1" ? { ...n, agent: "<b onmouseover=x>lib</b>" } : n)) };
    assert.equal(/<b onmouseover/i.test(rendre(bande.NeonTableau, { vue: piegee })), false);
  });

  it("textes de la salle : la phrase de la bande reprend le bandeau permanent (L26a) ; « non contrôlé avant exécution » partout le même", () => {
    assert.equal(TEXTES.avance.salle, "Salle OMO · extension active · actions non contrôlées avant exécution");
    assert.ok(OMO_TEXTES.avance.bandeau.texte.startsWith(`${TEXTES.avance.salle} · `));
    assert.equal(TEXTES.avance.nonControle.toLowerCase(), OMO_TEXTES.avance.marques.nonControle);
    assert.equal(TEXTES.avance.signes.extension.toLowerCase(), OMO_TEXTES.avance.marques.parExtension);
    assert.ok(TEXTES.avance.actionsExtension.includes(TEXTES.avance.nonControle.toLowerCase()));
    assert.ok(!JSON.stringify(TEXTES.simple).includes("OMO") && !JSON.stringify(TEXTES.partout).includes("OMO"), "la salle n'est nommée qu'en mode Avancé");
  });

  it("NeonBand.tsx et neon.css : aucune écriture HTML brute, aucune animation ni transition sur l'enceinte", () => {
    const source = fs.readFileSync(BAND_FILE, "utf8");
    assert.equal(/dangerouslySetInnerHTML|\.innerHTML|\.outerHTML|insertAdjacentHTML|DOMParser|document\.write/.test(source), false);
    const css = fs.readFileSync(path.join(path.dirname(BAND_FILE), "neon.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const regles = [...css.matchAll(/([^{}]*\.neon-enceinte[^{}]*)\{([^}]*)\}/g)];
    assert.ok(regles.length >= 2, "règles de l'enceinte trouvées");
    for (const [, selecteur, corps] of regles) assert.equal(/animation|transition|opacity|@keyframes/i.test(corps ?? ""), false, selecteur);
  });
});
