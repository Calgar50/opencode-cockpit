// Propriétaire : L46a.
// Coûts par équipe, archives d'équipe et filtre « Avec une équipe » (itération 5, plan d'exécution it5 fiche L46a, D-5-10,
// D-5-11 ; spécification §7.9 l.1204, §3.5 l.244-246). Module de la construction, groupe de routes « construction ».
//
// LECTURE SEULE : aucune écriture, aucune migration. Les tables `teams`, `team_runs`, `team_run_steps` et `team_run_events`
// existent DEPUIS LA MIGRATION 4 (db.ts) : la construction n'en ajoute aucune et le numéro 9 reste réservé et inutilisé
// (A2, A2 bis, D-5-03). Le code de l'itération 4 n'est pas encore dans cette branche : on lit les tables directement, en SQL
// PARAMÉTRÉ (jamais de concaténation d'une valeur dans une requête).
//
// Trois routes, toutes des GET, rendues à l'identique en mode Simple et en mode Avancé (le serveur ne lit pas le mode ; c'est
// l'interface qui décide ce qu'elle montre, U1) :
// - GET /api/usage/equipes?month=AAAA-MM → TeamCostsResponse. Le coût d'un lancement est la somme des `usage.cost` des sessions
//   de ses étapes (`team_run_steps.session_id`) ; sans aucune ligne `usage`, le coût enregistré du lancement (`team_runs.cost`)
//   fait foi. Le mois se lit sur `team_runs.created_at`. Regroupement par `team_id` tant que l'équipe existe, sinon par
//   `team_titre` (équipe supprimée : ses lancements restent comptés, `teamId` vaut null). « Estimé en général » est la moyenne
//   des `estimate_typique` enregistrés. Les TEAM_COSTS_TOP lancements les plus coûteux sont rendus à part.
// - GET /api/archives/:rootId/equipes → ArchiveTeamsResponse : lancements de la conversation, étapes par `ordre`, `tour` puis
//   `tentative`. `extrait` est le début du résultat, MASQUÉ par redactSecrets puis coupé à ARCHIVE_EXCERPT_MAX ; il vaut null
//   quand la purge d'une conversation l'a vidé (conversation-purge.ts) — les coûts, eux, restent.
// - GET /api/equipes/conversations → TeamConversationsResponse : racines qui ont lancé une équipe, TEAM_CONVERSATIONS_MAX au
//   plus, `tronque` quand il y en a davantage. Le filtre « Avec une équipe » des Archives est appliqué CÔTÉ CLIENT sur cette
//   liste (D-5-11) : ni `archive.list` ni les routes de http.ts ne changent.
//
// `teamRunsMarkdown` rend le résumé ajouté en fin d'export Markdown par archive.ts : un tableau Étape · Assistant · IA · État ·
// Coût, SANS AUCUN EXTRAIT (D-5-10). Sa lecture ne demande même pas la colonne `result_excerpt` : un extrait ne peut donc pas
// se glisser dans un fichier exporté, quoi que fasse le rendu. Les extraits ne sont visibles que dans l'interface.
//
// Tout texte lu dans la base (titre d'équipe, titre d'étape, assistant, IA, verdict, choix, cause, extrait) passe par
// `redactSecrets` AVANT d'être coupé : une coupe faite avant le masquage laisserait passer le début d'un secret.
import type { DatabaseSync } from "node:sqlite";
import type { Hono } from "hono";
import type { ConstructionModule } from "./construction-contracts.ts";
import type { Cockpit11, Registrar } from "./contracts-11.ts";
import { MONTH_RE, monthBounds, monthKey } from "./ledger.ts";
import { roundUsd } from "./pricing.ts";
import { redactSecrets } from "./redact.ts";
import {
  ARCHIVE_EXCERPT_MAX,
  CONSTRUCTION_ROUTE_PATHS,
  TEAM_CONVERSATIONS_MAX,
  TEAM_COSTS_MONTH_PARAM,
  TEAM_COSTS_TOP,
} from "./shared/construction-constants.ts";
import { TEXTES } from "./shared/construction-texts.ts";
import type {
  ArchiveTeamRun,
  ArchiveTeamStep,
  ArchiveTeamsResponse,
  TeamConversationsResponse,
  TeamCostRow,
  TeamCostsResponse,
  TeamRunCostRow,
} from "./shared/construction-types.ts";
import { SESSION_ID_RE } from "./shared/ids.ts";
import { remplir } from "./shared/neon-texts.ts";

// --- Bornes et fragments de requête ---------------------------------------------------------------------------------------

/** Étapes lues au plus pour une conversation : au-delà, les plus anciennes font foi (aucune archive n'en a autant). */
export const ARCHIVE_STEPS_MAX = 2_000;

/** Libellé court lu dans la base (titre, assistant, IA, verdict, choix, cause) : caractères gardés après masquage. */
export const TEAM_LABEL_MAX = 200;

/**
 * Coût d'un lancement `tr` : somme des lignes `usage` des sessions de ses étapes ; sans aucune ligne (sous-requête vide → SUM
 * null), le coût enregistré du lancement fait foi. Fragment SQL constant, sans aucune valeur interpolée.
 */
const COUT_LANCEMENT_SQL = `COALESCE(
  (SELECT SUM(u.cost) FROM usage u
    WHERE u.session_id IN (SELECT trs.session_id FROM team_run_steps trs WHERE trs.run_id = tr.id AND trs.session_id IS NOT NULL)),
  tr.cost)`;

/** Colonnes d'un lancement, communes aux deux lectures. */
const COLONNES_LANCEMENT = `tr.id AS id, tr.team_id AS team_id, tr.team_titre AS team_titre, tr.root_session_id AS root_session_id,
  tr.directory AS directory, tr.state AS state, tr.cause AS cause, tr.estimate_typique AS estimate_typique, tr.plafond AS plafond,
  tr.created_at AS created_at, tr.ended_at AS ended_at,
  (SELECT COUNT(*) FROM teams t WHERE t.id = tr.team_id) AS equipe_presente,
  ${COUT_LANCEMENT_SQL} AS cout`;

// --- Lignes lues ------------------------------------------------------------------------------------------------------------

interface RunRow {
  id: string;
  team_id: string | null;
  team_titre: string;
  root_session_id: string;
  directory: string;
  state: string;
  cause: string | null;
  estimate_typique: number | null;
  plafond: number | null;
  created_at: number;
  ended_at: number | null;
  equipe_presente: number;
  cout: number;
}

interface StepRow {
  run_id: string;
  step_id: string;
  titre: string;
  agent: string;
  model: string | null;
  state: string;
  tour: number;
  verdict: string | null;
  choix: string | null;
  cost: number;
  result_excerpt: string | null;
}

// --- Masquage et mise en forme ------------------------------------------------------------------------------------------------

/** Texte de la base rendu à l'interface : masqué PUIS coupé (l'ordre inverse laisserait passer le début d'un secret). */
function libelle(valeur: string | null): string {
  return valeur === null ? "" : redactSecrets(valeur).slice(0, TEAM_LABEL_MAX);
}

/** Même règle, mais « rien d'enregistré » reste distinct d'une chaîne vide. */
function libelleOuNull(valeur: string | null): string | null {
  return valeur === null ? null : redactSecrets(valeur).slice(0, TEAM_LABEL_MAX);
}

/** Titre affiché d'un lancement : celui enregistré au lancement, ou « Équipe supprimée » quand rien n'a été gardé. */
function titreLancement(teamTitre: string): string {
  const titre = libelle(teamTitre).trim();
  return titre === "" ? TEXTES.partout.couts.equipeSupprimee : titre;
}

/** Cellule d'un tableau Markdown : barres verticales échappées, retours à la ligne repliés (une ligne = une étape). */
function celluleMarkdown(valeur: string): string {
  return valeur.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\s*[\r\n]+\s*/g, " ").trim();
}

/** Montant écrit dans l'export Markdown, au centième de millième de dollar près, comme l'en-tête `cout_usd` des archives. */
function montantMarkdown(usd: number): string {
  return `${(Math.round(usd * 10_000) / 10_000).toFixed(4)} $`;
}

// --- Lectures ---------------------------------------------------------------------------------------------------------------

/** Étapes d'une conversation, par lancement puis `ordre`, `tour`, `tentative`. `extraits` faux : la colonne n'est même pas lue. */
function lireEtapes(db: DatabaseSync, rootId: string, extraits: boolean): StepRow[] {
  const excerpt = extraits ? "trs.result_excerpt AS result_excerpt" : "NULL AS result_excerpt";
  return db
    .prepare(
      `SELECT trs.run_id AS run_id, trs.step_id AS step_id, trs.titre AS titre, trs.agent AS agent, trs.model AS model,
              trs.state AS state, trs.tour AS tour, trs.verdict AS verdict, trs.choix AS choix, trs.cost AS cost, ${excerpt}
       FROM team_run_steps trs
       WHERE trs.run_id IN (SELECT tr.id FROM team_runs tr WHERE tr.root_session_id = :root)
       ORDER BY trs.run_id, trs.ordre, trs.tour, trs.tentative
       LIMIT :max`,
    )
    .all({ root: rootId, max: ARCHIVE_STEPS_MAX }) as unknown as StepRow[];
}

/**
 * Lancements d'une conversation, étapes comprises. `extraits` faux : aucun extrait n'est lu ni rendu (export Markdown, D-5-10).
 * `tour` n'est rendu que lorsque le lancement a enregistré plusieurs tours pour cette étape : « tour 1 » partout n'apprendrait
 * rien, et une relecture qui revient une deuxième fois doit se voir.
 */
function lireLancements(db: DatabaseSync, rootId: string, extraits: boolean): ArchiveTeamRun[] {
  const runs = db
    .prepare(`SELECT ${COLONNES_LANCEMENT} FROM team_runs tr WHERE tr.root_session_id = :root ORDER BY tr.created_at, tr.id`)
    .all({ root: rootId }) as unknown as RunRow[];
  if (runs.length === 0) return [];
  const etapes = lireEtapes(db, rootId, extraits);
  /** Nombre de tours distincts enregistrés par étape, clé « lancement/étape ». */
  const tours = new Map<string, Set<number>>();
  for (const row of etapes) {
    const cle = `${row.run_id}/${row.step_id}`;
    const vus = tours.get(cle) ?? new Set<number>();
    vus.add(row.tour);
    tours.set(cle, vus);
  }
  return runs.map((run): ArchiveTeamRun => {
    const siennes = etapes.filter((row) => row.run_id === run.id);
    return {
      runId: run.id,
      titre: titreLancement(run.team_titre),
      etat: run.state,
      cause: libelleOuNull(run.cause),
      cout: roundUsd(run.cout),
      estimeTypique: run.estimate_typique === null ? null : roundUsd(run.estimate_typique),
      plafond: run.plafond,
      debut: run.created_at,
      fin: run.ended_at,
      etapes: siennes.map(
        (row): ArchiveTeamStep => ({
          titre: libelle(row.titre),
          agent: libelle(row.agent),
          ia: libelle(row.model),
          etat: row.state,
          tour: (tours.get(`${row.run_id}/${row.step_id}`)?.size ?? 1) > 1 ? row.tour : null,
          verdict: libelleOuNull(row.verdict),
          choix: libelleOuNull(row.choix),
          cout: roundUsd(row.cost),
          // Masqué PUIS coupé ; null quand la purge l'a vidé (« Détail des étapes indisponible… », les coûts restent).
          extrait: row.result_excerpt === null ? null : redactSecrets(row.result_excerpt).slice(0, ARCHIVE_EXCERPT_MAX),
        }),
      ),
    };
  });
}

// --- Réponses ------------------------------------------------------------------------------------------------------------------

/** Coûts par équipe du mois `mois` (AAAA-MM, déjà validé par l'appelant) : lignes par équipe et lancements les plus coûteux. */
export function teamCosts(db: DatabaseSync, mois: string): TeamCostsResponse {
  const { start, end } = monthBounds(mois);
  const runs = db
    .prepare(
      `SELECT ${COLONNES_LANCEMENT} FROM team_runs tr
       WHERE tr.created_at >= :start AND tr.created_at < :end
       ORDER BY tr.created_at, tr.id`,
    )
    .all({ start, end }) as unknown as RunRow[];

  interface Groupe {
    cle: string;
    teamId: string | null;
    titre: string;
    lancements: number;
    cout: number;
    estimes: number[];
  }
  const groupes = new Map<string, Groupe>();
  for (const run of runs) {
    // Équipe supprimée (ou lancement sans équipe) : on regroupe sur le titre enregistré, et `teamId` reste null.
    const presente = run.team_id !== null && run.equipe_presente > 0;
    const titre = titreLancement(run.team_titre);
    const cle = presente ? `id:${run.team_id}` : `titre:${titre}`;
    const groupe = groupes.get(cle) ?? { cle, teamId: presente ? run.team_id : null, titre, lancements: 0, cout: 0, estimes: [] };
    groupe.lancements += 1;
    groupe.cout += run.cout;
    if (run.estimate_typique !== null) groupe.estimes.push(run.estimate_typique);
    groupes.set(cle, groupe);
  }

  const parEquipe = [...groupes.values()]
    .map(
      (groupe): TeamCostRow & { cle: string } => ({
        cle: groupe.cle,
        teamId: groupe.teamId,
        titre: groupe.titre,
        lancements: groupe.lancements,
        cout: roundUsd(groupe.cout),
        moyenne: roundUsd(groupe.cout / groupe.lancements),
        estimeTypique: groupe.estimes.length === 0 ? null : roundUsd(groupe.estimes.reduce((a, b) => a + b, 0) / groupe.estimes.length),
      }),
    )
    // Coût décroissant ; à coût égal, un ordre total (titre puis clé) pour que deux lectures rendent la même liste.
    .sort((a, b) => b.cout - a.cout || (a.titre < b.titre ? -1 : a.titre > b.titre ? 1 : a.cle < b.cle ? -1 : a.cle > b.cle ? 1 : 0))
    .map(({ cle: _cle, ...ligne }) => ligne);

  const lancements = runs
    .map(
      (run): TeamRunCostRow => ({
        runId: run.id,
        titre: titreLancement(run.team_titre),
        rootId: run.root_session_id,
        directory: run.directory,
        etat: run.state,
        cout: roundUsd(run.cout),
        estimeTypique: run.estimate_typique === null ? null : roundUsd(run.estimate_typique),
        plafond: run.plafond,
        debut: run.created_at,
      }),
    )
    .sort((a, b) => b.cout - a.cout || b.debut - a.debut || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0))
    .slice(0, TEAM_COSTS_TOP);

  return { mois, parEquipe, lancements };
}

/** Lancements d'équipe archivés d'une conversation, extraits masqués compris (l'interface seule les montre). */
export function archiveTeams(db: DatabaseSync, rootId: string): ArchiveTeamsResponse {
  return { rootId, lancements: lireLancements(db, rootId, true) };
}

/** Racines qui ont lancé une équipe, la plus récente d'abord ; `tronque` quand il y en a plus que TEAM_CONVERSATIONS_MAX. */
export function teamConversations(db: DatabaseSync): TeamConversationsResponse {
  const rows = db
    .prepare(
      `SELECT tr.root_session_id AS root_id, MAX(tr.created_at) AS dernier
       FROM team_runs tr GROUP BY tr.root_session_id
       ORDER BY dernier DESC, tr.root_session_id LIMIT :max`,
    )
    .all({ max: TEAM_CONVERSATIONS_MAX + 1 }) as unknown as Array<{ root_id: string; dernier: number }>;
  return { rootIds: rows.slice(0, TEAM_CONVERSATIONS_MAX).map((row) => row.root_id), tronque: rows.length > TEAM_CONVERSATIONS_MAX };
}

/**
 * Résumé des lancements d'équipe ajouté en fin d'export Markdown (archive.ts, D-5-10) : un titre et un tableau Étape ·
 * Assistant · IA · État · Coût par lancement, SANS EXTRAIT. Chaîne vide quand la conversation n'a lancé aucune équipe :
 * l'export reste alors celui de l'itération 1, à l'octet.
 */
export function teamRunsMarkdown(db: DatabaseSync, rootId: string): string {
  const lancements = lireLancements(db, rootId, false);
  if (lancements.length === 0) return "";
  const lignes: string[] = [];
  for (const run of lancements) {
    lignes.push(`## ${remplir(TEXTES.partout.archives.titreMarkdown, { equipe: run.titre })}`, "");
    lignes.push("| Étape | Assistant | IA | État | Coût |", "| --- | --- | --- | --- | --- |");
    for (const etape of run.etapes) {
      const cellules = [etape.titre, etape.agent, etape.ia, etape.etat].map(celluleMarkdown);
      lignes.push(`| ${cellules.join(" | ")} | ${montantMarkdown(etape.cout)} |`);
    }
    lignes.push("");
  }
  return `${lignes.join("\n").trimEnd()}\n`;
}

// --- Routes et module ------------------------------------------------------------------------------------------------------

const invalide = (message: string) => ({ error: "invalid", message }) as const;

export function registerTeamCostsRoutes(app: Hono, c11: Pick<Cockpit11, "db">): void {
  app.get(CONSTRUCTION_ROUTE_PATHS.coutsEquipes, (c) => {
    const mois = c.req.query(TEAM_COSTS_MONTH_PARAM) ?? monthKey(Date.now());
    if (!MONTH_RE.test(mois)) return c.json(invalide("Mois invalide (AAAA-MM)."), 400);
    return c.json(teamCosts(c11.db, mois));
  });

  app.get(CONSTRUCTION_ROUTE_PATHS.archivesEquipes, (c) => {
    const rootId = c.req.param("rootId");
    if (!SESSION_ID_RE.test(rootId)) return c.json(invalide("Identifiant de conversation invalide."), 400);
    return c.json(archiveTeams(c11.db, rootId));
  });

  app.get(CONSTRUCTION_ROUTE_PATHS.equipesConversations, (c) => c.json(teamConversations(c11.db)));
}

export const teamCostsModule: ConstructionModule = {
  name: "teamCosts",
  install(reg: Registrar, c11: Cockpit11) {
    reg.routes("construction", (app) => registerTeamCostsRoutes(app, c11));
  },
};
