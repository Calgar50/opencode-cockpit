// Route et service de « Revoir » (itération 3, L28b ; spécification §5.9 l.1018-1024, §7.7 l.1169, §3.9 l.343, Q6 ; plan
// d'exécution it3 §6 « L28b », D-3d-08, D-3d-09). Application montée par le harnais (startCockpit), base du harnais, faux opencode.
// - GET /api/revoir/:rootId : racine principale servie dans les deux modes ; racine de la Salle OMO simulée (sessions.instance =
//   'omo', faits `statut`, ligne `autonomy_requests`) servie en mode Simple SEULEMENT pour une demande terminée (D-3d-09), refusée
//   avec son code et sa phrase sinon ; toujours servie en mode Avancé ; 404 racine inconnue ; 400 identifiant invalide ; ?etat=1.
// - Lecture seule (spéc. l.1169) : aucune écriture en base, AUCUNE ligne `usage` créée et ZÉRO requête reçue par le faux opencode
//   pendant tous les appels ; les faits ne sont lus que lorsque la décision ou la réponse en a besoin.
// - Titre masqué par redactSecrets.
// Le faits de la conversation viennent d'un port `facts` de doublure (surcharge du harnais) : les faits partiels de la borne des
// 20 000 sont ainsi simulés sans écrire 20 000 lignes.
import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import type { Cockpit11 } from "./contracts-11.ts";
import type { ActivityFact, FactsResponse, SessionInstance } from "./shared/activity-types.ts";
import { libelleRefus, TEXTES } from "./shared/revoir-texts.ts";
import type { RevoirEtatResponse, RevoirRefus, RevoirResponse } from "./shared/salle3d-types.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";

const PRINCIPALE = "ses_revoir_principale";
const SALLE = "ses_revoir_salle";
const ENFANT = "ses_revoir_enfant";
const INCONNUE = "ses_revoir_inconnue";
/** Titre de fixture : synthétique, reconnu par redactSecrets (règle « password= »), jamais un vrai secret. */
const TITRE_BRUT = "Reprise du déploiement password=motdepasse-synthetique";
const TITRE_MASQUE = "Reprise du déploiement password=****";

// --- Doublure du port des faits -------------------------------------------------------------------------------------------------

interface FauxFaits {
  /** Réponses posées par conversation ; une conversation sans réponse posée rend une liste vide, non partielle. */
  poser(rootId: string, facts: ActivityFact[], partial?: boolean): void;
  /** Conversations dont `since` a été appelée, dans l'ordre (une entrée par appel). */
  lectures: string[];
  port: Cockpit11["ports"]["facts"];
}

function fauxFacts(): FauxFaits {
  const reponses = new Map<string, FactsResponse>();
  const lectures: string[] = [];
  return {
    poser(rootId, facts, partial = false) {
      reponses.set(rootId, { facts, partial });
    },
    lectures,
    port: {
      append: () => assert.fail("« Revoir » n'écrit aucun fait"),
      since: (rootId) => {
        lectures.push(rootId);
        return reponses.get(rootId) ?? { facts: [], partial: false };
      },
      work: {
        markDelegation: () => assert.fail("« Revoir » ne marque aucune délégation"),
        markWait: () => assert.fail("« Revoir » ne marque aucune attente"),
      },
    },
  };
}

/** Fait `statut` de cycle d'une session (occupee, nouvelle-tentative, repos, erreur) ; `instance` marque la racine de la salle. */
const statut = (rootId: string, sessionId: string, etat: string, at: number, instance?: SessionInstance): ActivityFact => ({
  rootId,
  sessionId,
  kind: "statut",
  ref: null,
  data: instance === undefined ? { etat } : { etat, instance },
  at,
});

// --- Harnais --------------------------------------------------------------------------------------------------------------------

interface Banc {
  h: CockpitHarness;
  faits: FauxFaits;
  /** Ligne `sessions` posée à la main (le faux opencode n'est pas sollicité). */
  session(id: string, options?: { parent?: string | null; root?: string; purpose?: string; instance?: SessionInstance; titre?: string }): void;
  /** Ligne `autonomy_requests` de la racine ; `finie` : `ended_at` renseigné. */
  demande(rootId: string, id: string, startedAt: number, finie: boolean): void;
  get(chemin: string): Promise<{ status: number; body: unknown }>;
}

async function banc(t: TestContext, mode: "simple" | "avance" = "simple"): Promise<Banc> {
  const faits = fauxFacts();
  const h = await startCockpit(t, { ports: { facts: faits.port }, ...(mode === "avance" ? { settings: { ui: { mode: "avance" } } } : {}) });
  return {
    h,
    faits,
    session(id, options = {}) {
      h.db
        .prepare(
          `INSERT INTO sessions (id, parent_id, root_id, directory, title, purpose, instance, created_at, updated_at)
           VALUES (:id, :parent, :root, '', :titre, :purpose, :instance, 1, 1)`,
        )
        .run({
          id,
          parent: options.parent ?? null,
          root: options.root ?? id,
          titre: options.titre ?? TITRE_BRUT,
          purpose: options.purpose ?? "chat",
          instance: options.instance ?? "principale",
        });
    },
    demande(rootId, id, startedAt, finie) {
      h.db
        .prepare("INSERT INTO autonomy_requests (id, root_id, choix, plafonds, started_at, ended_at) VALUES (:id, :root, 'autonome', '{}', :start, :fin)")
        .run({ id, root: rootId, start: startedAt, fin: finie ? startedAt + 10 : null });
    },
    async get(chemin) {
      const r = await h.call("GET", chemin, { headers: h.headers.authed });
      return { status: r.status, body: r.json() };
    },
  };
}

/** Racine de la Salle OMO simulée : ligne `sessions` (instance omo), un enfant, et les faits `statut` de l'arbre. */
function salleSimulee(b: Banc, options: { occupee?: boolean } = {}): void {
  b.session(SALLE, { instance: "omo" });
  b.session(ENFANT, { parent: SALLE, root: SALLE, instance: "omo", titre: "Étape de la salle" });
  b.faits.poser(SALLE, [
    statut(SALLE, SALLE, "creee", 10, "omo"),
    statut(SALLE, SALLE, "repos", 20),
    statut(SALLE, ENFANT, "occupee", 30),
    statut(SALLE, ENFANT, options.occupee === true ? "occupee" : "repos", 40),
  ]);
}

const refus = (body: unknown) => body as { error: string; code: RevoirRefus; message: string };

// --- Racine principale ------------------------------------------------------------------------------------------------------------

describe("« Revoir » (L28b) : racine de l'instance principale", () => {
  it("200 dans les deux modes, titre masqué, faits et « Déroulé partiel » rendus tels quels", async (t) => {
    for (const mode of ["simple", "avance"] as const) {
      const b = await banc(t, mode);
      b.session(PRINCIPALE);
      b.faits.poser(PRINCIPALE, [statut(PRINCIPALE, PRINCIPALE, "occupee", 5)], true);
      const reponse = await b.get(`/api/revoir/${PRINCIPALE}`);
      assert.equal(reponse.status, 200, mode);
      const vue = reponse.body as RevoirResponse;
      assert.equal(vue.rootId, PRINCIPALE);
      assert.equal(vue.instance, "principale");
      assert.equal(vue.titre, TITRE_MASQUE, "titre passé par redactSecrets");
      assert.equal(vue.titre.includes("motdepasse-synthetique"), false);
      assert.equal(vue.partial, true, "« Déroulé partiel » rendu tel quel");
      assert.deepEqual(vue.facts.map((f) => f.data.etat), ["occupee"]);
      // Une conversation en cours de l'instance principale est consultable, sans être « terminée ».
      assert.equal(vue.termine, false);
      assert.deepEqual(await b.get(`/api/revoir/${PRINCIPALE}?etat=1`), { status: 200, body: { rootId: PRINCIPALE, acces: true, raison: null } });
    }
  });

  it("racine terminée : `termine` vrai seulement avec une dernière demande finie et aucune session occupée", async (t) => {
    const b = await banc(t);
    b.session(PRINCIPALE);
    b.faits.poser(PRINCIPALE, [statut(PRINCIPALE, PRINCIPALE, "repos", 5)]);
    const termine = async () => ((await b.get(`/api/revoir/${PRINCIPALE}`)).body as RevoirResponse).termine;
    assert.equal(await termine(), false, "aucune demande enregistrée");
    b.demande(PRINCIPALE, "req_1", 100, false);
    assert.equal(await termine(), false, "dernière demande en cours");
    b.demande(PRINCIPALE, "req_2", 200, true);
    assert.equal(await termine(), true);
    // La plus récente fait foi, même insérée après une demande finie.
    b.demande(PRINCIPALE, "req_3", 300, false);
    assert.equal(await termine(), false);
  });
});

// --- Racine de la Salle OMO (D-3d-09) ----------------------------------------------------------------------------------------------

describe("« Revoir » (L28b) : racine de la Salle OMO simulée, mode Simple (D-3d-09)", () => {
  it("demande finie et arbre au repos → 200, `termine` vrai, instance omo", async (t) => {
    const b = await banc(t);
    salleSimulee(b);
    b.demande(SALLE, "req_1", 100, true);
    const reponse = await b.get(`/api/revoir/${SALLE}`);
    assert.equal(reponse.status, 200);
    const vue = reponse.body as RevoirResponse;
    assert.equal(vue.instance, "omo");
    assert.equal(vue.termine, true);
    assert.equal(vue.facts.length, 4);
    assert.deepEqual(await b.get(`/api/revoir/${SALLE}?etat=1`), { status: 200, body: { rootId: SALLE, acces: true, raison: null } });
  });

  it("dernière demande sans `ended_at` → 403 salle-demande-en-cours, avec sa phrase", async (t) => {
    const b = await banc(t);
    salleSimulee(b);
    b.demande(SALLE, "req_1", 100, false);
    const reponse = await b.get(`/api/revoir/${SALLE}`);
    assert.equal(reponse.status, 403);
    assert.deepEqual(refus(reponse.body), {
      error: "salle-demande-en-cours",
      code: "salle-demande-en-cours",
      message: TEXTES.partout.refus["salle-demande-en-cours"],
    });
    assert.deepEqual(await b.get(`/api/revoir/${SALLE}?etat=1`), { status: 200, body: { rootId: SALLE, acces: false, raison: "salle-demande-en-cours" } });
  });

  it("une session occupée selon les faits → 403, même avec une demande finie", async (t) => {
    const b = await banc(t);
    salleSimulee(b, { occupee: true });
    b.demande(SALLE, "req_1", 100, true);
    const reponse = await b.get(`/api/revoir/${SALLE}`);
    assert.equal(reponse.status, 403);
    assert.equal(refus(reponse.body).code, "salle-demande-en-cours");
  });

  it("aucune ligne `autonomy_requests` → 403 salle-fin-inconnue", async (t) => {
    const b = await banc(t);
    salleSimulee(b);
    const reponse = await b.get(`/api/revoir/${SALLE}`);
    assert.equal(reponse.status, 403);
    assert.deepEqual(refus(reponse.body), {
      error: "salle-fin-inconnue",
      code: "salle-fin-inconnue",
      message: TEXTES.partout.refus["salle-fin-inconnue"],
    });
    assert.deepEqual(await b.get(`/api/revoir/${SALLE}?etat=1`), { status: 200, body: { rootId: SALLE, acces: false, raison: "salle-fin-inconnue" } });
  });

  it("faits partiels (borne des 20 000) → 403 salle-fin-inconnue, même demande finie et arbre au repos", async (t) => {
    const b = await banc(t);
    salleSimulee(b);
    b.faits.poser(SALLE, [statut(SALLE, SALLE, "repos", 20)], true);
    b.demande(SALLE, "req_1", 100, true);
    const reponse = await b.get(`/api/revoir/${SALLE}`);
    assert.equal(reponse.status, 403);
    assert.equal(refus(reponse.body).code, "salle-fin-inconnue");
  });

  it("fait « Déroulé partiel » du magasin → 403 salle-fin-inconnue (fermé en cas de doute)", async (t) => {
    const b = await banc(t);
    salleSimulee(b);
    b.faits.poser(SALLE, [
      statut(SALLE, SALLE, "repos", 20),
      { rootId: SALLE, sessionId: SALLE, kind: "affichage", ref: null, data: { etat: "deroule-partiel" }, at: 25 },
    ]);
    b.demande(SALLE, "req_1", 100, true);
    assert.equal((await b.get(`/api/revoir/${SALLE}`)).status, 403);
  });

  it("instance illisible : traitée comme la salle, jamais comme l'instance principale", async (t) => {
    const b = await banc(t);
    b.session(SALLE, { instance: "inconnue" as SessionInstance });
    b.faits.poser(SALLE, [statut(SALLE, SALLE, "repos", 20)]);
    assert.equal((await b.get(`/api/revoir/${SALLE}`)).status, 403, "aucune demande enregistrée : refus");
    b.demande(SALLE, "req_1", 100, true);
    const vue = (await b.get(`/api/revoir/${SALLE}`)).body as RevoirResponse;
    assert.equal(vue.instance, "omo");
  });
});

describe("« Revoir » (L28b) : racine de la Salle OMO simulée, mode Avancé", () => {
  it("200 quel que soit l'état de la demande (la salle est réservée au mode Avancé)", async (t) => {
    const b = await banc(t, "avance");
    salleSimulee(b, { occupee: true });
    const reponse = await b.get(`/api/revoir/${SALLE}`);
    assert.equal(reponse.status, 200);
    const vue = reponse.body as RevoirResponse;
    assert.equal(vue.instance, "omo");
    assert.equal(vue.termine, false, "demande en cours : consultable, mais pas terminée");
    assert.deepEqual(await b.get(`/api/revoir/${SALLE}?etat=1`), { status: 200, body: { rootId: SALLE, acces: true, raison: null } });
  });

  it("le mode est relu à chaque requête : le même refus devient un accès en mode Avancé", async (t) => {
    const b = await banc(t);
    salleSimulee(b);
    assert.equal((await b.get(`/api/revoir/${SALLE}`)).status, 403);
    b.h.settings.update({ ui: { mode: "avance" } });
    assert.equal((await b.get(`/api/revoir/${SALLE}`)).status, 200);
  });
});

// --- Racines refusées et identifiants ------------------------------------------------------------------------------------------------

describe("« Revoir » (L28b) : racines refusées, identifiants", () => {
  it("racine inconnue, session enfant et session de service → 404 racine-inconnue", async (t) => {
    const b = await banc(t);
    b.session(ENFANT, { parent: PRINCIPALE, root: PRINCIPALE });
    b.session("ses_classement", { purpose: "classifier" });
    for (const id of [INCONNUE, ENFANT, "ses_classement"]) {
      const reponse = await b.get(`/api/revoir/${id}`);
      assert.equal(reponse.status, 404, id);
      assert.deepEqual(refus(reponse.body), { error: "racine-inconnue", code: "racine-inconnue", message: TEXTES.partout.refus["racine-inconnue"] }, id);
      assert.deepEqual(await b.get(`/api/revoir/${id}?etat=1`), { status: 200, body: { rootId: id, acces: false, raison: "racine-inconnue" } }, id);
    }
  });

  it("identifiant invalide → 400, avec et sans ?etat=1", async (t) => {
    const b = await banc(t);
    for (const invalide of ["ses.point", "ses%20espace", "x".repeat(129)]) {
      assert.equal((await b.get(`/api/revoir/${invalide}`)).status, 400, invalide);
      assert.equal((await b.get(`/api/revoir/${invalide}?etat=1`)).status, 400, `${invalide} ?etat=1`);
    }
  });

  it("chaque code de refus a sa phrase, jamais un gabarit ni la phrase neutre", async (t) => {
    const b = await banc(t);
    salleSimulee(b);
    const codes: RevoirRefus[] = ["racine-inconnue", "salle-fin-inconnue"];
    b.demande(SALLE, "req_1", 100, false);
    const vus = [refus((await b.get(`/api/revoir/${INCONNUE}`)).body).code, "salle-fin-inconnue" as const, refus((await b.get(`/api/revoir/${SALLE}`)).body).code];
    assert.deepEqual(vus, [...codes, "salle-demande-en-cours"]);
    for (const code of [...vus] as RevoirRefus[]) {
      assert.notEqual(libelleRefus(code), TEXTES.partout.refusInconnu, code);
      assert.doesNotMatch(libelleRefus(code), /[{}]/, code);
    }
  });
});

// --- Lecture seule (spéc. l.1169) ---------------------------------------------------------------------------------------------------

describe("« Revoir » (L28b) : lecture seule, aucune facturation", () => {
  it("aucune ligne `usage`, aucune écriture en base et zéro requête reçue par le faux opencode pendant tous les appels", async (t) => {
    const b = await banc(t);
    b.session(PRINCIPALE);
    salleSimulee(b);
    b.demande(SALLE, "req_1", 100, true);
    b.faits.poser(PRINCIPALE, [statut(PRINCIPALE, PRINCIPALE, "repos", 5)]);
    const usage = () => (b.h.db.prepare("SELECT COUNT(*) AS n FROM usage").get() as { n: number }).n;
    const changements = () => (b.h.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const usageAvant = usage();
    const changementsAvant = changements();
    const depuis = b.h.fake.requests.length;

    for (const chemin of [
      `/api/revoir/${PRINCIPALE}`,
      `/api/revoir/${PRINCIPALE}?etat=1`,
      `/api/revoir/${SALLE}`,
      `/api/revoir/${SALLE}?etat=1`,
      `/api/revoir/${INCONNUE}`,
      `/api/revoir/${INCONNUE}?etat=1`,
      "/api/revoir/ses.point",
    ]) {
      await b.get(chemin);
    }

    assert.equal(usage(), usageAvant, "aucune ligne `usage` créée (spéc. l.1169)");
    assert.equal(usage(), 0);
    assert.equal(changements(), changementsAvant, "aucune écriture en base pendant « Revoir »");
    assert.deepEqual(b.h.fake.requests.slice(depuis).map((r) => `${r.method} ${r.pathname}`), [], "zéro requête reçue par le faux opencode");
    // Témoin : le faux voit bien les requêtes du cockpit (le contrôle ci-dessus n'est pas vide).
    await b.h.cockpit.c11.client.request("GET", "/session/status");
    assert.deepEqual(b.h.fake.requests.slice(depuis).map((r) => `${r.method} ${r.pathname}`), ["GET /session/status"]);
    b.h.assertNoGlobalRestart();
  });

  it("?etat=1 ne lit les faits que lorsque la décision en dépend (racine de la salle en mode Simple)", async (t) => {
    const b = await banc(t);
    b.session(PRINCIPALE);
    salleSimulee(b);
    b.faits.lectures.length = 0;
    await b.get(`/api/revoir/${INCONNUE}?etat=1`);
    await b.get(`/api/revoir/${PRINCIPALE}?etat=1`);
    assert.deepEqual(b.faits.lectures, [], "racine inconnue et instance principale : aucune lecture des faits");
    await b.get(`/api/revoir/${SALLE}?etat=1`);
    assert.deepEqual(b.faits.lectures, [SALLE], "racine de la salle en mode Simple : les faits décident (D-3d-09)");
    b.h.settings.update({ ui: { mode: "avance" } });
    await b.get(`/api/revoir/${SALLE}?etat=1`);
    assert.deepEqual(b.faits.lectures, [SALLE], "mode Avancé : la décision ne dépend plus des faits");
    // La réponse complète, elle, les lit toujours : ce sont ses `facts`.
    await b.get(`/api/revoir/${PRINCIPALE}`);
    assert.deepEqual(b.faits.lectures, [SALLE, PRINCIPALE]);
  });

  it("authentification exigée avant la route (garde de http.ts)", async (t) => {
    const b = await banc(t);
    b.session(PRINCIPALE);
    assert.equal((await b.h.call("GET", `/api/revoir/${PRINCIPALE}`)).status, 401);
    assert.equal((await b.h.call("GET", `/api/revoir/${PRINCIPALE}?etat=1`)).status, 401);
  });

  it("aucune autre méthode n'est servie par la route (lecture seule)", async (t) => {
    const b = await banc(t);
    b.session(PRINCIPALE);
    for (const methode of ["POST", "PUT", "PATCH", "DELETE"]) {
      const r = await b.h.call(methode, `/api/revoir/${PRINCIPALE}`, { headers: b.h.headers.mutating, ...(methode === "DELETE" ? {} : { body: {} }) });
      assert.ok(r.status === 404 || r.status === 405, `${methode} : ${r.status}`);
    }
  });
});

// --- Forme des réponses --------------------------------------------------------------------------------------------------------------

describe("« Revoir » (L28b) : forme des réponses", () => {
  it("RevoirResponse et RevoirEtatResponse portent exactement leurs champs", async (t) => {
    const b = await banc(t);
    b.session(PRINCIPALE);
    b.faits.poser(PRINCIPALE, [statut(PRINCIPALE, PRINCIPALE, "repos", 5)]);
    const vue = (await b.get(`/api/revoir/${PRINCIPALE}`)).body as RevoirResponse;
    assert.deepEqual(Object.keys(vue).sort(), ["facts", "instance", "partial", "rootId", "termine", "titre"]);
    const etat = (await b.get(`/api/revoir/${PRINCIPALE}?etat=1`)).body as RevoirEtatResponse;
    assert.deepEqual(Object.keys(etat).sort(), ["acces", "raison", "rootId"]);
  });
});
