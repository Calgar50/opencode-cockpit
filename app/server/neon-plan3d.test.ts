// Plan 3D pur (spécification §5.8 l.992-997, §5.7.1 l.934-945, §5.7.3 l.967-976, P12, JP-6, JP-8 ; plan d'exécution it3, fiche
// L29a ; D-3d-07, D-3d-16, D-3d-19) : « différé = direct » sur les captures p1, p2, p6 et p7 ; honnêteté du dessin (chaque nœud,
// faisceau, marque et lot de tuiles recopie les faits de la scène) ; positions stables ; aucune géométrie liée à un coût ni à une
// durée ; 60 étiquettes au plus ; grammaire (formes et jetons) ; pureté du module.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { PLAN3D, PLAN3D_CAMERA, planConversation, type PlanConversationOptions } from "./shared/neon-plan3d.ts";
import { EventMemory, type FactContext, FactDeduper, type FactEvent, factsFromEvent, type FactSession } from "./shared/activity-facts.ts";
import type { ActivityFact, ActivityFactKind, FactValue } from "./shared/activity-types.ts";
import { NEON_GRAMMAIRE, NEON_SIGNE_FAISCEAU } from "./shared/neon-palette.ts";
import { moments, NEON_CADRE, type NeonScene, type NeonSceneOptions, scene, visibleCount } from "./shared/neon-scene.ts";
import type { Plan3d } from "./shared/salle3d-types.ts";
import { readCapture } from "./test-support/fake-opencode.ts";

const ROOT = "ses_f618ff214ffevi6gfuGx6TvpTP";
const P1_E2 = "ses_f618fbb91ffepC06O3owB9ayZ7";
/** Messages envoyés par le cockpit dans les captures (demande de p1, commande de p2, demande de p6). */
const SENT_BY_COCKPIT = new Set(["msg_09e702c4e001phPA6LcfC9t4WK", "msg_09e70de68001w3xwbgF26JxZPW", "msg_09e75b36c001x5Cehfmxl57pRZ"]);
const CAPTURES = ["p1-delegation-parallele.jsonl", "p2-commande-subtask.jsonl", "p6-arret-global.jsonl", "p7-autorisation-orpheline.jsonl"] as const;

const AVANCE: NeonSceneOptions = { zoom: 2, mode: "avance" };
const SIMPLE: NeonSceneOptions = { zoom: 2, mode: "simple" };
const ZOOM3: NeonSceneOptions = { zoom: 3, mode: "avance" };
const VUES: readonly NeonSceneOptions[] = [AVANCE, SIMPLE, ZOOM3];
const PLAN: PlanConversationOptions = { theme: "sombre", mode: "avance" };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const plan = (facts: readonly ActivityFact[], t: number | null, vue: NeonSceneOptions = AVANCE, options: PlanConversationOptions = PLAN): Plan3d =>
  planConversation(scene(facts, t, vue), options);

// --- Faits des captures (même chemin que le magasin : factsFromEvent puis FactDeduper) -----------------------------------------

/** Rejoue une capture comme le direct : faits dérivés événement par événement, doublons écartés. */
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

/** Faits relus comme depuis la base : data sérialisé en JSON, puis relu. */
const stored = (facts: readonly ActivityFact[]): ActivityFact[] =>
  facts.map((f, i) => ({ id: i + 1, rootId: f.rootId, sessionId: f.sessionId, kind: f.kind, ref: f.ref, data: JSON.parse(JSON.stringify(f.data)), at: f.at }));

// --- Histoires synthétiques ---------------------------------------------------------------------------------------------------

const R = "ses_racine";

class Story {
  readonly facts: ActivityFact[] = [];
  #at = 1_000;

  add(sessionId: string, kind: ActivityFactKind, data: Record<string, FactValue>, ref: string | null = null): number {
    this.#at += 10;
    this.facts.push({ rootId: R, sessionId, kind, ref, data, at: this.#at });
    return this.facts.length - 1;
  }
  demande(messageId: string) {
    return this.add(R, "origine", { origine: "demande", cas: 1, messageId }, messageId);
  }
  occupee(sessionId: string) {
    return this.add(sessionId, "statut", { etat: "occupee" });
  }
  delegate(parent: string, callId: string, messageId: string, enfant: string, agent: string) {
    this.add(parent, "consigne", { etat: "prepare", callId, messageId }, callId);
    this.add(enfant, "statut", { etat: "creee", role: "delegation", parent, agent, instance: "principale" });
    this.add(parent, "consigne", { etat: "envoyee", callId, messageId, enfant, agent, source: "ia", commande: null, reprise: false }, callId);
    return this.occupee(enfant);
  }
  resultat(parent: string, callId: string, enfant: string, etat: "rendu" | "echec" | "interrompu") {
    return this.add(parent, "resultat", { etat, callId, messageId: "msg_r", enfant }, callId);
  }
  outil(sessionId: string, callId: string, outil: string, phase: string, fichier: string | null = null, dossier: string | null = null) {
    return this.add(sessionId, "statut", { etat: "outil", outil, nom: outil, phase, callId, messageId: "msg_o", fichier, dossier }, callId);
  }
  attente(sessionId: string, permissionId: string, callId: string) {
    return this.add(sessionId, "attente", { permission: "edit", messageId: "msg_o", callId, agent: null }, permissionId);
  }
}

/** Histoire complète : demande, deux délégations en même temps, attente, décision, appel d'IA, outils, marque d'origine. */
function histoire(): ActivityFact[] {
  const s = new Story();
  s.demande("msg_1");
  s.occupee(R);
  s.add(R, "statut", { etat: "appel", messageId: "msg_1" });
  s.delegate(R, "call_a", "msg_1", "ses_a", "explore");
  s.delegate(R, "call_b", "msg_1", "ses_b", "plan");
  s.outil("ses_a", "call_l1", "lire", "termine", "f1", "d1");
  s.outil("ses_a", "call_l2", "modifier", "termine", "f2", "d1");
  s.outil("ses_a", "call_l3", "chercher", "erreur", "f3", "d1");
  s.outil("ses_a", "call_l4", "lire", "en-cours", "f4", "d2");
  s.attente("ses_b", "per_1", "call_e1");
  s.add(R, "decision", { verdict: "auto", regle: "E1", par: "regles" }, "per_2");
  s.add("ses_b", "origine", { origine: "relance-extension", cas: 5, messageId: "msg_9" }, "msg_9");
  s.resultat(R, "call_a", "ses_a", "rendu");
  return s.facts;
}

// --- « différé = direct » (P12, JP-8, spéc. §7.1 l.1085) ------------------------------------------------------------------------

describe("différé = direct", () => {
  for (const name of CAPTURES) {
    it(`${name} : à chaque moment, le plan des faits relus depuis la base est celui du préfixe en direct`, () => {
      const direct = replay(name);
      const reread = stored(direct);
      let compares = 0;
      for (const t of moments(reread)) {
        const prefixe = direct.slice(0, visibleCount(direct, t));
        for (const vue of VUES) assert.deepEqual(plan(reread, t, vue), plan(prefixe, null, vue), `t=${t} ${JSON.stringify(vue)}`);
        compares += 1;
      }
      assert.ok(compares >= 10, `moments comparés : ${compares}`);
      for (const vue of VUES) assert.deepEqual(plan(reread, null, vue), plan(direct, null, vue));
    });
  }

  // Reste connu (porte P-IT2 souple, plan it3 §7.2) : la fixture de l'itération 2 (L10a) n'est pas dans cette branche ; le
  // croisement est repris à la grande fusion. La fixture n'est jamais fabriquée ici.
  const p8 = path.join(import.meta.dirname, "test-support", "fixtures", "autonomie-p8.jsonl");
  const p8Absente = !fs.existsSync(p8);
  it(
    "autonomie-p8.jsonl : même contrôle sur la fixture des décisions",
    { skip: p8Absente ? "fixture autonomie-p8.jsonl absente de la branche (it2, L10a) : croisement repris à la grande fusion" : false },
    () => {
      const direct = replay("autonomie-p8.jsonl");
      const reread = stored(direct);
      for (const t of moments(reread)) {
        const prefixe = direct.slice(0, visibleCount(direct, t));
        for (const vue of VUES) assert.deepEqual(plan(reread, t, vue), plan(prefixe, null, vue), `t=${t}`);
      }
    },
  );
});

// --- Honnêteté du dessin (P12) --------------------------------------------------------------------------------------------------

/** Éléments du plan qui portent des faits : le décor (stations, territoires, caméra, étiquettes) n'en porte pas. */
function signes(p: Plan3d): { quoi: string; faits: readonly number[] }[] {
  return [
    ...p.noeuds.map((n) => ({ quoi: `nœud ${n.id}`, faits: n.faits })),
    ...p.faisceaux.map((f) => ({ quoi: `faisceau ${f.id}`, faits: f.faits })),
    ...p.marques.map((m) => ({ quoi: `marque ${m.id}`, faits: m.faits })),
    ...p.tuiles.map((t) => ({ quoi: `tuiles ${t.dossier}/${t.etat}`, faits: t.faits })),
  ];
}

describe("honnêteté du dessin (P12)", () => {
  it("captures : chaque nœud, faisceau, marque et lot de tuiles porte des faits visibles de la conversation", () => {
    for (const name of CAPTURES) {
      const facts = replay(name);
      for (const t of [...moments(facts).filter((_, i) => i % 5 === 0), null]) {
        const n = visibleCount(facts, t);
        for (const vue of VUES) {
          const p = plan(facts, t, vue);
          const tous = signes(p);
          assert.ok(tous.length > 0, `${name} ${t}`);
          for (const signe of tous) {
            assert.ok(signe.faits.length > 0, `${name} : ${signe.quoi} sans fait`);
            for (const i of signe.faits) {
              assert.ok(Number.isInteger(i) && i >= 0 && i < n, `${name} : ${signe.quoi} référence le fait ${i} sur ${n}`);
              assert.equal(facts[i]?.rootId, p.rootId, `${name} : ${signe.quoi} référence une autre conversation`);
            }
          }
        }
      }
    }
  });

  it("les faits sont recopiés de la scène, jamais inventés ni réordonnés", () => {
    const facts = histoire();
    const vue = scene(facts, null, ZOOM3);
    const p = planConversation(vue, PLAN);
    for (const noeud of p.noeuds) assert.deepEqual(noeud.faits, vue.noeuds.find((n) => n.sessionId === noeud.id)?.faits, noeud.id);
    for (const faisceau of p.faisceaux) assert.deepEqual(faisceau.faits, vue.faisceaux.find((f) => f.id === faisceau.id)?.faits, faisceau.id);
    for (const attente of vue.attentes) assert.deepEqual(p.marques.find((m) => m.id === `attente:${attente.permissionId}`)?.faits, attente.faits);
    // Les faits recopiés ne partagent pas le tableau de la scène : modifier le plan ne modifie pas la scène.
    p.noeuds[0]?.faits.push(999);
    assert.equal(vue.noeuds[0]?.faits.includes(999), false);
  });

  it("une tuile sans état à montrer n'entre dans aucun lot ; les autres sont groupées par dossier et par état", () => {
    const vue = scene(histoire(), null, { zoom: 3, mode: "avance", focus: "ses_a" });
    const dossier1 = vue.detail?.dossiers.find((d) => d.dossier === "d1");
    assert.equal(dossier1?.tuiles.length, 3, "d1 : lue, modifiée et une tuile d'outil en échec");
    const lots = planConversation(vue, PLAN).tuiles;
    assert.deepEqual(
      lots.map((l) => `${l.dossier}:${l.etat}:${l.positions.length}`),
      ["d1:modifie:1", "d1:lu:1", "d2:en-cours:1"],
    );
    for (const lot of lots) assert.equal(lot.positions.length, lot.faits.length > 0 ? lot.positions.length : 0);
    assert.ok(lots.every((l) => l.faits.length > 0));
  });

  it("zoom 2 : aucune tuile ; le zoom 3 nomme l'assistant détaillé", () => {
    const facts = replay("p1-delegation-parallele.jsonl");
    assert.deepEqual(plan(facts, null, AVANCE).tuiles, []);
    assert.equal(plan(facts, null, AVANCE).focus, null);
    assert.equal(planConversation(scene(facts, null, { zoom: 3, mode: "avance", focus: P1_E2 }), PLAN).focus, P1_E2);
    assert.ok(planConversation(scene(facts, null, { zoom: 3, mode: "avance", focus: P1_E2 }), PLAN).tuiles.length > 0);
  });
});

// --- Géométrie constante ---------------------------------------------------------------------------------------------------------

describe("géométrie : constantes seulement (§5.7.1 l.945)", () => {
  it("échelle, hauteurs, arc et plafond d'étiquettes", () => {
    assert.deepEqual(PLAN3D, { echelle: 0.05, hauteurs: { sol: 0, station: 0.4, noeud: 0.6, marque: 0.9, tuile: 0.1 }, arc: 1.2, arcParAnneau: 0.2, etiquettesMax: 60 });
    assert.equal(Object.isFrozen(PLAN3D) && Object.isFrozen(PLAN3D.hauteurs), true);
    assert.deepEqual(PLAN3D_CAMERA.distances, { 1: 26, 2: 15, 3: 9 });
  });

  it("position 3D = ((x − 280) × échelle, hauteur du genre, (y − 110) × échelle)", () => {
    const facts = histoire();
    const vue = scene(facts, null, AVANCE);
    const p = planConversation(vue, PLAN);
    const attendu = (q: { x: number; y: number }, hauteur: number) => ({
      x: Math.round((q.x - NEON_CADRE.largeur / 2) * PLAN3D.echelle * 1e6) / 1e6,
      y: hauteur,
      z: Math.round((q.y - NEON_CADRE.hauteur / 2) * PLAN3D.echelle * 1e6) / 1e6,
    });
    for (const noeud of vue.noeuds) assert.deepEqual(p.noeuds.find((n) => n.id === noeud.sessionId)?.position, attendu(noeud.position, PLAN3D.hauteurs.noeud), noeud.sessionId);
    for (const station of vue.stations) assert.deepEqual(p.stations.find((s) => s.id === station.id)?.position, attendu(station.position, PLAN3D.hauteurs.station), station.id);
    // La conversation est au centre du cadre : origine du monde.
    assert.deepEqual(p.noeuds.find((n) => n.role === "conversation")?.position, { x: 0, y: PLAN3D.hauteurs.noeud, z: 0 });
    assert.deepEqual(p.stations.map((s) => s.id).sort(), ["carnet", "copilot", "vous"]);
  });

  it("faisceau : point de contrôle au milieu, élevé de arc + arcParAnneau × anneau ; cible inconnue = départ", () => {
    const s = new Story();
    s.demande("msg_1");
    s.occupee(R);
    s.add(R, "consigne", { etat: "prepare", callId: "call_p", messageId: "msg_1" }, "call_p");
    s.delegate(R, "call_a", "msg_1", "ses_a", "explore");
    s.delegate("ses_a", "call_c", "msg_2", "ses_c", "plan");
    const p = plan(s.facts, null, AVANCE);
    const hauteur = (anneau: number) => Math.round((PLAN3D.hauteurs.noeud + PLAN3D.arc + PLAN3D.arcParAnneau * anneau) * 1e6) / 1e6;
    const preparation = p.faisceaux.find((f) => f.kind === "preparation");
    assert.ok(preparation);
    assert.equal(preparation.vers, null);
    assert.deepEqual(preparation.controle, { x: preparation.de.x, y: hauteur(0), z: preparation.de.z });
    const consigne = p.faisceaux.find((f) => f.id === "consigne:ses_racine:call_a");
    assert.ok(consigne?.vers);
    const milieu = (a: number, b: number) => Math.round(((a + b) / 2) * 1e6) / 1e6;
    assert.deepEqual(consigne.controle, { x: milieu(consigne.de.x, consigne.vers.x), y: hauteur(1), z: milieu(consigne.de.z, consigne.vers.z) });
    // Sous-délégation : anneau du parent plus sa vague, donc un arc plus haut.
    const sous = p.faisceaux.find((f) => f.id === "consigne:ses_a:call_c");
    assert.equal(sous?.controle.y, hauteur(2));
  });

  it("caméra : cible au centre, 55°, 35°, distance fixe par zoom", () => {
    const facts = histoire();
    assert.deepEqual(plan(facts, null, AVANCE).camera, { cible: { x: 0, y: 0, z: 0 }, distance: PLAN3D_CAMERA.distances[2], inclinaisonDeg: 55, fovDeg: 35 });
    assert.equal(plan(facts, null, ZOOM3).camera.distance, PLAN3D_CAMERA.distances[3]);
    assert.equal(plan(facts, null, ZOOM3).zoom, 3);
  });

  it("aucune géométrie ne dépend d'un coût ni d'une durée", () => {
    for (const name of CAPTURES) {
      const facts = replay(name);
      // Coûts multipliés, heures décalées : mêmes plans, au bit près.
      const autres = facts.map((f): ActivityFact => {
        const data: Record<string, FactValue> = { ...f.data };
        if (typeof data.cout === "number") data.cout = data.cout * 7 + 3;
        if (typeof data.debut === "number") data.debut += 60_000;
        return { ...f, at: f.at + 60_000, data };
      });
      for (const vue of VUES) assert.deepEqual(plan(autres, null, vue), plan(facts, null, vue), name);
    }
  });
});

// --- Positions stables (D-3d-16) ---------------------------------------------------------------------------------------------

describe("positions stables", () => {
  it("un fait ajouté ne déplace aucun nœud, faisceau ni marque déjà placé", () => {
    for (const name of CAPTURES) {
      const facts = replay(name);
      const places = new Map<string, string>();
      for (const t of [...moments(facts), null]) {
        for (const element of [...plan(facts, t, AVANCE).noeuds, ...plan(facts, t, AVANCE).faisceaux, ...plan(facts, t, AVANCE).marques]) {
          const cle = `${name}|${element.id}`;
          const ou = JSON.stringify("position" in element ? element.position : [element.de, element.controle, element.vers]);
          const connu = places.get(cle);
          if (connu !== undefined) assert.equal(ou, connu, `${cle} déplacé`);
          places.set(cle, ou);
        }
      }
      assert.ok(places.size > 0, name);
    }
  });
});

// --- Grammaire (formes, jetons, halos, animation) ------------------------------------------------------------------------------

describe("grammaire : la forme d'abord (§5.7.1)", () => {
  it("demande → flèche, préparation → pointillé, consigne → chevrons, résultat → losanges ; jetons de NEON_GRAMMAIRE", () => {
    const s = new Story();
    s.demande("msg_1");
    s.occupee(R);
    s.add(R, "consigne", { etat: "prepare", callId: "call_p", messageId: "msg_1" }, "call_p");
    s.delegate(R, "call_a", "msg_1", "ses_a", "explore");
    s.delegate(R, "call_b", "msg_1", "ses_b", "plan");
    // La consigne de « call_a » se referme sur son résultat ; celle de « call_b » reste ouverte.
    s.resultat(R, "call_a", "ses_a", "rendu");
    const p = plan(s.facts, null, AVANCE);
    const par = new Map(p.faisceaux.map((f) => [f.kind, f]));
    assert.deepEqual([...par.keys()].sort(), ["consigne", "demande", "preparation", "resultat"]);
    assert.deepEqual(
      [...par.entries()].map(([kind, f]) => `${kind}:${f.forme}:${f.jeton}`).sort(),
      ["consigne:chevrons:consigne", "demande:fleche:vous", "preparation:pointille:consigne", "resultat:losanges:resultat"],
    );
    for (const [kind, f] of par) assert.equal(f.jeton, NEON_GRAMMAIRE[NEON_SIGNE_FAISCEAU[kind]].trait, kind);
  });

  it("arrêt : les faisceaux figés gardent leur forme et prennent le trait d'arrêt ; une marque d'arrêt les accompagne", () => {
    const s = new Story();
    s.demande("msg_1");
    s.occupee(R);
    s.delegate(R, "call_a", "msg_1", "ses_a", "explore");
    s.add(R, "statut", { cause: "arret" });
    const p = plan(s.facts, null, AVANCE);
    const figes = p.faisceaux.filter((f) => f.fige);
    assert.ok(figes.length >= 2);
    for (const f of figes) {
      assert.equal(f.jeton, NEON_GRAMMAIRE.arret.trait, f.id);
      assert.equal(f.ouvert, false, f.id);
      assert.equal(f.forme, f.kind === "consigne" ? "chevrons" : "fleche", f.id);
    }
    const arret = p.marques.find((m) => m.kind === "arret");
    assert.equal(arret?.jeton, NEON_GRAMMAIRE.arret.trait);
    assert.deepEqual(arret?.position, { x: 0, y: PLAN3D.hauteurs.marque, z: 0 });
    // Un faisceau figé n'est plus « ouvert » : il ne défile plus. L'arrêt seul ne change pas l'état des assistants (neon-scene.ts).
    assert.equal(p.faisceaux.some((f) => f.ouvert), false);
  });

  it("marques : attente, décision, impulsion, origine ; l'extension en orange, les autres origines discrètes", () => {
    const p = plan(histoire(), null, AVANCE);
    const genres = p.marques.map((m) => `${m.kind}:${m.jeton}`);
    assert.ok(genres.includes(`attente:${NEON_GRAMMAIRE.attente.trait}`), JSON.stringify(genres));
    assert.ok(genres.includes(`auto:${NEON_GRAMMAIRE.auto.trait}`), JSON.stringify(genres));
    assert.ok(genres.includes(`impulsion:${NEON_GRAMMAIRE.appel.trait}`), JSON.stringify(genres));
    assert.ok(genres.includes(`origine:${NEON_GRAMMAIRE.extension.trait}`), JSON.stringify(genres));
    assert.equal(new Set(p.marques.map((m) => m.id)).size, p.marques.length, "identifiants de marques distincts");
    // Impulsion : au milieu du trajet vers la station « GitHub Copilot ».
    const copilot = p.stations.find((s) => s.id === "copilot");
    const impulsion = p.marques.find((m) => m.kind === "impulsion");
    assert.ok(copilot && impulsion);
    assert.equal(impulsion.position.z, (0 + copilot.position.z) / 2);
    assert.equal(impulsion.position.y, PLAN3D.hauteurs.marque);
  });

  it("halo et animation : « travaille » pulsé, attente d'accord statique, rien sinon", () => {
    const s = new Story();
    s.demande("msg_1");
    s.occupee(R);
    s.delegate(R, "call_a", "msg_1", "ses_a", "explore");
    s.attente("ses_a", "per_1", "call_e1");
    const p = plan(s.facts, null, AVANCE);
    assert.equal(p.noeuds.find((n) => n.id === R)?.halo, "travaille");
    assert.equal(p.noeuds.find((n) => n.id === "ses_a")?.halo, "statique");
    assert.equal(p.anime, true);
    // Tout au repos : plus rien ne s'anime, donc aucune boucle d'images (D-3d-17).
    const repos = new Story();
    repos.demande("msg_1");
    repos.occupee(R);
    repos.add(R, "statut", { etat: "repos" });
    const calme = plan(repos.facts, null, AVANCE);
    assert.deepEqual(calme.noeuds.map((n) => n.halo), ["aucun"]);
    assert.equal(calme.anime, false);
    assert.equal(calme.faisceaux.length, 0);
  });

  it("nom et état d'un nœud recopiés ; le carnet est vide hors de la salle ; ni territoire ni enceinte aux zooms 2 et 3", () => {
    const vue = scene(histoire(), null, AVANCE);
    const p = planConversation(vue, { theme: "clair", mode: "simple" });
    assert.equal(p.theme, "clair");
    assert.equal(p.mode, "simple");
    assert.equal(p.rootId, R);
    assert.equal(p.carnetVide, true);
    assert.deepEqual(p.territoires, []);
    assert.equal(p.enceinte, null);
    for (const noeud of vue.noeuds) {
      const traduit = p.noeuds.find((n) => n.id === noeud.sessionId);
      assert.equal(traduit?.nom, noeud.agent, noeud.sessionId);
      assert.equal(traduit?.etat, noeud.etat, noeud.sessionId);
      assert.equal(traduit?.secteur, noeud.secteur, noeud.sessionId);
      assert.equal(traduit?.parentId, noeud.parentId, noeud.sessionId);
    }
  });
});

// --- Étiquettes (D-3d-19) ------------------------------------------------------------------------------------------------------

describe("étiquettes DOM", () => {
  it("200 assistants : 60 étiquettes au plus, celle de la conversation comprise, par ordre de priorité", () => {
    const s = new Story();
    s.demande("msg_1");
    s.occupee(R);
    for (let i = 0; i < 200; i++) {
      s.delegate(R, `call_${i}`, `msg_${i}`, `ses_${i}`, i % 3 === 0 ? "explore" : "plan");
      // 20 attendent votre accord, 20 travaillent encore, les 160 autres ont rendu leur travail.
      if (i % 10 === 0) s.attente(`ses_${i}`, `per_${i}`, `call_e${i}`);
      else if (i % 10 !== 1) s.resultat(R, `call_${i}`, `ses_${i}`, "rendu");
    }
    const p = plan(s.facts, null, AVANCE);
    assert.equal(p.noeuds.length, 201);
    assert.equal(p.etiquettes.length, PLAN3D.etiquettesMax);
    assert.equal(p.etiquettes[0]?.cible, R, "la conversation d'abord");
    assert.equal(p.etiquettes[0]?.priorite, 0);
    // Ordre de tabulation = priorité, puis rang d'apparition ; aucune priorité ne précède une plus forte.
    const priorites = p.etiquettes.map((e) => e.priorite);
    assert.deepEqual(priorites, [...priorites].sort((a, b) => a - b));
    assert.ok(priorites.filter((v) => v === 1).length > 0, "des assistants qui travaillent");
    assert.ok(priorites.filter((v) => v === 2).length > 0, "des assistants en attente de votre accord");
    assert.equal(new Set(p.etiquettes.map((e) => e.cible)).size, p.etiquettes.length);
    // Chaque étiquette désigne un nœud du plan, au-dessus de lui, et ne porte aucun texte de message.
    for (const etiquette of p.etiquettes) {
      const noeud = p.noeuds.find((n) => n.id === etiquette.cible);
      assert.ok(noeud, etiquette.cible);
      assert.deepEqual(etiquette.position, { x: noeud.position.x, y: PLAN3D.hauteurs.marque, z: noeud.position.z });
      assert.equal(etiquette.nom, noeud.nom);
      assert.equal(etiquette.etat, noeud.etat);
    }
  });

  it("attente d'accord avant les autres, « travaille » avant l'attente", () => {
    const s = new Story();
    s.demande("msg_1");
    s.occupee(R);
    s.delegate(R, "call_a", "msg_1", "ses_a", "explore");
    s.resultat(R, "call_a", "ses_a", "rendu");
    s.delegate(R, "call_b", "msg_1", "ses_b", "plan");
    s.attente("ses_b", "per_1", "call_e1");
    s.delegate(R, "call_c", "msg_1", "ses_c", "plan");
    const p = plan(s.facts, null, AVANCE);
    assert.deepEqual(p.etiquettes.map((e) => `${e.cible}:${e.priorite}`), [`${R}:0`, "ses_c:1", "ses_b:2", "ses_a:3"]);
  });
});

// --- Pureté ---------------------------------------------------------------------------------------------------------------------

describe("pureté du plan 3D", () => {
  it("ni module node, ni process, ni horloge, ni aléa, ni réseau ; imports voisins seulement", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "shared", "neon-plan3d.ts"), "utf8");
    assert.equal(source.includes('"node:'), false);
    assert.equal(/\bprocess\./.test(source), false);
    assert.equal(/\bDate\.now\b|new Date\b|Math\.random|\bfetch\s*\(|\bsetTimeout\b|\bsetInterval\b|\bperformance\.|\bcrypto\./.test(source), false);
    for (const spec of [...source.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1] ?? "")) assert.match(spec, /^\.\/[\w.-]+\.ts$/, spec);
  });

  it("même scène, même plan ; ni la scène ni la liste des faits ne sont modifiées", () => {
    const facts = replay("p1-delegation-parallele.jsonl");
    const copie = JSON.stringify(facts);
    for (const vue of VUES) {
      const s = scene(facts, null, vue);
      const avant = JSON.stringify(s);
      assert.deepEqual(planConversation(s, PLAN), planConversation(s, PLAN));
      assert.equal(JSON.stringify(s), avant, "la scène n'est pas modifiée");
    }
    assert.equal(JSON.stringify(facts), copie);
  });

  it("aucun texte de message, aucune heure et aucun coût dans un plan", () => {
    for (const name of CAPTURES) {
      const facts = replay(name);
      for (const vue of VUES) {
        const p = plan(facts, null, vue);
        const ecrit = JSON.stringify(p);
        assert.equal(/"(?:depuis|at|cout|duree|texte|titre)"\s*:/.test(ecrit), false, `${name} ${JSON.stringify(vue)}`);
        // Les seules heures du magasin sont des entiers de plus de 12 chiffres : aucun ne doit apparaître.
        assert.equal(/\b1[6-9]\d{11}\b/.test(ecrit), false, name);
      }
    }
  });

  it("scène vide : plan vide, mais décor et caméra présents", () => {
    const p = plan([], null, AVANCE);
    assert.deepEqual([p.noeuds, p.faisceaux, p.marques, p.tuiles, p.etiquettes, p.territoires], [[], [], [], [], [], []]);
    assert.equal(p.rootId, null);
    assert.equal(p.anime, false);
    assert.equal(p.stations.length, 3);
    assert.equal(p.camera.fovDeg, 35);
  });
});
