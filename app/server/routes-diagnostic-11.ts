// Propriétaire : T0 (route mince, écrite en entier) ; données : L1f (ports.diagnostics) et L11b (ports.internalAgents).
// GET /api/diagnostic/activite → DiagnosticActiviteResponse (plan d'exécution §4.5) : lecture seule des ports, aucun code
// d'erreur propre. Montée par le module « diagnostics » (groupe « diagnostic-11 », dernier de STEP_ORDER.routes).
import type { Hono } from "hono";
import type { Cockpit11 } from "./contracts-11.ts";
import type { DiagnosticActiviteResponse } from "./shared/cockpit-event-types.ts";

export function registerDiagnostic11Routes(app: Hono, c11: Cockpit11): void {
  app.get("/api/diagnostic/activite", async (c) => {
    const body: DiagnosticActiviteResponse = {
      delegation: await c11.ports.diagnostics.delegation(),
      agentsInternes: c11.ports.internalAgents.status(),
      interrupteur: c11.env.autonomy,
      controleIa: c11.settings.get().budget.autonomie.controleIa,
      activationOuverte: c11.activationOuverte,
    };
    return c.json(body);
  });
}
