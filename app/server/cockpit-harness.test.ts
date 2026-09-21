import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Classifier } from "./classifier.ts";
import type { Cockpit11Module } from "./contracts-11.ts";
import type { OcGlobalEvent } from "./opencode.ts";
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
});

describe("harnais du cockpit : option « omo » (Salle OMO, plan 2 bis §2.2)", () => {
  it("sans l'option : aucune salle (h.omo null), emitOmo refuse, et les routes /api/omo/* répondent 403 salle-coupee", async (t) => {
    const h = await startCockpit(t, { modules: ["omoRoom"] });
    assert.equal(h.omo, null);
    assert.throws(() => h.emitOmo({ payload: { type: "session.created", properties: {} } } as OcGlobalEvent), /option « omo »/);
    const ouverture = await h.call("POST", "/api/omo/rooms", { headers: h.headers.confirmed, body: { projet: "app" } });
    assert.equal(ouverture.status, 403, ouverture.body);
    assert.equal(ouverture.json<{ error: string }>().error, "salle-coupee");
    h.assertNoGlobalRestart();
  });

  it("avec l'option : second faux opencode, instances.omo posé, dossiers de la salle créés et laissés VIDES par le démarrage", async (t) => {
    const h = await startCockpit(t, { omo: true, modules: ["omoControl", "omoRoom"] });
    assert.ok(h.omo, "option omo");
    // Second faux, distinct du premier : la salle a son propre opencode.
    assert.notEqual(h.omo.fake.url, h.fake.url);
    assert.equal(h.omo.deps.instance, "omo");
    assert.equal(h.cockpit.c11.instances?.omo, h.omo.deps);
    assert.equal(h.cockpit.c11.instances?.of("omo"), h.omo.deps);
    // Salle coupée : le service réel de L17b est branché sur ces dossiers, et le démarrage 1.1 n'y écrit rien.
    assert.equal(h.cockpit.c11.salleOuverte, false);
    await h.cockpit.startup();
    assert.deepEqual(h.omo.fichiers(), [], "aucun battement, aucun precheck-ok, aucun auth.json");
    // L'inscription de démarrage de la salle est celle d'omoControl, côté cockpit (exception documentée, D-2b-40).
    assert.deepEqual(
      h.cockpit.wiring.registrations,
      [
        { kind: "startup", key: "startup", module: "omoControl", instances: ["principale"] },
        { kind: "routes", key: "omo", module: "omoRoom", instances: ["omo"] },
      ],
    );
    const statut = await h.call("GET", "/api/omo/status", { headers: h.headers.authed });
    assert.equal(statut.status, 403, statut.body);
    h.assertNoGlobalRestart();
  });

  it("aiguillage factice : une inscription sans « instances » ne reçoit jamais la salle ; avec [\"omo\"], elle ne reçoit qu'elle", async (t) => {
    const vus: string[] = [];
    // Deux modules factices aux noms réels (rangés par STEP_ORDER) : l'un déclare la salle, l'autre non.
    const salle: Cockpit11Module = {
      name: "omoDetections",
      install: (reg) => {
        reg.derivation({ name: "omoDetections", instances: ["omo"], onEvent: (_event, origin) => vus.push(`salle:${origin?.instance ?? "principale"}`) });
        reg.hub("usage.updated", () => vus.push("salle:hub"), { instances: ["omo"] });
      },
    };
    const cockpit: Cockpit11Module = {
      name: "omoResponder",
      install: (reg) => {
        reg.derivation({ name: "omoResponder", onEvent: () => vus.push("cockpit:derivation") });
      },
    };
    const h = await startCockpit(t, { omo: true, modules: [salle, cockpit] });
    assert.ok(h.omo);
    vus.length = 0;
    // Aiguillage de la salle : seule l'inscription qui la déclare est appelée, avec l'origine « omo ».
    h.emitOmo({ payload: { type: "session.created", properties: {} } } as OcGlobalEvent);
    h.omo.hub("usage.updated", { monthSpentUsd: 1, percent: 10 });
    assert.deepEqual(vus, ["salle:omo", "salle:hub"]);
    // Événement réel de l'instance principale : seule l'inscription sans « instances » le voit.
    vus.length = 0;
    await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title: "Principale" } });
    await until(() => vus.length > 0);
    assert.ok(
      vus.every((vu) => vu === "cockpit:derivation"),
      `la salle ne voit rien de l'instance principale : ${vus.join(", ")}`,
    );
    h.assertNoGlobalRestart();
  });
});
