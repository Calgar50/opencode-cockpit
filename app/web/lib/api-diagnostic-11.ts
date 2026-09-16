// 1.1 (T2) : client mince du Diagnostic de l'activité (plan d'exécution §4.5, route T0, données L1f et L11b). Mêmes en-têtes et
// erreurs que web/lib/api.ts (aide `http` réutilisée).
import { http } from "./api.ts";
import type { DiagnosticActiviteResponse } from "./types.ts";

export const diagnostic11Api = {
  /** GET /api/diagnostic/activite → bandeaux du travail délégué, agents internes, interrupteur, contrôle IA, porte I1. */
  activite: (signal?: AbortSignal) => http.get<DiagnosticActiviteResponse>("/api/diagnostic/activite", signal),
};
