// 1.1 (itération 3, T3d-a) : client mince des routes de la salle de contrôle 3D et de « Revoir » (plan d'exécution it3 §4.1,
// D-3d-08, D-3d-30). Lecture seule : GET seulement, aucune requête à opencode. Mêmes en-têtes et erreurs que web/lib/api.ts (aide
// `http` réutilisée) ; un refus rend ApiError avec `code` = RevoirRefus ou « consigne-absente ».
import type {
  RevoirConsigneResponse,
  RevoirConsignesEnfantResponse,
  RevoirEtatResponse,
  RevoirResponse,
  TerritoiresResponse,
} from "../../server/shared/salle3d-types.ts";
import { http, query } from "./api.ts";

const enc = encodeURIComponent;

export const salle3dApi = {
  /** GET /api/salle-controle/territoires → projets, compteurs et enceinte de la salle (zoom 1). */
  territoires: (signal?: AbortSignal) => http.get<TerritoiresResponse>("/api/salle-controle/territoires", signal),
  /** GET /api/revoir/:rootId → faits de la conversation à revoir (400, 403, 404). */
  revoir: (rootId: string, signal?: AbortSignal) => http.get<RevoirResponse>(`/api/revoir/${enc(rootId)}`, signal),
  /** GET /api/revoir/:rootId?etat=1 → accès à « Revoir », sans les faits (400). */
  revoirEtat: (rootId: string, signal?: AbortSignal) => http.get<RevoirEtatResponse>(`/api/revoir/${enc(rootId)}${query({ etat: 1 })}`, signal),
  /** GET /api/revoir/:rootId/consignes/:callId → consigne gardée localement (400, 403, 404 « consigne-absente »). */
  revoirConsigne: (rootId: string, callId: string, signal?: AbortSignal) =>
    http.get<RevoirConsigneResponse>(`/api/revoir/${enc(rootId)}/consignes/${enc(callId)}`, signal),
  /** GET /api/revoir/:rootId/consignes?enfant= → consignes gardées reçues par cette session, 20 au plus (400, 403). */
  revoirConsignesEnfant: (rootId: string, enfant: string, signal?: AbortSignal) =>
    http.get<RevoirConsignesEnfantResponse>(`/api/revoir/${enc(rootId)}/consignes${query({ enfant })}`, signal),
};
