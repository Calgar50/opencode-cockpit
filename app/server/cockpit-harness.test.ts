import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import type { Classifier } from "./classifier.ts";
import { startCockpit } from "./test-support/cockpit-harness.ts";
import { until } from "./test-support/helpers.ts";

describe("harnais du cockpit", () => {
  it("démarrage : EventProcessor réel connecté au faux (rattrapage compris), mode Simple, session exigée, aucun rechargement d'opencode", async (t) => {
    const h = await startCockpit(t);
    assert.equal(h.processor.status.connected, true);
    assert.equal(h.settings.get().ui.mode, "simple");
    assert.ok(h.fake.requests.some((r) => r.method === "GET" && r.pathname === "/experimental/session"), "rattrapage du processeur");
    assert.equal((await h.call("GET", "/api/health")).status, 200);
    assert.equal((await h.call("GET", "/api/bootstrap")).status, 401, "sans cookie de session");
    const boot = await h.call("GET", "/api/bootstrap", { headers: h.headers.authed });
    assert.equal(boot.status, 200, boot.body);
    assert.equal(boot.json<{ opencode: { reachable: boolean; events: { connected: boolean } } }>().opencode.reachable, true);
    assert.deepEqual(h.fake.failures, []);
    h.assertNoGlobalRestart();
  });

  it("POST /api/oc/session par le proxy atteint le faux opencode (anti-CSRF exigé), puis la session est relevée par l'EventProcessor", async (t) => {
    const h = await startCockpit(t);
    assert.equal((await h.call("POST", "/api/oc/session", { headers: h.headers.authed, body: { title: "Fumée" } })).status, 403, "sans en-tête anti-CSRF");
    assert.ok(!h.fake.requests.some((r) => r.method === "POST" && r.pathname === "/session"), "refusée avant le relais");
    const created = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title: "Fumée" } });
    assert.equal(created.status, 200, created.body);
    const session = created.json<{ id: string; title: string }>();
    assert.equal(h.fake.session(session.id)?.title, "Fumée");
    const relayed = h.fake.requests.filter((r) => r.method === "POST" && r.pathname === "/session");
    assert.deepEqual(relayed.map((r) => [r.body, r.authorized]), [[{ title: "Fumée" }, true]]);
    const row = await until(() => h.sessions.get(session.id));
    assert.equal(row.root_id, session.id);
  });

  it("EventProcessor réel : une réponse relayée par le proxy est enregistrée dans l'usage (coût, jetons) et annoncée par usage.updated", async (t) => {
    const h = await startCockpit(t);
    const session = (await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title: "Usage" } })).json<{ id: string }>();
    h.fake.script(session.id, { text: "Bonjour.", cost: 0.0123, tokens: { input: 120, output: 30 } });
    const sent = await h.call("POST", `/api/oc/session/${session.id}/prompt_async`, {
      headers: h.headers.mutating,
      body: { agent: "build", model: { providerID: "github-copilot", modelID: "gpt-5-mini" }, parts: [{ type: "text", text: "Salut" }] },
    });
    assert.equal(sent.status, 204, sent.body);
    await h.fake.settled(session.id);
    const row = await until(
      () =>
        h.db.prepare("SELECT session_id, root_id, cost_reported, tokens_input, tokens_output FROM usage WHERE session_id = ? AND completed_at IS NOT NULL").get(session.id) as
          | { session_id: string; root_id: string; cost_reported: number; tokens_input: number; tokens_output: number }
          | undefined,
    );
    assert.deepEqual({ ...row }, { session_id: session.id, root_id: session.id, cost_reported: 0.0123, tokens_input: 120, tokens_output: 30 });
    await until(() => h.cockpitEvents().find((e) => e.type === "usage.updated" && (e.data as { sessionId?: string }).sessionId === session.id));
    h.assertNoGlobalRestart();
  });

  it("assertNoGlobalRestart : échoue sur un PATCH /global/config, un POST /global/dispose et un redémarrage demandé au contrôle", async (t) => {
    const patched = await startCockpit(t);
    patched.assertNoGlobalRestart();
    await patched.deps.client.request("PATCH", "/global/config", { body: { share: "disabled" } });
    assert.throws(() => patched.assertNoGlobalRestart(), /PATCH \/global\/config/);

    const disposed = await startCockpit(t);
    await disposed.deps.client.request("POST", "/global/dispose");
    assert.throws(() => disposed.assertNoGlobalRestart(), /POST \/global\/dispose/);

    const restarted = await startCockpit(t);
    const answer = await restarted.call("POST", "/api/system/restart-opencode", { headers: restarted.headers.mutating });
    assert.equal(answer.status, 200, answer.body);
    assert.throws(() => restarted.assertNoGlobalRestart(), /redémarrage demandé/);
  });

  it("options settings, env et deps appliquées (EventProcessor reconstruit sur le classement remplacé) ; close() idempotent, faux opencode fermé", async (t) => {
    const idle: string[] = [];
    const h = await startCockpit(t, {
      settings: { ui: { mode: "avance" } },
      env: { version: "harnais" },
      deps: () => ({ classifier: { onIdle: (rootId: string) => void idle.push(rootId), onBusy: () => undefined } as unknown as Classifier }),
    });
    assert.equal(h.settings.get().ui.mode, "avance");
    assert.equal((await h.call("GET", "/api/health")).json<{ version: string }>().version, "harnais");
    const session = (await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title: "Repos" } })).json<{ id: string }>();
    await h.deps.client.request("POST", `/session/${session.id}/message`, { body: { parts: [{ type: "text", text: "Bonjour" }] } });
    await until(() => idle.includes(session.id));
    await h.close();
    await h.close();
    await assert.rejects(fetch(`${h.fake.url}/global/health`));
  });

  it("sentinelle d'instance (R106-a) : le nettoyage échoue si le test a ouvert une instance hors de /workspace (« /ailleurs », « .. » littéral) ; témoin resté dans /workspace : nettoyage vert", async (t) => {
    // Faux TestContext : ce que startCockpit enregistre par t.after est rejoué ici, comme node:test le ferait en fin de test.
    const contexte = () => {
      const after: Array<() => unknown> = [];
      const nettoyer = async () => {
        for (const fn of after) await fn();
      };
      t.after(() => nettoyer().catch(() => undefined));
      return { t: { after: (fn: () => unknown) => void after.push(fn) } as unknown as TestContext, nettoyer };
    };
    for (const [dehors, releve] of [["/ailleurs", "/ailleurs"], ["/workspace/../secret", "/secret"]] as const) {
      const fautif = contexte();
      const h = await startCockpit(fautif.t);
      await h.deps.client.request("GET", "/session/status", { directory: dehors });
      await assert.rejects(fautif.nettoyer(), (err: unknown) => err instanceof AggregateError && new RegExp(`hors de /workspace : ${releve}\\b`).test(String(err.errors[0]?.message)));
    }
    const temoin = contexte();
    const w = await startCockpit(temoin.t);
    await w.deps.client.request("GET", "/session/status", { directory: "/workspace/projet" });
    await w.deps.client.request("GET", "/session/status", { directory: "/workspace/a/../b" });
    await temoin.nettoyer();
  });
});
