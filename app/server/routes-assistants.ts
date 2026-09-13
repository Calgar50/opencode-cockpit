// Routes HTTP des assistants (/api/assistants/*) et des niveaux d'IA (/api/ai*) — conception 0.2.0 §11.
// Les erreurs métier (AssistantServiceError) sont converties ici en { error, message, ...extra } ; les autres
// (StudioValidationError, StudioApplyError, SettingsError, opencode injoignable…) remontent au onError de http.ts.
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { type AssistantService, AssistantServiceError } from "./assistants.ts";
import type { EventHub } from "./hub.ts";
import type { Logger } from "./log.ts";
import { advancedOnly } from "./mode.ts";
import { CONFIRM_HEADER } from "./security.ts";
import { type SettingsStore, tierDefsSchema } from "./settings.ts";
import type { AiView, PutTiersResponse } from "./shared/api-types.ts";
import { MESSAGES } from "./shared/assistant-rules.ts";
import { issuesFrom, nameSchema } from "./studio-schema.ts";
import type { TierService } from "./tiers.ts";

export interface AssistantRoutesDeps {
  assistants: AssistantService;
  tiers: TierService;
  settings: SettingsStore;
  hub: EventHub;
  log: Logger;
}

const SMALL_BODY = 16 * 1024;
const LARGE_BODY = 64 * 1024;

const CATALOGUE_ID_RE = /^[a-z0-9-]{1,64}$/;

const installSchema = z.strictObject({ name: nameSchema.optional() });
const putTiersSchema = z.strictObject({ tiers: tierDefsSchema.nullable() });
const realignSchema = z.strictObject({
  items: z
    .array(z.strictObject({ kind: z.enum(["agents", "commands"]), name: nameSchema }))
    .max(200)
    .optional(),
});
const keepModelSchema = z.strictObject({ kind: z.enum(["agents", "commands"]), name: nameSchema });

/** Corps JSON ; vide = {} ; illisible = 400 invalid-json. */
async function jsonBody(c: Context): Promise<unknown> {
  const raw = await c.req.text();
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new AssistantServiceError(400, "invalid-json", "Corps JSON invalide.");
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AssistantServiceError(400, "validation", "Requête invalide.", { issues: issuesFrom(result.error) });
  return result.data;
}

async function answer(c: Context, run: () => Promise<object> | object): Promise<Response> {
  try {
    return c.json(await run());
  } catch (err) {
    if (err instanceof AssistantServiceError) return c.json({ error: err.code, message: err.message, ...err.extra }, err.status);
    throw err;
  }
}

/** /api/assistants/* — autorisé dans les deux modes (sortie de l'assistant sûre par construction). */
export function registerAssistantRoutes(app: Hono, deps: AssistantRoutesDeps): void {
  const { assistants } = deps;

  app.get("/api/assistants", (c) => answer(c, () => assistants.list()));

  app.get("/api/assistants/catalogue", (c) => answer(c, () => assistants.catalogue()));

  app.get("/api/assistants/fiches", (c) => answer(c, () => assistants.fiches()));

  app.post("/api/assistants/catalogue/:id/install", bodyLimit({ maxSize: SMALL_BODY }), (c) =>
    answer(c, async () => {
      const id = c.req.param("id");
      if (!CATALOGUE_ID_RE.test(id)) throw new AssistantServiceError(404, "not-found", "Assistant du catalogue introuvable.");
      const { name } = parse(installSchema, await jsonBody(c));
      return assistants.install(id, name);
    }),
  );

  // Aperçu : une saisie invalide n'est pas une erreur HTTP (200 avec `issues`) ; seul un corps illisible donne 400.
  app.post("/api/assistants/preview", bodyLimit({ maxSize: LARGE_BODY }), (c) =>
    answer(c, async () => assistants.preview(await jsonBody(c))),
  );

  app.put("/api/assistants/:name", bodyLimit({ maxSize: LARGE_BODY }), (c) =>
    answer(c, async () => assistants.save(c.req.param("name"), await jsonBody(c))),
  );

  app.post("/api/assistants/:name/adopt", bodyLimit({ maxSize: SMALL_BODY }), (c) =>
    answer(c, async () => assistants.adopt(c.req.param("name"), await jsonBody(c))),
  );

  app.delete("/api/assistants/:name/meta", (c) =>
    answer(c, () => {
      const kind = c.req.query("kind") ?? "agents";
      if (kind !== "agents" && kind !== "commands") throw new AssistantServiceError(400, "invalid", "Type inconnu (agents ou commands).");
      return assistants.removeMeta(kind, c.req.param("name"));
    }),
  );

  app.delete("/api/assistants/:name", (c) => answer(c, () => assistants.remove(c.req.param("name"), c.req.query("force") === "1")));
}

/** /api/ai (lecture, deux modes), /api/ai/tiers (Avancé), /api/ai/realign (deux modes, confirmation obligatoire). */
export function registerAiRoutes(app: Hono, deps: AssistantRoutesDeps): void {
  const { assistants, tiers, settings, hub } = deps;

  const aiView = async (): Promise<AiView> => {
    const s = settings.get();
    const [usage, updates] = await Promise.all([assistants.usage(), assistants.updates()]);
    return {
      source: tiers.source(),
      sourceText: tiers.sourceText(),
      tiers: tiers.views(),
      chatDefaultTier: s.ai.chatDefaultTier,
      allowModelOverride: s.ai.allowModelOverride,
      usage,
      updates,
    };
  };

  app.get("/api/ai", (c) => answer(c, aiView));

  app.put("/api/ai/tiers", advancedOnly(settings), bodyLimit({ maxSize: SMALL_BODY }), (c) =>
    answer(c, async (): Promise<PutTiersResponse> => {
      const { tiers: next } = parse(putTiersSchema, await jsonBody(c));
      if (!tiers.catalogLoaded()) throw new AssistantServiceError(409, "catalogue-indisponible", MESSAGES.catalogueIndisponible);
      if (next !== null) {
        const issues = tiers.validate(next);
        if (issues.length > 0) throw new AssistantServiceError(422, "validation", MESSAGES.fournisseurRefuse, { issues });
      }
      // Seul le réglage change : aucun fichier n'est réécrit (les éléments impactés passent en « Mise à jour disponible »).
      settings.update({ ai: { tiers: next } });
      hub.cockpit("ai.changed", { reason: "tiers" });
      return { impacted: await assistants.updates(), ai: await aiView() };
    }),
  );

  app.post("/api/ai/realign", bodyLimit({ maxSize: SMALL_BODY }), (c) =>
    answer(c, async () => {
      if (c.req.header(CONFIRM_HEADER) !== "1") throw new AssistantServiceError(428, "confirmation-requise", "Confirmez la mise à jour.");
      const { items } = parse(realignSchema, await jsonBody(c));
      return assistants.realign(items);
    }),
  );

  // « Garder cette IA précise » (deux modes) : seule la liaison au niveau est retirée, aucun fichier réécrit.
  app.post("/api/ai/keep-model", bodyLimit({ maxSize: SMALL_BODY }), (c) =>
    answer(c, async () => {
      const { kind, name } = parse(keepModelSchema, await jsonBody(c));
      return assistants.keepModel(kind, name);
    }),
  );
}
