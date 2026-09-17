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
import { activityStatus, emptyActivity, liveRows, replayFacts } from "./shared/activity.ts";
import type { ConversationAutonomyView } from "./shared/autonomy-types.ts";
import type { InternalAgentStatus, StopResult } from "./shared/cockpit-event-types.ts";
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
    const h = await startCockpit(t, { modules: "tous" });
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
      stopFacts.map((f) => [f.sessionId, f.data]),
      [[root.id, { cause: "arret", motif: "vous", nonConfirmees: 0 }]],
    );
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
});

describe("croisements it1 V2 : choix d'autonomie et faits", () => {
  const allow: ActivationPort = { check: async () => ({ ok: true }) };
  const putChoice = (h: CockpitHarness, rootId: string, body: unknown, headers: Record<string, string>) =>
    h.call("PUT", `/api/conversations/${rootId}/autonomie`, { headers, body });
  const choiceFacts = (facts: readonly ActivityFact[]) => facts.filter((f) => f.kind === "choix").map((f) => [f.sessionId, f.data]);

  it("resserrer (Autonome → Modifications → Demander) : immédiat, fait « choix » écrit par le magasin réel, diffusé, relu par L4c ; aucune scène d'assistant sur un choix seul", async (t) => {
    // Activation ouverte par surcharge de port (porte I1 fermée en production : voir le test suivant).
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

  it("porte I1 sur le câblage complet : relâcher → 428, puis 409 « a-venir » confirmé, rien d'écrit ; COCKPIT_AUTONOMY=off : demander 200, choix automatiques 403", async (t) => {
    const h = await startCockpit(t, { modules: "tous" });
    const root = await trackedRoot(h, "Porte I1");
    for (const choix of ["modifications", "autonome"]) {
      assert.equal((await putChoice(h, root.id, { choix }, h.headers.mutating)).status, 428);
      const refused = await putChoice(h, root.id, { choix }, h.headers.confirmed);
      assert.equal(refused.status, 409, refused.body);
      assert.deepEqual(
        { error: refused.json<{ error: string }>().error, raison: refused.json<{ raison: string }>().raison },
        { error: "autonomie-indisponible", raison: "a-venir" },
      );
    }
    assert.deepEqual(choiceFacts(await readFacts(h, root.id)), [], "aucun fait « choix »");
    assert.equal(h.cockpit.c11.ports.conversationAutonomy.choiceOf(root.id), "demander");

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
  it("mode Simple : démarrage 1.1 pendant une réponse → agent de classement en attente, rien d'installé ; redémarrage refusé (réponse en cours) ; au repos, redémarrage → installé ; Diagnostic à jour", async (t) => {
    const installs: string[] = [];
    let upToDate = false;
    const h = await startCockpit(t, {
      modules: "tous",
      deps: (base) => ({
        studio: {
          ...(base.studio as object),
          internalAgentUpToDate: async () => upToDate,
          ensureInternalAgent: async (name: string) => {
            installs.push(name);
            upToDate = true;
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
    assert.deepEqual(await diagnostic(), [{ nom: CLASSIFIER_AGENT, etat: "en-attente", prochainEssai: null }]);

    // Réponse en cours (autorisation en attente) dans une conversation créée par le proxy, avec son plancher.
    const root = await trackedRoot(h, "Réponse en cours");
    h.fake.script(root.id, { tools: [bash("ls")], followUp: { text: "fin" } });
    await sendThroughProxy(h, root.id, "Liste.");
    const asked = (await h.fake.waitForEvent("permission.asked", (p) => p.sessionID === root.id)).properties as unknown as FakePermissionRequest;

    // Démarrage 1.1 (L6a puis internalAgents, ordre de STEP_ORDER) : différé, reprise planifiée.
    await h.cockpit.startup();
    assert.deepEqual(installs, [], "aucune installation, donc aucun rechargement, pendant la réponse");
    const waiting = await diagnostic();
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0]?.etat, "en-attente");
    assert.ok(typeof waiting[0]?.prochainEssai === "number", "reprise planifiée");

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
    assert.deepEqual(installs, [CLASSIFIER_AGENT]);
    assert.deepEqual(await diagnostic(), [{ nom: CLASSIFIER_AGENT, etat: "installe", prochainEssai: null }]);
    assert.equal(h.fake.requests.some((r) => r.method === "POST" && (r.pathname === "/global/dispose" || r.pathname === "/instance/dispose")), false);
  });
});
