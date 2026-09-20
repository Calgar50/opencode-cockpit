// Tests L10c : plafonds d'une demande autonome (spécification §4.8.1, décision n° 9), « Passé sans contrôle » (§4.10),
// redémarrages d'opencode (§4.11, décision n° 10), garde de rechargement pendant un examen (§3.11, décision du 15/09) et
// P5 / P6. Plan d'exécution, fiche L10c.
// Harnais à modules déclarés (plan §2.2) : le choix d'autonomie (L6a), les faits (L4b), le plancher (L3), l'arrêt de l'arbre
// (L1c), les demandes et le cycle (L10a) et la surveillance de ce paquet ; le port `activation` est surchargé à « permis », la
// porte I1 (ACTIVATION_OUVERTE) n'est jamais touchée. Horloge et sondage injectés : aucune attente réelle, aucun appel facturé.
// Ce que ces tests prouvent, une intégration par plafond : coût → arrêt de l'arbre, fin `plafond-cout`, fait `statut`, puis retour
// à « Demander à chaque fois » avec `retour_cause` affiché ; actions, durée et fichiers → fin et retour, sans arrêt ; délégations
// et contrôles par IA → compteurs annoncés, rien d'autre. Puis : une redirection seule et une affectation passées sans contrôle
// (formes F-l de L8a, mesure MX2 §3) → `stopTree(non-controle)` en choix automatique et Journal ailleurs, aucun faux positif sur
// « echo a > f » ni sur un appel qui a bien demandé ; la séquence M14 rejouée sur le faux → demande `interrompue` + retour ;
// le repli par sondage ; la reprise au démarrage ; la garde de rechargement en 409 pendant un examen.
import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import type { Hono } from "hono";
import type { AssistantService } from "./assistants.ts";
import { capWatchModuleWith, NON_CONTROLE_RULE } from "./autonomy-watch.ts";
import type { ActivationPort, AutonomyPort, Cockpit11Module } from "./contracts-11.ts";
import type { Logger } from "./log.ts";
import { reloadOccupancy, reloadRefusal } from "./reload-guard.ts";
import { registerAiRoutes } from "./routes-assistants.ts";
import type { TierService } from "./tiers.ts";
import type { SessionRow } from "./sessions.ts";
import { activityStatus, emptyActivity, liveRows, replayFacts } from "./shared/activity.ts";
import type { ActivityFact } from "./shared/activity-types.ts";
import { phrasePlafond, phraseRegle, phraseRetour, regleCarte, TEXTES } from "./shared/autonomy-texts.ts";
import { raisonNonControle } from "./shared/autonomy-watch-texts.ts";
import type { AutonomyCaps, ConversationAutonomyView } from "./shared/autonomy-types.ts";
import { isNoRequestShellForm } from "./shared/shell-gate.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import { until } from "./test-support/helpers.ts";

const MODEL = { providerID: "github-copilot", modelID: "gpt-5-mini" };
const PERMIS: ActivationPort = { check: async () => ({ ok: true }) };

interface LogLine {
  level: string;
  message: string;
  fields: Record<string, unknown>;
}

function spyLogger(lines: LogLine[]): Logger {
  const push = (level: string) => (message: string, fields?: Record<string, unknown>) => void lines.push({ level, message, fields: fields ?? {} });
  return { debug: push("debug"), info: push("info"), warn: push("warn"), error: push("error") };
}

interface Bench {
  h: CockpitHarness;
  /** Décalage de l'horloge injectée dans la surveillance, en ms (plafond de durée : aucune attente réelle). */
  avance(ms: number): void;
  /** Un tour du repli par sondage (la minuterie n'est jamais posée pendant les tests). */
  poll(): Promise<void>;
  /** Décision en examen simulée : c'est elle qu'alimente `reloadBusy` (composé par wiring-11, branché par L1a). */
  examen: { value: boolean };
  logs: LogLine[];
}

async function startBench(t: TestContext, options: { settings?: Record<string, unknown> } = {}): Promise<Bench> {
  let decalage = 0;
  const logs: LogLine[] = [];
  const ticks: Array<() => Promise<void>> = [];
  const examen = { value: false };
  const capWatch: Cockpit11Module = capWatchModuleWith({
    now: () => Date.now() + decalage,
    schedule: (tick) => {
      ticks.push(tick);
      return () => void ticks.splice(ticks.indexOf(tick), 1);
    },
  });
  const h = await startCockpit(t, {
    modules: ["floors", "facts", "conversationAutonomy", "requests", "stopTree", "autonomy", capWatch],
    settings: { ui: { mode: "simple" }, ...(options.settings ?? {}) },
    ports: { activation: PERMIS },
    deps: () => ({ log: spyLogger(logs) }),
  });
  return {
    h,
    avance: (ms) => void (decalage += ms),
    poll: async () => {
      for (const tick of [...ticks]) await tick();
    },
    examen,
    logs,
  };
}

/**
 * Banc de la garde de rechargement (§3.11) : `reloadBusy` est composé par wiring-11 à partir de `ports.autonomy.examining()` et
 * branché par L1a ; ici l'examen est un drapeau, et les routes d'assistants sont montées comme le fait main.ts.
 */
async function startGuardBench(t: TestContext, settings: Record<string, unknown> = {}): Promise<Bench> {
  const logs: LogLine[] = [];
  const examen = { value: false };
  const autonomy: AutonomyPort = { examining: () => examen.value };
  const h = await startCockpit(t, {
    modules: ["conversationAutonomy"],
    settings: { ui: { mode: "simple" }, ...settings },
    ports: { activation: PERMIS, autonomy },
    deps: (base) => {
      const routeDeps = {
        assistants: base.assistants as AssistantService,
        tiers: base.tiers as TierService,
        settings: base.settings,
        hub: base.hub,
        log: base.log,
      };
      return { log: spyLogger(logs), routes: [(app: Hono) => registerAiRoutes(app, routeDeps)] };
    },
  });
  return { h, avance: () => undefined, poll: async () => undefined, examen, logs };
}

// --- Aides ------------------------------------------------------------------------------------------------------------------------

/**
 * Barrière du flux : une conversation créée après coup ; quand le cockpit la suit, il a traité tout ce qui précède sur le même
 * flux, dérivations comprises. Sans elle, un test qui vérifie qu'il ne s'est RIEN passé conclurait avant l'arrivée des
 * événements (contrôle de mutation : les gardes survivaient toutes).
 */
async function barriere(h: CockpitHarness): Promise<void> {
  const info = await h.deps.client.request<{ id: string }>("POST", "/session", { body: { title: "barrière" } });
  await until(() => h.sessions.get(info.id));
  // Le travail que les dérivations posent hors de l'appel (microtâche) est fait au tour de boucle suivant.
  await new Promise((resolve) => setTimeout(resolve, 5));
}

async function conversation(h: CockpitHarness, title = "Autonomie"): Promise<SessionRow> {
  const created = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title } });
  assert.equal(created.status, 200, created.body);
  const { id } = created.json<{ id: string }>();
  return until(() => h.sessions.get(id));
}

async function choisir(h: CockpitHarness, rootId: string, choix: string, plafonds?: Partial<AutonomyCaps>): Promise<void> {
  const put = await h.call("PUT", `/api/conversations/${rootId}/autonomie`, {
    headers: h.headers.confirmed,
    body: plafonds === undefined ? { choix } : { choix, plafonds },
  });
  assert.equal(put.status, 200, put.body);
}

const prompt = (h: CockpitHarness, rootId: string, text = "Travaille.") =>
  h.call("POST", `/api/oc/session/${rootId}/prompt_async`, {
    headers: h.headers.mutating,
    body: { agent: "build", model: MODEL, parts: [{ type: "text", text }] },
  });

interface RequestRow {
  id: string;
  root_id: string;
  started_at: number;
  ended_at: number | null;
  auto: number;
  fichiers: number;
  delegations: number;
  controles: number;
  fin: string | null;
}

const requests = (h: CockpitHarness, rootId: string): RequestRow[] =>
  h.db.prepare("SELECT * FROM autonomy_requests WHERE root_id = ? ORDER BY rowid").all(rootId) as unknown as RequestRow[];

const facts = (h: CockpitHarness, rootId: string, kind: string): ActivityFact[] =>
  (h.db.prepare("SELECT * FROM activity_facts WHERE root_id = ? AND kind = ? ORDER BY id").all(rootId, kind) as Array<Record<string, string>>).map(
    (row) => ({ ...row, data: JSON.parse(row.data ?? "{}") }) as unknown as ActivityFact,
  );

/** Faits « statut » d'un arrêt, d'un plafond ou d'un redémarrage (`data.cause`) ; ceux du Déroulé (L4b) portent `etat`. */
const statuts = (h: CockpitHarness, rootId: string): ActivityFact[] => facts(h, rootId, "statut").filter((fact) => fact.data.cause !== undefined);

/** Faits d'une conversation tels que `GET …/facts` les sert : ce que le Déroulé rejoue (replayFacts). */
const c11Facts = (h: CockpitHarness, rootId: string): ActivityFact[] => h.cockpit.c11.ports.facts.since(rootId, 0).facts;

/** Appel `bash` passé sans contrôle, identifiant fixé pour vérifier le `ref` des faits. */
const CALL_FL = "call_sanscontrole";
/** Demande d'autorisation encore ouverte au moment de la détection (rejeu du réducteur). */
const PERMISSION_OUVERTE = "per_attenteouverte";

const decisions = (h: CockpitHarness, rootId: string) =>
  h.db.prepare("SELECT * FROM autonomy_decisions WHERE root_id = ? ORDER BY id").all(rootId) as Array<Record<string, unknown>>;

const aborts = (h: CockpitHarness) => h.fake.requests.filter((r) => r.method === "POST" && /^\/session\/[^/]+\/abort$/.test(r.pathname));

/** Publication de `usage.updated {rootId}` : la surveillance des plafonds est hors file, sur cet abonnement (§4.8.1). */
const usageUpdated = (h: CockpitHarness, rootId: string | null, percent = 0) =>
  h.hub.cockpit("usage.updated", { ...(rootId === null ? {} : { rootId, sessionId: rootId }), monthSpentUsd: 0, percent });

/** Dépense de l'arbre enregistrée au registre, comme le fait le processeur pour un message clos. */
const depense = (h: CockpitHarness, rootId: string, cost: number, at = Date.now()) =>
  h.db
    .prepare(
      `INSERT INTO usage (message_id, session_id, root_id, provider_id, model_id, created_at, completed_at, cost)
       VALUES (?, ?, ?, 'github-copilot', 'gpt-5-mini', ?, ?, ?)`,
    )
    .run(`msg_${String(at)}_${String(Math.round(cost * 1000))}`, rootId, rootId, at, at, cost);

const vue = async (h: CockpitHarness, rootId: string): Promise<ConversationAutonomyView> => {
  const res = await h.call("GET", `/api/conversations/${rootId}/autonomie`, { headers: h.headers.authed });
  assert.equal(res.status, 200, res.body);
  return res.json<ConversationAutonomyView>();
};

/** Conversation en « Autonome avec contrôle » avec une demande ouverte (le tour du faux n'appelle aucun outil). */
async function demandeOuverte(bench: Bench, plafonds?: Partial<AutonomyCaps>): Promise<SessionRow> {
  const { h } = bench;
  const conv = await conversation(h);
  await choisir(h, conv.id, "autonome", plafonds);
  h.fake.script(conv.id, { text: "Fait." });
  assert.equal((await prompt(h, conv.id)).status, 204);
  await until(() => requests(h, conv.id).at(-1));
  // Tour du faux terminé et vu par le cockpit : un test qui vérifie ensuite qu'il ne s'est rien passé conclut sur un flux au repos.
  await barriere(h);
  return conv;
}

const ligneRetour = (h: CockpitHarness, rootId: string) =>
  h.db.prepare("SELECT choix, retour_cause FROM conversation_autonomy WHERE root_id = ?").get(rootId) as { choix: string; retour_cause: string | null };

// --- 1. Plafonds (§4.8.1, décision n° 9) -----------------------------------------------------------------------------------------

describe("L10c : plafonds d'une demande autonome", () => {
  it("valeurs de la décision n° 9 livrées par défaut : 1,00 $, 60 actions, 5 délégations, 30 minutes, 25 fichiers, 20 contrôles", async (t) => {
    const bench = await startBench(t);
    assert.deepEqual(bench.h.settings.get().budget.autonomie, {
      plafondUsd: 1,
      plafondMaxUsd: 5,
      actionsMax: 60,
      delegationsMax: 5,
      dureeMinutes: 30,
      fichiersMax: 25,
      controlesIaMax: 20,
      controleIa: true,
    });
  });

  it("coût : l'arbre est arrêté (fin `plafond-cout`, fait `statut`), puis retour à « Demander à chaque fois » avec `retour_cause` affiché", async (t) => {
    const bench = await startBench(t);
    const { h } = bench;
    const conv = await demandeOuverte(bench, { plafondUsd: 0.05 });
    const ouverte = requests(h, conv.id).at(-1);
    assert.ok(ouverte);
    assert.equal(ouverte.fin, null);

    depense(h, conv.id, 0.08);
    usageUpdated(h, conv.id);

    const close = await until(() => requests(h, conv.id).find((row) => row.fin !== null));
    assert.equal(close.fin, "plafond-cout");
    assert.equal(close.id, ouverte.id);
    // stopTree (L1c) : arrêt de l'arbre et fait statut {cause: plafond, motif: plafond-cout}.
    const statut = await until(() => statuts(h, conv.id).find((fact) => fact.data.cause === "plafond"));
    assert.equal(statut.data.motif, "plafond-cout");
    assert.ok(h.cockpitEvents().some((event) => event.type === "conversation.arretee"));
    assert.ok(aborts(h).length > 0, "l'arbre doit être arrêté au plafond de coût");

    // Retour à « Demander à chaque fois » : ligne, fait « choix », événement et vue.
    const ligne = await until(() => {
      const row = ligneRetour(h, conv.id);
      return row.choix === "demander" ? row : undefined;
    });
    assert.equal(ligne.retour_cause, "plafond-cout");
    const choix = facts(h, conv.id, "choix").at(-1);
    assert.deepEqual(choix?.data, { choix: "demander", cause: "plafond-cout" });
    const view = await vue(h, conv.id);
    assert.equal(view.choix, "demander");
    assert.equal(view.retourCause, "plafond-cout");
    assert.equal(phraseRetour("plafond-cout"), "Retour à « Demander à chaque fois » : plafond d'arrêt atteint.");
    // Phrase exacte du plafond de coût (§4.8.1 et §6), avec la dépense et le plafond de la demande.
    assert.equal(
      phrasePlafond("cout", { spent: 0.08, plafonds: view.plafonds }, "simple"),
      "Arrêtée : plafond d'arrêt atteint (0,08 $ sur 0,05 $). L'appel en cours de chaque assistant au travail peut l'avoir dépassé ; GitHub Copilot peut facturer un appel interrompu.",
    );
    h.assertNoGlobalRestart();
  });

  it("actions : une décision automatique de trop ferme la demande (`plafond-actions`) et ramène à « Demander », sans arrêter l'arbre", async (t) => {
    const bench = await startBench(t);
    const { h } = bench;
    const conv = await conversation(h);
    await choisir(h, conv.id, "autonome", { actionsMax: 1 });
    h.fake.script(conv.id, {
      tools: [{ tool: "skill", input: { name: "revue" }, ask: { permission: "skill", patterns: ["revue"] } }],
      followUp: { text: "Fait." },
    });
    assert.equal((await prompt(h, conv.id)).status, 204);

    const close = await until(() => requests(h, conv.id).find((row) => row.fin !== null), 5_000);
    assert.equal(close.fin, "plafond-actions");
    assert.equal(close.auto, 1);
    assert.equal(ligneRetour(h, conv.id).retour_cause, "plafond-actions");
    const statut = statuts(h, conv.id).find((fact) => fact.data.cause === "plafond");
    assert.equal(statut?.data.motif, "plafond-actions");
    // Décision n° 9 : au-delà des autres plafonds, retour à « Demander à chaque fois », jamais un arrêt.
    assert.deepEqual(aborts(h), []);
    assert.equal(phraseRetour("plafond-actions"), "Retour à « Demander à chaque fois » : plafond d'actions automatiques atteint.");
    h.assertNoGlobalRestart();
  });

  it("durée : l'horloge injectée dépasse la durée maximale (`plafond-duree`), retour à « Demander », sans arrêt", async (t) => {
    const bench = await startBench(t);
    const { h } = bench;
    const conv = await demandeOuverte(bench, { dureeMinutes: 30 });
    usageUpdated(h, conv.id);
    assert.equal(requests(h, conv.id).at(-1)?.fin, null, "sous la durée maximale, rien ne se ferme");

    bench.avance(31 * 60_000);
    usageUpdated(h, conv.id);

    const close = await until(() => requests(h, conv.id).find((row) => row.fin !== null));
    assert.equal(close.fin, "plafond-duree");
    assert.equal(ligneRetour(h, conv.id).retour_cause, "plafond-duree");
    assert.deepEqual(aborts(h), []);
    assert.equal(phraseRetour("plafond-duree"), "Retour à « Demander à chaque fois » : durée maximale atteinte.");
  });

  it("fichiers : un compte qui dépasse le plafond ferme la demande (`plafond-fichiers`) et ramène à « Demander »", async (t) => {
    const bench = await startBench(t);
    const { h } = bench;
    const conv = await demandeOuverte(bench, { fichiersMax: 2 });
    const ouverte = requests(h, conv.id).at(-1);
    assert.ok(ouverte);
    // E5 (L9a) retient chaque fichier nouveau au-delà du plafond : seul un compte qui le DÉPASSE arrête l'autonomie (plafond
    // abaissé pendant la demande, compteur illisible). Il est posé ici pour tenir l'intégration sur le seul effet de L10c.
    h.db.prepare("UPDATE autonomy_requests SET fichiers = 2 WHERE id = ?").run(ouverte.id);
    usageUpdated(h, conv.id);
    assert.equal(requests(h, conv.id).at(-1)?.fin, null, "au plafond compris, la demande continue");

    h.db.prepare("UPDATE autonomy_requests SET fichiers = 3 WHERE id = ?").run(ouverte.id);
    usageUpdated(h, conv.id);

    const close = await until(() => requests(h, conv.id).find((row) => row.fin !== null));
    assert.equal(close.fin, "plafond-fichiers");
    assert.equal(ligneRetour(h, conv.id).retour_cause, "plafond-fichiers");
    assert.deepEqual(aborts(h), []);
  });

  it("délégations et contrôles par IA : compteurs annoncés une fois avec leur phrase, sans arrêt ni retour à « Demander »", async (t) => {
    const bench = await startBench(t);
    const { h } = bench;
    const conv = await demandeOuverte(bench);
    const ouverte = requests(h, conv.id).at(-1);
    assert.ok(ouverte);

    h.db.prepare("UPDATE autonomy_requests SET delegations = 5, controles = 20 WHERE id = ?").run(ouverte.id);
    usageUpdated(h, conv.id);
    usageUpdated(h, conv.id);

    const annonces = bench.logs.filter((line) => line.message === "autonomie : plafond compté atteint");
    assert.deepEqual(
      annonces.map((line) => line.fields.plafond),
      ["delegations", "controles"],
      "une annonce par plafond compté et par demande",
    );
    const caps = { spent: 0, plafonds: (await vue(h, conv.id)).plafonds };
    assert.equal(annonces[0]?.fields.phrase, phrasePlafond("delegations", caps, "simple"));
    assert.equal(annonces[0]?.fields.phrase, "Plafond de délégations atteint (5) : les suivantes sont refusées et l'IA continue seule.");
    assert.equal(annonces[1]?.fields.phrase, "Plafond de contrôles par IA atteint (20) : les commandes à juger attendent votre accord.");
    // Ni arrêt, ni fin, ni retour : leur effet appartient à L10e (délégations) et à L11b (contrôles).
    assert.equal(requests(h, conv.id).at(-1)?.fin, null);
    assert.equal(ligneRetour(h, conv.id).choix, "autonome");
    assert.deepEqual(aborts(h), []);
  });

  it("aucune demande ouverte, ou dépense sous le plafond : la surveillance ne fait rien", async (t) => {
    const bench = await startBench(t);
    const { h } = bench;
    const conv = await conversation(h);
    // Conversation sans demande autonome : un usage.updated ne ferme rien et ne change aucun choix.
    depense(h, conv.id, 9);
    usageUpdated(h, conv.id);
    usageUpdated(h, null);
    await bench.poll();
    assert.deepEqual(requests(h, conv.id), []);
    assert.deepEqual(statuts(h, conv.id), []);
    assert.equal(ligneRetour(h, conv.id), undefined);
  });
});

// --- 2. « Passé sans contrôle » (§4.10, mesures MX2 §2 et §3) ---------------------------------------------------------------------

describe("L10c : « Passé sans contrôle »", () => {
  it("affectation puis redirection seule, sans aucune demande : l'arbre est arrêté (`non-controle`) et le Journal garde la trace", async (t) => {
    const bench = await startBench(t);
    const { h } = bench;
    const conv = await conversation(h);
    await choisir(h, conv.id, "autonome");
    // Formes F-l confirmées par MX2 §3 : aucune demande d'autorisation n'est posée pour elles.
    h.fake.script(conv.id, {
      tools: [
        { tool: "bash", input: { command: "x=1" } },
        { tool: "bash", input: { command: "> f" } },
      ],
      followUp: { text: "Fait." },
    });
    assert.equal((await prompt(h, conv.id)).status, 204);

    const close = await until(() => requests(h, conv.id).find((row) => row.fin !== null), 5_000);
    assert.equal(close.fin, "non-controle");
    const statut = await until(() => statuts(h, conv.id).find((fact) => fact.data.cause === "non-controle"));
    assert.equal(statut.data.motif, "non-controle");
    assert.ok(aborts(h).length > 0, "un choix automatique arrête l'arbre");
    const ligne = decisions(h, conv.id).at(0);
    assert.equal(ligne?.verdict, "non-controle");
    assert.equal(ligne?.permission, "bash");
    assert.equal(ligne?.regle, NON_CONTROLE_RULE);
    assert.equal(ligne?.par, "cockpit");
    assert.equal(ligne?.raison, raisonNonControle());
    assert.equal(ligne?.resume, "x=1");
    assert.equal(ligne?.request_id, close.id);
    // D-01 : une ligne de Journal, un fait « decision » — sans lui le Déroulé ne lit jamais le Journal du contrôle (L12c).
    const decision = await until(() => facts(h, conv.id, "decision").at(0));
    assert.deepEqual(decision.data, { verdict: "non-controle", regle: NON_CONTROLE_RULE });
    assert.equal(facts(h, conv.id, "decision").length, decisions(h, conv.id).length, "un fait « decision » par ligne de Journal");
    // Côté réducteur, l'arrêt de L1c est bien vu : c'est la contrepartie du cas sans arrêt ci-dessous.
    const etat = replayFacts(emptyActivity(conv.id), c11Facts(h, conv.id));
    assert.equal(activityStatus(etat).arret?.cause, "non-controle", "un vrai arrêt reste enregistré comme tel");
    h.assertNoGlobalRestart();
  });

  it("hors d'un choix automatique : Journal, fait « decision » et fait « detection » ; aucune attente n'est fermée", async (t) => {
    const bench = await startBench(t);
    const { h } = bench;
    const conv = await conversation(h);
    h.fake.script(conv.id, { tools: [{ tool: "bash", callID: CALL_FL, input: { command: "> f" } }], followUp: { text: "Fait." } });
    assert.equal((await prompt(h, conv.id)).status, 204);

    const ligne = await until(() => decisions(h, conv.id).at(0), 5_000);
    assert.equal(ligne.verdict, "non-controle");
    assert.equal(ligne.choix, "demander");
    assert.equal(ligne.request_id, null);
    assert.deepEqual(aborts(h), []);
    assert.deepEqual(requests(h, conv.id), []);
    // Rien n'a été arrêté : aucun fait d'arrêt (`statut {cause}`), seulement un fait de détection.
    assert.deepEqual(statuts(h, conv.id), [], "aucun fait d'arrêt : rien n'a été arrêté");
    const detection = await until(() => facts(h, conv.id, "detection").at(0));
    assert.deepEqual([detection.data, detection.ref], [{ cas: "non-controle" }, CALL_FL]);
    const decision = await until(() => facts(h, conv.id, "decision").at(0));
    assert.deepEqual([decision.data, decision.ref], [{ verdict: "non-controle", regle: NON_CONTROLE_RULE }, CALL_FL]);
    assert.equal(facts(h, conv.id, "decision").length, decisions(h, conv.id).length, "un fait « decision » par ligne de Journal");

    // Rejeu dans le réducteur (§3.10) sur la suite réelle, arrêtée à la détection et complétée d'une attente d'accord ouverte
    // (scénario de la fiche : l'assistant demande l'autorisation de modifier un fichier, puis lance `> f` dans le même tour).
    const tous = c11Facts(h, conv.id);
    const iDetection = tous.findIndex((fait) => fait.kind === "detection");
    assert.ok(iDetection >= 0, "fait de détection enregistré");
    const cible = tous[iDetection] as ActivityFact;
    // Le repos de fin de tour est écarté (la conversation attend encore) ; TOUT ce qui suit la détection est gardé, pour qu'un
    // fait d'arrêt écrit à sa place ou à côté d'elle soit vu par ce rejeu.
    const sansRepos = (liste: readonly ActivityFact[]): ActivityFact[] => liste.filter((fait) => fait.data.etat !== "repos");
    const attente: ActivityFact = { rootId: conv.id, sessionId: conv.id, kind: "attente", ref: PERMISSION_OUVERTE, data: { permission: "edit" }, at: cible.at - 1 };
    const etat = replayFacts(emptyActivity(conv.id), [...sansRepos(tous.slice(0, iDetection)), attente, ...sansRepos(tous.slice(iDetection))]);
    const racine = liveRows(etat, Date.now()).find((row) => row.key === conv.id);
    assert.equal(racine?.state, "attente-accord", "le Déroulé dit toujours « En attente de votre accord »");
    assert.equal(racine?.permissionId, PERMISSION_OUVERTE, "la demande d'autorisation ouverte reste répondable");
    assert.equal(activityStatus(etat).arret, null, "aucune conversation arrêtée : rien n'a été arrêté");
  });

  it("« echo a > f » n'est pas une forme sans demande (MX2 §3) : aucun faux positif", async (t) => {
    assert.equal(isNoRequestShellForm("echo a > f"), false);
    assert.equal(isNoRequestShellForm("> f"), true);
    assert.equal(isNoRequestShellForm("x=1"), true);
    const bench = await startBench(t);
    const { h } = bench;
    const conv = await conversation(h);
    await choisir(h, conv.id, "autonome");
    h.fake.script(conv.id, { tools: [{ tool: "bash", input: { command: "echo a > f" } }], followUp: { text: "Fait." } });
    assert.equal((await prompt(h, conv.id)).status, 204);

    await barriere(h);
    assert.equal(requests(h, conv.id).at(-1)?.fin, null);
    assert.deepEqual(decisions(h, conv.id), []);
    assert.deepEqual(aborts(h), []);
  });

  it("le code de règle écrit au Journal a sa phrase : le repère du Déroulé ne dit jamais « Règle inconnue… »", () => {
    for (const mode of ["simple", "avance"] as const) {
      for (const controleIa of [true, false]) {
        const phrase = phraseRegle(NON_CONTROLE_RULE, { mode, controleIa });
        assert.notEqual(phrase, TEXTES.partout.regles.inconnue, `${mode} / controleIa ${String(controleIa)}`);
        assert.ok(phrase.length > 0 && !/[{}]/.test(phrase), phrase);
        // La règle dit QUELLE forme est passée ; la raison du Journal dit que le cockpit l'a vue après coup : jamais le même texte.
        assert.notEqual(phrase, raisonNonControle(), "la phrase de la règle ne répète pas la raison du Journal");
      }
    }
    assert.equal(
      regleCarte(NON_CONTROLE_RULE, { mode: "simple", controleIa: true }),
      "Règle : Commande qu'opencode a lancée sans demande d'autorisation (affectation, déclaration ou redirection seule)",
    );
  });

  it("un appel `bash` qui a posé sa demande n'est jamais « passé sans contrôle », même sur une forme F-l", async (t) => {
    const bench = await startBench(t);
    const { h } = bench;
    const conv = await conversation(h);
    h.fake.script(conv.id, {
      tools: [{ tool: "bash", input: { command: "x=1" }, ask: { permission: "bash", patterns: ["x=1"] } }],
      followUp: { text: "Fait." },
    });
    assert.equal((await prompt(h, conv.id)).status, 204);
    const demande = await until(() => h.fake.pendingPermissions().at(0), 5_000);
    const repondu = await h.call("POST", `/api/oc/permission/${demande.id}/reply`, { headers: h.headers.mutating, body: { reply: "once" } });
    assert.equal(repondu.status, 200, repondu.body);

    await barriere(h);
    assert.deepEqual(decisions(h, conv.id), []);
    assert.deepEqual(statuts(h, conv.id), []);
    assert.deepEqual(aborts(h), []);
  });
});

// --- 3. Redémarrages d'opencode (§4.11, mesure MX1 §2 / M14) ----------------------------------------------------------------------

describe("L10c : redémarrages d'opencode", () => {
  it("séquence M14 rejouée sur le faux : demande `interrompue`, fait `statut` et retour à « Demander à chaque fois »", async (t) => {
    const bench = await startBench(t);
    const { h } = bench;
    const conv = await demandeOuverte(bench);
    // M14 : pour chaque session occupée, session.error MessageAbortedError puis repos, parties d'outil en erreur, message clos ;
    // server.instance.disposed par dossier, global.disposed en dernier ; aucune demande d'autorisation n'est répondue.
    h.fake.emitGlobalDisposed({ resetInstances: true });

    const close = await until(() => requests(h, conv.id).find((row) => row.fin !== null));
    assert.equal(close.fin, "interrompue");
    const statut = await until(() => statuts(h, conv.id).find((fact) => fact.data.cause === "interrompue"));
    assert.equal(statut.data.cause, "interrompue");
    const view = await vue(h, conv.id);
    assert.equal(view.choix, "demander");
    assert.equal(view.retourCause, "interrompue");
    assert.equal(phraseRetour("interrompue"), "Retour à « Demander à chaque fois » : opencode a redémarré et la demande a été interrompue.");
    // Aucune demande d'autorisation répondue par ce paquet, aucun rechargement demandé (P4, P6).
    assert.deepEqual(h.fake.requests.filter((r) => r.pathname.includes("/permission/")), []);
    h.assertNoGlobalRestart();
  });

  it("`server.instance.disposed` : seules les demandes du dossier libéré sont interrompues", async (t) => {
    const bench = await startBench(t);
    const { h } = bench;
    const conv = await demandeOuverte(bench);
    h.fake.emitInstanceDisposed("/autre/dossier");
    await barriere(h);
    assert.equal(requests(h, conv.id).at(-1)?.fin, null, "un autre dossier ne touche pas cette demande");

    h.fake.emitInstanceDisposed(h.sessions.get(conv.id)?.directory ?? "");
    const close = await until(() => requests(h, conv.id).find((row) => row.fin !== null));
    assert.equal(close.fin, "interrompue");
  });

  it("`session.error` MessageAbortedError de la racine : demande `interrompue` ; un travail délégué arrêté seul ne compte pas", async (t) => {
    const bench = await startBench(t);
    const { h } = bench;
    const conv = await demandeOuverte(bench);
    const enfant = await h.deps.client.request<{ id: string }>("POST", "/session", { body: { parentID: conv.id, title: "Délégué" } });
    await until(() => h.sessions.get(enfant.id));

    // Une autre erreur de la racine (tour en échec) n'est pas un redémarrage d'opencode…
    h.fake.emit({ type: "session.error", properties: { sessionID: conv.id, error: { name: "UnknownError", data: { message: "Boum" } } } });
    // … et un travail délégué arrêté seul (« Task cancelled ») non plus.
    h.fake.emit({ type: "session.error", properties: { sessionID: enfant.id, error: { name: "MessageAbortedError", data: { message: "Aborted" } } } });
    await barriere(h);
    assert.equal(requests(h, conv.id).at(-1)?.fin, null, "seul MessageAbortedError de la racine vaut un redémarrage d'opencode");

    h.fake.emit({ type: "session.error", properties: { sessionID: conv.id, error: { name: "MessageAbortedError", data: { message: "Aborted" } } } });
    const close = await until(() => requests(h, conv.id).find((row) => row.fin !== null));
    assert.equal(close.fin, "interrompue");
  });

  it("repli par sondage : les demandes d'autorisation disparues sans réponse valent un redémarrage du processus", async (t) => {
    const bench = await startBench(t);
    const { h } = bench;
    const conv = await conversation(h);
    await choisir(h, conv.id, "autonome");
    h.fake.script(conv.id, {
      tools: [{ tool: "bash", input: { command: "git push" }, ask: { permission: "bash", patterns: ["git push"] } }],
      followUp: { text: "Fait." },
    });
    assert.equal((await prompt(h, conv.id)).status, 204);
    await until(() => h.fake.pendingPermissions().at(0), 5_000);
    await until(() => requests(h, conv.id).at(-1));
    await barriere(h);

    // Garde du sondage : la demande d'autorisation tient toujours, rien n'est affirmé.
    await bench.poll();
    assert.equal(requests(h, conv.id).at(-1)?.fin, null);

    // Flux coupé (redémarrage du processus, non mesuré) : les demandes disparaissent sans permission.replied.
    h.fake.emitGlobalDisposed({ resetInstances: false });
    h.fake.disconnectStreams();
    await bench.poll();

    const close = await until(() => requests(h, conv.id).find((row) => row.fin !== null));
    assert.equal(close.fin, "interrompue");
    assert.equal(ligneRetour(h, conv.id).retour_cause, "interrompue");
  });

  it("reprise au démarrage du cockpit : la surveillance reprend les demandes encore ouvertes et applique un plafond déjà dépassé", async (t) => {
    const bench = await startBench(t);
    const { h } = bench;
    const conv = await demandeOuverte(bench, { plafondUsd: 0.05 });
    // Dépense enregistrée sans aucun événement (cockpit arrêté entre-temps) : seule la reprise peut la voir.
    depense(h, conv.id, 0.2);
    await barriere(h);
    assert.equal(requests(h, conv.id).at(-1)?.fin, null);

    await h.cockpit.startup();

    const close = await until(() => requests(h, conv.id).find((row) => row.fin !== null));
    assert.equal(close.fin, "plafond-cout");
    assert.ok(bench.logs.some((line) => line.message === "autonomie : reprise de la surveillance des demandes en cours"));
  });

  it("sondage : la durée maximale est vue même quand la demande n'envoie plus rien", async (t) => {
    const bench = await startBench(t);
    const { h } = bench;
    const conv = await demandeOuverte(bench, { dureeMinutes: 30 });
    // La minuterie est armée dès qu'une demande est ouverte ; aucun événement n'arrive plus, seule l'horloge avance.
    bench.avance(31 * 60_000);
    await bench.poll();

    const close = await until(() => requests(h, conv.id).find((row) => row.fin !== null));
    assert.equal(close.fin, "plafond-duree");
    assert.equal(ligneRetour(h, conv.id).retour_cause, "plafond-duree");
  });
});

// --- 4. Garde de rechargement pendant un examen (§3.11, décision du 15/09) ---------------------------------------------------------

describe("L10c : garde de rechargement pendant un examen", () => {
  it("mode Avancé : 409 `sessions-busy` avec la dérogation annoncée, levée par `x-cockpit-confirm`", async (t) => {
    const bench = await startGuardBench(t, { ui: { mode: "avance" } });
    const { h } = bench;
    bench.examen.value = true;
    assert.equal(h.cockpit.c11.reloadBusy(), true);

    const refuse = await h.call("POST", "/api/system/restart-opencode", { headers: h.headers.mutating });
    assert.equal(refuse.status, 409, refuse.body);
    assert.deepEqual(refuse.json<{ error: string; override: boolean }>().error, "sessions-busy");
    assert.equal(refuse.json<{ override: boolean }>().override, true);

    // Dérogation explicite du mode Avancé (§3.11) : elle passe, et c'est l'utilisateur qui la demande, jamais le cockpit.
    const permis = await h.call("POST", "/api/system/restart-opencode", { headers: h.headers.confirmed });
    assert.equal(permis.status, 200, permis.body);
  });

  it("mode Simple : la confirmation du remède ne couvre pas un examen (409 `sessions-busy`), même sonde illisible", async (t) => {
    const bench = await startGuardBench(t);
    const { h } = bench;
    bench.examen.value = true;

    const refuse = await h.call("POST", "/api/system/restart-opencode", { headers: h.headers.confirmed });
    assert.equal(refuse.status, 409, refuse.body);
    assert.equal(refuse.json<{ error: string }>().error, "sessions-busy");
    assert.equal(refuse.json<{ override: boolean }>().override, false);

    // Sonde illisible : l'examen l'emporte AVANT la sonde (reloadOccupancy), donc « sessions-busy » et jamais
    // « reponses-non-verifiables », dont la confirmation serait acceptée en Simple pour ce seul remède (décision du 15/09).
    const illisible = () => Promise.reject(new Error("conversations illisibles"));
    const occupancy = reloadOccupancy({ queue: { billedInFlight: 0 }, reloadBusy: () => true, probe: illisible });
    assert.equal(await occupancy(), "busy");
    const deps = {
      settings: h.settings,
      control: { restarting: false },
      occupancy,
      reachable: async () => true,
      log: { warn: () => undefined },
    };
    assert.deepEqual(await reloadRefusal(deps, { confirmUnverifiable: true }, { confirmed: true, path: "/api/system/restart-opencode" }), {
      error: "sessions-busy",
      message: (await reloadRefusal(deps, {}, { confirmed: false, path: "/x" }))?.message ?? "",
      override: false,
    });
    // Hors examen, le même remède confirmé passe : c'est bien l'examen qui refuse.
    const libre = reloadOccupancy({ queue: { billedInFlight: 0 }, reloadBusy: () => false, probe: illisible });
    assert.equal(await reloadRefusal({ ...deps, occupancy: libre }, { confirmUnverifiable: true }, { confirmed: true, path: "/api/system/restart-opencode" }), null);
  });

  it("réalignement d'assistants pendant un examen : 409 `sessions-busy`", async (t) => {
    const bench = await startGuardBench(t);
    const { h } = bench;
    bench.examen.value = true;
    const refuse = await h.call("POST", "/api/ai/realign", { headers: h.headers.confirmed, body: {} });
    assert.equal(refuse.status, 409, refuse.body);
    assert.equal(refuse.json<{ error: string }>().error, "sessions-busy");

    bench.examen.value = false;
    const libre = await h.call("POST", "/api/ai/realign", { headers: h.headers.confirmed, body: {} });
    assert.notEqual(libre.status, 409, libre.body);
  });
});

// --- 5. P5 et P6 ------------------------------------------------------------------------------------------------------------------

describe("L10c : P5 et P6", () => {
  it("seuils budgétaires mensuels (80 / 100 %) : jamais confirmés automatiquement, aucun appel facturé", async (t) => {
    const bench = await startBench(t);
    const { h } = bench;
    const conv = await demandeOuverte(bench);
    const avant = h.fake.requests.length;
    const reglages = JSON.stringify(h.settings.get());

    usageUpdated(h, conv.id, 80);
    usageUpdated(h, conv.id, 100);
    usageUpdated(h, null, 100);
    await bench.poll();

    // Le pourcentage mensuel n'a aucun effet : ni fin de demande, ni réglage changé, ni confirmation, ni envoi à opencode.
    assert.equal(requests(h, conv.id).at(-1)?.fin, null);
    assert.equal(JSON.stringify(h.settings.get()), reglages);
    assert.deepEqual(h.fake.requests.slice(avant), []);
    h.assertNoGlobalRestart();
  });

  it("P6 : aucun `PATCH /global/config`, aucun `dispose`, aucun redémarrage de l'instance principale", async (t) => {
    const bench = await startBench(t);
    const { h } = bench;
    const conv = await demandeOuverte(bench, { plafondUsd: 0.05, dureeMinutes: 1 });
    depense(h, conv.id, 0.2);
    usageUpdated(h, conv.id);
    await until(() => requests(h, conv.id).find((row) => row.fin !== null));
    bench.avance(2 * 60_000);
    await bench.poll();

    h.assertNoGlobalRestart();
    const interdites = h.fake.requests.filter((r) => /global\/(config|dispose)|instance\/dispose/.test(r.pathname));
    assert.deepEqual(interdites, []);
  });
});
