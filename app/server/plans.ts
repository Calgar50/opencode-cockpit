// Propriétaire : L6b.
// Plan d'abord (spécification §4.9, §3.9, §6 l.1044, D12, D-03, D-04, M2 ; plan d'exécution, fiche L6b) :
// - POST /api/plans : nouvelle racine créée avec le plancher PLAN vérifié (ports.floors.createWithFloor), choix « plan » permanent
//   et plan_source_id (conversation d'origine, « Plan d'abord (nouvelle conversation) ») ; permis avec COCKPIT_AUTONOMY=off. Rien
//   n'est envoyé : le premier message part par le proxy, avec la garde normale.
// - Crochet beforeBilledSend : un envoi facturé dans l'arbre d'une conversation de plan exige le plancher PLAN vérifié sur la
//   session visée ; sinon il est reposé (PATCH, écho vérifié, marque) avant de relayer, ou l'envoi est refusé (502). Le plancher
//   CONVERSATION reposé par le crochet « floors » quand une marque manque n'enlève donc jamais « ne peut rien modifier ».
// - POST /api/plans/:id/execution : nouvelle racine CONVERSATION (aucun fork : il recopierait les messages facturés, sans plancher),
//   execution_de_plan_id, brouillon « Exécute le plan suivant. » + dernier texte du plan. La confirmation et l'activation d'un
//   choix automatique suivent la logique de PUT …/autonomie (403 autonomie-coupee, 428 sans x-cockpit-confirm, 409 avec la raison
//   du port activation), vérifiées AVANT toute création de racine ; le choix est ensuite posé par ports.conversationAutonomy.put
//   avec l'en-tête, qui refait ces vérifications sur la nouvelle racine (refus : racine supprimée).
// Le service rend des CODES ; les phrases sont dans shared/plan-texts.ts et shared/autonomy-choice-texts.ts (routes-plans.ts).
// neutralPlans reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan §2.2).
import { z } from "zod";
import { emitCockpit } from "./cockpit-events.ts";
import type { AutonomyPutResult, Cockpit11, Cockpit11Module, PlansPort, ProxyContext } from "./contracts-11.ts";
import { ConversationAutonomyStore } from "./conversation-autonomy.ts";
import { errorMessage } from "./log.ts";
import type { OcSession } from "./opencode.ts";
import { redactSecrets } from "./redact.ts";
import { registerPlanRoutes } from "./routes-plans.ts";
import { FLOOR_ERROR, FLOOR_TIMEOUT_MS, FloorNotVerifiedError, floorHash } from "./session-floor-service.ts";
import type { SessionRow } from "./sessions.ts";
import { settingsSchema } from "./settings.ts";
import { assertFact } from "./shared/activity-facts.ts";
import type { ChoixFactData } from "./shared/activity-types.ts";
import type { AutomaticChoice, AutonomyCaps, FloorKind, PlanCreateResponse, PlanExecutionResponse, PlanSessionInfo } from "./shared/autonomy-types.ts";
import { ID_RE, SESSION_ID_RE } from "./shared/ids.ts";
import { brouillonExecution, TEXTES } from "./shared/plan-texts.ts";
import { buildFloor, floorHolds, floorMark, parseFloorMark } from "./shared/session-floors.ts";

export function neutralPlans(): PlansPort {
  return {};
}

// --- Corps des routes -----------------------------------------------------------------------------------------------------------

/** Longueur maximale d'un dossier opencode reçu (chemin absolu du conteneur). */
const DIRECTORY_MAX = 4096;

/**
 * Corps de POST /api/plans : `directory` (PlanCreateBody) ; `source`, conversation d'origine de « Plan d'abord (nouvelle
 * conversation) », enregistrée dans plan_source_id (champ à ajouter au contrat PlanCreateBody : demande à l'intégrateur).
 */
const createBodySchema = z.strictObject({
  directory: z.string().min(1).max(DIRECTORY_MAX),
  source: z.string().regex(SESSION_ID_RE).optional(),
});

/** Plafonds : mêmes bornes que les réglages et que PUT …/autonomie (clés inconnues refusées). */
const capsSchema = settingsSchema.shape.budget.shape.autonomie
  .pick({ plafondUsd: true, actionsMax: true, delegationsMax: true, dureeMinutes: true, fichiersMax: true, controlesIaMax: true })
  .partial()
  .strict();

/** Corps de POST /api/plans/:id/execution (PlanExecutionBody) : « plan » et « omo » refusés. */
const executionBodySchema = z.strictObject({
  choix: z.enum(["demander", "modifications", "autonome"]),
  plafonds: capsSchema.optional(),
});

// --- Résultats ------------------------------------------------------------------------------------------------------------------

/** Refus d'autonomie : même forme que PUT …/autonomie (ports.conversationAutonomy.put). */
export type AutonomyRefusal = Extract<AutonomyPutResult, { ok: false }>;

/** Refus propres aux plans ; `motif` choisit la phrase (routes-plans.ts). */
export type PlanRefusal =
  | { ok: false; status: 400; error: "invalid"; motif: "requete" }
  | { ok: false; status: 403; error: "forbidden-directory" }
  | { ok: false; status: 404; error: "not-found"; motif: "plan" | "source" }
  | { ok: false; status: 409; error: "budget-guard"; percent: number; spentUsd: number; budgetUsd: number }
  | { ok: false; status: 409; error: "plan-sans-reponse" }
  | { ok: false; status: 502; error: "plancher-non-verifie"; motif: "plan" | "plan-reste" | "execution" | "execution-reste" }
  | { ok: false; status: 502; error: "opencode-unreachable" };

export type PlanResult<T> = { ok: true; value: T } | PlanRefusal | AutonomyRefusal;

const invalid: PlanRefusal = { ok: false, status: 400, error: "invalid", motif: "requete" };

// --- Aides ----------------------------------------------------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const isAutomatic = (choix: string): choix is AutomaticChoice => choix === "modifications" || choix === "autonome";

/** Session rendue au navigateur : identifiant, titre, dossier et heures, rien d'autre (règles comprises). */
function sessionInfo(session: OcSession, directory: string): PlanSessionInfo {
  const now = Date.now();
  return {
    id: session.id,
    title: typeof session.title === "string" ? session.title : "",
    directory: typeof session.directory === "string" && session.directory ? session.directory : directory,
    time: { created: session.time?.created ?? now, updated: session.time?.updated ?? now },
  };
}

/**
 * Dernier texte du plan (§4.9, point 5) : texte, hors parties synthétiques ou ignorées, du dernier message d'assistant terminé,
 * sans erreur et qui n'est pas un résumé ; secrets masqués (le brouillon repart vers l'IA). null : aucune réponse terminée.
 */
export function lastPlanText(messages: unknown): string | null {
  if (!Array.isArray(messages)) throw new TypeError("messages du plan illisibles");
  for (let i = messages.length - 1; i >= 0; i--) {
    const message: unknown = messages[i];
    if (!isRecord(message) || !isRecord(message.info) || !Array.isArray(message.parts)) continue;
    const { info } = message;
    const time = isRecord(info.time) ? info.time : {};
    if (info.role !== "assistant" || typeof time.completed !== "number" || info.error !== undefined || info.summary === true) continue;
    const text = (message.parts as unknown[])
      .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text" && part.synthetic !== true && part.ignored !== true)
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("\n")
      .trim();
    if (text) return redactSecrets(text);
  }
  return null;
}

// --- Service --------------------------------------------------------------------------------------------------------------------

/** Plancher d'une session d'un arbre de plan avant un envoi : tenu ; opencode n'a pas répondu (« echec ») ; écho qui ne le tient pas. */
type PlanFloorOutcome = "ok" | "echec" | "ecart";

export interface PlanService {
  create(body: unknown, options: { confirmed: boolean }): Promise<PlanResult<PlanCreateResponse>>;
  execute(planId: string, body: unknown, options: { confirmed: boolean }): Promise<PlanResult<PlanExecutionResponse>>;
  /** Crochet beforeBilledSend (après « floors ») : arbre d'une conversation de plan → plancher PLAN vérifié, sinon 502. */
  beforeBilledSend(ctx: ProxyContext): Promise<Response | null>;
}

/** Service réel : lit les autres ports (floors, conversationAutonomy, activation, facts) au moment de l'appel, jamais en copie. */
export function createPlanService(c11: Cockpit11): PlanService {
  const store = new ConversationAutonomyStore(c11.db);
  const planFloor = buildFloor("PLAN");
  const planHash = floorHash("PLAN");
  /** Pose du plancher PLAN en cours par session : deux envois simultanés ne font qu'un PATCH. */
  const inflight = new Map<string, Promise<PlanFloorOutcome>>();

  /** Racine de conversation de l'instance principale : ni enfant, ni session interne, ni supprimée (comme PUT …/autonomie). */
  const rootConversation = async (id: string): Promise<SessionRow | null> => {
    if (!SESSION_ID_RE.test(id)) return null;
    const row = c11.sessions.get(id) ?? (await c11.sessions.ensure(id));
    if (!row || row.parent_id !== null || row.root_id !== row.id || row.purpose !== "chat" || row.deleted_at !== null) return null;
    return row.instance === "principale" ? row : null;
  };

  /** Conversation de plan : racine de conversation dont le choix enregistré est « plan » (posé par create seulement). */
  const planRoot = async (id: string): Promise<SessionRow | null> => {
    const row = await rootConversation(id);
    return row && store.read(id)?.choix === "plan" ? row : null;
  };

  /** Supprime une racine créée par ce service et refusée ensuite ; une suppression impossible est journalisée. */
  const discard = async (session: OcSession, directory: string): Promise<void> => {
    try {
      await c11.client.request("DELETE", `/session/${encodeURIComponent(session.id)}`, { directory, timeoutMs: FLOOR_TIMEOUT_MS });
      c11.sessions.markDeleted(session.id);
    } catch (err) {
      c11.log.warn("plans : conversation refusée non supprimée, elle reste vide dans la liste", { sessionId: session.id, error: errorMessage(err) });
    }
  };

  /** Crée une racine avec le plancher `kind` ; écart ou échec → refus 502 (motif selon qu'une conversation peut rester). */
  const createRoot = async (kind: FloorKind, directory: string, motifs: { gone: "plan" | "execution"; left: "plan-reste" | "execution-reste" }) => {
    try {
      return { ok: true as const, session: await c11.ports.floors.createWithFloor(kind, { directory }) };
    } catch (err) {
      const gone = err instanceof FloorNotVerifiedError && err.deleted;
      c11.log.warn("plans : conversation non créée, plancher non vérifié", { kind, error: errorMessage(err) });
      const refusal: PlanRefusal = { ok: false, status: 502, error: FLOOR_ERROR, motif: gone ? motifs.gone : motifs.left };
      return refusal;
    }
  };

  /** Session suivie par le cockpit (createWithFloor l'a déjà enregistrée, sauf erreur d'écriture). */
  const track = (session: OcSession): void => {
    if (!c11.sessions.get(session.id)) c11.sessions.upsert(session);
  };

  /** Événement autonomie.choix et fait « choix » (sans texte) de la nouvelle conversation de plan. */
  const announcePlan = (rootId: string, at: number): void => {
    emitCockpit(c11.hub, "autonomie.choix", { rootId, choix: "plan", cause: "clic" });
    try {
      const data: ChoixFactData = { choix: "plan", cause: "clic" };
      c11.ports.facts.append([assertFact({ rootId, sessionId: rootId, kind: "choix", ref: null, data, at })]);
    } catch (err) {
      c11.log.warn("plans : fait « choix » non écrit", { error: errorMessage(err) });
    }
  };

  const create: PlanService["create"] = async (body, options) => {
    const parsed = createBodySchema.safeParse(body);
    if (!parsed.success) return invalid;
    const { directory, source } = parsed.data;
    if (!c11.projects.isAllowedDirectory(directory)) return { ok: false, status: 403, error: "forbidden-directory" };
    if (source !== undefined) {
      const origin = await rootConversation(source);
      if (!origin) return { ok: false, status: 404, error: "not-found", motif: "source" };
      // Le plan s'écrit dans le dossier de la conversation d'origine.
      if (origin.directory !== directory) return invalid;
    }
    // Garde-fou budgétaire (409 budget-guard) : budget du mois atteint, comme le premier refus de ledger.guard. La création
    // n'appelle aucune IA ; chaque message passera ensuite par le garde-fou normal du proxy.
    const { guard, monthlyUsd } = c11.settings.get().budget;
    const percent = c11.ledger.percentUsed();
    if (!options.confirmed && guard.enabled && guard.blockAtLimit && percent >= 100) {
      return { ok: false, status: 409, error: "budget-guard", percent, spentUsd: c11.ledger.monthTotal(), budgetUsd: monthlyUsd };
    }

    const created = await createRoot("PLAN", directory, { gone: "plan", left: "plan-reste" });
    if (!created.ok) return created;
    const { session } = created;
    const at = Date.now();
    try {
      track(session);
      store.setPlan(session.id, source ?? null, at);
    } catch (err) {
      // Conversation créée mais pas enregistrée comme plan : retirée, erreur rendue par le gestionnaire global (500).
      c11.log.error("plans : conversation de plan non enregistrée", { sessionId: session.id, error: errorMessage(err) });
      await discard(session, directory);
      throw err;
    }
    announcePlan(session.id, at);
    return { ok: true, value: { rootId: session.id, session: sessionInfo(session, directory) } };
  };

  /**
   * Confirmation et activation d'un choix automatique pour une NOUVELLE conversation, avant sa création : logique de PUT
   * …/autonomie depuis « demander » (relâcher) : 403 si COCKPIT_AUTONOMY=off, 428 sans x-cockpit-confirm, puis port activation
   * (409 avec la raison). La racine n'existe pas encore : le port est interrogé pour le dossier du plan (`rootId` : le plan).
   */
  const preflight = async (plan: SessionRow, choix: AutomaticChoice, confirmed: boolean): Promise<AutonomyRefusal | null> => {
    if (!c11.env.autonomy) return { ok: false, status: 403, error: "autonomie-coupee", raison: "autonomie-coupee" };
    if (!confirmed) return { ok: false, status: 428, error: "confirmation-requise", raison: null };
    const verdict = await c11.ports.activation.check({ rootId: plan.id, choix, agent: null, directory: plan.directory || null });
    return verdict.ok ? null : { ok: false, status: 409, error: "autonomie-indisponible", raison: verdict.raison };
  };

  const execute: PlanService["execute"] = async (planId, body, options) => {
    const parsed = executionBodySchema.safeParse(body);
    if (!SESSION_ID_RE.test(planId) || !parsed.success) return invalid;
    const { choix, plafonds } = parsed.data;
    if ((plafonds?.plafondUsd ?? 0) > c11.settings.get().budget.autonomie.plafondMaxUsd) return invalid;
    const plan = await planRoot(planId);
    if (!plan) return { ok: false, status: 404, error: "not-found", motif: "plan" };
    const directory = plan.directory;
    if (!c11.projects.isAllowedDirectory(directory)) return { ok: false, status: 403, error: "forbidden-directory" };
    if (isAutomatic(choix)) {
      const refused = await preflight(plan, choix, options.confirmed);
      if (refused) return refused;
    }

    let text: string | null;
    try {
      const messages = await c11.client.request<unknown>("GET", `/session/${encodeURIComponent(plan.id)}/message`, { directory, timeoutMs: 60_000 });
      text = lastPlanText(messages);
    } catch (err) {
      c11.log.warn("plans : texte du plan illisible, exécution non créée", { planId: plan.id, error: errorMessage(err) });
      return { ok: false, status: 502, error: "opencode-unreachable" };
    }
    if (text === null) return { ok: false, status: 409, error: "plan-sans-reponse" };

    const created = await createRoot("CONVERSATION", directory, { gone: "execution", left: "execution-reste" });
    if (!created.ok) return created;
    const { session } = created;
    try {
      track(session);
      if (choix !== "demander" || plafonds !== undefined) {
        // Même logique que PUT …/autonomie, avec l'en-tête : refaite sur la nouvelle racine (l'activation a pu changer depuis).
        const put = await c11.ports.conversationAutonomy.put(session.id, { choix, ...(plafonds === undefined ? {} : { plafonds }) }, { confirmed: options.confirmed });
        if (!put.ok) {
          c11.log.info("plans : choix refusé sur la conversation d'exécution, conversation retirée", { status: put.status, raison: put.raison });
          await discard(session, directory);
          return put;
        }
      }
      store.setExecutionDePlan(session.id, plan.id, Date.now());
    } catch (err) {
      c11.log.error("plans : conversation d'exécution non enregistrée", { sessionId: session.id, error: errorMessage(err) });
      await discard(session, directory);
      throw err;
    }
    return { ok: true, value: { rootId: session.id, session: sessionInfo(session, directory), brouillon: brouillonExecution(text) } };
  };

  /** PLAN sur la session : marque à jour, sinon PATCH, écho vérifié (se termine par PLAN, rien que des refus avant), marque. */
  const ensurePlanFloor = (sessionId: string, directory: string | null): Promise<PlanFloorOutcome> => {
    const pending = inflight.get(sessionId);
    if (pending !== undefined) return pending;
    const run = (async (): Promise<PlanFloorOutcome> => {
      const mark = parseFloorMark(c11.sessions.get(sessionId)?.plancher);
      if (mark?.kind === "PLAN" && mark.hash === planHash) return "ok";
      let echo: unknown;
      try {
        echo = await c11.client.request<unknown>("PATCH", `/session/${encodeURIComponent(sessionId)}`, {
          ...(directory ? { directory } : {}),
          body: { permission: planFloor },
          timeoutMs: FLOOR_TIMEOUT_MS,
        });
      } catch (err) {
        c11.log.warn("plans : plancher PLAN non posé, envoi refusé", { sessionId, error: errorMessage(err) });
        return "echec";
      }
      if (!isRecord(echo) || echo.id !== sessionId || !floorHolds(echo.permission, planFloor)) {
        c11.log.warn("plans : plancher PLAN non vérifié après PATCH, envoi refusé", { sessionId });
        return "ecart";
      }
      try {
        c11.sessions.upsert(echo as unknown as OcSession);
        c11.sessions.setPlancher(sessionId, floorMark("PLAN", planHash));
      } catch (err) {
        // Le plancher est tenu (écho vérifié) : l'envoi part ; la marque sera reposée au prochain envoi.
        c11.log.warn("plans : plancher PLAN vérifié mais non enregistré", { sessionId, error: errorMessage(err) });
      }
      return "ok";
    })().finally(() => inflight.delete(sessionId));
    inflight.set(sessionId, run);
    return run;
  };

  const beforeBilledSend: PlanService["beforeBilledSend"] = async (ctx) => {
    const sessionId = ctx.sessionId;
    // Session illisible : refusée par le crochet « floors » ; aucune conversation de plan ne peut y être reconnue.
    if (sessionId === null || !ID_RE.test(sessionId)) return null;
    const row = c11.sessions.get(sessionId) ?? (await c11.sessions.ensure(sessionId, ctx.directory ?? undefined));
    const rootId = row?.root_id ?? sessionId;
    if (store.read(rootId)?.choix !== "plan") return null;
    const outcome = await ensurePlanFloor(sessionId, ctx.directory || row?.directory || null);
    if (outcome === "ok") return null;
    const message = outcome === "ecart" ? TEXTES.partout.erreurs.envoiEcart : TEXTES.partout.erreurs.envoi;
    return Response.json({ error: FLOOR_ERROR, message }, { status: 502 });
  };

  return { create, execute, beforeBilledSend };
}

export const plansModule: Cockpit11Module = {
  name: "plans",
  install(reg, c11) {
    const service = createPlanService(c11);
    c11.ports.plans = {};
    reg.hook("beforeBilledSend", (ctx) => service.beforeBilledSend(ctx));
    reg.routes("plans", (app) => registerPlanRoutes(app, service));
  },
};
