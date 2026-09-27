// Tests L31a, zoom 1 de la salle de contrôle (spécification §5.8 l.993, §5.9 l.1024, §6 l.1065, P11, P12, JP-10 ; plan d'exécution
// it3, fiche L31a, D-3d-13, D-3d-14, D-3d-16) :
// - modèle pur (shared/territoires.ts) : places stables, spirale hexagonale, plan du zoom 1 (territoires de taille égale, enceinte
//   séparée à droite, stations, aucun faisceau, aucune étiquette d'état en Simple pour l'enceinte, 60 étiquettes au plus) et règle
//   « qui travaille » recopiée de statusBusy ;
// - service (territoires-service.ts) sur le harnais du cockpit : deux projets, une racine occupée, une en attente d'accord, une au
//   repos, coûts, réponses de statut illisibles, salle en Simple et en Avancé, P11, et les attentes comptées sur l'ARBRE de la
//   conversation (ligne écrite sous une racine provisoire, puis rattachée).
// - salle branchée (« 3s », L3s-a) : en Avancé, état des sessions de la salle par le client de SON instance (jamais le principal,
//   P11) ; en Simple, aucune requête ; salle coupée : inchangé ; racine connue d'omo_rooms rangée dans l'enceinte.
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import type { OcSession } from "./opencode.ts";
import type { NeonMode } from "./shared/neon-scene.ts";
import type { ConversationTerritoire, Plan3d, TerritoiresResponse, TerritoireView } from "./shared/salle3d-types.ts";
import { ETIQUETTES_MAX, hexAxial, placer, planTerritoires, sessionsQuiTravaillent } from "./shared/territoires.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import { createTerritoiresPort, nomDeProjet, projetRelatif } from "./territoires-service.ts";

// --- Fabriques de vues -----------------------------------------------------------------------------------------------------------

const territoire = (projet: string, compteurs: Partial<TerritoireView["compteurs"]> = {}): TerritoireView => ({
  projet,
  nom: projet.split("/").at(-1) ?? projet,
  conversations: [],
  compteurs: { travaillent: 0, attendent: 0, cout: 0, ...compteurs },
});

const reponse = (extra: Partial<TerritoiresResponse> = {}): TerritoiresResponse => ({
  genereLe: 1_000,
  mode: "avance",
  projets: [],
  salle: null,
  statutVerifie: true,
  ...extra,
});

const centreDe = (plan: Plan3d, projet: string) => plan.territoires.find((t) => t.projet === projet && !t.enceinte)?.centre;

/** Anneau d'une plaque : distance hexagonale à l'origine en coordonnées axiales. */
const anneauDe = ({ q, r }: { q: number; r: number }) => (Math.abs(q) + Math.abs(q + r) + Math.abs(r)) / 2;

// --- Modèle pur : places (D-3d-16) --------------------------------------------------------------------------------------------

describe("territoires : places des projets (D-3d-16)", () => {
  it("ordre alphabétique à l'ouverture de la vue, chaîne vide (projet racine) comprise", () => {
    const places = placer(["zeta", "alpha", "", "Éta", "beta"], new Map());
    assert.deepEqual(
      [...places.entries()].sort((a, b) => a[1] - b[1]).map(([cle]) => cle),
      ["", "alpha", "beta", "Éta", "zeta"],
    );
  });

  it("projets nouveaux en fin, jamais devant un projet déjà placé", () => {
    const initiales = placer(["beta", "delta"], new Map());
    const suivantes = placer(["alpha", "beta", "delta"], initiales);
    assert.equal(suivantes.get("beta"), initiales.get("beta"));
    assert.equal(suivantes.get("delta"), initiales.get("delta"));
    assert.equal(suivantes.get("alpha"), 2, "le projet neuf prend la place libre suivante");
  });

  it("un projet disparu garde sa place (il la retrouve s'il revient) ; la table donnée n'est jamais modifiée", () => {
    const initiales = placer(["alpha", "beta", "gamma"], new Map());
    const copie = new Map(initiales);
    const sansBeta = placer(["alpha", "gamma"], initiales);
    assert.deepEqual([...initiales], [...copie], "table d'entrée inchangée");
    assert.equal(sansBeta.get("beta"), initiales.get("beta"));
    const retour = placer(["alpha", "beta", "gamma", "delta"], sansBeta);
    assert.equal(retour.get("beta"), initiales.get("beta"), "beta n'a pas bougé");
    assert.equal(retour.get("delta"), 3);
  });

  it("places illisibles écartées ; les places gardées ne se chevauchent jamais", () => {
    const abimee = new Map<string, number>([
      ["alpha", 0],
      ["beta", -1],
      ["gamma", 1.5],
      ["delta", Number.NaN],
    ]);
    const places = placer(["alpha", "beta", "gamma", "delta"], abimee);
    assert.equal(places.get("alpha"), 0);
    const rangs = [...places.values()];
    assert.equal(new Set(rangs).size, rangs.length, "aucune place en double");
    assert.deepEqual([...places.keys()].sort(), ["alpha", "beta", "delta", "gamma"]);
  });
});

// --- Modèle pur : spirale hexagonale (D-3d-16) --------------------------------------------------------------------------------

describe("territoires : spirale hexagonale (D-3d-16)", () => {
  it("rang 0 au centre, anneau par anneau : 6 plaques au premier anneau, 12 au deuxième", () => {
    assert.deepEqual(hexAxial(0), { q: 0, r: 0 });
    const rangs = Array.from({ length: 19 }, (_, rang) => hexAxial(rang));
    assert.deepEqual(rangs.slice(1, 7).map(anneauDe), [1, 1, 1, 1, 1, 1]);
    assert.deepEqual(
      rangs.slice(7, 19).map(anneauDe),
      Array.from({ length: 12 }, () => 2),
    );
  });

  it("aucune plaque en double sur 200 rangs ; anneau k = 6 k plaques", () => {
    const vues = new Set<string>();
    const parAnneau = new Map<number, number>();
    for (let rang = 0; rang < 200; rang++) {
      const { q, r } = hexAxial(rang);
      vues.add(`${q},${r}`);
      const anneau = anneauDe({ q, r });
      parAnneau.set(anneau, (parAnneau.get(anneau) ?? 0) + 1);
    }
    assert.equal(vues.size, 200);
    assert.equal(parAnneau.get(0), 1);
    for (const anneau of [1, 2, 3, 4, 5, 6, 7]) assert.equal(parAnneau.get(anneau), 6 * anneau, `anneau ${anneau}`);
  });

  it("rang illisible : erreur, jamais une position devinée", () => {
    for (const rang of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => hexAxial(rang), RangeError, String(rang));
    }
  });
});

// --- Modèle pur : plan du zoom 1 (D-3d-13, D-3d-14) ----------------------------------------------------------------------------

describe("territoires : plan du zoom 1 (D-3d-13, D-3d-14, JP-10)", () => {
  const vue = reponse({
    projets: [territoire("alpha", { travaillent: 2 }), territoire("beta", { attendent: 1 }), territoire("gamma")],
    salle: { projets: [territoire("salle-a", { travaillent: 1 }), territoire("salle-b", { attendent: 3 })] },
    statutVerifie: false,
  });

  it("zoom 1 : plaques de taille égale, AUCUN faisceau, aucun nœud, aucune marque, aucune tuile (P12)", () => {
    const plan = planTerritoires(vue, new Map(), { theme: "sombre", mode: "avance" });
    assert.equal(plan.zoom, 1);
    assert.equal(plan.rootId, null);
    assert.deepEqual(plan.faisceaux, [], "aucun faisceau entre projets au zoom 1 (D-3d-13)");
    assert.deepEqual(plan.noeuds, []);
    assert.deepEqual(plan.marques, []);
    assert.deepEqual(plan.tuiles, []);
    assert.equal(plan.anime, false);
    assert.equal(new Set(plan.territoires.map((t) => t.rayon)).size, 1, "toutes les plaques ont le même rayon");
    assert.equal(plan.camera.inclinaisonDeg, 55);
    assert.equal(plan.camera.fovDeg, 35);
    assert.equal(plan.theme, "sombre");
    assert.equal(plan.mode, "avance");
  });

  it("enceinte séparée, à droite de tous les projets (JP-10) ; enceinte nulle sans racine de la salle", () => {
    const plan = planTerritoires(vue, new Map(), { theme: "sombre", mode: "avance" });
    const projets = plan.territoires.filter((t) => !t.enceinte);
    const enceinte = plan.territoires.filter((t) => t.enceinte);
    assert.equal(projets.length, 3);
    assert.equal(enceinte.length, 2);
    assert.ok(Math.min(...enceinte.map((t) => t.centre.x)) > Math.max(...projets.map((t) => t.centre.x)), "l'enceinte est à droite");
    assert.deepEqual(plan.enceinte, { projets: ["salle-a", "salle-b"] });
    assert.equal(planTerritoires(reponse({ projets: [territoire("alpha")] }), new Map(), { theme: "sombre", mode: "avance" }).enceinte, null);
  });

  it("stations : « vous » en bas, « copilot » en haut, « controle » à gauche ; aucune station « carnet » au zoom 1", () => {
    const plan = planTerritoires(vue, new Map(), { theme: "sombre", mode: "avance" });
    assert.deepEqual(plan.stations.map((s) => s.id).sort(), ["controle", "copilot", "vous"]);
    const station = (id: string) => plan.stations.find((s) => s.id === id)?.position;
    const vous = station("vous");
    const copilot = station("copilot");
    const controle = station("controle");
    assert.ok(vous && copilot && controle);
    assert.ok(vous.z > Math.max(...plan.territoires.map((t) => t.centre.z)), "« vous » en bas");
    assert.ok(copilot.z < Math.min(...plan.territoires.map((t) => t.centre.z)), "« copilot » en haut");
    assert.ok(controle.x < Math.min(...plan.territoires.map((t) => t.centre.x)), "« controle » à gauche");
    assert.equal(plan.carnetVide, true);
  });

  it("positions stables : la même table rend les mêmes centres, et un projet neuf ne déplace personne (D-3d-16)", () => {
    const places = placer(["alpha", "beta", "gamma"], new Map());
    const premier = planTerritoires(vue, places, { theme: "sombre", mode: "avance" });
    const second = planTerritoires(vue, places, { theme: "clair", mode: "avance" });
    assert.deepEqual(
      premier.territoires.map((t) => t.centre),
      second.territoires.map((t) => t.centre),
    );
    const avecDelta = reponse({ ...vue, projets: [territoire("delta"), ...vue.projets] });
    const apres = planTerritoires(avecDelta, placer(["alpha", "beta", "gamma", "delta"], places), { theme: "sombre", mode: "avance" });
    for (const projet of ["alpha", "beta", "gamma"]) {
      assert.deepEqual(centreDe(apres, projet), centreDe(premier, projet), projet);
    }
    assert.notDeepEqual(centreDe(apres, "delta"), centreDe(premier, "alpha"));
  });

  it("étiquettes : état des projets dans les deux modes, AUCUN état pour l'enceinte en Simple (D-3d-14)", () => {
    const etats = (mode: NeonMode) =>
      Object.fromEntries(
        planTerritoires(vue, new Map(), { theme: "sombre", mode })
          .etiquettes.filter((e) => e.cible.includes(":"))
          .map((e) => [e.cible, e.etat]),
      );
    assert.deepEqual(etats("avance"), {
      "projet:alpha": "travaille",
      "projet:beta": "attente-accord",
      "projet:gamma": null,
      "salle:salle-a": "travaille",
      "salle:salle-b": "attente-accord",
    });
    assert.deepEqual(etats("simple"), {
      "projet:alpha": "travaille",
      "projet:beta": "attente-accord",
      "projet:gamma": null,
      "salle:salle-a": null,
      "salle:salle-b": null,
    });
  });

  it("noms des étiquettes : ceux de la réponse du serveur, jamais inventés ; stations sans nom", () => {
    const plan = planTerritoires(vue, new Map(), { theme: "sombre", mode: "avance" });
    assert.deepEqual(
      plan.etiquettes.filter((e) => !e.cible.includes(":")).map((e) => e.nom),
      [null, null, null],
    );
    assert.deepEqual(
      plan.etiquettes.filter((e) => e.cible.startsWith("projet:")).map((e) => e.nom),
      ["alpha", "beta", "gamma"],
    );
  });

  it("60 étiquettes au plus, les plus prioritaires d'abord (D-3d-19)", () => {
    const beaucoup = reponse({
      projets: Array.from({ length: 100 }, (_, index) => territoire(`p${String(index).padStart(3, "0")}`, index % 10 === 0 ? { travaillent: 1 } : {})),
    });
    const plan = planTerritoires(beaucoup, new Map(), { theme: "sombre", mode: "avance" });
    assert.equal(plan.territoires.length, 100, "toutes les plaques sont dessinées");
    assert.equal(plan.etiquettes.length, ETIQUETTES_MAX);
    assert.equal(plan.etiquettes.filter((e) => e.etat === "travaille").length, 10, "les dix territoires où l'on travaille sont étiquetés");
    assert.equal(plan.etiquettes.filter((e) => e.priorite === 0).length, 3, "les trois stations gardent leur étiquette");
  });
});

// --- Modèle pur : « qui travaille » (D-3d-13, règle de statusBusy) ---------------------------------------------------------------

describe("territoires : sessionsQuiTravaillent (règle de statusBusy, D-3d-13)", () => {
  const ARBRE = ["ses_r", "ses_a", "ses_b"];

  it("arbre de 3 sessions et réponse vide → 0 : une session absente de la réponse est au repos", () => {
    assert.equal(sessionsQuiTravaillent({}, ARBRE), 0);
  });

  it("une session « busy » → 1 ; une session « retry » → 1 ; toutes « idle » → 0", () => {
    assert.equal(sessionsQuiTravaillent({ ses_a: { type: "busy" } }, ARBRE), 1);
    assert.equal(sessionsQuiTravaillent({ ses_b: { type: "retry" } }, ARBRE), 1);
    assert.equal(sessionsQuiTravaillent({ ses_r: { type: "idle" }, ses_a: { type: "idle" }, ses_b: { type: "idle" } }, ARBRE), 0);
    assert.equal(sessionsQuiTravaillent({ ses_r: { type: "busy" }, ses_a: { type: "retry" }, ses_b: { type: "idle" } }, ARBRE), 2);
  });

  it("valeur illisible d'une session présente : elle travaille (comme statusBusy) ; sessions hors de l'arbre ignorées", () => {
    assert.equal(sessionsQuiTravaillent({ ses_a: null }, ARBRE), 1);
    assert.equal(sessionsQuiTravaillent({ ses_a: "busy" }, ARBRE), 1);
    assert.equal(sessionsQuiTravaillent({ ses_autre: { type: "busy" } }, ARBRE), 0);
    assert.equal(sessionsQuiTravaillent({ ses_a: { type: "busy" } }, ["ses_a", "ses_a"]), 1, "doublons comptés une fois");
  });

  it("réponse qui n'est pas un objet → null, jamais 0 (tableau, texte, null, nombre)", () => {
    for (const illisible of [[], ["ses_a"], "occupe", null, undefined, 3]) {
      assert.equal(sessionsQuiTravaillent(illisible, ARBRE), null, JSON.stringify(illisible ?? null));
    }
  });

  it("propriétés héritées du prototype jamais comptées", () => {
    assert.equal(sessionsQuiTravaillent({}, ["constructor", "toString"]), 0);
  });
});

// --- Chemins de projet -----------------------------------------------------------------------------------------------------------

describe("territoires : chemin et nom d'un projet", () => {
  it("chemin relatif au workspace, racine comprise ; nom = dernier composant", () => {
    assert.equal(projetRelatif("/workspace", "/workspace"), "");
    assert.equal(projetRelatif("/workspace", "/workspace/alpha"), "alpha");
    assert.equal(projetRelatif("/workspace", "/workspace/alpha/beta"), "alpha/beta");
    assert.equal(projetRelatif("/workspace/", "/workspace/alpha"), "alpha");
    assert.equal(projetRelatif("C:\\ws", "C:\\ws\\alpha"), "alpha");
    assert.equal(nomDeProjet("/workspace", "/workspace", ""), "workspace");
    assert.equal(nomDeProjet("/workspace", "/workspace/alpha/beta", "alpha/beta"), "beta");
  });
});

// --- Service : état réel sur le harnais du cockpit -------------------------------------------------------------------------------

const MAINTENANT = 1_800_000_000_000;

/** Ligne `sessions` semée (requête paramétrée) : racine par défaut, instance principale. */
function semerSession(
  db: DatabaseSync,
  row: { id: string; directory: string; title?: string; parent?: string; instance?: string; purpose?: string; updated?: number; deleted?: number },
): void {
  db.prepare(
    `INSERT INTO sessions (id, parent_id, root_id, directory, title, purpose, instance, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.parent ?? null,
    row.parent ?? row.id,
    row.directory,
    row.title ?? "",
    row.purpose ?? "chat",
    row.instance ?? "principale",
    MAINTENANT - 1_000,
    row.updated ?? MAINTENANT - 1_000,
    row.deleted ?? null,
  );
}

/** Session telle qu'opencode la rend, pour le VRAI SessionTracker (racine provisoire puis rattachement). */
const ocSession = (id: string, parentID?: string): OcSession => ({
  id,
  projectID: "p",
  directory: "/workspace/alpha",
  title: `Session ${id}`,
  time: { created: MAINTENANT - 1_000, updated: MAINTENANT - 1_000 },
  ...(parentID ? { parentID } : {}),
});

/** Message de l'utilisateur (prompts.kind = 'message') : début de la fenêtre de coût. */
function semerMessage(db: DatabaseSync, rootId: string, at: number, kind = "message"): void {
  db.prepare("INSERT INTO prompts (message_id, session_id, root_id, created_at, kind) VALUES (?, ?, ?, ?, ?)").run(`msg_${rootId}_${at}`, rootId, rootId, at, kind);
}

/** Ligne `usage` semée : seul `cost` compte pour ledger.spentSince (valeurs binaires exactes). */
function semerCout(db: DatabaseSync, messageId: string, rootId: string, at: number, cout: number): void {
  db.prepare(
    "INSERT INTO usage (message_id, session_id, root_id, provider_id, model_id, created_at, completed_at, cost) VALUES (?, ?, ?, 'github-copilot', 'gpt-5-mini', ?, ?, ?)",
  ).run(messageId, rootId, rootId, at, at, cout);
}

const territoireDe = (vue: TerritoiresResponse, projet: string) => vue.projets.find((t) => t.projet === projet);
const conversationDe = (vue: TerritoiresResponse, projet: string, rootId: string) => territoireDe(vue, projet)?.conversations.find((c) => c.rootId === rootId);
const racinesDe = (territoires: readonly TerritoireView[] | undefined) => (territoires ?? []).flatMap((t) => t.conversations.map((c) => c.rootId));

describe("territoires : service (D-3d-13)", () => {
  it("deux projets : une racine occupée, une en attente d'accord, une au repos ; compteurs et coûts par territoire", async (t) => {
    const h = await startCockpit(t);
    const db = h.db;
    semerSession(db, { id: "ses_occupee", directory: "/workspace/alpha", title: "Refonte" });
    semerSession(db, { id: "ses_enfant", directory: "/workspace/alpha", parent: "ses_occupee" });
    semerSession(db, { id: "ses_attente", directory: "/workspace/alpha", title: "Correctif" });
    semerSession(db, { id: "ses_repos", directory: "/workspace/beta", title: "Notes" });
    db.prepare("INSERT INTO permission_waits (permission_id, session_id, root_id, permission, asked_at) VALUES (?, ?, ?, 'bash', ?)").run(
      "per_1",
      "ses_attente",
      "ses_attente",
      MAINTENANT - 500,
    );
    db.prepare(
      "INSERT INTO permission_waits (permission_id, session_id, root_id, permission, asked_at, replied_at, reply) VALUES (?, ?, ?, 'bash', ?, ?, 'once')",
    ).run("per_2", "ses_attente", "ses_attente", MAINTENANT - 900, MAINTENANT - 800);
    for (const id of ["ses_occupee", "ses_attente", "ses_repos"]) semerMessage(db, id, MAINTENANT - 700);
    // Dépenses : avant le message de l'utilisateur (hors fenêtre) et après (comptées).
    semerCout(db, "u_avant", "ses_occupee", MAINTENANT - 900, 0.5);
    semerCout(db, "u_apres", "ses_occupee", MAINTENANT - 600, 0.25);
    semerCout(db, "u_enfant", "ses_occupee", MAINTENANT - 550, 0.25);
    semerCout(db, "u_attente", "ses_attente", MAINTENANT - 600, 0.25);
    semerCout(db, "u_repos", "ses_repos", MAINTENANT - 600, 9.5);

    const port = createTerritoiresPort(h.cockpit.c11, {
      statut: async (directory) => (directory === "/workspace/alpha" ? { ses_enfant: { type: "busy" }, ses_repos: { type: "busy" } } : {}),
    });
    const vue = await port.lire("avance", MAINTENANT);

    assert.equal(vue.genereLe, MAINTENANT);
    assert.equal(vue.statutVerifie, true);
    assert.equal(vue.salle, null);
    assert.deepEqual(territoireDe(vue, "alpha")?.compteurs, { travaillent: 1, attendent: 1, cout: 0.75 });
    assert.deepEqual(territoireDe(vue, "beta")?.compteurs, { travaillent: 0, attendent: 0, cout: 0 });
    assert.equal(territoireDe(vue, "alpha")?.nom, "alpha");
    assert.deepEqual(conversationDe(vue, "alpha", "ses_occupee"), {
      rootId: "ses_occupee",
      titre: "Refonte",
      instance: "principale",
      travaillent: 1,
      attendent: 0,
      coutEnCours: 0.5,
      demandeEnCours: true,
      derniereActivite: MAINTENANT - 1_000,
      revoir: true,
    });
    const attente = conversationDe(vue, "alpha", "ses_attente");
    assert.equal(attente?.travaillent, 0);
    assert.equal(attente?.attendent, 1, "seule la demande sans réponse compte");
    assert.equal(attente?.demandeEnCours, true, "une demande d'accord en attente est une demande en cours");
    assert.equal(attente?.coutEnCours, 0.25);
    const repos = conversationDe(vue, "beta", "ses_repos");
    assert.equal(repos?.travaillent, 0, "une session occupée d'un AUTRE arbre ne compte pas ici");
    assert.equal(repos?.demandeEnCours, false);
    assert.equal(repos?.coutEnCours, 0, "aucun coût « des demandes en cours » sans demande en cours");
  });

  it("coût : fenêtre ouverte au dernier message de l'utilisateur ; un envoi d'équipe n'ouvre pas de fenêtre", async (t) => {
    const h = await startCockpit(t);
    semerSession(h.db, { id: "ses_a", directory: "/workspace/alpha" });
    semerSession(h.db, { id: "ses_b", directory: "/workspace/alpha" });
    semerMessage(h.db, "ses_a", MAINTENANT - 800);
    semerMessage(h.db, "ses_a", MAINTENANT - 300);
    semerMessage(h.db, "ses_b", MAINTENANT - 800, "equipe-demande");
    semerCout(h.db, "u_1", "ses_a", MAINTENANT - 500, 4);
    semerCout(h.db, "u_2", "ses_a", MAINTENANT - 200, 0.25);
    semerCout(h.db, "u_3", "ses_b", MAINTENANT - 200, 8);
    const vue = await createTerritoiresPort(h.cockpit.c11, { statut: async () => ({ ses_a: { type: "busy" }, ses_b: { type: "busy" } }) }).lire("avance", MAINTENANT);
    assert.equal(conversationDe(vue, "alpha", "ses_a")?.coutEnCours, 0.25, "seulement depuis le DERNIER message de l'utilisateur");
    assert.equal(conversationDe(vue, "alpha", "ses_b")?.coutEnCours, 0, "aucun message de l'utilisateur : aucun coût annoncé");
  });

  it("statut illisible d'un dossier : travaillent null et statutVerifie faux, jamais 0", async (t) => {
    const h = await startCockpit(t);
    semerSession(h.db, { id: "ses_a", directory: "/workspace/alpha" });
    semerSession(h.db, { id: "ses_b", directory: "/workspace/beta" });
    semerMessage(h.db, "ses_a", MAINTENANT - 700);
    semerCout(h.db, "u_1", "ses_a", MAINTENANT - 600, 0.5);
    const cas: Array<{ nom: string; statut: (directory: string) => Promise<unknown> }> = [
      { nom: "tableau", statut: async () => [] },
      { nom: "texte", statut: async () => "occupe" },
      {
        nom: "echec",
        statut: async (directory) => {
          if (directory === "/workspace/alpha") throw new Error("injoignable");
          return {};
        },
      },
    ];
    for (const { nom, statut } of cas) {
      const vue = await createTerritoiresPort(h.cockpit.c11, { statut }).lire("avance", MAINTENANT);
      assert.equal(conversationDe(vue, "alpha", "ses_a")?.travaillent, null, nom);
      assert.equal(territoireDe(vue, "alpha")?.compteurs.travaillent, null, nom);
      assert.equal(vue.statutVerifie, false, nom);
      assert.equal(conversationDe(vue, "alpha", "ses_a")?.coutEnCours, 0, `${nom} : aucun coût deviné sur un état non vérifiable`);
    }
  });

  it("racines lues : sans parent, non supprimées, purpose « chat », actives dans les 24 h, identifiant et dossier valables", async (t) => {
    const h = await startCockpit(t);
    semerSession(h.db, { id: "ses_ok", directory: "/workspace/alpha" });
    semerSession(h.db, { id: "ses_enfant", directory: "/workspace/alpha", parent: "ses_ok" });
    semerSession(h.db, { id: "ses_supprimee", directory: "/workspace/alpha", deleted: MAINTENANT - 10 });
    semerSession(h.db, { id: "ses_controle", directory: "/workspace/alpha", purpose: "controle" });
    semerSession(h.db, { id: "ses_vieille", directory: "/workspace/alpha", updated: MAINTENANT - 25 * 60 * 60 * 1_000 });
    semerSession(h.db, { id: "ses.point", directory: "/workspace/alpha" });
    semerSession(h.db, { id: "ses_dehors", directory: "/ailleurs/projet" });
    const vue = await createTerritoiresPort(h.cockpit.c11, { statut: async () => ({}) }).lire("avance", MAINTENANT);
    assert.deepEqual(racinesDe(vue.projets), ["ses_ok"]);
    assert.equal(
      vue.projets.some((t2) => t2.projet.includes("ailleurs")),
      false,
      "un dossier hors du workspace n'ouvre aucun territoire",
    );
  });

  it("attente d'accord écrite sous une racine PROVISOIRE : comptée par l'arbre après rattachement, étiquette « attente-accord »", async (t) => {
    // Corrections de la relecture 3-vague-1 : activity-deriver retombe sur la session elle-même quand le parent est encore inconnu,
    // et fact-store.markWait écrit permission_waits avec ce root_id provisoire. SessionTracker.#reparent remet sessions.root_id à la
    // vraie racine, mais pas permission_waits : la lecture doit donc suivre l'ARBRE, comme routes-activity.ts, sinon la salle de
    // contrôle n'annonce pas qu'un accord est attendu, alors que la bande 2D, elle, le montre.
    const h = await startCockpit(t, { modules: ["facts"] });
    const ROOT = "ses_racine_arbre";
    const FILLE = "ses_fille_arbre";
    const PETITE = "ses_petite_arbre";
    h.sessions.upsert(ocSession(ROOT));
    h.sessions.upsert(ocSession(PETITE, FILLE)); // racine provisoire : FILLE
    assert.equal(h.sessions.rootOf(PETITE), FILLE, "racine provisoire avant rattachement");
    h.cockpit.c11.ports.facts.work.markWait({ permissionId: "per_arbre", sessionId: PETITE, rootId: FILLE, permission: "bash" }, "attente", null);
    h.sessions.upsert(ocSession(FILLE, ROOT)); // rattachement
    assert.equal(h.sessions.rootOf(PETITE), ROOT);
    assert.equal(
      (h.db.prepare("SELECT root_id FROM permission_waits WHERE permission_id = ?").get("per_arbre") as { root_id: string }).root_id,
      FILLE,
      "la ligne garde sa racine provisoire : c'est la LECTURE qui doit suivre l'arbre",
    );

    const vue = await createTerritoiresPort(h.cockpit.c11, { statut: async () => ({}) }).lire("avance", MAINTENANT);
    assert.equal(conversationDe(vue, "alpha", ROOT)?.attendent, 1, "la demande d'autorisation est signalée sur la vraie racine");
    assert.equal(territoireDe(vue, "alpha")?.compteurs.attendent, 1);
    const plan = planTerritoires(vue, new Map(), { theme: "sombre", mode: "avance" });
    const etiquette = plan.etiquettes.find((e) => e.cible === "projet:alpha");
    assert.equal(etiquette?.etat, "attente-accord", "l'étiquette du territoire dit qu'un accord est attendu");
  });

  it("titres passés par redactSecrets", async (t) => {
    const h = await startCockpit(t);
    semerSession(h.db, { id: "ses_secret", directory: "/workspace/alpha", title: "clé ghp_0123456789abcdefghijklmnopqrstuvwxyz gardée" });
    const vue = await createTerritoiresPort(h.cockpit.c11, { statut: async () => ({}) }).lire("avance", MAINTENANT);
    const titre = conversationDe(vue, "alpha", "ses_secret")?.titre ?? "";
    assert.equal(titre.includes("ghp_0123456789abcdefghijklmnopqrstuvwxyz"), false, "le jeton n'est jamais servi");
    assert.ok(titre.length > 0);
  });
});

describe("territoires : Salle OMO au zoom 1 (D-3d-14, P11)", () => {
  /** Racine de la salle simulée en base : fait de cycle et, au besoin, une demande d'autonomie finie ou non. */
  function semerSalle(h: CockpitHarness, id: string, options: { etat: "occupee" | "repos"; demande: "finie" | "en-cours" | "aucune" }): void {
    semerSession(h.db, { id, directory: "/workspace/salle", instance: "omo", title: `Demande ${id}` });
    h.cockpit.c11.ports.facts.append([{ rootId: id, sessionId: id, kind: "statut", ref: null, data: { etat: options.etat }, at: MAINTENANT - 900 }]);
    if (options.demande !== "aucune") {
      h.db
        .prepare("INSERT INTO autonomy_requests (id, root_id, choix, plafonds, started_at, ended_at) VALUES (?, ?, 'autonome', '{}', ?, ?)")
        .run(`req_${id}`, id, MAINTENANT - 900, options.demande === "finie" ? MAINTENANT - 100 : null);
    }
  }

  it("Simple : seules les demandes terminées de la salle sont listées, sans compteur, avec « Revoir »", async (t) => {
    const h = await startCockpit(t, { modules: ["facts"] });
    semerSalle(h, "ses_finie", { etat: "repos", demande: "finie" });
    semerSalle(h, "ses_encours", { etat: "repos", demande: "en-cours" });
    semerSalle(h, "ses_occupee", { etat: "occupee", demande: "finie" });
    semerSalle(h, "ses_sansdemande", { etat: "repos", demande: "aucune" });
    const appels: string[] = [];
    const vue = await createTerritoiresPort(h.cockpit.c11, {
      statut: async (directory) => {
        appels.push(directory);
        return {};
      },
    }).lire("simple", MAINTENANT);

    assert.deepEqual(appels, [], "P11 : aucun statut demandé pour un dossier qui n'a que des racines de la salle");
    const salle = vue.salle;
    assert.ok(salle, "l'enceinte existe dès qu'une racine de la salle existe");
    assert.deepEqual(racinesDe(salle.projets), ["ses_finie"]);
    const finie = salle.projets[0]?.conversations[0];
    assert.equal(finie?.revoir, true);
    assert.equal(finie?.travaillent, null, "aucun compteur en direct en Simple");
    assert.equal(finie?.attendent, 0);
    assert.equal(finie?.coutEnCours, 0);
    assert.equal(finie?.demandeEnCours, false);
    assert.deepEqual(salle.projets[0]?.compteurs, { travaillent: null, attendent: 0, cout: 0 });
    assert.equal(vue.statutVerifie, false);
    assert.deepEqual(racinesDe(vue.projets), [], "une racine de la salle n'est jamais un territoire de projet");
  });

  it("Avancé : compteurs de l'enceinte par les faits (occupeesSelonFaits), statutVerifie faux, toutes les demandes listées", async (t) => {
    const h = await startCockpit(t, { modules: ["facts"] });
    semerSalle(h, "ses_finie", { etat: "repos", demande: "finie" });
    semerSalle(h, "ses_encours", { etat: "occupee", demande: "en-cours" });
    const appels: string[] = [];
    const vue = await createTerritoiresPort(h.cockpit.c11, {
      statut: async (directory) => {
        appels.push(directory);
        return { ses_encours: { type: "busy" } };
      },
    }).lire("avance", MAINTENANT);

    assert.deepEqual(appels, [], "P11 : aucune requête au client principal pour la salle, même en Avancé");
    const salle = vue.salle;
    assert.ok(salle);
    assert.deepEqual(racinesDe(salle.projets).sort(), ["ses_encours", "ses_finie"]);
    const parId = new Map(salle.projets.flatMap((t2) => t2.conversations).map((c) => [c.rootId, c]));
    assert.equal(parId.get("ses_encours")?.travaillent, 1, "compté par les faits, jamais par un statut d'opencode");
    assert.equal(parId.get("ses_finie")?.travaillent, 0);
    assert.equal(salle.projets[0]?.compteurs.travaillent, 1);
    assert.equal(vue.statutVerifie, false);
  });

  it("faits absents : en Simple l'enceinte ne liste rien, en Avancé elle est montrée sans rien deviner", async (t) => {
    const h = await startCockpit(t);
    semerSession(h.db, { id: "ses_omo", directory: "/workspace/salle", instance: "omo" });
    const simple = await createTerritoiresPort(h.cockpit.c11, { statut: async () => ({}) }).lire("simple", MAINTENANT);
    assert.deepEqual(simple.salle?.projets, [], "aucune demande terminée prouvée : rien n'est listé");
    const avance = await createTerritoiresPort(h.cockpit.c11, { statut: async () => ({}) }).lire("avance", MAINTENANT);
    assert.deepEqual(racinesDe(avance.salle?.projets), ["ses_omo"]);
    assert.equal(avance.statutVerifie, false);
  });

  it("dossier partagé : la racine principale est interrogée, la racine de la salle reste dans l'enceinte", async (t) => {
    const h = await startCockpit(t);
    semerSession(h.db, { id: "ses_principale", directory: "/workspace/mixte" });
    semerSession(h.db, { id: "ses_omo", directory: "/workspace/mixte", instance: "omo" });
    const appels: string[] = [];
    const vue = await createTerritoiresPort(h.cockpit.c11, {
      statut: async (directory) => {
        appels.push(directory);
        return { ses_principale: { type: "busy" } };
      },
    }).lire("avance", MAINTENANT);
    assert.deepEqual(appels, ["/workspace/mixte"], "un seul appel, pour le dossier de la racine principale");
    assert.equal(conversationDe(vue, "mixte", "ses_principale")?.travaillent, 1);
    assert.deepEqual(racinesDe(vue.salle?.projets), ["ses_omo"], "la racine de la salle n'apparaît que dans l'enceinte");
  });
});

// --- Salle branchée (itération « 3s », L3s-a) : état des sessions de la salle par SON instance -------------------------------------

describe("territoires : salle branchée (L3s-a, P11)", () => {
  /** Racine de la salle en base (instance omo), faits de cycle et dernière demande. */
  function semerSalle(h: CockpitHarness, id: string, options: { etat: "occupee" | "repos"; demande: "finie" | "en-cours"; directory?: string }): void {
    semerSession(h.db, { id, directory: options.directory ?? "/workspace/salle", instance: "omo", title: `Demande ${id}` });
    h.cockpit.c11.ports.facts.append([{ rootId: id, sessionId: id, kind: "statut", ref: null, data: { etat: options.etat }, at: MAINTENANT - 900 }]);
    h.db
      .prepare("INSERT INTO autonomy_requests (id, root_id, choix, plafonds, started_at, ended_at) VALUES (?, ?, 'autonome', '{}', ?, ?)")
      .run(`req_${id}`, id, MAINTENANT - 900, options.demande === "finie" ? MAINTENANT - 100 : null);
  }
  /** Deux lectures espionnées : client principal et client de la salle. */
  const espions = (salle: (directory: string) => Promise<unknown>) => {
    const principal: string[] = [];
    const deLaSalle: string[] = [];
    return {
      principal,
      deLaSalle,
      options: {
        statut: async (directory: string) => {
          principal.push(directory);
          return {};
        },
        statutSalle: async (directory: string) => {
          deLaSalle.push(directory);
          return salle(directory);
        },
      },
    };
  };

  it("Avancé, salle présente : « travaillent » par le CLIENT DE LA SALLE (règle de statusBusy), jamais par le principal ; statutVerifie vrai", async (t) => {
    const h = await startCockpit(t, { modules: ["facts"], omo: true });
    // Les faits disent « au repos » : seul le statut de la salle peut dire qu'elle travaille (discriminant contre les faits).
    semerSalle(h, "ses_encours", { etat: "repos", demande: "en-cours" });
    semerSession(h.db, { id: "ses_enfant_salle", directory: "/workspace/salle", parent: "ses_encours", instance: "omo" });
    semerSalle(h, "ses_finie", { etat: "repos", demande: "finie" });
    const e = espions(async () => ({ ses_enfant_salle: { type: "busy" }, ses_etrangere: { type: "busy" } }));
    const vue = await createTerritoiresPort(h.cockpit.c11, e.options).lire("avance", MAINTENANT);
    assert.deepEqual(e.principal, [], "P11 : rien au client principal pour la salle");
    assert.deepEqual(e.deLaSalle, ["/workspace/salle"], "un appel par dossier de la salle, sur la salle");
    const parId = new Map((vue.salle?.projets ?? []).flatMap((t2) => t2.conversations).map((c) => [c.rootId, c]));
    assert.equal(parId.get("ses_encours")?.travaillent, 1, "l'enfant occupé de l'arbre, d'après la salle");
    assert.equal(parId.get("ses_encours")?.demandeEnCours, true);
    assert.equal(parId.get("ses_finie")?.travaillent, 0, "une session d'un autre arbre ne compte pas");
    assert.equal(vue.statutVerifie, true, "toutes les réponses sont arrivées");
  });

  it("Avancé, réponse de la salle en échec ou illisible : « travaillent » null, statutVerifie faux, jamais 0", async (t) => {
    const h = await startCockpit(t, { modules: ["facts"], omo: true });
    semerSalle(h, "ses_encours", { etat: "occupee", demande: "en-cours" });
    for (const [nom, lecture] of [
      ["échec", async () => Promise.reject(new Error("injoignable"))],
      ["levée tout de suite", () => {
        throw new Error("injoignable");
      }],
      ["tableau", async () => []],
    ] as const) {
      const vue = await createTerritoiresPort(h.cockpit.c11, { statut: async () => ({}), statutSalle: lecture as (directory: string) => Promise<unknown> }).lire("avance", MAINTENANT);
      const conversation = vue.salle?.projets[0]?.conversations[0];
      assert.equal(conversation?.travaillent, null, nom);
      assert.equal(vue.statutVerifie, false, nom);
    }
  });

  it("vrai client de la salle (second faux) : GET /session/status?directory=… reçu par la SALLE seulement", async (t) => {
    const h = await startCockpit(t, { modules: ["facts"], omo: true });
    assert.ok(h.omo);
    semerSalle(h, "ses_encours", { etat: "repos", demande: "en-cours" });
    const avantPrincipale = h.fake.requests.length;
    const avantSalle = h.omo.fake.requests.length;
    const vue = await createTerritoiresPort(h.cockpit.c11).lire("avance", MAINTENANT);
    const deLaSalle = h.omo.fake.requests.slice(avantSalle).map((r) => `${r.method} ${r.pathname} ${r.query.directory ?? ""}`);
    assert.deepEqual(deLaSalle, ["GET /session/status /workspace/salle"]);
    assert.deepEqual(
      h.fake.requests.slice(avantPrincipale).map((r) => `${r.method} ${r.pathname}`),
      [],
      "P11 : zéro requête au faux principal",
    );
    assert.equal(vue.salle?.projets[0]?.conversations[0]?.travaillent, 0);
    assert.equal(vue.statutVerifie, true);
  });

  it("Simple, salle présente : AUCUNE requête, ni au principal ni à la salle ; seules les demandes terminées, avec « Revoir » (D-3d-14)", async (t) => {
    const h = await startCockpit(t, { modules: ["facts"], omo: true });
    semerSalle(h, "ses_finie", { etat: "repos", demande: "finie" });
    semerSalle(h, "ses_encours", { etat: "occupee", demande: "en-cours" });
    const e = espions(async () => ({}));
    const vue = await createTerritoiresPort(h.cockpit.c11, e.options).lire("simple", MAINTENANT);
    assert.deepEqual([e.principal, e.deLaSalle], [[], []]);
    assert.deepEqual(racinesDe(vue.salle?.projets), ["ses_finie"]);
    assert.equal(vue.salle?.projets[0]?.conversations[0]?.revoir, true);
    assert.equal(vue.salle?.projets[0]?.conversations[0]?.travaillent, null);
    assert.equal(vue.statutVerifie, false);
  });

  it("salle coupée (instances.omo absent, cas de production) : rien ne change — la lecture de la salle n'est jamais appelée, compteurs par les faits", async (t) => {
    const h = await startCockpit(t, { modules: ["facts"] });
    assert.equal(h.cockpit.c11.instances?.omo ?? null, null);
    semerSalle(h, "ses_encours", { etat: "occupee", demande: "en-cours" });
    const e = espions(async () => ({ ses_encours: { type: "idle" } }));
    const vue = await createTerritoiresPort(h.cockpit.c11, e.options).lire("avance", MAINTENANT);
    assert.deepEqual([e.principal, e.deLaSalle], [[], []]);
    assert.equal(vue.salle?.projets[0]?.conversations[0]?.travaillent, 1, "par les faits, comme avant L3s-a");
    assert.equal(vue.statutVerifie, false);
  });

  it("racine ouverte par le cockpit (omo_rooms) mais `sessions` dit « principale » : rangée dans l'enceinte, jamais demandée au client principal", async (t) => {
    const h = await startCockpit(t, { modules: ["facts"] });
    semerSession(h.db, { id: "ses_desaccord", directory: "/workspace/salle", instance: "principale" });
    h.db.prepare("INSERT INTO omo_rooms (root_id, projet, created_at) VALUES (?, 'salle', ?)").run("ses_desaccord", MAINTENANT - 1_000);
    semerSession(h.db, { id: "ses_principale", directory: "/workspace/alpha" });
    const e = espions(async () => ({}));
    const vue = await createTerritoiresPort(h.cockpit.c11, e.options).lire("avance", MAINTENANT);
    assert.deepEqual(e.principal, ["/workspace/alpha"], "seul le dossier de la vraie racine principale");
    assert.deepEqual(racinesDe(vue.salle?.projets), ["ses_desaccord"]);
    assert.equal(racinesDe(vue.projets).includes("ses_desaccord"), false);
    // Témoin : sans la ligne omo_rooms, la même racine est une conversation principale.
    h.db.prepare("DELETE FROM omo_rooms WHERE root_id = ?").run("ses_desaccord");
    const temoin = await createTerritoiresPort(h.cockpit.c11, { statut: async () => ({}) }).lire("avance", MAINTENANT);
    assert.ok(racinesDe(temoin.projets).includes("ses_desaccord"));
  });
});
