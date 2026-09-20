// Routes des consignes gardées (paquet L28d, itération 3 ; U2, D-3d-30, Q7 (a)) : GET /api/revoir/:rootId/consignes/:callId et
// GET /api/revoir/:rootId/consignes?enfant=<id>. Lecture seule, aucune requête à opencode, aucune ligne `usage`.
// La règle d'accès est celle de « Revoir » (Q6, D-3d-09), lue par le port revoir.etat de L28b : ce paquet le SURCHARGE dans ses
// tests (buildSalle3dRoutes(c11, {ports})) et garde le port `consignes` RÉEL, au-dessus de la vraie base du harnais.
import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { Hono } from "hono";
import { createConsignesStore } from "./consignes-store.ts";
import type { RevoirPort } from "./contracts-3d.ts";
import type { NeonMode } from "./shared/neon-scene.ts";
import type { SessionInstance } from "./shared/activity-types.ts";
import type { RevoirConsigneResponse, RevoirConsignesEnfantResponse, RevoirEtatResponse } from "./shared/salle3d-types.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import { buildSalle3dRoutes } from "./wiring-3d.ts";

const ROOT = "ses_racine_principale";
const SALLE = "ses_racine_salle";
const AUTRE = "ses_racine_autre";
const ENFANT = "ses_enfant_1";
const ENFANT_2 = "ses_enfant_2";
const CALL = "call_consigne_1";

/** Fin d'une demande de la salle, telle que la verrait « Revoir » (L28b) : terminée, en cours, ou non vérifiable. */
type Fin = "terminee" | "en-cours" | "inconnue";

interface Simulation {
  app: Hono;
  modes: NeonMode[];
  fin: { valeur: Fin };
}

/**
 * Port `revoir` simulé à la place de L28b : la racine principale est toujours lisible ; la racine de la salle (sessions.instance
 * = 'omo') l'est en mode Avancé, et en mode Simple seulement quand sa dernière demande est terminée (D-3d-09). Le port
 * `consignes` reste celui du paquet, sur la vraie base.
 */
function simuler(h: CockpitHarness): Simulation {
  const modes: NeonMode[] = [];
  const fin = { valeur: "terminee" as Fin };
  const etat = (rootId: string, mode: NeonMode): RevoirEtatResponse => {
    modes.push(mode);
    const lue = (h.db.prepare("SELECT instance FROM sessions WHERE id = ?").get(rootId) as { instance: string } | undefined)?.instance;
    if (lue === undefined) return { rootId, acces: false, raison: "racine-inconnue", instance: null };
    const instance: SessionInstance = lue === "principale" ? "principale" : "omo";
    if (instance !== "omo" || mode === "avance") return { rootId, acces: true, raison: null, instance };
    if (fin.valeur === "terminee") return { rootId, acces: true, raison: null, instance };
    return { rootId, acces: false, raison: fin.valeur === "en-cours" ? "salle-demande-en-cours" : "salle-fin-inconnue", instance };
  };
  const revoir: RevoirPort = {
    etat,
    lire: (rootId, mode) => {
      const acces = etat(rootId, mode);
      return acces.acces
        ? { ok: true, value: { rootId, titre: "[synthétique]", instance: "principale", termine: true, facts: [], partial: false } }
        : { ok: false, status: acces.raison === "racine-inconnue" ? 404 : 403, code: acces.raison ?? "racine-inconnue" };
    },
  };
  const app = new Hono();
  for (const install of buildSalle3dRoutes(h.cockpit.c11, { ports: { revoir } })) install(app);
  return { app, modes, fin };
}

const lignesUsage = (h: CockpitHarness) => (h.db.prepare("SELECT COUNT(*) AS n FROM usage").get() as { n: number }).n;

/** Base du harnais : deux racines principales, une racine de la salle, et les consignes gardées de chacune. */
function garnir(h: CockpitHarness): void {
  const session = h.db.prepare("INSERT INTO sessions (id, parent_id, root_id, instance, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)");
  session.run(ROOT, null, ROOT, "principale");
  session.run(AUTRE, null, AUTRE, "principale");
  session.run(SALLE, null, SALLE, "omo");
  const store = createConsignesStore(h.db);
  assert.equal(store.enregistrer({ rootId: ROOT, parent: ROOT, enfant: ENFANT, callId: CALL, brut: "[synthétique] consigne de la racine principale", at: 1_000 }), "enregistree");
  assert.equal(store.enregistrer({ rootId: ROOT, parent: ROOT, enfant: ENFANT, callId: "call_consigne_2", brut: "[synthétique] seconde consigne", at: 2_000 }), "enregistree");
  assert.equal(store.enregistrer({ rootId: AUTRE, parent: AUTRE, enfant: ENFANT, callId: "call_autre", brut: "[synthétique] consigne d'une autre conversation", at: 3_000 }), "enregistree");
  assert.equal(store.enregistrer({ rootId: SALLE, parent: SALLE, enfant: ENFANT_2, callId: "call_salle", brut: "[synthétique] consigne de la salle", at: 4_000 }), "enregistree");
}

async function get(app: Hono, chemin: string): Promise<{ status: number; body: unknown }> {
  const reponse = await app.request(chemin);
  return { status: reponse.status, body: (await reponse.json()) as unknown };
}

const refus = (body: unknown) => {
  const rendu = body as { error?: unknown; code?: unknown; message?: unknown };
  return { code: String(rendu.code), memeError: rendu.error === rendu.code, phrase: typeof rendu.message === "string" && rendu.message.length > 10 };
};

describe("routes des consignes : racine principale", () => {
  it("200 dans les deux modes, consigne gardée rendue entière ; zéro requête au faux et aucune ligne usage", async (t: TestContext) => {
    const h = await startCockpit(t);
    garnir(h);
    const { app, modes } = simuler(h);
    const depuis = h.fake.requests.length;
    const usageAvant = lignesUsage(h);

    const simple = await get(app, `/api/revoir/${ROOT}/consignes/${CALL}`);
    assert.equal(simple.status, 200);
    assert.deepEqual(simple.body as RevoirConsigneResponse, {
      rootId: ROOT,
      callId: CALL,
      enfant: ENFANT,
      texte: "[synthétique] consigne de la racine principale",
      longueur: 46,
      tronque: false,
      at: 1_000,
    });

    h.settings.update({ ui: { mode: "avance" } });
    const avance = await get(app, `/api/revoir/${ROOT}/consignes/${CALL}`);
    assert.equal(avance.status, 200);
    assert.deepEqual(avance.body, simple.body);
    assert.deepEqual(modes, ["simple", "avance"], "le mode est relu à chaque requête");

    assert.deepEqual(h.fake.requests.slice(depuis).map((r) => `${r.method} ${r.pathname}`), [], "aucune requête à opencode");
    assert.equal(lignesUsage(h), usageAvant, "aucune ligne usage");
    h.assertNoGlobalRestart();
  });

  it("callId inconnu ou d'une autre racine : 404 « consigne-absente » avec sa phrase", async (t: TestContext) => {
    const h = await startCockpit(t);
    garnir(h);
    const { app } = simuler(h);
    for (const callId of ["call_jamais_vu", "call_autre"]) {
      const reponse = await get(app, `/api/revoir/${ROOT}/consignes/${callId}`);
      assert.equal(reponse.status, 404, callId);
      assert.deepEqual(refus(reponse.body), { code: "consigne-absente", memeError: true, phrase: true }, callId);
    }
    // La consigne de l'autre racine existe bien : c'est la racine demandée qui la rend invisible.
    const chezElle = await get(app, `/api/revoir/${AUTRE}/consignes/call_autre`);
    assert.equal(chezElle.status, 200);
  });
});

describe("routes des consignes : racine de la salle simulée (Q6, D-3d-09)", () => {
  it("mode Simple : demande terminée → 200 ; en cours → 403 salle-demande-en-cours ; fin inconnue → 403 salle-fin-inconnue", async (t: TestContext) => {
    const h = await startCockpit(t);
    garnir(h);
    const { app, fin } = simuler(h);

    fin.valeur = "terminee";
    assert.equal((await get(app, `/api/revoir/${SALLE}/consignes/call_salle`)).status, 200);

    fin.valeur = "en-cours";
    const enCours = await get(app, `/api/revoir/${SALLE}/consignes/call_salle`);
    assert.equal(enCours.status, 403);
    assert.deepEqual(refus(enCours.body), { code: "salle-demande-en-cours", memeError: true, phrase: true });

    fin.valeur = "inconnue";
    const inconnue = await get(app, `/api/revoir/${SALLE}/consignes/call_salle`);
    assert.equal(inconnue.status, 403);
    assert.deepEqual(refus(inconnue.body), { code: "salle-fin-inconnue", memeError: true, phrase: true });

    // Mode Avancé : la salle est ouverte, la fin ne compte plus.
    h.settings.update({ ui: { mode: "avance" } });
    assert.equal((await get(app, `/api/revoir/${SALLE}/consignes/call_salle`)).status, 200);
  });

  it("racine inconnue : 404 « racine-inconnue », jamais la consigne, quelle que soit la clé", async (t: TestContext) => {
    const h = await startCockpit(t);
    garnir(h);
    const { app } = simuler(h);
    const reponse = await get(app, `/api/revoir/ses_jamais_vue/consignes/${CALL}`);
    assert.equal(reponse.status, 404);
    assert.deepEqual(refus(reponse.body), { code: "racine-inconnue", memeError: true, phrase: true });
    const parEnfant = await get(app, `/api/revoir/ses_jamais_vue/consignes?enfant=${ENFANT}`);
    assert.equal(parEnfant.status, 404);
    assert.deepEqual(refus(parEnfant.body), { code: "racine-inconnue", memeError: true, phrase: true });
  });
});

describe("routes des consignes : lecture par l'enfant (?enfant=)", () => {
  it("consignes de cette session et de cette racine seulement ; liste vide possible ; même règle d'accès", async (t: TestContext) => {
    const h = await startCockpit(t);
    garnir(h);
    const { app, fin } = simuler(h);

    const reponse = await get(app, `/api/revoir/${ROOT}/consignes?enfant=${ENFANT}`);
    assert.equal(reponse.status, 200);
    const vue = reponse.body as RevoirConsignesEnfantResponse;
    assert.equal(vue.rootId, ROOT);
    assert.equal(vue.enfant, ENFANT);
    // La consigne de AUTRE désigne le même enfant : elle n'est jamais rendue sous cette racine.
    assert.deepEqual(vue.consignes.map((c) => [c.callId, c.at]), [
      [CALL, 1_000],
      ["call_consigne_2", 2_000],
    ]);
    for (const consigne of vue.consignes) assert.equal(consigne.rootId, ROOT);

    const vide = await get(app, `/api/revoir/${ROOT}/consignes?enfant=ses_enfant_sans_consigne`);
    assert.equal(vide.status, 200);
    assert.deepEqual(vide.body, { rootId: ROOT, enfant: "ses_enfant_sans_consigne", consignes: [] });

    // Même règle d'accès que la lecture par callId.
    fin.valeur = "en-cours";
    const salle = await get(app, `/api/revoir/${SALLE}/consignes?enfant=${ENFANT_2}`);
    assert.equal(salle.status, 403);
    assert.deepEqual(refus(salle.body), { code: "salle-demande-en-cours", memeError: true, phrase: true });
    fin.valeur = "terminee";
    assert.equal((await get(app, `/api/revoir/${SALLE}/consignes?enfant=${ENFANT_2}`)).status, 200);
  });
});

describe("routes des consignes : identifiants et méthodes", () => {
  it("identifiant invalide : 400 avant toute lecture (le port n'est jamais appelé)", async (t: TestContext) => {
    const h = await startCockpit(t);
    garnir(h);
    const { app, modes } = simuler(h);
    const invalides = [
      `/api/revoir/ses.point/consignes/${CALL}`,
      `/api/revoir/${"s".repeat(129)}/consignes/${CALL}`,
      `/api/revoir/${ROOT}/consignes/call.point`,
      `/api/revoir/${ROOT}/consignes/${"c".repeat(129)}`,
      `/api/revoir/${ROOT}/consignes/etape%3A1%3A1`,
      `/api/revoir/ses.point/consignes?enfant=${ENFANT}`,
      `/api/revoir/${ROOT}/consignes?enfant=ses.point`,
      `/api/revoir/${ROOT}/consignes`,
      `/api/revoir/${ROOT}/consignes?enfant=`,
    ];
    for (const chemin of invalides) assert.equal((await get(app, chemin)).status, 400, chemin);
    assert.deepEqual(modes, [], "règle d'accès jamais consultée pour un identifiant refusé");
  });

  it("GET seulement : POST, PUT, PATCH et DELETE donnent 404 ou 405, et n'écrivent rien", async (t: TestContext) => {
    const h = await startCockpit(t);
    garnir(h);
    const avant = (h.db.prepare("SELECT COUNT(*) AS n FROM revoir_consignes").get() as { n: number }).n;
    const depuis = h.fake.requests.length;
    for (const methode of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const chemin of [`/api/revoir/${ROOT}/consignes/${CALL}`, `/api/revoir/${ROOT}/consignes?enfant=${ENFANT}`]) {
        const reponse = await h.call(methode, chemin, { headers: h.headers.mutating, ...(methode === "DELETE" ? {} : { body: {} }) });
        assert.ok(reponse.status === 404 || reponse.status === 405, `${methode} ${chemin} : ${reponse.status}`);
      }
    }
    assert.equal((h.db.prepare("SELECT COUNT(*) AS n FROM revoir_consignes").get() as { n: number }).n, avant);
    assert.deepEqual(h.fake.requests.slice(depuis).map((r) => `${r.method} ${r.pathname}`), []);
  });

  it("authentification exigée (garde de http.ts, avant ces routes)", async (t: TestContext) => {
    const h = await startCockpit(t);
    garnir(h);
    for (const chemin of [`/api/revoir/${ROOT}/consignes/${CALL}`, `/api/revoir/${ROOT}/consignes?enfant=${ENFANT}`]) {
      assert.equal((await h.call("GET", chemin)).status, 401, chemin);
    }
  });
});
