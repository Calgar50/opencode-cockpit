// Itération 5 (T5a, plan d'exécution it5 §4.1) : client mince des routes de la construction — méthodes, Seconde lecture,
// chronologie, coûts par équipe et archives d'équipe. Mêmes en-têtes, erreurs et CSRF que web/lib/api.ts (aide `http`
// réutilisée, qui pose x-cockpit-csrf: 1 sur toute requête autre que GET) : web/lib/api.ts n'est pas modifié (§2.2).
// Les routes sont montées par le groupe « construction » du câblage 1.1, jamais dans http.ts (§2.2) : tant que leur module n'est
// pas livré, elles répondent 404 et l'appel lève une ApiError, comme pour toute route absente.
import { http, query } from "./api.ts";
import type {
  ArchiveTeamsResponse,
  ChronologieResponse,
  MethodsResponse,
  SecondReadingEstimate,
  SecondReadingEstimateBody,
  TeamConversationsResponse,
  TeamCostsResponse,
} from "./types.ts";

const enc = encodeURIComponent;

/** GET /api/methods → catalogue des méthodes et limites (L44b). `sources` est vide en mode Simple. */
export function getMethods(signal?: AbortSignal): Promise<MethodsResponse> {
  return http.get<MethodsResponse>("/api/methods", signal);
}

/**
 * POST /api/seconde-lecture/estimation → coût estimé d'une seconde lecture (L44c, D-5-22 : « ≈ {x} $ », jamais un minimum).
 * Aucune IA n'est appelée : l'estimation se lit dans ce qui est déjà enregistré.
 */
export function estimateSecondReading(body: SecondReadingEstimateBody): Promise<SecondReadingEstimate> {
  return http.post<SecondReadingEstimate>("/api/seconde-lecture/estimation", body);
}

/** GET /api/conversations/:rootId/chronologie → lignes `usage` de la conversation (L47b) ; mode Avancé seulement. */
export function getChronologie(rootId: string, signal?: AbortSignal): Promise<ChronologieResponse> {
  return http.get<ChronologieResponse>(`/api/conversations/${enc(rootId)}/chronologie`, signal);
}

/** GET /api/team-costs?mois= → coûts par équipe et lancements les plus coûteux du mois (L46a) ; mois courant sans paramètre. */
export function getTeamCosts(month?: string, signal?: AbortSignal): Promise<TeamCostsResponse> {
  return http.get<TeamCostsResponse>(`/api/team-costs${query({ mois: month })}`, signal);
}

/** GET /api/conversations/:rootId/equipes → lancements d'équipe archivés d'une conversation (L46a). */
export function getArchiveTeams(rootId: string, signal?: AbortSignal): Promise<ArchiveTeamsResponse> {
  return http.get<ArchiveTeamsResponse>(`/api/conversations/${enc(rootId)}/equipes`, signal);
}

/** GET /api/conversations/equipes → racines qui ont lancé une équipe (filtre « Avec une équipe » des Archives, D-5-11). */
export function getTeamConversations(signal?: AbortSignal): Promise<TeamConversationsResponse> {
  return http.get<TeamConversationsResponse>("/api/conversations/equipes", signal);
}
