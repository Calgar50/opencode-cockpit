// Tests T4 de bout en bout (plan d'exécution it4 §4.1.6, §2.3 ; D-eq-04 à D-eq-06) sur le harnais du cockpit : sans `equipes`, le
// comportement 1.1 ; avec tous les squelettes, les mêmes réponses ; garde de rechargement composée (réalignement, installation,
// redémarrage) lue par le prédicat du harnais comme par main.ts ; verrou des Archives avant la purge ; verrou du proxy avant la
// lecture du corps et avant toute demande comptée en vol ; arrêt décoré (route 1.1 et crochet abort) ; client web des routes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { AssistantService } from "./assistants.ts";
import type { ConfigWriteQueue } from "./config-queue.ts";
import { PortUnavailableError, type StopTreePort } from "./contracts-11.ts";
import type { TeamProxyGuardRequest, TeamRunnerPort } from "./contracts-eq.ts";
import type { AppDeps } from "./http.ts";
import { registerAiRoutes, registerAssistantRoutes } from "./routes-assistants.ts";
import { MESSAGES } from "./shared/assistant-rules.ts";
import type { StopCause, StopResult } from "./shared/cockpit-event-types.ts";
import type { StudioService } from "./studio.ts";
import { neutralGuards } from "./team-run-guards.ts";
import { neutralRunner } from "./team-runner.ts";
import { type CockpitHarness, type CockpitHarnessOptions, startCockpit } from "./test-support/cockpit-harness.ts";
import type { FakeSession } from "./test-support/fake-opencode.ts";
import { until } from "./test-support/helpers.ts";
import type { TierService } from "./tiers.ts";

/** Routes des assistants et des niveaux d'IA (celles de main.ts), montées sur le harnais. */
const assistantRoutes: CockpitHarnessOptions["deps"] = (base: AppDeps) => {
  const routeDeps = { assistants: base.assistants as AssistantService, tiers: base.tiers as TierService, settings: base.settings, hub: base.hub, log: base.log };
  return { routes: [(app) => registerAssistantRoutes(app, routeDeps), (app) => registerAiRoutes(app, routeDeps)] };
};

/** Conversation créée par le proxy, suivie par le cockpit. */
async function trackedRoot(h: CockpitHarness, title: string): Promise<FakeSession> {
  const created = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title } });
  assert.equal(created.status, 200, created.body);
  const session = created.json<FakeSession>();
  await until(() => h.sessions.get(session.id));
  return session;
}

/** Conversation archivée avec un lancement d'équipe : texte envoyé à une étape, extrait et précisions (purgés à la suppression). */
function seedTeamConversation(h: CockpitHarness, rootId: string): void {
  h.db.prepare("INSERT INTO conversations (session_id, created_at, updated_at) VALUES (?, 1, 1)").run(rootId);
  h.db
    .prepare(
      `INSERT INTO team_runs (id, team_titre, flow, flow_sha256, root_session_id, directory, state, precisions, created_at)
       VALUES (?, 'Revue SQL', '{"version":1,"blocs":[]}', 'f0', ?, '/workspace', 'en-cours', '["Voir la table des factures"]', 1)`,
    )
    .run(`run-${rootId}`, rootId);
  h.db
    .prepare(
      `INSERT INTO team_run_steps (run_id, step_id, ordre, bloc_index, titre, agent, state, message_text, result_excerpt)
       VALUES (?, 'exactitude', 1, 0, 'Exactitude', 'relire-requete-sql', 'terminee', 'Consigne envoyée à l''étape', 'Deux jointures à revoir')`,
    )
    .run(`run-${rootId}`);
}

const teamTexts = (h: CockpitHarness, rootId: string) => ({
  conversation: { ...(h.db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE session_id = ?").get(rootId) as { n: number }) },
  step: { ...(h.db.prepare("SELECT message_text, result_excerpt FROM team_run_steps WHERE run_id = ?").get(`run-${rootId}`) as Record<string, unknown>) },
  run: { ...(h.db.prepare("SELECT precisions FROM team_runs WHERE id = ?").get(`run-${rootId}`) as Record<string, unknown>) },
});

const locked = (message: string) =>
  new Response(JSON.stringify({ error: "equipe-en-cours", message }), { status: 409, headers: { "content-type": "application/json" } });

describe("équipes (T4) : harnais sans équipes et squelettes", () => {
  it("harnais sans `equipes` : aucun module, aucune inscription ; stopTree, reloadBusy et routes comme en 1.1", async (t) => {
    const h = await startCockpit(t);
    assert.deepEqual(h.cockpit.equipes.modules, []);
    assert.deepEqual(h.cockpit.equipes.registrations, []);
    assert.equal(h.cockpit.c11.reloadBusy(), false);
    await assert.rejects(h.cockpit.c11.ports.stopTree.run("ses_x", "vous"), PortUnavailableError);
    assert.equal(h.cockpit.equipes.eq.simpleOuvertes, false);
    for (const [method, url] of [
      ["GET", "/api/teams"],
      ["GET", "/api/team-runs?rootId=ses_x"],
      ["GET", "/api/agent-map?directory=/workspace"],
    ]) {
      assert.equal((await h.call(method ?? "", url ?? "", { headers: h.headers.authed })).status, 404, url);
    }
  });

  it("tous les modules squelettes = mêmes réponses que sans eux : routes d'équipe absentes, proxy, suppression aux Archives, arrêt, garde", async (t) => {
    const scenario = async (h: CockpitHarness) => {
      const out: unknown[] = [];
      for (const [method, url, body] of [
        ["GET", "/api/teams", undefined],
        ["POST", "/api/teams/preview", {}],
        ["POST", "/api/team-runs/00000000-0000-4000-8000-000000000000/stop", {}],
        ["GET", "/api/agent-map?directory=/workspace", undefined],
      ] as const) {
        const res = await h.call(method, url, { headers: h.headers.mutating, ...(body === undefined ? {} : { body }) });
        out.push([url, res.status]);
      }
      const root = await trackedRoot(h, "Squelettes");
      const list = await h.call("GET", "/api/oc/session", { headers: h.headers.authed });
      out.push(["liste", list.status, list.json<FakeSession[]>().some((s) => s.id === root.id)]);
      const bad = await h.call("POST", `/api/oc/session/${root.id}/prompt_async`, { headers: { ...h.headers.mutating, "content-type": "application/json" }, body: "{pas du json" });
      out.push(["corps invalide", bad.status, bad.json<{ error: string }>().error]);
      seedTeamConversation(h, "ses_archivee");
      const removed = await h.call("DELETE", "/api/archive/ses_archivee", { headers: h.headers.mutating });
      out.push(["archive", removed.status, removed.json(), teamTexts(h, "ses_archivee")]);
      const invalid = await h.call("DELETE", "/api/archive/ses.point", { headers: h.headers.mutating });
      out.push(["archive invalide", invalid.status, invalid.json()]);
      out.push(["reloadBusy", h.cockpit.c11.reloadBusy()]);
      await assert.rejects(h.cockpit.c11.ports.stopTree.run(root.id, "vous"), PortUnavailableError);
      return out;
    };
    const bare = await scenario(await startCockpit(t));
    const all = await startCockpit(t, { equipes: "tous" });
    assert.deepEqual(all.cockpit.equipes.modules, ["agentMap", "teams", "teamPreflight", "teamRunner", "teamGuards"]);
    assert.deepEqual(await scenario(all), bare);
    assert.deepEqual(
      bare.find((entry) => Array.isArray(entry) && entry[0] === "archive"),
      ["archive", 200, { deleted: true }, { conversation: { n: 0 }, step: { message_text: null, result_excerpt: null }, run: { precisions: "[]" } }],
      "sans équipes : suppression et purge de la 1.1",
    );
    all.assertNoGlobalRestart();
  });
});

describe("équipes (T4) : garde de rechargement composée (D-eq-06)", () => {
  const withRunner = (t: TestContext, stepsBusy: () => boolean) =>
    startCockpit(t, { deps: assistantRoutes, equipes: ["teamRunner"], eqPorts: { runner: { ...neutralRunner(), stepsBusy } } });

  const routes = async (h: CockpitHarness) => {
    const realign = await h.call("POST", "/api/ai/realign", { headers: h.headers.confirmed, body: {} });
    const install = await h.call("POST", "/api/assistants/catalogue/analyser-incident/install", { headers: h.headers.mutating, body: {} });
    const restart = await h.call("POST", "/api/system/restart-opencode", { headers: h.headers.mutating });
    return { realign, install, restart };
  };

  it("étapes en cours (runner.stepsBusy) → 409 : réalignement par la garde propre d'AssistantService (prédicat du harnais, comme main.ts), installation, redémarrage", async (t) => {
    const h = await withRunner(t, () => true);
    assert.equal(h.cockpit.c11.reloadBusy(), true);
    const { realign, install, restart } = await routes(h);
    assert.equal(realign.status, 409, realign.body);
    assert.deepEqual(realign.json(), { error: "sessions-busy", message: MESSAGES.sessionsBusy });
    const busy = { error: "sessions-busy", message: MESSAGES.reloadBusy, override: false };
    assert.equal(install.status, 409, install.body);
    assert.deepEqual(install.json(), busy);
    assert.equal(restart.status, 409, restart.body);
    assert.deepEqual(restart.json(), busy);
    h.assertNoGlobalRestart();
    // main.ts n'est pas modifié : il lit toujours cockpit.c11.reloadBusy() au moment de l'appel.
    const main = fs.readFileSync(path.join(import.meta.dirname, "main.ts"), "utf8");
    assert.match(main, /reloadBusy = \(\) => cockpit\.c11\.reloadBusy\(\);/);
  });

  it("stepsBusy faux : réponses inchangées (mêmes codes que le harnais sans équipes, réalignement et installation faits)", async (t) => {
    // Studio simulé complet (lecture des fichiers d'agents) : le réalignement et l'installation vont jusqu'au bout. Même prédicat
    // de garde que le harnais et main.ts : c11.reloadBusy() lu au moment de l'appel.
    const saved = new Map<string, unknown>();
    const studio = {
      save: async (kind: string, _scope: unknown, input: { name: string; frontmatter: Record<string, unknown> }) => {
        const item = {
          kind,
          name: input.name,
          scope: "global",
          project: null,
          file: `${kind}/${input.name}.md`,
          frontmatter: input.frontmatter,
          body: "x",
          error: null,
          files: [],
          updatedAt: Date.now(),
        };
        saved.set(`${kind}/${input.name}`, item);
        return item;
      },
      remove: async () => true,
      get: async (kind: string, name: string) => saved.get(`${kind}/${name}`) ?? null,
      list: async (kind: string) => [...saved.values()].filter((item) => (item as { kind: string }).kind === kind),
      applyModels: async (_plan: unknown[], beforeWrite?: () => Promise<void>) => void (await beforeWrite?.()),
      ensureClassifierAgent: async () => undefined,
    } as unknown as StudioService;
    const start = async (options: CockpitHarnessOptions) => {
      const ref: { h?: CockpitHarness } = {};
      const h = await startCockpit(t, {
        ...options,
        deps: (base) => {
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
            queue: base.configQueue as ConfigWriteQueue,
            reloadBusy: () => ref.h?.cockpit.c11.reloadBusy() ?? false,
          });
          const routeDeps = { assistants, tiers: base.tiers as TierService, settings: base.settings, hub: base.hub, log: base.log };
          return { studio, assistants, routes: [(app) => registerAssistantRoutes(app, routeDeps), (app) => registerAiRoutes(app, routeDeps)] };
        },
      });
      ref.h = h;
      return h;
    };
    const summary = async (h: CockpitHarness) => {
      const { realign, install, restart } = await routes(h);
      return [realign.status, install.status, restart.status];
    };
    const idle = await summary(await start({ equipes: ["teamRunner"], eqPorts: { runner: { ...neutralRunner(), stepsBusy: () => false } } }));
    const bare = await summary(await start({}));
    assert.deepEqual(idle, bare);
    assert.deepEqual(idle, [200, 200, 200]);
  });
});

describe("équipes (T4) : verrou des Archives et du proxy (D-eq-04)", () => {
  it("DELETE /api/archive/:id : verrou qui refuse → 409 rendu tel quel, aucune purge (textes d'équipe intacts) ; identifiant invalide : verrou non appelé", async (t) => {
    const seen: TeamProxyGuardRequest[] = [];
    const h = await startCockpit(t, {
      equipes: ["teamGuards"],
      eqPorts: {
        guards: {
          ...neutralGuards(),
          proxyGuard: async (req) => {
            seen.push(req);
            return req.entree === "archive" && req.sessionId === "ses_equipe" ? locked("Une équipe travaille dans cette conversation.") : null;
          },
        },
      },
    });
    seedTeamConversation(h, "ses_equipe");
    const refused = await h.call("DELETE", "/api/archive/ses_equipe", { headers: h.headers.mutating });
    assert.equal(refused.status, 409, refused.body);
    assert.deepEqual(refused.json(), { error: "equipe-en-cours", message: "Une équipe travaille dans cette conversation." });
    assert.deepEqual(seen, [{ entree: "archive", method: "DELETE", sub: "", directory: null, sessionId: "ses_equipe", permissionId: null }]);
    assert.deepEqual(teamTexts(h, "ses_equipe"), {
      conversation: { n: 1 },
      step: { message_text: "Consigne envoyée à l'étape", result_excerpt: "Deux jointures à revoir" },
      run: { precisions: '["Voir la table des factures"]' },
    });
    assert.equal(h.cockpitEvents().some((e) => e.type === "conversation.deleted"), false);

    // Verrou qui laisse passer : suppression et purge comme avant.
    seedTeamConversation(h, "ses_libre");
    const removed = await h.call("DELETE", "/api/archive/ses_libre", { headers: h.headers.mutating });
    assert.deepEqual([removed.status, removed.json()], [200, { deleted: true }]);
    assert.deepEqual(teamTexts(h, "ses_libre").step, { message_text: null, result_excerpt: null });

    // Identifiant refusé par shared/ids.ts : verrou non appelé, la route répond comme avant ; autres méthodes non gardées.
    seen.length = 0;
    const invalid = await h.call("DELETE", "/api/archive/ses.point", { headers: h.headers.mutating });
    assert.deepEqual([invalid.status, invalid.json()], [200, { deleted: false }]);
    assert.equal((await h.call("GET", "/api/archive/ses_equipe", { headers: h.headers.authed })).status, 200);
    assert.deepEqual(seen, []);
    // CSRF toujours exigé avant le verrou.
    assert.equal((await h.call("DELETE", "/api/archive/ses_equipe", { headers: h.headers.authed })).status, 403);
    assert.deepEqual(seen, []);
  });

  it("proxy : verrou en tête, avant la lecture du corps et avant toute demande comptée en vol ; identifiants et dossier transmis ; absent → 1.1", async (t) => {
    const seen: TeamProxyGuardRequest[] = [];
    const lockedRoots = new Set<string>();
    const h = await startCockpit(t, {
      equipes: ["teamGuards"],
      eqPorts: {
        guards: {
          ...neutralGuards(),
          proxyGuard: async (req) => {
            seen.push(req);
            return req.sessionId !== null && lockedRoots.has(req.sessionId) ? locked("L'équipe travaille : attendez la fin ou arrêtez-la.") : null;
          },
        },
      },
    });
    const root = await trackedRoot(h, "Verrou");
    assert.deepEqual(seen.at(-1), { entree: "proxy", method: "POST", sub: "/session", directory: null, sessionId: null, permissionId: null });
    lockedRoots.add(root.id);

    const before = h.fake.requests.length;
    const send = await h.call("POST", `/api/oc/session/${root.id}/prompt_async?directory=/workspace`, {
      headers: { ...h.headers.mutating, "content-type": "application/json" },
      body: "{pas du json",
    });
    assert.equal(send.status, 409, send.body);
    assert.equal(send.json<{ error: string }>().error, "equipe-en-cours", "refusé avant la lecture du corps (sinon 400 invalid-json)");
    assert.deepEqual(seen.at(-1), {
      entree: "proxy",
      method: "POST",
      sub: `/session/${root.id}/prompt_async`,
      directory: "/workspace",
      sessionId: root.id,
      permissionId: null,
    });
    const removed = await h.call("DELETE", `/api/oc/session/${root.id}`, { headers: h.headers.mutating });
    assert.equal(removed.status, 409, removed.body);
    assert.deepEqual(h.fake.requests.slice(before), [], "rien n'est relayé à opencode");
    assert.equal(h.deps.configQueue?.billedInFlight, 0, "aucune demande comptée en vol");

    // Dossier hors du workspace : null pour le verrou, puis 403 de la route comme avant ; réponse d'autorisation : son identifiant.
    const outside = await h.call("POST", "/api/oc/session/ses_autre/prompt_async?directory=/etc", { headers: h.headers.mutating, body: { parts: [] } });
    assert.equal(outside.status, 403, outside.body);
    assert.equal(seen.at(-1)?.directory, null);
    await h.call("POST", "/api/oc/permission/per_1/reply", { headers: h.headers.mutating, body: { reply: "reject" } });
    assert.deepEqual([seen.at(-1)?.permissionId, seen.at(-1)?.sessionId], ["per_1", null]);
    // Route hors liste blanche : 404 avant le verrou, comme avant.
    const count = seen.length;
    assert.equal((await h.call("POST", "/api/oc/global/dispose", { headers: h.headers.mutating, body: {} })).status, 404);
    assert.equal(seen.length, count);

    // Sans le module teamGuards : le corps invalide est lu et refusé par la 1.1 (400).
    const bare = await startCockpit(t, { equipes: ["teamRunner"] });
    const bareRoot = await trackedRoot(bare, "Sans verrou");
    const invalid = await bare.call("POST", `/api/oc/session/${bareRoot.id}/prompt_async`, {
      headers: { ...bare.headers.mutating, "content-type": "application/json" },
      body: "{pas du json",
    });
    assert.deepEqual([invalid.status, invalid.json<{ error: string }>().error], [400, "invalid-json"]);
    h.assertNoGlobalRestart();
  });
});

describe("équipes (T4) : arrêt décoré (D-eq-05)", () => {
  it("route 1.1 et crochet abort : runner prévenu avant puis après l'arrêt interne, seulement avec teamGuards", async (t) => {
    const trace: string[] = [];
    const inner: StopTreePort = {
      run: async (rootId, cause) => {
        trace.push(`arrêt ${cause}`);
        return { rootId, rejected: 0, aborted: [rootId], unconfirmed: [], durationMs: 1 };
      },
    };
    const runner: TeamRunnerPort = {
      ...neutralRunner(),
      stopRequested: (_rootId: string, cause: StopCause) => void trace.push(`stopRequested ${cause}`),
      stopped: (_rootId: string, cause: StopCause, result: StopResult | null) => void trace.push(`stopped ${cause} ${result?.aborted.length ?? "null"}`),
    };
    const h = await startCockpit(t, { modules: ["stopTree"], ports: { stopTree: inner }, equipes: ["teamGuards"], eqPorts: { runner } });
    const root = await trackedRoot(h, "Arrêt");
    const stop = await h.call("POST", `/api/conversations/${root.id}/stop`, { headers: h.headers.mutating });
    assert.equal(stop.status, 200, stop.body);
    assert.deepEqual(trace, ["stopRequested vous", "arrêt vous", "stopped vous 1"]);
    trace.length = 0;
    const abort = await h.call("POST", `/api/oc/session/${root.id}/abort`, { headers: h.headers.mutating });
    assert.equal(abort.status, 200, abort.body);
    assert.deepEqual(trace, ["stopRequested vous", "arrêt vous", "stopped vous 1"]);

    trace.length = 0;
    const bare = await startCockpit(t, { modules: ["stopTree"], ports: { stopTree: inner }, equipes: ["teamRunner"], eqPorts: { runner } });
    const bareRoot = await trackedRoot(bare, "Arrêt sans équipes");
    assert.equal((await bare.call("POST", `/api/conversations/${bareRoot.id}/stop`, { headers: bare.headers.mutating })).status, 200);
    assert.deepEqual(trace, ["arrêt vous"]);
  });
});

describe("équipes (T4) : client web des routes (api-teams.ts)", () => {
  it("chaque route des groupes teams et team-runs a sa fonction ; ni carte, ni proxy, ni Archives, ni /activity ; mutations par l'aide http", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "..", "web", "lib", "api-teams.ts"), "utf8");
    const methods: Record<string, string> = { get: "GET", post: "POST", put: "PUT", del: "DELETE" };
    const calls = [...source.matchAll(/http\.(get|post|put|del)<[^>]*>\(\s*[`"]([^`"]+)[`"]/g)].map((m) => {
      const url = (m[2] ?? "").replace(/\$\{enc\((\w+)\)\}/g, ":$1").replace(/\$\{query\(\{ (\w+) \}\)\}/g, "?$1=");
      return `${methods[m[1] ?? ""]} ${url}`;
    });
    assert.deepEqual([...calls].sort(), [
      "DELETE /api/teams/:id",
      "GET /api/team-runs/:runId",
      "GET /api/team-runs?rootId=",
      "GET /api/team-runs?sessionId=",
      "GET /api/teams",
      "POST /api/team-runs/:runId/ajouter-resultats",
      "POST /api/team-runs/:runId/continue",
      "POST /api/team-runs/:runId/estimate",
      "POST /api/team-runs/:runId/fermer",
      "POST /api/team-runs/:runId/relancer",
      "POST /api/team-runs/:runId/stop",
      "POST /api/teams/:id/estimate",
      "POST /api/teams/:id/run",
      "POST /api/teams/examples/:id/install",
      "POST /api/teams/preview",
      "PUT /api/teams/:id",
    ]);
    for (const excluded of ["/api/agent-map", "/api/oc/", "/api/archive", "/activity"]) {
      assert.equal(
        calls.some((call) => call.includes(excluded)),
        false,
        excluded,
      );
    }
    assert.equal(/\bfetch\(/.test(source), false, "CSRF, confirmation et erreurs par l'aide http de web/lib/api.ts");
    assert.match(source, /\/relancer`, body, \{ confirm: true \}\)/, "relance toujours confirmée");
  });
});
