// Propriétaire : L47b.
// Route dédiée de la chronologie (itération 5, plan d'exécution it5 fiche L47b, D-5-09 ; spécification §2.1 l.63, §5.1
// l.883-884, §5.5 l.920). Module `chronologie` de la construction, groupe de routes « construction » : AUCUNE route n'est
// ajoutée dans http.ts, ni maintenant ni plus tard (§2.2). Sans le module, la route reste absente (404 de l'itération 1).
//
// GET /api/conversations/:rootId/chronologie → ChronologieResponse : les lignes `usage` de la conversation, telles qu'elles sont
// enregistrées, pour que l'interface les rapproche des faits du Déroulé par le module pur shared/chronologie.ts (L47a).
// - identifiant validé par shared/ids.ts (invalide → 400), SQL PARAMÉTRÉ (jamais de concaténation d'une valeur) ;
// - racine connue de `sessions` ET sans parent, sinon 404 « racine-inconnue » : la chronologie d'une conversation est celle de
//   son arbre entier, jamais celle d'une session déléguée prise isolément (ses lignes `usage` portent la racine, pas elle) ;
// - une conversation qu'opencode n'a plus (`deleted_at`) garde sa chronologie : les Archives la montrent encore, et les lignes
//   `usage` du registre, elles, ne sont pas supprimées avec la session ;
// - CHRONO_MAX_ROWS lignes au plus, les plus anciennes d'abord, `tronque` quand il y en avait davantage ;
// - AUCUN TEXTE rendu : des identifiants, des codes de fournisseur et d'IA, des nombres et des instants. Ni titre, ni consigne,
//   ni réponse, ni message d'erreur d'appel ne sortent d'ici, donc aucun masquage de secret n'a à être fait sur cette réponse.
// LECTURE SEULE : aucune écriture, aucune migration (le numéro 9 reste inutilisé, A2, A2 bis, D-5-03).
//
// DEUX MODES : le serveur ne masque RIEN et rend la même chose en Simple et en Avancé. C'est l'interface (Deroule.tsx,
// Chronologie.tsx) qui ne montre la chronologie qu'en mode Avancé, « jeton » étant interdit en Simple (§4.3).
// Rappel D-5-17 : la chronologie d'une racine de la SALLE en Simple devra répondre 403, comme /facts (L18c). Le code de la salle
// n'est pas dans la construction : ce point est traité par GF5 à la grande fusion, et rien n'en est anticipé ici.
import type { Context, Hono } from "hono";
import type { ConstructionModule } from "./construction-contracts.ts";
import type { Cockpit11, Registrar } from "./contracts-11.ts";
import { CHRONO_MAX_ROWS, CONSTRUCTION_ROUTE_PATHS } from "./shared/construction-constants.ts";
import { TEXTES } from "./shared/construction-texts.ts";
import type { ChronologieResponse, ChronologieUsageRow } from "./shared/construction-types.ts";
import { SESSION_ID_RE } from "./shared/ids.ts";

/** Ligne `usage` telle que la base la rend (colonnes de db.ts, `variant` ajoutée par une migration antérieure). */
interface UsageRow {
  message_id: string;
  session_id: string;
  agent: string;
  provider_id: string;
  model_id: string;
  variant: string | null;
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  cost: number;
  created_at: number;
  completed_at: number | null;
}

/**
 * Colonnes lues, nommées une par une : `SELECT *` ferait sortir `directory`, `parent_message_id` et `error` — un chemin de
 * travail et un message d'erreur d'opencode, donc du texte, que cette réponse ne doit pas porter.
 */
const COLONNES = `message_id, session_id, agent, provider_id, model_id, variant, tokens_input, tokens_output, tokens_reasoning,
  tokens_cache_read, tokens_cache_write, cost, created_at, completed_at`;

/** Nombre fini et positif, ou 0 : une colonne vide ou abîmée ne devient jamais NaN dans la vue. */
const nombre = (valeur: unknown): number => (typeof valeur === "number" && Number.isFinite(valeur) && valeur > 0 ? valeur : 0);

const texte = (valeur: unknown): string => (typeof valeur === "string" ? valeur : "");

/**
 * Lignes `usage` d'une conversation, les plus anciennes d'abord ; `tronque` quand la base en avait plus que CHRONO_MAX_ROWS
 * (une ligne de plus est demandée pour le savoir sans second comptage). L'ordre est total (`created_at` puis `message_id`) :
 * deux lectures de la même base rendent la même liste, ce que le module pur attend pour rester déterministe.
 */
export function chronologieRows(db: Cockpit11["db"], rootId: string): ChronologieResponse {
  const lignes = db
    .prepare(
      `SELECT ${COLONNES} FROM usage WHERE root_id = :root
       ORDER BY created_at, message_id LIMIT :max`,
    )
    .all({ root: rootId, max: CHRONO_MAX_ROWS + 1 }) as unknown as UsageRow[];
  const rows: ChronologieUsageRow[] = lignes.slice(0, CHRONO_MAX_ROWS).map((ligne) => ({
    messageId: ligne.message_id,
    sessionId: ligne.session_id,
    agent: texte(ligne.agent),
    providerId: texte(ligne.provider_id),
    modelId: texte(ligne.model_id),
    variant: typeof ligne.variant === "string" && ligne.variant !== "" ? ligne.variant : null,
    tokensInput: nombre(ligne.tokens_input),
    tokensOutput: nombre(ligne.tokens_output),
    tokensReasoning: nombre(ligne.tokens_reasoning),
    tokensCacheRead: nombre(ligne.tokens_cache_read),
    tokensCacheWrite: nombre(ligne.tokens_cache_write),
    cost: nombre(ligne.cost),
    createdAt: ligne.created_at,
    completedAt: typeof ligne.completed_at === "number" ? ligne.completed_at : null,
  }));
  return { rootId, rows, tronque: lignes.length > CHRONO_MAX_ROWS };
}

/** La conversation est une racine connue du cockpit : enregistrée dans `sessions` et sans parent. */
export function estRacine(c11: Pick<Cockpit11, "sessions">, rootId: string): boolean {
  const row = c11.sessions.get(rootId);
  return row !== undefined && row.parent_id === null;
}

const invalide = (c: Context) => c.json({ error: "invalid", message: "Identifiant de conversation invalide." }, 400);
const inconnue = (c: Context) => c.json({ error: "racine-inconnue", message: TEXTES.partout.erreurs["racine-inconnue"] }, 404);

export function registerChronologieRoutes(app: Hono, c11: Pick<Cockpit11, "db" | "sessions">): void {
  app.get(CONSTRUCTION_ROUTE_PATHS.chronologie, (c) => {
    const rootId = c.req.param("rootId");
    if (!SESSION_ID_RE.test(rootId)) return invalide(c);
    if (!estRacine(c11, rootId)) return inconnue(c);
    return c.json(chronologieRows(c11.db, rootId));
  });
}

export const chronologieModule: ConstructionModule = {
  name: "chronologie",
  install(reg: Registrar, c11: Cockpit11) {
    reg.routes("construction", (app) => registerChronologieRoutes(app, c11));
  },
};
