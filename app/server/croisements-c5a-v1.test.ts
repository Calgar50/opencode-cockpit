// Tests de croisement du train 5a V1 (plan d'exécution it5 §2.4, §5.3 ; propriété de l'intégrateur) : L44b (méthodes attachées
// aux assistants), L44c (Seconde lecture, serveur) et L46a (coûts et archives par équipe), ENSEMBLE, sur le câblage complet
// (« modules: "tous" »), avec un AssistantService et un StudioService RÉELS sur un dossier temporaire, et les routes d'assistants
// montées par `deps.routes` comme dans main.ts — donc la vraie garde de rechargement de http.ts.
//
// Ce que la vague doit prouver ensemble, et qu'aucun paquet ne pouvait prouver seul (chacun a été écrit sans voir les autres,
// sur son seul module déclaré) :
//   1. les trois modules cohabitent sur le câblage réel : chacun monte ses routes dans le MÊME groupe « construction » sans
//      s'avaler l'un l'autre, et le crochet de la Seconde lecture est le DERNIER de beforeBilledSend, derrière le plancher et
//      les plans qui ne tournaient pas dans les tests de L44c ;
//   2. §5.3 : enregistrer un assistant avec 2 méthodes puis le rouvrir (consignes sans bloc, méthodes rendues, fichier identique
//      à un second enregistrement) ; Seconde lecture (ligne `chat_turns` requalifiée, GET /api/chat/choices/:id qui rend
//      l'assistant PRÉCÉDENT) ; estimation qui CROÎT avec la longueur de la conversation ; GET /api/usage/equipes sur des lignes
//      semées = somme des `usage` ;
//   3. grille de la vague : l'écriture d'un fichier d'agent reste derrière la garde de rechargement (409 SANS écriture), aucune
//      méthode ne s'attache à un nom réservé, le crochet ne requalifie que la ligne de la demande en cours, et aucun chemin
//      facturé ne s'ouvre hors d'`enforceTurn` (P5) — ici avec tous les modules, donc toutes les gardes de la 1.1 en place.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { AssistantService } from "./assistants.ts";
import { openMemoryDb, params } from "./db.ts";
import { METHODS } from "./methods-catalogue.ts";
import { registerAssistantRoutes } from "./routes-assistants.ts";
import { SECOND_READING_MAX_AGE_MS } from "./second-reading.ts";
import type { AssistantView } from "./shared/api-types.ts";
import { COMMON_RULES_START } from "./shared/assistant-rules.ts";
import {
  CONSTRUCTION_ROUTE_PATHS as CHEMINS,
  constructionPath,
  METHODS_PER_ASSISTANT,
  METHODS_PER_MESSAGE,
  METHODS_PER_STEP,
  SECOND_READING_CATALOG_ID,
  SECOND_READING_TURN_KIND,
  TEAM_COSTS_MONTH_PARAM,
} from "./shared/construction-constants.ts";
import { secondReadingPrefix } from "./shared/construction-texts.ts";
import type { MethodsResponse, SecondReadingEstimate, TeamCostsResponse } from "./shared/construction-types.ts";
import { methodMarkers } from "./shared/methods.ts";
import { StudioService } from "./studio.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import { nativeAgents } from "./test-support/fake-opencode.ts";
import { until } from "./test-support/helpers.ts";
import type { TierService } from "./tiers.ts";

/** IA du test et table de prix fixe à quatre tarifs distincts (un montant ne peut pas tomber juste par hasard). */
const MODEL = { providerID: "github-copilot", modelID: "gpt-5-mini" };
const MODEL_KEY = "github-copilot/gpt-5-mini";
const PRICING = { pricing: { overrides: { [MODEL_KEY]: { rates: { input: 10, cachedInput: 1, cacheWrite: 20, output: 100 } } } } };

const RELECTEUR = "relecteur-critique";
const NOM = "croisement-methodes";
const MOIS = "2026-05";
const T = (jour: number, heure = 12) => Date.UTC(2026, 4, jour, heure);

/** Brouillon valide sans fiche : l'enregistrement n'a rien à installer, le corps ne tient que les consignes. */
const DRAFT = {
  title: "Relire un script avant mise en production",
  description: "Relit un script PowerShell ou Bash avant une mise en production et signale les risques, sans rien modifier.",
  useCase: "relire",
  rights: "lecture",
  web: false,
  tier: "equilibre",
  reflection: "standard",
  taskSize: "M",
  instructions: "Relis le script ligne par ligne et signale chaque risque avec sa gravité.",
  fiches: [] as string[],
  examples: [] as string[],
  icon: "eye",
};

interface Croisement {
  h: CockpitHarness;
  /** Réponse en cours simulée : la garde de rechargement de http.ts refuse l'écriture, sans toucher au faux opencode. */
  occupee: (busy: boolean) => void;
  fichier: (name: string) => string;
  existe: (name: string) => boolean;
  put: (name: string, body: unknown) => Promise<{ status: number; body: any }>;
  vue: (name: string) => Promise<AssistantView | undefined>;
  methodes: () => Promise<MethodsResponse>;
}

/**
 * Harnais du croisement : câblage COMPLET (« tous »), Studio et AssistantService réels sur le dossier temporaire du harnais,
 * routes d'assistants montées par `deps.routes` comme dans main.ts. C'est le seul montage où les trois modules de la vague et
 * les gardes de l'itération 1 tournent en même temps.
 */
async function croisement(t: TestContext, options: { mode?: "simple" | "avance" } = {}): Promise<Croisement> {
  const etat = { occupee: false };
  const h = await startCockpit(t, {
    settings: { ...PRICING, ...(options.mode ? { ui: { mode: options.mode } } : {}) },
    modules: "tous",
    ports: { autonomy: { examining: () => etat.occupee } },
    deps: (base) => {
      const studio = new StudioService({
        env: base.env,
        client: base.client,
        projects: base.projects,
        control: base.control,
        log: base.log,
        catalog: base.catalog,
      });
      const assistants = new AssistantService({
        db: base.db,
        env: base.env,
        client: base.client,
        studio,
        lookup: base.lookup,
        tiers: base.tiers as TierService,
        ledger: base.ledger,
        settings: base.settings,
        catalog: base.catalog,
        projects: base.projects,
        hub: base.hub,
        log: base.log,
        queue: base.configQueue,
        reloadBusy: () => etat.occupee,
      });
      const routeDeps = { assistants, tiers: base.tiers as TierService, settings: base.settings, hub: base.hub, log: base.log };
      return { studio, assistants, routes: [(app) => registerAssistantRoutes(app, routeDeps)] };
    },
  });
  const fichierDe = (name: string) => path.join(h.deps.env.opencodeConfigDir, "agents", `${name}.md`);
  return {
    h,
    occupee: (busy: boolean) => {
      etat.occupee = busy;
    },
    fichier: (name) => fs.readFileSync(fichierDe(name), "utf8"),
    existe: (name) => fs.existsSync(fichierDe(name)),
    put: async (name, body) => {
      const res = await h.call("PUT", `/api/assistants/${name}`, { headers: h.headers.mutating, body });
      return { status: res.status, body: res.body ? JSON.parse(res.body) : null };
    },
    vue: async (name) => {
      const res = await h.call("GET", "/api/assistants", { headers: h.headers.authed });
      assert.equal(res.status, 200, res.body);
      return res.json<{ assistants: AssistantView[] }>().assistants.find((a) => a.name === name);
    },
    methodes: async () => {
      const res = await h.call("GET", CHEMINS.methodes, { headers: h.headers.authed });
      assert.equal(res.status, 200, res.body);
      return res.json<MethodsResponse>();
    },
  };
}

/** Occurrences d'un texte, sans expression régulière (les marqueurs portent des caractères spéciaux). */
function compter(texte: string, cherche: string): number {
  let n = 0;
  for (let at = texte.indexOf(cherche); at !== -1; at = texte.indexOf(cherche, at + cherche.length)) n++;
  return n;
}

/** Marqueur d'ouverture du bloc d'une méthode, à sa version du catalogue. */
function debutDe(id: string): string {
  const found = METHODS.find((m) => m.id === id);
  assert.ok(found, `méthode « ${id} » absente du catalogue`);
  return methodMarkers(id, found.version).debut;
}

/** « Relecteur critique » installé : agent vu par opencode (GET /agent) ET ligne `item_meta` venue du catalogue (L45a). */
function installerRelecteur(h: CockpitHarness): void {
  h.fake.setAgents([...nativeAgents(), { name: RELECTEUR, mode: "primary", options: {}, permission: [], model: MODEL }]);
  h.deps.lookup.invalidate();
  const now = Date.now();
  h.db
    .prepare(
      `INSERT INTO item_meta (kind, name, title, tier, task_size, origin, catalog_id, catalog_version, role, created_at, updated_at)
       VALUES ('agents', ?, 'Relecteur critique', 'rapide', 'S', 'catalogue', ?, 1, 'equipier', ?, ?)`,
    )
    .run(RELECTEUR, SECOND_READING_CATALOG_ID, now, now);
}

async function conversation(h: CockpitHarness, title: string): Promise<string> {
  const created = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title } });
  assert.equal(created.status, 200, created.body);
  return created.json<{ id: string }>().id;
}

/** Envoi facturé par le proxy : `enforceTurn` écrit la ligne `chat_turns`, puis les crochets passent. */
const envoyer = (h: CockpitHarness, sessionId: string, agent: string, text: string) =>
  h.call("POST", `/api/oc/session/${sessionId}/prompt_async`, {
    headers: h.headers.mutating,
    body: { agent, model: MODEL, parts: [{ type: "text", text }] },
  });

const genres = (h: CockpitHarness, sessionId: string): string[] =>
  (h.db.prepare("SELECT kind FROM chat_turns WHERE session_id = ? ORDER BY id").all(sessionId) as unknown as { kind: string }[]).map((t) => t.kind);

/** Faits « origine » dérivés pour cette conversation (L4b), dans l'ordre : origine retenue et numéro du cas du §5.7.2. */
const origines = (h: CockpitHarness, sessionId: string): { origine: string; cas: number }[] =>
  (h.db.prepare("SELECT data FROM activity_facts WHERE session_id = ? AND kind = 'origine' ORDER BY at, id").all(sessionId) as unknown as {
    data: string;
  }[]).map((row) => {
    const data = JSON.parse(row.data) as { origine: string; cas: number };
    return { origine: data.origine, cas: data.cas };
  });

/** Ligne `usage` terminée de la conversation : c'est elle qui donne la base « conversation » de l'estimation. */
function semerUsageChat(h: CockpitHarness, id: string, sessionId: string, contexte: number): void {
  const now = Date.now();
  h.db
    .prepare(
      `INSERT INTO usage (message_id, session_id, root_id, provider_id, model_id, agent, created_at, completed_at,
         tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, cost)
       VALUES (?, ?, ?, 'github-copilot', 'gpt-5-mini', ?, ?, ?, ?, 0, 0, 0, 0)`,
    )
    .run(id, sessionId, sessionId, RELECTEUR, now - 2_000, now - 1_000, contexte);
}

const estimer = (h: CockpitHarness, sessionId: string) =>
  h.call("POST", CHEMINS.secondeLectureEstimation, {
    headers: h.headers.mutating,
    body: { directory: h.fake.directory, sessionId, cible: "reponse" },
  });

// --- 1. Les trois modules ensemble sur le câblage réel ---------------------------------------------------------------------------

describe("croisement 5a V1 : les trois modules de la vague sur le câblage complet", () => {
  it("un seul groupe « construction » : les routes des trois modules répondent toutes, aucune n'avale celle d'un autre", async (t) => {
    const c = await croisement(t);
    // Les trois adresses sont lues dans CONSTRUCTION_ROUTE_PATHS, jamais recopiées : une adresse qui s'écarterait des fiches
    // ferait tomber ce test en même temps que celui du client d'API.
    const adresses: readonly [string, string][] = [
      ["GET", CHEMINS.methodes],
      ["GET", `${CHEMINS.coutsEquipes}?${TEAM_COSTS_MONTH_PARAM}=${MOIS}`],
      ["GET", CHEMINS.equipesConversations],
      ["GET", constructionPath(CHEMINS.archivesEquipes, "ses_croisement_v1")],
    ];
    for (const [methode, adresse] of adresses) {
      const res = await c.h.call(methode, adresse, { headers: c.h.headers.authed });
      assert.equal(res.status, 200, `${methode} ${adresse} → ${res.status} : ${res.body}`);
    }
    // L'estimation est une route POST du même groupe : elle n'est pas captée par les GET montés avant elle.
    const est = await estimer(c.h, "ses_croisement_v1");
    assert.equal(est.status, 200, est.body);
    // La chronologie (L47b, V2) n'est toujours pas montée : le groupe partagé n'a pas fabriqué de route fantôme.
    const chrono = await c.h.call("GET", constructionPath(CHEMINS.chronologie, "ses_croisement_v1"), { headers: c.h.headers.authed });
    assert.equal(chrono.status, 404);
    c.h.assertNoGlobalRestart();
  });
});

// --- 2. §5.3 : un assistant avec deux méthodes, enregistré puis rouvert ------------------------------------------------------------

describe("croisement 5a V1 : méthodes attachées à un assistant (L44b)", () => {
  it("2 méthodes : blocs avant les règles communes, consignes rendues SANS bloc, second enregistrement identique à l'octet", async (t) => {
    const c = await croisement(t);
    const ids = ["certitude", "pre-mortem"];
    assert.equal(ids.length, METHODS_PER_ASSISTANT, "la limite du §5.3 est bien celle de construction-constants.ts");

    const premier = await c.put(NOM, { ...DRAFT, methods: ids });
    assert.equal(premier.status, 200, JSON.stringify(premier.body));
    const fichier = c.fichier(NOM);
    for (const id of ids) {
      assert.equal(compter(fichier, debutDe(id)), 1, `${id} : un bloc et un seul`);
      assert.ok(fichier.indexOf(debutDe(id)) < fichier.indexOf(COMMON_RULES_START), `${id} : le bloc précède les règles communes`);
    }

    // Rouvrir : la vue rend les méthodes, et les consignes SANS aucun bloc (elles viennent du FICHIER, débarrassées).
    const vue = await c.vue(NOM);
    assert.ok(vue, "assistant absent de GET /api/assistants");
    assert.deepEqual(vue.methods, ids);
    for (const id of ids) assert.equal(vue.instructions?.includes(debutDe(id)), false, `${id} : bloc rendu dans les consignes`);
    assert.equal(vue.instructions?.includes(COMMON_RULES_START), false, "règles communes rendues dans les consignes");

    // Second enregistrement du brouillon rouvert : fichier identique à l'octet (aucun bloc en double, aucune dérive).
    const second = await c.put(NOM, { ...DRAFT, previousName: NOM, instructions: vue.instructions, methods: vue.methods });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(c.fichier(NOM), fichier, "second enregistrement : le fichier d'agent a changé");
  });

  it("garde de rechargement : réponse en cours → 409 et AUCUNE écriture ; un nom réservé reste refusé", async (t) => {
    const c = await croisement(t);
    const ids = ["certitude"];
    assert.equal((await c.put(NOM, { ...DRAFT, methods: ids })).status, 200);
    const avant = c.fichier(NOM);

    c.occupee(true);
    const refus = await c.put(NOM, { ...DRAFT, previousName: NOM, methods: ["pre-mortem"] });
    assert.equal(refus.status, 409, JSON.stringify(refus.body));
    assert.equal(c.fichier(NOM), avant, "un fichier d'agent a été écrit pendant une réponse en cours");
    c.occupee(false);

    // Nom réservé : refusé avec ou sans méthode, et aucun fichier posé (noms internes du cockpit).
    for (const reserve of ["build", "plan", "cockpit-classifier", "cockpit-controle"]) {
      const res = await c.put(reserve, { ...DRAFT, methods: ids });
      assert.equal(res.status, 409, `${reserve} → ${res.status}`);
      assert.equal(c.existe(reserve), false, `${reserve} : un fichier d'agent a été posé`);
    }
  });

  it("GET /api/methods voit l'assistant réel : utiliseePar et attachee lus dans le FICHIER d'agent", async (t) => {
    const c = await croisement(t, { mode: "avance" });
    assert.equal((await c.put(NOM, { ...DRAFT, methods: ["certitude"] })).status, 200);
    const reponse = await c.methodes();
    const certitude = reponse.methods.find((m) => m.id === "certitude");
    assert.ok(certitude, "méthode « certitude » absente de GET /api/methods");
    // `utiliseePar` porte le nom ET le titre lus dans la ligne item_meta de l'assistant réellement installé.
    assert.deepEqual(certitude.utiliseePar, [{ name: NOM, title: DRAFT.title }]);
    const premortem = reponse.methods.find((m) => m.id === "pre-mortem");
    assert.ok(premortem);
    assert.deepEqual(premortem.utiliseePar, [], "une méthode non attachée est donnée pour utilisée");
    assert.deepEqual(reponse.limites, { parAssistant: METHODS_PER_ASSISTANT, parMessage: METHODS_PER_MESSAGE, parEtape: METHODS_PER_STEP });
  });
});

// --- 3. §5.3 : Seconde lecture sur le proxy, avec tous les crochets en place ---------------------------------------------------------

describe("croisement 5a V1 : Seconde lecture (L44c)", () => {
  it("ligne chat_turns requalifiée, composeur qui retrouve l'assistant précédent, et rien d'autre requalifié", async (t) => {
    const c = await croisement(t);
    installerRelecteur(c.h);
    const ses = await conversation(c.h, "Incident de production");

    assert.equal((await envoyer(c.h, ses, "build", "Analyse ce journal.")).status, 204);
    const avant = await c.h.call("GET", `/api/chat/choices/${ses}`, { headers: c.h.headers.authed });
    assert.equal(avant.json<{ agent: string }>().agent, "build");

    const texte = `${secondReadingPrefix("reponse")}« Analyser un incident ». Vérifie-la.`;
    assert.equal((await envoyer(c.h, ses, RELECTEUR, texte)).status, 204);
    assert.deepEqual(genres(c.h, ses), ["message", SECOND_READING_TURN_KIND]);

    // `lastChatChoice` ne lit que `kind = 'message'` : le composeur retrouve l'assistant d'AVANT la relecture.
    const apres = await c.h.call("GET", `/api/chat/choices/${ses}`, { headers: c.h.headers.authed });
    assert.equal(apres.json<{ agent: string }>().agent, "build");

    // Une seconde conversation menée en parallèle n'est pas touchée : le crochet ne voit que la demande en cours.
    const autre = await conversation(c.h, "Autre conversation");
    assert.equal((await envoyer(c.h, autre, "build", "Autre chose.")).status, 204);
    assert.deepEqual(genres(c.h, autre), ["message"]);

    // P5 : la seconde lecture est un envoi ordinaire, passé par le proxy — aucun chemin facturé propre ne s'est ouvert.
    const recus = c.h.fake.requests.filter((r) => r.method === "POST" && r.pathname.endsWith("/prompt_async"));
    assert.deepEqual(recus.map((r) => (r.body as { agent?: string }).agent), ["build", RELECTEUR, "build"]);
    c.h.assertNoGlobalRestart();
  });

  it("le Journal garde « Vous » : envoi ordinaire puis seconde lecture donnent deux faits « demande » (cas 1), et le composeur rend toujours l'assistant précédent", async (t) => {
    // Croisement L44c × L4b (faits d'activité) : la requalification de la ligne `chat_turns` ne doit pas faire perdre au message
    // son origine « Vous » (spéc. §5.7.2, cas 1). Les deux propriétés tiennent ENSEMBLE : `lastChatChoice` ne lit que
    // `kind = 'message'` (c'est le but de la requalification), pendant que la dérivation reconnaît aussi « seconde-lecture ».
    // « Corriger » du mauvais côté (renoncer à la requalification) ferait tomber l'assertion du composeur.
    const c = await croisement(t);
    installerRelecteur(c.h);
    const ses = await conversation(c.h, "Incident de production");

    assert.equal((await envoyer(c.h, ses, "build", "Analyse ce journal.")).status, 204);
    await until(() => origines(c.h, ses).length === 1);

    const texte = `${secondReadingPrefix("reponse")}« Analyser un incident ». Vérifie-la.`;
    assert.equal((await envoyer(c.h, ses, RELECTEUR, texte)).status, 204);
    assert.deepEqual(genres(c.h, ses), ["message", SECOND_READING_TURN_KIND], "la ligne de la seconde lecture n'a pas été requalifiée");
    await until(() => origines(c.h, ses).length === 2);

    // Aucun « origine-inconnue » : la demande de seconde lecture vient du bouton de l'utilisateur, pas d'ailleurs (JP-1, JS-13).
    assert.deepEqual(origines(c.h, ses), [
      { origine: "demande", cas: 1 },
      { origine: "demande", cas: 1 },
    ]);

    const apres = await c.h.call("GET", `/api/chat/choices/${ses}`, { headers: c.h.headers.authed });
    assert.equal(apres.json<{ agent: string }>().agent, "build", "le composeur ne retrouve plus l'assistant précédent");
    c.h.assertNoGlobalRestart();
  });

  it("estimation : le montant CROÎT avec la longueur de la conversation, sur base « conversation »", async (t) => {
    const c = await croisement(t);
    installerRelecteur(c.h);
    const courte = await conversation(c.h, "Conversation courte");
    const longue = await conversation(c.h, "Conversation longue");
    semerUsageChat(c.h, "use_courte", courte, 2_000);
    semerUsageChat(c.h, "use_longue", longue, 40_000);

    const lire = async (ses: string): Promise<SecondReadingEstimate> => {
      const res = await estimer(c.h, ses);
      assert.equal(res.status, 200, res.body);
      return res.json<SecondReadingEstimate>();
    };
    const petite = await lire(courte);
    const grande = await lire(longue);
    assert.equal(petite.installe, true);
    assert.equal(petite.base, "conversation");
    assert.equal(grande.base, "conversation");
    assert.ok(petite.usd !== null && grande.usd !== null, "montant absent alors que la table de prix est posée");
    assert.ok(grande.usd > petite.usd, `estimation non croissante : ${grande.usd} ≤ ${petite.usd}`);
    // Lecture seule : aucune ligne écrite, aucun envoi à opencode (P5, D-5-22).
    assert.equal(
      (c.h.db.prepare("SELECT COUNT(*) AS n FROM chat_turns").get() as { n: number }).n,
      0,
      "une estimation a écrit une ligne chat_turns",
    );
    assert.equal(c.h.fake.requests.filter((r) => r.pathname.endsWith("/prompt_async")).length, 0);
    c.h.assertNoGlobalRestart();
  });

  it("borne de 5 s : une demande ancienne du relecteur n'est jamais requalifiée", async (t) => {
    const c = await croisement(t);
    installerRelecteur(c.h);
    const ses = await conversation(c.h, "Demande ancienne");
    // Ligne posée à la main, plus vieille que la borne : le crochet de l'envoi suivant ne doit pas la rattraper.
    c.h.db
      .prepare("INSERT INTO chat_turns (session_id, created_at, kind, agent) VALUES (?, ?, 'message', ?)")
      .run(ses, Date.now() - SECOND_READING_MAX_AGE_MS - 60_000, RELECTEUR);
    assert.equal((await envoyer(c.h, ses, "build", "Sans rapport.")).status, 204);
    assert.deepEqual(genres(c.h, ses), ["message", "message"]);
  });
});

// --- 4. §5.3 : coûts par équipe sur des lignes semées ------------------------------------------------------------------------------

describe("croisement 5a V1 : coûts par équipe (L46a)", () => {
  /** Lignes d'un lancement d'équipe, semées dans la base du harnais : deux étapes, deux lignes `usage`. */
  function semerLancement(h: CockpitHarness, runId: string, teamId: string, couts: readonly number[], createdAt = T(10)): number {
    h.db
      .prepare(
        `INSERT INTO team_runs (id, team_id, team_titre, flow, flow_sha256, root_session_id, directory, state, cause,
           estimate_typique, plafond, cost, created_at, ended_at)
         VALUES (:id, :team, 'Revue SQL sur réplica', '{}', 'sha', :root, '/travail/projet', 'terminee', NULL,
           0.2, NULL, 99, :at, :at)`,
      )
      .run(params({ id: runId, team: teamId, root: `ses_${runId}`, at: createdAt }));
    couts.forEach((cout, index) => {
      const sessionId = `ses_${runId}_e${index + 1}`;
      h.db
        .prepare(
          `INSERT INTO team_run_steps (run_id, step_id, tour, tentative, ordre, bloc_index, titre, agent, model, session_id,
             state, verdict, choix, result_excerpt, cost)
           VALUES (:run, :step, 1, 1, :ordre, 0, :titre, 'redacteur', 'github-copilot/gpt-5-mini', :ses,
             'terminee', NULL, NULL, NULL, 0)`,
        )
        .run(params({ run: runId, step: `e${index + 1}`, ordre: index + 1, titre: `Étape ${index + 1}`, ses: sessionId }));
      h.db
        .prepare(
          `INSERT INTO usage (message_id, session_id, root_id, directory, provider_id, model_id, agent, purpose, created_at, cost)
           VALUES (:id, :ses, :root, '/travail/projet', 'github-copilot', 'gpt-5-mini', 'redacteur', 'equipe', :at, :cout)`,
        )
        .run(params({ id: `msg_${runId}_${index}`, ses: sessionId, root: `ses_${runId}`, at: createdAt, cout }));
    });
    return couts.reduce((total, cout) => total + cout, 0);
  }

  it("GET /api/usage/equipes = somme des lignes `usage` des étapes, et non le coût enregistré du lancement", async (t) => {
    const c = await croisement(t);
    c.h.db
      .prepare(
        `INSERT INTO teams (id, titre, description, flow, origine, created_at, updated_at)
         VALUES (:id, 'Revue SQL sur réplica', '', '{}', 'creee', :at, :at)`,
      )
      .run(params({ id: "team_a", at: T(1) }));
    const attendu = semerLancement(c.h, "run_1", "team_a", [0.25, 0.15]) + semerLancement(c.h, "run_2", "team_a", [0.6], T(11));

    const res = await c.h.call("GET", `${CHEMINS.coutsEquipes}?${TEAM_COSTS_MONTH_PARAM}=${MOIS}`, { headers: c.h.headers.authed });
    assert.equal(res.status, 200, res.body);
    const reponse = res.json<TeamCostsResponse>();
    assert.equal(reponse.mois, MOIS);
    assert.equal(reponse.parEquipe.length, 1);
    const ligne = reponse.parEquipe[0];
    assert.ok(ligne);
    assert.equal(ligne.teamId, "team_a");
    assert.equal(ligne.lancements, 2);
    // 1,00 $ exactement : la somme des `usage` (0,25 + 0,15 + 0,60), jamais les 99 $ enregistrés sur les lignes `team_runs`.
    assert.equal(attendu, 1);
    assert.ok(Math.abs(ligne.cout - attendu) < 1e-9, `total ${ligne.cout} ≠ ${attendu}`);
    assert.equal(reponse.lancements.length, 2);
    const premier = reponse.lancements[0];
    assert.ok(premier);
    assert.equal(premier.runId, "run_2", "les plus coûteux ne sont pas triés par coût réel");
    c.h.assertNoGlobalRestart();
  });

  it("mois et identifiant validés (shared/ids.ts) : 400 sans jamais recopier l'entrée reçue", async (t) => {
    const c = await croisement(t);
    const mauvais = `${CHEMINS.coutsEquipes}?${TEAM_COSTS_MONTH_PARAM}=${encodeURIComponent("2026-05' OR 1=1--")}`;
    const res = await c.h.call("GET", mauvais, { headers: c.h.headers.authed });
    assert.equal(res.status, 400, res.body);
    assert.equal(res.body.includes("OR 1=1"), false, "le mois reçu est recopié dans la réponse");
    const archives = await c.h.call("GET", constructionPath(CHEMINS.archivesEquipes, "pas un identifiant"), { headers: c.h.headers.authed });
    assert.ok(archives.status === 400 || archives.status === 404, `identifiant invalide → ${archives.status}`);
  });
});

// --- 5. Base en mémoire : les trois modules ne touchent pas MIGRATIONS ---------------------------------------------------------------

describe("croisement 5a V1 : aucune migration ajoutée par la vague", () => {
  it("la base ouverte par la vague reste au numéro de migration de l'itération 1 (numéro 9 réservé et inutilisé)", (t) => {
    const db = openMemoryDb();
    t.after(() => db.close());
    const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    // Le numéro 9 est réservé à la construction (A2, A2 bis, D-5-03) et doit rester INUTILISÉ pendant toute la 5a : la table
    // `chat_turns` gagne seulement une valeur de `kind`, qui est un type TypeScript, pas une contrainte SQL.
    assert.ok(version < 9, `une migration de la construction a été posée (user_version = ${version})`);
  });
});
