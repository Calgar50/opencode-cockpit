// Tests L28a, légendes conditionnelles (spécification §5.8 l.999-1002, §7.7 l.1169, JP-2, JP-3, JP-5, U2 ; plan d'exécution it3,
// fiche L28a) : la légende « ne voit pas votre conversation » (clé neuf) n'est JAMAIS émise sur une reprise (fait reprise: true,
// enfant déjà vu, propriété sur 200 suites synthétiques à graine fixe) ; callId des légendes de consigne sur p1 et p2, null pour
// réveil et relance ; carnet dans la salle ; tâche de fond ancrée au faisceau de la consigne ; au plus 2 clés ; faits de chaque moment.
// Salle branchée (« 3s », L3s-a) : prédicats de legendes-salle.ts (tâche de fond `fond: true`, carnet bien formé), tâche de fond
// branchée par défaut pour une racine de la salle, légende « carnet » d'après les faits `carnet`, « neuf » jamais sur une reprise.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventMemory, type FactContext, FactDeduper, type FactEvent, factsFromEvent, type FactSession } from "./shared/activity-facts.ts";
import type { ActivityFact, ActivityFactKind, FactValue } from "./shared/activity-types.ts";
import { type Legende, LEGENDE_CLES_MAX, type LegendeKey, legendesAuMoment, type LegendesOptions } from "./shared/legendes.ts";
import { carnetTouche, tacheDeFond } from "./shared/legendes-salle.ts";
import { moments, type NeonSceneOptions, scene, visibleCount } from "./shared/neon-scene.ts";
import { readCapture } from "./test-support/fake-opencode.ts";

// --- Faits des captures (même chemin que le magasin, comme neon-scene.test.ts et revoir.test.ts) ------------------------------------

const ROOT = "ses_f618ff214ffevi6gfuGx6TvpTP";
const SENT_BY_COCKPIT = new Set(["msg_09e702c4e001phPA6LcfC9t4WK", "msg_09e70de68001w3xwbgF26JxZPW", "msg_09e75b36c001x5Cehfmxl57pRZ"]);
const CAPTURES = ["p1-delegation-parallele.jsonl", "p2-commande-subtask.jsonl", "p6-arret-global.jsonl", "p7-autorisation-orpheline.jsonl"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function replay(name: string): ActivityFact[] {
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
      promptKind: (id) => (SENT_BY_COCKPIT.has(id) ? "message" : null),
      firstUserMessage: (id) => memory.firstUserMessage(id),
      userMessageParts: (id) => memory.userMessageParts(id),
      unansweredUserMessages: (id) => memory.unansweredUserMessages(id),
    };
    kept.push(...factsFromEvent(event, ctx).filter((fact) => deduper.accept(fact)));
  }
  return kept;
}

const FAITS: ReadonlyMap<string, ActivityFact[]> = new Map(CAPTURES.map((name) => [name, replay(name)]));
const faitsDe = (name: (typeof CAPTURES)[number]): ActivityFact[] => FAITS.get(name) ?? [];
const AVANCE: NeonSceneOptions = { zoom: 2, mode: "avance" };
const HORS_SALLE: LegendesOptions = { salle: false };

/** Légendes de chaque moment, dans l'ordre, avec le moment qui les porte. */
function legendesDeTousLesMoments(faits: readonly ActivityFact[], options: LegendesOptions): Array<{ t: number; legende: Legende }> {
  return moments(faits).flatMap((t) => legendesAuMoment(faits, t, options).map((legende) => ({ t, legende })));
}

const consignesEnvoyees = (faits: readonly ActivityFact[]) => faits.filter((f) => f.kind === "consigne" && f.data.etat === "envoyee");

// --- Histoires synthétiques ------------------------------------------------------------------------------------------------------

const R = "ses_racine";

class Story {
  readonly facts: ActivityFact[] = [];
  at = 1_000;

  add(sessionId: string, kind: ActivityFactKind, data: Record<string, FactValue>, ref: string | null = null, rootId = R): ActivityFact {
    this.at += 10;
    const fact: ActivityFact = { rootId, sessionId, kind, ref, data, at: this.at };
    this.facts.push(fact);
    return fact;
  }
  statut(sessionId: string, etat: string) {
    return this.add(sessionId, "statut", { etat });
  }
  creee(enfant: string, parent: string) {
    return this.add(enfant, "statut", { etat: "creee", role: "delegation", parent, agent: "explore", instance: "principale" });
  }
  envoyee(parent: string, callId: string, enfant: string, reprise: boolean) {
    return this.add(parent, "consigne", { etat: "envoyee", callId, messageId: "msg_x", enfant, agent: "explore", source: "ia", commande: null, reprise }, callId);
  }
  resultat(parent: string, callId: string, enfant: string) {
    return this.add(parent, "resultat", { etat: "rendu", callId, messageId: "msg_x", enfant }, callId);
  }
  origine(sessionId: string, origine: string, messageId: string) {
    return this.add(sessionId, "origine", { origine, cas: 4, messageId }, messageId);
  }
  /** Délégation à un enfant neuf : création, envoi, travail, résultat. */
  deleguerNeuf(parent: string, callId: string, enfant: string, reprise = false) {
    this.creee(enfant, parent);
    const consigne = this.envoyee(parent, callId, enfant, reprise);
    this.statut(enfant, "occupee");
    this.statut(enfant, "repos");
    this.resultat(parent, callId, enfant);
    return consigne;
  }
}

/** Légende de nœud de la consigne `callId`, sur tous les moments. */
function legendeDeConsigne(faits: readonly ActivityFact[], callId: string, options: LegendesOptions = HORS_SALLE): Legende {
  const trouvees = legendesDeTousLesMoments(faits, options).filter(({ legende }) => legende.callId === callId && legende.ancre.genre === "noeud");
  assert.equal(trouvees.length, 1, `une légende de nœud pour ${callId}`);
  return (trouvees[0] as { legende: Legende }).legende;
}

/** Générateur à graine fixe (mulberry32) : suites reproductibles. */
function graine(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Attendu {
  callId: string;
  /** Vérité de construction : l'enfant avait déjà travaillé ou le fait porte reprise: true. */
  reprise: boolean;
}

/**
 * Suite synthétique : délégations à des enfants neufs (drapeau reprise parfois vrai), reprises d'enfants déjà vus (drapeau parfois
 * absent, comme une reprise mal marquée), réveils, relances, états de la racine, sous-délégations ; heures parfois inversées (M15).
 */
function suite(rand: () => number): { faits: ActivityFact[]; attendus: Attendu[] } {
  const story = new Story();
  const attendus: Attendu[] = [];
  const vus: string[] = [];
  const pas = 4 + Math.floor(rand() * 16);
  for (let i = 0; i < pas; i++) {
    const r = rand();
    const parent = vus.length > 0 && rand() < 0.25 ? (vus[Math.floor(rand() * vus.length)] as string) : R;
    const callId = `call_${i}`;
    if (r < 0.4 || vus.length === 0) {
      const enfant = `ses_n${i}`;
      const drapeau = rand() < 0.2;
      story.deleguerNeuf(parent, callId, enfant, drapeau);
      attendus.push({ callId, reprise: drapeau });
      vus.push(enfant);
    } else if (r < 0.7) {
      const enfant = vus[Math.floor(rand() * vus.length)] as string;
      if (enfant === parent) continue;
      story.envoyee(parent, callId, enfant, rand() < 0.6);
      story.statut(enfant, "occupee");
      attendus.push({ callId, reprise: true });
    } else if (r < 0.8) story.origine(R, rand() < 0.5 ? "reveil-sans-reponse" : "relance-extension", `msg_o${i}`);
    else story.statut(R, rand() < 0.5 ? "occupee" : "repos");
    if (rand() < 0.2) story.at -= 1 + Math.floor(rand() * 40);
  }
  return { faits: story.facts, attendus };
}

// --- Tests -----------------------------------------------------------------------------------------------------------------------

describe("légende « ne voit pas votre conversation » (clé neuf) jamais émise sur une reprise (spéc. l.1169)", () => {
  it("fait reprise: true sur un enfant jamais vu → reprise, jamais neuf", () => {
    const story = new Story();
    story.deleguerNeuf(R, "call_a", "ses_a", true);
    assert.deepEqual(legendeDeConsigne(story.facts, "call_a").cles, ["reprise"]);
  });

  it("enfant déjà vu, sans drapeau : reprise ; témoin : enfant neuf (seule sa création le précède) → neuf", () => {
    const story = new Story();
    story.deleguerNeuf(R, "call_a", "ses_a");
    story.envoyee(R, "call_b", "ses_a", false);
    assert.deepEqual(legendeDeConsigne(story.facts, "call_a").cles, ["neuf"], "création seule avant la consigne : enfant neuf");
    assert.deepEqual(legendeDeConsigne(story.facts, "call_b").cles, ["reprise"], "déjà délégué : reprise même sans drapeau");
  });

  it("enfant connu par un fait de sa session, par une consigne ou par un résultat qui le désigne : reprise", () => {
    const parSession = new Story();
    parSession.statut("ses_a", "occupee");
    parSession.envoyee(R, "call_a", "ses_a", false);
    assert.deepEqual(legendeDeConsigne(parSession.facts, "call_a").cles, ["reprise"]);
    const parResultat = new Story();
    parResultat.resultat(R, "call_0", "ses_a");
    parResultat.envoyee(R, "call_a", "ses_a", false);
    assert.deepEqual(legendeDeConsigne(parResultat.facts, "call_a").cles, ["reprise"]);
    const parAutreParent = new Story();
    parAutreParent.envoyee("ses_p", "call_0", "ses_a", false);
    parAutreParent.envoyee(R, "call_a", "ses_a", false);
    assert.deepEqual(legendeDeConsigne(parAutreParent.facts, "call_a").cles, ["reprise"]);
    // Un fait d'une autre conversation ne fait rien connaître.
    const autreRacine = new Story();
    autreRacine.statut(R, "occupee");
    autreRacine.add("ses_a", "statut", { etat: "occupee" }, null, "ses_autre");
    autreRacine.envoyee(R, "call_a", "ses_a", false);
    assert.deepEqual(legendeDeConsigne(autreRacine.facts, "call_a").cles, ["neuf"]);
  });

  it("propriété sur 200 suites synthétiques : une légende par consigne ; neuf seulement pour un enfant neuf sans drapeau", () => {
    const rand = graine(0x1169);
    let neufs = 0;
    let reprises = 0;
    for (let n = 0; n < 200; n++) {
      const { faits, attendus } = suite(rand);
      for (const salle of [false, true]) {
        const options: LegendesOptions = { salle };
        const legendes = legendesDeTousLesMoments(faits, options).map(({ legende }) => legende);
        const deConsigne = legendes.filter((l) => l.callId !== null);
        assert.deepEqual(
          deConsigne.map((l) => l.callId),
          attendus.map((a) => a.callId),
          `suite ${n} : une légende par consigne, dans l'ordre`,
        );
        attendus.forEach((attendu, k) => {
          const cles = (deConsigne[k] as Legende).cles;
          assert.ok(cles.length >= 1 && cles.length <= LEGENDE_CLES_MAX);
          if (attendu.reprise) assert.ok(!cles.includes("neuf") && cles[0] === "reprise", `suite ${n}, ${attendu.callId} : reprise`);
          else assert.equal(cles[0], "neuf", `suite ${n}, ${attendu.callId} : enfant neuf`);
          assert.deepEqual(cles.slice(1), salle ? ["carnet"] : []);
        });
        if (!salle) {
          neufs += attendus.filter((a) => !a.reprise).length;
          reprises += attendus.filter((a) => a.reprise).length;
        }
        for (const l of legendes) assert.ok(l.cles.length <= LEGENDE_CLES_MAX);
      }
    }
    assert.ok(neufs > 100 && reprises > 100, `${neufs} neufs, ${reprises} reprises : la propriété discrimine`);
  });
});

describe("légendes des captures : ancres et callId (U2)", () => {
  it("p1, p2 : callId de chaque légende de consigne = callId du fait consigne qui la porte ; p6 aussi ; p7 : aucune", () => {
    const attendus: Record<string, string[]> = {
      "p1-delegation-parallele.jsonl": ["call_d16cb6e832bd48ac81b65537", "call_397a867685754eee8591b009"],
      "p2-commande-subtask.jsonl": ["01M2F71QKG9N9C7MEKM6DXE7T7"],
      "p6-arret-global.jsonl": ["call_f1eebcb4e2c04b828581e60e"],
      "p7-autorisation-orpheline.jsonl": [],
    };
    for (const name of CAPTURES) {
      const faits = faitsDe(name);
      const legendes = legendesDeTousLesMoments(faits, HORS_SALLE);
      assert.deepEqual(
        legendes.map(({ legende }) => legende.callId),
        attendus[name],
        name,
      );
      for (const { t, legende } of legendes) {
        const consigne = consignesEnvoyees(faits).find((f) => f.data.callId === legende.callId);
        assert.ok(consigne, `${name} : fait consigne de ${legende.callId}`);
        assert.equal(legende.sessionId, consigne.data.enfant);
        assert.deepEqual(legende.ancre, { genre: "noeud", id: consigne.data.enfant });
        assert.deepEqual(legende.cles, ["neuf"], `${name} : enfant neuf, reprise: false`);
        assert.ok(scene(faits, t, AVANCE).noeuds.some((n) => n.sessionId === legende.ancre.id), `${name} : ancre dessinée à son moment`);
        assert.ok(visibleCount(faits, t) > faits.indexOf(consigne), "la consigne est visible au moment de sa légende");
      }
    }
  });

  it("réveil et relance : clé seule, ancrée au nœud du message, callId null ; autres origines : aucune légende", () => {
    const story = new Story();
    story.statut(R, "occupee");
    story.origine("ses_a", "reveil-sans-reponse", "msg_r");
    story.origine(R, "relance-extension", "msg_l");
    for (const autre of ["demande", "consigne", "cockpit", "interne-extension", "interne-opencode", "origine-inconnue", "constructor", "toString"]) story.origine(R, autre, `msg_${autre}`);
    const legendes = legendesDeTousLesMoments(story.facts, { salle: true }).map(({ legende }) => legende);
    assert.deepEqual(legendes, [
      { cles: ["reveil"], ancre: { genre: "noeud", id: "ses_a" }, sessionId: "ses_a", callId: null },
      { cles: ["relance"], ancre: { genre: "noeud", id: R }, sessionId: R, callId: null },
    ]);
  });
});

describe("salle, tâche de fond et bornes", () => {
  it("dans la salle, carnet après neuf ou reprise (ordre de spéc. l.1000-1002)", () => {
    const story = new Story();
    story.deleguerNeuf(R, "call_a", "ses_a");
    story.envoyee(R, "call_b", "ses_a", true);
    assert.deepEqual(legendeDeConsigne(story.facts, "call_a", { salle: true }).cles, ["neuf", "carnet"]);
    assert.deepEqual(legendeDeConsigne(story.facts, "call_b", { salle: true }).cles, ["reprise", "carnet"]);
  });

  it("tâche de fond : jamais par défaut ; si le prédicat le dit, légende à part ancrée au faisceau de la consigne, dessiné à ce moment", () => {
    const faits = faitsDe("p1-delegation-parallele.jsonl");
    const sansPredicat = legendesDeTousLesMoments(faits, { salle: true });
    assert.ok(sansPredicat.every(({ legende }) => !legende.cles.includes("tache-de-fond")));
    const vus: ActivityFact[] = [];
    const tacheDeFond = (fait: ActivityFact) => {
      vus.push(fait);
      return fait.data.callId === "call_397a867685754eee8591b009";
    };
    const avec = legendesDeTousLesMoments(faits, { salle: true, tacheDeFond });
    assert.ok(vus.length > 0 && vus.every((f) => f.kind === "consigne" && f.data.etat === "envoyee"), "prédicat lu sur les consignes envoyées seulement");
    const fond = avec.filter(({ legende }) => legende.cles.includes("tache-de-fond"));
    assert.equal(fond.length, 1);
    const { t, legende } = fond[0] as { t: number; legende: Legende };
    assert.deepEqual(legende.cles, ["tache-de-fond"]);
    assert.equal(legende.ancre.genre, "faisceau");
    assert.equal(legende.callId, "call_397a867685754eee8591b009");
    assert.equal(legende.sessionId, "ses_f618fbb91ffepC06O3owB9ayZ7");
    assert.ok(scene(faits, t, AVANCE).faisceaux.some((b) => b.id === legende.ancre.id), `faisceau ${legende.ancre.id} dessiné par scene() (même id que neon-scene.ts)`);
    const noeud = avec.find(({ legende: l }) => l.callId === legende.callId && l.ancre.genre === "noeud");
    assert.deepEqual(noeud?.legende.cles, ["neuf", "carnet"], "carnet n'efface pas la tâche de fond, et la légende garde 2 phrases au plus");
    for (const { legende: l } of avec) assert.ok(l.cles.length <= LEGENDE_CLES_MAX);
  });

  it("chaque moment porte les légendes de ses propres faits ; entre deux moments : le précédent ; avant le premier : aucune ; null : le dernier", () => {
    const story = new Story();
    story.deleguerNeuf(R, "call_a", "ses_a");
    story.deleguerNeuf(R, "call_b", "ses_b");
    const faits = story.facts;
    const coupures = moments(faits);
    const parMoment = coupures.map((t) => legendesAuMoment(faits, t, HORS_SALLE).map((l) => l.callId));
    assert.deepEqual(
      parMoment.filter((liste) => liste.length > 0),
      [["call_a"], ["call_b"]],
    );
    const iA = coupures.findIndex((t) => legendesAuMoment(faits, t, HORS_SALLE).length > 0);
    assert.ok(iA >= 0 && (coupures[iA + 1] ?? 0) - (coupures[iA] ?? 0) > 5);
    assert.deepEqual(
      legendesAuMoment(faits, (coupures[iA] ?? 0) + 5, HORS_SALLE),
      legendesAuMoment(faits, coupures[iA] ?? 0, HORS_SALLE),
      "entre deux moments : les faits du moment précédent",
    );
    assert.deepEqual(legendesAuMoment(faits, (coupures[0] ?? 0) - 1, HORS_SALLE), []);
    assert.deepEqual(legendesAuMoment(faits, null, HORS_SALLE), legendesAuMoment(faits, coupures.at(-1) ?? 0, HORS_SALLE));
    const fin = new Story();
    fin.statut(R, "occupee");
    fin.deleguerNeuf(R, "call_z", "ses_z");
    fin.facts.splice(-3);
    assert.deepEqual(
      legendesAuMoment(fin.facts, null, HORS_SALLE).map((l) => l.callId),
      ["call_z"],
      "en direct, la consigne arrivée en dernier",
    );
  });

  it("faits illisibles ou d'une autre racine : ignorés ; consigne sans enfant ou préparée : aucune légende", () => {
    const story = new Story();
    story.statut(R, "occupee");
    story.add(R, "consigne", { etat: "prepare", callId: "call_p", messageId: "msg_x", enfant: "ses_p" }, "call_p");
    story.add(R, "consigne", { etat: "envoyee", callId: "call_s", messageId: "msg_x", enfant: null, reprise: false }, "call_s");
    story.add(R, "consigne", { etat: "envoyee", callId: "call_o", messageId: "msg_x", enfant: "ses_o", reprise: false }, "call_o", "ses_autre");
    const faits = [...story.facts, { rootId: R, sessionId: R, kind: "consigne", ref: null, data: null, at: 9_000 } as unknown as ActivityFact];
    assert.deepEqual(legendesDeTousLesMoments(faits, HORS_SALLE), []);
    const sansCallId = new Story();
    sansCallId.add(R, "consigne", { etat: "envoyee", messageId: "msg_x", enfant: "ses_a", reprise: false });
    assert.deepEqual(
      legendesDeTousLesMoments(sansCallId.facts, { salle: false, tacheDeFond: () => true }).map(({ legende }) => legende),
      [{ cles: ["neuf"], ancre: { genre: "noeud", id: "ses_a" }, sessionId: "ses_a", callId: null }],
      "sans callId : ni [Voir la consigne] ni faisceau",
    );
  });

  it("clés : sous-ensemble du §4.1.1", () => {
    const toutes: readonly LegendeKey[] = ["neuf", "reprise", "carnet", "tache-de-fond", "reveil", "relance"];
    const story = new Story();
    story.deleguerNeuf(R, "call_a", "ses_a");
    story.origine(R, "reveil-sans-reponse", "msg_r");
    for (const { legende } of legendesDeTousLesMoments(story.facts, { salle: true, tacheDeFond: () => true })) for (const cle of legende.cles) assert.ok(toutes.includes(cle));
  });
});

// --- Salle OMO branchée (itération « 3s », L3s-a) : prédicats de legendes-salle.ts ------------------------------------------------

/** Consigne envoyée de la salle : les clés de consigneOmo (activity-facts.ts, L25a), dont `fond`. */
function envoyeeSalle(story: Story, parent: string, callId: string, enfant: string, fond: boolean, reprise = false): ActivityFact {
  return story.add(
    parent,
    "consigne",
    { etat: "envoyee", callId, messageId: "msg_x", enfant, agent: "explore", source: "ia", commande: null, reprise, categorie: "quick", ia: null, competences: 0, fond },
    callId,
  );
}

/** Fait `carnet` de la salle (JP-6), bien formé : chemin relatif sous .omo, clé de fichier de 16 chiffres hexadécimaux. */
function carnetSalle(story: Story, sessionId: string, callId: string, etat = "lu", chemin = ".omo/notepads/n.md"): ActivityFact {
  return story.add(sessionId, "carnet", { etat, chemin, fichier: "00000000000000c1", dossier: "00000000000000d0", callId, messageId: "msg_c" }, callId);
}

describe("salle branchée (L3s-a) : prédicats de legendes-salle.ts", () => {
  it("tacheDeFond : consigne envoyée avec `fond: true` seulement ; carnetTouche : fait carnet bien formé seulement", () => {
    const story = new Story();
    assert.equal(tacheDeFond(envoyeeSalle(story, R, "call_f", "ses_f", true)), true);
    assert.equal(tacheDeFond(envoyeeSalle(story, R, "call_s", "ses_s", false)), false);
    // Hors de la salle, la clé `fond` n'existe pas ; une consigne préparée ou un autre fait ne sont jamais une tâche de fond.
    assert.equal(tacheDeFond(story.envoyee(R, "call_p", "ses_p", false)), false);
    assert.equal(tacheDeFond(story.add(R, "consigne", { etat: "prepare", callId: "call_q", messageId: "msg_x", fond: true }, "call_q")), false);
    assert.equal(tacheDeFond(story.add(R, "statut", { etat: "occupee", fond: true })), false);
    assert.equal(carnetTouche(carnetSalle(story, R, "call_c1", "lu")), "lu");
    assert.equal(carnetTouche(carnetSalle(story, R, "call_c2", "modifie", ".omo/plans/plan.md")), "modifie");
    for (const [etat, chemin] of [
      ["x", ".omo/notepads/n.md"],
      ["lu", ".omo/notepads/../../secret"],
      ["lu", "/workspace/projet/.omo/notepads/n.md"],
      ["lu", ".omo/notepads/"],
      ["lu", "notes/n.md"],
    ] as const) {
      assert.equal(carnetTouche(carnetSalle(story, R, "call_x", etat, chemin)), null, `${etat} ${chemin}`);
    }
    assert.equal(carnetTouche(story.add(R, "carnet", { etat: "lu", chemin: ".omo/notepads/n.md", fichier: "pas-une-cle" }, "call_y")), null);
    assert.equal(carnetTouche(story.statut(R, "occupee")), null);
  });

  it("tâche de fond BRANCHÉE dans la salle : légende à part, ancrée au faisceau, sans prédicat de l'appelant ; `fond: false`, hors salle : jamais ; le prédicat de l'appelant l'emporte", () => {
    const story = new Story();
    story.creee("ses_f", R);
    envoyeeSalle(story, R, "call_f", "ses_f", true);
    story.creee("ses_s", R);
    envoyeeSalle(story, R, "call_s", "ses_s", false);
    const salle = legendesDeTousLesMoments(story.facts, { salle: true }).map(({ legende }) => legende);
    const fond = salle.filter((legende) => legende.cles.includes("tache-de-fond"));
    assert.deepEqual(fond, [{ cles: ["tache-de-fond"], ancre: { genre: "faisceau", id: "consigne:ses_racine:call_f" }, sessionId: "ses_f", callId: "call_f" }]);
    assert.deepEqual(legendeDeConsigne(story.facts, "call_f", { salle: true }).cles, ["neuf", "carnet"], "la légende du nœud garde ses 2 phrases");
    // Hors de la salle : le même fait ne porte jamais la tâche de fond (défaut « jamais »).
    assert.ok(legendesDeTousLesMoments(story.facts, HORS_SALLE).every(({ legende }) => !legende.cles.includes("tache-de-fond")));
    // Le prédicat de l'appelant l'emporte sur celui de la salle.
    assert.ok(legendesDeTousLesMoments(story.facts, { salle: true, tacheDeFond: () => false }).every(({ legende }) => !legende.cles.includes("tache-de-fond")));
  });

  it("carnet d'après les faits `carnet` : la conversation qui touche le carnet reçoit « carnet » seule, une fois ; un assistant qui l'a reçue avec sa consigne ne la reçoit pas deux fois ; hors salle, fait mal formé : rien", () => {
    const story = new Story();
    story.statut(R, "occupee");
    const premier = carnetSalle(story, R, "call_c1", "modifie", ".omo/plans/plan.md");
    carnetSalle(story, R, "call_c2", "lu", ".omo/plans/plan.md");
    story.creee("ses_j", R);
    envoyeeSalle(story, R, "call_j", "ses_j", false);
    carnetSalle(story, "ses_j", "call_c3", "modifie");
    // Un assistant dont la consigne n'est pas dans les faits (connu par sa seule session) : la phrase lui est dite à son carnet.
    carnetSalle(story, "ses_inconnu", "call_c4", "lu");
    const legendes = legendesDeTousLesMoments(story.facts, { salle: true });
    const carnets = legendes.filter(({ legende }) => legende.cles.length === 1 && legende.cles[0] === "carnet").map(({ t, legende }) => ({ t, legende }));
    assert.deepEqual(
      carnets.map(({ legende }) => legende),
      [
        { cles: ["carnet"], ancre: { genre: "noeud", id: R }, sessionId: R, callId: null },
        { cles: ["carnet"], ancre: { genre: "noeud", id: "ses_inconnu" }, sessionId: "ses_inconnu", callId: null },
      ],
    );
    assert.equal(carnets[0]?.t, premier.at, "ancrée au moment du premier fait carnet de la conversation");
    assert.deepEqual(legendeDeConsigne(story.facts, "call_j", { salle: true }).cles, ["neuf", "carnet"], "ses_j l'a reçue avec sa consigne");
    for (const { legende } of legendes) {
      assert.ok(legende.cles.length <= LEGENDE_CLES_MAX);
      assert.ok(!(legende.cles.includes("neuf") && legende.cles.includes("reprise")));
    }
    // Hors de la salle : aucun fait carnet n'y porte de légende.
    assert.ok(legendesDeTousLesMoments(story.facts, HORS_SALLE).every(({ legende }) => !(legende.cles.length === 1 && legende.cles[0] === "carnet")));
    // Fait mal formé : rien.
    const mal = new Story();
    carnetSalle(mal, R, "call_m", "lu", ".omo/notepads/../../secret");
    assert.deepEqual(legendesDeTousLesMoments(mal.facts, { salle: true }), []);
  });

  it("dans la salle, la légende « neuf » n'est jamais émise sur une reprise, tâche de fond comprise", () => {
    const story = new Story();
    story.creee("ses_a", R);
    envoyeeSalle(story, R, "call_a", "ses_a", true);
    story.statut("ses_a", "occupee");
    envoyeeSalle(story, R, "call_b", "ses_a", true);
    envoyeeSalle(story, R, "call_c", "ses_c", true, true);
    assert.deepEqual(legendeDeConsigne(story.facts, "call_a", { salle: true }).cles, ["neuf", "carnet"]);
    assert.deepEqual(legendeDeConsigne(story.facts, "call_b", { salle: true }).cles, ["reprise", "carnet"]);
    assert.deepEqual(legendeDeConsigne(story.facts, "call_c", { salle: true }).cles, ["reprise", "carnet"]);
  });
});
