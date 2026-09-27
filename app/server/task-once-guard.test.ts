// Tests L1d : garde du « task once », refus Simple et détails de délégation (spécification §3.14, §3.9, §6 l.1038, l.1048,
// l.1050, décision n° 4 ; plan d'exécution, fiche L1d, question Q5 ; mesure MX1 §3.5 : F-c, refus retenu).
// - 7 cas de refus en 409 delegation-refusee {message}, rien relayé, la demande reste en attente ;
// - T-L1-c : `bash` en attente + `task` en Simple, aucun refus avant la réponse au `bash` (votre autre demande n'est pas annulée) ;
//   aussi quand la demande voisine arrive après la lecture du portillon (edit 5 ms, bash 100 ms : course mesurée sur opencode réel) ;
// - IA `available: false` refusée (l.1050) ; parité « après votre accord » avec evaluate (l.1048) ;
// - choix « autonome » → aucun refus Simple ; repli M9 interne (désactivé par défaut) ; textes (Q5).
// M9 (l'IA continue seule, sans boucle, sur une IA Copilot réelle) : RECETTE EN ATTENTE (facturée, non autorisée). Sur le faux,
// le refus avec message est une CorrectedError : la boucle continue (tour de reprise joué).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { Cockpit11, ConversationAutonomyPort, EventDerivation, PermissionGate, ProxyContext, RequestsPort } from "./contracts-11.ts";
import { createLogger } from "./log.ts";
import type { OcGlobalEvent, OpencodeClient } from "./opencode.ts";
import { createPermissionGate } from "./permission-gate.ts";
import { SessionTracker } from "./sessions.ts";
import type { ActivityFact, DelegationDetailsView, DelegationRefusalCode } from "./shared/activity-types.ts";
import type { Rule, UiMode } from "./shared/assistant-rules.ts";
import type { AutonomyChoice, AutonomyRequestView, DelegationFacts } from "./shared/autonomy-types.ts";
import { avisSimple, avisSimpleEnAttente, erreurDetails, messageRefusSimple, refusDelegation, TEXTES, verificationImpossible } from "./shared/delegation-texts.ts";
import {
  COMPARED_PERMISSIONS,
  comparedRights,
  createTaskGuard,
  DelegationGoneError,
  delegationAccord,
  FILE_REFERENCE,
  GUARD_PROMPT_RISKS,
  guardRefusal,
  isInternalTarget,
  PROMPT_REFS_MAX,
  PROMPT_SCAN_MAX,
  promptRiskOf,
  readPermission,
  REPLI_ATTENTE_SIMPLE,
  SIMPLE_JOBS_MAX,
  SIMPLE_RETAINED_MAX,
  simpleRefusalApplies,
  taskGuardModuleWith,
  workspaceRefResolver,
} from "./task-once-guard.ts";
import { type CockpitHarness, startCockpit } from "./test-support/cockpit-harness.ts";
import {
  deriveChildRules,
  evaluateRules,
  type FakeAgent,
  type FakePermissionRequest,
  type FakeSession,
  type FakeToolScript,
  nativeAgents,
  type PermissionRule,
} from "./test-support/fake-opencode.ts";
import { bash, editTool, until, within } from "./test-support/helpers.ts";

const MODEL = { providerID: "github-copilot", modelID: "gpt-5-mini" };
const AVANCE = { ui: { mode: "avance" } };
const FIN = "Synthèse faite seule.";
/** Consigne sans aucun risque (ni @, ni !`, ni adresse, ni ~, ni .., ni chemin absolu). */
const PROMPT = "Lis le fichier des changements et résume-le en trois points.";
const REFUS = TEXTES.partout.refus;
const SERVER_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

// --- Aides ------------------------------------------------------------------------------------------------------------------------

interface TaskOptions {
  description?: string;
  prompt?: string;
  taskId?: string;
  agentRules?: PermissionRule[];
}

/** Appel `task` qui demande une autorisation (tool/task.ts : patterns = [subagent_type], metadata {description, subagent_type}). */
function task(agent: string, options: TaskOptions = {}): FakeToolScript {
  const description = options.description ?? `Déléguer à ${agent}`;
  return {
    tool: "task",
    input: { description, prompt: options.prompt ?? PROMPT, subagent_type: agent, ...(options.taskId === undefined ? {} : { task_id: options.taskId }) },
    ask: { permission: "task", patterns: [agent], metadata: { description, subagent_type: agent } },
    ...(options.agentRules ? { agentRules: options.agentRules } : {}),
    child: { agent, text: "Résumé du sous-agent." },
  };
}

async function conversation(h: CockpitHarness, title: string): Promise<FakeSession> {
  const created = await h.call("POST", "/api/oc/session", { headers: h.headers.mutating, body: { title } });
  assert.equal(created.status, 200, created.body);
  const session = created.json<FakeSession>();
  await until(() => h.sessions.get(session.id));
  return session;
}

async function send(h: CockpitHarness, session: FakeSession, tools: FakeToolScript[], headers: Record<string, string> = h.headers.mutating): Promise<void> {
  h.fake.script(session.id, { tools, followUp: { text: FIN } });
  const sent = await h.call("POST", `/api/oc/session/${session.id}/prompt_async`, {
    headers,
    body: { agent: "build", model: MODEL, parts: [{ type: "text", text: "Travaille." }] },
  });
  assert.equal(sent.status, 204, sent.body);
}

/** Les `count` demandes de la conversation, toutes en attente. */
async function pending(h: CockpitHarness, session: FakeSession, count: number): Promise<FakePermissionRequest[]> {
  return until(() => {
    const list = h.fake.pendingPermissions().filter((p) => p.sessionID === session.id);
    return list.length === count ? list : null;
  });
}

function byDescription(asked: readonly FakePermissionRequest[], description: string): FakePermissionRequest {
  const found = asked.find((p) => p.metadata.description === description);
  assert.ok(found, description);
  return found;
}

const repliesTo = (h: CockpitHarness, requestId: string) =>
  h.fake.requests.filter((r) => r.method === "POST" && r.pathname === `/permission/${requestId}/reply`).map((r) => r.body);

const once = (h: CockpitHarness, requestId: string, headers: Record<string, string> = h.headers.mutating) =>
  h.call("POST", `/api/oc/permission/${requestId}/reply`, { headers, body: { reply: "once" } });

/** « Autoriser une fois » refusé par la garde : 409 delegation-refusee {message}, rien relayé, la demande reste en attente. */
async function assertRefused(h: CockpitHarness, request: FakePermissionRequest, message: string, label = request.id): Promise<void> {
  const res = await once(h, request.id);
  assert.equal(res.status, 409, `${label} : ${res.body}`);
  assert.deepEqual(res.json(), { error: "delegation-refusee", message }, label);
  assert.deepEqual(repliesTo(h, request.id), [], `${label} : rien relayé à opencode`);
  assert.ok(
    h.fake.pendingPermissions().some((p) => p.id === request.id),
    `${label} : la demande d'autorisation reste en attente`,
  );
}

async function assertRelayed(h: CockpitHarness, request: FakePermissionRequest, label = request.id, headers?: Record<string, string>): Promise<void> {
  const res = await once(h, request.id, headers);
  assert.equal(res.status, 200, `${label} : ${res.body}`);
  assert.deepEqual(repliesTo(h, request.id), [{ reply: "once" }], label);
}

async function details(h: CockpitHarness, rootId: string, permissionId: string): Promise<DelegationDetailsView> {
  const res = await h.call("GET", `/api/conversations/${rootId}/delegations/${permissionId}`, { headers: h.headers.authed });
  assert.equal(res.status, 200, res.body);
  return res.json<DelegationDetailsView>();
}

async function flush(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** File des réponses libre : toute évaluation déjà commencée est terminée. */
async function queueIdle(gate: PermissionGate): Promise<void> {
  await flush();
  (await within(gate.acquire(), "file des réponses libre"))();
}

/** Attente d'accord enregistrée par la dérivation des faits (L4b) : la dérivation taskGuard a vu le même événement juste après. */
async function waitRow(h: CockpitHarness, permissionId: string): Promise<{ reply: string | null; replied_by: string | null }> {
  return until(
    () =>
      h.db.prepare("SELECT reply, replied_by FROM permission_waits WHERE permission_id = ?").get(permissionId) as
        | { reply: string | null; replied_by: string | null }
        | undefined,
  );
}

function toolState(h: CockpitHarness, sessionId: string, tool: string): { status?: string; error?: string } | undefined {
  const part = h.fake
    .messages(sessionId)
    .flatMap((m) => m.parts)
    .find((p) => p.type === "tool" && p.tool === tool);
  return part?.state as { status?: string; error?: string } | undefined;
}

const lastText = (h: CockpitHarness, sessionId: string): unknown =>
  h.fake
    .messages(sessionId)
    .flatMap((m) => m.parts)
    .findLast((p) => p.type === "text")?.text;

/** Portillon réel dont on peut remplacer une méthode (espion). */
function wrapGate(over: (real: PermissionGate) => Partial<PermissionGate>) {
  return (deps: Parameters<NonNullable<Parameters<typeof startCockpit>[1]>["gate"] & object>[0]): PermissionGate => {
    const real = createPermissionGate({ client: deps.client, db: deps.db, log: deps.log, hub: deps.hub, sessions: new SessionTracker(deps.db, deps.client) });
    return { ...real, ...over(real) };
  };
}

function choicePort(read: () => AutonomyChoice): ConversationAutonomyPort {
  return {
    get: async () => null,
    choiceOf: () => read(),
    put: async () => ({ ok: false, status: 409, error: "autonomie-indisponible", raison: null }),
  };
}

/** Générateur pseudo-aléatoire à graine fixe (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// --- Fonctions pures --------------------------------------------------------------------------------------------------------------

describe("L1d : consigne, cibles, refus et parité (fonctions pures)", () => {
  it("FILE_REFERENCE : même motif que http.ts (FILE_REGEX d'opencode 1.18.30)", () => {
    const source = fs.readFileSync(path.join(SERVER_DIR, "http.ts"), "utf8");
    const line = /const FILE_REFERENCE = \/(.+)\/g;/.exec(source);
    assert.ok(line, "FILE_REFERENCE introuvable dans http.ts");
    assert.equal(FILE_REFERENCE.source, line[1]);
    assert.equal(FILE_REFERENCE.flags, "g");
  });

  it("cibles internes : cockpit-*, compaction, title, summary ; jamais general ni explore", () => {
    for (const name of ["cockpit-classifier", "cockpit-controle", "cockpit-futur", "compaction", "title", "summary"]) assert.equal(isInternalTarget(name), true, name);
    for (const name of ["general", "explore", "build", "plan", "cockpitx", "titles", "mon-summary"]) assert.equal(isInternalTarget(name), false, name);
  });

  it("promptRiskOf : illisible, !`, adresse, @ qui résout (ou invérifiable), puis ~, .. et chemin absolu (D3 seulement), dans cet ordre", async () => {
    const files = new Map<string, boolean | null>([
      ["a.txt", true],
      ["dossier", true],
      ["absent.txt", false],
      ["general", false],
      ["~/.ssh/id_rsa", null],
    ]);
    const seen: string[] = [];
    const resolve = async (ref: string) => {
      seen.push(ref);
      return files.has(ref) ? (files.get(ref) ?? null) : false;
    };
    const cases: Array<[unknown, string | null]> = [
      [undefined, "illisible"],
      [42, "illisible"],
      ["x".repeat(PROMPT_SCAN_MAX + 1), "illisible"],
      [Array.from({ length: PROMPT_REFS_MAX + 1 }, (_, i) => `@f${i}`).join(" "), "illisible"],
      ["Lance !`ls` puis résume.", "commande"],
      ["Lance ! `ls` puis résume.", "commande"],
      ["Lis https://exemple.org/doc.", "url"],
      ["Voir www.exemple.org pour la doc.", "url"],
      ["Résume @a.txt.", "arobase-fichier"],
      ["Liste @dossier pour moi.", "arobase-fichier"],
      ["Lis @~/.ssh/id_rsa.", "arobase-fichier"],
      ["Résume @absent.txt et demande à @general.", null],
      ["Écris à moi@exemple.org, sans pièce jointe.", null],
      ["Regarde ~/notes.", "tilde"],
      ["Remonte dans ../autre.", "parent"],
      ["Lis /etc/hosts.", "chemin-absolu"],
      ["Lis C:\\Users\\x.", "chemin-absolu"],
      [PROMPT, null],
      ["Compare 1/2 et 3/4, puis a..b.", null],
    ];
    for (const [prompt, expected] of cases) assert.equal(await promptRiskOf(prompt, resolve), expected, String(prompt).slice(0, 60));
    // Les risques de la garde passent avant ceux de D3 ; @ et « ~ » ensemble : le @ résolu l'emporte.
    assert.equal(await promptRiskOf("Regarde ~/x et @a.txt.", resolve), "arobase-fichier");
    assert.equal(await promptRiskOf("Lis https://x.org et @a.txt.", resolve), "url");
    assert.ok(seen.includes("absent.txt") && seen.includes("general"), "chaque @ est vérifié");
    assert.deepEqual([...GUARD_PROMPT_RISKS].sort(), ["arobase-fichier", "commande", "illisible", "url"]);
  });

  it("guardRefusal : les 7 cas du §3.14, dans l'ordre de la spécification ; D3 seuls (~, .., absolu) ne refusent pas le « once »", () => {
    const facts: DelegationFacts = {
      target: { name: "general", mode: "subagent", internal: false },
      taskIdInTree: null,
      promptRisk: null,
      modelAllowed: true,
      guardAccepts: true,
      delegationsSoFar: 0,
      estimateUsd: 0.01,
      remainingUsd: 1,
    };
    const caps = { delegationsMax: 5, plafondUsd: 1 };
    const request = {} as never;
    const refusal = (over: Partial<DelegationFacts>, req: unknown = request) => guardRefusal({ request: req as never, facts: { ...facts, ...over }, caps });
    assert.equal(refusal({}), null);
    assert.equal(refusal({}, null), "demande-morte");
    assert.equal(refusal({ target: null }), "cible-refusee");
    assert.equal(refusal({ target: { name: "build", mode: "primary", internal: false } }), "cible-refusee");
    assert.equal(refusal({ target: { name: "cockpit-classifier", mode: "subagent", internal: true } }), "cible-refusee");
    assert.equal(refusal({ target: { name: "tout", mode: "all", internal: false } }), null);
    assert.equal(refusal({ taskIdInTree: false }), "task-id-hors-arbre");
    assert.equal(refusal({ taskIdInTree: true }), null);
    for (const risk of ["illisible", "commande", "url", "arobase-fichier"]) assert.equal(refusal({ promptRisk: risk }), "consigne-refusee", risk);
    for (const risk of ["tilde", "parent", "chemin-absolu"]) assert.equal(refusal({ promptRisk: risk }), null, risk);
    assert.equal(refusal({ modelAllowed: false }), "ia-refusee");
    assert.equal(refusal({ guardAccepts: false }), "budget-refuse");
    assert.equal(refusal({ delegationsSoFar: 5 }), "plafond-atteint");
    assert.equal(refusal({ delegationsSoFar: 4 }), null);
    assert.equal(refusal({ remainingUsd: 0 }), "plafond-atteint");
    assert.equal(refusal({ remainingUsd: 0.0001 }), null);
    // Ordre : le premier cas l'emporte.
    const all: Partial<DelegationFacts> = { target: null, taskIdInTree: false, promptRisk: "url", modelAllowed: false, guardAccepts: false, delegationsSoFar: 9, remainingUsd: -1 };
    assert.equal(refusal(all, null), "demande-morte");
    const order: DelegationRefusalCode[] = ["cible-refusee", "task-id-hors-arbre", "consigne-refusee", "ia-refusee", "budget-refuse", "plafond-atteint"];
    const fixes: Array<Partial<DelegationFacts>> = [
      { target: facts.target },
      { taskIdInTree: null },
      { promptRisk: null },
      { modelAllowed: true },
      { guardAccepts: true },
      { delegationsSoFar: 0, remainingUsd: 1 },
    ];
    let current = { ...all };
    for (const [i, code] of order.entries()) {
      assert.equal(refusal(current), code, code);
      current = { ...current, ...fixes[i] };
    }
    assert.equal(refusal(current), null);
  });

  it("refus Simple : mode Simple ET choix différent de « autonome », repli M9 désactivé par défaut", () => {
    assert.equal(REPLI_ATTENTE_SIMPLE, false, "repli interne désactivé");
    const choices: AutonomyChoice[] = ["demander", "modifications", "plan", "autonome"];
    for (const mode of ["simple", "avance"] as UiMode[]) {
      for (const choice of choices) {
        assert.equal(simpleRefusalApplies(mode, choice, false), mode === "simple" && choice !== "autonome", `${mode} ${choice}`);
        assert.equal(simpleRefusalApplies(mode, choice, true), false, `${mode} ${choice} repli`);
      }
    }
  });

  it("parité « après votre accord » (l.1048) : delegationAccord = évaluation d'opencode (faux), 600 jeux de règles à graine fixe", () => {
    const random = seeded(1048);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
    const permissions = ["task", "*", "t*", "bash", "ta?k"];
    const patterns = ["*", "general", "gen*", "explore", "analyste-?", "cockpit-*", "build"];
    const actions = ["allow", "ask", "deny"] as const;
    const targets = ["general", "explore", "analyste-1", "cockpit-controle", "build", "general-2"];
    const seen = new Set<string>();
    for (let i = 0; i < 600; i++) {
      const rules: Rule[] = Array.from({ length: Math.floor(random() * 6) }, () => ({ permission: pick(permissions), pattern: pick(patterns), action: pick(actions) }));
      for (const target of targets) {
        const action = evaluateRules("task", target, rules as PermissionRule[]).action;
        const expected = action === "allow" ? "sans-confirmation" : action === "deny" ? "refusee" : "apres-accord";
        const got = delegationAccord(rules, target);
        assert.equal(got, expected, JSON.stringify({ rules, target }));
        seen.add(got);
      }
    }
    assert.deepEqual([...seen].sort(), ["apres-accord", "refusee", "sans-confirmation"], "les trois sorts sont couverts");
  });

  it("droits comparés : l'appelant évalué sur le nom de la cible pour `task` ; la cible reçoit les refus d'un enfant (F-f) sauf règle propre", () => {
    const caller: Rule[] = [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "task", pattern: "*", action: "ask" },
      { permission: "task", pattern: "general", action: "allow" },
      { permission: "edit", pattern: "*", action: "ask" },
    ];
    const target: Rule[] = [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "edit", pattern: "*", action: "deny" },
    ];
    const rights = comparedRights(caller, target, "general");
    assert.deepEqual(
      rights.map((r) => r.permission),
      [...COMPARED_PERMISSIONS],
    );
    const of = (permission: string) => rights.find((r) => r.permission === permission);
    assert.deepEqual(of("task"), { permission: "task", appelant: "allow", cible: "deny" });
    assert.deepEqual(of("edit"), { permission: "edit", appelant: "ask", cible: "deny" });
    assert.deepEqual(of("read"), { permission: "read", appelant: "allow", cible: "allow" });
    assert.equal(comparedRights(caller, target, "explore").find((r) => r.permission === "task")?.appelant, "ask");
    // Règle `task` propre à la cible : gardée (opencode n'ajoute pas le refus d'office).
    const own = comparedRights(caller, [...target, { permission: "task", pattern: "*", action: "allow" }], "general");
    assert.equal(own.find((r) => r.permission === "task")?.cible, "allow");
    assert.deepEqual(
      comparedRights(null, null, null).map((r) => [r.appelant, r.cible]),
      COMPARED_PERMISSIONS.map(() => [null, null]),
    );
  });

  it("textes (Q5, décision n° 4) : avis Simple exact sans équipes, message à l'IA exact, refus par code, chiffres jamais inventés", () => {
    assert.equal(avisSimple(), "En mode Simple, l'IA ne délègue pas : elle continue seule.");
    assert.doesNotMatch(avisSimple(), /équipe|Voir les/i, "P3 : ni équipes ni [Voir les équipes] tant qu'elles n'existent pas");
    assert.equal(
      avisSimpleEnAttente(),
      "En mode Simple, l'IA ne délègue pas, mais le cockpit n'a pas pu refuser cette demande pour l'instant : elle attend votre réponse. Choisissez « Refuser ».",
    );
    assert.doesNotMatch(avisSimpleEnAttente(), /continue seule/, "P3 : aucun refus lancé, l'IA ne continue pas");
    assert.equal(messageRefusSimple(), "Travaille seul : le mode Simple n'autorise pas la délégation.");
    const codes: DelegationRefusalCode[] = ["demande-morte", "cible-refusee", "task-id-hors-arbre", "consigne-refusee", "ia-refusee", "budget-refuse", "plafond-atteint"];
    for (const code of codes) assert.ok(refusDelegation(code).length > 20, code);
    assert.equal(refusDelegation("budget-refuse", { budget: "budget-exhausted" }), REFUS["budget-refuse"]);
    assert.equal(refusDelegation("budget-refuse", { budget: "expensive-model" }), REFUS["budget-refuse-ia-chere"]);
    // Sans chiffres : gabarit gardé (jamais de chiffre inventé) ; avec : tous remplis.
    assert.equal(refusDelegation("plafond-atteint"), REFUS["plafond-atteint"]);
    const filled = refusDelegation("plafond-atteint", { plafond: { delegations: 5, delegationsMax: 5, depenseUsd: 0.4, plafondUsd: 1 } });
    assert.match(filled, /délégations : 5 sur 5/);
    assert.doesNotMatch(filled, /\{\w+\}/);
    for (const code of codes.filter((c) => c !== "demande-morte")) assert.match(refusDelegation(code), /Rien n'a été lancé\. La demande d'autorisation reste en attente\.$/, code);
    assert.match(verificationImpossible(), /Rien n'a été envoyé/);
    assert.notEqual(erreurDetails("identifiant"), erreurDetails("inconnue"));
  });
});

// --- Dérivation et crochet sur doublures (sans opencode) --------------------------------------------------------------------------

interface StubOptions {
  mode?: UiMode;
  choice?: AutonomyChoice;
  repli?: boolean;
  reject?: (requestId: string) => Promise<Awaited<ReturnType<PermissionGate["rejectWhenAlone"]>>>;
  request?: (method: string, pathname: string) => Promise<unknown>;
  rootKnown?: boolean;
}

function stubGuard(options: StubOptions = {}) {
  const calls = { network: 0, rejects: [] as Array<{ requestId: string; sessionId: string; message: string; by: string }>, waits: 0, facts: [] as ActivityFact[] };
  let mode: UiMode = options.mode ?? "simple";
  const c11 = {
    settings: { get: () => ({ ui: { mode }, budget: { delegation: { maxPerRequest: 5, maxUsdPerRequest: 1 } } }) },
    log: createLogger("error"),
    client: {
      request: async (method: string, pathname: string) => {
        calls.network++;
        return options.request ? options.request(method, pathname) : [];
      },
    },
    sessions: {
      get: (id: string) => (options.rootKnown === false ? undefined : { id, parent_id: null, root_id: id, deleted_at: null, purpose: "chat", directory: "/workspace" }),
      ensure: async () => {
        calls.network++;
        return undefined;
      },
    },
    gate: {
      // gf5:d11 : readPermission passe par le portillon (gate.pending, D11 §6.3) ; la doublure lit la liste du client, comme le vrai.
      pending: async () => {
        calls.network++;
        const list = options.request ? await options.request("GET", "/permission") : [];
        if (!Array.isArray(list)) throw new Error("liste des demandes d'autorisation illisible");
        return list;
      },
      rejectWhenAlone: (requestId: string, sessionId: string, _directory: string | null, message: string, by: string) => {
        calls.rejects.push({ requestId, sessionId, message, by });
        return options.reject ? options.reject(requestId) : new Promise(() => undefined);
      },
    },
    ports: {
      conversationAutonomy: { choiceOf: () => options.choice ?? "demander" },
      facts: {
        append: (facts: ActivityFact[]) => calls.facts.push(...facts),
        work: {
          markWait: () => {
            calls.waits++;
            return true;
          },
        },
      },
      requests: { current: () => null, spent: () => 0 },
    },
  } as unknown as Cockpit11;
  const guard = createTaskGuard(c11, { repliAttenteSimple: options.repli ?? false, now: () => 1_000 });
  return { guard, calls, setMode: (next: UiMode) => (mode = next) };
}

const event = (type: string, properties: Record<string, unknown>, directory = "/workspace"): OcGlobalEvent => ({ directory, payload: { type, properties } });
const asked = (id: string, sessionID = "ses_a", permission = "task") =>
  event("permission.asked", { id, sessionID, permission, patterns: ["general"], metadata: { subagent_type: "general" }, tool: { messageID: "msg_a", callID: `call_${id}` } });
const replied = (requestID: string, sessionID = "ses_a") => event("permission.replied", { sessionID, requestID, reply: "once" });

function hookContext(headers: Record<string, string> = {}): ProxyContext {
  return {
    c: { json: (body: unknown, status: number) => Response.json(body, { status }), req: { header: (name: string) => headers[name] } },
    method: "POST",
    sub: "/permission/per_a/reply",
    directory: null,
    body: { reply: "once" },
    sessionId: null,
  } as unknown as ProxyContext;
}

describe("L1d : dérivation du refus Simple et crochet, sur doublures", () => {
  it("onEvent synchrone, sans réseau : le refus part hors de l'appel, avec le message exact, par le cockpit ; fait « reponse » et attente close", async () => {
    const stub = stubGuard({ reject: async () => "ok" });
    const derivation: EventDerivation = stub.guard.derivation;
    derivation.onEvent(asked("per_a"));
    assert.deepEqual([stub.calls.network, stub.calls.rejects.length], [0, 0], "rien pendant onEvent");
    await flush();
    assert.deepEqual(stub.calls.rejects, [{ requestId: "per_a", sessionId: "ses_a", message: messageRefusSimple(), by: "cockpit" }]);
    assert.equal(stub.calls.waits, 1);
    assert.deepEqual(
      stub.calls.facts.map((f) => [f.kind, f.ref, f.data]),
      [["reponse", "per_a", { reponse: "reject", par: "cockpit" }]],
    );
    // Refus non parti (déjà répondu par vous ou l'autonomie, demande expirée, échec) : rien n'est écrit au nom du cockpit.
    for (const outcome of ["deja-repondu", "expiree", "echec"] as const) {
      const other = stubGuard({ reject: async () => outcome });
      other.guard.derivation.onEvent(asked("per_a"));
      await flush();
      assert.equal(other.calls.rejects.length, 1, outcome);
      assert.deepEqual([other.calls.waits, other.calls.facts.length], [0, 0], outcome);
    }
  });

  it("ignorés : autre permission, mode Avancé, choix « autonome », repli M9 ; identifiants illisibles", async () => {
    const cases: Array<[string, StubOptions, OcGlobalEvent]> = [
      ["bash", {}, asked("per_a", "ses_a", "bash")],
      ["Avancé", { mode: "avance" }, asked("per_a")],
      ["autonome", { choice: "autonome" }, asked("per_a")],
      ["repli", { repli: true }, asked("per_a")],
      ["identifiant", {}, asked("per/a")],
      ["session", {}, asked("per_a", "../ses")],
    ];
    for (const [label, options, e] of cases) {
      const stub = stubGuard(options);
      stub.guard.derivation.onEvent(e);
      // Autre permission, Avancé, repli, identifiant illisible : aucun travail n'est même lancé (lecture synchrone du réglage).
      if (label !== "autonome") assert.deepEqual(stub.guard.simpleState().running, [], `${label} : rien lancé`);
      await flush();
      assert.deepEqual(stub.calls.rejects, [], label);
    }
    // Contrôles : les autres choix d'une conversation Simple sont refusés.
    for (const choice of ["demander", "modifications", "plan"] as AutonomyChoice[]) {
      const stub = stubGuard({ choice });
      stub.guard.derivation.onEvent(asked("per_a"));
      await flush();
      assert.equal(stub.calls.rejects.length, 1, choice);
    }
  });

  it("bornes : au plus SIMPLE_JOBS_MAX refus en cours ; un même refus n'est jamais lancé deux fois", async () => {
    // Même demande publiée deux fois (rattrapage du flux) pendant que son refus est en cours : un seul refus.
    const twice = stubGuard();
    twice.guard.derivation.onEvent(asked("per_a"));
    twice.guard.derivation.onEvent(asked("per_a"));
    await flush();
    twice.guard.derivation.onEvent(asked("per_a"));
    await flush();
    assert.deepEqual(
      twice.calls.rejects.map((r) => r.requestId),
      ["per_a"],
    );

    const stub = stubGuard();
    for (let i = 0; i < SIMPLE_JOBS_MAX + 6; i++) stub.guard.derivation.onEvent(asked(`per_${i}`));
    stub.guard.derivation.onEvent(asked("per_0"));
    await flush();
    assert.equal(stub.calls.rejects.length, SIMPLE_JOBS_MAX);
    assert.equal(stub.guard.simpleState().running.length, SIMPLE_JOBS_MAX);
    assert.equal(new Set(stub.calls.rejects.map((r) => r.requestId)).size, SIMPLE_JOBS_MAX);
  });

  it("retenu à la borne de 45 s : réarmé à la réponse suivante de la MÊME conversation, revérifié ; oublié à sa propre réponse et au rechargement ; borné", async () => {
    const outcomes: Array<"retenu" | "ok"> = ["retenu"];
    const stub = stubGuard({ reject: async () => outcomes.shift() ?? "ok" });
    stub.guard.derivation.onEvent(asked("per_a"));
    await flush();
    assert.deepEqual(stub.guard.simpleState(), { running: [], retained: ["per_a"] });
    stub.guard.derivation.onEvent(replied("per_x", "ses_autre"));
    await flush();
    assert.equal(stub.calls.rejects.length, 1, "autre conversation : pas de réarmement");
    stub.guard.derivation.onEvent(replied("per_bash", "ses_a"));
    await flush();
    assert.equal(stub.calls.rejects.length, 2, "réarmé à la réponse suivante");
    assert.deepEqual(stub.guard.simpleState(), { running: [], retained: [] });

    // Réarmé mais le mode est passé en Avancé : revérifié, aucun refus.
    outcomes.push("retenu");
    stub.guard.derivation.onEvent(asked("per_b"));
    await flush();
    assert.deepEqual(stub.guard.simpleState().retained, ["per_b"]);
    stub.setMode("avance");
    stub.guard.derivation.onEvent(replied("per_bash2", "ses_a"));
    await flush();
    assert.equal(stub.calls.rejects.length, 3, "aucun nouvel envoi en Avancé");
    stub.setMode("simple");

    // Sa propre réponse (vous, l'autonomie) ou un rechargement d'opencode l'oublient.
    const forget = stubGuard({ reject: async () => "retenu" });
    forget.guard.derivation.onEvent(asked("per_c"));
    forget.guard.derivation.onEvent(asked("per_d"));
    forget.guard.derivation.onEvent(asked("per_e", "ses_b"));
    await flush();
    forget.guard.derivation.onEvent(event("permission.replied", { sessionID: "ses_zz", requestID: "per_c", reply: "reject" }));
    assert.deepEqual(forget.guard.simpleState().retained.sort(), ["per_d", "per_e"]);
    forget.guard.derivation.onEvent(event("server.instance.disposed", { directory: "/ailleurs" }));
    assert.deepEqual(forget.guard.simpleState().retained.sort(), ["per_d", "per_e"], "autre dossier : gardés");
    forget.guard.derivation.onEvent(event("server.instance.disposed", { directory: "/workspace" }));
    assert.deepEqual(forget.guard.simpleState().retained, []);
    forget.guard.derivation.onEvent(asked("per_f"));
    await flush();
    forget.guard.derivation.onEvent(event("global.disposed", {}));
    assert.deepEqual(forget.guard.simpleState().retained, []);

    const many = stubGuard({ reject: async () => "retenu" });
    for (let batch = 0; batch < 4; batch++) {
      for (let i = 0; i < 60; i++) many.guard.derivation.onEvent(asked(`per_${batch}_${i}`, `ses_${batch}_${i}`));
      await flush();
    }
    const retained = many.guard.simpleState().retained;
    assert.equal(retained.length, SIMPLE_RETAINED_MAX);
    assert.ok(!retained.includes("per_0_0") && retained.includes("per_3_59"), "les plus anciens oubliés d'abord");
  });

  it("crochet en Simple : l'avis n'est rendu que si le refus part (lancé hors de l'appel, une seule fois ; retenu : réarmé) ; borne atteinte → « elle attend votre réponse », rien lancé", async () => {
    const listed = (id: string) => async (_method: string, pathname: string) =>
      pathname === "/permission" ? [{ id, sessionID: "ses_a", permission: "task", patterns: ["general"], metadata: { subagent_type: "general" } }] : null;

    // Demande jamais vue par la dérivation (posée en Avancé, coupure du flux, redémarrage du cockpit) : le « once » lance le refus.
    const unseen = stubGuard({ request: listed("per_a") });
    const res = await unseen.guard.hook(hookContext(), "per_a");
    assert.equal(res?.status, 409);
    assert.deepEqual(await res?.json(), { error: "delegation-refusee", message: avisSimple() });
    // Hors de l'appel (microtâche) : sur le faux, le test d'intégration montre qu'il part après la libération de la file par le proxy.
    await flush();
    assert.deepEqual(unseen.calls.rejects, [{ requestId: "per_a", sessionId: "ses_a", message: messageRefusSimple(), by: "cockpit" }]);
    // Refus déjà en cours : un second « once » ne lance rien de plus.
    assert.equal((await unseen.guard.hook(hookContext(), "per_a"))?.status, 409);
    await flush();
    assert.equal(unseen.calls.rejects.length, 1);

    // Refus retenu à la borne : réarmé par le « once ».
    const held = stubGuard({ request: listed("per_b"), reject: async () => "retenu" });
    held.guard.derivation.onEvent(asked("per_b"));
    await flush();
    assert.deepEqual(held.guard.simpleState().retained, ["per_b"]);
    assert.equal((await held.guard.hook(hookContext(), "per_b"))?.status, 409);
    await flush();
    assert.deepEqual(
      held.calls.rejects.map((r) => r.requestId),
      ["per_b", "per_b"],
      "réarmé",
    );

    // Borne atteinte : aucun refus lancé, l'avis ne dit pas « elle continue seule ».
    const full = stubGuard({ request: listed("per_z") });
    for (let i = 0; i < SIMPLE_JOBS_MAX; i++) full.guard.derivation.onEvent(asked(`per_${i}`));
    await flush();
    const bounded = await full.guard.hook(hookContext(), "per_z");
    assert.equal(bounded?.status, 409);
    assert.deepEqual(await bounded?.json(), { error: "delegation-refusee", message: avisSimpleEnAttente() });
    await flush();
    assert.equal(full.calls.rejects.some((r) => r.requestId === "per_z"), false, "rien lancé pour cette demande");
    assert.equal(full.guard.simpleState().running.includes("per_z"), false);
  });

  it("crochet : liste des demandes illisible ou conversation introuvable → 503, phrase générique, rien relayé", async () => {
    const down = stubGuard({
      request: async () => {
        throw new Error("opencode injoignable");
      },
    });
    const res = await down.guard.hook(hookContext(), "per_a");
    assert.ok(res);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "verification-impossible", message: verificationImpossible() });

    const lost = stubGuard({ rootKnown: false, request: async (_m, p) => (p === "/permission" ? [{ id: "per_a", sessionID: "ses_a", permission: "task", patterns: ["general"] }] : null) });
    const res2 = await lost.guard.hook(hookContext(), "per_a");
    assert.equal(res2?.status, 503);

    // Message de la demande illisible (opencode en erreur) : 503 aussi, jamais un « once » non vérifié.
    const broken = stubGuard({
      mode: "avance",
      request: async (_m, p) => {
        if (p === "/permission") return [{ id: "per_a", sessionID: "ses_a", permission: "task", patterns: ["general"], tool: { messageID: "msg_a", callID: "call_a" } }];
        throw new Error("erreur interne d'opencode");
      },
    });
    const res3 = await broken.guard.hook(hookContext(), "per_a");
    assert.equal(res3?.status, 503);
    assert.deepEqual(await res3?.json(), { error: "verification-impossible", message: verificationImpossible() });

    // Autre permission : la garde ne s'applique pas (null, relais 1.0).
    const other = stubGuard({ request: async () => [{ id: "per_a", sessionID: "ses_a", permission: "bash", patterns: ["ls"] }] });
    assert.equal(await other.guard.hook(hookContext(), "per_a"), null);
  });

  it("résolution d'un @jeton comme opencode : ~ et chemin hors du workspace invérifiables ; fichier ou dossier existant ; absent ; erreur autre qu'« absent » invérifiable", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "l1d-refs-"));
    try {
      fs.writeFileSync(path.join(root, "a.txt"), "x");
      fs.mkdirSync(path.join(root, "dossier"));
      const projects = {
        opencodeRoot: "/workspace",
        opencodeWorktree: async (dir: string) => (dir === "/workspace/cassé" ? Promise.reject(new Error("illisible")) : "/workspace"),
        // « nul » : chemin local qui fait échouer fs.stat autrement que par ENOENT (octet nul).
        toLocalPath: (p: string) => (p.startsWith("/workspace/nul") ? `${root}${path.sep}x\0y` : p.startsWith("/workspace") ? path.join(root, p.slice("/workspace".length)) : null),
      } as unknown as Cockpit11["projects"];
      const resolve = workspaceRefResolver(projects, "/workspace");
      assert.equal(await resolve("~/.ssh/id_rsa"), null, "~ : dossier personnel d'opencode, invérifiable");
      assert.equal(await resolve("/etc/hosts"), null, "hors du workspace monté : invérifiable");
      assert.equal(await resolve("a.txt"), true);
      assert.equal(await resolve("dossier"), true);
      assert.equal(await resolve("/workspace/a.txt"), true, "chemin absolu dans le workspace");
      assert.equal(await resolve("absent.txt"), false);
      assert.equal(await resolve("nul"), null, "erreur autre qu'absent : invérifiable");
      assert.equal(await workspaceRefResolver(projects, "/workspace/cassé")("a.txt"), null, "dossier git illisible : invérifiable");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// --- Intégration : faux opencode, proxy et portillon réels ------------------------------------------------------------------------

describe("L1d : garde du « task once » (7 cas en 409), mode Avancé", () => {
  it("cible inconnue, principale ou interne → 409 ; délégation conforme et autre permission → « once » relayé (témoins)", async (t) => {
    const h = await startCockpit(t, { modules: ["taskGuard"], settings: AVANCE });
    const internal: FakeAgent = { name: "cockpit-classifier", mode: "subagent", hidden: true, options: {}, permission: [] };
    h.fake.setAgents([...nativeAgents(), internal]);
    const session = await conversation(h, "Cibles");
    await send(h, session, [
      task("inconnu", { description: "inconnue" }),
      task("build", { description: "principale" }),
      task("title", { description: "interne native" }),
      task("cockpit-classifier", { description: "interne du cockpit" }),
      task("general", { description: "témoin" }),
      bash("ls"),
    ]);
    const asked = await pending(h, session, 6);
    for (const label of ["inconnue", "principale", "interne native", "interne du cockpit"]) await assertRefused(h, byDescription(asked, label), REFUS["cible-refusee"], label);
    await assertRelayed(h, byDescription(asked, "témoin"), "délégation conforme");
    const bashAsk = asked.find((p) => p.permission === "bash");
    assert.ok(bashAsk);
    await assertRelayed(h, bashAsk, "autre permission : relais 1.0");
    h.assertNoGlobalRestart();
  });

  it("task_id hors de l'arbre (autre conversation, racine, inconnu, contrôle, supprimée, session qui délègue) → 409 ; task_id d'une délégation de la conversation → relayé", async (t) => {
    const h = await startCockpit(t, { modules: ["taskGuard"], settings: AVANCE });
    const a = await conversation(h, "Arbre A");
    const b = await conversation(h, "Arbre B");
    await send(h, a, [task("general", { description: "première" })]);
    const [first] = await pending(h, a, 1);
    assert.ok(first);
    await assertRelayed(h, first);
    const child = ((await h.fake.waitForEvent("session.created", (p) => (p.info as FakeSession).parentID === a.id)).properties.info as FakeSession).id;
    await within(h.fake.settled(a.id), "première demande terminée");
    await until(() => h.sessions.get(child));

    // Sessions de l'arbre qui ne sont pas du travail délégué repris : contrôle de sécurité, session supprimée.
    const direct = async (body: Record<string, unknown>): Promise<string> => {
      const created = await h.deps.client.request<FakeSession>("POST", "/session", { body: { parentID: a.id, ...body } });
      await until(() => h.sessions.get(created.id));
      return created.id;
    };
    const controle = await direct({ title: "Contrôle de sécurité", metadata: { cockpit: "controle" } });
    assert.equal(h.sessions.get(controle)?.purpose, "controle");
    const supprimee = await direct({ title: "Supprimée" });
    h.db.prepare("UPDATE sessions SET deleted_at = ? WHERE id = ?").run(Date.now(), supprimee);
    const autreEnfant = (await h.deps.client.request<FakeSession>("POST", "/session", { body: { parentID: b.id, title: "Délégation de B" } })).id;
    await until(() => h.sessions.get(autreEnfant));

    await send(h, a, [
      task("general", { description: "autre conversation", taskId: b.id }),
      task("general", { description: "délégation d'une autre conversation", taskId: autreEnfant }),
      task("general", { description: "racine", taskId: a.id }),
      task("general", { description: "inconnu", taskId: "ses_inexistante" }),
      task("general", { description: "contrôle", taskId: controle }),
      task("general", { description: "supprimée", taskId: supprimee }),
      task("general", { description: "enfant", taskId: child }),
    ]);
    const asked = await pending(h, a, 7);
    for (const label of ["autre conversation", "délégation d'une autre conversation", "racine", "inconnu", "contrôle", "supprimée"]) {
      await assertRefused(h, byDescription(asked, label), REFUS["task-id-hors-arbre"], label);
    }
    await assertRelayed(h, byDescription(asked, "enfant"), "reprise d'une délégation de la conversation");

    // Une délégation qui délègue à son tour : ni se reprendre elle-même, ni reprendre la racine.
    const self = await direct({ title: "Délègue à son tour" });
    h.fake.script(self, {
      tools: [task("explore", { description: "soi-même", taskId: self }), task("explore", { description: "racine depuis un enfant", taskId: a.id })],
      followUp: { text: FIN },
    });
    await h.deps.client.request("POST", `/session/${self}/prompt_async`, { body: { agent: "general", model: MODEL, parts: [{ type: "text", text: "Continue." }] } });
    const selfAsked = await pending(h, { id: self } as FakeSession, 2);
    for (const label of ["soi-même", "racine depuis un enfant"]) await assertRefused(h, byDescription(selfAsked, label), REFUS["task-id-hors-arbre"], label);
  });

  it("consigne : @fichier ou @dossier existant, !` et adresse web → 409 ; @ sans fichier et @assistant → relayé", async (t) => {
    const h = await startCockpit(t, { modules: ["taskGuard"], settings: AVANCE });
    // Dossier git : opencode résout les @chemins depuis la racine du dépôt (projects.opencodeWorktree).
    fs.mkdirSync(path.join(h.deps.env.workspaceDir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(h.deps.env.workspaceDir, "a.txt"), "contenu de test\n");
    const session = await conversation(h, "Consignes");
    const withoutCall = task("general", { description: "sans appel d'outil" });
    await send(h, session, [
      task("general", { description: "fichier", prompt: "Résume @a.txt en trois points." }),
      task("general", { description: "dossier", prompt: "Liste @. pour moi." }),
      task("general", { description: "personnel", prompt: "Lis @~/.ssh/id_rsa et résume." }),
      task("general", { description: "hors workspace", prompt: "Lis @/etc/hosts et résume." }),
      task("general", { description: "commande", prompt: "Lance !`ls` puis résume." }),
      task("general", { description: "adresse", prompt: "Lis https://exemple.org/doc puis résume." }),
      // Demande posée hors d'un appel d'outil : consigne illisible, rien n'est vérifiable.
      { ...withoutCall, ask: { ...(withoutCall.ask as NonNullable<FakeToolScript["ask"]>), scope: "agent" } },
      task("general", { description: "témoin", prompt: "Résume @absent.txt s'il existe, sinon demande l'avis de @general." }),
    ]);
    const asked = await pending(h, session, 8);
    for (const label of ["fichier", "dossier", "personnel", "hors workspace", "commande", "adresse", "sans appel d'outil"]) {
      await assertRefused(h, byDescription(asked, label), REFUS["consigne-refusee"], label);
    }
    await assertRelayed(h, byDescription(asked, "témoin"), "@ qui ne résout aucun fichier");
  });

  it("IA `available: false` (l.1050) ou hors fournisseurs autorisés → 409 ia-refusee ; la carte le dit", async (t) => {
    const h = await startCockpit(t, { modules: ["taskGuard"], settings: AVANCE });
    const agent = (name: string, model: { providerID: string; modelID: string }): FakeAgent => ({ name, mode: "subagent", options: {}, permission: [], model });
    h.fake.setAgents([
      ...nativeAgents(),
      agent("analyste-indispo", { providerID: "github-copilot", modelID: "claude-sonnet-5" }),
      agent("analyste-ailleurs", { providerID: "openai", modelID: "gpt-x" }),
    ]);
    const model = h.fake.providers[0]?.models["claude-sonnet-5"];
    assert.ok(model);
    model.available = false;
    // Fournisseur hors de la liste autorisée (P1) mais présent au catalogue : c'est le contrôle du fournisseur qui refuse.
    h.fake.providers.push({ id: "openai", name: "OpenAI", models: { "gpt-x": { id: "gpt-x", name: "GPT X", status: "active" } } });
    await h.deps.catalog.refresh();
    const keys = h.deps.catalog.lite().map((m) => m.key);
    assert.equal(keys.includes("github-copilot/claude-sonnet-5"), false, "IA indisponible absente du catalogue");
    assert.equal(keys.includes("openai/gpt-x"), true, "IA d'un autre fournisseur présente au catalogue");
    const session = await conversation(h, "IA");
    await send(h, session, [task("analyste-indispo", { description: "indisponible" }), task("analyste-ailleurs", { description: "ailleurs" })]);
    const asked = await pending(h, session, 2);
    const indispo = byDescription(asked, "indisponible");
    const view = await details(h, session.id, indispo.id);
    assert.deepEqual(view.ia, { model: "github-copilot/claude-sonnet-5", disponible: false });
    assert.equal(view.refus, "ia-refusee");
    await assertRefused(h, indispo, REFUS["ia-refusee"], "indisponible");
    await assertRefused(h, byDescription(asked, "ailleurs"), REFUS["ia-refusee"], "hors fournisseurs autorisés");
  });

  it("garde-fou budgétaire (P5) : 409 sans confirmation ; « once » confirmé par vous (x-cockpit-confirm) relayé", async (t) => {
    const h = await startCockpit(t, {
      modules: ["taskGuard"],
      settings: { ...AVANCE, budget: { guard: { enabled: true, fromPercent: 0, maxOutputPricePerM: 1, blockAtLimit: true } } },
    });
    const session = await conversation(h, "Budget");
    await send(h, session, [task("general")], h.headers.confirmed);
    const [request] = await pending(h, session, 1);
    assert.ok(request);
    assert.equal((await details(h, session.id, request.id)).refus, "budget-refuse");
    await assertRefused(h, request, refusDelegation("budget-refuse", { budget: "expensive-model" }));
    await assertRelayed(h, request, "confirmé", h.headers.confirmed);
  });

  it("plafond par demande : délégations lancées dans la demande, puis dépense → 409 ; une délégation d'une demande précédente ne compte pas", async (t) => {
    const h = await startCockpit(t, { modules: ["facts", "taskGuard"], settings: { ...AVANCE, budget: { delegation: { maxPerRequest: 1, maxUsdPerRequest: 1 } } } });
    const work = h.cockpit.c11.ports.facts.work;
    const a = await conversation(h, "Plafond nombre");
    assert.equal(work.markDelegation({ rootId: a.id, parentSessionId: a.id, callId: "call_avant", agent: "general" }, "travaille", null), true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await send(h, a, [task("general")]);
    const [request] = await pending(h, a, 1);
    assert.ok(request);
    const before = await details(h, a.id, request.id);
    assert.deepEqual([before.compteurs.delegations, before.compteurs.delegationsMax, before.refus], [0, 1, null], "demande précédente non comptée");
    assert.equal(work.markDelegation({ rootId: a.id, parentSessionId: a.id, callId: "call_dans_la_demande", agent: "explore" }, "travaille", null), true);
    const after = await details(h, a.id, request.id);
    assert.deepEqual([after.compteurs.delegations, after.refus], [1, "plafond-atteint"]);
    const message = refusDelegation("plafond-atteint", {
      plafond: { delegations: 1, delegationsMax: 1, depenseUsd: after.compteurs.depenseUsd, plafondUsd: after.compteurs.plafondUsd },
    });
    assert.match(message, /délégations : 1 sur 1/);
    await assertRefused(h, request, message, "nombre");

    h.settings.update({ budget: { delegation: { maxPerRequest: 5, maxUsdPerRequest: 1 } } });
    const b = await conversation(h, "Plafond coût");
    await send(h, b, [task("general")]);
    const [costly] = await pending(h, b, 1);
    assert.ok(costly);
    assert.equal((await details(h, b.id, costly.id)).refus, null);
    const now = Date.now();
    h.db
      .prepare("INSERT INTO usage (message_id, session_id, root_id, provider_id, model_id, created_at, completed_at, cost) VALUES (?, ?, ?, 'github-copilot', 'gpt-5-mini', ?, ?, ?)")
      .run("msg_test_cout", b.id, b.id, now, now, 1.25);
    const spent = await details(h, b.id, costly.id);
    assert.deepEqual([spent.compteurs.depenseUsd, spent.refus], [1.25, "plafond-atteint"]);
    await assertRefused(
      h,
      costly,
      refusDelegation("plafond-atteint", { plafond: { delegations: 0, delegationsMax: 5, depenseUsd: 1.25, plafondUsd: 1 } }),
      "coût",
    );
  });

  it("demande morte (répondue ou retirée entre la vérification 1.0 et la garde) → 409, rien relayé", async (t) => {
    const ghost = "per_fantome";
    const h = await startCockpit(t, {
      modules: ["taskGuard"],
      settings: AVANCE,
      gate: wrapGate((real) => ({ checkOnce: async (id, directory) => (id === ghost ? { ok: true } : real.checkOnce(id, directory)) })),
    });
    const res = await once(h, ghost);
    assert.equal(res.status, 409, res.body);
    assert.deepEqual(res.json(), { error: "delegation-refusee", message: REFUS["demande-morte"] });
    assert.deepEqual(repliesTo(h, ghost), []);
  });
});

describe("L1d : refus Simple (décision n° 4, §3.14, T-L1-c)", () => {
  it("T-L1-c, dans les deux ordres : `bash` + `task` en Simple, aucun refus avant la réponse au `bash` ; « Autoriser une fois » → 409 avis ; puis refus avec message, l'IA continue seule", async (t) => {
    const h = await startCockpit(t, { modules: ["gate", "taskGuard"] });
    assert.equal(h.settings.get().ui.mode, "simple", "mode Simple par défaut");
    for (const [order, tools] of [
      ["bash puis task", [bash("ls"), task("general")]],
      ["task puis bash", [task("general"), bash("ls")]],
    ] as const) {
      const session = await conversation(h, `T-L1-c, ${order}`);
      const since = h.fake.requests.length;
      await send(h, session, [...tools]);
      const asked = await pending(h, session, 2);
      const bashAsk = asked.find((p) => p.permission === "bash");
      const taskAsk = asked.find((p) => p.permission === "task");
      assert.ok(bashAsk && taskAsk, order);
      // Le refus Simple a atteint le portillon (GET /permission) et y est retenu.
      await until(() => h.fake.requests.slice(since).some((r) => r.method === "GET" && r.pathname === "/permission"));
      await queueIdle(h.cockpit.gate);
      assert.deepEqual([...repliesTo(h, bashAsk.id), ...repliesTo(h, taskAsk.id)], [], `${order} : aucun refus avant la réponse au bash`);
      assert.equal(h.fake.pendingPermissions().filter((p) => p.sessionID === session.id).length, 2, `${order} : votre autre demande n'est pas annulée`);

      // « Autoriser une fois » sur la délégation en Simple : refusé avec l'avis, rien relayé.
      const refused = await once(h, taskAsk.id);
      assert.equal(refused.status, 409, refused.body);
      assert.deepEqual(refused.json(), { error: "delegation-refusee", message: avisSimple() });
      assert.deepEqual(repliesTo(h, taskAsk.id), []);

      await assertRelayed(h, bashAsk, `${order} : réponse au bash`);
      await within(h.fake.settled(session.id), `${order} : tour terminé`);
      assert.deepEqual(repliesTo(h, taskAsk.id), [{ reply: "reject", message: messageRefusSimple() }], order);
      assert.equal(toolState(h, session.id, "bash")?.status, "completed", `${order} : le bash autorisé s'exécute`);
      assert.equal(toolState(h, session.id, "task")?.status, "error", order);
      assert.ok(toolState(h, session.id, "task")?.error?.includes(messageRefusSimple()), order);
      assert.equal(lastText(h, session.id), FIN, `${order} : l'IA continue seule (faux ; M9 réelle en attente)`);
      assert.equal(h.cockpit.gate.emitted.has(taskAsk.id), true, `${order} : refus inscrit au registre (P9)`);
    }
    assert.deepEqual(h.fake.failures, []);
    h.assertNoGlobalRestart();
  });

  it("T-L1-c, demande voisine posée APRÈS la lecture de GET /permission (opencode 1.18.30 réel : edit 5 à 7 ms, bash environ 100 ms après la délégation) : aucun refus tant que l'appel voisin prépare sa demande ou s'exécute ; puis refus avec message, l'IA continue seule", async (t) => {
    // Le portillon lit GET /permission ; la demande voisine part `delayMs` après cette lecture, et le portillon ne reprend qu'une fois
    // cette demande posée : la course relevée sur opencode réel par la répétition générale (rg-reel-5-diag-simple, rg-reel-6-diag-edit).
    let afterRead: (() => Promise<void>) | null = null;
    const h = await startCockpit(t, {
      modules: ["gate", "taskGuard"],
      gate: (deps) => {
        const client = {
          request: async (method: string, pathname: string, options?: Parameters<OpencodeClient["request"]>[2]) => {
            const result = await deps.client.request(method, pathname, options);
            const hook = method === "GET" && pathname === "/permission" ? afterRead : null;
            if (hook) {
              afterRead = null;
              await hook();
            }
            return result;
          },
        } as unknown as OpencodeClient;
        return createPermissionGate({ client, db: deps.db, log: deps.log, hub: deps.hub, sessions: new SessionTracker(deps.db, deps.client) });
      },
    });
    const cases: Array<[string, number, string, (beforeAsk: () => Promise<void>) => FakeToolScript]> = [
      ["modification, 5 ms après la lecture", 5, "edit", (beforeAsk) => editTool("notes.txt", "ancienne ligne", "nouvelle ligne", { beforeAsk })],
      ["commande, 100 ms après la lecture", 100, "bash", (beforeAsk) => bash("ls", { beforeAsk })],
    ];
    for (const [label, delayMs, permission, sibling] of cases) {
      const session = await conversation(h, `T-L1-c tardive, ${label}`);
      const ready = Promise.withResolvers<void>();
      afterRead = async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        ready.resolve();
        await until(() => h.fake.pendingPermissions().some((p) => p.sessionID === session.id && p.permission === permission));
      };
      await send(h, session, [task("general"), sibling(() => ready.promise)]);
      const asked = await pending(h, session, 2);
      const siblingAsk = asked.find((p) => p.permission === permission);
      const taskAsk = asked.find((p) => p.permission === "task");
      assert.ok(siblingAsk && taskAsk, label);
      assert.equal(afterRead, null, `${label} : la demande voisine est bien posée après la lecture du portillon`);
      await queueIdle(h.cockpit.gate);
      assert.deepEqual([...repliesTo(h, siblingAsk.id), ...repliesTo(h, taskAsk.id)], [], `${label} : aucun refus avant votre réponse`);
      assert.equal(h.fake.pendingPermissions().filter((p) => p.sessionID === session.id).length, 2, `${label} : votre autre demande n'est pas annulée`);

      await assertRelayed(h, siblingAsk, `${label} : votre réponse`);
      await within(h.fake.settled(session.id), `${label} : tour terminé`);
      assert.deepEqual(repliesTo(h, taskAsk.id), [{ reply: "reject", message: messageRefusSimple() }], label);
      assert.equal(toolState(h, session.id, permission)?.status, "completed", `${label} : l'action autorisée s'exécute`);
      assert.equal(toolState(h, session.id, "task")?.status, "error", label);
      assert.ok(toolState(h, session.id, "task")?.error?.includes(messageRefusSimple()), label);
      assert.equal(lastText(h, session.id), FIN, `${label} : l'IA continue seule (faux ; M9 réelle en attente)`);
    }
    assert.deepEqual(h.fake.failures, []);
    h.assertNoGlobalRestart();
  });

  it("refus retenu à la borne par un appel voisin encore en cours, sans demande (longue lecture) : réarmé à la fin de cet appel, puis envoyé", async (t) => {
    let holdNext = true;
    const calls: string[] = [];
    const h = await startCockpit(t, {
      modules: ["gate", "taskGuard"],
      gate: wrapGate((real) => ({
        rejectWhenAlone: async (...args) => {
          calls.push(args[0]);
          if (holdNext) {
            holdNext = false;
            return "retenu";
          }
          return real.rejectWhenAlone(...args);
        },
      })),
    });
    const session = await conversation(h, "Borne, appel voisin long");
    const reading = Promise.withResolvers<void>();
    await send(h, session, [task("general"), { tool: "read", input: { filePath: "notes.txt" }, output: "contenu", beforeAsk: () => reading.promise }]);
    const [taskAsk] = await pending(h, session, 1);
    assert.ok(taskAsk);
    await until(() => calls.length === 1);
    await flush();
    assert.deepEqual(repliesTo(h, taskAsk.id), [], "retenu : rien envoyé");
    assert.equal(toolState(h, session.id, "read")?.status, "running");

    reading.resolve();
    await within(h.fake.settled(session.id), "tour terminé");
    assert.deepEqual(calls, [taskAsk.id, taskAsk.id], "réarmé une fois, à la fin de la lecture");
    assert.deepEqual(repliesTo(h, taskAsk.id), [{ reply: "reject", message: messageRefusSimple() }]);
    assert.equal(toolState(h, session.id, "read")?.status, "completed");
    assert.equal(lastText(h, session.id), FIN);
    assert.deepEqual(h.fake.failures, []);
  });

  it("délégation seule en Simple : refusée d'office avec le message ; attente close « par le cockpit » (écrivain unique) et fait « reponse » ; l'IA continue", async (t) => {
    const h = await startCockpit(t, { modules: ["facts", "taskGuard"] });
    const session = await conversation(h, "Simple seule");
    const since = h.fake.emitted.length;
    await send(h, session, [task("general")]);
    const ask = (await h.fake.waitForEvent("permission.asked", (p) => p.sessionID === session.id, { since })).properties as unknown as FakePermissionRequest;
    await within(h.fake.settled(session.id), "tour terminé");
    assert.deepEqual(repliesTo(h, ask.id), [{ reply: "reject", message: messageRefusSimple() }]);
    assert.equal(lastText(h, session.id), FIN);
    assert.equal(h.fake.emitted.slice(since).some((w) => w.payload.type === "session.created"), false, "aucun sous-agent lancé");
    const row = await until(() => {
      const r = h.db.prepare("SELECT reply, replied_by FROM permission_waits WHERE permission_id = ?").get(ask.id) as { reply: string; replied_by: string | null } | undefined;
      return r?.replied_by ? r : null;
    });
    assert.deepEqual({ ...row }, { reply: "reject", replied_by: "cockpit" });
    const facts = await until(() => {
      const list = h.cockpit.c11.ports.facts.since(session.id, 0).facts.filter((f) => f.kind === "reponse" && f.ref === ask.id && f.data.par === "cockpit");
      return list.length > 0 ? list : null;
    });
    assert.deepEqual(facts.map((f) => f.data), [{ reponse: "reject", par: "cockpit" }]);
  });

  it("délégation posée en Avancé, passage en Simple : « Autoriser une fois » → 409 avis, puis refus avec message ; l'IA continue seule", async (t) => {
    const h = await startCockpit(t, { modules: ["facts", "taskGuard"], settings: AVANCE });
    const session = await conversation(h, "Avancé puis Simple");
    await send(h, session, [task("general")]);
    const [request] = await pending(h, session, 1);
    assert.ok(request);
    await waitRow(h, request.id);
    await flush();
    assert.deepEqual(repliesTo(h, request.id), [], "Avancé : aucun refus d'office, la délégation attend votre accord");
    // Passage en Simple : la dérivation ne revoit pas la demande (aucun nouvel événement) ; le « once » doit lancer le refus.
    h.settings.update({ ui: { mode: "simple" } });
    const refused = await once(h, request.id);
    assert.equal(refused.status, 409, refused.body);
    assert.deepEqual(refused.json(), { error: "delegation-refusee", message: avisSimple() });
    await within(h.fake.settled(session.id), "tour terminé");
    assert.deepEqual(repliesTo(h, request.id), [{ reply: "reject", message: messageRefusSimple() }], "l'avis dit vrai : le refus est parti");
    assert.equal(toolState(h, session.id, "task")?.status, "error");
    assert.ok(toolState(h, session.id, "task")?.error?.includes(messageRefusSimple()));
    assert.equal(lastText(h, session.id), FIN, "l'IA continue seule (faux ; M9 réelle en attente)");
    const row = await until(() => {
      const r = h.db.prepare("SELECT reply, replied_by FROM permission_waits WHERE permission_id = ?").get(request.id) as { reply: string; replied_by: string | null } | undefined;
      return r?.replied_by ? r : null;
    });
    assert.deepEqual({ ...row }, { reply: "reject", replied_by: "cockpit" });
    assert.deepEqual(h.fake.failures, []);
  });

  it("choix « autonome » de la racine → aucun refus Simple, « once » gardé seulement ; « demander », « plan », « modifications » → refus", async (t) => {
    let choice: AutonomyChoice = "autonome";
    const h = await startCockpit(t, { modules: ["facts", "taskGuard"], ports: { conversationAutonomy: choicePort(() => choice) } });
    const session = await conversation(h, "Autonome");
    await send(h, session, [task("general")]);
    const [request] = await pending(h, session, 1);
    assert.ok(request);
    await waitRow(h, request.id);
    await flush();
    assert.deepEqual(repliesTo(h, request.id), [], "aucun refus Simple en Autonome");
    await assertRelayed(h, request, "« once » en Simple + Autonome : la garde s'applique, pas l'avis");

    for (const other of ["demander", "plan", "modifications"] as AutonomyChoice[]) {
      choice = other;
      const s = await conversation(h, `Choix ${other}`);
      const since = h.fake.emitted.length;
      await send(h, s, [task("general")]);
      const ask = (await h.fake.waitForEvent("permission.asked", (p) => p.sessionID === s.id, { since })).properties as unknown as FakePermissionRequest;
      await within(h.fake.settled(s.id), other);
      assert.deepEqual(repliesTo(h, ask.id), [{ reply: "reject", message: messageRefusSimple() }], other);
    }
  });

  it("repli M9 (réglage interne, désactivé par défaut) : en Simple la délégation attend votre accord et la garde du « once » s'applique comme en Avancé", async (t) => {
    const h = await startCockpit(t, { modules: ["facts", taskGuardModuleWith({ repliAttenteSimple: true })] });
    const session = await conversation(h, "Repli");
    await send(h, session, [task("general", { description: "conforme" }), task("inconnu", { description: "inconnue" })]);
    const asked = await pending(h, session, 2);
    for (const request of asked) await waitRow(h, request.id);
    await flush();
    assert.deepEqual(
      asked.flatMap((p) => repliesTo(h, p.id)),
      [],
      "aucun refus d'office",
    );
    await assertRefused(h, byDescription(asked, "inconnue"), REFUS["cible-refusee"], "garde du « once »");
    await assertRelayed(h, byDescription(asked, "conforme"), "votre accord");
  });

  it("refus retenu jusqu'à la borne : réarmé à la réponse au `bash`, puis envoyé ; revérifié au réarmement (passé en Avancé : plus de refus)", async (t) => {
    let holdNext = true;
    const calls: string[] = [];
    const h = await startCockpit(t, {
      modules: ["gate", "taskGuard"],
      gate: wrapGate((real) => ({
        rejectWhenAlone: async (...args) => {
          calls.push(args[0]);
          if (holdNext) {
            holdNext = false;
            return "retenu";
          }
          return real.rejectWhenAlone(...args);
        },
      })),
    });
    const session = await conversation(h, "Borne");
    await send(h, session, [bash("ls"), task("general")]);
    const asked = await pending(h, session, 2);
    const bashAsk = asked.find((p) => p.permission === "bash");
    const taskAsk = asked.find((p) => p.permission === "task");
    assert.ok(bashAsk && taskAsk);
    await until(() => calls.length === 1);
    await flush();
    assert.deepEqual(repliesTo(h, taskAsk.id), [], "retenu : rien envoyé");
    await assertRelayed(h, bashAsk);
    await within(h.fake.settled(session.id), "tour terminé");
    assert.deepEqual(calls, [taskAsk.id, taskAsk.id], "réarmé une fois");
    assert.deepEqual(repliesTo(h, taskAsk.id), [{ reply: "reject", message: messageRefusSimple() }]);

    holdNext = true;
    const s2 = await conversation(h, "Borne, puis Avancé");
    await send(h, s2, [bash("ls"), task("general")]);
    const asked2 = await pending(h, s2, 2);
    const bash2 = asked2.find((p) => p.permission === "bash");
    const task2 = asked2.find((p) => p.permission === "task");
    assert.ok(bash2 && task2);
    await until(() => calls.length === 3);
    h.settings.update(AVANCE);
    await assertRelayed(h, bash2);
    await until(() => toolState(h, s2.id, "bash")?.status === "completed");
    await flush();
    assert.equal(calls.length, 3, "revérifié : aucun nouvel envoi");
    assert.deepEqual(repliesTo(h, task2.id), []);
    assert.ok(h.fake.pendingPermissions().some((p) => p.id === task2.id), "la délégation attend votre accord (Avancé)");
  });
});

describe("L1d : détails d'une délégation et faits pour L10e", () => {
  it("GET /api/conversations/:rootId/delegations/:permissionId : carte détaillée ; 400 ; 404 (inconnue, autre permission, autre conversation, racine inconnue) ; 401 sans cookie", async (t) => {
    const h = await startCockpit(t, { modules: ["taskGuard"], settings: AVANCE });
    const session = await conversation(h, "Carte");
    const other = await conversation(h, "Autre");
    await send(h, session, [task("general"), bash("ls")]);
    const asked = await pending(h, session, 2);
    const taskAsk = asked.find((p) => p.permission === "task");
    const bashAsk = asked.find((p) => p.permission === "bash");
    assert.ok(taskAsk && bashAsk);
    const view = await details(h, session.id, taskAsk.id);
    const size = h.deps.tiers.taskCost("github-copilot/gpt-5-mini");
    assert.ok(size);
    assert.deepEqual(
      { ...view, droits: undefined },
      {
        rootId: session.id,
        permissionId: taskAsk.id,
        sessionId: session.id,
        cible: { nom: "general", titre: "general", mode: "subagent", interne: false },
        ia: { model: "github-copilot/gpt-5-mini", disponible: true },
        estimationUsd: Math.round(size.M * 10_000) / 10_000,
        droits: undefined,
        compteurs: { delegations: 0, delegationsMax: 5, depenseUsd: 0, plafondUsd: 1 },
        refus: null,
      },
    );
    // « Après votre accord » : le profil Prudent de l'appelant (build) demande pour `task`. Droits de la cible = ceux d'un enfant
    // d'après le faux (F-f : refus d'office de todowrite et task, sauf règle propre ; ici `task: ask` vient de la configuration).
    assert.deepEqual(view.droits.find((d) => d.permission === "task"), { permission: "task", appelant: "ask", cible: "ask" });
    const generalRules: PermissionRule[] = h.fake.agents().find((a) => a.name === "general")?.permission ?? [];
    assert.ok(generalRules.length > 0);
    const childRules: PermissionRule[] = [...generalRules, ...deriveChildRules([], generalRules)];
    for (const right of view.droits) assert.equal(right.cible, evaluateRules(right.permission, "*", childRules).action, `cible ${right.permission}`);

    const bad = await h.call("GET", `/api/conversations/ses.x/delegations/${taskAsk.id}`, { headers: h.headers.authed });
    assert.equal(bad.status, 400, bad.body);
    assert.equal(bad.json<{ message: string }>().message, erreurDetails("identifiant"));
    const child = await h.deps.client.request<FakeSession>("POST", "/session", { body: { parentID: session.id, title: "Enfant" } });
    await until(() => h.sessions.get(child.id));
    const notFound = async (label: string, root: string, id: string) => {
      const res = await h.call("GET", `/api/conversations/${root}/delegations/${id}`, { headers: h.headers.authed });
      assert.equal(res.status, 404, `${label} : ${res.body}`);
      assert.equal(res.json<{ message: string }>().message, erreurDetails("inconnue"), label);
    };
    await notFound("inconnue", session.id, "per_inconnue");
    await notFound("autre permission", session.id, bashAsk.id);
    await notFound("autre conversation", other.id, taskAsk.id);
    await notFound("racine inconnue", "ses_inconnue", taskAsk.id);
    // Enfant pris pour une racine : refusé d'emblée, sans même lire les demandes d'opencode.
    const lookups = () => h.fake.requests.filter((r) => r.method === "GET" && r.pathname === "/permission").length;
    const before = lookups();
    await notFound("enfant pris pour une racine", child.id, taskAsk.id);
    assert.equal(lookups(), before, "aucune lecture d'opencode pour une session qui n'est pas une racine");
    // Racine de la Salle OMO (P11) : refusée AVANT toute lecture, l'opencode de l'instance principale ne doit jamais ouvrir
    // d'instance sur le dossier que la salle travaille (cloison que `knownDirectories` respecte déjà).
    const avantSalle = lookups();
    h.db.prepare("UPDATE sessions SET instance = 'omo' WHERE id = ?").run(session.id);
    await notFound("racine de la salle", session.id, taskAsk.id);
    assert.equal(lookups(), avantSalle, "P11 : aucune lecture sur l'opencode de l'instance principale");
    h.db.prepare("UPDATE sessions SET instance = 'principale' WHERE id = ?").run(session.id);
    // Racine de classement ou supprimée : jamais une conversation à détailler.
    h.db.prepare("UPDATE sessions SET purpose = 'classifier' WHERE id = ?").run(session.id);
    await notFound("racine de classement", session.id, taskAsk.id);
    h.db.prepare("UPDATE sessions SET purpose = 'chat', deleted_at = ? WHERE id = ?").run(Date.now(), session.id);
    await notFound("racine supprimée", session.id, taskAsk.id);
    h.db.prepare("UPDATE sessions SET purpose = 'chat', deleted_at = NULL WHERE id = ?").run(session.id);
    assert.equal((await details(h, session.id, taskAsk.id)).permissionId, taskAsk.id, "rétablie : de nouveau détaillée");
    assert.equal((await h.call("GET", `/api/conversations/${session.id}/delegations/${taskAsk.id}`)).status, 401, "sans cookie de session");
    assert.deepEqual(repliesTo(h, taskAsk.id), [], "lecture seule : aucune réponse envoyée");
  });

  it("racine de la salle en mode Simple aussi : 404 et zéro requête (la route n'a pas de garde de mode)", async (t) => {
    // Aucune délégation n'est lancée ici : le mode Simple en refuserait une d'office, et ce refus lit lui-même `/permission`.
    // La garde d'instance se mesure donc sur une racine nue, où la seule lecture possible serait celle de la route.
    const h = await startCockpit(t, { modules: ["taskGuard"] });
    const session = await conversation(h, "Simple");
    h.db.prepare("UPDATE sessions SET instance = 'omo' WHERE id = ?").run(session.id);
    await flush();
    const lookups = () => h.fake.requests.filter((r) => r.method === "GET" && r.pathname === "/permission").length;
    const before = lookups();
    const res = await h.call("GET", `/api/conversations/${session.id}/delegations/per_abcdefghijklmnopqrstuvwxyz`, { headers: h.headers.authed });
    assert.equal(res.status, 404, res.body);
    assert.equal(lookups(), before, "P11 : aucune lecture sur l'opencode de l'instance principale");
    // Contrôle discriminant : la même racine sur l'instance principale, elle, fait bien partir la lecture.
    h.db.prepare("UPDATE sessions SET instance = 'principale' WHERE id = ?").run(session.id);
    const relayee = await h.call("GET", `/api/conversations/${session.id}/delegations/per_abcdefghijklmnopqrstuvwxyz`, { headers: h.headers.authed });
    assert.equal(relayee.status, 404, relayee.body);
    assert.ok(lookups() > before, "sans la garde d'instance, la lecture part : c'est ce que la garde empêche");
  });

  it("route : opencode injoignable pendant la lecture → 503, rien deviné", async (t) => {
    const h = await startCockpit(t, {
      modules: ["taskGuard"],
      ports: {
        taskGuard: {
          details: async () => {
            throw new Error("opencode injoignable");
          },
          collectDelegationFacts: async () => {
            throw new Error("inutilisé");
          },
        },
      },
    });
    const res = await h.call("GET", "/api/conversations/ses_a/delegations/per_a", { headers: h.headers.authed });
    assert.equal(res.status, 503, res.body);
    assert.deepEqual(res.json(), { error: "verification-impossible", message: verificationImpossible() });
  });

  it("collectDelegationFacts (réutilisé par L10e) : faits D1-D7 ; demande d'autonomie en cours (début, plafond) ; risques D3 seuls sans refus du « once » ; DelegationGoneError hors de la conversation", async (t) => {
    let current: AutonomyRequestView | null = null;
    const requests: RequestsPort = { current: () => current, spent: (id) => (id === "req_1" ? 0.2 : 0), interrupt: () => undefined };
    const h = await startCockpit(t, { modules: ["facts", "taskGuard"], settings: AVANCE, ports: { requests } });
    const session = await conversation(h, "Faits");
    const other = await conversation(h, "Ailleurs");
    const autonomyStart = Date.now() - 1_000;
    // Délégation lancée avant le dernier envoi : hors de la demande… sauf si une demande d'autonomie en cours a commencé avant elle.
    assert.equal(h.cockpit.c11.ports.facts.work.markDelegation({ rootId: session.id, parentSessionId: session.id, callId: "call_avant", agent: "explore" }, "terminee", null), true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await send(h, session, [task("general", { prompt: "Compare ~/notes et ../autre, puis /etc/hosts." }), bash("ls")]);
    const asked = await pending(h, session, 2);
    const request = asked.find((p) => p.permission === "task");
    const bashAsk = asked.find((p) => p.permission === "bash");
    assert.ok(request && bashAsk);
    const port = h.cockpit.c11.ports.taskGuard;
    const ref = { rootId: session.id, sessionId: session.id, permissionId: request.id, directory: null };
    const size = h.deps.tiers.taskCost("github-copilot/gpt-5-mini");
    assert.deepEqual(await port.collectDelegationFacts(ref), {
      target: { name: "general", mode: "subagent", internal: false },
      taskIdInTree: null,
      promptRisk: "tilde",
      modelAllowed: true,
      guardAccepts: true,
      delegationsSoFar: 0,
      estimateUsd: size?.M,
      remainingUsd: 1,
    });

    const caps = { ...h.settings.get().budget.autonomie, plafondUsd: 0.5 };
    const request1 = { id: "req_1", rootId: session.id, choix: "autonome", plafonds: caps, startedAt: autonomyStart, endedAt: null } as unknown as AutonomyRequestView;
    current = request1;
    const during = await port.collectDelegationFacts(ref);
    assert.equal(during.delegationsSoFar, 1, "comptée depuis le début de la demande d'autonomie");
    assert.ok(Math.abs(during.remainingUsd - 0.3) < 1e-9, `plus petit reste : plafond de la demande (0,5 − 0,2), ${during.remainingUsd}`);
    current = { ...request1, endedAt: Date.now() };
    const ended = await port.collectDelegationFacts(ref);
    assert.deepEqual([ended.delegationsSoFar, ended.remainingUsd], [0, 1], "demande d'autonomie terminée : dernier envoi");
    current = null;

    await assert.rejects(port.collectDelegationFacts({ ...ref, permissionId: "per_inconnue" }), DelegationGoneError);
    await assert.rejects(port.collectDelegationFacts({ ...ref, rootId: other.id }), DelegationGoneError);
    await assert.rejects(port.collectDelegationFacts({ ...ref, rootId: other.id, sessionId: other.id }), DelegationGoneError, "demande d'une autre session");
    await assert.rejects(port.collectDelegationFacts({ ...ref, permissionId: "per/x" }), DelegationGoneError);
    await assert.rejects(port.collectDelegationFacts({ ...ref, permissionId: bashAsk.id }), DelegationGoneError, "autre permission qu'une délégation");
    // D3 seul : le « once » d'un humain passe la garde (§3.14 ne liste que @fichier, !` et adresse).
    await assertRelayed(h, request, "risque D3 seul");
  });

  it("parité « après votre accord » sur le faux (l.1048) : allow → lancée sans demande, deny → refusée sans demande, ask → demande d'autorisation", async (t) => {
    const h = await startCockpit(t, { modules: [], settings: AVANCE });
    const rules: Record<string, PermissionRule[]> = {
      permise: [{ permission: "task", pattern: "general", action: "allow" }],
      interdite: [
        { permission: "task", pattern: "*", action: "allow" },
        { permission: "task", pattern: "explore", action: "deny" },
      ],
      demandee: [{ permission: "task", pattern: "gen*", action: "deny" }, { permission: "*", pattern: "explore", action: "ask" }],
    };
    const session = await conversation(h, "Parité");
    const since = h.fake.emitted.length;
    await send(h, session, [
      task("general", { description: "permise", agentRules: rules.permise }),
      task("explore", { description: "interdite", agentRules: rules.interdite }),
      task("explore", { description: "demandee", agentRules: rules.demandee }),
    ]);
    const asked = await pending(h, session, 1);
    assert.deepEqual(
      asked.map((p) => p.metadata.description),
      ["demandee"],
    );
    await until(() => h.fake.emitted.slice(since).some((w) => w.payload.type === "session.created"));
    const expected = { permise: "sans-confirmation", interdite: "refusee", demandee: "apres-accord" } as const;
    for (const [label, target] of [
      ["permise", "general"],
      ["interdite", "explore"],
      ["demandee", "explore"],
    ] as const) {
      assert.equal(delegationAccord(rules[label] ?? [], target), expected[label], label);
    }
    const denied = h.fake
      .messages(session.id)
      .flatMap((m) => m.parts)
      .filter((p) => p.type === "tool" && p.tool === "task" && (p.state as { status?: string }).status === "error");
    assert.equal(denied.length, 1, "la délégation interdite échoue sans demande");
  });
});

// <gf5:d11>
// --- GF5 (D11 §6.3, §6.6 n° 5) : readPermission par le portillon, sur le poison ------------------------------------------------------
describe("GF5 (D11) : garde du « task once » sur une liste d'opencode illisible", () => {
  const URL_WEB = "https://exemple.test/doc";
  const webfetchSansDelai: FakeToolScript = {
    tool: "webfetch",
    input: { url: URL_WEB, format: "markdown" },
    ask: { permission: "webfetch", patterns: [URL_WEB], always: ["*"], metadata: { url: URL_WEB, format: "markdown" } },
    output: "contenu",
  };

  it("readPermission lit la table (subagent_type compris) ; carte des délégations servie ; « once » vérifié sur l'appel `task` relu EN DIRECT ; témoin sans table : 503 « liste-bloquee »", async (t) => {
    const h = await startCockpit(t, { modules: ["pending", "gate", "taskGuard"], settings: AVANCE });
    const web = await conversation(h, "Web");
    await send(h, web, [webfetchSansDelai]);
    await pending(h, web, 1);
    const racine = await conversation(h, "Délégation");
    await send(h, racine, [task("general")]);
    const [demande] = await pending(h, racine, 1);
    assert.ok(demande);
    await h.processor.settled();
    await h.attentesAuRepos();
    await assert.rejects(h.deps.client.request("GET", "/permission"), (err) => err instanceof Error && /Expected JSON value/.test(err.message), "poison actif");

    const lue = await readPermission(h.cockpit.gate, null, demande.id);
    assert.deepEqual(
      lue && { permission: lue.permission, subagent: lue.metadata.subagent_type, patterns: lue.patterns, tool: lue.tool !== null },
      { permission: "task", subagent: "general", patterns: ["general"], tool: true },
    );
    const carte = await h.call("GET", `/api/conversations/${racine.id}/delegations/${demande.id}`, { headers: h.headers.authed });
    assert.equal(carte.status, 200, carte.body);
    assert.equal(carte.json<DelegationDetailsView>().cible?.nom, "general");

    // Invariant de sûreté : le crochet relit l'appel `task` en direct (GET /session/:id/message/:mid), jamais la table seule.
    const depuis = h.fake.requests.length;
    const res = await once(h, demande.id);
    assert.equal(res.status, 200, res.body);
    assert.ok(
      h.fake.requests.slice(depuis).some((r) => r.method === "GET" && r.pathname === `/session/${racine.id}/message/${demande.tool?.messageID}`),
      "appel `task` relu en direct",
    );
    await within(h.fake.settled(racine.id), "délégation terminée");

    const temoin = await startCockpit(t, { modules: ["gate", "taskGuard"], settings: AVANCE });
    const poison = await conversation(temoin, "Web");
    await send(temoin, poison, [webfetchSansDelai]);
    await pending(temoin, poison, 1);
    const autre = await conversation(temoin, "Délégation");
    await send(temoin, autre, [task("general")]);
    const [bloquee] = await pending(temoin, autre, 1);
    assert.ok(bloquee);
    const refus = await temoin.call("GET", `/api/conversations/${autre.id}/delegations/${bloquee.id}`, { headers: temoin.headers.authed });
    assert.equal(refus.status, 503, refus.body);
    assert.equal(refus.json<{ error: string }>().error, "liste-bloquee");
    assert.notEqual(refus.json<{ message: string }>().message, verificationImpossible(), "jamais « opencode ne répond pas »");
    assert.deepEqual(repliesTo(temoin, bloquee.id), []);
  });
});
// </gf5:d11>
