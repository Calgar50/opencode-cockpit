// Tests 1.1 (L44c) : Seconde lecture côté serveur — crochet `secondReading` et route d'estimation.
// Voie principale (MC5-1 tenue, train de V0 de 5a) : la seconde lecture est un message ordinaire envoyé au « Relecteur critique »
// DANS la même conversation, par le proxy. Le cockpit ne fait que requalifier la ligne `chat_turns` qu'`enforceTurn` vient
// d'écrire, et chiffrer une estimation en lecture seule.
// Chaque garde a son contrôle discriminant : sans la reconnaissance de l'assistant, « même texte à un autre assistant » passerait
// en `seconde-lecture` ; sans le début fixe du message, un message ordinaire du relecteur passerait ; sans la borne de 5 s, une
// demande ancienne serait requalifiée ; sans `session_id` (au lieu de `root_id`), la ligne d'une session enfant chiffrerait
// l'estimation ; sans le prix d'écriture de cache, le montant « conversation » tomberait à une autre valeur exacte.
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { describe, it, type TestContext } from "node:test";
import { openMemoryDb } from "./db.ts";
import { estMessageDeSecondeLecture, requalifierTour, SECOND_READING_MAX_AGE_MS } from "./second-reading.ts";
import { TASK_PROFILES } from "./shared/assistant-rules.ts";
import { SECOND_READING_CATALOG_ID, SECOND_READING_TURN_KIND } from "./shared/construction-constants.ts";
import { secondReadingPrefix } from "./shared/construction-texts.ts";
import type { SecondReadingEstimate } from "./shared/construction-types.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import { nativeAgents } from "./test-support/fake-opencode.ts";

const MODEL = { providerID: "github-copilot", modelID: "gpt-5-mini" };
const MODEL_KEY = "github-copilot/gpt-5-mini";
/** Nom d'agent de l'assistant installé depuis l'entrée de catalogue « relecteur-critique » (L45a). */
const RELECTEUR = "relecteur-critique";

/**
 * Table de prix FIXE du test : quatre tarifs distincts, pour que le montant attendu ne puisse pas tomber juste par hasard si le
 * code confondait entrée, cache lu, cache écrit ou sortie (USD par million de jetons).
 */
const RATES = { input: 10, cachedInput: 1, cacheWrite: 20, output: 100 };
const PRICING = { pricing: { overrides: { [MODEL_KEY]: { rates: RATES } } } };

/** Profil S, sortie totale : base des deux montants chiffrés ci-dessous (une dérive la rendrait visible ici, pas ailleurs). */
const SORTIE_S = TASK_PROFILES.S.output;

const texteSecondeLecture = (assistant: string) => `${secondReadingPrefix("reponse")}« ${assistant} ». Vérifie-la.`;
const texteEquipe = (equipe: string) => `${secondReadingPrefix("equipe")}« ${equipe} ». Vérifie-le.`;

interface TourRow {
  id: number;
  session_id: string;
  kind: string;
  agent: string;
}

const tours = (db: DatabaseSync, sessionId: string): TourRow[] =>
  db.prepare("SELECT id, session_id, kind, agent FROM chat_turns WHERE session_id = ? ORDER BY id").all(sessionId) as unknown as TourRow[];

const genres = (db: DatabaseSync, sessionId: string): string[] => tours(db, sessionId).map((t) => t.kind);

/** Assistant « Relecteur critique » installé : agent vu par opencode (`GET /agent`) ET ligne `item_meta` venue du catalogue. */
function installerRelecteur(h: CockpitHarness, options: { model?: { providerID: string; modelID: string } | null; tier?: string | null } = {}): void {
  const model = options.model === undefined ? MODEL : options.model;
  h.fake.setAgents([...nativeAgents(), { name: RELECTEUR, mode: "primary", options: {}, permission: [], ...(model ? { model } : {}) }]);
  h.deps.lookup.invalidate();
  const now = Date.now();
  h.db
    .prepare(
      `INSERT INTO item_meta (kind, name, title, tier, task_size, origin, catalog_id, catalog_version, role, created_at, updated_at)
       VALUES ('agents', ?, 'Relecteur critique', ?, 'S', 'catalogue', ?, 1, 'equipier', ?, ?)`,
    )
    .run(RELECTEUR, options.tier === undefined ? "rapide" : options.tier, SECOND_READING_CATALOG_ID, now, now);
}

/** Conversation créée par le proxy (aucun plancher : le module `floors` n'est pas déclaré par ces tests). */
async function conversation(h: CockpitHarness, title: string): Promise<string> {
  const created = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title } });
  assert.equal(created.status, 200, created.body);
  return created.json<{ id: string }>().id;
}

/** Envoi facturé par le proxy : `enforceTurn` écrit la ligne `chat_turns`, puis les crochets passent. */
function envoyer(h: CockpitHarness, sessionId: string, agent: string, text: string) {
  return h.call("POST", `/api/oc/session/${sessionId}/prompt_async`, {
    headers: h.headers.mutating,
    body: { agent, model: MODEL, parts: [{ type: "text", text }] },
  });
}

/** Corps des `prompt_async` reçus par le faux pour cette conversation. */
const recus = (h: CockpitHarness, sessionId: string): Record<string, unknown>[] =>
  h.fake.requests
    .filter((r) => r.method === "POST" && r.pathname === `/session/${sessionId}/prompt_async`)
    .map((r) => r.body as Record<string, unknown>);

/** Ligne `usage` semée : seule la dernière ligne TERMINÉE et à jetons non nuls de la conversation chiffre l'estimation. */
function semerUsage(
  h: CockpitHarness,
  row: { messageId: string; sessionId: string; rootId: string; createdAt: number; completedAt: number | null; input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number },
): void {
  h.db
    .prepare(
      `INSERT INTO usage (message_id, session_id, root_id, provider_id, model_id, agent, created_at, completed_at,
         tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, cost)
       VALUES (?, ?, ?, 'github-copilot', 'gpt-5-mini', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.messageId,
      row.sessionId,
      row.rootId,
      RELECTEUR,
      row.createdAt,
      row.completedAt,
      row.input ?? 0,
      row.output ?? 0,
      row.cacheRead ?? 0,
      row.cacheWrite ?? 0,
      row.cost ?? 0,
    );
}

/** `n` relectures observées du Relecteur, hors de la conversation estimée : une racine, une ligne `prompts` et son coût chacune. */
function semerObserve(h: CockpitHarness, n: number, coutParDemande: number, prefixe = "a"): void {
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const root = `ses_obs_${prefixe}${i}`;
    h.db
      .prepare("INSERT INTO sessions (id, parent_id, root_id, purpose, created_at, updated_at) VALUES (?, NULL, ?, 'chat', ?, ?)")
      .run(root, root, now - 1_000, now);
    h.db
      .prepare("INSERT INTO prompts (message_id, session_id, root_id, provider_id, model_id, agent, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, 'message', ?)")
      .run(`msg_obs_${prefixe}${i}`, root, root, MODEL.providerID, MODEL.modelID, RELECTEUR, now - 900);
    semerUsage(h, { messageId: `use_obs_${prefixe}${i}`, sessionId: root, rootId: root, createdAt: now - 800, completedAt: now - 700, output: 10, cost: coutParDemande });
  }
}

const estimer = (h: CockpitHarness, sessionId: string, cible: "reponse" | "equipe" = "reponse", headers = h.headers.mutating) =>
  h.call("POST", "/api/chat/second-reading/estimate", { headers, body: { directory: h.fake.directory, sessionId, cible } });

async function estimation(h: CockpitHarness, sessionId: string, cible: "reponse" | "equipe" = "reponse"): Promise<SecondReadingEstimate> {
  const res = await estimer(h, sessionId, cible);
  assert.equal(res.status, 200, res.body);
  return res.json<SecondReadingEstimate>();
}

const start = (t: TestContext, settings: Record<string, unknown> = {}) => startCockpit(t, { modules: ["secondReading"], settings: { ...PRICING, ...settings } });

// --- 1. Reconnaissance du message ---------------------------------------------------------------------------------------------

describe("L44c : début fixe du message de seconde lecture", () => {
  it("reconnaît les deux cibles, et rien d'autre", () => {
    assert.equal(estMessageDeSecondeLecture(texteSecondeLecture("Analyser un incident")), true);
    assert.equal(estMessageDeSecondeLecture(texteEquipe("Revue SQL")), true);
    // Discriminants : un texte qui contient la phrase sans l'ouvrir, ou qui la paraphrase, n'est pas une seconde lecture.
    assert.equal(estMessageDeSecondeLecture(`Bonjour. ${texteSecondeLecture("Analyser un incident")}`), false);
    assert.equal(estMessageDeSecondeLecture("Seconde lecture, s'il te plaît."), false);
    assert.equal(estMessageDeSecondeLecture(""), false);
  });
});

// --- 2. Requalification : borne de 5 s et portée de la requête -------------------------------------------------------------------

describe("L44c : requalification de la ligne chat_turns", () => {
  const poser = (db: DatabaseSync, sessionId: string, agent: string, createdAt: number, kind = "message") =>
    Number(db.prepare("INSERT INTO chat_turns (session_id, created_at, kind, agent) VALUES (?, ?, ?, ?)").run(sessionId, createdAt, kind, agent).lastInsertRowid);

  it("ne touche que la ligne « message » la plus récente de cette conversation, de cet assistant, et de moins de 5 s", (t) => {
    const db = openMemoryDb();
    t.after(() => db.close());
    const now = 1_000_000;
    const ancienne = poser(db, "ses_a", RELECTEUR, now - SECOND_READING_MAX_AGE_MS - 1);
    const autreAgent = poser(db, "ses_a", "build", now - 10);
    const autreSession = poser(db, "ses_b", RELECTEUR, now - 10);
    // Deux demandes récentes du relecteur dans la même conversation (renvoi après un refus, second onglet) : une seule change,
    // la PLUS RÉCENTE, celle qu'`enforceTurn` vient d'écrire.
    const precedente = poser(db, "ses_a", RELECTEUR, now - 8);
    const bonne = poser(db, "ses_a", RELECTEUR, now - 5);

    assert.equal(requalifierTour(db, "ses_a", RELECTEUR, now), 1, "une seule ligne modifiée");
    const genreDe = (id: number) => (db.prepare("SELECT kind FROM chat_turns WHERE id = ?").get(id) as { kind: string }).kind;
    assert.equal(genreDe(bonne), SECOND_READING_TURN_KIND);
    assert.equal(genreDe(precedente), "message", "seule la demande en cours est requalifiée");
    assert.equal(genreDe(ancienne), "message", "une demande de plus de 5 s n'est jamais requalifiée");
    assert.equal(genreDe(autreAgent), "message");
    assert.equal(genreDe(autreSession), "message", "une autre conversation menée en même temps n'est pas touchée");
    // Un second passage prendrait la ligne précédente : la borne de 5 s reste la seule protection, elle est donc testée seule
    // ci-dessus avec `ancienne`, hors de portée quel que soit le nombre de passages.
    assert.equal(requalifierTour(db, "ses_a", RELECTEUR, now), 1);
    assert.equal(genreDe(precedente), SECOND_READING_TURN_KIND);
    assert.equal(requalifierTour(db, "ses_a", RELECTEUR, now), 0, "plus aucune ligne « message » récente");
    assert.equal(genreDe(ancienne), "message");
  });

  it("ne requalifie ni un raccourci ni un résumé", (t) => {
    const db = openMemoryDb();
    t.after(() => db.close());
    const now = 2_000_000;
    const raccourci = poser(db, "ses_c", RELECTEUR, now - 5, "raccourci");
    const resume = poser(db, "ses_c", RELECTEUR, now - 4, "resume");
    assert.equal(requalifierTour(db, "ses_c", RELECTEUR, now), 0);
    const kinds = db.prepare("SELECT kind FROM chat_turns WHERE id IN (?, ?) ORDER BY id").all(raccourci, resume) as Array<{ kind: string }>;
    assert.deepEqual(kinds.map((k) => k.kind), ["raccourci", "resume"]);
  });
});

// --- 3. Crochet beforeBilledSend sur le proxy réel -------------------------------------------------------------------------------

describe("L44c : crochet secondReading sur le proxy", () => {
  it("envoi conforme : le faux reçoit le prompt_async du relecteur, la ligne passe en « seconde-lecture », et le composeur retrouve l'assistant précédent", async (t) => {
    const h = await start(t);
    installerRelecteur(h);
    const ses = await conversation(h, "Incident");

    assert.equal((await envoyer(h, ses, "build", "Analyse ce journal.")).status, 204);
    const avant = await h.call("GET", `/api/chat/choices/${ses}`, { headers: h.headers.authed });
    assert.equal(avant.json<{ agent: string }>().agent, "build");

    assert.equal((await envoyer(h, ses, RELECTEUR, texteSecondeLecture("Analyser un incident"))).status, 204);
    assert.deepEqual(genres(h.db, ses), ["message", SECOND_READING_TURN_KIND]);
    // Le message part bien au relecteur, par le proxy : aucun chemin facturé propre à la seconde lecture (P5).
    assert.deepEqual(recus(h, ses).map((body) => body.agent), ["build", RELECTEUR]);
    // `lastChatChoice` ne lit que `kind = 'message'` : le composeur retrouve l'assistant d'avant la relecture, tel quel.
    const apres = await h.call("GET", `/api/chat/choices/${ses}`, { headers: h.headers.authed });
    assert.equal(apres.json<{ agent: string }>().agent, "build");
    h.assertNoGlobalRestart();
  });

  it("variante « équipe » reconnue aussi", async (t) => {
    const h = await start(t);
    installerRelecteur(h);
    const ses = await conversation(h, "Équipe");
    assert.equal((await envoyer(h, ses, RELECTEUR, texteEquipe("Revue SQL sur réplica"))).status, 204);
    assert.deepEqual(genres(h.db, ses), [SECOND_READING_TURN_KIND]);
  });

  it("même texte à un autre assistant → la ligne reste « message »", async (t) => {
    const h = await start(t);
    installerRelecteur(h);
    const ses = await conversation(h, "Autre assistant");
    assert.equal((await envoyer(h, ses, "build", texteSecondeLecture("Analyser un incident"))).status, 204);
    assert.deepEqual(genres(h.db, ses), ["message"]);
  });

  it("relecteur sans la phrase d'ouverture → la ligne reste « message »", async (t) => {
    const h = await start(t);
    installerRelecteur(h);
    const ses = await conversation(h, "Sans la phrase");
    assert.equal((await envoyer(h, ses, RELECTEUR, "Peux-tu relire le fichier ci-joint ?")).status, 204);
    assert.deepEqual(genres(h.db, ses), ["message"]);
  });

  it("relecteur non installé (aucune ligne de catalogue) → la ligne reste « message »", async (t) => {
    const h = await start(t);
    h.fake.setAgents([...nativeAgents(), { name: RELECTEUR, mode: "primary", options: {}, permission: [], model: MODEL }]);
    h.deps.lookup.invalidate();
    const ses = await conversation(h, "Sans catalogue");
    assert.equal((await envoyer(h, ses, RELECTEUR, texteSecondeLecture("Analyser un incident"))).status, 204);
    assert.deepEqual(genres(h.db, ses), ["message"]);
  });

  it("garde budgétaire refusée → 409 d'enforceTurn, aucune ligne écrite, aucune requalification, rien relayé", async (t) => {
    const h = await start(t);
    installerRelecteur(h);
    const ses = await conversation(h, "Budget");
    assert.equal((await envoyer(h, ses, "build", "Analyse ce journal.")).status, 204);
    h.ledger.percentUsed = () => 120;
    h.ledger.monthTotal = () => 180;
    const refuse = await envoyer(h, ses, RELECTEUR, texteSecondeLecture("Analyser un incident"));
    assert.equal(refuse.status, 409, refuse.body);
    assert.equal(refuse.json<{ error: string }>().error, "budget-guard");
    // `enforceTurn` refuse AVANT d'écrire sa ligne et avant les crochets : rien n'est requalifié, et la demande précédente reste.
    assert.deepEqual(genres(h.db, ses), ["message"]);
    assert.deepEqual(recus(h, ses).map((body) => body.agent), ["build"]);
  });

  it("deux conversations menées en même temps : seule la ligne de la bonne conversation change", async (t) => {
    const h = await start(t);
    installerRelecteur(h);
    const [a, b] = [await conversation(h, "A"), await conversation(h, "B")];
    assert.equal((await envoyer(h, a, RELECTEUR, "Relis ce script.")).status, 204);
    assert.equal((await envoyer(h, b, RELECTEUR, texteSecondeLecture("Analyser un incident"))).status, 204);
    assert.deepEqual(genres(h.db, a), ["message"]);
    assert.deepEqual(genres(h.db, b), [SECOND_READING_TURN_KIND]);
  });
});

// --- 4. Estimation ---------------------------------------------------------------------------------------------------------------

describe("L44c : POST /api/chat/second-reading/estimate", () => {
  it("Relecteur critique absent → installe: false, usd: null, base « aucune », même avec d'autres assistants du catalogue", async (t) => {
    const h = await start(t);
    // Un autre assistant venu du catalogue est installé : seule la ligne dont `catalog_id` vaut « relecteur-critique » compte.
    const now = Date.now();
    h.db
      .prepare(
        `INSERT INTO item_meta (kind, name, title, tier, task_size, origin, catalog_id, catalog_version, role, created_at, updated_at)
         VALUES ('agents', 'analyser-incident', 'Analyser un incident', 'equilibre', 'M', 'catalogue', 'analyser-incident', 1, 'assistant', ?, ?)`,
      )
      .run(now, now);
    h.fake.setAgents([...nativeAgents(), { name: "analyser-incident", mode: "primary", options: {}, permission: [], model: MODEL }]);
    h.deps.lookup.invalidate();
    const ses = await conversation(h, "Sans relecteur");
    assert.deepEqual(await estimation(h, ses), { installe: false, assistant: null, ia: null, usd: null, base: "aucune" });
    // Et aucun envoi de cet autre assistant n'est requalifié, même avec la phrase d'ouverture.
    assert.equal((await envoyer(h, ses, "analyser-incident", texteSecondeLecture("Relire un script"))).status, 204);
    assert.deepEqual(genres(h.db, ses), ["message"]);
  });

  it("ligne de catalogue sans fichier d'agent (assistant supprimé du Studio) → installe: false", async (t) => {
    const h = await start(t);
    installerRelecteur(h);
    h.fake.setAgents([...nativeAgents()]);
    h.deps.lookup.invalidate();
    const ses = await conversation(h, "Agent disparu");
    assert.equal((await estimation(h, ses)).installe, false);
  });

  it("aucune ligne usage, aucune relecture observée → base « profil » (profil S au prix effectif), valeur exacte", async (t) => {
    const h = await start(t);
    installerRelecteur(h);
    const ses = await conversation(h, "Profil");
    const vue = await estimation(h, ses);
    assert.equal(vue.base, "profil");
    assert.deepEqual(vue.assistant, { name: RELECTEUR, title: "Relecteur critique" });
    assert.deepEqual(vue.ia, { model: MODEL_KEY, libelle: "GPT-5 mini" });
    // Profil S : 2 appels de (6 750 jetons en écriture de cache + 6 600 en cache lu + 1 200 en sortie).
    const parAppel = (6_750 * RATES.cacheWrite + 6_600 * RATES.cachedInput + 1_200 * RATES.output) / 1_000_000;
    assert.ok(Math.abs((vue.usd ?? 0) - parAppel * 2) < 0.0001, `profil : ${vue.usd}`);
  });

  it("5 relectures observées, aucune ligne dans la conversation → base « observe » ; 4 seulement → retour au profil", async (t) => {
    const h = await start(t);
    installerRelecteur(h);
    const ses = await conversation(h, "Observé");
    semerObserve(h, 4, 0.1, "quatre");
    assert.equal((await estimation(h, ses)).base, "profil", "4 échantillons ne suffisent pas");
    semerObserve(h, 5, 0.1, "cinq");
    const vue = await estimation(h, ses);
    assert.equal(vue.base, "observe");
    assert.ok(Math.abs((vue.usd ?? 0) - 0.1) < 0.0001, `observé : ${vue.usd}`);
  });

  it("dernière ligne usage de la conversation → base « conversation », valeur exacte : tout le contexte en écriture de cache, plus la sortie du profil S", async (t) => {
    const h = await start(t);
    installerRelecteur(h);
    const ses = await conversation(h, "Conversation");
    // Des relectures observées existent aussi : l'ordre de D-5-22 place « conversation » d'abord.
    semerObserve(h, 5, 0.1);
    const now = Date.now();
    semerUsage(h, { messageId: "m1", sessionId: ses, rootId: ses, createdAt: now - 200, completedAt: now - 150, input: 1_000, cacheRead: 2_000, cacheWrite: 3_000, output: 4_000 });
    const vue = await estimation(h, ses);
    assert.equal(vue.base, "conversation");
    // Contexte = 1 000 + 2 000 + 3 000 + 4 000 = 10 000 jetons, au prix d'ÉCRITURE de cache, plus la sortie du profil S.
    const attendu = (10_000 * RATES.cacheWrite + SORTIE_S * RATES.output) / 1_000_000;
    assert.ok(Math.abs((vue.usd ?? 0) - attendu) < 0.0001, `conversation : ${vue.usd} au lieu de ${attendu}`);
    // Discriminants : au prix d'entrée, ou sans la réponse relue, le montant serait autre.
    assert.ok(Math.abs(attendu - (10_000 * RATES.input + SORTIE_S * RATES.output) / 1_000_000) > 0.0001);
    assert.ok(Math.abs(attendu - (6_000 * RATES.cacheWrite + SORTIE_S * RATES.output) / 1_000_000) > 0.0001);
    assert.equal(SORTIE_S, 2_400, "sortie du profil S : l'attendu ci-dessus la reprend");
  });

  it("le montant croît strictement avec le contexte de la dernière ligne", async (t) => {
    const h = await start(t);
    installerRelecteur(h);
    const ses = await conversation(h, "Croissance");
    const now = Date.now();
    semerUsage(h, { messageId: "court", sessionId: ses, rootId: ses, createdAt: now - 300, completedAt: now - 280, input: 5_000, output: 500 });
    const petit = await estimation(h, ses);
    semerUsage(h, { messageId: "long", sessionId: ses, rootId: ses, createdAt: now - 100, completedAt: now - 80, input: 50_000, output: 5_000 });
    const grand = await estimation(h, ses);
    assert.equal(petit.base, "conversation");
    assert.equal(grand.base, "conversation");
    assert.ok((grand.usd ?? 0) > (petit.usd ?? 0), `${grand.usd} doit dépasser ${petit.usd}`);
  });

  it("ligne non terminée ou à zéro jeton ignorée : la dernière ligne utile fait foi", async (t) => {
    const h = await start(t);
    installerRelecteur(h);
    const ses = await conversation(h, "Lignes écartées");
    const now = Date.now();
    semerUsage(h, { messageId: "utile", sessionId: ses, rootId: ses, createdAt: now - 300, completedAt: now - 280, input: 1_000, cacheRead: 2_000, cacheWrite: 3_000, output: 4_000 });
    semerUsage(h, { messageId: "en-cours", sessionId: ses, rootId: ses, createdAt: now - 100, completedAt: null, input: 900_000, output: 900_000 });
    semerUsage(h, { messageId: "vide", sessionId: ses, rootId: ses, createdAt: now - 50, completedAt: now - 40 });
    const vue = await estimation(h, ses);
    assert.equal(vue.base, "conversation");
    const attendu = (10_000 * RATES.cacheWrite + SORTIE_S * RATES.output) / 1_000_000;
    assert.ok(Math.abs((vue.usd ?? 0) - attendu) < 0.0001, `${vue.usd} au lieu de ${attendu}`);
  });

  it("ligne d'une session enfant de la même conversation, ou d'une autre conversation, ignorée", async (t) => {
    const h = await start(t);
    installerRelecteur(h);
    const ses = await conversation(h, "Enfant et voisine");
    const now = Date.now();
    // Enfant (sous-agent ou étape d'équipe) : son travail n'est pas dans l'historique que le Relecteur recevra.
    semerUsage(h, { messageId: "enfant", sessionId: `${ses}_enfant`, rootId: ses, createdAt: now - 100, completedAt: now - 80, input: 500_000, output: 100_000 });
    semerUsage(h, { messageId: "voisine", sessionId: "ses_voisine", rootId: "ses_voisine", createdAt: now - 60, completedAt: now - 50, input: 700_000, output: 100_000 });
    const vue = await estimation(h, ses);
    assert.equal(vue.base, "profil", "aucune ligne de CETTE conversation : le profil reprend la main");
  });

  it("mode Simple permis ; CSRF manquant → 403 ; corps invalide → 400 ; dossier hors du workspace → 403", async (t) => {
    const h = await start(t);
    installerRelecteur(h);
    assert.equal(h.settings.get().ui.mode, "simple", "mode Simple par défaut");
    const ses = await conversation(h, "Gardes");
    assert.equal((await estimer(h, ses)).status, 200);

    const sansCsrf = await estimer(h, ses, "reponse", h.headers.authed);
    assert.equal(sansCsrf.status, 403);
    assert.equal(sansCsrf.json<{ error: string }>().error, "csrf");
    assert.equal((await h.call("POST", "/api/chat/second-reading/estimate", { body: { directory: h.fake.directory, sessionId: ses, cible: "reponse" } })).status, 401);

    const cible = await h.call("POST", "/api/chat/second-reading/estimate", { headers: h.headers.mutating, body: { directory: h.fake.directory, sessionId: ses, cible: "autre" } });
    assert.equal(cible.status, 400);
    const identifiant = await h.call("POST", "/api/chat/second-reading/estimate", { headers: h.headers.mutating, body: { directory: h.fake.directory, sessionId: "ses/../x", cible: "reponse" } });
    assert.equal(identifiant.status, 400);
    const inconnue = await h.call("POST", "/api/chat/second-reading/estimate", { headers: h.headers.mutating, body: { directory: h.fake.directory, sessionId: ses, cible: "reponse", extra: 1 } });
    assert.equal(inconnue.status, 400, "clé inconnue refusée (strictObject)");
    const dossier = await h.call("POST", "/api/chat/second-reading/estimate", { headers: h.headers.mutating, body: { directory: "/ailleurs", sessionId: ses, cible: "reponse" } });
    assert.equal(dossier.status, 403);
    assert.equal(dossier.json<{ error: string }>().error, "forbidden-directory");
  });

  it("l'estimation ne facture rien et n'appelle jamais opencode pour un envoi", async (t) => {
    const h = await start(t);
    installerRelecteur(h);
    const ses = await conversation(h, "Lecture seule");
    const avant = h.fake.requests.length;
    await estimation(h, ses);
    await estimation(h, ses, "equipe");
    const envois = h.fake.requests.slice(avant).filter((r) => r.method === "POST");
    assert.deepEqual(envois, [], "aucune écriture vers opencode");
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM usage").get()?.n, 0);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM chat_turns").get()?.n, 0);
    h.assertNoGlobalRestart();
  });

  it("module non déclaré : la route n'existe pas (404), et aucun envoi n'est requalifié", async (t) => {
    const h = await startCockpit(t, { modules: [], settings: PRICING });
    installerRelecteur(h);
    const ses = await conversation(h, "Sans module");
    assert.equal((await estimer(h, ses)).status, 404);
    assert.equal((await envoyer(h, ses, RELECTEUR, texteSecondeLecture("Analyser un incident"))).status, 204);
    assert.deepEqual(genres(h.db, ses), ["message"]);
  });

  it("IA propre de l'assistant, sinon son niveau : les deux résolutions donnent l'IA envoyée au chat", async (t) => {
    const h = await start(t);
    // Agent sans `model` dans son fichier : le niveau « Rapide » de sa ligne de catalogue résout l'IA.
    installerRelecteur(h, { model: null });
    const ses = await conversation(h, "Niveau");
    const parNiveau = await estimation(h, ses);
    assert.equal(parNiveau.ia?.model, MODEL_KEY, "niveau Rapide → IA résolue du niveau");
    assert.notEqual(parNiveau.usd, null);
  });

  it("ni IA propre ni niveau connu → aucune estimation, mais l'assistant reste installé", async (t) => {
    const h = await start(t);
    installerRelecteur(h, { model: null });
    const absent = { candidates: ["github-copilot/jamais-au-catalogue"], variant: null };
    h.settings.update({ ai: { tiers: { rapide: absent, equilibre: absent, expert: absent } } });
    const ses = await conversation(h, "Sans IA");
    const vue = await estimation(h, ses);
    assert.equal(vue.installe, true);
    assert.deepEqual(vue.assistant, { name: RELECTEUR, title: "Relecteur critique" });
    assert.equal(vue.ia, null);
    assert.equal(vue.usd, null);
    assert.equal(vue.base, "aucune");
  });
});
