// Propriétaire : L26a.
// Client mince de la Salle OMO (spécification §4.14.1 l.806-811, §4.14.2, §4.12 ; plan 2 bis-2 ter, fiche L26a, D-2b-30).
// Mêmes en-têtes, erreurs et garde anti-CSRF que web/lib/api.ts (aide `http` réutilisée) ; `confirm` envoie x-cockpit-confirm: 1.
//
// Routes appelées, toutes posées par des paquets déjà fusionnés — aucune route nouvelle ici :
// - GET  /api/omo/status                      (L18c) : état de la salle, sans secret ;
// - GET  /api/omo/precheck?projet=…           (L18c) : pré-contrôle d'un projet préparé, liste masquée des chemins trouvés ;
// - POST /api/omo/rooms                       (L18c) : ouverture d'une salle sur un projet préparé ;
// - POST /api/omo/rooms/:rootId/stop          (L18c, D-2b-30) : « Arrêter » de la salle ; jamais /api/conversations/:id/stop ;
// - PUT  /api/conversations/:rootId/autonomie (L10a, corps `OmoActivationBody`) : activation « omo », à CHAQUE demande ;
// - GET/POST /api/omo/oc/*                    (L18b) : lecture de la conversation de la salle et envoi d'un message.
//
// Tant que `SALLE_OUVERTE` est faux, TOUTE requête /api/omo/* reçoit 403 « salle-coupee » : ce n'est pas une panne, c'est l'état
// livré. `estSalleCoupee` le reconnaît pour que la page montre l'état de la salle (lu dans `Bootstrap.omo`) plutôt qu'une erreur
// technique (arbitrage A16 point 4 b).
import { ApiError, http, query } from "./api.ts";
import type {
  OmoActivationBody,
  OmoPrecheckProjectResult,
  OmoRoomCreateResponse,
  OmoStatusResponse,
} from "../../server/shared/omo-types.ts";
import type { ConversationAutonomyView, OcMessageWithParts, OcSession } from "./types.ts";

const enc = encodeURIComponent;

/** GET /api/omo/status : état de la salle, image, projets préparés, balayage git, battement. Jamais un secret. */
export function getOmoStatus(signal?: AbortSignal): Promise<OmoStatusResponse> {
  return http.get<OmoStatusResponse>("/api/omo/status", signal);
}

/** GET /api/omo/precheck : pré-contrôle d'un projet préparé, avant d'ouvrir une salle (mode Avancé seulement). */
export function getOmoPrecheck(projet: string, signal?: AbortSignal): Promise<OmoPrecheckProjectResult> {
  return http.get<OmoPrecheckProjectResult>(`/api/omo/precheck${query({ projet })}`, signal);
}

/**
 * POST /api/omo/rooms/:rootId/stop (D-2b-30) : « Arrêter » de la salle. Un arrêt ne fait que restreindre, il part donc dans les
 * deux modes ; une racine qui n'est pas une salle reçoit 404 sans qu'aucune instance soit appelée.
 */
export function stopOmo(rootId: string): Promise<{ arretee: boolean }> {
  return http.post<{ arretee: boolean }>(`/api/omo/rooms/${enc(rootId)}/stop`);
}

/** POST /api/omo/rooms : ouvre une salle sur un projet préparé (pré-contrôle du projet compris, côté serveur). */
export function openOmoRoom(projet: string): Promise<OmoRoomCreateResponse> {
  return http.post<OmoRoomCreateResponse>("/api/omo/rooms", { projet }, { confirm: true });
}

/**
 * PUT /api/conversations/:rootId/autonomie avec `{ choix: "omo", plafondUsd }` et x-cockpit-confirm: 1, à CHAQUE nouvelle
 * demande (§4.14.2). Le montant part en CHAÎNE saisie, jamais en flottant JSON : le serveur le vérifie (omo-cap.ts) et refuse
 * 409 avec sa phrase, sans rien lancer.
 */
export function activerOmo(rootId: string, plafondUsd: string): Promise<ConversationAutonomyView> {
  const body: OmoActivationBody = { choix: "omo", plafondUsd };
  return http.put<ConversationAutonomyView>(`/api/conversations/${enc(rootId)}/autonomie`, body, { confirm: true });
}

/** GET /api/omo/oc/session/:id : conversation de la salle, en lecture. */
export function getOmoSession(rootId: string, signal?: AbortSignal): Promise<OcSession> {
  return http.get<OcSession>(`/api/omo/oc/session/${enc(rootId)}`, signal);
}

/** GET /api/omo/oc/session/:id/message : messages de la conversation de la salle, en lecture. */
export function getOmoMessages(rootId: string, signal?: AbortSignal): Promise<OcMessageWithParts[]> {
  return http.get<OcMessageWithParts[]>(`/api/omo/oc/session/${enc(rootId)}/message`, signal);
}

/**
 * Envoi d'un message dans la salle, par le proxy de l'instance (L18b). L'activation est confirmée juste avant, à chaque demande :
 * sans elle, le serveur refuse. `confirm` est envoyé parce que l'envoi relâche vers un choix automatique.
 */
export function envoyerOmo(rootId: string, directory: string, corps: unknown): Promise<void> {
  return http.post<void>(`/api/omo/oc/session/${enc(rootId)}/prompt_async${query({ directory })}`, corps, { confirm: true });
}

/** Vrai quand le serveur a répondu « salle coupée » : état livré, jamais une panne à montrer comme telle. */
export function estSalleCoupee(err: unknown): boolean {
  return err instanceof ApiError && err.code === "salle-coupee";
}

/** Corps d'un refus de pré-contrôle : le résultat masqué joint au 409, sinon null. */
export function precheckRefuse(err: unknown): OmoPrecheckProjectResult | null {
  if (!(err instanceof ApiError) || err.data === null || typeof err.data !== "object") return null;
  const precheck = (err.data as { precheck?: unknown }).precheck;
  if (typeof precheck !== "object" || precheck === null) return null;
  const candidat = precheck as Partial<OmoPrecheckProjectResult>;
  return typeof candidat.projet === "string" && Array.isArray(candidat.trouves) ? (candidat as OmoPrecheckProjectResult) : null;
}
