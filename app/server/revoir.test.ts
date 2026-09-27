// Tests L28a, lecteur « Revoir » (spécification §5.8 l.998, §7.7 l.1169, P12 ; plan d'exécution it3, fiche L28a, D-3d-10, D-3d-11,
// D-3d-21, D-3d-27) : demandes et fenêtres sur p1, p2, p6, p7 ; « différé = direct » à chaque moment ; raccourci des moments sans
// événement ; transitions bornées et vitesse refusée hors liste ; cible de « Suivre l'action » ; pureté des trois modules de L28a et
// aucune chaîne affichable (D-3d-21 : le contrôle de textes-3d.test.ts de T3d-b est repris ici en plus strict).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { EventMemory, type FactContext, FactDeduper, type FactEvent, factsFromEvent, type FactSession } from "./shared/activity-facts.ts";
import type { ActivityFact, ActivityFactKind, FactValue } from "./shared/activity-types.ts";
import { moments, type NeonScene, type NeonSceneOptions, scene, visibleCount } from "./shared/neon-scene.ts";
import {
  aller,
  auDirect,
  badge,
  choisirVitesse,
  cibleASuivre,
  type Demande,
  delaiSuivant,
  demandes,
  figer,
  instant,
  lire,
  ouvrir,
  precedent,
  RACCOURCI,
  type ReplayBadge,
  type ReplaySpeed,
  type ReplayState,
  suivant,
  VITESSES,
} from "./shared/revoir.ts";
import { readCapture } from "./test-support/fake-opencode.ts";

// --- Faits des captures (même chemin que le magasin : factsFromEvent puis FactDeduper, comme neon-scene.test.ts) -------------------

const ROOT = "ses_f618ff214ffevi6gfuGx6TvpTP";
/** Messages envoyés par le cockpit dans les captures (demande de p1, commande de p2, demande de p6). */
const SENT_BY_COCKPIT = new Set(["msg_09e702c4e001phPA6LcfC9t4WK", "msg_09e70de68001w3xwbgF26JxZPW", "msg_09e75b36c001x5Cehfmxl57pRZ"]);
const CAPTURES = ["p1-delegation-parallele.jsonl", "p2-commande-subtask.jsonl", "p6-arret-global.jsonl", "p7-autorisation-orpheline.jsonl"] as const;
const P1_E1 = "ses_f618fc47effewRlFGgpRFi51pw";

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

const OPTIONS: readonly NeonSceneOptions[] = [
  { zoom: 2, mode: "simple" },
  { zoom: 2, mode: "avance" },
  { zoom: 3, mode: "avance" },
];
const AVANCE: NeonSceneOptions = { zoom: 2, mode: "avance" };

// --- Faits synthétiques ----------------------------------------------------------------------------------------------------------

const R = "ses_racine";
const fait = (sessionId: string, kind: ActivityFactKind, data: Record<string, FactValue>, at: number, ref: string | null = null, rootId = R): ActivityFact => ({
  rootId,
  sessionId,
  kind,
  ref,
  data,
  at,
});
const demandeFait = (messageId: string, at: number, sessionId = R, rootId = R) => fait(sessionId, "origine", { origine: "demande", cas: 1, messageId }, at, messageId, rootId);
const statut = (sessionId: string, etat: string, at: number) => fait(sessionId, "statut", { etat }, at);

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

/** Suite synthétique : demandes de la racine entre des faits de travail, heures parfois inversées (au plus 150 ms, M15). */
function suiteSynthetique(rand: () => number): ActivityFact[] {
  const out: ActivityFact[] = [];
  let at = 10_000;
  const total = 6 + Math.floor(rand() * 40);
  for (let i = 0; i < total; i++) {
    at += Math.floor(rand() * 3_000);
    const inverse = rand() < 0.15 ? Math.floor(rand() * 150) : 0;
    const r = rand();
    if (r < 0.2) out.push(demandeFait(`msg_d${i}`, at - inverse));
    else if (r < 0.3) out.push(demandeFait(`msg_e${i}`, at - inverse, "ses_enfant"));
    else out.push(statut(rand() < 0.5 ? R : "ses_enfant", rand() < 0.5 ? "occupee" : "repos", at - inverse));
  }
  return out;
}

/** Fenêtre d'une demande calculée sans raccourci : visibleCount à chaque moment (référence des tests). */
function fenetreDeReference(faits: readonly ActivityFact[], demande: Demande): number[] {
  const tous = moments(faits);
  const dedans = tous.filter((t) => visibleCount(faits, t) > demande.debut && (demande.fin === null || visibleCount(faits, t) <= demande.fin));
  if (dedans.length > 0) return dedans;
  const premier = tous.find((t) => visibleCount(faits, t) > demande.debut);
  return premier === undefined ? [] : [premier];
}

const etat = (moments: number[], index: number, extra: Partial<ReplayState> = {}): ReplayState =>
  Object.freeze({ moments: Object.freeze([...moments]), index, vitesse: 1, lecture: false, direct: false, ...extra });

// --- Tests -----------------------------------------------------------------------------------------------------------------------

describe("demandes : fenêtres délimitées par les demandes de la racine (D-3d-10)", () => {
  it("p1, p2, p6 : une demande, du fait de la demande au dernier fait ; p7 : aucune", () => {
    const attendu: Record<string, string | null> = {
      "p1-delegation-parallele.jsonl": "msg_09e702c4e001phPA6LcfC9t4WK",
      "p2-commande-subtask.jsonl": "msg_09e70de68001w3xwbgF26JxZPW",
      "p6-arret-global.jsonl": "msg_09e75b36c001x5Cehfmxl57pRZ",
      "p7-autorisation-orpheline.jsonl": null,
    };
    for (const name of CAPTURES) {
      const faits = faitsDe(name);
      assert.ok(faits.length > 10, `${name} : ${faits.length} faits`);
      const liste = demandes(faits, ROOT);
      const messageId = attendu[name] ?? null;
      if (messageId === null) {
        assert.deepEqual(liste, [], name);
        continue;
      }
      assert.equal(liste.length, 1, name);
      const [d] = liste as [Demande];
      assert.equal(d.index, 0);
      assert.equal(d.fin, null);
      assert.equal(faits[d.debut], d.fait);
      assert.equal(d.fait.data.messageId, messageId, name);
      assert.equal(d.fait.data.origine, "demande");
    }
  });

  it("plusieurs demandes : chacune jusqu'à la suivante ; demandes d'un enfant ou d'une autre racine et autres origines ignorées", () => {
    const faits = [
      statut(R, "occupee", 1_000),
      demandeFait("msg_a", 1_010),
      statut(R, "repos", 2_000),
      demandeFait("msg_enfant", 2_010, "ses_enfant"),
      demandeFait("msg_autre", 2_020, "ses_autre", "ses_autre"),
      fait(R, "origine", { origine: "consigne", cas: 3, messageId: "msg_c" }, 2_030, "msg_c"),
      demandeFait("msg_b", 3_000),
      statut(R, "occupee", 3_010),
      demandeFait("msg_c2", 4_000),
    ];
    const liste = demandes(faits, R);
    assert.deepEqual(
      liste.map((d) => [d.index, d.debut, d.fin, d.fait.data.messageId]),
      [
        [0, 1, 6, "msg_a"],
        [1, 6, 8, "msg_b"],
        [2, 8, null, "msg_c2"],
      ],
    );
    assert.deepEqual(demandes(faits, "ses_inconnue"), []);
    assert.deepEqual(demandes([], R), []);
  });
});

describe("ouvrir : moments de la fenêtre, lecteur figé sur le dernier (D-3d-10)", () => {
  it("toute la conversation (null) : tous les moments, dernier moment, ×1, ni lecture ni direct", () => {
    for (const name of CAPTURES) {
      const faits = faitsDe(name);
      const s = ouvrir(faits, null);
      assert.deepEqual(s.moments, moments(faits), name);
      assert.deepEqual({ index: s.index, vitesse: s.vitesse, lecture: s.lecture, direct: s.direct }, { index: s.moments.length - 1, vitesse: 1, lecture: false, direct: false });
    }
    assert.deepEqual(ouvrir([], null), { moments: [], index: 0, vitesse: 1, lecture: false, direct: false });
  });

  it("fenêtre d'une demande : ses moments montrent son fait et pas celui de la demande suivante ; p1 exclut le moment d'avant", () => {
    const p1 = faitsDe("p1-delegation-parallele.jsonl");
    const [d1] = demandes(p1, ROOT) as [Demande];
    const s1 = ouvrir(p1, d1);
    assert.equal(d1.debut, 1);
    assert.equal(p1[0]?.data.etat, "creee");
    assert.deepEqual(s1.moments, moments(p1).slice(1), "la création de la conversation, avant la demande, reste hors de la fenêtre");
    assert.equal(s1.index, s1.moments.length - 1);
    const faits = [statut(R, "occupee", 1_000), demandeFait("msg_a", 1_010), statut(R, "repos", 2_000), demandeFait("msg_b", 3_000), statut(R, "occupee", 3_010)];
    const [a, b] = demandes(faits, R) as [Demande, Demande];
    assert.deepEqual(ouvrir(faits, a).moments, [1_010, 2_000]);
    assert.deepEqual(ouvrir(faits, b).moments, [3_000, 3_010]);
    assert.equal(ouvrir(faits, a).index, 1);
  });

  it("fenêtres de 300 suites à heures inversées : égales au calcul par visibleCount, ordonnées, et couvrant tous les moments", () => {
    const rand = graine(0x28a);
    let raccourcies = 0;
    for (let n = 0; n < 300; n++) {
      const faits = suiteSynthetique(rand);
      const liste = demandes(faits, R);
      let precedente = Number.NEGATIVE_INFINITY;
      const vus: number[] = [];
      for (const d of liste) {
        const fenetre = ouvrir(faits, d).moments;
        assert.deepEqual(fenetre, fenetreDeReference(faits, d), `suite ${n}, demande ${d.index}`);
        assert.ok(fenetre.length >= 1, "une demande a toujours au moins un moment");
        assert.ok((fenetre[0] ?? 0) >= precedente, "fenêtres dans l'ordre");
        precedente = fenetre.at(-1) ?? precedente;
        vus.push(...fenetre);
      }
      const avant = liste.length === 0 ? moments(faits) : moments(faits).filter((t) => visibleCount(faits, t) <= (liste[0]?.debut ?? 0));
      const couverts = new Set([...avant, ...vus]);
      if (couverts.size === moments(faits).length && vus.length === new Set(vus).size) continue;
      // Deux demandes mêlées dans un même moment par une inversion d'heure : le moment est partagé, jamais perdu.
      raccourcies += 1;
      for (const t of moments(faits)) assert.ok(couverts.has(t), `suite ${n} : moment ${t} perdu`);
    }
    assert.ok(raccourcies < 300, `${raccourcies} suites à moment partagé`);
  });

  it("demande invalide pour ces faits (indices hors bornes, fin avant le début, fait qui n'est pas une demande) : aucun moment", () => {
    const faits = [demandeFait("msg_a", 1_000), statut(R, "occupee", 1_010), statut(R, "repos", 1_020)];
    const [d] = demandes(faits, R) as [Demande];
    assert.equal(ouvrir(faits, d).moments.length, 3);
    for (const faux of [{ ...d, debut: 5 }, { ...d, debut: -1 }, { ...d, debut: 0.5 }, { ...d, fin: 0 }, { ...d, fin: 9 }, { ...d, debut: 1, fin: null }]) {
      assert.deepEqual(ouvrir(faits, faux).moments, [], JSON.stringify([faux.debut, faux.fin]));
    }
  });
});

describe("différé = direct (P12, D-3d-10)", () => {
  it("scene(faits, instant(état)) égal à scene(faits.slice(0, visibleCount(faits, t)), null) à chaque moment de p1, p2, p6 et p7", () => {
    let verifies = 0;
    for (const name of CAPTURES) {
      const faits = faitsDe(name);
      for (const demande of [null, ...demandes(faits, ROOT)]) {
        const ouvert = ouvrir(faits, demande);
        assert.ok(ouvert.moments.length > 0, name);
        for (let i = 0; i < ouvert.moments.length; i++) {
          const t = instant(aller(ouvert, i));
          assert.equal(t, ouvert.moments[i]);
          for (const options of OPTIONS) {
            assert.deepEqual(scene(faits, t, options), scene(faits.slice(0, visibleCount(faits, t)), null, options), `${name}, moment ${i}, ${options.mode} zoom ${options.zoom}`);
            verifies += 1;
          }
        }
      }
    }
    assert.ok(verifies > 300, `${verifies} scènes comparées`);
  });

  it("revoir une demande garde les positions de toute la conversation : chaque nœud à sa place finale", () => {
    for (const name of CAPTURES) {
      const faits = faitsDe(name);
      const finale = new Map(scene(faits, null, AVANCE).noeuds.map((n) => [n.sessionId, n.position]));
      for (const demande of demandes(faits, ROOT)) {
        const ouvert = ouvrir(faits, demande);
        for (let i = 0; i < ouvert.moments.length; i++) {
          for (const noeud of scene(faits, instant(aller(ouvert, i)), AVANCE).noeuds) assert.deepEqual(noeud.position, finale.get(noeud.sessionId), `${name} ${noeud.sessionId}`);
        }
      }
    }
  });

  const p8 = path.join(import.meta.dirname, "test-support", "fixtures", "autonomie-p8.jsonl");
  it(
    "même égalité sur autonomie-p8.jsonl (décisions et choix)",
    { skip: fs.existsSync(p8) ? false : "autonomie-p8.jsonl absente à H0 (it2, L10a) : reste connu, repris à la grande fusion" },
    () => {
      const lignes = fs.readFileSync(p8, "utf8").split("\n").filter((line) => line.trim() !== "");
      const premiere = JSON.parse(lignes[0] ?? "{}") as Record<string, unknown>;
      // Faits enregistrés (une ligne par fait) ; une capture d'événements se rejoue comme p1.
      const faits = "event" in premiere ? replay("autonomie-p8.jsonl") : lignes.map((line) => JSON.parse(line) as ActivityFact);
      const ouvert = ouvrir(faits, null);
      assert.ok(ouvert.moments.length > 0);
      for (let i = 0; i < ouvert.moments.length; i++) {
        const t = instant(aller(ouvert, i));
        for (const options of OPTIONS) assert.deepEqual(scene(faits, t, options), scene(faits.slice(0, visibleCount(faits, t)), null, options));
      }
    },
  );
});

describe("lecteur : transitions pures et bornées", () => {
  const s = etat([100, 200, 300, 400], 3);

  it("bornes : premier et dernier moment, indice hors bornes ramené, fractionnaire tronqué, illisible refusé", () => {
    assert.equal(precedent(etat([100, 200], 0)).index, 0);
    assert.equal(suivant(s).index, 3);
    assert.equal(aller(s, -3).index, 0);
    assert.equal(aller(s, 99).index, 3);
    assert.equal(aller(s, 1.7).index, 1);
    for (const illisible of [Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(aller(s, illisible), s);
    assert.equal(precedent(s).index, 2);
    assert.equal(suivant(aller(s, 0)).index, 1);
    const vide = ouvrir([], null);
    for (const pas of [lire, figer, precedent, suivant, auDirect]) assert.equal(pas(vide).index, 0);
  });

  it("« Lire » : depuis le moment courant, depuis le dernier reprend au premier ; la lecture se fige au dernier moment", () => {
    const lu = lire(aller(s, 1));
    assert.deepEqual([lu.index, lu.lecture, lu.direct], [1, true, false]);
    const repris = lire(s);
    assert.deepEqual([repris.index, repris.lecture], [0, true]);
    let pas = repris;
    for (let i = 0; i < 10; i++) pas = suivant(pas);
    assert.deepEqual([pas.index, pas.lecture], [3, false], "arrivée au dernier moment : lecture figée");
    assert.equal(aller(lu, 3).lecture, false);
    assert.equal(lire(etat([100], 0)).lecture, false, "un seul moment : rien à lire");
    assert.equal(precedent(lu).lecture, true, "le pas à pas garde la lecture en cours");
    const fige = figer(lu);
    assert.deepEqual([fige.index, fige.lecture, fige.direct], [1, false, false]);
  });

  it("direct : « Revenir au direct » (dernier moment, sans lecture) ; tout pas ou « Figer ici » repasse en différé", () => {
    const direct = auDirect(lire(aller(s, 1)));
    assert.deepEqual([direct.index, direct.lecture, direct.direct], [3, false, true]);
    assert.equal(instant(direct), null);
    assert.deepEqual(badge(direct), { etat: "direct" });
    assert.equal(delaiSuivant(direct), null);
    for (const pas of [figer, precedent, suivant, lire, (x: ReplayState) => aller(x, 0)]) assert.equal(pas(direct).direct, false);
    assert.equal(figer(direct).index, 3, "« Figer ici » : le moment affiché");
  });

  it("vitesse : les cinq valeurs acceptées, toute autre refusée (état inchangé)", () => {
    assert.deepEqual([...VITESSES], [0.25, 0.5, 1, 2, 4]);
    for (const v of VITESSES) assert.equal(choisirVitesse(s, v).vitesse, v);
    for (const v of [0, 3, -1, 8, 0.3, Number.NaN, Number.POSITIVE_INFINITY, "2" as unknown as number]) assert.equal(choisirVitesse(s, v), s, String(v));
  });

  it("aucune transition ne modifie l'état reçu (états gelés)", () => {
    const gele = etat([100, 200, 300], 1, { lecture: true });
    for (const pas of [lire, figer, precedent, suivant, auDirect, (x: ReplayState) => aller(x, 0), (x: ReplayState) => choisirVitesse(x, 2)]) {
      const apres = pas(gele);
      assert.notEqual(apres, gele);
      assert.deepEqual(gele, etat([100, 200, 300], 1, { lecture: true }));
    }
  });

  it("badge et instant en différé : vitesse et heure du moment courant ; sans moment, scène vide et heure 0", () => {
    const b: ReplayBadge = badge(choisirVitesse(aller(s, 1), 0.5));
    assert.deepEqual(b, { etat: "differe", vitesse: 0.5, heure: 200 });
    assert.deepEqual(badge(etat([100], 0, { vitesse: 3 as ReplaySpeed })), { etat: "differe", vitesse: 1, heure: 100 }, "vitesse illisible : ×1");
    const vide = ouvrir([], null);
    assert.deepEqual(badge(vide), { etat: "differe", vitesse: 1, heure: 0 });
    assert.equal(instant(vide), Number.NEGATIVE_INFINITY);
    const faits = [demandeFait("msg_a", 1_000)];
    assert.equal(visibleCount(faits, instant(vide)), 0, "sans moment, aucun fait visible (jamais toute la conversation)");
  });
});

describe("délai avant le moment suivant (D-3d-11)", () => {
  it("raccourci : écart de 4 001 ms → 1 000 ms et étiquette ; 2 000 ms à ×2 → 1 000 ms sans étiquette", () => {
    assert.deepEqual(RACCOURCI, { seuilMs: 4_000, montreMs: 1_000 });
    assert.deepEqual(delaiSuivant(etat([1_000, 5_001], 0)), { ms: 1_000, raccourciMs: 4_001 });
    assert.deepEqual(delaiSuivant(etat([1_000, 3_000], 0, { vitesse: 2 })), { ms: 1_000, raccourciMs: null });
  });

  it("seuil exclu (4 000 ms dure écart / v), raccourci à toute vitesse, écart / v sinon ; null au dernier moment", () => {
    assert.deepEqual(delaiSuivant(etat([0, 4_000], 0)), { ms: 4_000, raccourciMs: null });
    assert.deepEqual(delaiSuivant(etat([0, 4_000], 0, { vitesse: 0.25 })), { ms: 16_000, raccourciMs: null });
    for (const vitesse of VITESSES) assert.deepEqual(delaiSuivant(etat([0, 9_000], 0, { vitesse })), { ms: 1_000, raccourciMs: 9_000 });
    const attendus: Record<string, number> = { "0.25": 8_000, "0.5": 4_000, "1": 2_000, "2": 1_000, "4": 500 };
    for (const vitesse of VITESSES) assert.deepEqual(delaiSuivant(etat([0, 2_000], 0, { vitesse })), { ms: attendus[String(vitesse)], raccourciMs: null });
    assert.equal(delaiSuivant(etat([0, 2_000], 1)), null);
    assert.equal(delaiSuivant(etat([0], 0)), null);
    assert.equal(delaiSuivant(ouvrir([], null)), null);
    assert.equal(delaiSuivant(etat([0, 2_000], 0, { direct: true })), null, "en direct, aucun délai, même hors du dernier moment");
    assert.deepEqual(delaiSuivant(etat([0, 2_000], 0, { vitesse: 3 as ReplaySpeed })), { ms: 2_000, raccourciMs: null }, "vitesse illisible : ×1");
  });

  it("p1 : chaque écart de plus de 4 s est raccourci et étiqueté, les autres durent écart / v", () => {
    const ouvert = ouvrir(faitsDe("p1-delegation-parallele.jsonl"), null);
    let raccourcis = 0;
    for (let i = 0; i < ouvert.moments.length - 1; i++) {
      const ecart = (ouvert.moments[i + 1] ?? 0) - (ouvert.moments[i] ?? 0);
      const delai = delaiSuivant(choisirVitesse(aller(ouvert, i), 2));
      if (ecart > 4_000) {
        raccourcis += 1;
        assert.deepEqual(delai, { ms: 1_000, raccourciMs: ecart });
      } else assert.deepEqual(delai, { ms: ecart / 2, raccourciMs: null });
    }
    assert.equal(raccourcis, 2);
  });
});

describe("« Suivre l'action » : cibleASuivre", () => {
  const faits = faitsDe("p1-delegation-parallele.jsonl");
  const vues = moments(faits).map((t) => scene(faits, t, AVANCE));

  it("p1 : l'enfant qui apparaît est suivi ; rien de changé → null ; toute cible est un signe de la scène d'après", () => {
    const apparition = vues.findIndex((v) => v.noeuds.some((n) => n.sessionId === P1_E1));
    assert.ok(apparition > 0);
    assert.equal(cibleASuivre(vues[apparition - 1] as NeonScene, vues[apparition] as NeonScene), P1_E1);
    for (const v of vues) assert.equal(cibleASuivre(v, v), null);
    let suivies = 0;
    for (let i = 1; i < vues.length; i++) {
      const apres = vues[i] as NeonScene;
      const cible = cibleASuivre(vues[i - 1] as NeonScene, apres);
      if (cible === null) continue;
      suivies += 1;
      const ids = [...apres.noeuds.map((n) => n.sessionId), ...apres.faisceaux.map((b) => b.id), ...apres.attentes.map((w) => w.permissionId)];
      assert.ok(ids.includes(cible), cible);
    }
    assert.ok(suivies >= 5, `${suivies} cibles`);
  });

  it("ordre et cas : nœud changé d'état avant faisceau, faisceau apparu ou figé, attente apparue ; signe disparu ignoré", () => {
    const base = vues.at(-1) as NeonScene;
    const copie = (): NeonScene => structuredClone(base);
    const racine = copie();
    (racine.noeuds[0] as NeonScene["noeuds"][number]).etat = "echec";
    racine.attentes.push({ permissionId: "per_x", sessionId: ROOT, permission: "task", callId: null, faisceau: null, position: { x: 0, y: 0 }, depuis: 0, faits: [0] });
    assert.equal(cibleASuivre(base, racine), ROOT, "le nœud passe avant l'attente");
    const attente = copie();
    attente.attentes.push({ permissionId: "per_x", sessionId: ROOT, permission: "task", callId: null, faisceau: null, position: { x: 0, y: 0 }, depuis: 0, faits: [0] });
    assert.equal(cibleASuivre(base, attente), "per_x");
    const avecFaisceau = copie();
    avecFaisceau.faisceaux.push({ id: "consigne:x:y", kind: "consigne", de: ROOT, vers: null, depart: { x: 0, y: 0 }, arrivee: null, callId: "y", messageId: null, enMemeTemps: false, depuis: 0, fige: false, fin: null, faits: [0] });
    assert.equal(cibleASuivre(base, avecFaisceau), "consigne:x:y");
    const fige = structuredClone(avecFaisceau);
    (fige.faisceaux.at(-1) as NeonScene["faisceaux"][number]).fige = true;
    assert.equal(cibleASuivre(avecFaisceau, fige), "consigne:x:y");
    assert.equal(cibleASuivre(avecFaisceau, base), null, "un faisceau disparu n'est pas suivi");
    const sansNoeud = copie();
    sansNoeud.noeuds.pop();
    assert.equal(cibleASuivre(base, sansNoeud), null);
  });
});

describe("pureté et aucune chaîne affichable (D-3d-21, D-3d-27)", () => {
  const MODULES = ["revoir.ts", "legendes.ts", "revoir-access.ts"] as const;
  const lire_ = (file: string) => fs.readFileSync(path.join(import.meta.dirname, "shared", file), "utf8");
  /** Code en minuscules ASCII (lexique de textes.test.ts). */
  const CODE_LIKE = /^[a-z0-9]+(?:[-_.:][a-z0-9]+)*$/;

  /** Chaînes littérales d'un source, commentaires écartés ; les gabarits (accent grave) sont comptés à part (refusés ici). */
  function litteraux(source: string): { chaines: string[]; gabarits: number } {
    const chaines: string[] = [];
    let gabarits = 0;
    for (let i = 0; i < source.length; ) {
      const c = source.charAt(i);
      if (source.startsWith("//", i)) {
        const fin = source.indexOf("\n", i);
        i = fin === -1 ? source.length : fin;
      } else if (source.startsWith("/*", i)) {
        const fin = source.indexOf("*/", i + 2);
        i = fin === -1 ? source.length : fin + 2;
      } else if (c === '"' || c === "'") {
        let at = i + 1;
        let texte = "";
        while (at < source.length && source[at] !== c && source[at] !== "\n") {
          texte += source[at] === "\\" ? (source[at + 1] ?? "") : source[at];
          at += source[at] === "\\" ? 2 : 1;
        }
        chaines.push(texte);
        i = at + 1;
      } else {
        if (c === "`") gabarits += 1;
        i += 1;
      }
    }
    return { chaines, gabarits };
  }

  /** Problèmes d'un source : chaîne qui porte une lettre sans être un code, gabarit, module node, environnement, horloge, aléa, réseau. */
  function problemes(source: string): string[] {
    const out: string[] = [];
    const { chaines, gabarits } = litteraux(source);
    // Les chemins d'import (./x.ts) sont contrôlés à part (imports permis).
    for (const texte of chaines) if (/\p{L}/u.test(texte) && !CODE_LIKE.test(texte) && !/^\.\/[\w.-]+\.ts$/.test(texte)) out.push(`chaîne : ${texte}`);
    if (gabarits > 0) out.push("gabarit");
    if (source.includes('"node:')) out.push("node:");
    if (/\bprocess\./.test(source)) out.push("process");
    if (/\bDate\.now\b|new Date\s*\(\s*\)|new Date\b(?!\s*\()|Math\.random|\bfetch\s*\(|\bsetTimeout\b|\bsetInterval\b|\bperformance\.|\bcrypto\./.test(source)) out.push("horloge, aléa ou réseau");
    return out;
  }

  it("chaque règle échoue sur un source fabriqué, et laisse passer codes, ponctuation et commentaires", () => {
    const cas: Array<[string, string]> = [
      [`const a = "Il reprend son travail";`, "chaîne"],
      [`const a = 'Terminé';`, "chaîne"],
      [`const a = "Voir";`, "chaîne"],
      [`const a = "neuf reprise";`, "chaîne"],
      ["const a = `x${1}`;", "gabarit"],
      [`import fs from "node:fs";`, "node:"],
      [`const a = process.env;`, "process"],
      [`const a = Date.now();`, "horloge"],
      [`const a = new Date();`, "horloge"],
      [`const a = Math.random();`, "horloge"],
      [`const a = performance.now();`, "horloge"],
    ];
    for (const [source, attendu] of cas) assert.ok(problemes(source).some((p) => p.startsWith(attendu)), source);
    assert.deepEqual(problemes(`// "Il ne voit pas votre conversation"\nconst a = ["consigne", "b"].join(":"); const b = 'tache-de-fond'; const c = new Date(1);`), []);
  });

  it("revoir.ts, legendes.ts, revoir-access.ts : purs, sans chaîne affichable ni gabarit", () => {
    for (const file of MODULES) assert.deepEqual(problemes(lire_(file)), [], file);
  });

  it("imports : activity-types.ts, neon-scene.ts et les types partagés de salle3d-types.ts seulement (plus, pour legendes.ts, les prédicats de legendes-salle.ts), jamais un module de textes (D-3d-27)", () => {
    // « 3s » (L3s-a) : legendes.ts branche les prédicats de la salle de legendes-salle.ts, module pur et sans texte (contrôle de
    // source dans croisements-3d-salle.test.ts). Adaptation de L3s-a : aucun autre import n'est permis, aucun module de textes.
    const permis = (file: string, spec: string) =>
      spec === "./activity-types.ts" || spec === "./neon-scene.ts" || spec === "./salle3d-types.ts" || (file === "legendes.ts" && spec === "./legendes-salle.ts");
    for (const file of MODULES) {
      const source = lire_(file);
      const imports = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)].map((m) => m[1] ?? "");
      assert.ok(imports.length > 0, file);
      for (const spec of imports) assert.ok(permis(file, spec), `${file} : ${spec}`);
      assert.doesNotMatch(source, /^\s*import\s+(?!type\b)[^;]*from\s*["']\.\/salle3d-types\.ts["']/m, `${file} : salle3d-types.ts en types seulement`);
    }
  });

  it("types partagés réexportés de salle3d-types.ts depuis le train de V0 (D-3d-27), plus aucune copie", () => {
    const reexports: Array<[string, string]> = [
      ["revoir.ts", 'export type { ReplayBadge, ReplaySpeed } from "./salle3d-types.ts";'],
      ["legendes.ts", 'export type { LegendeKey } from "./salle3d-types.ts";'],
      ["revoir-access.ts", 'export type { RevoirRefus } from "./salle3d-types.ts";'],
    ];
    for (const [file, ligne] of reexports) {
      assert.ok(lire_(file).includes(ligne), `${file} : ${ligne}`);
      assert.doesNotMatch(lire_(file), /\btype\s+(?:ReplaySpeed|ReplayBadge|LegendeKey|RevoirRefus)\s*=/, `${file} : copie restante`);
    }
    // Égalité des types (vérifiée par typecheck) : aucune valeur de plus ni de moins que le §4.1.1.
    type Egal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
    const vitesses: Egal<ReplaySpeed, 0.25 | 0.5 | 1 | 2 | 4> = true;
    const badges: Egal<ReplayBadge, { etat: "direct" } | { etat: "differe"; vitesse: 0.25 | 0.5 | 1 | 2 | 4; heure: number }> = true;
    assert.ok(vitesses && badges);
  });
});
