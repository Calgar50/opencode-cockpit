// Point unique de suppression d'une conversation (D-07, spécification §3.5) : appelé par ArchiveService.remove, et par lui seul.
// Une conversation supprimée dans opencode mais gardée aux Archives garde ses faits (Déroulé des Archives) : rien n'est purgé
// sur session.deleted.
import type { DatabaseSync } from "node:sqlite";
import { purgeConsignes } from "./consignes-store.ts"; // [3d] copies locales des consignes (itération 3, L28d)
import { transaction } from "./db.ts";

/** Lignes touchées par une purge. */
export interface PurgeResult {
  /** Exécutions d'équipe dont les précisions ont été vidées. */
  runs: number;
  /** Étapes dont le texte envoyé ou l'extrait du résultat a été vidé. */
  steps: number;
  /** Décisions d'autonomie dont le résumé ou la raison a été vidé. */
  decisions: number;
  /** Faits d'activité supprimés. */
  facts: number;
}

/**
 * Sessions de la conversation : la racine et toute session suivie rattachée à elle. Une ligne écrite sous une racine provisoire
 * (session enregistrée avant ses ancêtres, puis rattachée par SessionTracker) reste ainsi purgée. Lue par les index
 * idx_sessions_root puis *_root des tables purgées.
 */
const TREE_SQL = "SELECT :root UNION SELECT id FROM sessions WHERE root_id = :root";

/**
 * Vide les textes 1.1 d'une conversation (texte exact envoyé à une étape, extrait de résultat, précisions d'une exécution, résumé
 * et raison d'une décision) et supprime ses faits d'activité. Empreintes, IA, coûts, états et compteurs restent : le registre
 * des coûts et les tableaux de bord ne changent pas. Atomique : dans la transaction de l'appelant s'il y en a une, sinon dans
 * la sienne.
 */
export function purgeConversation(db: DatabaseSync, rootId: string): PurgeResult {
  const purge = (): PurgeResult => {
    const root = { root: rootId };
    const steps = db
      .prepare(
        `UPDATE team_run_steps SET message_text = NULL, result_excerpt = NULL
         WHERE run_id IN (SELECT id FROM team_runs WHERE root_session_id IN (${TREE_SQL}))
           AND (message_text IS NOT NULL OR result_excerpt IS NOT NULL)`,
      )
      .run(root);
    const runs = db
      .prepare(`UPDATE team_runs SET precisions = '[]' WHERE root_session_id IN (${TREE_SQL}) AND precisions != '[]'`)
      .run(root);
    const decisions = db
      .prepare(`UPDATE autonomy_decisions SET resume = '', raison = '' WHERE root_id IN (${TREE_SQL}) AND (resume != '' OR raison != '')`)
      .run(root);
    const facts = db.prepare(`DELETE FROM activity_facts WHERE root_id IN (${TREE_SQL})`).run(root);
    purgeConsignes(db, rootId); // [3d] copies locales des consignes, même politique que les faits (U2, D-3d-30 ; itération 3, L28d)
    return { runs: Number(runs.changes), steps: Number(steps.changes), decisions: Number(decisions.changes), facts: Number(facts.changes) };
  };
  return db.isTransaction ? purge() : transaction(db, purge);
}
