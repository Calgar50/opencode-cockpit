// Adresse de l'API Copilot imposée à opencode (options.baseURL du fournisseur github-copilot) quand le cockpit en retient une
// autre que l'adresse d'office : imposée par .env, ou adresse de l'abonnement quand le réseau bloque l'adresse générale.
// opencode 1.18.30 (mesuré) : l'état du fournisseur est rangé PAR DOSSIER. Un PATCH /global/config qui change le texte du
// fichier invalide le cache global et libère les instances en tâche de fond ; POST /global/dispose attend leur libération mais
// reconstruit les dossiers depuis le cache global, même périmé ; le fournisseur est reconstruit au prochain accès. Un PATCH sans
// changement de texte n'invalide rien, une écriture directe du fichier n'est jamais relue. Seul GET /config/providers?directory=…
// dit l'adresse réellement utilisée (jamais GET /global/config, simple cache, ni model.api.url). Jamais pendant une réponse : un
// dispose pendant les nouvelles tentatives d'une demande l'abandonne sans erreur.
import type { ModelCatalog } from "./catalog.ts";
import type { ConfigWriteQueue } from "./config-queue.ts";
import type { ControlService } from "./control.ts";
import type { CopilotApi, CopilotEndpoint } from "./copilot.ts";
import type { EventHub } from "./hub.ts";
import { errorMessage, type Logger } from "./log.ts";
import type { OpencodeClient } from "./opencode.ts";

export type CopilotSyncState = "inactif" | "a-jour" | "applique" | "en-attente" | "redemarrage-requis" | "echec";

/** Adresse utilisée par le fournisseur d'un dossier ("" = adresse d'office ; directory null = instance par défaut). */
export interface CopilotDirectoryCheck {
  directory: string | null;
  baseURL: string;
}

export interface CopilotSyncDetails {
  /** Adresse relue dans chaque dossier APRÈS la dernière écriture ; vide quand rien n'a pu être relu depuis. */
  checked: CopilotDirectoryCheck[];
  /** Durée de la libération des instances, quand il y en a eu une. */
  disposeMs?: number;
  /** Libération des instances confirmée par opencode (absent sans libération). */
  disposeOk?: boolean;
  /** Échec qu'un redémarrage d'opencode règle (libération ratée) ; jamais pour un PATCH refusé par opencode. */
  restartHelps?: boolean;
}

export interface CopilotSyncStatus {
  state: CopilotSyncState;
  message: string | null;
  at: number;
  details: CopilotSyncDetails;
}

/** Adresse d'office d'opencode sur github.com, valeur intermédiaire quand la cible est l'adresse d'office. */
export const OPENCODE_DEFAULT_COPILOT_URL = "https://api.githubcopilot.com";

const rec = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** Barres obliques finales retirées, en temps linéaire (réponse d'opencode non fiable). */
const trimUrl = (raw: unknown): string => {
  if (typeof raw !== "string") return "";
  let end = raw.length;
  while (end > 0 && raw.charCodeAt(end - 1) === 47) end--;
  return raw.slice(0, end);
};

/** Adresse à écrire : undefined tant que l'adresse retenue est inconnue ; "" = adresse d'office d'opencode. */
export function copilotBaseUrlTarget(endpoint: CopilotEndpoint | null): string | undefined {
  if (!endpoint) return undefined;
  return endpoint.url === endpoint.opencodeDefault ? "" : endpoint.url;
}

/** Adresse lue dans la configuration globale d'opencode ("" si aucune) : cache global, pas l'adresse utilisée. */
export function currentCopilotBaseUrl(effective: unknown): string {
  return trimUrl(rec(rec(rec(rec(effective)?.provider)?.["github-copilot"])?.options)?.baseURL);
}

/** Adresse utilisée par le fournisseur github-copilot d'après GET /config/providers ("" si aucune) ; erreur si illisible. */
export function providerBaseUrl(answer: unknown): string {
  const providers = rec(answer)?.providers;
  if (!Array.isArray(providers)) throw new Error("réponse de /config/providers illisible");
  const copilot = providers.map(rec).find((p) => p?.id === "github-copilot");
  return trimUrl(rec(copilot?.options)?.baseURL);
}

/**
 * Tout redémarrage d'opencode (page Diagnostic, fichier brut, profils de permissions, retours arrière, Studio, relance par le
 * superviseur) coupe son flux /global/event ; le processeur publie « opencode.connection » à chaque changement. Dès la coupure,
 * « synchro due » est posée jusqu'à la synchro de reconnexion, sans soupape tant que le flux reste coupé : opencode est injoignable
 * (le proxy répond 502) ou le cockpit ne peut pas suivre ses réponses, refuser ne coûte rien ; opencode peut aussi revenir sur
 * l'adresse d'office avant que le flux se rebranche (jusqu'à 10 s d'attente). À la reconnexion (jamais au premier branchement, qui
 * suit la synchro de démarrage), nouvelle pose puis adresse revérifiée dans chaque dossier. Des déclenchements rapprochés se
 * fondent dans sync() : une synchro à la fois, une seule relancée à sa fin. Rend le désabonnement.
 */
export function resyncOnReconnect(hub: Pick<EventHub, "subscribe">, sync: Pick<CopilotConfigSync, "sync" | "markDue">): () => void {
  let lost = false;
  return hub.subscribe((event) => {
    if (event.kind !== "cockpit" || event.type !== "opencode.connection") return;
    if (rec(event.data)?.connected !== true) {
      lost = true;
      sync.markDue("flux d'événements d'opencode coupé", "coupure");
      return;
    }
    if (!lost) return;
    lost = false;
    sync.markDue("flux d'événements d'opencode rétabli", "reconnexion");
    void sync.sync().catch(() => undefined);
  });
}

/**
 * Pendant un épisode « correction différée » (adresse fausse relue sans pouvoir l'écrire, soupape passée comprise) : synchro
 * relancée dès qu'une conversation passe au repos (session.idle, ou session.status de type idle, relayés par le processeur),
 * pour corriger l'adresse à la fin de la réponse plutôt qu'à la tentative suivante. Hors épisode : rien, aucune synchro à chaque
 * fin de réponse. Des fins rapprochées se fondent dans sync() ; une autre conversation encore occupée rend « en-attente » sans
 * réarmer la soupape de l'épisode. Conversations du classement automatique (non relayées) : tentatives planifiées seulement.
 * Rend le désabonnement.
 */
export function resyncOnIdle(hub: Pick<EventHub, "subscribe">, sync: Pick<CopilotConfigSync, "sync" | "deferredEpisode">): () => void {
  return hub.subscribe((event) => {
    if (event.kind !== "opencode") return;
    const { type, properties } = event.event;
    const idle = type === "session.idle" || (type === "session.status" && rec(rec(properties)?.status)?.type === "idle");
    if (!idle || !sync.deferredEpisode) return;
    void sync.sync().catch(() => undefined);
  });
}

const unreachable = (err: unknown) => `opencode injoignable : ${errorMessage(err)}`;
const BUSY_MESSAGE = "Une conversation travaille : adresse appliquée à la prochaine vérification.";
const RESTARTING_MESSAGE = "opencode redémarre : adresse vérifiée après le redémarrage.";
const SYNC_DUE_MESSAGE = "opencode redémarre ou recharge sa configuration : l'adresse sera revérifiée.";
const STREAM_DOWN_MESSAGE = "opencode est injoignable ou redémarre (flux d'événements coupé) : l'adresse sera revérifiée à la reconnexion.";
const STARTUP_WAIT_MESSAGE = "opencode ne répond pas encore : l'adresse sera vérifiée dès qu'il répondra.";
/** Cause de la « synchro due » d'un épisode « adresse fausse relue pendant une réponse, correction différée ». */
export const DEFERRED_CAUSE = "adresse Copilot fausse, correction différée";
/** Cause de la « synchro due » posée au démarrage du cockpit quand .env impose l'adresse cible. */
export const STARTUP_CAUSE = "démarrage du cockpit";
const shownUrl = (baseURL: string) => baseURL || "(adresse d'office)";

/**
 * Soupape : « synchro due » levée de force après ce délai, pour qu'un événement perdu ne bloque jamais les demandes facturées.
 * Jamais pendant une coupure du flux d'événements, ni sur une pose de démarrage tant qu'opencode n'a jamais répondu (markStartup) ;
 * comptée depuis la première détection pour un épisode « correction différée », et jamais appliquée à la pose de l'épisode pendant la
 * synchro qui la couvre (cette synchro est la correction, elle décide à sa fin).
 */
export const SYNC_DUE_MAX_MS = 90_000;

/**
 * Pendant un épisode « correction différée », la tentative suivante part au plus tard ce délai avant la soupape : sa tâche doit
 * seulement DÉMARRER avant l'échéance (elle garde ensuite la pose jusqu'à sa fin). Marge fixe plutôt qu'une durée prévue : elle
 * absorbe une tâche de la file en cours (écriture et libération mesurées vers 0,4 s, synchro vers 0,5 s) et le retard des minuteries,
 * sans dépendre d'une mesure précédente.
 */
export const SYNC_RETRY_LEAD_MS = 5_000;

/**
 * Délai minimal d'une tentative avancée avant la soupape : en dessous, la tentative suivante reprend le délai normal. Au plus une
 * tentative visant l'échéance par épisode, jamais de rafale de synchros dans les dernières secondes.
 */
export const SYNC_RETRY_MIN_MS = 1_000;

/**
 * Origine d'une « synchro due » : écriture de la configuration ou redémarrage fait par le cockpit (levée par la synchro suivante),
 * coupure du flux d'événements (levée seulement par la synchro qui suit la reconnexion), reconnexion du flux.
 */
export type SyncDueKind = "ecriture" | "coupure" | "reconnexion";

/**
 * Raison d'une « synchro due » en vigueur : revérification après une écriture, un redémarrage ou une reconnexion (« verification »),
 * flux d'événements coupé ou opencode jamais joint depuis le démarrage du cockpit (« coupure », jamais levée par la soupape), adresse
 * fausse relue sans pouvoir l'écrire pendant une réponse (« correction-differee » ; « verification » une fois l'adresse écrite par la
 * synchro qui la corrige, pendant la relecture de la liste des IA).
 */
export type SyncDueReason = "verification" | "coupure" | "correction-differee";

/** Dossiers nommés dans un message (cinq au plus). */
function directoryNames(checks: CopilotDirectoryCheck[]): string {
  const names = checks.map((c) => c.directory ?? "l'instance par défaut");
  const shown = names.slice(0, 5).join(", ");
  return names.length > 5 ? `${shown} et ${names.length - 5} autre${names.length > 6 ? "s" : ""}` : shown;
}

export interface CopilotConfigSyncDeps {
  client: Pick<OpencodeClient, "request">;
  /** Liste des IA : adresse retenue, relecture après une écriture, première lecture faite (loaded). */
  catalog: Pick<ModelCatalog, "sources" | "refresh" | "loaded">;
  /** Adresse imposée par .env, appliquée même quand la dernière lecture de la liste des IA a échoué. */
  copilot: Pick<CopilotApi, "status">;
  hub: Pick<EventHub, "cockpit">;
  log: Logger;
  /** File d'écriture de la configuration, partagée avec l'API ; ses demandes facturées en vol comptent comme des réponses en cours. */
  queue: Pick<ConfigWriteQueue, "run" | "applyingWhile" | "billedInFlight">;
  /** Redémarrage d'opencode en cours : rien n'est lu ni écrit. */
  control: Pick<ControlService, "restarting">;
  /** Dossiers dont l'adresse utilisée est vérifiée (null = instance par défaut). */
  directories: () => Promise<Array<string | null>>;
  /** true si une conversation travaille : l'écriture attend la vérification suivante. */
  busy: () => Promise<boolean>;
  /**
   * Délai entre deux tentatives tant que l'état reste « en-attente » (conversation en cours, opencode injoignable ou qui redémarre) ;
   * raccourci pendant un épisode « correction différée » pour que la dernière tentative parte avant la soupape.
   */
  retryMs?: number;
  /** Horloge de la soupape de « synchro due » (Date.now par défaut ; injectée par les tests). */
  now?: () => number;
  /**
   * Adresse cible imposée par .env (COCKPIT_COPILOT_API_URL) : « synchro due » posée dès la construction, avant la première lecture
   * de la liste des IA, sans soupape tant qu'opencode n'a jamais répondu (markStartup), gardée tant que les synchros rendent
   * « en-attente » (ou « inactif » avant la première lecture de la liste) et levée par la première qui rend un autre état (demandes
   * facturées refusées d'ici là).
   */
  targetImposed?: boolean;
}

type LogContext = { target?: string; busy?: boolean; wrote?: boolean; error?: string };

/**
 * « Synchro due » posée : instant compté par la soupape (dernière pose, ou première détection d'un épisode « correction différée »),
 * rang de la pose, cause, attente de la reconnexion du flux, épisode « correction différée », démarrage du cockpit (flux d'événements
 * pas encore suivi : gardée par une synchro « en-attente », sans soupape tant qu'opencode n'a jamais répondu).
 */
type SyncDue = { since: number; mark: number; cause: string; untilReconnect: boolean; deferred: boolean; startup: boolean };

/** Coupure du flux d'événements en cours : début, avertissement « coupure longue » déjà journalisé. */
type StreamDown = { since: number; warned: boolean };

/** Fin d'une synchro : état, et adresse fausse relue sans pouvoir l'écrire (conversation occupée ou demande en vol). */
type SyncOutcome = { status: CopilotSyncStatus; deferred: boolean };

const settled = (status: CopilotSyncStatus): SyncOutcome => ({ status, deferred: false });

export class CopilotConfigSync {
  readonly #d: CopilotConfigSyncDeps;
  #running: Promise<CopilotSyncStatus> | null = null;
  /** Synchro demandée pendant une autre : lancée à sa fin, avec la cible relue ; partagée par les appels d'ici là. */
  #next: Promise<CopilotSyncStatus> | null = null;
  #retry: NodeJS.Timeout | undefined;
  #stopped = false;
  #status: CopilotSyncStatus = { state: "inactif", message: null, at: 0, details: { checked: [] } };
  #due: SyncDue | null = null;
  #marks = 0;
  #stream: StreamDown | null = null;
  /** Épisode « adresse fausse, correction différée » en cours : instant de sa première détection. */
  #episode: { since: number } | null = null;
  /** Rang de la pose « correction différée » couverte par la synchro en cours : aucune soupape sur elle jusqu'à la fin de sa tâche. */
  #correcting: number | null = null;
  /**
   * Adresse écrite par la synchro en cours : pendant la relecture de la liste des IA qui suit, la pose « correction différée » (forcément
   * celle que cette synchro couvre : aucune n'est créée avant la fin de sa tâche) est présentée comme une vérification.
   */
  #written = false;
  /**
   * opencode a répondu depuis le démarrage du cockpit (markStartup, boucle de santé de main.ts). Jusque-là, aucune soupape sur une
   * pose de démarrage : opencode ne répond pas, refuser ne coûte rien, et il peut accepter une demande avant que la boucle le voie.
   */
  #opencodeAnswered = false;
  /** Avertissement « opencode injoignable depuis le démarrage » déjà journalisé (une fois). */
  #startupWaitWarned = false;

  constructor(deps: CopilotConfigSyncDeps) {
    this.#d = deps;
    // Adresse cible imposée : demandes facturées refusées dès l'écoute du serveur HTTP, sans soupape tant qu'opencode n'a jamais
    // répondu, jusqu'à la première synchro qui vérifie ou corrige l'adresse.
    if (deps.targetImposed === true) this.#pose(STARTUP_CAUSE, true);
  }

  /**
   * Dernier état ; « en-attente » tant que « synchro due » est posée (les adresses relues avant ne valent plus), avec un message de
   * coupure tant que le flux d'événements est coupé, ou d'attente tant qu'opencode n'a jamais répondu au démarrage. Épisode
   * « correction différée » : état « en-attente » de la synchro qui a relu l'adresse fausse, adresses relues comprises.
   */
  get status(): CopilotSyncStatus {
    const due = this.#currentDue();
    if (due === null) return this.#status;
    if (due.deferred && this.#status.state === "en-attente") return this.#status;
    const message = due.untilReconnect ? STREAM_DOWN_MESSAGE : this.#awaitingOpencode(due) ? STARTUP_WAIT_MESSAGE : SYNC_DUE_MESSAGE;
    return { state: "en-attente", message, at: due.since, details: { checked: [] } };
  }

  /**
   * true entre un redémarrage ou une écriture de la configuration d'opencode (ou une coupure de son flux) et la fin de la synchro
   * qui revérifie l'adresse, ou pendant un épisode « correction différée » : opencode peut tourner sur l'adresse d'office pendant ce
   * temps, les demandes facturées sont refusées. Jamais attendu par la synchro ni par une route ; levé de force après
   * SYNC_DUE_MAX_MS (soupape, journalisée), sauf pendant une coupure du flux ou, au démarrage, tant qu'opencode n'a jamais répondu.
   */
  get syncDue(): boolean {
    return this.#currentDue() !== null;
  }

  /**
   * Raison de « synchro due » (null quand elle n'est pas posée), d'où le proxy tire le message du refus : « coupure » aussi pour une
   * pose de démarrage tant qu'opencode n'a jamais répondu (jamais « réessayez dans quelques secondes » pendant une attente sans
   * borne) ; « verification » pour la pose « correction différée » dont la synchro en cours a écrit l'adresse.
   */
  get dueReason(): SyncDueReason | null {
    const due = this.#currentDue();
    if (due === null) return null;
    if (due.untilReconnect || this.#awaitingOpencode(due)) return "coupure";
    return due.deferred && !this.#written ? "correction-differee" : "verification";
  }

  /**
   * true pendant un épisode « correction différée » : adresse fausse relue sans pouvoir l'écrire, jusqu'à la synchro qui rend un
   * autre état qu'« en-attente » (ou une coupure du flux, ou la perte de l'adresse cible), soupape passée comprise.
   */
  get deferredEpisode(): boolean {
    return this.#episode !== null;
  }

  /**
   * opencode répond enfin (boucle de santé de main.ts, un seul appel) : soupape de nouveau appliquée aux poses de démarrage.
   * « Synchro due » du démarrage du cockpit, seulement quand .env impose l'adresse cible (même avant la première lecture de la liste
   * des IA) : posée à la construction (sans soupape ni message « quelques secondes » jusqu'à cet appel), puis reposée ici. Message
   * « adresse en vérification », sous soupape. Gardée par une synchro qui rend « en-attente » (adresse ni vérifiée ni corrigée :
   * opencode injoignable ou qui redémarre, écriture inachevée), ou « inactif » partie avant la première lecture de la liste des IA,
   * car le flux d'événements n'est pas encore suivi et aucune pose de coupure ne prendrait le relais ; levée par la première qui rend
   * un autre état. Rend true si posée.
   */
  markStartup(): boolean {
    this.#opencodeAnswered = true;
    if (this.#d.targetImposed !== true) return false;
    this.#pose(STARTUP_CAUSE, true);
    return true;
  }

  /**
   * Pose « synchro due » (seulement si une adresse cible est retenue ; sinon rien à revérifier, un indicateur resté posé est
   * retiré). Adresse imposée par .env encore inconnue du cockpit (première lecture de la liste des IA pas finie) : pose de démarrage,
   * jamais d'effacement. Nouvelle pose pendant une pose de démarrage en vigueur (écriture, redémarrage, coupure ou reconnexion avant
   * que la synchro de démarrage l'ait levée) : elle en garde le caractère (gardée par une synchro « en-attente », sous soupape).
   * À appeler DANS la tâche de la file qui a écrit ou redémarré, avant la libération d'applying, puis relancer sync()
   * après la tâche. Une pose pendant une synchro attend la synchro suivante ; une coupure du flux attend la reconnexion.
   * Coupure et reconnexion suivent l'état du flux, même sans adresse cible ; une coupure clôt l'épisode « correction différée » en
   * cours (la synchro de reconnexion relit tout). Rend true si l'indicateur est posé.
   */
  markDue(cause: string, kind: SyncDueKind = "ecriture"): boolean {
    if (kind === "coupure") {
      this.#stream ??= { since: this.#now(), warned: false };
      this.#episode = null;
    } else if (kind === "reconnexion") {
      this.#stream = null;
    }
    if (copilotBaseUrlTarget(this.#endpoint()) === undefined) {
      // Adresse de .env pas encore lue par le cockpit : opencode peut tourner sur l'adresse d'office, rien n'est effacé.
      if (this.#d.targetImposed === true && !this.#d.catalog.loaded) {
        this.#pose(cause, true);
        return true;
      }
      this.#due = null;
      return false;
    }
    this.#pose(cause, this.#startupInForce());
    return true;
  }

  /** Nouvelle pose de revérification (attente de la reconnexion tant que le flux est coupé). */
  #pose(cause: string, startup = false): void {
    const untilReconnect = this.#stream !== null;
    this.#due = { since: this.#now(), mark: ++this.#marks, cause, untilReconnect, deferred: false, startup };
    this.#d.log.debug("adresse de l'API Copilot d'opencode : revérification due", { cause, untilReconnect });
  }

  #now(): number {
    return (this.#d.now ?? Date.now)();
  }

  /**
   * Indicateur en vigueur, après la soupape : levé de force (log.warn) au-delà de SYNC_DUE_MAX_MS depuis la dernière pose (ou la
   * première détection d'un épisode « correction différée »). Jamais pendant une coupure du flux : aucune levée, un seul
   * avertissement par coupure qui dépasse ce délai. Jamais sur une pose de démarrage tant qu'opencode n'a jamais répondu : un seul
   * avertissement. Jamais sur la pose « correction différée » couverte par la synchro en cours : #settleDue décide à sa fin, les
   * demandes facturées restent refusées jusque-là.
   */
  #currentDue(): SyncDue | null {
    const due = this.#due;
    if (due === null) return null;
    const waitedMs = this.#now() - due.since;
    if (waitedMs < SYNC_DUE_MAX_MS) return due;
    if (due.deferred && due.mark === this.#correcting) return due;
    const stream = due.untilReconnect ? this.#stream : null;
    if (stream !== null) {
      if (!stream.warned) {
        stream.warned = true;
        this.#d.log.warn("adresse de l'API Copilot d'opencode : flux d'événements coupé depuis longtemps, demandes facturées refusées jusqu'à la reconnexion", {
          cause: due.cause,
          waitedMs: this.#now() - stream.since,
        });
      }
      return due;
    }
    if (this.#awaitingOpencode(due)) {
      if (!this.#startupWaitWarned) {
        this.#startupWaitWarned = true;
        this.#d.log.warn("adresse de l'API Copilot d'opencode : opencode injoignable depuis le démarrage du cockpit, demandes facturées refusées jusqu'à sa réponse", {
          cause: due.cause,
          waitedMs,
        });
      }
      return due;
    }
    this.#expire(due);
    return null;
  }

  /** Pose de démarrage alors qu'opencode n'a jamais répondu depuis le démarrage du cockpit : aucune soupape. */
  #awaitingOpencode(due: SyncDue): boolean {
    return due.startup && !this.#opencodeAnswered;
  }

  /**
   * Pose de démarrage en vigueur, sans appliquer la soupape (ni levée ni journal, contrairement à #currentDue) : soupape pas encore
   * passée, ou exemptée (flux coupé, opencode jamais joint). Une pose « correction différée » n'est jamais de démarrage.
   */
  #startupInForce(): boolean {
    const due = this.#due;
    if (due === null || !due.startup) return false;
    return this.#now() - due.since < SYNC_DUE_MAX_MS || (due.untilReconnect && this.#stream !== null) || this.#awaitingOpencode(due);
  }

  /** Soupape : indicateur levé de force, journalisé (cause et attente depuis la pose ou la première détection). */
  #expire(due: SyncDue): void {
    this.#due = null;
    this.#d.log.warn("adresse de l'API Copilot d'opencode : revérification attendue trop longtemps, demandes facturées de nouveau admises", {
      cause: due.cause,
      waitedMs: this.#now() - due.since,
    });
  }

  /**
   * Indicateur couvert par une synchro qui démarre. Pose « correction différée » : lue sans soupape, même au-delà de l'échéance
   * (cette synchro est la correction : #settleDue la lève, la garde ou applique la soupape à sa fin). Autres poses : soupape appliquée.
   */
  #coveredDue(): SyncDue | null {
    const due = this.#due;
    return due?.deferred === true ? due : this.#currentDue();
  }

  /** Lève l'indicateur couvert par une synchro (posé avant son début), sauf s'il a été reposé depuis. */
  #liftDue(covered: number | null, state: CopilotSyncState): void {
    if (covered === null || this.#due?.mark !== covered) return;
    this.#due = null;
    this.#d.log.debug("adresse de l'API Copilot d'opencode : revérification faite", { state });
  }

  /**
   * Fin d'une synchro, dans sa tâche. « a-jour », « applique », « echec », « redemarrage-requis » ou « inactif » : épisode
   * « correction différée » clos, indicateur couvert levé. « en-attente » après une adresse fausse relue sans pouvoir l'écrire
   * (conversation occupée ou demande en vol) : l'épisode commence ; tant qu'il n'a pas dépassé SYNC_DUE_MAX_MS depuis sa première
   * détection, l'indicateur est gardé ou créé, jamais réarmé par les nouvelles tentatives, et un indicateur reposé pendant la
   * synchro est laissé à la suivante. Épisode expiré (SYNC_DUE_MAX_MS depuis sa première détection) : la synchro qui couvrait sa
   * pose la lève à sa fin (soupape, log.warn) sans rien reposer, quel que soit ce qu'elle a relu ; la synchro suivante qui relit
   * encore l'adresse fausse sans pouvoir l'écrire ouvre un nouvel épisode compté depuis sa fin. Jamais de pose sans fin (chaque
   * épisode est levé par la soupape, et suivi d'au moins une synchro sans pose), jamais plus rien qui garde tant que l'adresse reste
   * fausse. Pose du démarrage couverte par une synchro « en-attente » (adresse ni vérifiée ni corrigée), ou « inactif » partie avant
   * la première lecture de la liste des IA (loaded faux à son départ : adresse de .env pas encore lue, rien de vérifié) : gardée, le
   * flux d'événements n'étant pas encore suivi. Flux coupé : l'indicateur attend la reconnexion, aucun épisode compté d'ici là.
   */
  #settleDue(covered: SyncDue | null, state: CopilotSyncState, deferred: boolean, loaded: boolean): void {
    const mark = covered === null ? null : covered.mark;
    const ended = state !== "en-attente" || copilotBaseUrlTarget(this.#endpoint()) === undefined;
    if (ended) this.#episode = null;
    if (!ended && this.#stream === null) {
      const now = this.#now();
      let episode = this.#episode;
      if (episode !== null && now - episode.since >= SYNC_DUE_MAX_MS) {
        if (covered?.deferred === true) {
          // Correction partie sur la pose de l'épisode, qui a expiré pendant ou avant sa tâche : soupape à sa fin, jamais renouvelé par elle.
          const due = this.#due;
          if (due !== null && due.mark === mark) this.#expire(due);
          return;
        }
        if (deferred) episode = this.#episode = { since: now };
      } else if (deferred) {
        episode = this.#episode ??= { since: now };
      }
      if (episode !== null && now - episode.since < SYNC_DUE_MAX_MS) {
        const current = this.#currentDue();
        if (current !== null && current.mark !== mark) return;
        this.#due = { since: episode.since, mark: ++this.#marks, cause: DEFERRED_CAUSE, untilReconnect: false, deferred: true, startup: false };
        this.#d.log.debug("adresse de l'API Copilot d'opencode : revérification due", { cause: DEFERRED_CAUSE, untilReconnect: false });
        return;
      }
      // Démarrage : le flux d'événements n'est pas encore suivi, aucune pose de coupure ne prendrait le relais d'une levée ici.
      if (covered?.startup === true) return;
    }
    if (covered?.startup === true && state === "inactif" && !loaded) return;
    this.#liftDue(mark, state);
  }

  /** Adresse retenue : confirmée par une lecture réussie, ou imposée par .env ; null sinon. */
  #endpoint(): CopilotEndpoint | null {
    const last = this.#d.copilot.status.endpoint;
    return this.#d.catalog.sources.endpoint ?? (last?.source === "env" ? last : null);
  }

  /** Une synchronisation à la fois ; un appel pendant qu'elle tourne en relance une seconde à sa fin, jamais l'ancien résultat. */
  sync(): Promise<CopilotSyncStatus> {
    if (this.#next !== null) return this.#next;
    if (this.#running === null) return this.#launch();
    this.#next = this.#running.then(() => {
      this.#next = null;
      return this.#launch();
    });
    return this.#next;
  }

  /** Annule la nouvelle tentative prévue et toutes les suivantes. */
  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#retry);
    this.#retry = undefined;
  }

  #launch(): Promise<CopilotSyncStatus> {
    clearTimeout(this.#retry);
    this.#retry = undefined;
    const run = this.#d.queue
      .run(async () => {
        // « Synchro due » posée avant le début de cette synchro (hors attente de reconnexion) : réglée à sa fin, dans la tâche,
        // quel que soit l'état final, erreur comprise (levée, ou gardée pendant un épisode « correction différée »). Posée pendant
        // qu'elle tourne : laissée à la synchro suivante. Pose « correction différée » : cette synchro est la correction, aucune
        // soupape sur elle d'ici sa fin (ni au démarrage, ni pendant la relecture qui précède l'écriture).
        const covered = this.#coveredDue();
        const tracked = covered === null || covered.untilReconnect ? null : covered;
        this.#correcting = covered?.deferred === true ? covered.mark : null;
        // Liste des IA lue au départ de la synchro (#sync lit l'adresse cible dans le même tour) : « inactif » avant elle ne vérifie rien.
        const loaded = this.#d.catalog.loaded;
        let state: CopilotSyncState = "echec";
        let deferred = false;
        try {
          const outcome = await this.#sync().catch((err: unknown) =>
            settled(this.#set("echec", errorMessage(err), { checked: [] }, { error: errorMessage(err) })),
          );
          state = outcome.status.state;
          deferred = outcome.deferred;
          return outcome.status;
        } finally {
          this.#correcting = null;
          this.#written = false;
          this.#settleDue(tracked, state, deferred, loaded);
        }
      })
      .then((status) => {
        this.#running = null;
        if (status.state === "en-attente") this.#scheduleRetry();
        return status;
      });
    this.#running = run;
    return run;
  }

  /** Nouvelle tentative tant que l'état reste « en-attente » ; jamais après « echec » ni « redemarrage-requis ». */
  #scheduleRetry(): void {
    if (this.#stopped) return;
    clearTimeout(this.#retry);
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      void this.sync();
    }, this.#retryDelay());
    this.#retry.unref();
  }

  /**
   * Délai de la tentative suivante : retryMs, ou moins pendant un épisode « correction différée » non expiré pour partir
   * SYNC_RETRY_LEAD_MS avant la soupape (min(retryMs, échéance − marge − maintenant)). Moins de SYNC_RETRY_MIN_MS avant ce départ
   * visé (la synchro qui vient de finir est partie dans la marge, ou tout près) : retryMs, jamais de rafale ; la soupape lève la pose
   * à l'échéance, et la tentative suivante ouvre un nouvel épisode si l'adresse est toujours fausse.
   */
  #retryDelay(): number {
    const retryMs = this.#d.retryMs ?? 30_000;
    const due = this.#due;
    if (due === null || !due.deferred) return retryMs;
    const lead = due.since + SYNC_DUE_MAX_MS - SYNC_RETRY_LEAD_MS - this.#now();
    return lead >= SYNC_RETRY_MIN_MS ? Math.min(retryMs, lead) : retryMs;
  }

  /**
   * Nouvel état, journalisé (adresses et erreurs seulement, jamais de jeton) : au niveau info ou warn à chaque transition et à
   * chaque réécriture d'opencode (PATCH ou libération des instances), même quand l'état ne change pas ; sinon en debug.
   */
  #set(state: CopilotSyncState, message: string | null, details: CopilotSyncDetails, context: LogContext = {}): CopilotSyncStatus {
    const previous = this.#status;
    this.#status = { state, message, at: Date.now(), details };
    const fields: Record<string, unknown> = {
      state,
      ...context,
      checked: details.checked.map((c) => ({ directory: c.directory ?? "(instance par défaut)", baseURL: shownUrl(c.baseURL) })),
      ...(details.disposeMs === undefined ? {} : { disposeMs: details.disposeMs }),
      ...(details.disposeOk === undefined ? {} : { disposeOk: details.disposeOk }),
      ...(details.restartHelps ? { restartHelps: true } : {}),
      ...(message ? { message } : {}),
    };
    const { log } = this.#d;
    const unchanged = state === previous.state && message === previous.message;
    const acted = context.wrote === true || details.disposeOk !== undefined;
    if (unchanged && !acted) {
      log.debug("adresse de l'API Copilot d'opencode : état inchangé", fields);
      return this.#status;
    }
    const title = unchanged ? "adresse de l'API Copilot d'opencode : réécrite, état inchangé" : "adresse de l'API Copilot d'opencode : nouvel état";
    if (state === "echec" || state === "redemarrage-requis") log.warn(title, fields);
    else log.info(title, fields);
    return this.#status;
  }

  /** Adresse utilisée dans chaque dossier (GET /config/providers construit l'état du dossier s'il le faut). */
  #check(directories: Array<string | null>): Promise<CopilotDirectoryCheck[]> {
    return Promise.all(
      directories.map(async (directory) => {
        const answer = await this.#d.client.request<unknown>("GET", "/config/providers", { ...(directory ? { directory } : {}), timeoutMs: 20_000 });
        return { directory, baseURL: providerBaseUrl(answer) };
      }),
    );
  }

  async #sync(): Promise<SyncOutcome> {
    const { catalog, control } = this.#d;
    // Seule une adresse confirmée par une lecture réussie est écrite, ou celle imposée par .env : une lecture en échec
    // (coupure réseau, jeton refusé) ne déplace jamais opencode.
    const endpoint = this.#endpoint();
    const target = copilotBaseUrlTarget(endpoint);
    if (target === undefined) return settled(this.#set("inactif", null, { checked: [] }));
    const shown = shownUrl(target);
    if (control.restarting) return settled(this.#set("en-attente", RESTARTING_MESSAGE, { checked: [] }, { target: shown }));

    const directories = await this.#d.directories();
    let checked: CopilotDirectoryCheck[];
    try {
      checked = await this.#check(directories);
    } catch (err) {
      return settled(this.#set("en-attente", unreachable(err), { checked: [] }, { target: shown, error: errorMessage(err) }));
    }
    if (checked.every((c) => c.baseURL === target)) return settled(this.#set("a-jour", null, { checked }, { target: shown }));

    // Valeur intermédiaire officielle, différente de la cible et acceptée par le verrou d'adresse : "" (adresse d'office), ou
    // l'adresse d'office explicite quand la cible est "".
    const intermediate = target === "" ? endpoint?.opencodeDefault || OPENCODE_DEFAULT_COPILOT_URL : "";
    // Indicateur posé avant la sonde et gardé jusqu'à la dernière relecture : le proxy refuse toute nouvelle demande facturée (avec
    // le message « adresse en vérification », rien ne redémarre) et le classement automatique attend ; les demandes déjà admises par
    // le proxy comptent comme des réponses en cours.
    const { status, wrote, deferred } = await this.#d.queue.applyingWhile(() => this.#apply(target, intermediate, directories, checked), "adresse-copilot");
    if (wrote) {
      // Adresse écrite : la relecture de la liste des IA n'attend plus la fin d'une réponse (refus « adresse en vérification »).
      this.#written = true;
      this.#d.hub.cockpit("opencode.config.changed", {});
      await catalog.refresh().catch(() => undefined);
    }
    return { status, deferred };
  }

  /**
   * Valeur intermédiaire puis cible, dès qu'un dossier diffère : le texte du fichier change forcément, donc le cache global est
   * invalidé même quand le fichier vaut déjà la cible avec un cache périmé (mesuré : un PATCH identique n'invalide rien, le double
   * PATCH suivi d'une libération répare sans redémarrage). Puis libération des instances et adresse relue dans chaque dossier,
   * même après une libération ratée.
   */
  async #apply(
    target: string,
    intermediate: string,
    directories: Array<string | null>,
    checked: CopilotDirectoryCheck[],
  ): Promise<{ status: CopilotSyncStatus; wrote: boolean; deferred: boolean }> {
    const { client, control, queue } = this.#d;
    const shown = shownUrl(target);
    const done = (status: CopilotSyncStatus, wrote = false) => ({ status, wrote, deferred: false });

    // Demande facturée admise par le proxy juste avant l'indicateur : réponse en cours que la sonde ne voit pas encore.
    let busy = queue.billedInFlight > 0;
    if (!busy) {
      try {
        busy = await this.#d.busy();
      } catch (err) {
        // Sonde en erreur : opencode ne répond pas, ce n'est pas une conversation en cours.
        return done(this.#set("en-attente", unreachable(err), { checked }, { target: shown, error: errorMessage(err) }));
      }
    }
    // Adresse fausse relue sans pouvoir l'écrire : « synchro due » gardée pendant l'épisode (correction différée, sous soupape).
    if (busy) return { status: this.#set("en-attente", BUSY_MESSAGE, { checked }, { target: shown, busy }), wrote: false, deferred: true };
    if (control.restarting) return done(this.#set("en-attente", RESTARTING_MESSAGE, { checked }, { target: shown, busy }));

    const patch = (baseURL: string) =>
      client.request("PATCH", "/global/config", { body: { provider: { "github-copilot": { options: { baseURL } } } }, timeoutMs: 30_000 });
    try {
      await patch(intermediate);
    } catch (err) {
      // Refusé par opencode : rien n'est écrit, les adresses relues juste avant restent celles qu'il utilise.
      return done(this.#set("echec", errorMessage(err), { checked }, { target: shown, busy, error: errorMessage(err) }));
    }
    try {
      await patch(target);
    } catch {
      try {
        // Valeur intermédiaire déjà écrite : une seconde chance pour la cible, sinon opencode resterait sur l'adresse d'office.
        await patch(target);
      } catch (err) {
        // Jamais « echec » définitif : les nouvelles tentatives reprennent (les dossiers diffèrent toujours de la cible).
        const message = `Adresse intermédiaire (adresse d'office) restée écrite, adresse visée non écrite : nouvelle tentative à la prochaine vérification (${errorMessage(err)}).`;
        return done(this.#set("en-attente", message, { checked: [] }, { target: shown, busy, wrote: true, error: errorMessage(err) }), true);
      }
    }

    const begin = Date.now();
    let disposeError: string | null = null;
    try {
      await client.request("POST", "/global/dispose", { timeoutMs: 60_000 });
    } catch (err) {
      disposeError = errorMessage(err);
    }
    const disposeMs = Date.now() - begin;
    const disposeOk = disposeError === null;
    const context: LogContext = { target: shown, busy, wrote: true, ...(disposeError === null ? {} : { error: disposeError }) };

    // Relue même après une libération ratée : un PATCH qui change le texte libère déjà les instances en tâche de fond.
    let after: CopilotDirectoryCheck[];
    try {
      after = await this.#check(directories);
    } catch (err) {
      if (disposeError !== null) {
        const message = `Adresse écrite, mais opencode n'a pas libéré ses instances (${disposeError}) et l'adresse utilisée n'a pas pu être relue : ${unreachable(err)}`;
        const details = { checked: [], disposeMs, disposeOk, restartHelps: true };
        return done(this.#set("echec", message, details, { ...context, error: `${disposeError} ; ${errorMessage(err)}` }), true);
      }
      const message = `Adresse écrite, vérification impossible : ${unreachable(err)}`;
      return done(this.#set("en-attente", message, { checked: [], disposeMs, disposeOk }, { ...context, error: errorMessage(err) }), true);
    }
    const late = after.filter((c) => c.baseURL !== target);
    if (late.length > 0) {
      const cause = disposeError === null ? "" : ` (libération des instances en échec : ${disposeError})`;
      const message = `Adresse écrite, mais opencode ne l'utilise pas encore dans ${directoryNames(late)}${cause} : redémarrez opencode (page Diagnostic).`;
      return done(this.#set("redemarrage-requis", message, { checked: after, disposeMs, disposeOk }, context), true);
    }
    const message = disposeError === null ? null : `Adresse utilisée dans chaque dossier, bien que la libération des instances ait échoué : ${disposeError}`;
    return done(this.#set("applique", message, { checked: after, disposeMs, disposeOk }, context), true);
  }
}
