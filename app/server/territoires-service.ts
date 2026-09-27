// Propriétaire : L31a.
// Territoires du zoom 1 de la salle de contrôle (spécification §5.8 l.993, §5.9 l.1024, §6 l.1065, D-3d-13, D-3d-14, P11) : un
// territoire par projet, trois compteurs, enceinte de la Salle OMO.
// Lecture seule : aucune écriture en base, aucune écriture de configuration ; la seule requête à opencode est
// GET /session/status?directory=… sur l'INSTANCE PRINCIPALE, et seulement pour un dossier qui porte au moins une racine de cette
// instance (P11 : rien n'est demandé au client principal pour la Salle OMO).
// - projets : deps.projects.list() plus les dossiers des racines récentes, chacun filtré par deps.projects.isAllowedDirectory ;
// - racines récentes : `sessions` sans parent, non supprimées, purpose = 'chat', updated_at dans les 24 h, 200 au plus ;
// - travaillent : sessionsQuiTravaillent (règle de statusBusy, shared/territoires.ts) sur l'arbre de la racine ; échec de la
//   requête ou réponse qui n'est pas un objet → null et statutVerifie: false, jamais 0 ;
// - attendent : lignes `permission_waits` de l'arbre sans réponse ;
// - cout : ledger.spentSince(racine, heure du dernier message de l'utilisateur) pour une racine dont la demande est en cours
//   (« Coût des demandes en cours dans ce projet », salle3d-texts.ts) ;
// - salle (sessions.instance = 'omo', D-3d-14) : en Avancé, compteurs par les faits (occupeesSelonFaits) et statutVerifie: false ;
//   en Simple, ni compteurs ni titre en direct, et seulement les conversations dont revoirAcces est ok, avec revoir: true.
// Titres passés par redactSecrets. Requêtes SQL paramétrées seulement ; identifiants validés par shared/ids.ts.
import type { Salle3dDeps, TerritoiresPort } from "./contracts-3d.ts";
import { redactSecrets } from "./redact.ts";
import type { SessionInstance } from "./shared/activity-types.ts";
import { SESSION_ID_RE } from "./shared/ids.ts";
import type { NeonMode } from "./shared/neon-scene.ts";
import { occupeesSelonFaits, revoirAcces } from "./shared/revoir-access.ts";
import type { ConversationTerritoire, TerritoireView, TerritoiresResponse } from "./shared/salle3d-types.ts";
import { sessionsQuiTravaillent } from "./shared/territoires.ts";

/** Fenêtre des racines « récentes » (D-3d-13 : conversations actives dans les 24 h). */
export const FENETRE_RACINES_MS = 24 * 60 * 60 * 1_000;
/** Racines lues au plus (D-3d-13). */
export const RACINES_MAX = 200;
/** Délai de GET /session/status par dossier (fiche L31a). */
export const STATUT_TIMEOUT_MS = 5_000;

/**
 * Sessions de la conversation : la racine et toute session suivie rattachée à elle (conversation-purge.ts, fact-store.ts,
 * routes-activity.ts). Une ligne écrite sous une racine provisoire (session enregistrée avant ses ancêtres, puis rattachée par
 * SessionTracker) reste ainsi comptée avec sa conversation.
 */
const TREE_SQL = "SELECT :root UNION SELECT id FROM sessions WHERE root_id = :root";

export interface TerritoiresOptions {
  /** Horloge de secours : utilisée quand `lire` reçoit un instant illisible ; absente : Date.now. */
  now?: () => number;
  /** Lecture du statut d'un dossier de l'instance principale (tests) ; absente : deps.client.request. */
  statut?: (directory: string) => Promise<unknown>;
}

type RacineRow = {
  id: string;
  directory: string;
  title: string;
  instance: string;
  updated_at: number;
};

/** Racine retenue, après validation de son identifiant et de son dossier. */
interface Racine {
  id: string;
  directory: string;
  titre: string;
  instance: SessionInstance;
  derniereActivite: number;
}

const estInstance = (valeur: unknown): valeur is SessionInstance => valeur === "principale" || valeur === "omo";

/**
 * Chemin d'un dossier relatif à la racine du workspace vue par opencode (TerritoireView.projet) ; la racine elle-même rend la
 * chaîne vide. Le séparateur suit la forme de la racine (chemin POSIX du conteneur ou chemin Windows).
 */
export function projetRelatif(racineWorkspace: string, dossier: string): string {
  const separateur = racineWorkspace.startsWith("/") ? "/" : "\\";
  const base = racineWorkspace.endsWith(separateur) ? racineWorkspace.slice(0, -separateur.length) : racineWorkspace;
  if (dossier === base) return "";
  if (dossier.startsWith(base + separateur)) return dossier.slice(base.length + separateur.length);
  // isAllowedDirectory a déjà accepté ce dossier : il reste dans le workspace, mais sa forme diffère (repli honnête).
  return dossier;
}

/** Dernier composant du chemin (TerritoireView.nom) ; pour la racine du workspace, le dernier composant de son chemin. */
export function nomDeProjet(racineWorkspace: string, dossier: string, projet: string): string {
  const chemin = projet === "" ? racineWorkspace : projet;
  const segments = chemin.split(/[\\/]/).filter((segment) => segment !== "");
  return segments.at(-1) ?? projet;
}

/** Somme des compteurs d'un groupe de conversations ; `travaillent` reste null dès qu'une conversation n'est pas vérifiable. */
function compteurs(conversations: readonly ConversationTerritoire[]): TerritoireView["compteurs"] {
  let travaillent: number | null = 0;
  let attendent = 0;
  let cout = 0;
  for (const conversation of conversations) {
    if (conversation.travaillent === null) travaillent = null;
    else if (travaillent !== null) travaillent += conversation.travaillent;
    attendent += conversation.attendent;
    cout += conversation.coutEnCours;
  }
  return { travaillent, attendent, cout };
}

export function createTerritoiresPort(deps: Salle3dDeps, options: TerritoiresOptions = {}): TerritoiresPort {
  const horloge = options.now ?? Date.now;
  const statutDuDossier =
    options.statut ?? ((directory: string) => deps.client.request<unknown>("GET", "/session/status", { directory, timeoutMs: STATUT_TIMEOUT_MS }));

  /** Racines de conversation actives dans les 24 h, bornées, identifiants et dossiers validés. */
  const racinesRecentes = (maintenant: number): Racine[] => {
    const rows = deps.db
      .prepare(
        `SELECT id, directory, title, instance, updated_at FROM sessions
         WHERE parent_id IS NULL AND deleted_at IS NULL AND purpose = 'chat' AND directory != '' AND updated_at >= ?
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(maintenant - FENETRE_RACINES_MS, RACINES_MAX) as RacineRow[];
    const racines: Racine[] = [];
    for (const row of rows) {
      if (typeof row.id !== "string" || !SESSION_ID_RE.test(row.id)) continue;
      if (typeof row.directory !== "string" || !deps.projects.isAllowedDirectory(row.directory)) continue;
      racines.push({
        id: row.id,
        directory: row.directory,
        titre: redactSecrets(typeof row.title === "string" ? row.title : ""),
        instance: estInstance(row.instance) ? row.instance : "principale",
        derniereActivite: typeof row.updated_at === "number" ? row.updated_at : 0,
      });
    }
    return racines;
  };

  /** Demandes d'autorisation de l'ARBRE encore sans réponse (D-3d-13), comme routes-activity.ts : jamais la seule égalité root_id = ?. */
  const attentes = (rootId: string): number => {
    const row = deps.db
      .prepare(`SELECT COUNT(*) AS n FROM permission_waits WHERE root_id IN (${TREE_SQL}) AND replied_at IS NULL`)
      .get({ root: rootId }) as { n: number } | undefined;
    return typeof row?.n === "number" ? row.n : 0;
  };

  /** Heure du dernier message de l'utilisateur (prompts.kind = 'message') envoyé à la racine ; null si la conversation n'en a pas. */
  const dernierMessage = (rootId: string): number | null => {
    const row = deps.db
      .prepare("SELECT MAX(created_at) AS at FROM prompts WHERE root_id = ? AND session_id = ? AND kind = 'message'")
      .get(rootId, rootId) as { at: number | null } | undefined;
    return typeof row?.at === "number" && Number.isFinite(row.at) ? row.at : null;
  };

  /** Coût de la demande en cours d'une racine (D-3d-13) ; 0 sans demande en cours ou sans message de l'utilisateur. */
  const coutEnCours = (rootId: string, demandeEnCours: boolean): number => {
    if (!demandeEnCours) return 0;
    const depuis = dernierMessage(rootId);
    if (depuis === null) return 0;
    try {
      return deps.ledger.spentSince(rootId, depuis);
    } catch (error) {
      // Coût illisible : 0 annoncé plutôt qu'un chiffre inventé, et la cause est journalisée (jamais de secret : identifiants seuls).
      deps.log.warn("coût de la demande en cours illisible", { rootId, error: String(error) });
      return 0;
    }
  };

  /** Dernière ligne `autonomy_requests` de la racine (revoirAcces) ; null : aucune. */
  // Égalité `root_id = ?` gardée à dessein, et non TREE_SQL comme les attentes : une demande d'autonomie s'ouvre toujours sur une
  // VRAIE racine (l'utilisateur la demande depuis sa conversation), jamais sur une racine provisoire, et la salle veut la dernière
  // demande de cette racine-là, pas la plus récente de tout l'arbre. Écart de convention avec routes-activity.ts, assumé ici.
  const derniereDemande = (rootId: string): { finie: boolean } | null => {
    const row = deps.db.prepare("SELECT ended_at FROM autonomy_requests WHERE root_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1").get(rootId) as
      | { ended_at: number | null }
      | undefined;
    return row === undefined ? null : { finie: row.ended_at !== null };
  };

  /** Sessions occupées d'une racine de la salle, selon les faits seuls (D-3d-14, P11) ; null : faits partiels. */
  const occupeesDeLaSalle = (rootId: string): number | null => {
    const reponse = deps.ports.facts.since(rootId, 0);
    return occupeesSelonFaits(reponse.facts, reponse.partial);
  };

  const lire = async (mode: NeonMode, now: number): Promise<TerritoiresResponse> => {
    const maintenant = Number.isFinite(now) ? now : horloge();
    const racines = racinesRecentes(maintenant);
    const racinesPrincipales = racines.filter((racine) => racine.instance === "principale");
    const racinesSalle = racines.filter((racine) => racine.instance === "omo");

    // P11 : un dossier n'est interrogé que s'il porte au moins une racine de l'instance principale.
    const dossiersInterroges = [...new Set(racinesPrincipales.map((racine) => racine.directory))];
    const reponses = await Promise.allSettled(dossiersInterroges.map((directory) => statutDuDossier(directory)));
    const statuts = new Map<string, unknown>();
    dossiersInterroges.forEach((directory, index) => {
      const resultat = reponses[index];
      if (resultat?.status === "fulfilled") statuts.set(directory, resultat.value);
      // Requête en échec : le dossier reste absent de la table, donc « non vérifiable » (null), jamais 0.
    });

    const conversationsPrincipales = racinesPrincipales.map((racine) => {
      const arbre = [racine.id, ...deps.sessions.descendants(racine.id)];
      const travaillent = statuts.has(racine.directory) ? sessionsQuiTravaillent(statuts.get(racine.directory), arbre) : null;
      const attendent = attentes(racine.id);
      const demandeEnCours = (travaillent ?? 0) > 0 || attendent > 0;
      return {
        directory: racine.directory,
        conversation: {
          rootId: racine.id,
          titre: racine.titre,
          instance: racine.instance,
          travaillent,
          attendent,
          coutEnCours: coutEnCours(racine.id, demandeEnCours),
          demandeEnCours,
          derniereActivite: racine.derniereActivite,
          // Une conversation de l'instance principale est toujours consultable dans « Revoir » (D-3d-09).
          revoir: revoirAcces({ existe: true, instance: racine.instance, mode, sessionsOccupees: null, derniereDemande: null }).ok,
        } satisfies ConversationTerritoire,
      };
    });

    const simple = mode === "simple";
    const conversationsSalle: Array<{ directory: string; conversation: ConversationTerritoire }> = [];
    for (const racine of racinesSalle) {
      const occupees = occupeesDeLaSalle(racine.id);
      const acces = revoirAcces({ existe: true, instance: racine.instance, mode, sessionsOccupees: occupees, derniereDemande: derniereDemande(racine.id) });
      // D-3d-14 : en Simple, seules les demandes terminées sont listées.
      if (simple && !acces.ok) continue;
      const attendent = simple ? 0 : attentes(racine.id);
      const travaillent = simple ? null : occupees;
      const demandeEnCours = simple ? false : (travaillent ?? 0) > 0 || attendent > 0;
      conversationsSalle.push({
        directory: racine.directory,
        conversation: {
          rootId: racine.id,
          titre: racine.titre,
          instance: racine.instance,
          travaillent,
          attendent,
          coutEnCours: simple ? 0 : coutEnCours(racine.id, demandeEnCours),
          demandeEnCours,
          derniereActivite: racine.derniereActivite,
          revoir: acces.ok,
        },
      });
    }

    // Dossiers de territoire : projets du workspace, plus les dossiers des racines récentes.
    const dossiers = new Set<string>();
    for (const projet of await deps.projects.list()) {
      if (deps.projects.isAllowedDirectory(projet.directory)) dossiers.add(projet.directory);
    }
    for (const racine of racinesPrincipales) dossiers.add(racine.directory);

    const racineWorkspace = deps.projects.opencodeRoot;
    const vue = (directory: string, conversations: ConversationTerritoire[]): TerritoireView => {
      const projet = projetRelatif(racineWorkspace, directory);
      return { projet, nom: nomDeProjet(racineWorkspace, directory, projet), conversations, compteurs: compteurs(conversations) };
    };
    const grouper = (entrees: Array<{ directory: string; conversation: ConversationTerritoire }>, tous: Iterable<string>): TerritoireView[] => {
      const parDossier = new Map<string, ConversationTerritoire[]>();
      for (const dossier of tous) parDossier.set(dossier, []);
      for (const { directory, conversation } of entrees) {
        const liste = parDossier.get(directory);
        if (liste) liste.push(conversation);
        else parDossier.set(directory, [conversation]);
      }
      return [...parDossier]
        .map(([directory, conversations]) => vue(directory, conversations.sort((a, b) => b.derniereActivite - a.derniereActivite)))
        .sort((a, b) => a.projet.localeCompare(b.projet, "fr"));
    };

    const projets = grouper(conversationsPrincipales, dossiers);
    // Enceinte : présente dès qu'une racine de la salle existe (JP-10), même si le filtre Simple n'en garde aucune conversation.
    const salle =
      racinesSalle.length > 0 ? { projets: grouper(conversationsSalle, new Set(conversationsSalle.map((e) => e.directory))) } : null;

    // statutVerifie : faux dès qu'un statut n'a pas pu être lu, et toujours faux quand une enceinte est montrée (ses compteurs
    // viennent des faits en Avancé, et n'existent pas en Simple : ils ne sont jamais un état vérifié de l'instance principale).
    const statutVerifie = salle === null && projets.every((territoire) => territoire.compteurs.travaillent !== null);

    return { genereLe: maintenant, mode, projets, salle, statutVerifie };
  };

  return { lire };
}
