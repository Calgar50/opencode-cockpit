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

  it("mise en page lue dans les sources : colonne du fil dans la fenêtre, demandes bornées aux boutons collés, « Contexte » fermé par défaut quand il recouvre la saisie, carte des agents et « Qui travaille ? » jamais repliés par une demande en Avancé", () => {
    // Répétition générale de l'itération 1 : fil à 0 px, « Autoriser une fois » et « Arrêter » hors de la fenêtre sous une zone
    // principale qui ne défile pas, « Arrêter » recouvert par le panneau « Contexte » à 1280 et 400 px. La preuve dans le navigateur
    // (elementFromPoint, quatre tailles) est le scénario e2e it1-ui-mise-en-page. Clôture de l'itération 1 : la correction repliait la
    // carte des agents et « Qui travaille ? » à chaque demande, en Avancé aussi (rg-reel-7 en échec sur opencode réel) ; en Avancé,
    // rien ne se replie plus pour une demande, les bornes ci-dessous suffisent (e2e it1-ui-delegation et it1-ui-mise-en-page).
    const read = (relative: string) => fs.readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = (css: string, selector: string) => {
      const at = css.indexOf(`\n${selector} {`);
      assert.ok(at >= 0, `règle ${selector} absente`);
      return css.slice(at, css.indexOf("}", at));
    };
    const chat = read("../web/pages/chat/chat.css");
    assert.match(rule(chat, ".chat-center"), /overflow-y: auto;/, "dernier recours : la colonne défile, jamais la zone principale");
    assert.match(chat, /\.chat-center > \.chat-header,\s*\.chat-center > \.composer-wrap \{\s*flex: none;/, "en-tête et saisie gardent leur taille");
    assert.match(rule(chat, ".chat-scroll"), /flex: 1 1 0;[\s\S]*min-height: min\(96px, 12vh\);/, "le fil garde une hauteur lisible");
    assert.match(rule(chat, ".chat-center:has(> .interactions) > .chat-scroll"), /min-height: min\(64px, 8vh\);/, "demande en attente : le fil garde ses dernières lignes");
    const interactions = rule(chat, ".interactions");
    for (const decl of ["flex: 0 1 auto;", "min-height: 0;", "max-height: 50vh;", "overflow-y: auto;"]) assert.ok(interactions.includes(decl), `.interactions : ${decl}`);
    assert.match(rule(chat, ".interactions:has(> .interaction)"), /min-height: min\(7rem, 40vh\);/, "une carte garde son titre et ses boutons");
    assert.match(rule(chat, ".interaction-actions"), /position: sticky;\s*bottom: 0;/, "boutons collés au bas de la zone des demandes");
    const activityCss = read("../web/pages/chat/activity/activity.css");
    const activity = rule(activityCss, ".activity-region");
    for (const decl of ["flex: 0 1 auto;", "min-height: 0;", "max-height: 36vh;", "overflow-y: auto;"]) assert.ok(activity.includes(decl), `.activity-region : ${decl}`);
    assert.match(rule(activityCss, ".activity-region.attente"), /flex-shrink: 0;\s*max-height: min\(36vh, 8rem\);/, "mode Simple, demande en attente : les deux lignes de tête restent entières");
    assert.match(
      rule(chat, ".chat-center:has(> .activity-region.demande) > .interactions"),
      /flex-shrink: 4;/,
      "mode Avancé, demande en attente : la carte de la demande cède bien avant la région, jusqu'à son plancher (vérification de la clôture)",
    );
    assert.match(rule(activityCss, ".activity-region.demande"), /min-height: min\(2\.5rem, 6vh\);/, "mode Avancé, demande en attente : la région garde sa première ligne");
    const region = read("../web/pages/chat/activity/ActivityRegion.tsx");
    assert.match(region, /const repliPourLaDemande = replierPendantLaDemande\(advanced, activity\.rows\);/, "repli d'office : mode Simple seulement");
    assert.match(
      region,
      /if \(repliPourLaDemande\) classe = "activity-region attente";\s*else if \(demandeEnAttente\(activity\.rows\)\) classe = "activity-region demande";/,
      "Simple : région repliée (.attente) ; Avancé : région dépliée (.demande)",
    );
    assert.match(region, /<div className=\{classe\}>/);
    assert.match(region, /working=\{working\}\s+repliPourLaDemande=\{repliPourLaDemande\}/, "« Qui travaille ? » replié pendant la demande en Simple seulement");
    assert.doesNotMatch(region, /demandeEnAttente=\{|permissionId !== null/, "aucune demande brute passée aux composants");
    const who = read("../web/pages/chat/activity/WhoIsWorking.tsx");
    assert.match(who, /useEffect\(\(\) => setManual\(null\), \[working, repliPourLaDemande\]\);/);
    assert.match(who, /const expanded = manual \?\? \(working && !narrow && !repliPourLaDemande\);/, "Avancé : déplié pendant le travail, demande comprise (§5.1)");
    assert.doesNotMatch(who, /demandeEnAttente|permissionId !== null\)/, "« Qui travaille ? » ne lit aucune demande pour se replier");
    const prompts = read("../web/pages/chat/Interactions.tsx");
    assert.equal(prompts.match(/className="row(?: wrap)? interaction-actions"/g)?.length, 3, "rangées de boutons : refus, choix, question");

    // « Contexte » posé sur la conversation sous 1280 px : même borne dans la page et la feuille, fermé par défaut.
    assert.match(chat, /@media \(max-width: 1280px\) \{\s*\.chat-aside \{\s*display: none;\s*\}\s*\.chat\.aside-open \.chat-aside \{\s*display: flex;\s*position: fixed;/);
    const page = read("../web/pages/ChatPage.tsx");
    assert.match(page, /const ASIDE_OVERLAY_QUERY = "\(max-width: 1280px\)";/);
    assert.match(page, /useState\(\(\) => !asideOverlay\(\) && readFlag\(ASIDE_FLAG, true\)\)/);
    assert.match(page, /const onChange = \(\) => \{\s*if \(media\.matches\) setAsideOpen\(false\);\s*\};/, "fermé à chaque passage sous 1280 px, jamais rouvert d'office");
    assert.equal(page.match(/writeFlag\(ASIDE_FLAG/g)?.length, 2);
    assert.equal(page.match(/if \(!asideOverlay\(\)\) writeFlag\(ASIDE_FLAG, !open\);|if \(!open && !asideOverlay\(\)\) writeFlag\(ASIDE_FLAG, true\);/g)?.length, 2, "préférence inchangée par le panneau posé");
  });

  it("mode Avancé, demande en attente : « Qui travaille ? » entier sous la bande, bande bornée à la place qui reste et carte réduite à sa hauteur (vérification de la clôture de l'itération 1)", () => {
    // Vérification de la clôture : dépliées, la carte des agents (504 × 198 à 1440 × 900) et « Qui travaille ? » dépassaient la région
    // bornée ; le titre, les lignes et [Répondre] de « Qui travaille ? » étaient rendus mais cachés (sous le fil et la carte de la
    // demande), à 1440 × 900 comme à 1280 × 800, 1366 × 768, 1024 × 768 et 400 × 860. La liste reste la vérité (§5.1, §5.7.4) : elle
    // garde sa hauteur, la bande prend le reste et la carte s'y réduit (unités de conteneur), pas au-dessous de la mini-carte (§5.6) ;
    // ensuite la bande défile, en gardant sa ligne de titre. La preuve dans le navigateur (elementFromPoint : titre, lignes,
    // [Répondre], signes de la carte, aux quatre tailles) est dans les e2e it1-ui-mise-en-page et it1-ui-delegation.
    const css = fs.readFileSync(new URL("../web/pages/chat/activity/activity.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const plat = css.replace(/\s+/g, " ");
    const bloc = (selecteur: string, depuis = 0) => {
      const at = plat.indexOf(`${selecteur} {`, depuis);
      assert.ok(at >= 0, `règle ${selecteur} absente`);
      return plat.slice(at, plat.indexOf("}", at));
    };
    const media = (requete: string) => {
      const at = plat.indexOf(`@media ${requete} {`);
      assert.ok(at >= 0, `@media ${requete} absente`);
      return at;
    };
    const BANDE = ".activity-region.demande > .neon-band:has(> .neon-body)";
    const bande = bloc(BANDE);
    for (const decl of ["display: flex;", "flex-direction: column;", "flex: 0 1 auto;", "min-height: 1.75rem;", "overflow-y: auto;"]) {
      assert.ok(bande.includes(decl), `${BANDE} : ${decl}`);
    }
    assert.ok(bloc(".activity-region.demande > .neon-band > .neon-head").includes("flex: none;"), "la tête de la bande garde sa hauteur");
    const CORPS = ".activity-region.demande > .neon-band > .neon-body:has(> .neon-map-wrap)";
    const corps = bloc(CORPS);
    for (const decl of ["flex: 0 1 auto;", "min-height: 4.5em;", "container-type: size;", "contain-intrinsic-block-size: min(220px, 22vh);"]) {
      assert.ok(corps.includes(decl), `${CORPS} : ${decl}`);
    }
    assert.ok(
      bloc(".activity-region.demande > .neon-band > .neon-body > .neon-map-wrap").includes("max-width: min(560px, 56vh, 100cqh * 560 / 220);"),
      "carte réduite à la hauteur de son corps (plancher : la mini-carte, par le min-height du corps)",
    );
    // « Qui travaille ? » ne cède jamais au-dessus de 400 px : aucun enfant de la région ne rétrécit hors de la bande.
    assert.ok(bloc(".activity-region > *").includes("flex: none;"));
    const horsMedia = plat.slice(0, plat.indexOf("@media"));
    assert.doesNotMatch(horsMedia, /\.activity-region\.demande > \.who-banner \{/, "« Qui travaille ? » garde sa hauteur au-dessus de 400 px");
    // Sous 900 px : mini-carte de 3 lignes (neon.css) ; à 400 px : liste seule, bandeau d'une ligne, qui garde sa place sous la bande.
    assert.ok(bloc(CORPS, media("(max-width: 899.98px)")).includes("contain-intrinsic-block-size: 4.5em;"));
    const a400 = media("(max-width: 400px)");
    const corps400 = bloc(CORPS, a400);
    for (const decl of ["min-height: 0;", "container-type: normal;", "contain-intrinsic-block-size: none;"]) assert.ok(corps400.includes(decl), `400 px, ${CORPS} : ${decl}`);
    // Bande repliée (sans corps) ou dépliée (le sélecteur :has(> .neon-body) l'emporterait sinon, par sa spécificité).
    const toute400 = bloc(`.activity-region.demande > .neon-band, ${BANDE}`, a400);
    for (const decl of ["flex: 0 1 auto;", "min-height: 0;", "overflow-y: auto;"]) assert.ok(toute400.includes(decl), `400 px, bande dépliée ou repliée : ${decl}`);
    // Bandeau d'une ligne, [Répondre] compris (2,5 rem), avant la bande ; la ligne de titre de la bande (1,75 rem) quand la région le permet.
    const qui400 = bloc(".activity-region.demande > .who-banner", a400);
    for (const decl of ["max-height: max(2.5rem, 100% - 1.75rem);", "overflow-y: auto;"]) assert.ok(qui400.includes(decl), `400 px, « Qui travaille ? » : ${decl}`);
    // Au-dessus de 400 px, bande repliée par vous (sans corps) : aucune de ces bornes, elle garde sa hauteur de tête.
    assert.doesNotMatch(horsMedia, /\.activity-region\.demande > \.neon-band \{/, "la bande repliée garde sa hauteur de tête");
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
