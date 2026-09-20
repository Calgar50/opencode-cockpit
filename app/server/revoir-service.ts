// Propriétaire : L28b.
// « Revoir » côté serveur (spécification §5.9 l.1018-1024, §7.7 l.1169, Q6, D-3d-08, D-3d-09) : règle d'accès, faits de la
// conversation, titre masqué. Lecture seule en base : aucune requête à opencode, aucune écriture, aucune ligne `usage`, requêtes
// SQL paramétrées.
// - `lire(rootId, mode)` : ligne `sessions` de la racine (existence, instance, titre), faits par `ports.facts.since(rootId, 0)`,
//   sessions occupées par `occupeesSelonFaits`, dernière ligne `autonomy_requests` de la racine (`ended_at`), décision par
//   `revoirAcces` (L28a) ; accès donné : RevoirResponse avec `termine` et le titre passé par `redactSecrets`.
// - `etat(rootId, mode)` : MÊME décision, sans rendre les faits. Ils ne sont lus que lorsque la décision en dépend (racine de la
//   salle en mode Simple) ; sinon `sessionsOccupees` vaut null, c'est-à-dire « fin inconnue », donc un refus si la règle changeait
//   un jour : fermé en cas de doute, jamais ouvert par défaut. `etat` rend AUSSI l'instance de la racine (null : racine inconnue) :
//   c'est la seule lecture décisive dont la page du zoom 2 dispose pour savoir si une racine est de la Salle OMO (D-3d-14), la
//   liste des territoires ne portant que les racines actives des dernières 24 h.
// `etat` est AUSSI consommé par la route des consignes gardées (L28d, U2, D-3d-30), qui lui applique la même règle d'accès : sa
// signature ne change pas après le train sans demande écrite à l'intégrateur.
import type { RevoirPort, RevoirResult, Salle3dDeps } from "./contracts-3d.ts";
import { redactSecrets } from "./redact.ts";
import { sessionRole } from "./shared/activity-facts.ts";
import type { FactsResponse, SessionInstance } from "./shared/activity-types.ts";
import type { NeonMode } from "./shared/neon-scene.ts";
import { occupeesSelonFaits, type RevoirAcces, revoirAcces } from "./shared/revoir-access.ts";
import type { RevoirEtatResponse } from "./shared/salle3d-types.ts";

/** Dernière demande d'autonomie de la racine (D-3d-09, conditions 2 et 3) ; `id` départage deux demandes de même heure. */
const DERNIERE_DEMANDE_SQL = "SELECT ended_at FROM autonomy_requests WHERE root_id = :root ORDER BY started_at DESC, id DESC LIMIT 1";

/** Racine consultable : ligne `sessions` d'une conversation (jamais un enfant, jamais une session de service). */
interface Racine {
  /** `sessions.instance` ; null si la valeur est illisible : traitée comme la salle (fermé en cas de doute, L28a). */
  instance: SessionInstance | null;
  /** `sessions.title`, masqué par redactSecrets. */
  titre: string;
}

/** Ligne `sessions` de la racine, ou null : racine inconnue du cockpit, session enfant, ou session de service (classement). */
function lireRacine(deps: Salle3dDeps, rootId: string): Racine | null {
  const row = deps.sessions.get(rootId);
  if (row === undefined || row.parent_id !== null || sessionRole(row.purpose, null) !== "conversation") return null;
  const instance = row.instance === "principale" || row.instance === "omo" ? row.instance : null;
  return { instance, titre: redactSecrets(row.title) };
}

/** Dernière ligne `autonomy_requests` de la racine ; null : aucune demande enregistrée (D-3d-09 : refus en mode Simple). */
function derniereDemande(deps: Salle3dDeps, rootId: string): { finie: boolean } | null {
  const row = deps.db.prepare(DERNIERE_DEMANDE_SQL).get({ root: rootId }) as { ended_at: number | null } | undefined;
  if (row === undefined) return null;
  return { finie: typeof row.ended_at === "number" && Number.isFinite(row.ended_at) };
}

/** Décision commune à `lire` et `etat` ; `faits` est null quand ils n'ont été ni demandés ni nécessaires à la décision. */
interface Decision {
  racine: Racine | null;
  faits: FactsResponse | null;
  occupees: number | null;
  demande: { finie: boolean } | null;
  acces: RevoirAcces;
}

function decider(deps: Salle3dDeps, rootId: string, mode: NeonMode, avecFaits: boolean): Decision {
  const racine = lireRacine(deps, rootId);
  const vide = { racine: null, faits: null, occupees: null, demande: null };
  if (racine === null) return { ...vide, acces: revoirAcces({ existe: false, instance: null, mode, sessionsOccupees: null, derniereDemande: null }) };
  // Les faits ne décident qu'en mode Simple, pour une racine qui n'est pas de l'instance principale (D-3d-09, condition 1).
  const faitsNecessaires = avecFaits || (racine.instance !== "principale" && mode !== "avance");
  const faits = faitsNecessaires ? deps.ports.facts.since(rootId, 0) : null;
  const occupees = faits === null ? null : occupeesSelonFaits(faits.facts, faits.partial);
  const demande = derniereDemande(deps, rootId);
  const acces = revoirAcces({ existe: true, instance: racine.instance, mode, sessionsOccupees: occupees, derniereDemande: demande });
  return { racine, faits, occupees, demande, acces };
}

/** Port réel de « Revoir » (L28b) : remplace le port neutre de T3d-a, monté par wiring-3d.ts. */
export function createRevoirPort(deps: Salle3dDeps): RevoirPort {
  return {
    lire(rootId: string, mode: NeonMode): RevoirResult {
      const { racine, faits, occupees, demande, acces } = decider(deps, rootId, mode, true);
      if (!acces.ok) return { ok: false, status: acces.status, code: acces.code };
      // `acces.ok` n'est rendu que pour une racine lue, dont les faits ont été demandés : les deux sont donc présents ici.
      if (racine === null || faits === null) return { ok: false, status: 404, code: "racine-inconnue" };
      return {
        ok: true,
        value: {
          rootId,
          titre: racine.titre,
          // Instance illisible : annoncée comme la salle, comme la règle d'accès la traite (jamais « principale » par défaut).
          instance: racine.instance ?? "omo",
          termine: occupees === 0 && demande !== null && demande.finie === true,
          facts: faits.facts,
          partial: faits.partial,
        },
      };
    },
    etat(rootId: string, mode: NeonMode): RevoirEtatResponse {
      const { racine, acces } = decider(deps, rootId, mode, false);
      // Instance illisible : annoncée comme la salle, comme la règle d'accès la traite (jamais « principale » par défaut).
      const instance = racine === null ? null : (racine.instance ?? "omo");
      return acces.ok ? { rootId, acces: true, raison: null, instance } : { rootId, acces: false, raison: acces.code, instance };
    },
  };
}
