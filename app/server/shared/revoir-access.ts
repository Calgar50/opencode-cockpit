// Politique d'accès à « Revoir » (spécification §5.9 l.1018-1024, Q6 l.1373, P11 ; plan d'exécution it3, fiche L28a, D-3d-09,
// D-3d-08) : décision pure, rendue par la route GET /api/revoir/:rootId (L28b) et ses consignes gardées (L28d, U2).
// - Racine inconnue → 404 « racine-inconnue ».
// - Conversation de l'instance principale → accès (la bande en direct la montre déjà, dans les deux modes).
// - Racine de la Salle OMO (ou instance illisible : traitée comme la salle) en mode Avancé → accès.
// - Racine de la salle en mode Simple (ou mode illisible) : accès seulement pour une demande TERMINÉE (D-3d-09) : aucune session
//   occupée selon les faits et une dernière demande finie : ligne `autonomy_requests` (`ended_at`) et, pour la salle, qui ne l'écrit
//   jamais là, sa ligne « omo » de conversation_autonomy et sa demande active (salle-demande.ts, répétition générale « 3s »). Faits
//   partiels (borne des 20 000) ou aucune demande connue → 403 « salle-fin-inconnue » ; session occupée ou demande pas finie → 403
//   « salle-demande-en-cours ». Fermé en cas de doute.
// occupeesSelonFaits : sessions dont le dernier fait `statut` de cycle (occupee, nouvelle-tentative, repos, erreur) est occupee ou
// nouvelle-tentative ; null si les faits sont partiels.
// Aucune chaîne affichable (D-3d-21) : codes seulement ; les phrases viennent de revoir-texts.ts (T3d-b).
// Module pur (server/shared) : aucun module node, aucun accès à l'environnement, ni horloge ni aléa.
import type { ActivityFact, SessionInstance } from "./activity-types.ts";
import type { NeonMode } from "./neon-scene.ts";
import type { RevoirRefus } from "./salle3d-types.ts";

// Type partagé de la vague 0 (D-3d-27) : référence salle3d-types.ts (T3d-a), réexporté depuis le train de V0.
export type { RevoirRefus } from "./salle3d-types.ts";

export interface RevoirAccesEntree {
  /** La racine est une conversation connue du cockpit (ligne `sessions`). */
  existe: boolean;
  /** `sessions.instance` de la racine ; null si illisible. */
  instance: SessionInstance | null;
  mode: NeonMode;
  /** Sessions occupées selon les faits (occupeesSelonFaits) ; null : faits partiels. */
  sessionsOccupees: number | null;
  /**
   * Dernière demande de la racine (`finie` : `ended_at` renseigné, ou demande de la salle close, salle-demande.ts) ; null : aucune
   * demande connue, ou fin illisible.
   */
  derniereDemande: { finie: boolean } | null;
}

export type RevoirAcces = { ok: true } | { ok: false; status: 403 | 404; code: RevoirRefus };

const refus = (status: 403 | 404, code: RevoirRefus): RevoirAcces => ({ ok: false, status, code });

/** Décision d'accès à « Revoir » (D-3d-09). */
export function revoirAcces(entree: RevoirAccesEntree): RevoirAcces {
  if (entree.existe !== true) return refus(404, "racine-inconnue");
  if (entree.instance === "principale") return { ok: true };
  if (entree.mode === "avance") return { ok: true };
  const occupees = entree.sessionsOccupees;
  const demande = entree.derniereDemande;
  if (occupees === null || demande === null) return refus(403, "salle-fin-inconnue");
  // Valeurs illisibles (nombre négatif, fractionnaire ou non fini ; `finie` qui n'est pas un booléen) : fin inconnue.
  if (!Number.isSafeInteger(occupees) || occupees < 0 || typeof demande.finie !== "boolean") return refus(403, "salle-fin-inconnue");
  if (occupees !== 0 || demande.finie !== true) return refus(403, "salle-demande-en-cours");
  return { ok: true };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** États de cycle d'une session (faits `statut` sans `cause`) et ceux qui la disent occupée. */
const CYCLE: ReadonlySet<string> = new Set(["occupee", "nouvelle-tentative", "repos", "erreur"]);
const OCCUPEE: ReadonlySet<string> = new Set(["occupee", "nouvelle-tentative"]);

/**
 * Nombre de sessions occupées selon les faits (D-3d-09, condition 1) ; null si les faits sont partiels (`partial` qui n'est pas
 * exactement false, ou fait « Déroulé partiel » du magasin) : fermé en cas de doute.
 */
export function occupeesSelonFaits(faits: readonly ActivityFact[], partial: boolean): number | null {
  if (partial !== false) return null;
  const dernierEtat = new Map<string, string>();
  for (const fait of faits) {
    if (!isRecord(fait) || typeof fait.sessionId !== "string" || !isRecord(fait.data)) continue;
    if (fait.kind === "affichage" && fait.data.etat === "deroule-partiel") return null;
    const etat = fait.data.etat;
    // Un fait d'arrêt ou de plafond (`cause`, L1c) n'est pas un état de cycle, comme dans scene().
    if (fait.kind === "statut" && fait.data.cause === undefined && typeof etat === "string" && CYCLE.has(etat)) dernierEtat.set(fait.sessionId, etat);
  }
  let occupees = 0;
  for (const etat of dernierEtat.values()) if (OCCUPEE.has(etat)) occupees += 1;
  return occupees;
}
