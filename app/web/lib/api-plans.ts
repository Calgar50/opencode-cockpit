// 1.1 (T2) : client mince de « Plan d'abord » (plan d'exécution §4.5, L6b). Mêmes en-têtes, erreurs et CSRF que web/lib/api.ts
// (aide `http` réutilisée) ; `confirm` envoie x-cockpit-confirm: 1 (garde-fou budgétaire, choix automatique).
import { http } from "./api.ts";
import type { PlanCreateBody, PlanCreateResponse, PlanExecutionBody, PlanExecutionResponse } from "./types.ts";

const enc = encodeURIComponent;

export const planApi = {
  /**
   * POST /api/plans : nouvelle conversation de plan (400 ; 403 forbidden-directory ; 404 conversation d'origine inconnue ; 409
   * budget-guard, outils-hors-controle ; 502 plancher-non-verifie, configuration-illisible). `source` : conversation d'origine
   * (« Plan d'abord (nouvelle conversation) »).
   */
  create: (directory: string, options: { confirm?: boolean; source?: string } = {}) => {
    const { source, ...request } = options;
    const body: PlanCreateBody = source === undefined ? { directory } : { directory, source };
    return http.post<PlanCreateResponse>("/api/plans", body, request);
  },
  /**
   * POST /api/plans/:id/execution : nouvelle conversation qui exécute le plan, avec son brouillon. 428 confirmation-requise
   * sans `confirm` pour un choix automatique (aucune conversation créée) ; 403 autonomie-coupee ; 409 ; 404 ; 502.
   */
  execute: (planRootId: string, body: PlanExecutionBody, options: { confirm?: boolean } = {}) =>
    http.post<PlanExecutionResponse>(`/api/plans/${enc(planRootId)}/execution`, body, options),
};
