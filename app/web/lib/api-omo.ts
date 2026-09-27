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
// - GET/POST /api/omo/oc/*                    (L18b) : lecture de la conversation et des assistants de la salle, envoi d'un message.
//
// Tant que `SALLE_OUVERTE` est faux, TOUTE requête /api/omo/* reçoit 403 « salle-coupee » : ce n'est pas une panne, c'est l'état
// livré. `estSalleCoupee` le reconnaît pour que la page montre l'état de la salle (lu dans `Bootstrap.omo`) plutôt qu'une erreur
// technique (arbitrage A16 point 4 b).
import { ApiError, assistantModelChanged, http, query } from "./api.ts";
import type { OmoAutonomyView } from "../../server/shared/api-types.ts";
import type {
  OmoActivationBody,
  OmoPrecheckProjectResult,
  OmoRoomCreateResponse,
  OmoStatusResponse,
} from "../../server/shared/omo-types.ts";
import type { OcAgent, OcMessageWithParts, OcSession } from "./types.ts";

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
 * 409 avec sa phrase, sans rien lancer. Réponse : la vue « omo » d'une racine de la salle (`OmoAutonomyView`, L22c ; typée ainsi
 * au train de V4, elle l'était en `ConversationAutonomyView`, qui ne peut pas porter « omo » sans inventer un plafond).
 */
export function activerOmo(rootId: string, plafondUsd: string): Promise<OmoAutonomyView> {
  const body: OmoActivationBody = { choix: "omo", plafondUsd };
  return http.put<OmoAutonomyView>(`/api/conversations/${enc(rootId)}/autonomie`, body, { confirm: true });
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

/**
 * IA que le serveur retient pour un envoi de la salle sans `agent` : celle de l'assistant « build » s'il est principal, sinon du
 * premier assistant principal visible — la règle de `defaultAgent` (http.ts), appliquée aux assistants de la SALLE. null : aucune
 * IA lisible ; l'envoi part alors sans IA et le serveur le refuse avec sa phrase (400 « modele-requis »), rien n'est inventé.
 */
export function modeleEnvoiSalle(agents: unknown): { providerID: string; modelID: string } | null {
  const liste = Array.isArray(agents) ? (agents as Partial<OcAgent>[]) : [];
  const principal = (agent: Partial<OcAgent>) => typeof agent?.name === "string" && agent.mode !== "subagent";
  const agent = liste.find((a) => principal(a) && a.name === "build") ?? liste.find((a) => principal(a) && a.hidden !== true);
  const model = agent?.model;
  if (typeof model?.providerID !== "string" || model.providerID === "" || typeof model.modelID !== "string" || model.modelID === "") return null;
  return { providerID: model.providerID, modelID: model.modelID };
}

/**
 * Envoi d'un message de la page de la salle, comme la page de conversation (ChatPage) : le proxy passe toute demande facturée par
 * `enforceTurn`, qui EXIGE l'IA de la demande (400 « modele-requis » sinon). L'IA part donc dans le corps, lue dans les assistants
 * de la salle (GET /api/omo/oc/agent) ; sur 409 « assistant-model-changed », UN seul renvoi avec l'IA et la réflexion reçues. Ce
 * refus vient d'`enforceTurn`, AVANT les crochets de la salle : le jeton d'activation n'est pas consommé par le premier envoi.
 * Train de V4 (2 ter), constat n° 2 de L21b : la page envoyait `{ parts }` seul et ne pouvait envoyer aucun message.
 */
export async function envoyerMessageOmo(rootId: string, directory: string, texte: string): Promise<void> {
  const agents = await http.get<OcAgent[]>(`/api/omo/oc/agent${query({ directory })}`);
  const model = modeleEnvoiSalle(agents);
  const parts = [{ type: "text", text: texte }];
  try {
    await envoyerOmo(rootId, directory, model === null ? { parts } : { parts, model });
  } catch (err) {
    const imposee = assistantModelChanged(err);
    if (imposee === null) throw err;
    await envoyerOmo(rootId, directory, { parts, model: imposee.model, ...(imposee.variant ? { variant: imposee.variant } : {}) });
  }
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
