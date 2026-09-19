// Propriétaire : L6b.
// POST /api/plans {directory, source?} → PlanCreateResponse (400 ; 403 forbidden-directory ; 404 source inconnue ; 409 budget-guard ;
// 502 plancher-non-verifie ; permis avec COCKPIT_AUTONOMY=off) ; POST /api/plans/:id/execution {choix, plafonds?} →
// PlanExecutionResponse (400 ; 404 ; 403 autonomie-coupee ; 409 autonomie-indisponible {raison}, plan-sans-reponse ; 428
// confirmation-requise sans x-cockpit-confirm pour un choix automatique, avant toute création de racine ; 502) (plan d'exécution
// §4.5). Groupe « plans », monté par le module plans. Routes minces : toute la logique est dans le service (plans.ts) ; phrases :
// shared/plan-texts.ts, et shared/autonomy-choice-texts.ts pour les refus d'autonomie (mêmes que PUT …/autonomie).
// Authentification et anti-CSRF : gardes globales de http.ts, avant ces routes.
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AutonomyRefusal, PlanRefusal, PlanResult, PlanService } from "./plans.ts";
import { CONFIRM_HEADER } from "./security.ts";
import type { BudgetGuardError } from "./shared/api-types.ts";
import { formatUsd } from "./shared/assistant-rules.ts";
import { raisonIndisponible, TEXTES as AUTONOMIE } from "./shared/autonomy-choice-texts.ts";
import type { AutonomyErrorBody } from "./shared/autonomy-types.ts";
import { SESSION_ID_RE } from "./shared/ids.ts";
import { budgetPlan, TEXTES } from "./shared/plan-texts.ts";

/** Corps des deux routes : un dossier et une conversation d'origine, ou un choix et six plafonds, au plus. */
const BODY_MAX = 4 * 1024;

type ErrorBody = { error: string; message: string; raison?: string } | BudgetGuardError | AutonomyErrorBody;

/** Refus d'autonomie : même corps que PUT …/autonomie (routes-autonomy.ts). */
function autonomyBody(result: AutonomyRefusal): ErrorBody {
  const { erreurs } = AUTONOMIE.partout;
  switch (result.error) {
    case "invalid":
      return { error: "invalid", message: TEXTES.partout.erreurs.requete };
    case "not-found":
      return { error: "not-found", message: erreurs.inconnue };
    case "confirmation-requise":
      return { error: result.error, message: erreurs.confirmation };
    default: {
      // raison null : un autre choix est arrivé pendant la vérification.
      const message = result.raison === null ? erreurs.remplace : raisonIndisponible(result.raison);
      return { error: result.error, message, ...(result.raison === null ? {} : { raison: result.raison }) };
    }
  }
}

function planBody(result: PlanRefusal): ErrorBody {
  const { erreurs } = TEXTES.partout;
  switch (result.error) {
    case "invalid":
      return { error: "invalid", message: erreurs.requete };
    case "forbidden-directory":
      return { error: result.error, message: erreurs.dossier };
    case "not-found":
      return { error: result.error, message: result.motif === "source" ? erreurs.sourceInconnue : erreurs.planInconnu };
    case "budget-guard":
      // Même forme que le garde-fou du proxy (BudgetGuardError) : aucune IA n'est appelée, d'où run et modelName à null.
      return {
        error: "budget-guard",
        allowed: false,
        code: "budget-exhausted",
        title: TEXTES.partout.budget.titre,
        message: budgetPlan(formatUsd(result.spentUsd), formatUsd(result.budgetUsd)),
        percent: result.percent,
        outputPricePerM: null,
        run: null,
        modelName: null,
      };
    case "plan-sans-reponse":
      return { error: result.error, message: erreurs.sansReponse };
    case "opencode-unreachable":
      return { error: result.error, message: erreurs.lecture };
    case "plancher-non-verifie": {
      const messages = { plan: erreurs.planNonCree, "plan-reste": erreurs.planRefuse, execution: erreurs.executionNonCreee, "execution-reste": erreurs.executionRefusee };
      return { error: result.error, message: messages[result.motif] };
    }
  }
}

function respond<T>(c: Context, result: PlanResult<T>): Response {
  if (result.ok) return c.json(result.value as object);
  const body = "raison" in result ? autonomyBody(result) : planBody(result);
  return c.json(body, result.status);
}

/** Corps JSON lu tel quel (le service le valide) ; undefined si illisible. */
async function readJson(c: Context): Promise<unknown> {
  try {
    return JSON.parse(await c.req.text()) as unknown;
  } catch {
    return undefined;
  }
}

export function registerPlanRoutes(app: Hono, service: PlanService): void {
  // onError : sans lui, l'exception 413 de bodyLimit remonterait au onError global de http.ts (500).
  const tooLong = (c: Context) => c.json({ error: "invalid", message: TEXTES.partout.erreurs.tropLong }, 413);
  const confirmed = (c: Context) => c.req.header(CONFIRM_HEADER) === "1";

  app.post("/api/plans", bodyLimit({ maxSize: BODY_MAX, onError: tooLong }), async (c) => {
    const body = await readJson(c);
    if (body === undefined) return c.json({ error: "invalid", message: TEXTES.partout.erreurs.requete }, 400);
    return respond(c, await service.create(body, { confirmed: confirmed(c) }));
  });

  app.post("/api/plans/:id/execution", bodyLimit({ maxSize: BODY_MAX, onError: tooLong }), async (c) => {
    const planId = c.req.param("id");
    if (!SESSION_ID_RE.test(planId)) return c.json({ error: "invalid", message: TEXTES.partout.erreurs.identifiant }, 400);
    const body = await readJson(c);
    if (body === undefined) return c.json({ error: "invalid", message: TEXTES.partout.erreurs.requete }, 400);
    return respond(c, await service.execute(planId, body, { confirmed: confirmed(c) }));
  });
}
