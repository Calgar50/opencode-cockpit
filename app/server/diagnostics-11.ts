// Propriétaire : L1f.
// Diagnostic du travail délégué (spécification §3.14) : bandeaux subagent_depth > 1, sous-agents en arrière-plan, extensions dans
// oc-config/plugin(s)/, agents `task: allow`. Le module monte la route T0 GET /api/diagnostic/activite (routes-diagnostic-11.ts).
// Squelette T0 : port neutre = aucun bandeau ; seule inscription : le groupe de routes « diagnostic-11 » (route T0).
// neutralDiagnostics reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan §2.2).
import type { Cockpit11Module, DiagnosticsPort } from "./contracts-11.ts";
import { registerDiagnostic11Routes } from "./routes-diagnostic-11.ts";

export function neutralDiagnostics(): DiagnosticsPort {
  return {
    delegation: async () => [],
  };
}

export const diagnosticsModule: Cockpit11Module = {
  name: "diagnostics",
  install(reg, c11) {
    reg.routes("diagnostic-11", (app) => registerDiagnostic11Routes(app, c11));
  },
};
