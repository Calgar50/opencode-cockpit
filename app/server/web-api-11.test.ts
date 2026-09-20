// Clients d'API minces de la 1.1 (T2) : adresses, en-têtes CSRF et de confirmation, et repli de « Arrêter » sur l'arrêt 1.0.4
// seulement quand la route d'arrêt de l'arbre répond 404. Le fetch du navigateur est remplacé par un espion (aucun réseau).
import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { activityApi } from "../web/lib/api-activity.ts";
import { autonomyApi, autonomyError } from "../web/lib/api-autonomy.ts";
import { conversationApi, stopConversation } from "../web/lib/api-conversations.ts";
import { diagnostic11Api } from "../web/lib/api-diagnostic-11.ts";
import { planApi } from "../web/lib/api-plans.ts";
import { ApiError } from "../web/lib/api.ts";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status: number; body?: unknown } | "network";

/** Remplace fetch : chaque appel est noté et reçoit la réponse suivante de `replies` (la dernière est répétée). */
function spyFetch(t: TestContext, replies: Reply[]): Call[] {
  const calls: Call[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ method: init?.method ?? "GET", url: String(input), headers, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    const reply = replies[Math.min(calls.length, replies.length) - 1] ?? { status: 200 };
    if (reply === "network") throw new TypeError("fetch failed");
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  });
  return calls;
}

const STOP_RESULT = { rootId: "ses_A1", rejected: 1, aborted: ["ses_A1"], unconfirmed: [], durationMs: 12 };

describe("clients 1.1 : arrêt de la conversation", () => {
  it("route d'arrêt de l'arbre : StopResult rendu, aucun arrêt par le proxy", async (t) => {
    const calls = spyFetch(t, [{ status: 200, body: STOP_RESULT }]);
    assert.deepEqual(await stopConversation("ses_A1", "/w/projet"), STOP_RESULT);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.url, "/api/conversations/ses_A1/stop");
    assert.equal(calls[0]?.headers["x-cockpit-csrf"], "1");
  });

  it("404 (racine non suivie ou route absente) : repli sur l'arrêt 1.0.4 par le proxy", async (t) => {
    const calls = spyFetch(t, [{ status: 404, body: { error: "not-found", message: "Route inconnue." } }, { status: 200, body: true }]);
    assert.equal(await stopConversation("ses_A1", "/w/projet"), null);
    assert.deepEqual(
      calls.map((c) => [c.method, c.url]),
      [
        ["POST", "/api/conversations/ses_A1/stop"],
        ["POST", "/api/oc/session/ses_A1/abort?directory=%2Fw%2Fprojet"],
      ],
    );
  });

  for (const reply of [{ status: 403, body: { error: "csrf" } }, { status: 409, body: { error: "x" } }, { status: 500 }, "network"] as Reply[]) {
    it(`autre échec (${reply === "network" ? "réseau" : reply.status}) : erreur rendue, aucun repli`, async (t) => {
      const calls = spyFetch(t, [reply, { status: 200, body: true }]);
      await assert.rejects(stopConversation("ses_A1", "/w/projet"), ApiError);
      assert.equal(calls.length, 1);
    });
  }

  it("identifiants encodés dans l'adresse", async (t) => {
    const calls = spyFetch(t, [{ status: 200, body: {} }]);
    await conversationApi.delegationDetails("ses/1", "per 2");
    assert.equal(calls[0]?.url, "/api/conversations/ses%2F1/delegations/per%202");
    assert.equal(calls[0]?.method, "GET");
    assert.equal(calls[0]?.headers["x-cockpit-csrf"], undefined);
  });
});

describe("clients 1.1 : activité, autonomie, plans, Diagnostic", () => {
  it("adresses et méthodes", async (t) => {
    const calls = spyFetch(t, [{ status: 200, body: {} }]);
    await activityApi.activity("ses_A1");
    await activityApi.facts("ses_A1", 1_700_000_000_000);
    await activityApi.affichage("ses_A1");
    await autonomyApi.get("ses_A1");
    await diagnostic11Api.activite();
    assert.deepEqual(
      calls.map((c) => [c.method, c.url]),
      [
        ["GET", "/api/conversations/ses_A1/activity"],
        ["GET", "/api/conversations/ses_A1/facts?since=1700000000000"],
        ["POST", "/api/conversations/ses_A1/facts/affichage"],
        ["GET", "/api/conversations/ses_A1/autonomie"],
        ["GET", "/api/diagnostic/activite"],
      ],
    );
  });

  it("x-cockpit-confirm seulement quand la confirmation est demandée", async (t) => {
    const calls = spyFetch(t, [{ status: 200, body: {} }]);
    await autonomyApi.put("ses_A1", { choix: "demander" });
    await autonomyApi.put("ses_A1", { choix: "autonome", plafonds: { plafondUsd: 1 } }, { confirm: true });
    await planApi.create("/w/projet");
    await planApi.create("/w/projet", { source: "ses_O1" });
    await planApi.create("/w/projet", { confirm: true, source: undefined });
    await planApi.execute("ses_P1", { choix: "modifications" });
    await planApi.execute("ses_P1", { choix: "autonome" }, { confirm: true });
    assert.deepEqual(
      calls.map((c) => [c.method, c.url, c.headers["x-cockpit-confirm"] ?? null, c.body]),
      [
        ["PUT", "/api/conversations/ses_A1/autonomie", null, { choix: "demander" }],
        ["PUT", "/api/conversations/ses_A1/autonomie", "1", { choix: "autonome", plafonds: { plafondUsd: 1 } }],
        ["POST", "/api/plans", null, { directory: "/w/projet" }],
        // Conversation d'origine (train it1 V3) : dans le corps seulement quand elle existe.
        ["POST", "/api/plans", null, { directory: "/w/projet", source: "ses_O1" }],
        ["POST", "/api/plans", "1", { directory: "/w/projet" }],
        ["POST", "/api/plans/ses_P1/execution", null, { choix: "modifications" }],
        ["POST", "/api/plans/ses_P1/execution", "1", { choix: "autonome" }],
      ],
    );
    for (const call of calls) assert.equal(call.headers["x-cockpit-csrf"], "1");
  });

  it("autonomyError : codes d'autonomie seulement, raison reprise", async (t) => {
    spyFetch(t, [{ status: 409, body: { error: "autonomie-indisponible", message: "Pas encore disponible dans cette version du cockpit.", raison: "a-venir" } }]);
    const err = await autonomyApi.put("ses_A1", { choix: "autonome" }, { confirm: true }).catch((e: unknown) => e);
    assert.deepEqual(autonomyError(err), {
      status: 409,
      error: "autonomie-indisponible",
      message: "Pas encore disponible dans cette version du cockpit.",
      raison: "a-venir",
    });
    assert.deepEqual(autonomyError(new ApiError(428, "confirmation-requise", "Confirmez.")), { status: 428, error: "confirmation-requise", message: "Confirmez." });
    assert.equal(autonomyError(new ApiError(409, "budget-guard", "Budget.")), null);
    assert.equal(autonomyError(new Error("autonomie-coupee")), null);
  });
});
