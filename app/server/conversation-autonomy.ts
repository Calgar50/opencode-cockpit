// Propriétaire : L6a.
// Choix d'autonomie par conversation (conversation_autonomy ; spécification §3.9, §4.1, §4.2, §4.11, D10, D13 ; plan d'exécution,
// fiche L6a) : get et put par racine (identifiant d'enfant refusé), « plan » posé seulement par les plans, resserrer immédiat,
// relâcher → 428 sans x-cockpit-confirm, choix automatiques confiés au port activation, COCKPIT_AUTONOMY=off → 403 pour
// « modifications » et « autonome », événement autonomie.choix et fait « choix » à chaque changement, retour à « demander » au
// démarrage (retour_cause redemarrage-cockpit). Le port rend des CODES ; les phrases sont dans shared/autonomy-choice-texts.ts.
// neutralConversationAutonomy reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan §2.2).
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { emitCockpit } from "./cockpit-events.ts";
import type { ActivationVerdict, AutonomyPutResult, Cockpit11, Cockpit11Deps, Cockpit11Module, ConversationAutonomyPort } from "./contracts-11.ts";
import { errorMessage } from "./log.ts";
import { registerAutonomyRoutes } from "./routes-autonomy.ts";
import type { SessionRow } from "./sessions.ts";
import { settingsSchema } from "./settings.ts";
import { assertFact } from "./shared/activity-facts.ts";
import type { ActivityFact, ChoixFactData } from "./shared/activity-types.ts";
import type {
  ActivationRefusalCode,
  AutomaticChoice,
  AutonomyCaps,
  AutonomyChoice,
  AutonomyChoiceAvailability,
  ChoiceCause,
  ConversationAutonomyView,
} from "./shared/autonomy-types.ts";
import { SESSION_ID_RE } from "./shared/ids.ts";

export function neutralConversationAutonomy(deps: Cockpit11Deps): ConversationAutonomyPort {
  const view = (rootId: string): ConversationAutonomyView => {
    const caps = deps.settings.get().budget.autonomie;
    const automatic: ActivationRefusalCode = deps.env.autonomy ? "a-venir" : "autonomie-coupee";
    return {
      rootId,
      choix: "demander",
      plafonds: {
        plafondUsd: caps.plafondUsd,
        actionsMax: caps.actionsMax,
        delegationsMax: caps.delegationsMax,
        dureeMinutes: caps.dureeMinutes,
        fichiersMax: caps.fichiersMax,
        controlesIaMax: caps.controlesIaMax,
      },
      depuis: null,
      retourCause: null,
      planSourceId: null,
      executionDePlanId: null,
      interrupteur: deps.env.autonomy,
      disponibles: [
        { choix: "demander", disponible: true, raison: null },
        { choix: "modifications", disponible: false, raison: automatic },
        { choix: "plan", disponible: false, raison: "nouvelle-conversation" },
        { choix: "autonome", disponible: false, raison: automatic },
      ],
      demande: null,
    };
  };
  return {
    get: async (rootId) => view(rootId),
    choiceOf: () => "demander",
    put: async () => ({ ok: false, status: 409, error: "autonomie-indisponible", raison: "a-venir" }),
  };
}

// --- Magasin (table conversation_autonomy, migration 4) -----------------------------------------------------------------------

const CAP_KEYS = ["plafondUsd", "actionsMax", "delegationsMax", "dureeMinutes", "fichiersMax", "controlesIaMax"] as const satisfies ReadonlyArray<keyof AutonomyCaps>;

/** Plafonds d'une conversation : mêmes bornes que les réglages (budget.autonomie), clés inconnues refusées. */
const capsSchema = settingsSchema.shape.budget.shape.autonomie
  .pick({ plafondUsd: true, actionsMax: true, delegationsMax: true, dureeMinutes: true, fichiersMax: true, controlesIaMax: true })
  .partial()
  .strict();

/** Corps de PUT : « omo » (Salle OMO, itération 2 ter) et toute autre valeur refusés. */
const putBodySchema = z.strictObject({
  choix: z.enum(["demander", "modifications", "plan", "autonome"]),
  plafonds: capsSchema.optional(),
});

const CHOICES: ReadonlySet<string> = new Set<AutonomyChoice>(["demander", "modifications", "plan", "autonome"]);
const CAUSES: ReadonlySet<string> = new Set<ChoiceCause>([
  "clic",
  "redemarrage-cockpit",
  "interrompue",
  "agent-non-conforme",
  "plafond-cout",
  "plafond-actions",
  "plafond-duree",
  "plafond-fichiers",
]);

/** Choix qu'un clic peut poser ; « plan » ne l'est que par les plans (setPlan). */
export type ClickableChoice = Exclude<AutonomyChoice, "plan">;

/** Ligne de conversation_autonomy, relue (valeur inconnue ramenée à « demander », plafonds illisibles ignorés). */
export interface StoredAutonomy {
  rootId: string;
  choix: AutonomyChoice;
  plafonds: Partial<AutonomyCaps>;
  depuis: number;
  retourCause: ChoiceCause | null;
  planSourceId: string | null;
  executionDePlanId: string | null;
}

interface AutonomyRow {
  root_id: string;
  choix: string;
  plafonds: string;
  depuis: number;
  retour_cause: string | null;
  plan_source_id: string | null;
  execution_de_plan_id: string | null;
}

function parseCaps(text: string): Partial<AutonomyCaps> {
  try {
    const parsed = capsSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** Accès à conversation_autonomy. Aucune route n'écrit « plan » : setPlan est réservé aux plans (plans.ts, L6b). */
export class ConversationAutonomyStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  read(rootId: string): StoredAutonomy | null {
    const row = this.#db.prepare("SELECT * FROM conversation_autonomy WHERE root_id = ?").get(rootId) as AutonomyRow | undefined;
    if (!row) return null;
    return {
      rootId: row.root_id,
      // Valeur inconnue (« omo » hors de la salle, écriture étrangère) : lue comme le choix le plus restrictif.
      choix: CHOICES.has(row.choix) ? (row.choix as AutonomyChoice) : "demander",
      plafonds: parseCaps(row.plafonds),
      depuis: row.depuis,
      retourCause: row.retour_cause !== null && CAUSES.has(row.retour_cause) ? (row.retour_cause as ChoiceCause) : null,
      planSourceId: row.plan_source_id,
      executionDePlanId: row.execution_de_plan_id,
    };
  }

  /** Choix et plafonds d'une conversation ; plan_source_id et execution_de_plan_id gardés. */
  write(rootId: string, value: { choix: ClickableChoice; plafonds: Partial<AutonomyCaps>; depuis: number; retourCause: ChoiceCause | null }): void {
    this.#db
      .prepare(
        `INSERT INTO conversation_autonomy (root_id, choix, plafonds, depuis, retour_cause) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(root_id) DO UPDATE SET choix = excluded.choix, plafonds = excluded.plafonds, depuis = excluded.depuis,
           retour_cause = excluded.retour_cause`,
      )
      .run(rootId, value.choix, JSON.stringify(value.plafonds), value.depuis, value.retourCause);
  }

  /**
   * Choix automatiques remis à « demander » (depuis, cause), pour la racine `rootId` ou pour toutes ; `garder` : racines laissées
   * telles quelles (choix posés par ce démarrage). Une seule instruction (RETURNING) : chaque racine changée est rendue une fois,
   * triée. « demander » et « plan » : inchangés.
   */
  resetAutomatic(options: { depuis: number; cause: ChoiceCause; rootId?: string; garder?: readonly string[] }): string[] {
    const conditions = ["choix IN ('modifications', 'autonome')"];
    const values: Array<string | number> = [options.depuis, options.cause];
    if (options.rootId !== undefined) {
      conditions.push("root_id = ?");
      values.push(options.rootId);
    }
    if (options.garder !== undefined) {
      conditions.push("root_id NOT IN (SELECT value FROM json_each(?))");
      values.push(JSON.stringify([...options.garder]));
    }
    const rows = this.#db
      .prepare(`UPDATE conversation_autonomy SET choix = 'demander', depuis = ?, retour_cause = ? WHERE ${conditions.join(" AND ")} RETURNING root_id`)
      .all(...values) as Array<{ root_id: string }>;
    return rows.map((row) => row.root_id).sort();
  }

  /** Réservé aux plans (L6b) : racine de plan, choix « plan » permanent, conversation d'origine (null : nouvelle conversation). */
  setPlan(rootId: string, planSourceId: string | null, depuis: number): void {
    this.#db
      .prepare(
        `INSERT INTO conversation_autonomy (root_id, choix, plafonds, depuis, retour_cause, plan_source_id) VALUES (?, 'plan', '{}', ?, NULL, ?)
         ON CONFLICT(root_id) DO UPDATE SET choix = 'plan', depuis = excluded.depuis, retour_cause = NULL, plan_source_id = excluded.plan_source_id`,
      )
      .run(rootId, depuis, planSourceId);
  }

  /** Réservé aux plans (L6b) : racine d'exécution du plan `planId` ; son choix reste celui posé (« demander » si aucun). */
  setExecutionDePlan(rootId: string, planId: string, depuis: number): void {
    this.#db
      .prepare(
        `INSERT INTO conversation_autonomy (root_id, choix, plafonds, depuis, retour_cause, execution_de_plan_id) VALUES (?, 'demander', '{}', ?, NULL, ?)
         ON CONFLICT(root_id) DO UPDATE SET execution_de_plan_id = excluded.execution_de_plan_id`,
      )
      .run(rootId, depuis, planId);
  }
}

// --- Événement et fait « choix » ------------------------------------------------------------------------------------------------

/** Événement autonomie.choix et fait « choix » (sans texte) par racine ; un fait refusé n'annule pas le choix déjà écrit. */
function announceChoice(c11: Cockpit11, rootIds: readonly string[], choix: AutonomyChoice, cause: ChoiceCause, at: number): void {
  const facts: ActivityFact[] = [];
  for (const rootId of rootIds) {
    emitCockpit(c11.hub, "autonomie.choix", { rootId, choix, cause });
    const data: ChoixFactData = { choix, cause };
    try {
      facts.push(assertFact({ rootId, sessionId: rootId, kind: "choix", ref: null, data, at }));
    } catch (err) {
      c11.log.warn("autonomie : fait « choix » refusé", { error: errorMessage(err) });
    }
  }
  if (facts.length === 0) return;
  try {
    c11.ports.facts.append(facts);
  } catch (err) {
    c11.log.warn("autonomie : fait « choix » non écrit", { conversations: facts.length, error: errorMessage(err) });
  }
}

/**
 * Retour à « Demander à chaque fois » (§4.11, décision n° 10) des choix automatiques, pour `rootId` ou pour toutes les
 * conversations, sauf les racines de `garder` : ligne (retour_cause), événement et fait « choix » par racine changée. Rend les
 * racines changées. Démarrage du cockpit (redemarrage-cockpit) ; réutilisable par les plafonds et l'activation.
 */
export function returnToAsk(c11: Cockpit11, cause: ChoiceCause, scope: { rootId?: string; garder?: readonly string[] } = {}): string[] {
  const now = Date.now();
  const roots = new ConversationAutonomyStore(c11.db).resetAutomatic({
    depuis: now,
    cause,
    ...(scope.rootId === undefined ? {} : { rootId: scope.rootId }),
    ...(scope.garder === undefined ? {} : { garder: scope.garder }),
  });
  announceChoice(c11, roots, "demander", cause, now);
  return roots;
}

// --- Service et port ------------------------------------------------------------------------------------------------------------

/** Du plus restrictif au plus permissif : aller vers la droite, c'est relâcher. « plan » est à part (posé par les plans). */
const RANK: Readonly<Record<ClickableChoice, number>> = { demander: 0, modifications: 1, autonome: 2 };

const isAutomatic = (choix: AutonomyChoice): choix is AutomaticChoice => choix === "modifications" || choix === "autonome";

type Refusal = Extract<AutonomyPutResult, { ok: false }>;

const refusal = (status: Refusal["status"], error: Refusal["error"], raison: ActivationRefusalCode | null = null): Refusal => ({ ok: false, status, error, raison });

const sameRow = (a: StoredAutonomy | null, b: StoredAutonomy | null) => JSON.stringify(a) === JSON.stringify(b);

export interface ConversationAutonomyService {
  port: ConversationAutonomyPort;
  store: ConversationAutonomyStore;
  /**
   * Heure d'installation du module, montrée comme `depuis` d'un choix périmé. Jamais comparée à l'heure d'une ligne : un choix
   * automatique est tenu pour posé par ce démarrage seulement si CE service l'a écrit (aucune horloge entre deux démarrages).
   */
  readonly bootAt: number;
  /** Étape de démarrage : choix automatiques des démarrages précédents remis à « demander » (redemarrage-cockpit), avec leur fait. */
  returnToAskAtStartup(): Promise<void>;
}

/** Service réel : lit les autres ports (activation, facts, requests) au moment de l'appel, jamais en copie. */
export function createConversationAutonomy(c11: Cockpit11): ConversationAutonomyService {
  const store = new ConversationAutonomyStore(c11.db);
  const bootAt = Date.now();

  /**
   * Racines dont le choix automatique a été écrit par CE démarrage (apply). Aucune heure n'est comparée d'un démarrage à l'autre :
   * une horloge qui recule ne ferait plus passer un choix automatique pour récent (§4.11, décision n° 10).
   */
  const posedNow = new Set<string>();

  /** Choix automatique posé par un démarrage précédent (§4.11) : jamais appliqué. Avec COCKPIT_AUTONOMY=off, c'est le cas de tous. */
  const stale = (row: StoredAutonomy | null): boolean => row !== null && isAutomatic(row.choix) && !posedNow.has(row.rootId);

  /** Ligne telle qu'elle s'applique : un choix périmé est lu « demander », cause redemarrage-cockpit, sans écriture. */
  const effective = (row: StoredAutonomy | null): StoredAutonomy | null =>
    row && stale(row) ? { ...row, choix: "demander", depuis: bootAt, retourCause: "redemarrage-cockpit" } : row;

  /** Avant une écriture : un choix périmé est d'abord remis à « demander » (ligne, événement, fait), puis la ligne est relue. */
  const settle = (rootId: string): StoredAutonomy | null => {
    const row = store.read(rootId);
    if (!stale(row)) return row;
    returnToAsk(c11, "redemarrage-cockpit", { rootId });
    return store.read(rootId);
  };

  /**
   * Relâchements en cours de vérification, par racine. Toute demande de choix arrivée ensuite (resserrer, autre relâchement,
   * retour au démarrage) avance la génération : le relâchement vérifié avant elle n'est plus appliqué (le dernier choix l'emporte).
   * Entrée retirée quand plus aucune vérification n'attend : la table reste bornée aux vérifications en vol.
   */
  const inFlight = new Map<string, { checks: number; generation: number }>();
  const supersede = (rootId: string) => {
    const entry = inFlight.get(rootId);
    if (entry) entry.generation++;
  };

  /** Racine de conversation de l'instance principale : ni enfant, ni session interne (classement, contrôle, étape), ni supprimée. */
  const rootSession = async (rootId: string): Promise<SessionRow | null> => {
    if (!SESSION_ID_RE.test(rootId)) return null;
    const row = c11.sessions.get(rootId) ?? (await c11.sessions.ensure(rootId));
    if (!row || row.parent_id !== null || row.root_id !== row.id || row.purpose !== "chat" || row.deleted_at !== null) return null;
    // P11 : une conversation de la Salle OMO n'est jamais servie par ces routes (son seul choix, « omo », vient en 2 ter).
    return row.instance === "principale" ? row : null;
  };

  /** Plafonds en vigueur : réglages, puis ceux de la conversation ; le coût jamais au-delà de plafondMaxUsd (arrêt plus tôt). */
  const effectiveCaps = (stored: Partial<AutonomyCaps>): AutonomyCaps => {
    const settings = c11.settings.get().budget.autonomie;
    const caps: AutonomyCaps = {
      plafondUsd: settings.plafondUsd,
      actionsMax: settings.actionsMax,
      delegationsMax: settings.delegationsMax,
      dureeMinutes: settings.dureeMinutes,
      fichiersMax: settings.fichiersMax,
      controlesIaMax: settings.controlesIaMax,
      ...stored,
    };
    caps.plafondUsd = Math.min(caps.plafondUsd, settings.plafondMaxUsd);
    return caps;
  };

  const activationInput = (session: SessionRow, choix: AutomaticChoice) => ({
    rootId: session.id,
    choix,
    agent: session.agent,
    directory: session.directory || null,
  });

  const availability = async (session: SessionRow): Promise<AutonomyChoiceAvailability[]> => {
    if (effective(store.read(session.id))?.choix === "plan") {
      return (["demander", "modifications", "plan", "autonome"] as const).map((choix) =>
        choix === "plan" ? { choix, disponible: true, raison: null } : { choix, disponible: false, raison: "racine-de-plan" },
      );
    }
    const automatic = async (choix: AutomaticChoice): Promise<AutonomyChoiceAvailability> => {
      if (!c11.env.autonomy) return { choix, disponible: false, raison: "autonomie-coupee" };
      const verdict = await c11.ports.activation.check(activationInput(session, choix));
      return verdict.ok ? { choix, disponible: true, raison: null } : { choix, disponible: false, raison: verdict.raison };
    };
    const [modifications, autonome] = await Promise.all([automatic("modifications"), automatic("autonome")]);
    return [{ choix: "demander", disponible: true, raison: null }, modifications, { choix: "plan", disponible: false, raison: "nouvelle-conversation" }, autonome];
  };

  const view = async (session: SessionRow): Promise<ConversationAutonomyView> => {
    const disponibles = await availability(session);
    // Relu après les vérifications : la vue montre le choix en vigueur à la réponse.
    const stored = effective(store.read(session.id));
    return {
      rootId: session.id,
      choix: stored?.choix ?? "demander",
      plafonds: effectiveCaps(stored?.plafonds ?? {}),
      depuis: stored?.depuis ?? null,
      retourCause: stored?.retourCause ?? null,
      planSourceId: stored?.planSourceId ?? null,
      executionDePlanId: stored?.executionDePlanId ?? null,
      interrupteur: c11.env.autonomy,
      disponibles,
      demande: c11.ports.requests.current(session.id),
    };
  };

  /** Écrit le choix s'il change quelque chose ; événement et fait « choix » (cause clic) seulement quand le choix change. */
  const apply = (rootId: string, stored: StoredAutonomy | null, choix: ClickableChoice, plafonds: Partial<AutonomyCaps>) => {
    const changed = (stored?.choix ?? "demander") !== choix;
    const capsChanged = CAP_KEYS.some((key) => stored?.plafonds[key] !== plafonds[key]);
    if (!changed && !capsChanged) return;
    const now = Date.now();
    store.write(rootId, {
      choix,
      plafonds,
      depuis: changed || stored === null ? now : stored.depuis,
      retourCause: changed ? null : (stored?.retourCause ?? null),
    });
    // Choix automatique écrit par ce démarrage : il s'applique jusqu'au prochain, quelle que soit l'heure de l'horloge.
    if (isAutomatic(choix)) posedNow.add(rootId);
    else posedNow.delete(rootId);
    if (changed) announceChoice(c11, [rootId], choix, "clic", now);
  };

  /**
   * Activation d'un choix automatique par le port activation, gardée contre les choix arrivés pendant la vérification : une autre
   * demande de choix (génération avancée) ou une autre écriture de la ligne (retour à « demander » par un autre module) l'emporte.
   * Rend null si le choix peut être écrit, sinon le refus (raison null : remplacé pendant la vérification).
   */
  const checkActivation = async (session: SessionRow, choix: AutomaticChoice, snapshot: StoredAutonomy | null): Promise<Refusal | null> => {
    const entry = inFlight.get(session.id) ?? { checks: 0, generation: 0 };
    inFlight.set(session.id, entry);
    const generation = ++entry.generation;
    entry.checks++;
    let verdict: ActivationVerdict;
    try {
      verdict = await c11.ports.activation.check(activationInput(session, choix));
    } finally {
      entry.checks--;
      if (entry.checks === 0 && inFlight.get(session.id) === entry) inFlight.delete(session.id);
    }
    if (entry.generation !== generation || !sameRow(store.read(session.id), snapshot)) return refusal(409, "autonomie-indisponible");
    return verdict.ok ? null : refusal(409, "autonomie-indisponible", verdict.raison);
  };

  /**
   * Choix automatique demandé : 403 si COCKPIT_AUTONOMY=off ; relâcher (choix plus permissif ou plafond relevé) → 428 sans
   * confirmation, puis port activation (« verifie » ou refus) ; resserrer (Autonome → Modifications, plafonds abaissés) ou garder
   * → « immediat », sans activation.
   */
  const guardAutomatic = async (
    session: SessionRow,
    stored: StoredAutonomy | null,
    choix: AutomaticChoice,
    plafonds: Partial<AutonomyCaps>,
    confirmed: boolean,
  ): Promise<Refusal | "verifie" | "immediat"> => {
    if (!c11.env.autonomy) return refusal(403, "autonomie-coupee", "autonomie-coupee");
    const current: ClickableChoice = stored === null || stored.choix === "plan" ? "demander" : stored.choix;
    const before = effectiveCaps(stored?.plafonds ?? {});
    const after = effectiveCaps(plafonds);
    if (RANK[choix] <= RANK[current] && CAP_KEYS.every((key) => after[key] <= before[key])) return "immediat";
    if (!confirmed) return refusal(428, "confirmation-requise");
    return (await checkActivation(session, choix, stored)) ?? "verifie";
  };

  const put: ConversationAutonomyPort["put"] = async (rootId, body, options): Promise<AutonomyPutResult> => {
    // Corps revalidé ici : la route le passe tel que lu, et d'autres modules (plans, L6b) appellent aussi ce port.
    const parsed = putBodySchema.safeParse(body);
    if (!SESSION_ID_RE.test(rootId) || !parsed.success) return refusal(400, "invalid");
    const { choix, plafonds: requested } = parsed.data;
    if ((requested?.plafondUsd ?? 0) > c11.settings.get().budget.autonomie.plafondMaxUsd) return refusal(400, "invalid");
    const session = await rootSession(rootId);
    if (!session) return refusal(404, "not-found");

    const stored = settle(rootId);
    if (stored?.choix === "plan") {
      // Conversation de plan : « plan » permanent (§4.9), rien d'autre ne s'y applique.
      if (choix === "plan" && requested === undefined) return { ok: true, view: await view(session) };
      return refusal(409, "autonomie-indisponible", "racine-de-plan");
    }
    // « Plan d'abord » s'ouvre dans une nouvelle conversation (POST /api/plans, L6b), jamais par ce port.
    if (choix === "plan") return refusal(409, "autonomie-indisponible", "nouvelle-conversation");

    const plafonds: Partial<AutonomyCaps> = { ...stored?.plafonds, ...requested };
    const outcome = isAutomatic(choix) ? await guardAutomatic(session, stored, choix, plafonds, options.confirmed) : "immediat";
    if (typeof outcome === "object") return outcome;
    // Resserrer ou garder (« demander » compris, même avec COCKPIT_AUTONOMY=off) : immédiat ; un relâchement encore en
    // vérification pour cette conversation n'est plus appliqué.
    if (outcome === "immediat") supersede(rootId);
    apply(rootId, stored, choix, plafonds);
    return { ok: true, view: await view(session) };
  };

  const port: ConversationAutonomyPort = {
    get: async (rootId) => {
      const session = await rootSession(rootId);
      return session ? view(session) : null;
    },
    choiceOf: (id) => {
      if (!SESSION_ID_RE.test(id)) return "demander";
      // Une demande d'enfant porte l'identifiant de l'enfant : le choix est celui de sa racine (§4.1).
      return effective(store.read(c11.sessions.rootOf(id) ?? id))?.choix ?? "demander";
    },
    put,
  };

  return {
    port,
    store,
    bootAt,
    async returnToAskAtStartup() {
      const roots = returnToAsk(c11, "redemarrage-cockpit", { garder: [...posedNow] });
      for (const rootId of roots) supersede(rootId);
      if (roots.length > 0) c11.log.info("autonomie : choix automatiques revenus à « demander » au démarrage", { conversations: roots.length });
    },
  };
}

export const conversationAutonomyModule: Cockpit11Module = {
  name: "conversationAutonomy",
  install(reg, c11) {
    const service = createConversationAutonomy(c11);
    c11.ports.conversationAutonomy = service.port;
    reg.startup(() => service.returnToAskAtStartup());
    reg.routes("autonomy", (app) => registerAutonomyRoutes(app, c11));
  },
};
