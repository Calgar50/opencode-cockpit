// Propriétaire : L3s-a.
// Fin de la demande d'une racine de la Salle OMO, pour « Revoir », ses consignes gardées et le zoom 1 (Q6 ; spécification §5.9
// l.1018-1024, §6 l.1065 ; plan it3 D-3d-09, D-3d-14 ; correction de la répétition générale « 3s »).
//
// La salle n'écrit JAMAIS sa demande dans `autonomy_requests` (omo-activation.ts, L22c : l'API de L10a n'accepte ni « omo » ni un
// montant en chaîne, et la surveillance de L10c relirait une ligne de la salle avec les plafonds d'« Autonome avec contrôle », ce
// que Q7 interdit ; la demande de contrat L22c va au paquet d'ouverture de la salle, A35). Elle la tient à deux endroits, lus ici :
// - la ligne « omo » de conversation_autonomy (ConversationAutonomyStore.writeOmo) : `plafonds.demande` vaut {id, debut} dès
//   l'envoi confirmé (écrit AVANT que la demande soit active : si l'écriture échoue, rien ne part), puis null à la fin de la demande
//   (endRequest) ou au démarrage qui la dit « interrompue » (interruptSalleAtStartup) ;
// - la demande active du port omoActivation (`activeRequest()`, en mémoire), une seule dans la salle (D-2b-08).
// La dernière ligne `autonomy_requests` de la racine (règle écrite de D-3d-09) reste lue par l'appelant, avec sa propre requête, et
// passée ici : elle ne peut que fermer.
//
// Règle, fermée en cas de doute, jamais ouverte par défaut :
// - une source illisible (table illisible, ligne « omo » dont le contenu n'a pas la forme écrite par writeOmo, port qui lève ou qui
//   rend une valeur illisible) → fin inconnue (null) ;
// - sinon, une source qui dit la demande en cours (ligne « omo » avec une demande, demande active sur CETTE racine, dernière ligne
//   `autonomy_requests` sans `ended_at`) → en cours ;
// - sinon, une source qui dit une demande finie → finie ;
// - aucune source → null (aucune demande connue : refus en Simple, D-3d-09).
// Lecture seule et synchrone : aucune requête à opencode (ni au client principal ni à celui de la salle), aucune écriture, SQL
// paramétré. Le journal ne porte que l'identifiant de la racine et le NOM d'une erreur.
import { z } from "zod";
import type { Salle3dDeps } from "./contracts-3d.ts";

/** Dernière demande d'une racine, telle que revoirAcces la lit ; null : aucune, ou fin inconnue. */
export type DemandeLue = { finie: boolean } | null;

/** Ce qu'une source dit de la demande de la racine. */
type Source = "absente" | "illisible" | { finie: boolean };

/**
 * Forme de `plafonds` d'une ligne « omo », recopiée du magasin (conversation-autonomy.ts, `omoPlafondsSchema`, que ce module ne
 * modifie pas) : tout écart, champ en trop compris, rend la ligne illisible. croisements-3d-salle.test.ts écrit ses lignes par le
 * magasin réel : une forme qui changerait là ferait tomber ce test au lieu d'ouvrir « Revoir ».
 */
const plafondsOmoSchema = z.strictObject({
  plafondUsd: z.string().max(32).nullable(),
  demande: z.strictObject({ id: z.string().min(1).max(128), debut: z.number().int().nonnegative() }).nullable(),
});

const LIGNE_OMO_SQL = "SELECT plafonds FROM conversation_autonomy WHERE root_id = ? AND choix = 'omo'";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

type Deps = Pick<Salle3dDeps, "db" | "ports" | "log">;

/** Nom d'une erreur pour le journal, jamais son message (qui pourrait citer une requête ou une valeur). */
const nomErreur = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

/** Contenu `plafonds` d'une ligne « omo » : demande en cours ({id, debut}), finie (null), ou illisible. */
function demandeDeLaLigneOmo(plafonds: unknown): Source {
  if (typeof plafonds !== "string") return "illisible";
  let brut: unknown;
  try {
    brut = JSON.parse(plafonds);
  } catch {
    return "illisible";
  }
  const lu = plafondsOmoSchema.safeParse(brut);
  if (!lu.success) return "illisible";
  return { finie: lu.data.demande === null };
}

/** Ligne « omo » de conversation_autonomy de la racine. */
function ligneOmo(deps: Deps, rootId: string): Source {
  let row: { plafonds?: unknown } | undefined;
  try {
    row = deps.db.prepare(LIGNE_OMO_SQL).get(rootId) as { plafonds?: unknown } | undefined;
  } catch (err: unknown) {
    deps.log.warn("salle : demande de la racine illisible, fin inconnue", { rootId, erreur: nomErreur(err) });
    return "illisible";
  }
  if (row === undefined) return "absente";
  return demandeDeLaLigneOmo(row.plafonds);
}

/** Demande active du port omoActivation : en cours si elle est sur CETTE racine ; port neutre (salle coupée) : absente. */
function demandeActive(deps: Deps, rootId: string): Source {
  let active: unknown;
  try {
    active = deps.ports.omoActivation.activeRequest();
  } catch (err: unknown) {
    deps.log.warn("salle : demande active illisible, fin inconnue", { rootId, erreur: nomErreur(err) });
    return "illisible";
  }
  if (active === null) return "absente";
  if (!isRecord(active) || typeof active.rootId !== "string") return "illisible";
  return active.rootId === rootId ? { finie: false } : "absente";
}

/** Dernière ligne `autonomy_requests`, lue par l'appelant : `finie` qui n'est pas un booléen → illisible. */
function ligneAutonomie(derniereLigne: DemandeLue): Source {
  if (derniereLigne === null) return "absente";
  return typeof derniereLigne.finie === "boolean" ? { finie: derniereLigne.finie } : "illisible";
}

/**
 * Dernière demande d'une racine de la salle (ou d'instance illisible, traitée comme la salle) : ligne « omo », demande active du
 * port, et `derniereLigne` (dernière ligne `autonomy_requests`, lue par l'appelant). Fermée en cas de doute (en-tête du module).
 */
export function demandeDeLaSalle(deps: Deps, rootId: string, derniereLigne: DemandeLue): DemandeLue {
  const sources: Source[] = [ligneOmo(deps, rootId), demandeActive(deps, rootId), ligneAutonomie(derniereLigne)];
  if (sources.includes("illisible")) return null;
  const lues = sources.filter((source): source is { finie: boolean } => typeof source === "object");
  if (lues.length === 0) return null;
  return { finie: lues.every((source) => source.finie) };
}
