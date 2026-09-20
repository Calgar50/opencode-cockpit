// Propriétaire : L10c.
// Surveillance d'une demande autonome : plafonds (spécification §4.8.1, décision n° 9), « Passé sans contrôle » (§4.10) et
// redémarrages d'opencode (§4.11, décision n° 10) ; plan d'exécution, fiche L10c. Tout est fait HORS de la file des réponses.
//
// 1. PLAFONDS. Les verdicts viennent de `capReached()` / `CAP_ORDER` (L9b) : ce module ne réécrit aucune règle, il applique
//    l'effet. Ils sont revus à chaque `usage.updated {rootId}` (abonnement au hub) et à chaque événement du flux qui peut avoir
//    changé un compteur de la demande (réponse à une demande d'autorisation, message clos, repos, appel d'outil terminé), plus au
//    sondage (§4, durée d'une demande qui n'envoie plus rien).
//    - Coût : `ports.stopTree.run(rootId, « plafond-cout »)` — il clôt la demande (fin `plafond-cout`), refuse les demandes
//      d'autorisation en attente, arrête l'arbre et écrit le fait `statut {cause: plafond}` — PUIS retour à « Demander à chaque
//      fois » (`returnToAsk`, cause `plafond-cout` : ligne `retour_cause`, fait `choix`, événement `autonomie.choix`).
//    - Actions (60), durée (30 min, horloge injectable) et fichiers (25) : fin de la demande (`ports.requests.interrupt`), fait
//      `statut {cause: plafond}` et retour à « Demander à chaque fois ». Rien n'est arrêté : le travail en cours va au bout, les
//      actions suivantes vous attendent.
//    - Délégations (5) et contrôles par IA (20) : COMPTEURS seulement, annoncés une fois par demande avec leur phrase exacte
//      (`phrasePlafond`). Leur effet appartient à la délégation en Autonome (L10e : refus en Simple, attente en Avancé) et à l'IA
//      de contrôle (L11b : « plafond-controles », donc attente) ; ni arrêt, ni retour à « Demander ».
//    La phrase affichée est TOUJOURS celle de L9b (`phrasePlafond`, `phraseFin`, `phraseRetour`) : aucune n'est écrite ici.
// 2. « PASSÉ SANS CONTRÔLE » (§4.10). Une partie `bash` TERMINÉE (`completed` ou `error`) dont le `callID` n'a porté aucun
//    `permission.asked`, et dont la commande est reconnue par `isNoRequestShellForm` (L8a, formes F-l), a échappé au contrôle.
//    En choix automatique : `stopTree(rootId, « non-controle »)`, qui écrit lui-même le fait `statut {cause: non-controle}` de
//    l'arrêt. Ailleurs (« Demander à chaque fois », « Plan d'abord ») : une ligne de Journal et un fait `detection
//    {cas: non-controle}`, sans rien arrêter — jamais un fait `statut {cause}`, que le réducteur d'activité lit comme un ARRÊT de
//    la conversation (il fermerait l'attente d'accord en cours). Une ligne de Journal est écrite dans les deux cas (verdict
//    `non-controle`, §4.12), et avec elle UN fait `decision` (D-01, §7.4), sans lequel le Déroulé ne lit jamais le Journal.
//    Mesure MX2 §2 (M5, [MESURÉ] ×3) : la partie `bash` est publiée 3 à 4 ms AVANT l'effet disque, mais un `abort` envoyé 2,6 ms
//    avant l'effet n'empêche pas la commande. La prévention n'est pas fiable : la DÉTECTION APRÈS COUP reste la parade, et la
//    phrase « le cockpit les repère après coup » est conservée telle quelle. Ce module agit donc sur l'état terminal de la partie,
//    jamais sur `running` : agir sur `running` n'empêcherait rien et confondrait un appel dont la demande arrive dans la même
//    milliseconde (MX2 : `echo a > f` demande bien `bash`, et sa demande arrive à l'horodatage du `running`).
//    Mesure MX2 §3 (F-l) : la liste des formes sans demande fait foi côté L8a ; elle est consommée ici, jamais redéfinie.
// 3. REDÉMARRAGES D'OPENCODE (§4.11, mesure MX1 §2 / M14). `global.disposed`, `server.instance.disposed` du dossier de la demande,
//    ou `session.error` MessageAbortedError de la session racine : demande `interrompue`, fait `statut {cause: interrompue}` et
//    retour à « Demander à chaque fois » (cause `interrompue`). M14 : les demandes d'autorisation disparaissent SANS
//    `permission.replied`, et le flux n'est pas coupé.
// 4. REPLI PAR SONDAGE, GARDÉ (redémarrage du PROCESSUS : le flux est coupé, aucun des trois événements du point 3 n'arrive ;
//    cas non mesuré, MX1 §9). Sondage périodique, armé seulement tant qu'une demande est ouverte. Garde : il ne sonde que les
//    conversations dont au moins une demande d'autorisation a été vue `asked` sans `replied`. Il relit alors `gate.pending`
//    (lecture seule) : si AUCUNE de ces demandes n'existe plus chez opencode, elles ont disparu sans réponse — opencode a
//    redémarré — et la demande passe `interrompue`. Lecture illisible : rien n'est affirmé. Le sondage revoit aussi les plafonds,
//    ce qui couvre la durée d'une demande qui n'envoie plus aucun événement.
// 5. REPRISE AU DÉMARRAGE DU COCKPIT (`recover`, inscription `startup`, après `conversationAutonomy` et `internalAgents.ensureAll`) :
//    les demandes encore ouvertes gardent leur surveillance jusqu'au repos (§4.11), leurs plafonds sont revus aussitôt et le
//    sondage est armé. Le retour des choix à « Demander à chaque fois » du démarrage appartient à L6a, qui passe avant.
// 6. GARDE DE RECHARGEMENT pendant un examen (§3.11, décision du 15/09) : rien n'est branché ici. `reloadBusy` est composé par
//    `wiring-11` à partir de `ports.autonomy.examining()` et branché par L1a ; ce paquet en écrit les tests.
// P4 : aucune réponse d'autorisation n'est envoyée (le refus des attentes pendant un arrêt appartient à `stopTree`). P5 : aucun
// appel facturé n'est lancé, et les seuils budgétaires mensuels (80 / 100 %) ne sont JAMAIS confirmés ici : `usage.updated` ne
// sert qu'à relire les plafonds de la demande. P6 : lectures seules (`GET /permission` par le portillon) ; aucune écriture de la
// configuration d'opencode, aucun `dispose`, aucun redémarrage d'instance.
// Limites dites : un compteur ou un plafond illisible donne le plafond pour atteint (`capReached`, prudent) ; une commande
// illisible ou trop longue n'est jamais donnée pour « passée sans contrôle » (rien n'est affirmé) ; le dépassement annoncé du
// plafond de coût est l'appel en cours de chaque assistant au travail (phrase de L9b).
// neutralCapWatch reste exporté et inchangé : c'est le port des tests qui ne déclarent pas ce module (plan §2.2).
import { AutonomyRequestStore } from "./autonomy-requests.ts";
import type { CapWatchPort, Cockpit11, Cockpit11Module, EventDerivation, UsageUpdatedData } from "./contracts-11.ts";
import { returnToAsk } from "./conversation-autonomy.ts";
import { errorMessage } from "./log.ts";
import type { OcGlobalEvent } from "./opencode.ts";
import { redactSecrets } from "./redact.ts";
import { assertFact } from "./shared/activity-facts.ts";
import type { ActivityFact, DecisionFactData, DetectionFactData, StatutCause, StatutFactData } from "./shared/activity-types.ts";
import { AUTONOMY_RULES_VERSION, type CapHit, capReached } from "./shared/autonomy-rules.ts";
import { phrasePlafond, phraseRetour } from "./shared/autonomy-texts.ts";
import type { AutonomyChoice, AutonomyRequestView, ChoiceCause } from "./shared/autonomy-types.ts";
import { raisonNonControle } from "./shared/autonomy-watch-texts.ts";
import { ID_RE } from "./shared/ids.ts";
import { isNoRequestShellForm } from "./shared/shell-gate.ts";

export function neutralCapWatch(): CapWatchPort {
  return {};
}

// --- Bornes ------------------------------------------------------------------------------------------------------------------------

/** Période du repli par sondage (§4 de l'en-tête) ; armé seulement tant qu'une demande autonome est ouverte. */
export const CAP_POLL_INTERVAL_MS = 60_000;
/** Conversations relues d'un coup (reprise au démarrage, libération d'instance, sondage). */
export const WATCH_ROOTS_MAX = 200;
/** Appels d'outil gardés en mémoire (demandes vues, appels déjà traités). */
export const WATCH_CALLS_MAX = 5_000;
/** Demandes d'autorisation gardées en attente par conversation, pour la garde du sondage. */
export const WATCH_PENDING_MAX = 200;
/** Commande lue au plus dans une partie `bash` ; au-delà : illisible, rien n'est affirmé. */
export const COMMAND_MAX = 4_000;
/** Résumé de l'action au Journal du contrôle (§4.12), même borne que le cycle d'autonomie. */
export const RESUME_MAX = 120;
/** Longueur maximale d'un callID (même borne que le portillon et le cycle d'autonomie). */
const CALL_ID_MAX_LENGTH = 512;

/** Code de règle du Journal pour une commande passée sans contrôle : la famille des formes sans demande (§4.10, mesure MX2 §3). */
export const NON_CONTROLE_RULE = "F-l";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const idOf = (value: unknown): string | null => (typeof value === "string" && ID_RE.test(value) ? value : null);
const callIdOf = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= CALL_ID_MAX_LENGTH ? value : null;
const textOf = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** Session citée par un événement : `sessionID` des propriétés, sinon celui de `info` (message.updated). */
const sessionOf = (p: Record<string, unknown>): string | null => {
  const direct = idOf(p.sessionID);
  if (direct !== null) return direct;
  const info = isRecord(p.info) ? p.info : null;
  return info === null ? null : idOf(info.sessionID);
};

/** Ensemble borné : au-delà de la borne, l'entrée la plus ancienne est oubliée (aucune mémoire qui grossit sans fin). */
class BoundedSet {
  readonly #limit: number;
  readonly #set = new Set<string>();

  constructor(limit: number) {
    this.#limit = limit;
  }

  get size(): number {
    return this.#set.size;
  }

  has(key: string): boolean {
    return this.#set.has(key);
  }

  add(key: string): void {
    this.#set.delete(key);
    this.#set.add(key);
    if (this.#set.size > this.#limit) {
      const oldest = this.#set.values().next();
      if (!oldest.done) this.#set.delete(oldest.value);
    }
  }

  delete(key: string): void {
    this.#set.delete(key);
  }

  values(): string[] {
    return [...this.#set];
  }

  clear(): void {
    this.#set.clear();
  }
}

/** Plafonds comptés seulement (§4.8.1) : leur effet appartient à L10e et à L11b. */
type CounterCap = "delegations" | "controles";

const COUNTER_CAPS: ReadonlyArray<readonly [CounterCap, (view: AutonomyRequestView) => boolean]> = [
  ["delegations", (view) => view.delegations >= view.plafonds.delegationsMax],
  ["controles", (view) => view.controles >= view.plafonds.controlesIaMax],
];

/** Choix qui répondent sans vous (§4.1) : eux seuls ouvrent une demande autonome et font arrêter « Passé sans contrôle ». */
function isAutomatic(choix: AutonomyChoice): boolean {
  return choix === "modifications" || choix === "autonome";
}

// --- Service -----------------------------------------------------------------------------------------------------------------------

export interface CapWatchOptions {
  /** Horloge injectable : `server/shared` reste pur, l'heure des plafonds vient toujours d'ici (plafond de durée). */
  now?: () => number;
  /** Travail lancé hors de l'appel de la dérivation (défaut : microtâche). */
  defer?: (fn: () => void) => void;
  /** Période du sondage (défaut CAP_POLL_INTERVAL_MS). */
  pollIntervalMs?: number;
  /** Minuterie du sondage ; rend la fonction qui l'arrête. Défaut : setInterval non bloquant (unref). */
  schedule?: (tick: () => Promise<void>, ms: number) => () => void;
}

export interface CapWatch {
  port: CapWatchPort;
  derivation: EventDerivation;
  /** Abonnement `usage.updated` : plafonds revus pour la conversation citée, ou pour toutes après un rattrapage. */
  onUsage(data: UsageUpdatedData): void;
  /** Inscription `startup` : reprise de la surveillance des demandes encore ouvertes. */
  recover(): Promise<void>;
  /** Un tour de sondage (tests : appelé à la main, aucune attente réelle). */
  poll(): Promise<void>;
  /** Arrête le sondage (tests). */
  stop(): void;
}

function defaultSchedule(tick: () => Promise<void>, ms: number): () => void {
  const timer = setInterval(() => void tick(), ms);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function createCapWatch(c11: Cockpit11, options: CapWatchOptions = {}): CapWatch {
  const now = options.now ?? Date.now;
  const defer = options.defer ?? queueMicrotask;
  const pollIntervalMs = options.pollIntervalMs ?? CAP_POLL_INTERVAL_MS;
  const schedule = options.schedule ?? defaultSchedule;
  const store = new AutonomyRequestStore(c11.db);
  const log = c11.log;

  /** Appels d'outil dont une demande d'autorisation a été vue (« session|callID ») : ils sont passés par le contrôle. */
  const askedCalls = new BoundedSet(WATCH_CALLS_MAX);
  /** Appels `bash` déjà examinés par « Passé sans contrôle » : un appel ne compte qu'une fois. */
  const seenCalls = new BoundedSet(WATCH_CALLS_MAX);
  /** Demandes d'autorisation vues `asked` sans `replied`, par conversation : garde du sondage. */
  const waiting = new Map<string, BoundedSet>();
  /** Plafonds comptés déjà annoncés, par demande (« requestId|plafond ») : une annonce par demande. */
  const announced = new BoundedSet(WATCH_ROOTS_MAX * COUNTER_CAPS.length);
  /** Conversations dont l'effet d'un plafond ou d'un redémarrage est en cours : jamais deux fois de suite. */
  const reacting = new Set<string>();
  let stopTimer: (() => void) | null = null;

  const mode = () => c11.settings.get().ui.mode;

  // --- Lectures ------------------------------------------------------------------------------------------------------------------

  /** Racine de conversation suivie de l'instance principale pour `sessionId` ; null : rien à surveiller ici. */
  const rootOf = (sessionId: string | null): string | null => {
    if (sessionId === null) return null;
    const rootId = c11.sessions.rootOf(sessionId);
    if (rootId === null) return null;
    const root = c11.sessions.get(rootId);
    if (!root || root.parent_id !== null || root.root_id !== root.id || root.purpose !== "chat" || root.deleted_at !== null) return null;
    return root.instance === "principale" ? rootId : null;
  };

  /** Demande autonome en cours d'une conversation ; null : aucune (ou port neutre). */
  const current = (rootId: string): AutonomyRequestView | null => {
    try {
      const view = c11.ports.requests.current(rootId);
      return view !== null && view.endedAt === null && view.fin === null ? view : null;
    } catch (err) {
      log.warn("surveillance : demande autonome illisible", { rootId, error: errorMessage(err) });
      return null;
    }
  };

  /** Conversations qui ont une demande autonome ouverte, les plus récentes d'abord. */
  const openRoots = (): string[] => {
    try {
      return store.openRoots(WATCH_ROOTS_MAX);
    } catch (err) {
      log.warn("surveillance : demandes autonomes en cours illisibles", { error: errorMessage(err) });
      return [];
    }
  };

  const choiceOf = (rootId: string): AutonomyChoice => {
    try {
      return c11.ports.conversationAutonomy.choiceOf(rootId);
    } catch (err) {
      log.warn("surveillance : choix d'autonomie illisible", { rootId, error: errorMessage(err) });
      return "demander";
    }
  };

  // --- Écritures communes --------------------------------------------------------------------------------------------------------

  /** Fait `statut {cause}` de la conversation (écrivain des faits : ports.facts, L4b) : un ARRÊT, jamais une simple détection. */
  const statutFact = (rootId: string, sessionId: string, cause: StatutCause, motif: string | null): void => {
    const data: StatutFactData = { cause, ...(motif === null ? {} : { motif }) };
    try {
      const fact: ActivityFact = { rootId, sessionId, kind: "statut", ref: null, data, at: now() };
      c11.ports.facts.append([assertFact(fact)]);
    } catch (err) {
      log.warn("surveillance : fait « statut » non écrit", { rootId, cause, error: errorMessage(err) });
    }
  };

  /** Fin d'une demande décidée ici (plafond sans arrêt, redémarrage d'opencode) : L10a écrit la ligne et l'événement. */
  const endRequest = (rootId: string, fin: AutonomyRequestView["fin"]): void => {
    if (fin === null) return;
    try {
      c11.ports.requests.interrupt(rootId, fin);
    } catch (err) {
      log.warn("surveillance : demande autonome non close", { rootId, fin, error: errorMessage(err) });
    }
  };

  /** Retour à « Demander à chaque fois » (§4.11) : ligne `retour_cause`, fait « choix », événement `autonomie.choix`. */
  const backToAsk = (rootId: string, cause: ChoiceCause): void => {
    try {
      const changed = returnToAsk(c11, cause, { rootId });
      if (changed.length > 0) log.info("autonomie : retour à « Demander à chaque fois »", { rootId, cause, phrase: phraseRetour(cause) });
    } catch (err) {
      log.warn("surveillance : retour à « Demander à chaque fois » en échec", { rootId, cause, error: errorMessage(err) });
    }
  };

  // --- 1. Plafonds ----------------------------------------------------------------------------------------------------------------

  /** Plafonds comptés (délégations, contrôles par IA) : une annonce par demande, avec la phrase exacte de L9b. */
  const announceCounters = (view: AutonomyRequestView): void => {
    for (const [cap, reached] of COUNTER_CAPS) {
      const key = `${view.id}|${cap}`;
      if (announced.has(key) || !reached(view)) continue;
      announced.add(key);
      log.info("autonomie : plafond compté atteint", { rootId: view.rootId, requestId: view.id, plafond: cap, phrase: phrasePlafond(cap, view, mode()) });
    }
  };

  /** Effet d'un plafond atteint (§4.8.1) : coût → arrêt de l'arbre ; actions, durée, fichiers → fin de la demande. Puis retour. */
  const applyCap = async (rootId: string, view: AutonomyRequestView, hit: CapHit): Promise<void> => {
    log.warn("autonomie : plafond atteint", {
      rootId,
      requestId: view.id,
      plafond: hit.plafond,
      fin: hit.fin,
      phrase: phrasePlafond(hit.plafond, view, mode()),
    });
    if (hit.effet === "arret") {
      try {
        // stopTree (L1c) : fin « plafond-cout », refus des attentes de l'arbre, arrêt des sessions, fait statut {cause: plafond}.
        await c11.ports.stopTree.run(rootId, "plafond-cout");
      } catch (err) {
        // Arrêt indisponible ou en échec : la demande est close quand même, et le fait est écrit ici (jamais de plafond ignoré).
        log.warn("autonomie : arrêt de l'arbre en échec au plafond de coût", { rootId, error: errorMessage(err) });
        endRequest(rootId, hit.fin);
        statutFact(rootId, rootId, "plafond", hit.fin);
      }
    } else {
      endRequest(rootId, hit.fin);
      statutFact(rootId, rootId, "plafond", hit.fin);
    }
    backToAsk(rootId, hit.cause);
  };

  /**
   * Plafonds d'une conversation revus (hors file). Les verdicts viennent de `capReached` (L9b) ; l'heure est celle de l'horloge
   * injectée. L'effet est lancé hors de l'appel : une dérivation reste synchrone et sans attente réseau.
   */
  const evaluate = (rootId: string): void => {
    const view = current(rootId);
    if (view === null) return;
    arm();
    announceCounters(view);
    if (reacting.has(rootId)) return;
    const hit = capReached({ startedAt: view.startedAt, spentUsd: view.spent, auto: view.auto, fichiers: view.fichiers }, view.plafonds, now());
    if (hit === null) return;
    reacting.add(rootId);
    defer(() => {
      void applyCap(rootId, view, hit)
        .catch((err: unknown) => log.warn("autonomie : plafond non appliqué", { rootId, error: errorMessage(err) }))
        .finally(() => reacting.delete(rootId));
    });
  };

  const evaluateSession = (sessionId: string | null): void => {
    const rootId = rootOf(sessionId);
    if (rootId !== null) evaluate(rootId);
  };

  // --- 2. « Passé sans contrôle » --------------------------------------------------------------------------------------------------

  /**
   * Une ligne du Journal du contrôle (§4.12) : verdict « non-controle », par le cockpit, jamais un texte de message.
   * Rend l'heure de la ligne, ou null si elle n'a pas pu être écrite (le fait « decision » suit la ligne, jamais l'inverse).
   */
  const journal = (input: { rootId: string; sessionId: string; requestId: string | null; callId: string; command: string; choix: AutonomyChoice }): number | null => {
    const at = now();
    const resume = redactSecrets(input.command).replace(/\s+/g, " ").trim().slice(0, RESUME_MAX);
    try {
      c11.db
        .prepare(
          `INSERT INTO autonomy_decisions (request_id, root_id, session_id, permission_id, permission, resume, choix, regle,
             rules_version, verdict, par, raison, ia_model, ia_cost, ia_ms, relais, asked_at, decided_at)
           VALUES (?, ?, ?, NULL, 'bash', ?, ?, ?, ?, 'non-controle', 'cockpit', ?, NULL, NULL, NULL, NULL, ?, ?)`,
        )
        .run(input.requestId, input.rootId, input.sessionId, resume, input.choix, NON_CONTROLE_RULE, AUTONOMY_RULES_VERSION, raisonNonControle(), at, at);
      return at;
    } catch (err) {
      log.warn("autonomie : « Passé sans contrôle » non journalisé", { rootId: input.rootId, error: errorMessage(err) });
      return null;
    }
  };

  /**
   * Fait « decision » de la ligne de Journal (D-01, §7.4 : UN fait par ligne de `autonomy_decisions`). Sans lui, le Déroulé (L12c)
   * ne lit jamais le Journal du contrôle : il ne le demande que si un fait « decision » existe. `ref` est l'appel d'outil, car
   * aucune demande d'autorisation n'a été posée (`permission_id` reste nul).
   */
  const decisionFact = (rootId: string, sessionId: string, callId: string, at: number): void => {
    const data: DecisionFactData = { verdict: "non-controle", regle: NON_CONTROLE_RULE };
    try {
      c11.ports.facts.append([assertFact({ rootId, sessionId, kind: "decision", ref: callId, data, at })]);
    } catch (err) {
      log.warn("autonomie : fait « decision » non écrit", { rootId, callId, error: errorMessage(err) });
    }
  };

  /**
   * Fait de DÉTECTION d'une commande passée sans contrôle, quand RIEN n'est arrêté. Jamais un fait `statut {cause}` : celui-là est
   * réservé aux vrais arrêts de L1c, et le réducteur d'activité (shared/activity.ts) le lit comme un arrêt de la conversation —
   * il fermerait les attentes d'accord en cours et dirait la conversation arrêtée alors qu'elle attend l'utilisateur.
   */
  const detectionFact = (rootId: string, sessionId: string, callId: string): void => {
    const data: DetectionFactData = { cas: "non-controle" };
    try {
      c11.ports.facts.append([assertFact({ rootId, sessionId, kind: "detection", ref: callId, data, at: now() })]);
    } catch (err) {
      log.warn("surveillance : fait « detection » non écrit", { rootId, callId, error: errorMessage(err) });
    }
  };

  /** Commande passée sans contrôle : arrêt en choix automatique, Journal seul ailleurs (§4.10). */
  const uncontrolled = async (rootId: string, sessionId: string, callId: string, command: string): Promise<void> => {
    const choix = choiceOf(rootId);
    const view = current(rootId);
    log.warn("autonomie : commande lancée sans demande d'autorisation, vue après coup", { rootId, sessionId, callId, choix });
    const at = journal({ rootId, sessionId, requestId: view?.id ?? null, callId, command, choix });
    if (at !== null) decisionFact(rootId, sessionId, callId, at);
    if (!isAutomatic(choix)) {
      detectionFact(rootId, sessionId, callId);
      return;
    }
    try {
      // stopTree (L1c) : fin « non-controle » de la demande et fait statut {cause: non-controle}.
      await c11.ports.stopTree.run(rootId, "non-controle");
    } catch (err) {
      // Arrêt en échec : rien n'a été arrêté, donc aucun fait d'arrêt — seulement la détection, et la fin de la demande.
      log.warn("autonomie : arrêt de l'arbre en échec après une commande sans contrôle", { rootId, error: errorMessage(err) });
      endRequest(rootId, "non-controle");
      detectionFact(rootId, sessionId, callId);
    }
  };

  /** Partie d'outil du flux : appel `bash` terminé sans demande d'autorisation et reconnu par L8a (formes F-l). */
  const onPart = (p: Record<string, unknown>): void => {
    const part = isRecord(p.part) ? p.part : null;
    if (!part || part.type !== "tool" || part.tool !== "bash") return;
    const state = isRecord(part.state) ? part.state : null;
    // Détection APRÈS COUP (mesure MX2 §2) : seul l'état terminal de la partie fait foi.
    if (!state || (state.status !== "completed" && state.status !== "error")) return;
    const sessionId = idOf(part.sessionID) ?? idOf(p.sessionID);
    const callId = callIdOf(part.callID);
    if (sessionId === null || callId === null) return;
    const key = `${sessionId}|${callId}`;
    if (seenCalls.has(key)) return;
    seenCalls.add(key);
    // Une demande d'autorisation a été posée pour cet appel : il est passé par le contrôle.
    if (askedCalls.has(key)) return;
    const input = isRecord(state.input) ? state.input : {};
    const command = typeof input.command === "string" && input.command.length <= COMMAND_MAX ? input.command : null;
    // Commande absente, illisible ou trop longue : rien n'est affirmé (P3).
    if (command === null) return;
    // Liste des formes sans demande : L8a en est le seul auteur (mesure MX2 §3), elle est consommée telle quelle.
    if (!isNoRequestShellForm(command)) return;
    const rootId = rootOf(sessionId);
    if (rootId === null) return;
    defer(() => {
      void uncontrolled(rootId, sessionId, callId, command).catch((err: unknown) =>
        log.warn("autonomie : « Passé sans contrôle » non traité", { rootId, error: errorMessage(err) }),
      );
    });
  };

  // --- 3. Redémarrages d'opencode ---------------------------------------------------------------------------------------------------

  /** Demande « interrompue » (§4.11) : fin, fait `statut {cause: interrompue}` et retour à « Demander à chaque fois ». */
  const interrupt = (rootId: string): void => {
    const view = current(rootId);
    if (view === null || reacting.has(rootId)) return;
    reacting.add(rootId);
    try {
      log.info("autonomie : demande interrompue, opencode a redémarré", { rootId, requestId: view.id });
      endRequest(rootId, "interrompue");
      statutFact(rootId, rootId, "interrompue", null);
      waiting.get(rootId)?.clear();
      backToAsk(rootId, "interrompue");
    } finally {
      reacting.delete(rootId);
    }
  };

  /** Libération d'instance : les demandes du dossier libéré (toutes si `global.disposed`) passent « interrompue ». */
  const onDisposed = (directory: string | null): void => {
    for (const rootId of openRoots()) {
      if (directory !== null) {
        const root = c11.sessions.get(rootId);
        if (!root || (root.directory === "" ? null : root.directory) !== directory) continue;
      }
      interrupt(rootId);
    }
  };

  /**
   * `session.error` MessageAbortedError de la session RACINE d'une conversation suivie (mesure MX1 §2). Restreint à la racine :
   * un travail délégué arrêté seul (« Task cancelled ») ne vaut pas un redémarrage d'opencode. Un arrêt voulu (« Arrêter »,
   * plafond de coût, « Passé sans contrôle ») a déjà clos la demande avant d'arrêter les sessions : `current` rend alors null.
   */
  const onSessionError = (p: Record<string, unknown>): void => {
    const error = isRecord(p.error) ? p.error : null;
    if (!error || error.name !== "MessageAbortedError") return;
    const sessionId = sessionOf(p);
    const rootId = rootOf(sessionId);
    if (rootId === null || rootId !== sessionId) return;
    interrupt(rootId);
  };

  // --- 4. Repli par sondage, gardé ---------------------------------------------------------------------------------------------------

  const pendingOf = (rootId: string): BoundedSet => {
    const known = waiting.get(rootId);
    if (known !== undefined) return known;
    if (waiting.size >= WATCH_ROOTS_MAX) waiting.delete(waiting.keys().next().value ?? "");
    const set = new BoundedSet(WATCH_PENDING_MAX);
    waiting.set(rootId, set);
    return set;
  };

  const forgetPermission = (permissionId: string): void => {
    for (const set of waiting.values()) set.delete(permissionId);
  };

  /**
   * Garde du sondage : seules les conversations dont au moins une demande d'autorisation attend encore sont sondées. Toutes
   * disparues de `GET /permission` sans réponse vue : opencode a redémarré (mesure MX1 §2), la demande est interrompue.
   */
  const probeRestart = async (rootId: string): Promise<void> => {
    const pending = waiting.get(rootId);
    if (pending === undefined || pending.size === 0) return;
    const root = c11.sessions.get(rootId);
    if (!root) return;
    const directory = root.directory === "" ? null : root.directory;
    let alive: Set<string>;
    try {
      alive = new Set((await c11.gate.pending(directory)).map((request) => request.id));
    } catch (err) {
      // Lecture illisible : rien n'est affirmé (P3).
      log.warn("surveillance : demandes d'autorisation en attente illisibles", { rootId, error: errorMessage(err) });
      return;
    }
    if (pending.values().some((id) => alive.has(id))) return;
    log.warn("autonomie : demandes d'autorisation disparues sans réponse, opencode a redémarré", { rootId, disparues: pending.size });
    interrupt(rootId);
  };

  const poll = async (): Promise<void> => {
    const roots = openRoots();
    if (roots.length === 0) {
      disarm();
      return;
    }
    for (const rootId of roots) {
      evaluate(rootId);
      await probeRestart(rootId);
    }
  };

  function arm(): void {
    if (stopTimer !== null) return;
    stopTimer = schedule(() => poll().catch((err: unknown) => log.warn("surveillance : sondage en échec", { error: errorMessage(err) })), pollIntervalMs);
  }

  function disarm(): void {
    stopTimer?.();
    stopTimer = null;
  }

  // --- Dérivation, abonnement, reprise ---------------------------------------------------------------------------------------------

  const derivation: EventDerivation = {
    name: "capWatch",
    onEvent(global: OcGlobalEvent): void {
      const event = isRecord(global) ? global.payload : null;
      if (!isRecord(event) || typeof event.type !== "string") return;
      const p = isRecord(event.properties) ? event.properties : null;
      if (p === null) return;
      switch (event.type) {
        case "permission.asked": {
          const permissionId = idOf(p.id);
          const sessionId = sessionOf(p);
          const tool = isRecord(p.tool) ? p.tool : null;
          const callId = tool === null ? null : callIdOf(tool.callID);
          if (sessionId !== null && callId !== null) askedCalls.add(`${sessionId}|${callId}`);
          const rootId = rootOf(sessionId);
          if (rootId === null) return;
          if (permissionId !== null) pendingOf(rootId).add(permissionId);
          evaluate(rootId);
          return;
        }
        case "permission.replied": {
          const permissionId = idOf(p.requestID);
          if (permissionId !== null) forgetPermission(permissionId);
          evaluateSession(sessionOf(p));
          return;
        }
        case "message.part.updated":
          onPart(p);
          return;
        case "message.updated":
        case "session.idle":
          evaluateSession(sessionOf(p));
          return;
        case "session.error":
          onSessionError(p);
          return;
        case "server.instance.disposed":
          onDisposed(textOf(p.directory) ?? textOf(global.directory));
          return;
        case "global.disposed":
          onDisposed(null);
          return;
        default:
          return;
      }
    },
  };

  const onUsage = (data: UsageUpdatedData): void => {
    if (!isRecord(data)) return;
    // P5 : `percent` (seuils mensuels 80 / 100 %) n'est jamais lu ici, et rien n'est confirmé automatiquement.
    const rootId = idOf(data.rootId);
    if (rootId !== null) {
      evaluate(rootId);
      return;
    }
    // Sans rootId (après un rattrapage) : toutes les demandes ouvertes sont revues.
    for (const id of openRoots()) evaluate(id);
  };

  const recover = async (): Promise<void> => {
    const roots = openRoots();
    log.info("autonomie : reprise de la surveillance des demandes en cours", { conversations: roots.length });
    for (const rootId of roots) evaluate(rootId);
    if (roots.length > 0) arm();
    await Promise.resolve();
  };

  return { port: {}, derivation, onUsage, recover, poll, stop: disarm };
}

/** Module « capWatch » avec une horloge, un sondage ou des bornes injectés (tests). Production : capWatchModule. */
export function capWatchModuleWith(options: CapWatchOptions = {}): Cockpit11Module {
  return {
    name: "capWatch",
    install(reg, c11) {
      const watch = createCapWatch(c11, options);
      c11.ports.capWatch = watch.port;
      reg.derivation(watch.derivation);
      reg.hub("usage.updated", (data) => watch.onUsage(data));
      reg.startup(() => watch.recover());
    },
  };
}

export const capWatchModule: Cockpit11Module = capWatchModuleWith();
