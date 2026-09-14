// File d'écriture de la configuration d'opencode, partagée par l'API (profils de permissions, fichier brut, correctif du mode
// Avancé, redémarrage depuis Diagnostic), le Studio et la synchronisation de l'adresse Copilot : une application à la fois, chacune
// pouvant libérer ou redémarrer opencode. Aucune tâche de la file n'appelle le Studio ni n'attend une synchro : jamais d'imbrication.

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

export class ConfigWriteQueue {
  #tail: Promise<unknown> = Promise.resolve();
  #applying = 0;
  #billed = 0;

  /** true pendant une application : les demandes facturées sont refusées (opencode les couperait). */
  get applying(): boolean {
    return this.#applying > 0;
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

  /** Indicateur `applying` posé le temps de la tâche, même si elle échoue. */
  async applyingWhile<T>(task: () => Promise<T>): Promise<T> {
    this.#applying++;
    try {
      return await task();
    } finally {
      this.#applying--;
    }
  }
}
