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
 * « synchro due » est posée jusqu'à la synchro de reconnexion (opencode peut revenir sur l'adresse d'office avant que le flux se
 * rebranche : jusqu'à 10 s d'attente). À la reconnexion (jamais au premier branchement, qui suit la synchro de démarrage),
 * l'adresse est revérifiée dans chaque dossier. Des déclenchements rapprochés se fondent dans sync() : une synchro à la fois, une
 * seule relancée à sa fin. Rend le désabonnement.
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

const unreachable = (err: unknown) => `opencode injoignable : ${errorMessage(err)}`;
const BUSY_MESSAGE = "Une conversation travaille : adresse appliquée à la prochaine vérification.";
const RESTARTING_MESSAGE = "opencode redémarre : adresse vérifiée après le redémarrage.";
const SYNC_DUE_MESSAGE = "opencode redémarre ou recharge sa configuration : l'adresse sera revérifiée.";
const shownUrl = (baseURL: string) => baseURL || "(adresse d'office)";

/** Soupape : « synchro due » levée de force après ce délai, pour qu'un événement perdu ne bloque jamais les demandes facturées. */
export const SYNC_DUE_MAX_MS = 90_000;

/**
 * Origine d'une « synchro due » : écriture de la configuration ou redémarrage fait par le cockpit (levée par la synchro suivante),
 * coupure du flux d'événements (levée seulement par la synchro qui suit la reconnexion), reconnexion du flux.
 */
export type SyncDueKind = "ecriture" | "coupure" | "reconnexion";

/** Dossiers nommés dans un message (cinq au plus). */
function directoryNames(checks: CopilotDirectoryCheck[]): string {
  const names = checks.map((c) => c.directory ?? "l'instance par défaut");
  const shown = names.slice(0, 5).join(", ");
  return names.length > 5 ? `${shown} et ${names.length - 5} autre${names.length > 6 ? "s" : ""}` : shown;
}

export interface CopilotConfigSyncDeps {
  client: Pick<OpencodeClient, "request">;
  catalog: Pick<ModelCatalog, "sources" | "refresh">;
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
  /** Délai entre deux tentatives tant que l'état reste « en-attente » (conversation en cours, opencode injoignable ou qui redémarre). */
  retryMs?: number;
  /** Horloge de la soupape de « synchro due » (Date.now par défaut ; injectée par les tests). */
  now?: () => number;
}

type LogContext = { target?: string; busy?: boolean; wrote?: boolean; error?: string };

/** « Synchro due » posée : instant et rang de la dernière pose, cause, attente de la reconnexion du flux. */
type SyncDue = { since: number; mark: number; cause: string; untilReconnect: boolean };

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

  constructor(deps: CopilotConfigSyncDeps) {
    this.#d = deps;
  }

  /** Dernier état ; « en-attente » tant que « synchro due » est posée (les adresses relues avant ne valent plus). */
  get status(): CopilotSyncStatus {
    const due = this.#currentDue();
    if (due === null) return this.#status;
    return { state: "en-attente", message: SYNC_DUE_MESSAGE, at: due.since, details: { checked: [] } };
  }

  /**
   * true entre un redémarrage ou une écriture de la configuration d'opencode (ou une coupure de son flux) et la fin de la synchro
   * qui revérifie l'adresse : opencode peut tourner sur l'adresse d'office pendant ce temps, les demandes facturées sont refusées.
   * Jamais attendu par la synchro ni par une route ; levé de force après SYNC_DUE_MAX_MS (soupape, journalisée).
   */
  get syncDue(): boolean {
    return this.#currentDue() !== null;
  }

  /**
   * Pose « synchro due » (seulement si une adresse cible est retenue ; sinon rien à revérifier, un indicateur resté posé est
   * retiré). À appeler DANS la tâche de la file qui a écrit ou redémarré, avant la libération d'applying, puis relancer sync()
   * après la tâche. Une pose pendant une synchro attend la synchro suivante ; une coupure du flux attend la reconnexion.
   * Rend true si l'indicateur est posé.
   */
  markDue(cause: string, kind: SyncDueKind = "ecriture"): boolean {
    if (copilotBaseUrlTarget(this.#endpoint()) === undefined) {
      this.#due = null;
      return false;
    }
    const previous = this.#currentDue();
    const untilReconnect = kind === "coupure" || (kind === "ecriture" && previous?.untilReconnect === true);
    this.#due = { since: this.#now(), mark: ++this.#marks, cause, untilReconnect };
    this.#d.log.debug("adresse de l'API Copilot d'opencode : revérification due", { cause, untilReconnect });
    return true;
  }

  #now(): number {
    return (this.#d.now ?? Date.now)();
  }

  /** Indicateur en vigueur, après la soupape : levé de force (log.warn) au-delà de SYNC_DUE_MAX_MS depuis la dernière pose. */
  #currentDue(): SyncDue | null {
    const due = this.#due;
    if (due === null) return null;
    const waitedMs = this.#now() - due.since;
    if (waitedMs < SYNC_DUE_MAX_MS) return due;
    this.#due = null;
    this.#d.log.warn("adresse de l'API Copilot d'opencode : revérification attendue trop longtemps, demandes facturées de nouveau admises", {
      cause: due.cause,
      waitedMs,
    });
    return null;
  }

  /** Lève l'indicateur couvert par une synchro (posé avant son début), sauf s'il a été reposé depuis. */
  #liftDue(covered: number | null, state: CopilotSyncState): void {
    if (covered === null || this.#due?.mark !== covered) return;
    this.#due = null;
    this.#d.log.debug("adresse de l'API Copilot d'opencode : revérification faite", { state });
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
        // « Synchro due » posée avant le début de cette synchro (hors attente de reconnexion) : levée à sa fin, dans la tâche,
        // quel que soit l'état final, erreur comprise. Posée pendant qu'elle tourne : laissée à la synchro suivante.
        const covered = this.#currentDue();
        const mark = covered === null || covered.untilReconnect ? null : covered.mark;
        let state: CopilotSyncState = "echec";
        try {
          const status = await this.#sync().catch((err: unknown) => this.#set("echec", errorMessage(err), { checked: [] }, { error: errorMessage(err) }));
          state = status.state;
          return status;
        } finally {
          this.#liftDue(mark, state);
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
    }, this.#d.retryMs ?? 30_000);
    this.#retry.unref();
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

  async #sync(): Promise<CopilotSyncStatus> {
    const { catalog, control } = this.#d;
    // Seule une adresse confirmée par une lecture réussie est écrite, ou celle imposée par .env : une lecture en échec
    // (coupure réseau, jeton refusé) ne déplace jamais opencode.
    const endpoint = this.#endpoint();
    const target = copilotBaseUrlTarget(endpoint);
    if (target === undefined) return this.#set("inactif", null, { checked: [] });
    const shown = shownUrl(target);
    if (control.restarting) return this.#set("en-attente", RESTARTING_MESSAGE, { checked: [] }, { target: shown });

    const directories = await this.#d.directories();
    let checked: CopilotDirectoryCheck[];
    try {
      checked = await this.#check(directories);
    } catch (err) {
      return this.#set("en-attente", unreachable(err), { checked: [] }, { target: shown, error: errorMessage(err) });
    }
    if (checked.every((c) => c.baseURL === target)) return this.#set("a-jour", null, { checked }, { target: shown });

    // Valeur intermédiaire officielle, différente de la cible et acceptée par le verrou d'adresse : "" (adresse d'office), ou
    // l'adresse d'office explicite quand la cible est "".
    const intermediate = target === "" ? endpoint?.opencodeDefault || OPENCODE_DEFAULT_COPILOT_URL : "";
    // Indicateur posé avant la sonde et gardé jusqu'à la dernière relecture : le proxy refuse toute nouvelle demande facturée et
    // le classement automatique attend ; les demandes déjà admises par le proxy comptent comme des réponses en cours.
    const { status, wrote } = await this.#d.queue.applyingWhile(() => this.#apply(target, intermediate, directories, checked));
    if (wrote) {
      this.#d.hub.cockpit("opencode.config.changed", {});
      await catalog.refresh().catch(() => undefined);
    }
    return status;
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
  ): Promise<{ status: CopilotSyncStatus; wrote: boolean }> {
    const { client, control, queue } = this.#d;
    const shown = shownUrl(target);
    const done = (status: CopilotSyncStatus, wrote = false) => ({ status, wrote });

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
    if (busy) return done(this.#set("en-attente", BUSY_MESSAGE, { checked }, { target: shown, busy }));
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
