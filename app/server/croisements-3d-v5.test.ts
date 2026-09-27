// Tests de croisement du train de la vague 5 (itération « 3s » ; plan d'exécution it3 §2.4, §5.2 ligne V5, §8.4 (b) ; propriété
// de l'intégrateur). « 3s » est posée sur chantier/1.1 après F1 (GF1 : salle HS ; GF2 : 3D H3). Paquets de la vague : L3s-a,
// fusionné ; L3s-b, arrêté sans commit (P-CAPTURE fermée par la décision du lancement : la démonstration réelle de la salle et M20
// réel demandent des appels facturés, décision (4) du 17/09). L3s-a a ses propres croisements (croisements-3d-salle.test.ts,
// salle3d-hors-bornes.test.ts) ; ici, seulement ce qui ne se voit qu'une fois la vague posée sur le code complet :
//   1. L3s-a × L25b : legendes-salle.ts RECOPIE la règle du carnet de neon-scene.ts (chemin relatif sous .omo, clé de fichier) et
//      lit `fond` comme metadonneesOf. Deux copies d'une même règle dérivent en silence : un fait `carnet` est « touché » pour la
//      légende si et seulement si la scène dessine sa tuile, la légende « carnet » de la conversation suit la tuile, et « tâche de
//      fond » est dite si et seulement si la scène porte l'attente `fond` de la consigne (P12 : aucune phrase sans le signe qui la
//      justifie ; JP-3, JP-6, JP-7).
//   2. L3s-a × L3s-a × L3s-a, sur le cockpit réel à deux instances : « Revoir », ses consignes gardées et le zoom 1 (territoires)
//      sont trois services réécrits séparément pour reconnaître la salle par omo_rooms. Sur le cas de doute (omo_rooms connaît la
//      racine, `sessions` dit « principale ») ils rendent la MÊME décision — la salle —, dans les deux modes, et aucun ne demande
//      quoi que ce soit au client principal pour elle (P11). Témoin : sans la ligne omo_rooms, conversation principale partout.
//   3. L3s-b × le dépôt (P-CAPTURE fermée) : la démonstration de la salle n'existe jamais sans son test D-2b-31, son générateur et
//      son entrée du lecteur, ni le scénario de débit de la salle sans capture du banc ; tant qu'elle manque : « en attente ».
//   4. Constantes au train : « 3s » ne bascule rien (salle livrée fermée, activation ouverte, Simple par défaut, équipes de F2
//      absentes).
// Aucun appel facturé, aucun vrai opencode : deux faux opencode (option omo du harnais, T3b). Textes : « [synthétique] ».
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { parseOmo } from "./env.ts";
import { DEFAULT_SETTINGS } from "./settings.ts";
import type { ActivityFact, ActivityFactKind, FactValue } from "./shared/activity-types.ts";
import { legendesAuMoment } from "./shared/legendes.ts";
import { carnetTouche, tacheDeFond } from "./shared/legendes-salle.ts";
import { moments, scene } from "./shared/neon-scene.ts";
import { roleDeAgent } from "./shared/omo-roles.ts";
import type { RevoirResponse, TerritoiresResponse } from "./shared/salle3d-types.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import { ACTIVATION_OUVERTE, SALLE_OUVERTE } from "./wiring-11.ts";

const APP_DIR = path.join(import.meta.dirname, "..");
const existe = (relatif: string): boolean => fs.existsSync(path.join(APP_DIR, relatif));
const lire = (relatif: string): string => fs.readFileSync(path.join(APP_DIR, relatif), "utf8");

// --- 1. Règles recopiées : légendes de la salle (L3s-a) contre scène de la salle (L25b) ----------------------------------------------

const R = "ses_v5_racine";
const ENFANT = "ses_v5_enfant";

/** Suite de faits d'une racine de la salle : sa création porte `instance: "omo"`, fait que seule la salle écrit (faitDeLaSalle). */
class SuiteSalle {
  readonly faits: ActivityFact[] = [];
  #at = 1_000;

  constructor() {
    this.add(R, "statut", { etat: "creee", role: "conversation", parent: null, agent: null, instance: "omo" });
    this.add(R, "statut", { etat: "occupee" });
  }

  add(sessionId: string, kind: ActivityFactKind, data: Record<string, FactValue>, ref: string | null = null): ActivityFact {
    this.#at += 10;
    const fait: ActivityFact = { id: this.faits.length + 1, rootId: R, sessionId, kind, ref, data, at: this.#at };
    this.faits.push(fait);
    return fait;
  }

  /** Consigne envoyée par la conversation à ENFANT, avec les clés de consigneOmo (L25a) ; `fond` absent si `undefined`. */
  consigne(callId: string, fond: FactValue | undefined): ActivityFact {
    const data: Record<string, FactValue> = {
      etat: "envoyee",
      callId,
      messageId: `msg_${callId}`,
      enfant: ENFANT,
      agent: "sisyphus-junior",
      source: "ia",
      commande: null,
      reprise: false,
      categorie: "quick",
      ia: null,
      competences: 0,
    };
    if (fond !== undefined) data.fond = fond;
    return this.add(R, "consigne", data, callId);
  }
}

/** Index (0-based) d'un fait dans sa suite, tel que la scène le recopie dans `faits`. */
const indexDe = (suite: SuiteSalle, fait: ActivityFact): number => suite.faits.indexOf(fait);

/** Légendes de tous les moments d'une suite de la salle. */
const legendesSalle = (faits: readonly ActivityFact[]) => moments(faits).flatMap((t) => legendesAuMoment(faits, t, { salle: true }));

/** Variantes d'un fait `carnet` : chemin relatif du carnet ou d'un plan, clé de fichier de 16 chiffres hexadécimaux en minuscules. */
const CLE = "00000000000000c1";
const VARIANTES_CARNET: ReadonlyArray<{ nom: string; data: Record<string, FactValue> }> = [
  { nom: "carnet lu", data: { etat: "lu", chemin: ".omo/notepads/n.md", fichier: CLE } },
  { nom: "plan modifié", data: { etat: "modifie", chemin: ".omo/plans/plan.md", fichier: CLE } },
  { nom: "90 caractères après le dossier (borne)", data: { etat: "lu", chemin: `.omo/notepads/${"a".repeat(90)}`, fichier: CLE } },
  { nom: "91 caractères après le dossier", data: { etat: "lu", chemin: `.omo/notepads/${"a".repeat(91)}`, fichier: CLE } },
  { nom: "barre finale", data: { etat: "lu", chemin: ".omo/notepads/", fichier: CLE } },
  { nom: "remontée", data: { etat: "lu", chemin: ".omo/notepads/../../secret", fichier: CLE } },
  { nom: "chemin absolu", data: { etat: "lu", chemin: "/workspace/proj/.omo/notepads/n.md", fichier: CLE } },
  { nom: "hors du carnet", data: { etat: "lu", chemin: ".omo/autre/n.md", fichier: CLE } },
  { nom: "espace", data: { etat: "lu", chemin: ".omo/notepads/n m.md", fichier: CLE } },
  { nom: "état inconnu", data: { etat: "ecrit", chemin: ".omo/notepads/n.md", fichier: CLE } },
  { nom: "clé en majuscules", data: { etat: "lu", chemin: ".omo/notepads/n.md", fichier: "00000000000000C1" } },
  { nom: "clé trop courte", data: { etat: "lu", chemin: ".omo/notepads/n.md", fichier: "0000000000000c1" } },
  { nom: "chemin qui n'est pas un texte", data: { etat: "lu", chemin: 42, fichier: CLE } },
];

describe("croisements V5 : légendes de la salle (L3s-a) et scène de la salle (L25b), deux copies d'une même règle", () => {
  it("fait `carnet` : touché pour la légende ⇔ tuile dessinée par la scène (conversation et assistant) ; légende « carnet » de la conversation ⇔ tuile", () => {
    let touches = 0;
    for (const { nom, data } of VARIANTES_CARNET) {
      // Sur la conversation (qui ne reçoit jamais de consigne) : la légende « carnet » seule suit la tuile.
      const surRacine = new SuiteSalle();
      const faitRacine = surRacine.add(R, "carnet", { ...data, dossier: "00000000000000d0", callId: "call_c", messageId: "msg_c" }, "call_c");
      const vueRacine = scene(surRacine.faits, null, { zoom: 2, mode: "avance", roleSalle: roleDeAgent });
      const tuileRacine = vueRacine.carnet.tuiles.some((tuile) => tuile.faits.includes(indexDe(surRacine, faitRacine)));
      const touche = carnetTouche(faitRacine) !== null;
      assert.equal(touche, tuileRacine, `${nom} : carnetTouche et la tuile de la scène divergent (conversation)`);
      const legendeCarnet = legendesSalle(surRacine.faits).some((l) => l.cles.length === 1 && l.cles[0] === "carnet" && l.sessionId === R);
      assert.equal(legendeCarnet, tuileRacine, `${nom} : légende « carnet » sans tuile, ou tuile sans légende (P12)`);

      // Sur un assistant créé par une consigne : même règle (sa légende « carnet » vient avec sa consigne, pas du fait carnet).
      const surEnfant = new SuiteSalle();
      surEnfant.consigne("call_e", false);
      const faitEnfant = surEnfant.add(ENFANT, "carnet", { ...data, dossier: "00000000000000d0", callId: "call_d", messageId: "msg_d" }, "call_d");
      const vueEnfant = scene(surEnfant.faits, null, { zoom: 2, mode: "avance", roleSalle: roleDeAgent });
      const tuileEnfant = vueEnfant.carnet.tuiles.some((tuile) => tuile.faits.includes(indexDe(surEnfant, faitEnfant)));
      assert.equal(carnetTouche(faitEnfant) !== null, tuileEnfant, `${nom} : carnetTouche et la tuile de la scène divergent (assistant)`);
      if (touche) touches += 1;
    }
    // Contrôle non vide : les deux formes valables (et la borne de 90) dessinent une tuile, les dix autres aucune.
    assert.equal(touches, 3, "trois variantes bien formées attendues");
  });

  it("tâche de fond : légende « tâche de fond » ⇔ attente `fond` portée par la scène (panneau du zoom 3) ; `fond` non booléen : ni l'une ni l'autre", () => {
    const variantes: ReadonlyArray<{ nom: string; fond: FactValue | undefined; attendu: boolean }> = [
      { nom: "fond: true", fond: true, attendu: true },
      { nom: "fond: false", fond: false, attendu: false },
      { nom: "fond: \"true\" (texte)", fond: "true", attendu: false },
      { nom: "fond: 1", fond: 1, attendu: false },
      { nom: "fond: null", fond: null, attendu: false },
      { nom: "fond absent (hors forme de la salle)", fond: undefined, attendu: false },
    ];
    for (const { nom, fond, attendu } of variantes) {
      const suite = new SuiteSalle();
      const consigne = suite.consigne("call_f", fond);
      const detail = scene(suite.faits, null, { zoom: 3, mode: "avance", focus: ENFANT, roleSalle: roleDeAgent }).detail;
      assert.equal(detail?.sessionId, ENFANT, `${nom} : l'assistant de la consigne est dessiné`);
      const attenteFond = detail?.panneau.metadonnees?.attente === "fond";
      const legendeFond = legendesSalle(suite.faits).some((l) => l.cles.includes("tache-de-fond"));
      assert.equal(tacheDeFond(consigne), attendu, `${nom} : prédicat de legendes-salle.ts`);
      assert.equal(attenteFond, attendu, `${nom} : attente de la scène`);
      assert.equal(legendeFond, attenteFond, `${nom} : légende et scène divergent`);
    }
  });
});

// --- 2. « Revoir », consignes et zoom 1 d'accord sur une racine de la salle, sur le cockpit réel --------------------------------------

const DOUTE = "ses_v5_doute";
const DOSSIER = "/workspace/proj";

const requetes = (liste: ReadonlyArray<{ method: string; pathname: string }>, depuis: number): string[] => liste.slice(depuis).map((r) => `${r.method} ${r.pathname}`);

/** Racine récente de l'instance principale selon `sessions`, dans /workspace/proj. */
function poserRacinePrincipale(h: CockpitHarness, rootId: string): void {
  const maintenant = Date.now();
  h.db
    .prepare(
      "INSERT INTO sessions (id, parent_id, root_id, directory, title, purpose, instance, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, 'chat', 'principale', ?, ?)",
    )
    .run(rootId, rootId, DOSSIER, "[synthétique] conversation", maintenant, maintenant);
}

async function territoires(h: CockpitHarness): Promise<TerritoiresResponse> {
  const reponse = await h.call("GET", "/api/salle-controle/territoires", { headers: h.headers.authed });
  assert.equal(reponse.status, 200, reponse.body);
  return reponse.json<TerritoiresResponse>();
}

/** [racine, instance, [Revoir]] des conversations d'un groupe de territoires. */
const entrees = (projets: readonly TerritoiresResponse["projets"][number][] | undefined): Array<[string, string, boolean]> =>
  (projets ?? []).flatMap((p) => p.conversations.map((c): [string, string, boolean] => [c.rootId, c.instance, c.revoir]));

describe("croisements V5 : « Revoir », consignes gardées et zoom 1 rendent la même décision pour une racine de la salle (omo_rooms), P11", () => {
  it("cas de doute (omo_rooms connaît la racine, `sessions` dit « principale ») : la salle pour les trois services, dans les deux modes, rien demandé au client principal ; témoin sans omo_rooms : principale partout", async (t) => {
    const h = await startCockpit(t, { modules: "tous", omo: true });
    assert.ok(h.omo, "harnais à deux instances (T3b)");
    poserRacinePrincipale(h, DOUTE);
    h.db.prepare("INSERT INTO omo_rooms (root_id, projet, created_at) VALUES (?, 'proj', ?)").run(DOUTE, Date.now());
    const avantPrincipal = h.fake.requests.length;
    const avantSalle = h.omo.fake.requests.length;

    // Simple, aucune demande enregistrée : « Revoir » et la consigne refusés avec le MÊME code ; aucune entrée au zoom 1.
    for (const route of [`/api/revoir/${DOUTE}`, `/api/revoir/${DOUTE}/consignes/call_v5`]) {
      const refus = await h.call("GET", route, { headers: h.headers.authed });
      assert.equal(refus.status, 403, `${route} : ${refus.body}`);
      assert.equal((refus.json() as { code?: string }).code, "salle-fin-inconnue", route);
    }
    let zoom1 = await territoires(h);
    assert.deepEqual(entrees(zoom1.projets), [], "jamais rangée parmi les conversations principales");
    assert.deepEqual(entrees(zoom1.salle?.projets), [], "Simple : aucune entrée sans demande terminée");

    // Demande terminée : servie comme une conversation de la salle, et proposée dans l'enceinte du zoom 1.
    h.db
      .prepare("INSERT INTO autonomy_requests (id, root_id, choix, plafonds, started_at, ended_at) VALUES ('aur_v5_doute', ?, 'autonome', '{}', 100, 200)")
      .run(DOUTE);
    const revoir = await h.call("GET", `/api/revoir/${DOUTE}`, { headers: h.headers.authed });
    assert.equal(revoir.status, 200, revoir.body);
    assert.equal(revoir.json<RevoirResponse>().instance, "omo", "annoncée comme la salle, jamais « principale » par défaut");
    zoom1 = await territoires(h);
    assert.deepEqual(entrees(zoom1.projets), []);
    assert.deepEqual(entrees(zoom1.salle?.projets), [[DOUTE, "omo", true]]);
    assert.deepEqual(requetes(h.fake.requests, avantPrincipal), [], "Simple, P11 : zéro requête au faux principal");
    assert.deepEqual(requetes(h.omo.fake.requests, avantSalle), [], "Simple : zéro requête au faux de la salle");

    // Avancé : l'état de la racine est lu sur l'instance de la SALLE, jamais sur le client principal.
    h.settings.update({ ui: { mode: "avance" } });
    const avantSalleAvance = h.omo.fake.requests.length;
    zoom1 = await territoires(h);
    assert.deepEqual(entrees(zoom1.salle?.projets).map(([racine, instance]) => [racine, instance]), [[DOUTE, "omo"]]);
    assert.deepEqual(requetes(h.omo.fake.requests, avantSalleAvance), ["GET /session/status"]);
    assert.deepEqual(requetes(h.fake.requests, avantPrincipal), [], "Avancé, P11 : toujours zéro requête au faux principal");

    // Témoin : sans la ligne omo_rooms, la même racine est une conversation principale pour les trois services.
    h.db.prepare("DELETE FROM omo_rooms WHERE root_id = ?").run(DOUTE);
    h.db.prepare("DELETE FROM autonomy_requests WHERE root_id = ?").run(DOUTE);
    h.settings.update({ ui: { mode: "simple" } });
    const principale = await h.call("GET", `/api/revoir/${DOUTE}`, { headers: h.headers.authed });
    assert.equal(principale.status, 200, `témoin : ${principale.body}`);
    assert.equal(principale.json<RevoirResponse>().instance, "principale");
    const absente = await h.call("GET", `/api/revoir/${DOUTE}/consignes/call_v5`, { headers: h.headers.authed });
    assert.equal(absente.status, 404, `témoin : même accès que « Revoir », consigne simplement absente (${absente.body})`);
    const avantTemoin = h.fake.requests.length;
    zoom1 = await territoires(h);
    assert.deepEqual(entrees(zoom1.projets).map(([racine, instance]) => [racine, instance]), [[DOUTE, "principale"]]);
    assert.equal(zoom1.salle, null);
    assert.deepEqual(requetes(h.fake.requests, avantTemoin), ["GET /session/status"], "témoin : une conversation principale est lue sur le principal");
  });
});

// --- 3. L3s-b arrêté sans commit : P-CAPTURE fermée par décision -----------------------------------------------------------------------

const DEMO_SALLE = "web/pages/chat/activity/demos/salle-omo.json";
const TEST_DEMO_SALLE = "server/demo-salle.test.ts";
const GEN_DEMO_SALLE = "server/test-support/gen-demo-salle.ts";
const LECTEUR = "web/pages/chat/activity/DemoPlayer.tsx";
const DEBIT_SALLE = "../e2e/scenarios/it3-debit-omo.mjs";
const FIXTURES = "server/test-support/fixtures";

describe("croisements V5 : L3s-b arrêté sans commit (P-CAPTURE fermée par la décision du lancement)", () => {
  it("la démonstration de la salle n'existe jamais sans son test D-2b-31, son générateur ni son entrée du lecteur ; le scénario de débit de la salle jamais sans capture du banc", () => {
    const demo = existe(DEMO_SALLE);
    assert.equal(existe(TEST_DEMO_SALLE), demo, "demo-salle.test.ts (règle D-2b-31 propre à la démonstration) ⇔ démonstration présente");
    assert.equal(existe(GEN_DEMO_SALLE), demo, "générateur ⇔ démonstration présente");
    assert.equal(/salle-omo\.json/.test(lire(LECTEUR)), demo, "entrée du lecteur ⇔ démonstration présente");
    if (demo) assert.match(lire(TEST_DEMO_SALLE), /salle-omo\.json/, "le test D-2b-31 lit bien la démonstration de la salle");
    if (existe(DEBIT_SALLE)) {
      const captures = fs.readdirSync(path.join(APP_DIR, FIXTURES)).filter((nom) => /^omo-banc-.+\.jsonl$/.test(nom));
      assert.ok(captures.length > 0, "scénario de débit de la salle sans capture du banc");
      assert.match(lire(DEBIT_SALLE), /omo-banc-/, "le scénario rejoue une capture du banc");
    }
  });

  it(
    "démonstration réelle de la salle (séquence anonymisée) et M20 réel sur la capture du banc",
    {
      skip: existe(DEMO_SALLE)
        ? false
        : "en attente : P-CAPTURE fermée par la décision (4) du 17/09 (appels facturés) ; L3s-b arrêté sans commit, repris par l'orchestrateur à la réouverture de la porte",
    },
    () => {
      assert.ok(existe(TEST_DEMO_SALLE) && existe(DEBIT_SALLE), "démonstration posée : son test D-2b-31 et son scénario de débit l'accompagnent");
    },
  );
});

// --- 4. Constantes : « 3s » ne bascule rien ------------------------------------------------------------------------------------------

describe("croisements V5 : constantes au train", () => {
  it("salle livrée fermée (constante et COCKPIT_OMO par défaut), activation ouverte, Simple par défaut, interrupteur des équipes de F2 absent", () => {
    assert.equal(SALLE_OUVERTE, false);
    assert.equal(ACTIVATION_OUVERTE, true);
    assert.equal(parseOmo({}).enabled, false, "COCKPIT_OMO absent : salle coupée");
    assert.equal(DEFAULT_SETTINGS.ui.mode, "simple");
    // Une seule déclaration de SALLE_OUVERTE dans le code livré, jamais une affectation ailleurs ; l'interrupteur des équipes
    // en Simple (U1) n'arrive qu'avec F2 (GF3).
    const sources: string[] = [];
    const parcourir = (dossier: string): void => {
      for (const entree of fs.readdirSync(path.join(APP_DIR, dossier), { withFileTypes: true })) {
        const relatif = `${dossier}/${entree.name}`;
        if (entree.isDirectory()) {
          if (entree.name !== "node_modules" && entree.name !== "fixtures") parcourir(relatif);
        } else if (/\.tsx?$/.test(entree.name) && !/\.test\.ts$/.test(entree.name)) sources.push(relatif);
      }
    };
    parcourir("server");
    parcourir("web");
    const declarations = sources.filter((f) => /SALLE_OUVERTE\s*=/.test(lire(f)));
    assert.deepEqual(declarations, ["server/wiring-11.ts"]);
    assert.match(lire("server/wiring-11.ts"), /^export const SALLE_OUVERTE = false;$/m);
    assert.deepEqual(sources.filter((f) => lire(f).includes("EQUIPES_SIMPLE_OUVERTES")), []);
  });
});
