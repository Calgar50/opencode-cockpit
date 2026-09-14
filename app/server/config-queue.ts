// File d'écriture de la configuration d'opencode, partagée par l'API (profils de permissions, fichier brut, correctif du mode
// Avancé, redémarrage depuis Diagnostic), le Studio et la synchronisation de l'adresse Copilot : une application à la fois, chacune
// pouvant libérer ou redémarrer opencode. Aucune tâche de la file n'appelle le Studio ni n'attend une synchro : jamais d'imbrication.
import type { SyncDueReason } from "./oc-copilot-config.ts";

/**
 * Origine d'une application en cours : écriture de la configuration ou redémarrage demandés par l'API ou le Studio
 * (« configuration »), ou écriture de l'adresse de l'API Copilot par sa synchronisation (« adresse-copilot » : quelques secondes,
 * rien ne redémarre).
 */
export type ApplyOrigin = "configuration" | "adresse-copilot";

/** Motif du refus d'une demande facturée, d'où le proxy tire son message (code d'erreur inchangé). */
export type BillRefusal = "redemarrage" | "adresse-en-verification" | "reconnexion" | "correction-differee";

/**
 * Garde des demandes facturées (proxy des conversations, classement automatique) : refusées pendant une application de la
 * configuration d'opencode, un redémarrage, ou tant que l'adresse de l'API Copilot doit être revérifiée (« synchro due ») :
 * opencode les couperait, ou les enverrait vers une adresse que le réseau bloque (5 tentatives, environ 69 s, puis échec).
 */
export function canBill(state: {
  queue: Pick<ConfigWriteQueue, "applying">;
  control: { readonly restarting: boolean };
  copilotConfig: { readonly syncDue: boolean };
}): boolean {
  return !state.queue.applying && !state.control.restarting && !state.copilotConfig.syncDue;
}

/**
 * Motif du refus d'une demande facturée (null : admise), aux mêmes conditions que canBill. Redémarrage ou application de la
 * configuration : « redemarrage ». Écriture de l'adresse par sa synchronisation, ou revérification due : « adresse-en-verification ».
 * Flux d'événements d'opencode coupé : « reconnexion ». Adresse fausse relue pendant une réponse : « correction-differee ».
 */
export function billRefusal(state: {
  queue: Pick<ConfigWriteQueue, "applyingOrigin">;
  control: { readonly restarting: boolean };
  copilotConfig: { readonly dueReason: SyncDueReason | null };
}): BillRefusal | null {
  const origin = state.queue.applyingOrigin;
  if (state.control.restarting || origin === "configuration") return "redemarrage";
  if (origin === "adresse-copilot") return "adresse-en-verification";
  switch (state.copilotConfig.dueReason) {
    case null:
      return null;
    case "coupure":
      return "reconnexion";
    case "correction-differee":
      return "correction-differee";
    case "verification":
      return "adresse-en-verification";
  }
}

export class ConfigWriteQueue {
  #tail: Promise<unknown> = Promise.resolve();
  readonly #applying: Record<ApplyOrigin, number> = { configuration: 0, "adresse-copilot": 0 };
  #billed = 0;

  /** true pendant une application : les demandes facturées sont refusées (opencode les couperait). */
  get applying(): boolean {
    return this.applyingOrigin !== null;
  }

  /** Origine de l'application en cours (null : aucune) ; « configuration » l'emporte quand les deux se chevauchent. */
  get applyingOrigin(): ApplyOrigin | null {
    if (this.#applying.configuration > 0) return "configuration";
    return this.#applying["adresse-copilot"] > 0 ? "adresse-copilot" : null;
  }

  /** Demandes facturées admises (applying faux au moment de la garde) dont opencode n'a pas encore répondu. */
  get billedInFlight(): number {
    return this.#billed;
  }

  /**
   * Demande facturée admise : comptée jusqu'à l'appel de la fonction rendue (les appels suivants sont sans effet). Une application
   * qui commence d'ici là la traite comme une réponse en cours : la sonde des conversations ne la voit pas encore.
   */
  beginBilled(): () => void {
    this.#billed++;
    let open = true;
    return () => {
      if (!open) return;
      open = false;
      this.#billed--;
    };
  }

  /** Tâches exécutées une par une, dans l'ordre d'arrivée ; un échec ne bloque jamais la suivante. */
  run<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(task, task);
    this.#tail = run.catch(() => undefined);
    return run;
  }

  /** Indicateur `applying` posé le temps de la tâche, même si elle échoue, avec son origine (« configuration » par défaut). */
  async applyingWhile<T>(task: () => Promise<T>, origin: ApplyOrigin = "configuration"): Promise<T> {
    this.#applying[origin]++;
    try {
      return await task();
    } finally {
      this.#applying[origin]--;
    }
  }
}
