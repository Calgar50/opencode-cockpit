// Tests L3, service du plancher de conversation (spécification §3.4, §3.9, §3.14 l.441, D5, D-04 ; plan fiche L3) sur le harnais
// du cockpit (module « floors » déclaré) et le faux opencode : plancher CONVERSATION ajouté par le serveur à POST /api/oc/session et
// vérifié sur l'écho (marque SHA-256), écart → DELETE + 502 plancher-non-verifie, « permission » toujours refusée dans le corps du
// client, PATCH puis vérification avant le premier envoi d'une ancienne conversation, ports verified et createWithFloor, outils
// retirés conformes à M2 (toolsFor du faux), héritage des refus de clés par un enfant (F-f).
// Écarts provoqués par un client opencode qui altère les réponses (TamperingClient) : le faux reste fidèle à opencode 1.18.30.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { describe, it, type TestContext } from "node:test";
import { type FloorSessionBody, PortUnavailableError, type ProxyContext } from "./contracts-11.ts";
import { OpencodeClient } from "./opencode.ts";
import { FLOOR_ERROR, FLOOR_TIMEOUT_MS, FloorNotVerifiedError, floorHash, SessionFloorService } from "./session-floor-service.ts";
import { evaluate, type Rule } from "./shared/assistant-rules.ts";
import { TEXTES } from "./shared/floor-texts.ts";
import { buildFloor } from "./shared/session-floors.ts";
import { type CockpitHarness, type CockpitHarnessOptions, startCockpit } from "./test-support/cockpit-harness.ts";
import type { FakeSession, FakeToolScript } from "./test-support/fake-opencode.ts";
import { promptAsync, until, within } from "./test-support/helpers.ts";

const MODEL = { providerID: "github-copilot", modelID: "gpt-5-mini" };
const CONVERSATION = buildFloor("CONVERSATION");
const PLAN = buildFloor("PLAN");

interface M2Fixture {
  model: { providerID: string; modelID: string };
  configPermission: Record<string, unknown>;
  cases: Array<{ name: string; tools: string[] }>;
}
const m2 = JSON.parse(fs.readFileSync(new URL("./test-support/fixtures/m2-tools.json", import.meta.url), "utf8")) as M2Fixture;
const m2Tools = (name: string): string[] => {
  const found = m2.cases.find((c) => c.name === name);
  assert.ok(found, name);
  return found.tools;
};

/** `forward` relaie la requête au faux opencode ; ne pas l'appeler simule une réponse d'opencode sans que la requête lui parvienne. */
type Tamper = (method: string, pathname: string, forward: () => Promise<Response>) => Promise<Response>;

/** Client opencode qui peut intercepter une requête ou altérer sa réponse (écho d'opencode) : le proxy et le plancher la lisent. */
class TamperingClient extends OpencodeClient {
  tamper: Tamper | null = null;

  override raw(method: string, url: URL, init: Parameters<OpencodeClient["raw"]>[2] = {}): Promise<Response> {
    const forward = () => super.raw(method, url, init);
    return this.tamper ? this.tamper(method.toUpperCase(), url.pathname, forward) : forward();
  }
}

const jsonResponse = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Réécrit le corps JSON d'une réponse. */
async function rewrite(res: Response, edit: (body: Record<string, unknown>) => unknown): Promise<Response> {
  return jsonResponse(res.status, edit((await res.json()) as Record<string, unknown>));
}

/** Empreinte attendue, calculée sans le module : SHA-256 du tableau de règles en JSON, clés permission, pattern, action. */
const markOf = (code: string, floor: readonly Rule[]): string =>
  `${code}:${createHash("sha256")
    .update(JSON.stringify(floor.map(({ permission, pattern, action }) => ({ permission, pattern, action }))), "utf8")
    .digest("hex")}`;

async function harness(t: TestContext, options: CockpitHarnessOptions = {}): Promise<{ h: CockpitHarness; client: TamperingClient }> {
  let client: TamperingClient | null = null;
  const h = await startCockpit(t, {
    modules: ["floors"],
    ...options,
    deps: (base) => {
      client = new TamperingClient(base.env);
      return { client };
    },
  });
  assert.ok(client);
  return { h, client };
}

const requests = (h: CockpitHarness, method: string, pathname: string) => h.fake.requests.filter((r) => r.method === method && r.pathname === pathname);

async function createByProxy(h: CockpitHarness, title = "Plancher"): Promise<FakeSession> {
  const res = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title } });
  assert.equal(res.status, 200, res.body);
  return res.json<FakeSession>();
}

/** Conversation créée sans le cockpit (1.0.4, autre client) : aucune marque de plancher. */
const createDirect = (h: CockpitHarness, body: Record<string, unknown> = { title: "Ancienne" }) => h.deps.client.request<FakeSession>("POST", "/session", { body });

function send(h: CockpitHarness, sessionId: string, text = "Bonjour.") {
  return h.call("POST", `/api/oc/session/${sessionId}/prompt_async`, { headers: h.headers.mutating, body: { agent: "build", model: MODEL, parts: [{ type: "text", text }] } });
}

async function sendAndSettle(h: CockpitHarness, sessionId: string): Promise<void> {
  h.fake.script(sessionId, { text: "Réponse." });
  const res = await send(h, sessionId);
  assert.equal(res.status, 204, res.body);
  await within(h.fake.settled(sessionId), "réponse terminée");
}

/** Refus du plancher : 502 et code figé par D-04 (plan §4.5), écrit en toutes lettres. */
function assertRefused(res: { status: number; body: string; json<T>(): T }, message: string): void {
  assert.equal(res.status, 502, res.body);
  assert.deepEqual(res.json(), { error: "plancher-non-verifie", message });
  assert.equal(FLOOR_ERROR, "plancher-non-verifie");
}

const markIn = (h: CockpitHarness, sessionId: string) => h.sessions.get(sessionId)?.plancher ?? null;

describe("plancher : création par le proxy (§3.9 POST /api/oc/session)", () => {
  it("plancher CONVERSATION ajouté par le serveur, écho vérifié, marque SHA-256 ; outils de M2 (read gardé) ; verified()", async (t) => {
    const { h } = await harness(t);
    h.fake.globalConfig = { ...h.fake.globalConfig, permission: m2.configPermission };
    const session = await createByProxy(h, "Plancher");
    assert.deepEqual(requests(h, "POST", "/session").at(-1)?.body, { title: "Plancher", permission: CONVERSATION });
    assert.deepEqual(h.fake.session(session.id)?.permission, CONVERSATION);
    assert.deepEqual(session.permission, CONVERSATION, "réponse transmise telle quelle");
    assert.equal(markIn(h, session.id), markOf("conversation", CONVERSATION));
    assert.equal(markIn(h, session.id), `conversation:${floorHash("CONVERSATION")}`);
    const floors = h.cockpit.c11.ports.floors;
    assert.equal(await floors.verified(session.id), true);
    assert.equal(await floors.verified("ses_inconnue"), false);
    assert.equal(await floors.verified("../ses_x"), false);
    assert.deepEqual(h.fake.toolsFor(session.id, { modelID: m2.model.modelID, agent: "build" }), m2Tools("sans-regle"));
    // Envoi suivant : plancher déjà vérifié, aucun PATCH.
    await sendAndSettle(h, session.id);
    assert.equal(requests(h, "PATCH", `/session/${session.id}`).length, 0);
  });

  it("témoin sans le module : corps 1.0.4 (titre seul), aucune marque, aucun PATCH avant l'envoi, ports neutres", async (t) => {
    const h = await startCockpit(t);
    const session = await createByProxy(h, "Témoin");
    assert.deepEqual(requests(h, "POST", "/session").at(-1)?.body, { title: "Témoin" });
    assert.equal(markIn(h, session.id), null);
    await sendAndSettle(h, session.id);
    assert.equal(requests(h, "PATCH", `/session/${session.id}`).length, 0);
    assert.equal(await h.cockpit.c11.ports.floors.verified(session.id), false);
    await assert.rejects(h.cockpit.c11.ports.floors.createWithFloor("PLAN", { directory: h.fake.directory }), PortUnavailableError);
  });

  it("« permission » toujours refusée dans le corps du client : POST et PATCH 403 avant tout crochet, rien relayé", async (t) => {
    const { h } = await harness(t);
    const session = await createByProxy(h);
    const posts = requests(h, "POST", "/session").length;
    for (const permission of [[{ permission: "read", pattern: "*", action: "allow" }], CONVERSATION, []]) {
      const created = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title: "x", permission } });
      assert.equal(created.status, 403, created.body);
      assert.equal(created.json<{ error: string }>().error, "forbidden-body");
      const patched = await h.call("PATCH", `/api/oc/session/${session.id}`, { headers: h.headers.mutating, body: { permission } });
      assert.equal(patched.status, 403, patched.body);
    }
    assert.equal(requests(h, "POST", "/session").length, posts);
    assert.equal(requests(h, "PATCH", `/session/${session.id}`).length, 0);
    assert.deepEqual(h.fake.session(session.id)?.permission, CONVERSATION);
  });

  it("écart sur l'écho (plancher absent, autorisation avant, règle après, réordonné) → DELETE de la conversation et 502", async (t) => {
    const { h, client } = await harness(t);
    const variants: Array<[string, (permission: Rule[]) => unknown]> = [
      ["plancher absent", () => undefined],
      ["autorisation avant", (p) => [{ permission: "read", pattern: "*.env", action: "allow" }, ...p]],
      ["demande avant", (p) => [{ permission: "*", pattern: "*", action: "ask" }, ...p]],
      ["règle après", (p) => [...p, { permission: "read", pattern: "x", action: "deny" }]],
      ["réordonné", (p) => [...p].reverse()],
      ["tronqué", (p) => p.slice(0, -1)],
    ];
    for (const [name, edit] of variants) {
      let created: string | null = null;
      client.tamper = async (method, pathname, forward) =>
        method === "POST" && pathname === "/session"
          ? rewrite(await forward(), (body) => {
              created = String(body.id);
              const permission = edit(body.permission as Rule[]);
              if (permission === undefined) delete body.permission;
              else body.permission = permission;
              return body;
            })
          : forward();
      const res = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title: name } });
      client.tamper = null;
      assertRefused(res, TEXTES.partout.creationRefusee);
      assert.ok(created, name);
      const deleted = requests(h, "DELETE", `/session/${created}`);
      assert.equal(deleted.length, 1, name);
      assert.equal(deleted[0]?.query.directory, h.fake.directory, name);
      assert.equal(h.fake.session(created), undefined, `${name} : conversation supprimée`);
      assert.equal(markIn(h, created), null, name);
      assert.equal(await h.cockpit.c11.ports.floors.verified(created), false, name);
    }
    h.assertNoGlobalRestart();
  });

  it("suppression impossible → 502 « Conversation refusée » ; écho illisible → 502 sans DELETE ; vérification refaite avant chaque envoi", async (t) => {
    const { h, client } = await harness(t);
    let created: string | null = null;
    client.tamper = async (method, pathname, forward) => {
      if (method === "POST" && pathname === "/session")
        return rewrite(await forward(), (body) => {
          created = String(body.id);
          delete body.permission;
          return body;
        });
      if (method === "DELETE") return jsonResponse(500, { name: "UnknownError" });
      return forward();
    };
    const kept = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title: "Restée" } });
    assertRefused(kept, TEXTES.partout.creationRefuseeRestee);
    assert.ok(created);
    const id: string = created;
    assert.ok(h.fake.session(id), "la conversation est restée chez opencode");
    assert.equal(markIn(h, id), null);

    // Écho illisible : identifiant inconnu, rien à supprimer.
    const deletes = h.fake.requests.filter((r) => r.method === "DELETE").length;
    client.tamper = async (method, pathname, forward) => {
      const res = await forward();
      return method === "POST" && pathname === "/session" ? new Response("pas du JSON", { status: 200 }) : res;
    };
    const unreadable = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title: "Illisible" } });
    assertRefused(unreadable, TEXTES.partout.creationRefuseeRestee);
    assert.equal(h.fake.requests.filter((r) => r.method === "DELETE").length, deletes);

    // Conversation restée : le prochain envoi pose et vérifie le plancher avant de relayer (l'écho du PATCH est fidèle ici).
    client.tamper = null;
    await sendAndSettle(h, id);
    const patch = requests(h, "PATCH", `/session/${id}`);
    assert.equal(patch.length, 1);
    assert.equal(markIn(h, id), markOf("conversation", CONVERSATION));
  });
});

describe("plancher : avant un envoi facturé (§3.9 prompt_async, command, summarize)", () => {
  it("ancienne conversation : PATCH du plancher puis vérification AVANT le premier envoi ; marque posée ; envoi suivant sans PATCH", async (t) => {
    const { h } = await harness(t);
    const old = await createDirect(h);
    assert.equal(old.permission, undefined);
    await sendAndSettle(h, old.id);
    const routes = h.fake.requests.map((r) => `${r.method} ${r.pathname}`);
    const patchAt = routes.indexOf(`PATCH /session/${old.id}`);
    const promptAt = routes.indexOf(`POST /session/${old.id}/prompt_async`);
    assert.ok(patchAt >= 0 && promptAt > patchAt, "PATCH avant l'envoi");
    assert.deepEqual(h.fake.requests[patchAt]?.body, { permission: CONVERSATION });
    assert.deepEqual(h.fake.session(old.id)?.permission, CONVERSATION);
    assert.equal(markIn(h, old.id), markOf("conversation", CONVERSATION));
    assert.equal(await h.cockpit.c11.ports.floors.verified(old.id), true);
    await sendAndSettle(h, old.id);
    assert.equal(requests(h, "PATCH", `/session/${old.id}`).length, 1);

    // « Résumer » passe par le même crochet.
    const other = await createDirect(h, { title: "À résumer" });
    const summary = await h.call("POST", `/api/oc/session/${other.id}/summarize`, { headers: h.headers.mutating, body: MODEL });
    assert.equal(summary.status, 200, summary.body);
    const otherRoutes = h.fake.requests.map((r) => `${r.method} ${r.pathname}`);
    assert.ok(otherRoutes.indexOf(`PATCH /session/${other.id}`) < otherRoutes.indexOf(`POST /session/${other.id}/summarize`));
    await within(h.fake.settled(other.id), "résumé terminé");
    assert.equal(markIn(h, other.id), markOf("conversation", CONVERSATION));
  });

  it("conversation qui porte une autorisation : écart après PATCH → 502, message jamais relayé ni facturé, conversation gardée, refus répété", async (t) => {
    const { h } = await harness(t);
    const old = await createDirect(h, { title: "Permissive", permission: [{ permission: "read", pattern: "*.env", action: "allow" }] });
    for (const attempt of [1, 2]) {
      const res = await send(h, old.id);
      assertRefused(res, TEXTES.partout.envoiRefuseEcart);
      assert.equal(requests(h, "PATCH", `/session/${old.id}`).length, attempt, "vérification refaite à chaque envoi");
    }
    assert.equal(requests(h, "POST", `/session/${old.id}/prompt_async`).length, 0);
    assert.equal(h.fake.requests.filter((r) => r.method === "DELETE").length, 0, "une conversation existante n'est jamais supprimée");
    assert.ok(h.fake.session(old.id));
    assert.equal(markIn(h, old.id), null);
    assert.equal(await h.cockpit.c11.ports.floors.verified(old.id), false);
    assert.equal((h.db.prepare("SELECT COUNT(*) AS n FROM usage").get() as { n: number }).n, 0, "rien de facturé");
  });

  it("PATCH sans réponse valable d'opencode → 502 « Réessayez », rien relayé ; écho d'une autre session → écart ; retour d'opencode → envoi", async (t) => {
    const { h, client } = await harness(t);
    const old = await createDirect(h);
    client.tamper = async (method, _pathname, forward) => (method === "PATCH" ? jsonResponse(503, { name: "Indisponible" }) : forward());
    assertRefused(await send(h, old.id), TEXTES.partout.envoiRefuse);
    assert.equal(requests(h, "PATCH", `/session/${old.id}`).length, 0);
    client.tamper = async (method, _pathname, forward) => (method === "PATCH" ? rewrite(await forward(), (body) => ({ ...body, id: "ses_autre" })) : forward());
    assertRefused(await send(h, old.id), TEXTES.partout.envoiRefuseEcart);
    assert.equal(requests(h, "POST", `/session/${old.id}/prompt_async`).length, 0);
    assert.equal(markIn(h, old.id), null);
    client.tamper = null;
    await sendAndSettle(h, old.id);
    assert.equal(markIn(h, old.id), markOf("conversation", CONVERSATION));
  });

  it("marque périmée → PATCH du même genre (PLAN reste PLAN) ; marque illisible ou ETAPE → refus sans PATCH", async (t) => {
    const { h } = await harness(t);
    const session = await createByProxy(h);
    assert.equal(h.sessions.setPlancher(session.id, `plan:${"0".repeat(64)}`), true);
    await sendAndSettle(h, session.id);
    const patches = requests(h, "PATCH", `/session/${session.id}`);
    assert.equal(patches.length, 1);
    assert.deepEqual(patches[0]?.body, { permission: PLAN });
    assert.deepEqual(h.fake.session(session.id)?.permission, [...CONVERSATION, ...PLAN]);
    assert.equal(markIn(h, session.id), markOf("plan", PLAN));

    for (const mark of [`etape:${"a".repeat(64)}`, "illisible", `conversation:${"A".repeat(64)}`]) {
      h.sessions.setPlancher(session.id, mark);
      assertRefused(await send(h, session.id), TEXTES.partout.envoiRefuseEcart);
      assert.equal(requests(h, "PATCH", `/session/${session.id}`).length, 1, mark);
      assert.equal(await h.cockpit.c11.ports.floors.verified(session.id), false, mark);
    }
    assert.equal(requests(h, "POST", `/session/${session.id}/prompt_async`).length, 1);
  });

  it("deux envois simultanés sur une ancienne conversation : un seul PATCH ; session illisible : refus sans requête", async (t) => {
    const { h, client } = await harness(t);
    const old = await createDirect(h);
    client.tamper = async (method, _pathname, forward) => {
      if (method === "PATCH") await new Promise((resolve) => setTimeout(resolve, 80));
      return forward();
    };
    const service = new SessionFloorService({ client, sessions: h.sessions, projects: h.deps.projects, log: h.deps.log });
    const ctx = (sessionId: string | null) => ({ method: "POST", sub: `/session/${sessionId}/prompt_async`, directory: null, body: {}, sessionId }) as unknown as ProxyContext;
    assert.deepEqual(await Promise.all([service.beforeBilledSend(ctx(old.id)), service.beforeBilledSend(ctx(old.id))]), [null, null]);
    assert.equal(requests(h, "PATCH", `/session/${old.id}`).length, 1);
    assert.equal(await service.beforeBilledSend(ctx(old.id)), null);
    assert.equal(requests(h, "PATCH", `/session/${old.id}`).length, 1);
    const before = h.fake.requests.length;
    for (const sessionId of [null, "../ses_x"]) {
      const refused = await service.beforeBilledSend(ctx(sessionId));
      assert.equal(refused?.status, 502);
      assert.deepEqual(await refused?.json(), { error: FLOOR_ERROR, message: TEXTES.partout.envoiRefuseEcart });
    }
    assert.equal(h.fake.requests.length, before);
    assert.equal(FLOOR_TIMEOUT_MS, 15_000);
  });
});

describe("plancher : port createWithFloor (L6b, L11b) et héritage (§3.14 l.441)", () => {
  it("PLAN : corps reconstruit, écho vérifié, marque ; outils de M2 sur la racine et l'enfant general ; CONTROLE retire tout ; envoi sans PATCH", async (t) => {
    const { h } = await harness(t);
    h.fake.globalConfig = { ...h.fake.globalConfig, permission: m2.configPermission };
    const floors = h.cockpit.c11.ports.floors;
    const body = { directory: h.fake.directory, title: "Plan", metadata: { cockpit: "plan" }, permission: [{ permission: "*", pattern: "*", action: "allow" }], agent: "build" };
    const plan = await floors.createWithFloor("PLAN", body as FloorSessionBody);
    assert.deepEqual(requests(h, "POST", "/session").at(-1)?.body, { title: "Plan", metadata: { cockpit: "plan" }, permission: PLAN });
    assert.deepEqual(requests(h, "POST", "/session").at(-1)?.query, { directory: h.fake.directory });
    assert.deepEqual(h.fake.session(plan.id)?.permission, PLAN);
    assert.equal(markIn(h, plan.id), markOf("plan", PLAN));
    assert.equal(await floors.verified(plan.id), true);
    assert.deepEqual(h.fake.toolsFor(plan.id, { modelID: m2.model.modelID, agent: "build" }), m2Tools("racine-edit-bash-refuses"));

    h.fake.script(plan.id, {
      tools: [{ tool: "task", input: { description: "Lecture", prompt: "Lis a.txt.", subagent_type: "general" }, child: { agent: "general", text: "Résumé." } }],
      followUp: { text: "fin" },
    });
    assert.equal(await promptAsync(h.deps.client, plan.id, "Délègue.", { model: m2.model }), 204);
    await within(h.fake.settled(plan.id), "délégation terminée");
    const [child] = await h.deps.client.request<FakeSession[]>("GET", `/session/${plan.id}/children`);
    assert.ok(child);
    assert.deepEqual(h.fake.toolsFor(child.id), m2Tools("enfant-general"));

    const control = await floors.createWithFloor("CONTROLE", { directory: h.fake.directory, parentID: plan.id, title: "Contrôle", metadata: { cockpit: "controle" } });
    assert.deepEqual(h.fake.session(control.id)?.permission, [{ permission: "*", pattern: "*", action: "deny" }]);
    assert.deepEqual(h.fake.toolsFor(control.id, { modelID: m2.model.modelID, agent: "build" }), []);
    assert.equal(markIn(h, control.id), markOf("controle", buildFloor("CONTROLE")));
    await until(() => h.sessions.get(control.id)?.purpose === "controle");
    assert.equal(h.sessions.get(control.id)?.root_id, plan.id);

    const conversation = await floors.createWithFloor("CONVERSATION", { directory: h.fake.directory });
    assert.deepEqual(requests(h, "POST", "/session").at(-1)?.body, { permission: CONVERSATION });
    assert.equal(markIn(h, conversation.id), markOf("conversation", CONVERSATION));

    await sendAndSettle(h, plan.id);
    assert.equal(requests(h, "PATCH", `/session/${plan.id}`).length, 0);
  });

  it("refus avant tout envoi (ETAPE, dossier hors workspace, parent, titre ou metadata invalides) ; écart → DELETE et FloorNotVerifiedError", async (t) => {
    const { h, client } = await harness(t);
    const floors = h.cockpit.c11.ports.floors;
    const posts = () => requests(h, "POST", "/session").length;
    const before = posts();
    const invalid: Array<[string, FloorSessionBody, "ETAPE" | "PLAN"]> = [
      ["ETAPE", { directory: h.fake.directory }, "ETAPE"],
      ["dossier hors workspace", { directory: "/etc" }, "PLAN"],
      ["dossier absent", {} as FloorSessionBody, "PLAN"],
      ["parent invalide", { directory: h.fake.directory, parentID: "../ses_x" }, "PLAN"],
      ["titre invalide", { directory: h.fake.directory, title: 7 } as unknown as FloorSessionBody, "PLAN"],
      ["metadata invalide", { directory: h.fake.directory, metadata: [] } as unknown as FloorSessionBody, "PLAN"],
    ];
    for (const [name, body, kind] of invalid) await assert.rejects(floors.createWithFloor(kind, body), RangeError, name);
    assert.equal(posts(), before);

    let created: string | null = null;
    const stripEcho: Tamper = async (method, pathname, forward) =>
      method === "POST" && pathname === "/session"
        ? rewrite(await forward(), (body) => {
            created = String(body.id);
            return { ...body, permission: [...(body.permission as Rule[]), { permission: "edit", pattern: "*", action: "allow" }] };
          })
        : forward();
    client.tamper = stripEcho;
    await assert.rejects(floors.createWithFloor("PLAN", { directory: h.fake.directory }), (err: unknown) => {
      assert.ok(err instanceof FloorNotVerifiedError);
      assert.equal(err.code, FLOOR_ERROR);
      assert.equal(err.deleted, true);
      assert.equal(err.sessionId, created);
      return true;
    });
    assert.ok(created);
    assert.equal(requests(h, "DELETE", `/session/${created}`).length, 1);
    assert.equal(h.fake.session(created), undefined);

    const deletes = h.fake.requests.filter((r) => r.method === "DELETE").length;
    client.tamper = async (method, pathname, forward) => (method === "DELETE" ? jsonResponse(500, {}) : stripEcho(method, pathname, forward));
    await assert.rejects(floors.createWithFloor("CONTROLE", { directory: h.fake.directory }), (err: unknown) => err instanceof FloorNotVerifiedError && !err.deleted);
    client.tamper = null;
    assert.equal(h.fake.requests.filter((r) => r.method === "DELETE").length, deletes);
  });

  it("un enfant explore d'une conversation créée par le cockpit ne lit pas un fichier de clés, sans demande (F-f) ; témoin sans plancher : lu", async (t) => {
    const readKey = async (h: CockpitHarness): Promise<{ status: string; error?: string; asked: number }> => {
      const root = await createByProxy(h, "Exploration");
      const file = `${h.fake.directory}/secrets/cle.pfx`;
      // Règles de l'assistant explore (read autorisé), évaluées avant celles de la session enfant (F-d).
      const explore = h.fake.agents().find((agent) => agent.name === "explore");
      assert.ok(explore);
      assert.equal(evaluate(explore.permission, "read", file), "allow");
      const read: FakeToolScript = { tool: "read", input: { filePath: file }, ask: { permission: "read", patterns: [file] }, agentRules: explore.permission, output: "contenu" };
      h.fake.script(root.id, {
        tools: [{ tool: "task", input: { description: "Exploration", prompt: "Lis cle.pfx.", subagent_type: "explore" }, child: { agent: "explore", turn: { tools: [read], followUp: { text: "Lu." } } } }],
        followUp: { text: "fin" },
      });
      const res = await send(h, root.id, "Explore.");
      assert.equal(res.status, 204, res.body);
      await within(h.fake.settled(root.id), "exploration terminée");
      const [child] = await h.deps.client.request<FakeSession[]>("GET", `/session/${root.id}/children`);
      assert.ok(child);
      const part = h.fake
        .messages(child.id)
        .flatMap((message) => message.parts)
        .find((candidate) => candidate.type === "tool" && (candidate as { tool?: string }).tool === "read") as { state: { status: string; error?: string } } | undefined;
      assert.ok(part);
      const asked = h.fake.emitted.filter((wire) => "type" in wire.payload && wire.payload.type === "permission.asked" && wire.payload.properties.sessionID === child.id).length;
      return { status: part.state.status, ...(part.state.error ? { error: part.state.error } : {}), asked };
    };

    const { h } = await harness(t);
    const floored = await readKey(h);
    assert.equal(floored.status, "error");
    assert.match(floored.error ?? "", /specified a rule which prevents you/);
    assert.equal(floored.asked, 0);

    const temoin = await readKey(await startCockpit(t));
    assert.deepEqual(temoin, { status: "completed", asked: 0 });
  });
});
