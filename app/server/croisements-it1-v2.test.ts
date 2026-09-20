// Tests de croisement du train it1 V2 (plan d'exécution §2.3, §5.2 ; propriété de l'intégrateur) : L1b (relayOnce, refus retenu,
// arbre unique), L1c (arrêt de l'arbre), L3 (plancher), L6a (choix d'autonomie), L4b (magasin de faits, écrivain unique, routes),
// L4c (réducteur d'activité), L5a (scène néon) et L1g (agents internes gardés).
// Ce que la vague doit prouver ensemble, et qu'aucun paquet ne peut prouver seul (chaque paquet a testé avec des espions) :
//   1. « Arrêter » du navigateur sur une conversation suivie, créée avec son plancher : stopTree, puis « once » tardif refusé ;
//      délégation marquée par le VRAI écrivain unique, fait statut {cause: arret} dans le VRAI magasin, relu tel quel par le
//      réducteur (L4c) et la scène (L5a) ; le plancher tient encore après l'arrêt ;
//   2. resserrement du choix d'autonomie → fait « choix » écrit par le magasin réel, diffusé en activite.fait et relu par L4c ;
//      porte I1 (activation fermée) et COCKPIT_AUTONOMY=off sur le câblage complet ;
//   3. agent interne différé pendant une réponse puis installé au repos, par le démarrage 1.1 et le redémarrage d'opencode du
//      câblage complet (mode Simple par défaut : redémarrage refusé pendant la réponse).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLASSIFIER_AGENT } from "./classifier.ts";
import type { ActivationPort } from "./contracts-11.ts";
import type { ActivityFact, ActivityResponse, FactsResponse } from "./shared/activity-types.ts";
import { activityStatus, announcements, applyEvent, emptyActivity, liveRows, replayFacts } from "./shared/activity.ts";
import type { ConversationAutonomyView } from "./shared/autonomy-types.ts";
import type { InternalAgentStatus, StopResult } from "./shared/cockpit-event-types.ts";
import { CONTROL_AGENT_NAME } from "./shared/control-ai-output.ts";
import { scene } from "./shared/neon-scene.ts";
import type { StudioService } from "./studio.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import type { FakePermissionRequest, FakeSession } from "./test-support/fake-opencode.ts";
import { assertSubsequence, bash, trace, until, within } from "./test-support/helpers.ts";

const MODEL = { providerID: "github-copilot", modelID: "gpt-5-mini" };

/** Comme `until`, pour une lecture asynchrone (route HTTP) : `until` n'attend pas une promesse, il la rendrait aussitôt. */
async function untilAsync<T>(read: () => Promise<T | undefined | null | false>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() > deadline) throw new Error("condition non atteinte à temps");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Conversation créée par le proxy (plancher posé par L3 quand le module est installé), suivie par le cockpit. */
async function trackedRoot(h: CockpitHarness, title: string): Promise<FakeSession> {
  const created = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title } });
  assert.equal(created.status, 200, created.body);
  const session = created.json<FakeSession>();
  await until(() => h.sessions.get(session.id));
  return session;
}

async function sendThroughProxy(h: CockpitHarness, sessionId: string, text: string): Promise<void> {
  const sent = await h.call("POST", `/api/oc/session/${sessionId}/prompt_async`, {
    headers: h.headers.mutating,
    body: { agent: "build", model: MODEL, parts: [{ type: "text", text }] },
  });
  assert.equal(sent.status, 204, sent.body);
}

async function readFacts(h: CockpitHarness, rootId: string): Promise<ActivityFact[]> {
  const res = await h.call("GET", `/api/conversations/${rootId}/facts?since=0`, { headers: h.headers.authed });
  assert.equal(res.status, 200, res.body);
  const body = res.json<FactsResponse>();
  assert.equal(body.partial, false);
  return body.facts;
}

async function readActivity(h: CockpitHarness, rootId: string): Promise<ActivityResponse> {
  const res = await h.call("GET", `/api/conversations/${rootId}/activity`, { headers: h.headers.authed });
  assert.equal(res.status, 200, res.body);
  return res.json<ActivityResponse>();
}

const patchesOf = (h: CockpitHarness, sessionId: string) => h.fake.requests.filter((r) => r.method === "PATCH" && r.pathname === `/session/${sessionId}`).length;

describe("croisements it1 V2 : arrêt de l'arbre sur le câblage complet", () => {
  it("« Arrêter » (proxy) sur une conversation suivie avec plancher : stopTree refuse la demande, arrête l'arbre ; « once » tardif 409 ; délégations par l'écrivain unique, fait statut arret relu par L4c et L5a ; plancher encore tenu ; P6", async (t) => {
    // Mode Avancé : en Simple, la délégation qui attend votre accord serait refusée d'office par la garde du « task once » (L1d,
    // décision n° 4) ; seul l'Avancé garde cette attente pour « Arrêter ».
    const h = await startCockpit(t, { modules: "tous", settings: { ui: { mode: "avance" } } });
    const root = await trackedRoot(h, "Arrêt croisé");
    // L3 : plancher CONVERSATION posé à la création, écho vérifié, marque enregistrée.
    assert.equal(await h.cockpit.c11.ports.floors.verified(root.id), true);
    assert.match(String(h.sessions.get(root.id)?.plancher), /^conversation:[0-9a-f]{64}$/);

    // Scénario de la capture p6 : une délégation travaille, une seconde attend votre accord.
    h.fake.script(root.id, {
      tools: [
        { tool: "task", input: { description: "Analyser les journaux", prompt: "Consigne", subagent_type: "general" }, child: { agent: "general", workMs: 60_000 } },
        {
          tool: "task",
          input: { description: "Analyser changements.md", prompt: "Lis changements.md", subagent_type: "general" },
          ask: { permission: "task", patterns: ["general"], metadata: { description: "Analyser changements.md", subagent_type: "general" } },
          child: { agent: "general", text: "Deux changements." },
        },
      ],
    });
    await sendThroughProxy(h, root.id, "Consulte les deux analystes.");
    assert.equal(patchesOf(h, root.id), 0, "plancher à jour : aucun PATCH avant le premier envoi");
    const asked = (await h.fake.waitForEvent("permission.asked", (p) => p.sessionID === root.id)).properties as unknown as FakePermissionRequest;
    const child = ((await h.fake.waitForEvent("session.created", (p) => (p.info as FakeSession).parentID === root.id)).properties.info as FakeSession).id;
    await until(() => h.fake.statusOf(child).type === "busy" && h.sessions.get(child));
    // L4b : la dérivation des faits a écrit les délégations et l'attente depuis le flux.
    const before = await untilAsync(async () => {
      const a = await readActivity(h, root.id);
      return a.delegations.some((d) => d.state === "travaille") && a.delegations.some((d) => d.state === "attente-accord") ? a : null;
    });
    assert.deepEqual(before.waits.map((w) => [w.permissionId, w.reply]), [[asked.id, null]]);
    // Délégation dont le flux a été manqué (coupure) : inscrite « travaille » par le VRAI écrivain unique, aucune partie `task` ne
    // la close. Seule l'étape 6 de stopTree peut la marquer « arretee » : la délégation vue dans le flux, elle, est déjà close par la
    // dérivation (partie `task` interrompue) avant l'étape 6.
    const missed = "call_flux_manque";
    assert.equal(h.cockpit.c11.ports.facts.work.markDelegation({ rootId: root.id, parentSessionId: root.id, callId: missed, agent: "general" }, "travaille", null), true);

    const since = h.fake.emitted.length;
    const stop = await h.call("POST", `/api/oc/session/${root.id}/abort`, { headers: h.headers.mutating });
    assert.equal(stop.status, 200, stop.body);
    const result = stop.json<StopResult>();
    assert.equal(result.rootId, root.id);
    assert.equal(result.rejected, 1);
    assert.equal(result.aborted[0], root.id);
    assert.deepEqual(result.unconfirmed, []);
    const stopped = trace(h.fake.emitted.slice(since), { [root.id]: "racine", [child]: "enfant" });
    assertSubsequence(stopped, ["permission.replied:reject@racine", "session.error:MessageAbortedError@enfant", "session.error:MessageAbortedError@racine"]);
    assert.equal(h.cockpit.gate.emitted.has(asked.id), true, "refus inscrit au registre (P9)");
    assert.deepEqual(await h.deps.client.request("GET", "/session/status"), {}, "aucune session occupée");

    // « once » tardif : refusé par le portillon, rien lancé (p7).
    const sinceLate = h.fake.emitted.length;
    const late = await h.call("POST", `/api/oc/permission/${asked.id}/reply`, { headers: h.headers.mutating, body: { reply: "once" } });
    assert.equal(late.status, 409, late.body);
    assert.equal(late.json<{ error: string }>().error, "demande-expiree");
    assert.deepEqual(
      h.fake.requests.filter((r) => r.method === "POST" && r.pathname === `/permission/${asked.id}/reply`).map((r) => r.body),
      [{ reply: "reject" }],
    );
    assert.equal(h.fake.emitted.slice(sinceLate).some((w) => w.payload.type === "session.created"), false, "aucun sous-agent détaché");

    // L1c + L4b : délégations en cours « arretee » (celle du flux et celle que seul stopTree pouvait clore), demande refusée
    // « refusee », attente close ; état final jamais régressé.
    const after = await untilAsync(async () => {
      const a = await readActivity(h, root.id);
      return a.delegations.every((d) => d.endedAt !== null) && a.waits.every((w) => w.reply !== null) ? a : null;
    });
    const label = (d: ActivityResponse["delegations"][number]) => (d.callId === missed ? "manquee" : d.childSessionId === child ? "enfant" : "demande");
    assert.deepEqual(
      after.delegations.map((d) => [label(d), d.state]).sort(),
      [
        ["demande", "refusee"],
        ["enfant", "arretee"],
        ["manquee", "arretee"],
      ],
    );
    assert.deepEqual(after.waits.map((w) => [w.permissionId, w.reply]), [[asked.id, "reject"]]);

    // Fait statut {cause: arret} dans le magasin réel, en dernier ; diffusé en activite.fait.
    const facts = await readFacts(h, root.id);
    const stopFacts = facts.filter((f) => f.kind === "statut" && f.data.cause !== undefined);
    assert.deepEqual(
      stopFacts.map((f) => [f.sessionId, { ...f.data, debut: typeof f.data.debut }]),
      [[root.id, { cause: "arret", motif: "vous", nonConfirmees: 0, debut: "number" }]],
    );
    assert.ok(stopFacts.every((f) => Number(f.data.debut) <= f.at), "le fait d'arrêt porte l'heure de son début");
    assert.equal(facts.at(-1)?.kind, "statut");
    assert.ok(
      h.cockpitEvents().some((e) => e.type === "activite.fait" && (e.data as ActivityFact).kind === "statut" && (e.data as ActivityFact).data.cause === "arret"),
      "fait d'arrêt diffusé",
    );
    assert.deepEqual(
      h.cockpitEvents().filter((e) => e.type === "conversation.arretee"),
      [{ type: "conversation.arretee", data: { rootId: root.id, cause: "vous", unconfirmed: [] } }],
    );

    // L4c : les faits relus (différé) disent l'arrêt ; racine et enfant arrêtés, demande refusée jamais démarrée.
    const state = replayFacts(emptyActivity(root.id), facts);
    const status = activityStatus(state);
    assert.deepEqual(status.arret && { cause: status.arret.cause, nonConfirmees: status.arret.nonConfirmees }, { cause: "arret", nonConfirmees: 0 });
    const rows = liveRows(state, Date.now());
    assert.deepEqual(
      rows.map((r) => [r.sessionId === root.id ? "racine" : r.sessionId === child ? "enfant" : r.sessionId, r.sansSession, r.state]),
      [
        ["racine", false, "arrete"],
        ["enfant", false, "arrete"],
        ["racine", true, "jamais-demarre"],
      ],
    );
    // L5a : la même suite de faits fige en gris les faisceaux de la réponse arrêtée.
    const drawn = scene(facts, null, { zoom: 2, mode: "avance" });
    assert.ok(drawn.arret !== null, "arrêt signalé sur la carte");
    assert.ok(drawn.faisceaux.length > 0 && drawn.faisceaux.every((b) => b.fige), "faisceaux de la réponse arrêtée figés");
    assert.deepEqual(drawn.noeuds.map((n) => [n.sessionId === root.id ? "racine" : "enfant", n.etat]), [
      ["racine", "arrete"],
      ["enfant", "arrete"],
    ]);

    // L3 après l'arrêt : le plancher tient toujours, l'envoi suivant part sans PATCH et la réponse suivante n'est plus figée.
    h.fake.script(root.id, { text: "Reprise." });
    await sendThroughProxy(h, root.id, "Reprends seul.");
    await within(h.fake.settled(root.id), "réponse suivante");
    assert.equal(patchesOf(h, root.id), 0);
    const resumed = await untilAsync(async () => {
      const list = await readFacts(h, root.id);
      return list.length > facts.length && list.at(-1)?.data.etat === "repos" ? list : null;
    });
    assert.equal(scene(resumed, null, { zoom: 2, mode: "avance" }).noeuds.find((n) => n.sessionId === root.id)?.etat, "termine");
    h.assertNoGlobalRestart();
  });

  it("mode Simple : « Arrêter » pendant une attente d'accord pour une commande de la racine → racine « arrete » (cause arret), demande figée, annonce « arrêté » ; en direct comme en différé ; témoin : « Refuser » sans message reste « termine »", async (t) => {
    const h = await startCockpit(t, { modules: "tous" });
    const root = await trackedRoot(h, "Arrêt pendant une attente");
    h.fake.script(root.id, { tools: [bash("ls")], followUp: { text: "fin" } });
    await sendThroughProxy(h, root.id, "Liste.");
    const asked = (await h.fake.waitForEvent("permission.asked", (p) => p.sessionID === root.id)).properties as unknown as FakePermissionRequest;
    const waiting = await untilAsync(async () => {
      const list = await readFacts(h, root.id);
      return list.some((f) => f.kind === "attente" && f.ref === asked.id) ? list : null;
    });
    const atWait = replayFacts(emptyActivity(root.id), waiting);
    assert.deepEqual(liveRows(atWait, Date.now()).map((r) => [r.sessionId === root.id, r.state]), [[true, "attente-accord"]]);

    const since = h.fake.emitted.length;
    const stop = await h.call("POST", `/api/oc/session/${root.id}/abort`, { headers: h.headers.mutating });
    assert.equal(stop.status, 200, stop.body);
    assert.deepEqual([stop.json<StopResult>().rejected, stop.json<StopResult>().unconfirmed], [1, []]);
    // Le tour s'arrête sur le refus (RejectedError), sans MessageAbortedError : c'est le cas que l'abortedAt ne couvre pas.
    const stopped = trace(h.fake.emitted.slice(since), { [root.id]: "racine" });
    assertSubsequence(stopped, ["permission.replied:reject@racine", "session.status:idle@racine"]);
    assert.equal(stopped.some((e) => e.startsWith("session.error")), false, stopped.join(", "));

    const facts = await untilAsync(async () => {
      const list = await readFacts(h, root.id);
      return list.some((f) => f.kind === "statut" && f.data.cause === "arret") ? list : null;
    });
    const stopFact = facts.find((f) => f.kind === "statut" && f.data.cause === "arret");
    assert.ok(stopFact && typeof stopFact.data.debut === "number" && stopFact.data.debut <= stopFact.at, "début de l'arrêt écrit dans le fait");
    const live = h
      .cockpitEvents()
      .filter((e) => e.type === "activite.fait")
      .reduce((state, e) => applyEvent(state, { kind: "cockpit", type: e.type, data: e.data }), emptyActivity(root.id));
    const deferred = replayFacts(emptyActivity(root.id), facts);
    const now = Date.now();
    for (const [label, state] of [["direct", live], ["différé", deferred]] as const) {
      assert.deepEqual(liveRows(state, now).map((r) => [r.sessionId === root.id, r.state, r.cause]), [[true, "arrete", "arret"]], label);
      assert.equal(activityStatus(state).arret?.cause, "arret", label);
      for (const mode of ["simple", "avance"] as const) {
        const drawn = scene(state.facts, null, { zoom: 2, mode });
        assert.notEqual(drawn.arret, null, `${label} ${mode}`);
        assert.deepEqual(drawn.noeuds.map((n) => [n.sessionId === root.id, n.etat]), [[true, "arrete"]], `${label} ${mode}`);
        assert.ok(drawn.faisceaux.some((b) => b.kind === "demande") && drawn.faisceaux.every((b) => b.fige), `${label} ${mode} : demande figée`);
      }
    }
    // Annonce : de l'attente à l'état final, « arrêté », jamais « terminé ».
    const said = announcements(atWait, deferred, now).say ?? [];
    assert.deepEqual(said.filter((a) => a.key === root.id).map((a) => [a.code, a.cause]), [["arrete", "arret"]]);

    // Témoin : « Refuser » sans message, sans « Arrêter » : le tour s'arrête aussi, la réponse reste « terminée », rien de figé.
    const other = await trackedRoot(h, "Refus seul");
    h.fake.script(other.id, { tools: [bash("ls")], followUp: { text: "fin" } });
    await sendThroughProxy(h, other.id, "Liste.");
    const refusedAsk = (await h.fake.waitForEvent("permission.asked", (p) => p.sessionID === other.id)).properties as unknown as FakePermissionRequest;
    const refused = await h.call("POST", `/api/oc/permission/${refusedAsk.id}/reply`, { headers: h.headers.mutating, body: { reply: "reject" } });
    assert.equal(refused.status, 200, refused.body);
    await until(() => h.fake.statusOf(other.id).type === "idle");
    const otherFacts = await untilAsync(async () => {
      const list = await readFacts(h, other.id);
      return list.at(-1)?.data.etat === "repos" ? list : null;
    });
    const refusedState = replayFacts(emptyActivity(other.id), otherFacts);
    assert.deepEqual(liveRows(refusedState, Date.now()).map((r) => [r.state, r.cause]), [["termine", null]]);
    assert.equal(activityStatus(refusedState).arret, null);
    const refusedScene = scene(otherFacts, null, { zoom: 2, mode: "avance" });
    assert.deepEqual([refusedScene.noeuds.map((n) => n.etat), refusedScene.faisceaux, refusedScene.arret], [["termine"], [], null]);
    h.assertNoGlobalRestart();
  });
});

describe("croisements it1 V2 : choix d'autonomie et faits", () => {
  const allow: ActivationPort = { check: async () => ({ ok: true }) };
  /** Porte I1 refermée : le refus que le port réel rendait avant la bascule du train de la vague 3 (it2). */
  const aVenir: ActivationPort = { check: async () => ({ ok: false, raison: "a-venir" }) };
  const putChoice = (h: CockpitHarness, rootId: string, body: unknown, headers: Record<string, string>) =>
    h.call("PUT", `/api/conversations/${rootId}/autonomie`, { headers, body });
  const choiceFacts = (facts: readonly ActivityFact[]) => facts.filter((f) => f.kind === "choix").map((f) => [f.sessionId, f.data]);

  it("resserrer (Autonome → Modifications → Demander) : immédiat, fait « choix » écrit par le magasin réel, diffusé, relu par L4c ; aucune scène d'assistant sur un choix seul", async (t) => {
    // Activation ouverte par surcharge de port : ce test ne dépend d'aucune configuration d'assistant (voir le test suivant).
    const h = await startCockpit(t, { modules: "tous", ports: { activation: allow } });
    const root = await trackedRoot(h, "Choix croisé");

    assert.equal((await putChoice(h, root.id, { choix: "autonome" }, h.headers.mutating)).status, 428);
    const relaxed = await putChoice(h, root.id, { choix: "autonome" }, h.headers.confirmed);
    assert.equal(relaxed.status, 200, relaxed.body);
    for (const choix of ["modifications", "demander"]) {
      const res = await putChoice(h, root.id, { choix }, h.headers.mutating);
      assert.equal(res.status, 200, res.body);
      assert.equal(res.json<ConversationAutonomyView>().choix, choix);
    }

    const expected = [
      [root.id, { choix: "autonome", cause: "clic" }],
      [root.id, { choix: "modifications", cause: "clic" }],
      [root.id, { choix: "demander", cause: "clic" }],
    ];
    const facts = await readFacts(h, root.id);
    assert.deepEqual(choiceFacts(facts), expected);
    assert.deepEqual(
      choiceFacts(h.cockpitEvents().filter((e) => e.type === "activite.fait").map((e) => e.data as ActivityFact)),
      expected,
      "chaque fait « choix » diffusé en activite.fait",
    );
    assert.deepEqual(
      h.cockpitEvents().filter((e) => e.type === "autonomie.choix").map((e) => e.data),
      expected.map(([rootId, data]) => ({ rootId, ...(data as object) })),
    );
    const status = activityStatus(replayFacts(emptyActivity(root.id), facts));
    assert.deepEqual(status.choix && { choix: status.choix.choix, cause: status.choix.cause }, { choix: "demander", cause: "clic" });
    assert.deepEqual(scene(facts.filter((f) => f.kind === "choix"), null, { zoom: 2, mode: "avance" }).noeuds, [], "P12 : un choix seul ne dessine aucun assistant");
    h.assertNoGlobalRestart();
  });

  // Porte I1 BASCULÉE au train de la vague 3 de l'itération 2 : sur le câblage complet, un choix automatique confirmé passe
  // désormais. Le refus « a-venir » reste joué ici par un port d'activation qui refuse — la porte refermée —, et le avant/après
  // de la constante elle-même est tenu par croisements-it2-v3.test.ts.
  it("porte I1 ouverte sur le câblage complet : relâcher → 428, puis 200 confirmé et fait « choix » ; porte refermée → 409 « a-venir », rien d'écrit ; COCKPIT_AUTONOMY=off : demander 200, choix automatiques 403", async (t) => {
    const h = await startCockpit(t, { modules: "tous" });
    const root = await trackedRoot(h, "Porte I1");
    for (const choix of ["modifications", "autonome"]) {
      assert.equal((await putChoice(h, root.id, { choix }, h.headers.mutating)).status, 428);
      const ouvert = await putChoice(h, root.id, { choix }, h.headers.confirmed);
      assert.equal(ouvert.status, 200, ouvert.body);
      assert.equal(ouvert.json<ConversationAutonomyView>().choix, choix);
      assert.equal(h.cockpit.c11.ports.conversationAutonomy.choiceOf(root.id), choix);
    }
    assert.deepEqual(choiceFacts(await readFacts(h, root.id)), [
      [root.id, { choix: "modifications", cause: "clic" }],
      [root.id, { choix: "autonome", cause: "clic" }],
    ]);

    const ferme = await startCockpit(t, { modules: "tous", ports: { activation: aVenir } });
    const fermeRoot = await trackedRoot(ferme, "Porte refermée");
    for (const choix of ["modifications", "autonome"]) {
      assert.equal((await putChoice(ferme, fermeRoot.id, { choix }, ferme.headers.mutating)).status, 428);
      const refused = await putChoice(ferme, fermeRoot.id, { choix }, ferme.headers.confirmed);
      assert.equal(refused.status, 409, refused.body);
      assert.deepEqual(
        { error: refused.json<{ error: string }>().error, raison: refused.json<{ raison: string }>().raison },
        { error: "autonomie-indisponible", raison: "a-venir" },
      );
    }
    assert.deepEqual(choiceFacts(await readFacts(ferme, fermeRoot.id)), [], "aucun fait « choix »");
    assert.equal(ferme.cockpit.c11.ports.conversationAutonomy.choiceOf(fermeRoot.id), "demander");

    const off = await startCockpit(t, { modules: "tous", env: { autonomy: false }, ports: { activation: allow } });
    const offRoot = await trackedRoot(off, "Autonomie coupée");
    assert.equal((await putChoice(off, offRoot.id, { choix: "demander" }, off.headers.mutating)).status, 200);
    for (const choix of ["modifications", "autonome"]) {
      const res = await putChoice(off, offRoot.id, { choix }, off.headers.confirmed);
      assert.equal(res.status, 403, res.body);
      assert.equal(res.json<{ error: string }>().error, "autonomie-coupee");
    }
    assert.deepEqual(choiceFacts(await readFacts(off, offRoot.id)), []);
  });
});

describe("croisements it1 V2 : agents internes gardés sur le câblage complet", () => {
  it("mode Simple : démarrage 1.1 pendant une réponse → agents internes (classement, contrôle) en attente, rien d'installé ; redémarrage refusé (réponse en cours) ; au repos, redémarrage → installés ; Diagnostic à jour", async (t) => {
    const installs: string[] = [];
    // L11b : chaque agent interne a son propre fichier (cockpit-classifier, puis cockpit-controle).
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
    const diagnostic = async () => {
      const res = await h.call("GET", "/api/diagnostic/activite", { headers: h.headers.authed });
      assert.equal(res.status, 200, res.body);
      return res.json<{ agentsInternes: InternalAgentStatus[] }>().agentsInternes;
    };
    const agents = [CLASSIFIER_AGENT, CONTROL_AGENT_NAME];
    assert.deepEqual(
      await diagnostic(),
      agents.map((nom) => ({ nom, etat: "en-attente", prochainEssai: null })),
    );

    // Réponse en cours (autorisation en attente) dans une conversation créée par le proxy, avec son plancher.
    const root = await trackedRoot(h, "Réponse en cours");
    h.fake.script(root.id, { tools: [bash("ls")], followUp: { text: "fin" } });
    await sendThroughProxy(h, root.id, "Liste.");
    const asked = (await h.fake.waitForEvent("permission.asked", (p) => p.sessionID === root.id)).properties as unknown as FakePermissionRequest;

    // Démarrage 1.1 (L6a puis internalAgents, ordre de STEP_ORDER) : différé, reprise planifiée.
    await h.cockpit.startup();
    assert.deepEqual(installs, [], "aucune installation, donc aucun rechargement, pendant la réponse");
    const waiting = await diagnostic();
    assert.deepEqual(
      waiting.map((agent) => agent.nom),
      agents,
    );
    for (const agent of waiting) {
      assert.equal(agent.etat, "en-attente", agent.nom);
      assert.ok(typeof agent.prochainEssai === "number", `reprise planifiée : ${agent.nom}`);
    }

    // Mode Simple : le redémarrage d'opencode est refusé tant qu'une réponse est en cours (décision du 15/09).
    const refused = await h.call("POST", "/api/system/restart-opencode", { headers: h.headers.confirmed });
    assert.equal(refused.status, 409, refused.body);
    assert.equal(refused.json<{ error: string }>().error, "sessions-busy");
    assert.deepEqual(installs, []);
    h.assertNoGlobalRestart();

    // Au repos : la réponse passe par le portillon (L1b), puis le redémarrage retente aussitôt l'installation.
    const once = await h.call("POST", `/api/oc/permission/${asked.id}/reply`, { headers: h.headers.mutating, body: { reply: "once" } });
    assert.equal(once.status, 200, once.body);
    await within(h.fake.settled(root.id), "réponse terminée");
    await until(() => h.fake.statusOf(root.id).type === "idle");
    const restart = await h.call("POST", "/api/system/restart-opencode", { headers: h.headers.confirmed });
    assert.equal(restart.status, 200, restart.body);
    assert.deepEqual(installs, agents, "installés au repos, dans l'ordre");
    assert.deepEqual(
      await diagnostic(),
      agents.map((nom) => ({ nom, etat: "installe", prochainEssai: null })),
    );
    assert.equal(h.fake.requests.some((r) => r.method === "POST" && (r.pathname === "/global/dispose" || r.pathname === "/instance/dispose")), false);
  });
});
