// Propriétaire : L4b.
// Magasin de faits (activity_facts, migration 5 ; spécification §3.5, §3.10 point 6, P12 ; plan d'exécution, fiche L4b) :
// - append : faits vérifiés par assertFact (aucun texte de message, aucun secret), tout ou rien, au plus 20 000 par racine : le
//   20 000e est le fait « affichage » {etat: deroule-partiel} (« Déroulé partiel », à l'heure du premier fait non enregistré), puis
//   plus rien n'est écrit, jusqu'à la purge de la conversation ; chaque fait écrit part vers les navigateurs (activite.fait) ;
// - since : faits d'une conversation (racine et sessions rattachées, comme purgeConversation) depuis un instant, `partial` à la borne ;
// - work.markDelegation et work.markWait : SEULS points d'écriture des tables delegations et permission_waits (migration 4 ;
//   fact-store.test.ts échoue sur tout autre écrivain), transitions de activity-types.ts : un état final ne régresse jamais ;
//   l'identité (enfant, assistant, demande, commande) est complétée sans rien remplacer ; « sans confirmation » ne tient jamais
//   avec une demande d'autorisation connue.
// Le module « facts » pose le port, la dérivation (activity-deriver.ts) et le groupe de routes « activity » (routes-activity.ts).
// neutralFacts reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan §2.2).
import type { DatabaseSync } from "node:sqlite";
import { activityDerivation } from "./activity-deriver.ts";
import { emitCockpit } from "./cockpit-events.ts";
import type { Cockpit11Module, DelegationUpsert, FactsPort, WaitUpsert } from "./contracts-11.ts";
import { transaction } from "./db.ts";
import type { EventHub } from "./hub.ts";
import { redactSecrets } from "./redact.ts";
import { registerActivityRoutes } from "./routes-activity.ts";
import { assertFact, factProblem } from "./shared/activity-facts.ts";
import type {
  ActivityFact,
  ActivityFactKind,
  DelegationSource,
  DelegationState,
  DelegationTransitions,
  FactsResponse,
  FactValue,
  WaitState,
  WaitTransitions,
} from "./shared/activity-types.ts";
import type { RepliedBy } from "./shared/autonomy-types.ts";
import { ID_RE } from "./shared/ids.ts";

export function neutralFacts(): FactsPort {
  return {
    append: () => undefined,
    since: () => ({ facts: [], partial: false }),
    work: {
      markDelegation: () => false,
      markWait: () => false,
    },
  };
}

export const factsModule: Cockpit11Module = {
  name: "facts",
  install(reg, c11) {
    c11.ports.facts = createFactStore({ db: c11.db, hub: c11.hub });
    reg.derivation(activityDerivation(c11));
    reg.routes("activity", (app) => registerActivityRoutes(app, c11));
  },
};

// --- Bornes et codes ------------------------------------------------------------------------------------------------------------

/** Au plus 20 000 faits par racine (§3.5), le fait « Déroulé partiel » compris. */
export const FACTS_PER_ROOT_MAX = 20_000;
/** `data.etat` du fait « affichage » écrit à la place du 20 000e : la suite de la conversation n'est plus enregistrée. */
export const PARTIAL_FACT_ETAT = "deroule-partiel";
/** Racines dont le nombre de faits est gardé en mémoire ; les autres sont recomptées à leur prochaine écriture. */
const COUNT_CACHE_MAX = 1_000;
/**
 * Lignes d'une conversation : la racine et toute session suivie rattachée à elle, comme purgeConversation (conversation-purge.ts) :
 * une ligne écrite sous une racine provisoire (session connue avant ses ancêtres) reste lue et purgée avec sa conversation.
 */
const TREE_SQL = "SELECT :root UNION SELECT id FROM sessions WHERE root_id = :root";

/** Transitions permises d'une délégation (DelegationTransitions) ; un état final n'a aucune suite. */
export const DELEGATION_NEXT = {
  prepare: ["attente-accord", "autorisee", "travaille", "refusee", "expiree", "arretee", "jamais-demarree"],
  "attente-accord": ["autorisee", "refusee", "expiree", "arretee", "jamais-demarree"],
  autorisee: ["travaille", "terminee", "arretee", "jamais-demarree"],
  travaille: ["terminee", "arretee"],
  terminee: [],
  arretee: [],
  "jamais-demarree": [],
  refusee: [],
  expiree: [],
} as const satisfies { readonly [S in DelegationState]: ReadonlyArray<DelegationTransitions[S]> };

/** Transitions permises d'une attente d'accord (WaitTransitions). */
export const WAIT_NEXT = {
  attente: ["once", "reject", "expiree"],
  once: [],
  reject: [],
  expiree: [],
} as const satisfies { readonly [S in WaitState]: ReadonlyArray<WaitTransitions[S]> };

// Complétude vérifiée à la compilation : toute transition du contrat figure dans les tables (et `satisfies` refuse l'inverse).
type MissingDelegation = { [S in DelegationState]: Exclude<DelegationTransitions[S], (typeof DELEGATION_NEXT)[S][number]> }[DelegationState];
type MissingWait = { [S in WaitState]: Exclude<WaitTransitions[S], (typeof WAIT_NEXT)[S][number]> }[WaitState];
export const TRANSITIONS_COMPLETE: [MissingDelegation, MissingWait] extends [never, never] ? true : never = true;

const DELEGATION_STATES = new Set<string>(Object.keys(DELEGATION_NEXT));
const WAIT_STATES = new Set<string>(Object.keys(WAIT_NEXT));
const REPLIED_BY = new Set<string>(["vous", "cockpit", "controle"] satisfies RepliedBy[]);
const SOURCES = new Set<string>(["ia", "raccourci"] satisfies DelegationSource[]);

export function delegationTransitionAllowed(from: DelegationState, to: DelegationState): boolean {
  return (DELEGATION_NEXT[from] as readonly string[]).includes(to);
}

export function waitTransitionAllowed(from: WaitState, to: WaitState): boolean {
  return (WAIT_NEXT[from] as readonly string[]).includes(to);
}

const isFinalDelegation = (state: DelegationState) => DELEGATION_NEXT[state].length === 0;

// --- Validation des écritures de travail -----------------------------------------------------------------------------------------

/** Nom d'assistant, de commande ou d'outil : nom technique, jamais un texte. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** Clé de permission d'opencode (edit, bash, task, external_directory…). */
const PERMISSION_RE = /^[a-z_]{1,32}$/;

const idOk = (value: unknown): value is string => typeof value === "string" && ID_RE.test(value) && redactSecrets(value) === value;
const optionalId = (value: unknown): boolean => value === undefined || value === null || idOk(value);
const optionalName = (value: unknown): boolean => value === undefined || value === null || (typeof value === "string" && NAME_RE.test(value));

function checkDelegation(delegation: DelegationUpsert, etat: DelegationState, par: RepliedBy | null): void {
  const ok =
    idOk(delegation.rootId) &&
    idOk(delegation.parentSessionId) &&
    idOk(delegation.callId) &&
    optionalId(delegation.childSessionId) &&
    optionalId(delegation.permissionId) &&
    (delegation.agent === "" || optionalName(delegation.agent)) &&
    typeof delegation.agent === "string" &&
    optionalName(delegation.command) &&
    (delegation.source === undefined || SOURCES.has(delegation.source)) &&
    (delegation.sansConfirmation === undefined || typeof delegation.sansConfirmation === "boolean") &&
    DELEGATION_STATES.has(etat) &&
    (par === null || REPLIED_BY.has(par));
  // Le message ne recopie aucune valeur reçue.
  if (!ok) throw new RangeError("délégation refusée : identifiant, nom, source ou état invalide");
}

function checkWait(wait: WaitUpsert, etat: WaitState, par: RepliedBy | null): void {
  const ok =
    idOk(wait.permissionId) &&
    idOk(wait.sessionId) &&
    idOk(wait.rootId) &&
    typeof wait.permission === "string" &&
    PERMISSION_RE.test(wait.permission) &&
    optionalName(wait.target) &&
    WAIT_STATES.has(etat) &&
    (par === null || REPLIED_BY.has(par));
  if (!ok) throw new RangeError("attente d'accord refusée : identifiant, permission, cible ou état invalide");
}

// --- Magasin -----------------------------------------------------------------------------------------------------------------------

export interface FactStoreDeps {
  db: DatabaseSync;
  hub: Pick<EventHub, "cockpit">;
  /** Horloge des écritures de travail et du fait « Déroulé partiel » (tests). */
  now?: () => number;
}

interface RootCount {
  count: number;
  /** Ligne du fait « Déroulé partiel », null tant que la borne n'est pas atteinte. */
  partialId: number | null;
}

interface FactRow {
  id: number;
  root_id: string;
  session_id: string;
  kind: string;
  ref: string | null;
  data: string;
  at: number;
}

interface DelegationRow {
  state: DelegationState;
  agent: string;
}

interface WaitRow {
  reply: Exclude<WaitState, "attente"> | null;
  replied_by: string | null;
}

/** Atomique : dans la transaction de l'appelant s'il y en a une, sinon dans la sienne. */
const atomic = <T>(db: DatabaseSync, fn: () => T): T => (db.isTransaction ? fn() : transaction(db, fn));

/** Magasin de faits et écrivain unique des délégations et des attentes d'accord (port facts). */
export function createFactStore(deps: FactStoreDeps): FactsPort {
  const { db, hub } = deps;
  const now = deps.now ?? Date.now;
  const counts = new Map<string, RootCount>();

  const loadCount = (rootId: string): RootCount => {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM activity_facts WHERE root_id = ?").get(rootId) as { n: number };
    let partialId: number | null = null;
    if (n >= FACTS_PER_ROOT_MAX) {
      const marker = db
        .prepare("SELECT id FROM activity_facts WHERE root_id = ? AND kind = 'affichage' AND data = ? ORDER BY id DESC LIMIT 1")
        .get(rootId, JSON.stringify({ etat: PARTIAL_FACT_ETAT })) as { id: number } | undefined;
      partialId = marker?.id ?? null;
    }
    const entry = { count: n, partialId };
    counts.delete(rootId);
    if (counts.size >= COUNT_CACHE_MAX) counts.delete(counts.keys().next().value as string);
    counts.set(rootId, entry);
    return entry;
  };

  /** Compte d'une racine ; recompté si le fait « Déroulé partiel » a disparu (conversation purgée par purgeConversation). */
  const countOf = (rootId: string): RootCount => {
    const entry = counts.get(rootId);
    if (!entry) return loadCount(rootId);
    if (entry.partialId !== null && db.prepare("SELECT 1 FROM activity_facts WHERE id = ?").get(entry.partialId) === undefined) return loadCount(rootId);
    return entry;
  };

  const insertFact = (fact: ActivityFact): ActivityFact => {
    const result = db
      .prepare("INSERT INTO activity_facts (root_id, session_id, kind, ref, data, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(fact.rootId, fact.sessionId, fact.kind, fact.ref, JSON.stringify(fact.data), fact.at);
    return { ...fact, id: Number(result.lastInsertRowid) };
  };

  const append = (facts: readonly ActivityFact[]): void => {
    // Tout ou rien : un seul fait refusé (texte, secret, identifiant) et rien n'est écrit.
    for (const fact of facts) assertFact(fact);
    if (facts.length === 0) return;
    const written = atomic(db, () => {
      const out: ActivityFact[] = [];
      for (const fact of facts) {
        let entry = countOf(fact.rootId);
        if (entry.partialId !== null) continue;
        if (entry.count >= FACTS_PER_ROOT_MAX - 1) {
          // Compte gardé en mémoire : vérifié avant de fermer la racine (une purge a pu vider ses faits entre-temps).
          entry = loadCount(fact.rootId);
          if (entry.partialId !== null) continue;
          if (entry.count >= FACTS_PER_ROOT_MAX - 1) {
            // À l'heure du premier fait non enregistré : « Revoir » montre où le déroulé s'arrête.
            const marker = insertFact({ rootId: fact.rootId, sessionId: fact.rootId, kind: "affichage", ref: null, data: { etat: PARTIAL_FACT_ETAT }, at: fact.at });
            entry.count++;
            entry.partialId = marker.id ?? null;
            out.push(marker);
            continue;
          }
        }
        out.push(insertFact(fact));
        entry.count++;
      }
      return out;
    });
    for (const fact of written) emitCockpit(hub, "activite.fait", fact);
  };

  const since = (rootId: string, from: number, limit: number = FACTS_PER_ROOT_MAX): FactsResponse => {
    if (!idOk(rootId)) throw new RangeError("identifiant de conversation invalide");
    if (!Number.isSafeInteger(from) || from < 0) throw new RangeError("instant invalide");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > FACTS_PER_ROOT_MAX) throw new RangeError("borne invalide");
    const rows = db
      .prepare(`SELECT id, root_id, session_id, kind, ref, data, at FROM activity_facts WHERE root_id IN (${TREE_SQL}) AND at >= :from ORDER BY at, id LIMIT :limit`)
      .all({ root: rootId, from, limit }) as unknown as FactRow[];
    const facts: ActivityFact[] = [];
    for (const row of rows) {
      let data: unknown;
      try {
        data = JSON.parse(row.data);
      } catch {
        continue;
      }
      const fact = { id: row.id, rootId: row.root_id, sessionId: row.session_id, kind: row.kind as ActivityFactKind, ref: row.ref, data: data as Record<string, FactValue>, at: row.at };
      // Une ligne qui ne passerait plus la garde (base modifiée hors du magasin) n'est jamais rendue.
      if (factProblem(fact) === null) facts.push(fact);
    }
    return { facts, partial: countOf(rootId).partialId !== null };
  };

  const markDelegation = (delegation: DelegationUpsert, etat: DelegationState, par: RepliedBy | null): boolean => {
    checkDelegation(delegation, etat, par);
    return atomic(db, () => {
      const at = now();
      const key = [delegation.parentSessionId, delegation.callId] as const;
      const row = db.prepare("SELECT state, agent FROM delegations WHERE parent_session_id = ? AND call_id = ?").get(...key) as DelegationRow | undefined;
      const started = etat === "travaille" ? at : null;
      const ended = isFinalDelegation(etat) ? at : null;
      if (!row) {
        db.prepare(
          `INSERT INTO delegations (root_id, parent_session_id, child_session_id, call_id, agent, command, source, sans_confirmation, state,
             permission_id, created_at, started_at, ended_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          delegation.rootId,
          delegation.parentSessionId,
          delegation.childSessionId ?? null,
          delegation.callId,
          delegation.agent,
          delegation.command ?? null,
          delegation.source ?? "ia",
          delegation.sansConfirmation === true && !delegation.permissionId ? 1 : 0,
          etat,
          delegation.permissionId ?? null,
          at,
          started,
          ended,
        );
        return true;
      }
      // Identité complétée sans rien remplacer (enfant, assistant, demande, commande), même quand la transition est refusée ; un
      // raccourci reconnu l'emporte sur « ia » posé par défaut ; « sans confirmation » ne tient jamais avec une demande connue.
      db.prepare(
        `UPDATE delegations SET child_session_id = COALESCE(child_session_id, :child), agent = CASE WHEN agent = '' THEN :agent ELSE agent END,
           permission_id = COALESCE(permission_id, :permission), command = COALESCE(command, :command),
           source = CASE WHEN :source = 'raccourci' THEN 'raccourci' ELSE source END,
           sans_confirmation = CASE WHEN permission_id IS NOT NULL OR :permission IS NOT NULL THEN 0 WHEN :sans = 1 THEN 1 ELSE sans_confirmation END
         WHERE parent_session_id = :parent AND call_id = :call`,
      ).run({
        child: delegation.childSessionId ?? null,
        agent: delegation.agent,
        permission: delegation.permissionId ?? null,
        command: delegation.command ?? null,
        source: delegation.source ?? null,
        sans: delegation.sansConfirmation === true ? 1 : 0,
        parent: key[0],
        call: key[1],
      });
      if (!delegationTransitionAllowed(row.state, etat)) return false;
      db.prepare(
        `UPDATE delegations SET state = ?, started_at = COALESCE(started_at, ?), ended_at = COALESCE(?, ended_at)
         WHERE parent_session_id = ? AND call_id = ? AND state = ?`,
      ).run(etat, started, ended, ...key, row.state);
      return true;
    });
  };

  const markWait = (wait: WaitUpsert, etat: WaitState, par: RepliedBy | null): boolean => {
    checkWait(wait, etat, par);
    return atomic(db, () => {
      const at = now();
      const row = db.prepare("SELECT reply, replied_by FROM permission_waits WHERE permission_id = ?").get(wait.permissionId) as WaitRow | undefined;
      const final = etat !== "attente";
      if (!row) {
        db.prepare(
          `INSERT INTO permission_waits (permission_id, session_id, root_id, permission, target, asked_at, replied_at, reply, replied_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(wait.permissionId, wait.sessionId, wait.rootId, wait.permission, wait.target ?? null, at, final ? at : null, final ? etat : null, final ? par : null);
        return true;
      }
      db.prepare("UPDATE permission_waits SET target = COALESCE(target, ?) WHERE permission_id = ?").run(wait.target ?? null, wait.permissionId);
      const current: WaitState = row.reply ?? "attente";
      if (!waitTransitionAllowed(current, etat)) {
        // Même réponse, auteur encore inconnu (réponse vue dans le flux avant le service qui l'a envoyée) : auteur complété, sans transition.
        if (final && current === etat && row.replied_by === null && par !== null) {
          db.prepare("UPDATE permission_waits SET replied_by = ? WHERE permission_id = ? AND replied_by IS NULL").run(par, wait.permissionId);
        }
        return false;
      }
      db.prepare("UPDATE permission_waits SET reply = ?, replied_at = ?, replied_by = ? WHERE permission_id = ? AND reply IS NULL").run(etat, at, par, wait.permissionId);
      return true;
    });
  };

  return { append, since, work: { markDelegation, markWait } };
}
