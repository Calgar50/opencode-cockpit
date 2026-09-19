// Propriétaire : L28d.
// Consignes gardées localement pour « Revoir » (U2, D-3d-30) : copie bornée et masquée de chaque consigne transmise à un
// sous-assistant, table revoir_consignes (migration 8, écrite par L28d seul). `enregistrer` est aussi l'API publique de la jonction
// des étapes d'équipe (GF3 du plan it5), qui l'appelle sans écrire ce fichier. Jamais journalisée.
// Squelette T3d-a : magasin neutre, AUCUN accès à la base (ni db.ts, ni table) : lire → null, parEnfant → [], enregistrer → rien.
import type { DatabaseSync } from "node:sqlite";
import type { ConsignesPort, Salle3dDeps } from "./contracts-3d.ts";

/** Consigne à garder : `brut` est le texte envoyé, masqué puis borné par le magasin avant toute écriture. */
export interface ConsigneAGarder {
  rootId: string;
  /** Session qui a confié le travail (clé naturelle : parent, callId). */
  parent: string;
  /** Session qui reçoit la consigne ; null si inconnue. */
  enfant: string | null;
  /** callID de la partie `task`, ou clé d'étape d'équipe « etape-<tour>-<tentative>-<session> » (ID_RE). */
  callId: string;
  brut: string;
  at: number;
}

export interface ConsignesStore extends ConsignesPort {
  enregistrer(consigne: ConsigneAGarder): void;
}

export function createConsignesStore(_db: DatabaseSync): ConsignesStore {
  return {
    lire: () => null,
    parEnfant: () => [],
    enregistrer: () => undefined,
  };
}

/** Port `consignes` de « Revoir » : lecture seule du magasin. */
export function createConsignesPort(deps: Salle3dDeps): ConsignesPort {
  const store = createConsignesStore(deps.db);
  return { lire: (rootId, callId) => store.lire(rootId, callId), parEnfant: (rootId, enfant) => store.parEnfant(rootId, enfant) };
}
