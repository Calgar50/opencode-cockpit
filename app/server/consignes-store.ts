// Propriétaire : L28d.
// Consignes gardées localement pour « Revoir » (U2, D-3d-30) : copie bornée et masquée de chaque consigne transmise à un
// sous-assistant, table revoir_consignes (migration 8, écrite par L28d seul). `enregistrer` est aussi l'API publique de la jonction
// des étapes d'équipe (GF3 du plan it5), qui l'appelle sans écrire ce fichier. Jamais journalisée.
// Écriture : INSERT OR IGNORE paramétré, après bornerConsigne(brut, redactSecrets) ; aucune requête construite par concaténation
// de valeurs. Lecture : synchrone, en base seulement, jamais une requête à opencode. Purge : purgeConsignes, appelée par la ligne
// [3d] de conversation-purge.ts (point unique D-07).
import type { ConsignesPort, Salle3dDeps } from "./contracts-3d.ts";
import type { Db } from "./db.ts";
import { redactSecrets } from "./redact.ts";
import { bornerConsigne, CONSIGNES } from "./shared/consignes.ts";
import { ID_RE, SESSION_ID_RE } from "./shared/ids.ts";
import type { RevoirConsigneResponse } from "./shared/salle3d-types.ts";

/** Consignes rendues au plus par `parEnfant` (D-3d-30). */
export const PAR_ENFANT_MAX = 20;

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

/**
 * Résultat d'un enregistrement : écrit ; déjà gardé pour ce couple (parent, callId) ; conversation à sa borne (rien d'écrit) ;
 * identifiant refusé par ID_RE ou SESSION_ID_RE (rien d'écrit).
 */
export type ConsigneEcriture = "enregistree" | "doublon" | "limite" | "cle-invalide";

export interface ConsignesStore extends ConsignesPort {
  enregistrer(consigne: ConsigneAGarder): ConsigneEcriture;
}

/** Ligne lue, telle que la rend SQLite (tronque : 0 ou 1). */
interface ConsigneRow {
  root_id: string;
  call_id: string;
  enfant_session_id: string | null;
  texte: string;
  longueur: number;
  tronque: number;
  at: number;
}

/**
 * Sessions de la conversation : recopié de TREE_SQL de conversation-purge.ts (la racine et toute session suivie rattachée à elle),
 * pour que la purge des consignes porte exactement sur le même arbre que purgeConversation. Un changement là-bas se recopie ici.
 */
const TREE_SQL = "SELECT :root UNION SELECT id FROM sessions WHERE root_id = :root";

const INSERT_SQL = `INSERT OR IGNORE INTO revoir_consignes
  (root_id, parent_session_id, enfant_session_id, call_id, texte, longueur, tronque, at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

const COLONNES = "root_id, call_id, enfant_session_id, texte, longueur, tronque, at";

const vue = (row: ConsigneRow): RevoirConsigneResponse => ({
  rootId: row.root_id,
  callId: row.call_id,
  enfant: row.enfant_session_id,
  texte: row.texte,
  longueur: Number(row.longueur),
  tronque: Number(row.tronque) !== 0,
  at: Number(row.at),
});

/** Identifiant de session accepté par les routes du cockpit ; `null` permis seulement pour l'enfant. */
const sessionValide = (id: string | null): boolean => id === null || SESSION_ID_RE.test(id);

export function createConsignesStore(db: Db): ConsignesStore {
  // Requêtes préparées à la première utilisation : la table existe dès l'ouverture de la base (migrate), mais le magasin est
  // construit au câblage, avant tout appel.
  const prepare = (() => {
    const cache = new Map<string, ReturnType<Db["prepare"]>>();
    return (sql: string) => {
      const known = cache.get(sql);
      if (known) return known;
      const statement = db.prepare(sql);
      cache.set(sql, statement);
      return statement;
    };
  })();

  return {
    enregistrer({ rootId, parent, enfant, callId, brut, at }: ConsigneAGarder): ConsigneEcriture {
      // Clé d'étape d'équipe comprise (D-3d-30) : le deux-points est refusé par ID_RE, rien n'est écrit.
      if (!ID_RE.test(callId) || !SESSION_ID_RE.test(rootId) || !SESSION_ID_RE.test(parent) || !sessionValide(enfant)) return "cle-invalide";
      const { n } = prepare("SELECT COUNT(*) AS n FROM revoir_consignes WHERE root_id = ?").get(rootId) as { n: number };
      if (Number(n) >= CONSIGNES.parRacine) return "limite";
      const { texte, longueur, tronque } = bornerConsigne(brut, redactSecrets);
      const instant = Number.isFinite(at) ? Math.trunc(at) : 0;
      const result = prepare(INSERT_SQL).run(rootId, parent, enfant, callId, texte, longueur, tronque ? 1 : 0, instant);
      return Number(result.changes) > 0 ? "enregistree" : "doublon";
    },

    lire(rootId: string, callId: string): RevoirConsigneResponse | null {
      if (!SESSION_ID_RE.test(rootId) || !ID_RE.test(callId)) return null;
      const row = prepare(`SELECT ${COLONNES} FROM revoir_consignes WHERE root_id = ? AND call_id = ? ORDER BY at, id LIMIT 1`).get(rootId, callId) as
        | ConsigneRow
        | undefined;
      return row ? vue(row) : null;
    },

    parEnfant(rootId: string, enfant: string): RevoirConsigneResponse[] {
      if (!SESSION_ID_RE.test(rootId) || !SESSION_ID_RE.test(enfant)) return [];
      // « par at croissant » (D-3d-30) ; `id` départage deux consignes de la même milliseconde, l'ordre reste celui de l'écriture.
      const rows = prepare(
        `SELECT ${COLONNES} FROM revoir_consignes WHERE root_id = ? AND enfant_session_id = ? ORDER BY at, id LIMIT ${PAR_ENFANT_MAX}`,
      ).all(rootId, enfant) as unknown as ConsigneRow[];
      return rows.map(vue);
    },
  };
}

/**
 * Supprime les copies gardées d'une conversation, sur le même arbre que purgeConversation (conversation-purge.ts, D-07) : appelée
 * par sa ligne [3d], donc dans la même transaction. Rend le nombre de lignes supprimées.
 */
export function purgeConsignes(db: Db, rootId: string): number {
  return Number(db.prepare(`DELETE FROM revoir_consignes WHERE root_id IN (${TREE_SQL})`).run({ root: rootId }).changes);
}

/** Port `consignes` de « Revoir » : lecture seule du magasin. */
export function createConsignesPort(deps: Salle3dDeps): ConsignesPort {
  const store = createConsignesStore(deps.db);
  return { lire: (rootId, callId) => store.lire(rootId, callId), parEnfant: (rootId, enfant) => store.parEnfant(rootId, enfant) };
}
