// Tests de croisement du train it1 V4 (plan d'exécution §2.3, §5.2 ; propriété de l'intégrateur) : L1f (interface du portillon et
// Diagnostic), L5d (démonstration p1), L6c (carte de plan) et L7b-1 (e2e API, joués par run-e2e.sh), sur le câblage complet
// (modules « tous »). Ce que la vague doit prouver ensemble, et qu'aucun paquet ne peut prouver seul :
//   1. « différé = direct » sur p1 (L4c, L5a, L5d) : la capture p1 rejouée sur le cockpit complet (mode Avancé, celui de la
//      démonstration) donne exactement les faits de demo-p1.json ; le navigateur ouvert avant (direct, flux du hub), rouvert après
//      (GET …/facts) ou ouvert en cours de route (relecture et direct qui se recouvrent) a les mêmes faits, les mêmes lignes de
//      « Qui travaille ? » et la même bande ; après chaque fait reçu en direct, la bande dessine ce que le lecteur montre après le
//      même nombre de faits ;
//   2. « Arrêter » visible pendant une délégation : la saisie (ChatPage, stopVisible) suit l'arbre du magasin d'activité (L5b), qui
//      travaille tant qu'un travail délégué travaille ; l'arrêt de l'arbre (L1c) le rend au repos ;
//   3. carte de plan (L6c) : après une réponse, boutons automatiques désactivés avec la raison que le serveur (L6b, porte I1)
//      opposerait, « demander » et « continuer » actifs ; COCKPIT_AUTONOMY=off : la raison du 403 ;
//   4. Diagnostic (L1f) : état des agents internes (L1g, L11b) dit en mots, en attente pendant une réponse puis installé, bandeaux
//      du module diagnostics sur le faux aligné sur 1.18.30 (aucun bandeau « illisible » parasite), carte toujours présente.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { type ActivityClock, type ActivitySource, ActivityStore } from "../web/lib/useActivity.ts";
import { formatTime } from "../web/lib/format.ts";
import { buildPlanCard, clickEffect, type PlanCardModel, planAnswered } from "../web/pages/chat/plan/plan-card.ts";
import { CLASSIFIER_AGENT } from "./classifier.ts";
import type { ActivityFact, FactsResponse } from "./shared/activity-types.ts";
import { activityStatus, type ActivityState, emptyActivity, liveRows, replayFacts, replayMessages, timeline, totals } from "./shared/activity.ts";
import type { ActivationRefusalCode, BootstrapAutonomy, ConversationAutonomyView, PlanCreateResponse } from "./shared/autonomy-types.ts";
import { raisonRefus } from "./shared/autonomy-texts.ts";
import type { DiagnosticActiviteResponse } from "./shared/cockpit-event-types.ts";
import { CONTROL_AGENT_NAME } from "./shared/control-ai-output.ts";
import { bandeauDiagnostic, etatAgentInterne, nomAgentInterne, TEXTES as DELEGATION } from "./shared/delegation-texts.ts";
import { type NeonSceneOptions, scene } from "./shared/neon-scene.ts";
import type { StudioService } from "./studio.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import { type FakePermissionRequest, type FakeSession, type FakeToolScript, readCapture } from "./test-support/fake-opencode.ts";
import { DEMO_P1_CAPTURE, DEMO_P1_FILE, DEMO_P1_ROOT, DEMO_P1_SENT, DEMO_SCENE, type DemoFile, dessin } from "./test-support/gen-demo.ts";
import { bash, until, within } from "./test-support/helpers.ts";

const MODEL = { providerID: "github-copilot", modelID: "gpt-5-mini" };
const DEROULE_FILE = path.join(import.meta.dirname, "..", "web", "pages", "chat", "activity", "Deroule.tsx");

/** Conversation créée par le proxy (plancher posé par L3), suivie par le cockpit. */
async function trackedRoot(h: CockpitHarness, title: string): Promise<FakeSession> {
  const created = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title } });
  assert.equal(created.status, 200, created.body);
  const session = created.json<FakeSession>();
  await until(() => h.sessions.get(session.id));
  return session;
}

/** Envoi par le proxy (ligne chat_turns = début de la demande, crochets d'envoi), puis relais. */
async function sendThroughProxy(h: CockpitHarness, sessionId: string, text: string): Promise<void> {
  const sent = await h.call("POST", `/api/oc/session/${sessionId}/prompt_async`, {
    headers: h.headers.mutating,
    body: { agent: "build", model: MODEL, parts: [{ type: "text", text }] },
  });
  assert.equal(sent.status, 204, sent.body);
}

async function getJson<T>(h: CockpitHarness, pathname: string): Promise<T> {
  const res = await h.call("GET", pathname, { headers: h.headers.authed });
  assert.equal(res.status, 200, `${pathname} : ${res.body}`);
  return res.json<T>();
}

// --- Navigateur : magasin d'activité (web/lib/useActivity.ts) branché sur le vrai cockpit ------------------------------------------

/** Horloge qui avance à chaque lecture : chaque changement est rendu tout de suite (aucune minuterie n'est jouée). */
function eagerClock(): ActivityClock {
  let t = 1_800_000_000_000;
  return { now: () => (t += 1_000), setTimer: () => null, clearTimer: () => undefined };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Ce qu'opencode servirait d'une capture rejouée, que le faux ne garde pas : informations de session (dernier session.created ou
 * session.updated) et messages (dernier message.updated, sans leurs parties) de ce que le faux a diffusé jusqu'à la lecture. Une
 * session pas encore diffusée n'est pas connue (null : rien à relire).
 */
function replayed(h: CockpitHarness): { sessions: Array<Record<string, unknown>>; messages: Array<Record<string, unknown>> } {
  const sessions = new Map<string, Record<string, unknown>>();
  const messages = new Map<string, Record<string, unknown>>();
  for (const { payload } of h.fake.emitted) {
    if (!("properties" in payload)) continue;
    const info: unknown = isRecord(payload.properties) ? payload.properties.info : undefined;
    if (!isRecord(info) || typeof info.id !== "string") continue;
    if (payload.type === "session.created" || payload.type === "session.updated") sessions.set(info.id, info);
    else if (payload.type === "message.updated") messages.set(info.id, info);
  }
  return { sessions: [...sessions.values()], messages: [...messages.values()] };
}

/**
 * Lectures du navigateur par les routes du cockpit : GET …/facts, puis le proxy opencode (conversation, enfants, messages).
 * `replay` : capture rejouée sur le flux ; opencode est lu dans ce que le faux a diffusé (replayed).
 */
function cockpitSource(h: CockpitHarness, replay = false): ActivitySource {
  const facts = async (rootId: string) => getJson<FactsResponse>(h, `/api/conversations/${rootId}/facts?since=0`);
  if (replay) {
    return {
      facts,
      session: async (sessionId) => replayed(h).sessions.find((info) => info.id === sessionId) ?? null,
      children: async (sessionId) => replayed(h).sessions.filter((info) => info.parentID === sessionId),
      messages: async (sessionId) => replayed(h).messages.filter((info) => info.sessionID === sessionId).map((info) => ({ info, parts: [] })),
    };
  }
  return {
    facts,
    session: async (sessionId, directory) => getJson<unknown>(h, `/api/oc/session/${sessionId}?directory=${encodeURIComponent(directory)}`),
    children: async (sessionId, directory) => getJson<unknown[]>(h, `/api/oc/session/${sessionId}/children?directory=${encodeURIComponent(directory)}`),
    messages: async (sessionId, directory) => getJson<unknown[]>(h, `/api/oc/session/${sessionId}/message?directory=${encodeURIComponent(directory)}`),
  };
}

/** Onglet ouvert sur la conversation : flux SSE du hub (événements opencode relayés et faits du cockpit), relecture à l'ouverture. */
async function openTab(t: { after(fn: () => void): void }, h: CockpitHarness, rootId: string, directory: string, replay = false): Promise<ActivityStore> {
  const store = new ActivityStore(rootId, directory, cockpitSource(h, replay), eagerClock());
  const unsubscribe = h.hub.subscribe((event) => store.push(event));
  t.after(() => {
    unsubscribe();
    store.stop();
  });
  store.start();
  await until(() => store.getSnapshot().loaded);
  return store;
}

/**
 * Lignes de « Qui travaille ? » et du Déroulé sans les durées (seules à dépendre de l'heure de lecture) : titres (mode Avancé) et
 * assistants compris, celui de la conversation elle-même aussi (« Conversation · orchestrateur ») : un onglet rouvert relit ses
 * informations (GET /session/:id : titre et assistant de la dernière demande, comme session.updated en direct). Une reconnexion garde
 * ce que l'onglet a appris en direct : elle n'est pas en cause.
 */
const rowsOf = (state: ActivityState) => liveRows(state, Number.MAX_SAFE_INTEGER).map(({ durationMs: _durationMs, ...row }) => row);

/** Forme d'un fait sans son numéro ni son heure (le démonstrateur garde les heures de la capture). */
const shape = ({ rootId, sessionId, kind, ref, data }: ActivityFact) => ({ rootId, sessionId, kind, ref, data });

const SCENES: readonly NeonSceneOptions[] = [
  { zoom: 2, mode: "simple" },
  { zoom: 2, mode: "avance" },
  { zoom: 3, mode: "simple" },
  { zoom: 3, mode: "avance" },
];

describe("croisements it1 V4 : « différé = direct » sur p1 (L4c, L5a, L5d)", () => {
  it("p1 sur le cockpit complet : faits = demo-p1.json ; onglets ouverts avant, après et en cours de route identiques (faits, lignes, bande) ; chaque fait reçu en direct dessine ce que montre le lecteur", async (t) => {
    // Mode Avancé, celui de la démonstration (en Simple, la délégation qui demande votre accord serait refusée d'office par L1d).
    const h = await startCockpit(t, { modules: "tous", settings: { ui: { mode: "avance" } } });
    const demo = JSON.parse(fs.readFileSync(DEMO_P1_FILE, "utf8")) as DemoFile;
    assert.equal(demo.rootId, DEMO_P1_ROOT);
    assert.equal(demo.source, DEMO_P1_CAPTURE);
    // Votre demande (seul message envoyé par le cockpit dans p1) : ligne écrite par le proxy avant le relais (enforceTurn), comme
    // DEMO_P1_SENT pour le générateur ; heure de la capture (message msg_09e702c4e001…, créé à 1789364546638).
    assert.deepEqual(DEMO_P1_SENT, ["msg_09e702c4e001phPA6LcfC9t4WK"]);
    h.ledger.recordChatTurn({ session_id: DEMO_P1_ROOT, created_at: 1_789_364_546_598, kind: "message", agent: "orchestrateur", command: null, tier: null, model: null, variant: null, runs: [] });

    const before = await openTab(t, h, DEMO_P1_ROOT, h.fake.directory, true);
    const rows = readCapture(DEMO_P1_CAPTURE);
    const half = Math.floor(rows.length / 2);
    for (const { wire } of rows.slice(0, half)) h.fake.emitRaw(wire);
    await until(() => before.getSnapshot().state.facts.length > 0, 5_000);
    // Onglet ouvert pendant le travail : sa relecture (GET …/facts) et le direct se recouvrent.
    const during = new ActivityStore(DEMO_P1_ROOT, h.fake.directory, cockpitSource(h, true), eagerClock());
    const unsubscribe = h.hub.subscribe((event) => during.push(event));
    t.after(() => {
      unsubscribe();
      during.stop();
    });
    during.start();
    for (const { wire } of rows.slice(half)) h.fake.emitRaw(wire);

    const published = () => h.cockpitEvents().filter((e) => e.type === "activite.fait").map((e) => e.data as ActivityFact);
    await until(() => published().some((f) => f.sessionId === DEMO_P1_ROOT && f.kind === "statut" && f.data.etat === "repos"), 10_000);
    const stored = (await getJson<FactsResponse>(h, `/api/conversations/${DEMO_P1_ROOT}/facts?since=0`)).facts;
    assert.deepEqual(published().map((f) => f.id), stored.map((f) => f.id), "faits publiés = faits relus, dans l'ordre du magasin");

    // L5d : le câblage complet enregistre exactement les faits de la démonstration (seules les heures diffèrent).
    assert.deepEqual(stored.map(shape), demo.faits.map(shape));

    const after = await openTab(t, h, DEMO_P1_ROOT, h.fake.directory, true);
    await until(() => during.getSnapshot().loaded && during.getSnapshot().state.facts.length === stored.length, 5_000);
    await until(() => before.getSnapshot().state.facts.length === stored.length, 5_000);
    assert.deepEqual([before, after, during].map((store) => store.getSnapshot().failed), [false, false, false], "relectures réussies");
    const [direct, reopened, midway] = [before, after, during].map((store) => store.getSnapshot().state);
    assert.ok(direct && reopened && midway);
    // L4c : mêmes faits (ordre du magasin), mêmes lignes, même Déroulé, mêmes totaux, même état.
    for (const [label, state] of [["rouvert", reopened], ["ouvert en cours", midway]] as const) {
      assert.deepEqual(state.facts, direct.facts, label);
      assert.deepEqual(rowsOf(state), rowsOf(direct), label);
      assert.deepEqual(timeline(state), timeline(direct), label);
      assert.deepEqual(totals(state), totals(direct), label);
      assert.deepEqual(activityStatus(state), activityStatus(direct), label);
      // L5a : la bande (NeonBand lit activity.state.facts) est la même, dans tous les modes et zooms, à chaque moment.
      for (const options of SCENES) assert.deepEqual(scene(state.facts, null, options), scene(direct.facts, null, options), `${label} ${JSON.stringify(options)}`);
    }
    const root = rowsOf(reopened).find((row) => row.depth === 0);
    assert.deepEqual([root?.title, root?.agent], ["ocgraph - delegation", "orchestrateur"], "conversation rouverte : son titre et son assistant");
    // Déroulé rouvert (Deroule.tsx, ConversationStore.reload, branche avec faits) : faits relus, puis informations de la conversation
    // et de ses enfants, par le même réducteur ; mêmes lignes (titres, « Conversation · orchestrateur ») que le direct.
    const source = cockpitSource(h, true);
    const infos = [await source.session(DEMO_P1_ROOT, h.fake.directory), ...(await source.children(DEMO_P1_ROOT, h.fake.directory))];
    const deroule = replayMessages(replayFacts(emptyActivity(DEMO_P1_ROOT), stored), { sessions: infos, messages: [] });
    assert.deepEqual(rowsOf(deroule), rowsOf(direct), "Déroulé rouvert");
    const reload = /async reload\(\): Promise<void> \{([\s\S]*?)\n {2}\}\n/.exec(fs.readFileSync(DEROULE_FILE, "utf8"))?.[1] ?? "";
    const withFacts = reload.slice(reload.indexOf("if (persisted.facts.length > 0) {"), reload.indexOf("} else {"));
    assert.ok(withFacts.includes("const sessions = await this.#sessions();"), withFacts);
    assert.ok(withFacts.includes("replayMessages(replayFacts(base, persisted.facts), { sessions, messages: [] })"), withFacts);
    assert.equal(before.getSnapshot().working, false, "conversation au repos : « Arrêter » n'est plus affiché");

    // L5d : après k faits reçus en direct, la bande dessine ce que le lecteur montre après ses k premiers faits (même scène que le
    // direct, heures de la capture) ; les étapes du lecteur sont les moments où ce dessin change.
    const retimed = direct.facts.map((fact, i) => ({ ...fact, at: demo.faits[i]?.at ?? -1 }));
    assert.deepEqual(retimed, demo.faits.map(({ id: _id, ...fact }) => fact));
    for (let k = 1; k <= retimed.length; k++) {
      for (const options of [DEMO_SCENE, { zoom: 2, mode: "simple" } satisfies NeonSceneOptions]) {
        assert.equal(dessin(scene(retimed.slice(0, k), null, options)), dessin(scene(demo.faits.slice(0, k), null, options)), `${k} faits ${options.mode}`);
      }
    }
    const last = demo.etapes.at(-1);
    assert.ok(last !== undefined);
    assert.equal(dessin(scene(demo.faits, last, DEMO_SCENE)), dessin(scene(retimed, null, DEMO_SCENE)), "dernière étape du lecteur = bande du direct à la fin");
    assert.deepEqual(h.fake.failures, []);
    h.assertNoGlobalRestart();
  });
});

describe("croisements it1 V4 : « Arrêter » visible pendant une délégation (L1f, T2, L5b, L1c)", () => {
  /** Délégation d'un assistant du Studio avec `task: allow` : aucune demande, le sous-agent travaille `workMs`. */
  const allowTask = (description: string, workMs: number): FakeToolScript => ({
    tool: "task",
    input: { description, prompt: `Consigne : ${description}`, subagent_type: "general" },
    agentRules: [{ permission: "task", pattern: "*", action: "allow" }],
    child: { agent: "general", workMs },
  });
  /** ChatPage : stopVisible={Boolean(sessionId) && treeWorking}, treeWorking reçu d'ActivityRegion (onTreeWorking(working)). */
  const stopVisible = (sessionId: string | null, working: boolean) => Boolean(sessionId) && working;

  it("mode Simple : délégation lancée sans demande (Studio) → l'arbre travaille, « Arrêter » visible ; arrêt (proxy → stopTree) → racine et enfant arrêtés, « Arrêter » masqué ; P6", async (t) => {
    const h = await startCockpit(t, { modules: "tous" });
    assert.equal(h.settings.get().ui.mode, "simple");
    const root = await trackedRoot(h, "Arrêter visible");
    const tab = await openTab(t, h, root.id, root.directory);
    assert.equal(stopVisible(root.id, tab.getSnapshot().working), false, "conversation au repos");

    h.fake.script(root.id, { tools: [allowTask("Analyser les journaux", 60_000)] });
    await sendThroughProxy(h, root.id, "Délègue l'analyse.");
    const child = ((await h.fake.waitForEvent("session.created", (p) => (p.info as FakeSession).parentID === root.id)).properties.info as FakeSession).id;
    const working = await until(() => {
      const view = tab.getSnapshot();
      const childRow = view.rows.find((row) => row.sessionId === child && !row.sansSession);
      return view.working && childRow?.state === "travaille" ? view : null;
    }, 5_000);
    assert.equal(working.rows.find((row) => row.sessionId === root.id)?.state, "attend-delegation");
    assert.equal(stopVisible(root.id, working.working), true, "« Arrêter » visible pendant le travail délégué");
    assert.equal(stopVisible(null, working.working), false, "jamais sans conversation");

    const stop = await h.call("POST", `/api/oc/session/${root.id}/abort`, { headers: h.headers.mutating });
    assert.equal(stop.status, 200, stop.body);
    const stopped = await until(() => {
      const view = tab.getSnapshot();
      const states = [root.id, child].map((id) => view.rows.find((row) => row.sessionId === id && !row.sansSession)?.state);
      return !view.working && states.every((state) => state === "arrete") ? view : null;
    }, 5_000);
    assert.equal(stopVisible(root.id, stopped.working), false, "« Arrêter » masqué une fois l'arbre arrêté");
    assert.deepEqual(await h.deps.client.request("GET", "/session/status"), {}, "aucune session occupée");
    h.assertNoGlobalRestart();
  });

  it("câblage lu dans les sources : ActivityRegion annonce working, ChatPage le passe à la saisie, la saisie montre « Arrêter » pour la racine ou l'arbre", () => {
    const read = (relative: string) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");
    assert.match(read("../web/pages/chat/activity/ActivityRegion.tsx"), /useEffect\(\(\) => onTreeWorking\(working\), \[working, onTreeWorking\]\);/);
    const chat = read("../web/pages/ChatPage.tsx");
    assert.match(chat, /onTreeWorking=\{onTreeWorking\}/);
    assert.match(chat, /stopVisible=\{Boolean\(sessionId\) && treeWorking\}/);
    assert.match(read("../web/pages/chat/Composer.tsx"), /\{busy \|\| stopVisible \? \(/);
  });
});

describe("croisements it1 V4 : carte de plan (L6c) sur le câblage complet (L6b, porte I1)", () => {
  /** Carte telle que PlanCard la construit : amorçage, vue du serveur, messages relus par le proxy. */
  async function card(h: CockpitHarness, planId: string, boot: BootstrapAutonomy, busy = false): Promise<PlanCardModel> {
    const view = await getJson<ConversationAutonomyView>(h, `/api/conversations/${planId}/autonomie`);
    const messages = await getJson<unknown[]>(h, `/api/oc/session/${planId}/message?directory=${encodeURIComponent(h.fake.directory)}`);
    return buildPlanCard({ rootId: planId, view, answer: { rootId: planId, answered: planAnswered(messages) }, busy, boot });
  }

  for (const [label, autonomy, expected] of [
    ["porte I1 fermée", true, "a-venir"],
    ["COCKPIT_AUTONOMY=off", false, "autonomie-coupee"],
  ] as const) {
    it(`${label} : après la réponse, « modifications » et « autonome » désactivés avec la raison « ${expected} », celle que le serveur oppose ; « demander » et « continuer » actifs`, async (t) => {
      const h = await startCockpit(t, { modules: "tous", env: { autonomy } });
      const boot = (await getJson<{ autonomy: BootstrapAutonomy }>(h, "/api/bootstrap")).autonomy;
      assert.deepEqual(boot, { interrupteur: autonomy, activationOuverte: false });
      const created = await h.call("POST", "/api/plans", { headers: h.headers.mutating, body: { directory: h.fake.directory } });
      assert.equal(created.status, 200, created.body);
      const planId = created.json<PlanCreateResponse>().rootId;
      assert.equal((await card(h, planId, boot)).affichage, "note", "aucune réponse : la phrase d'honnêteté seule");

      h.fake.script(planId, { text: "1. Lire a.txt." });
      await sendThroughProxy(h, planId, "Prépare un plan.");
      await within(h.fake.settled(planId), "réponse du plan terminée");
      assert.equal((await card(h, planId, boot, true)).affichage, "note", "la racine travaille : la carte attend");
      const model = await card(h, planId, boot);
      assert.equal(model.affichage, "carte");
      const byAction = new Map(model.boutons.map((b) => [b.action, b]));
      for (const action of ["demander", "continuer"] as const) {
        const button = byAction.get(action);
        assert.deepEqual([button?.desactive, button?.raison], [false, null], action);
        assert.equal(clickEffect(button as NonNullable<typeof button>, false), action === "continuer" ? "continuer" : "executer");
      }
      const phrase = raisonRefus(expected as ActivationRefusalCode);
      for (const action of ["modifications", "autonome"] as const) {
        const button = byAction.get(action);
        assert.ok(button);
        assert.deepEqual([button.desactive, button.raisonCode, button.raison], [true, expected, phrase], action);
        assert.equal(clickEffect(button, false), "rien", "un bouton désactivé ne fait rien");
        // Le serveur (L6b, porte I1) oppose la même raison à un appel confirmé : la carte ne promet rien qu'il refuserait autrement.
        const res = await h.call("POST", `/api/plans/${planId}/execution`, { headers: h.headers.confirmed, body: { choix: action } });
        assert.equal(res.status, autonomy ? 409 : 403, res.body);
        const body = res.json<{ error: string; raison?: string }>();
        assert.equal(autonomy ? body.raison : body.error, expected, action);
      }
      assert.deepEqual(model.raisons, [{ code: expected, texte: phrase }], "une ligne de raison pour les deux boutons");

      // « demander » : exécution permise, nouvelle conversation sans carte de plan.
      const ask = await h.call("POST", `/api/plans/${planId}/execution`, { headers: h.headers.mutating, body: { choix: "demander" } });
      assert.equal(ask.status, 200, ask.body);
      const execution = ask.json<{ rootId: string }>().rootId;
      assert.equal((await card(h, execution, boot)).affichage, "aucune");
      h.assertNoGlobalRestart();
    });
  }
});

describe("croisements it1 V4 : Diagnostic du travail délégué (L1f) et agents internes (L1g, L11b)", () => {
  it("état des agents internes dit en mots dans les deux modes : en attente d'un moment sans réponse en cours (heure du prochain essai), puis installé ; bandeaux du module diagnostics ; carte présente ; P6", async (t) => {
    const installs: string[] = [];
    const upToDate = new Set<string>();
    const h = await startCockpit(t, {
      modules: "tous",
      deps: (base) => ({
        studio: {
          ...(base.studio as object),
          internalAgentUpToDate: async (name: string) => upToDate.has(name),
          ensureInternalAgent: async (name: string) => {
            installs.push(name);
            upToDate.add(name);
            return true;
          },
        } as unknown as StudioService,
      }),
    });
    const diagnostic = () => getJson<DiagnosticActiviteResponse>(h, "/api/diagnostic/activite");
    /** Ce que DelegationDiagnostics affiche : bandeaux connus, puis une ligne par agent interne (nom, état en mots). */
    const shown = (data: DiagnosticActiviteResponse, advanced: boolean) => ({
      present: data.delegation.length > 0 || data.agentsInternes.length > 0,
      bandeaux: data.delegation.map((b) => bandeauDiagnostic(b, advanced)),
      agents: data.agentsInternes.map((a) => [nomAgentInterne(a.nom, advanced), etatAgentInterne(a, formatTime)]),
    });
    const agents = [CLASSIFIER_AGENT, CONTROL_AGENT_NAME];
    const labels = (advanced: boolean) => agents.map((nom) => nomAgentInterne(nom, advanced));
    assert.deepEqual(labels(false), [DELEGATION.simple.agentsInternes.noms["cockpit-classifier"], DELEGATION.simple.agentsInternes.noms["cockpit-controle"]]);
    // Avancé : même libellé, suivi du nom réservé (<code>) quand le libellé est connu (InternalAgentsStatus).
    assert.deepEqual(labels(true), labels(false));

    // Faux aligné sur 1.18.30 (capacités servies) : seul le bandeau constaté (un assistant du Studio qui délègue sans demande), aucun
    // « illisible » ; la carte est présente, et le resterait sans bandeau grâce aux agents internes (écart 6 de L1f, pour L12c).
    h.fake.setAgents([{ name: "delegue-tout", mode: "primary", options: {}, permission: [{ permission: "task", pattern: "*", action: "allow" }] }]);
    const first = await diagnostic();
    assert.deepEqual([first.delegation, first.interrupteur, first.activationOuverte], [[{ code: "task-allow", noms: ["delegue-tout"] }], true, false]);
    assert.deepEqual(shown(first, false), {
      present: true,
      bandeaux: [bandeauDiagnostic({ code: "task-allow", noms: ["delegue-tout"] }, false)],
      agents: labels(false).map((nom) => [nom, DELEGATION.partout.agentsInternes.enAttente]),
    });
    assert.ok(shown(first, false).bandeaux.every((text) => text !== null && !/\bagents?\b/i.test(text)), "mode Simple sans « agent »");
    assert.match(String(shown(first, true).bandeaux[0]), /task vaut allow/);
    assert.equal(shown({ ...first, delegation: [] }, false).present, true, "carte présente par les seuls agents internes");

    // Réponse en cours, puis démarrage 1.1 : installation différée, reprise planifiée, heure du prochain essai affichée.
    const root = await trackedRoot(h, "Réponse en cours");
    h.fake.script(root.id, { tools: [bash("ls")], followUp: { text: "fin" } });
    await sendThroughProxy(h, root.id, "Liste.");
    const asked = (await h.fake.waitForEvent("permission.asked", (p) => p.sessionID === root.id)).properties as unknown as FakePermissionRequest;
    await h.cockpit.startup();
    assert.deepEqual(installs, [], "rien d'installé pendant une réponse");
    const waiting = await diagnostic();
    for (const advanced of [false, true]) {
      const view = shown(waiting, advanced);
      assert.deepEqual(view.agents.map(([nom]) => nom), labels(advanced));
      for (const [i, [, etat]] of view.agents.entries()) {
        const next = waiting.agentsInternes[i]?.prochainEssai;
        assert.ok(typeof next === "number", "reprise planifiée");
        assert.match(String(etat), /moment sans réponse en cours/);
        assert.ok(String(etat).includes(formatTime(next)), String(etat));
      }
    }

    // Au repos, redémarrage d'opencode (confirmé) : installés, dans l'ordre.
    const once = await h.call("POST", `/api/oc/permission/${asked.id}/reply`, { headers: h.headers.mutating, body: { reply: "once" } });
    assert.equal(once.status, 200, once.body);
    await within(h.fake.settled(root.id), "réponse terminée");
    await until(() => h.fake.statusOf(root.id).type === "idle");
    const restart = await h.call("POST", "/api/system/restart-opencode", { headers: h.headers.confirmed });
    assert.equal(restart.status, 200, restart.body);
    assert.deepEqual(installs, agents);
    const installed = await diagnostic();
    for (const advanced of [false, true]) {
      assert.deepEqual(
        shown(installed, advanced).agents,
        labels(advanced).map((nom) => [nom, DELEGATION.partout.agentsInternes.installe]),
      );
    }
    assert.equal(h.fake.requests.some((r) => r.method === "POST" && (r.pathname === "/global/dispose" || r.pathname === "/instance/dispose")), false);
  });
});
