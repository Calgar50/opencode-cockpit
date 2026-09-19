// Reprise de l'amorçage de l'interface (1.1, décision U4 ; défaut constaté pendant la mesure M25 de R105b, présent dans la 1.0.5) :
// un rechargement de /api/bootstrap qui échoue pendant une coupure ne doit plus laisser l'écran « Le cockpit ne répond pas »
// pour toujours. Minuterie factice et faux cockpit : aucun réseau, aucun navigateur. Le branchement du crochet
// (startBootRecovery : « online », « visibilitychange » et état de l'onglet, reconnexion du flux, 401, arrêt) est joué ici sur
// des EventTarget de Node, et de bout en bout par le scénario e2e/scenarios/010-reprise-apres-coupure.mjs (coupure réseau,
// onglet, focus, onglet caché, redémarrage réel du conteneur, amorçage lent, 401).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { classifyBootError, startBootRecovery } from "../web/app/useBootRecovery.ts";
import { ApiError } from "../web/lib/api.ts";
import type { BrowserEvent } from "../web/lib/types.ts";
import {
  type BootFailure,
  type BootRecovery,
  type BootView,
  createBootRecovery,
  focusARattraper,
  INITIAL_BOOT_VIEW,
  RETRY_DELAYS_MS,
  type RetryTrigger,
  retryDelay,
  watchRetryTriggers,
} from "./shared/boot-recovery.ts";
import { nextAttemptText, TEXTES } from "./shared/boot-recovery-texts.ts";

const WEB_DIR = path.join(import.meta.dirname, "..", "web");

/** Laisse passer les promesses en attente (réponse du faux cockpit, suite de la tentative). */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Minuterie factice : rien ne part tant que le test n'avance pas l'horloge. */
class FakeClock {
  now = 0;
  #timers = new Map<number, { at: number; run: () => void }>();
  #next = 1;

  setTimer = (run: () => void, ms: number): unknown => {
    const id = this.#next++;
    this.#timers.set(id, { at: this.now + ms, run });
    return id;
  };

  clearTimer = (handle: unknown): void => {
    this.#timers.delete(handle as number);
  };

  /** Délais restants des minuteries en attente, triés. */
  get pending(): number[] {
    return [...this.#timers.values()].map((t) => t.at - this.now).sort((a, b) => a - b);
  }

  /** Avance l'horloge de `ms` en déclenchant, dans l'ordre, les minuteries échues. */
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    let due = this.#nextDue(end);
    while (due) {
      this.#timers.delete(due[0]);
      this.now = due[1].at;
      due[1].run();
      await flush();
      due = this.#nextDue(end);
    }
    this.now = end;
    await flush();
  }

  #nextDue(end: number): [number, { at: number; run: () => void }] | undefined {
    return [...this.#timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
  }
}

interface Boot {
  n: number;
}

/** Faux cockpit : « up » répond, « down » est injoignable (erreur réseau de l'API), « 401 » a perdu la session. */
class FakeCockpit {
  state: "up" | "down" | "401" = "up";
  calls = 0;
  /** Réponses retenues (tentative en cours) quand `hold` est vrai. */
  hold = false;
  #held: Array<{ call: number; resolve: () => void }> = [];

  load = async (): Promise<Boot> => {
    this.calls++;
    const call = this.calls;
    if (this.hold) await new Promise<void>((resolve) => this.#held.push({ call, resolve }));
    if (this.state === "down") throw new ApiError(0, "network", "Le cockpit ne répond pas (conteneur arrêté ?).");
    if (this.state === "401") throw new ApiError(401, "unauthorized", "Session expirée.");
    return { n: call };
  };

  release(): void {
    this.hold = false;
    for (const { resolve } of this.#held.splice(0)) resolve();
  }

  /** Rend la seule réponse de la requête n° `call` (réponses dans le désordre) ; les autres restent retenues. */
  releaseCall(call: number): void {
    const index = this.#held.findIndex((h) => h.call === call);
    const [held] = index < 0 ? [] : this.#held.splice(index, 1);
    held?.resolve();
  }
}

function setup({ hidden = () => false }: { hidden?: () => boolean } = {}) {
  const clock = new FakeClock();
  const cockpit = new FakeCockpit();
  const views: Array<BootView<Boot>> = [];
  const ready: Boot[] = [];
  const recovery = createBootRecovery<Boot>({
    load: cockpit.load,
    classify: (err): BootFailure => classifyBootError(err),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    hidden,
    onChange: (view) => views.push(view),
    onReady: (data) => ready.push(data),
  });
  return { clock, cockpit, views, ready, recovery };
}

/** Interface chargée une première fois (phase « ready »). */
async function loaded() {
  const s = setup();
  await s.recovery.load();
  assert.equal(s.recovery.view.phase, "ready");
  return s;
}

describe("reprise de l'amorçage : attente croissante et bornée", () => {
  it("2, 5, 10 puis 30 s, jamais plus", () => {
    assert.deepEqual([...RETRY_DELAYS_MS], [2_000, 5_000, 10_000, 30_000]);
    assert.deepEqual([1, 2, 3, 4, 5, 50].map(retryDelay), [2_000, 5_000, 10_000, 30_000, 30_000, 30_000]);
    assert.equal(retryDelay(0), 2_000);
  });

  it("vue initiale : amorçage en cours, aucune reprise", () => {
    assert.deepEqual(INITIAL_BOOT_VIEW, { phase: "loading", data: null, error: "", retry: null, recovered: false });
  });
});

describe("reprise de l'amorçage : premier chargement", () => {
  it("succès : interface prête, flux d'événements connecté, aucune minuterie", async () => {
    const { recovery, clock, ready } = setup();
    await recovery.load();
    assert.deepEqual(recovery.view, { phase: "ready", data: { n: 1 }, error: "", retry: null, recovered: false });
    assert.deepEqual(ready, [{ n: 1 }]);
    assert.deepEqual(clock.pending, []);
  });

  it("échec : écran d'erreur avec son message, puis tentatives seules à 2, 5, 10, 30 et 30 s ; rétabli seul quand le cockpit répond", async () => {
    const { recovery, clock, cockpit, ready } = setup();
    cockpit.state = "down";
    await recovery.load();
    assert.equal(recovery.view.phase, "error");
    assert.equal(recovery.view.error, "Le cockpit ne répond pas (conteneur arrêté ?).");
    assert.deepEqual(recovery.view.retry, { failures: 1, delayMs: 2_000 });
    assert.deepEqual(clock.pending, [2_000]);

    const seen: number[] = [];
    for (const delay of [2_000, 5_000, 10_000, 30_000]) {
      await clock.advance(delay - 1);
      seen.push(cockpit.calls);
      await clock.advance(1);
      seen.push(cockpit.calls);
    }
    // Rien avant l'échéance, une tentative à l'échéance : 1 → 2 → 3 → 4 → 5 appels.
    assert.deepEqual(seen, [1, 2, 2, 3, 3, 4, 4, 5]);
    assert.deepEqual(recovery.view.retry, { failures: 5, delayMs: 30_000 });
    assert.equal(recovery.view.phase, "error");

    cockpit.state = "up";
    await clock.advance(30_000);
    assert.equal(recovery.view.phase, "ready");
    assert.deepEqual(recovery.view.data, { n: 6 });
    assert.equal(recovery.view.retry, null);
    assert.deepEqual(ready, [{ n: 6 }]);
    assert.deepEqual(clock.pending, [], "rien ne tourne plus une fois rétabli");
  });
});

describe("reprise de l'amorçage : interface déjà chargée", () => {
  it("rechargement en échec : l'interface reste (données gardées), reprise signalée, puis rétablie seule", async () => {
    const { recovery, clock, cockpit, views } = await loaded();
    const avant = recovery.view.data;
    cockpit.state = "down";
    await recovery.load();
    assert.equal(recovery.view.phase, "ready", "l'écran « Le cockpit ne répond pas » ne remplace pas une interface chargée");
    assert.equal(recovery.view.data, avant, "mêmes données : rien n'est remonté");
    assert.deepEqual(recovery.view.retry, { failures: 1, delayMs: 2_000 });
    assert.equal(recovery.view.recovered, false);
    assert.ok(views.every((v) => v.phase !== "error"));

    await clock.advance(2_000);
    assert.deepEqual(recovery.view.retry, { failures: 2, delayMs: 5_000 });
    cockpit.state = "up";
    await clock.advance(5_000);
    assert.deepEqual(recovery.view, { phase: "ready", data: { n: 4 }, error: "", retry: null, recovered: true });
    assert.deepEqual(clock.pending, []);
  });

  it("« Le cockpit répond de nouveau » n'est annoncé qu'après une reprise, et retombe au prochain échec", async () => {
    const { recovery, cockpit } = await loaded();
    await recovery.load();
    assert.equal(recovery.view.recovered, false, "rechargement ordinaire : rien à annoncer");
    cockpit.state = "down";
    await recovery.load();
    cockpit.state = "up";
    await recovery.load();
    assert.equal(recovery.view.recovered, true);
    cockpit.state = "down";
    await recovery.load();
    assert.equal(recovery.view.recovered, false);
  });
});

describe("reprise de l'amorçage : déclencheurs", () => {
  for (const reason of ["online", "visible", "stream"] as const satisfies readonly RetryTrigger[]) {
    it(`« ${reason} » : tentative aussitôt si une reprise est en attente, minuterie annulée`, async () => {
      const { recovery, clock, cockpit } = await loaded();
      cockpit.state = "down";
      await recovery.load();
      await clock.advance(2_000);
      assert.deepEqual(clock.pending, [5_000]);
      cockpit.state = "up";
      recovery.trigger(reason);
      await flush();
      assert.equal(cockpit.calls, 4);
      assert.equal(recovery.view.retry, null);
      assert.equal(recovery.view.recovered, true);
      assert.deepEqual(clock.pending, []);
    });
  }

  it("sans reprise en attente, un déclencheur ne fait aucune requête", async () => {
    const { recovery, cockpit, clock } = await loaded();
    for (const reason of ["online", "visible", "stream"] as const) recovery.trigger(reason);
    await flush();
    assert.equal(cockpit.calls, 1);
    assert.deepEqual(clock.pending, []);
  });

  it("déclencheurs pendant une tentative : partagée, jamais doublée", async () => {
    const { recovery, cockpit, clock } = await loaded();
    cockpit.state = "down";
    await recovery.load();
    cockpit.hold = true;
    const manual = recovery.load();
    for (const reason of ["online", "visible", "stream", "online"] as const) recovery.trigger(reason);
    assert.equal(cockpit.calls, 3, "une seule tentative en cours");
    cockpit.state = "up";
    cockpit.release();
    await manual;
    assert.equal(cockpit.calls, 3, "aucune tentative de plus après elle");
    assert.equal(recovery.view.retry, null);
    assert.deepEqual(clock.pending, []);
  });

  it("échec d'une tentative déclenchée : attente suivante reprise là où elle en était", async () => {
    const { recovery, cockpit, clock } = await loaded();
    cockpit.state = "down";
    await recovery.load();
    recovery.trigger("online");
    await flush();
    assert.deepEqual(recovery.view.retry, { failures: 2, delayMs: 5_000 });
    assert.deepEqual(clock.pending, [5_000]);
  });

  it("onglet caché : la tentative programmée attend le retour de l'onglet, rien ne tourne en arrière-plan", async () => {
    let hidden = false;
    const { recovery, cockpit, clock } = setup({ hidden: () => hidden });
    await recovery.load();
    cockpit.state = "down";
    await recovery.load();
    hidden = true;
    await clock.advance(60_000);
    assert.equal(cockpit.calls, 2, "aucune tentative onglet caché");
    assert.deepEqual(clock.pending, []);
    assert.notEqual(recovery.view.retry, null, "la reprise reste en attente");
    hidden = false;
    cockpit.state = "up";
    recovery.trigger("visible");
    await flush();
    assert.equal(cockpit.calls, 3);
    assert.equal(recovery.view.retry, null);
  });
});

// Constat de la vérification de c630349 : un rafraîchissement demandé juste après une modification recevait la réponse d'une
// tentative déjà en cours, calculée avant la modification (affichage faux, aucune nouvelle requête ; régression par rapport à
// la 1.0.5). Seuls les déclencheurs de reprise partagent la tentative en cours ; un load() explicite en programme une seule
// nouvelle, lancée à sa fin, et seule compte la réponse de la tentative la plus récente.
describe("reprise de l'amorçage : rafraîchissement demandé pendant une tentative", () => {
  it("une seule nouvelle requête, lancée à la fin de la tentative en cours ; ses données l'emportent, la réponse dépassée n'est jamais affichée", async () => {
    const { recovery, cockpit, views, ready, clock } = await loaded();
    cockpit.hold = true;
    // Rechargement lancé avant une modification : sa réponse ({ n: 2 }) est calculée avant elle.
    const avant = recovery.load();
    // Modification pendant ce rechargement : l'interface demande un rafraîchissement (deux fois, deux événements).
    const apres1 = recovery.load();
    const apres2 = recovery.load();
    assert.equal(cockpit.calls, 2, "rien ne part tant que la tentative en cours n'est pas finie");
    cockpit.release();
    await Promise.all([avant, apres1, apres2]);
    assert.equal(cockpit.calls, 3, "une seule nouvelle requête, partie après la tentative en cours");
    assert.deepEqual(recovery.view, { phase: "ready", data: { n: 3 }, error: "", retry: null, recovered: false });
    assert.ok(
      views.every((v) => v.data?.n !== 2),
      "la réponse calculée avant la modification ne remplace jamais l'affichage",
    );
    assert.deepEqual(ready, [{ n: 1 }, { n: 3 }]);
    assert.deepEqual(clock.pending, []);
  });

  it("chaque load() se résout une fois la nouvelle requête réglée, jamais avec la réponse dépassée", async () => {
    const { recovery, cockpit } = await loaded();
    cockpit.hold = true;
    const avant = recovery.load();
    const apres = recovery.load().then(() => recovery.view.data);
    cockpit.release();
    assert.deepEqual(await apres, { n: 3 });
    await avant;
    assert.deepEqual(recovery.view.data, { n: 3 });
  });

  it("« Réessayer » pendant une tentative en échec : une seule nouvelle tentative, un seul échec compté", async () => {
    const { recovery, cockpit, clock } = await loaded();
    cockpit.state = "down";
    await recovery.load();
    cockpit.hold = true;
    recovery.trigger("online");
    const reessayer = recovery.load();
    assert.equal(cockpit.calls, 3);
    cockpit.release();
    await reessayer;
    assert.equal(cockpit.calls, 4, "« Réessayer » fait partir une tentative après celle en cours");
    assert.deepEqual(recovery.view.retry, { failures: 2, delayMs: 5_000 }, "la tentative dépassée ne compte pas");
    assert.deepEqual(clock.pending, [5_000]);
  });

  it("session perdue (401 d'une autre requête) avec un rafraîchissement en attente : connexion, rien ne part ensuite", async () => {
    const { recovery, cockpit, clock } = await loaded();
    cockpit.hold = true;
    const avant = recovery.load();
    const apres = recovery.load();
    recovery.unauthorized();
    cockpit.release();
    await Promise.all([avant, apres]);
    assert.equal(recovery.view.phase, "login");
    assert.equal(cockpit.calls, 2, "aucune requête après le 401");
    assert.deepEqual(clock.pending, []);
  });

  it("401 rendu par une tentative dépassée : la nouvelle tentative le revoit, connexion, jamais de boucle", async () => {
    const { recovery, cockpit, clock } = await loaded();
    cockpit.hold = true;
    const avant = recovery.load();
    const apres = recovery.load();
    cockpit.state = "401";
    cockpit.release();
    await Promise.all([avant, apres]);
    assert.equal(recovery.view.phase, "login");
    assert.equal(cockpit.calls, 3);
    for (const reason of ["online", "visible", "stream"] as const) recovery.trigger(reason);
    await clock.advance(120_000);
    assert.equal(cockpit.calls, 3);
    assert.deepEqual(clock.pending, []);
  });

  it("réponses dans le désordre : seule compte la tentative la plus récemment lancée", async () => {
    const { recovery, cockpit } = await loaded();
    cockpit.hold = true;
    const ancienne = recovery.load();
    recovery.unauthorized();
    const nouvelle = recovery.load();
    cockpit.releaseCall(3);
    await nouvelle;
    assert.deepEqual(recovery.view.data, { n: 3 });
    cockpit.releaseCall(2);
    await ancienne;
    assert.equal(recovery.view.phase, "ready");
    assert.deepEqual(recovery.view.data, { n: 3 }, "la réponse en retard ne remplace pas la plus récente");
  });
});

describe("reprise de l'amorçage : 401 et démontage", () => {
  it("401 au rechargement : écran de connexion, aucune minuterie, aucun déclencheur ne relance", async () => {
    const { recovery, cockpit, clock } = await loaded();
    cockpit.state = "401";
    await recovery.load();
    assert.deepEqual(recovery.view, { phase: "login", data: null, error: "", retry: null, recovered: false });
    for (const reason of ["online", "visible", "stream"] as const) recovery.trigger(reason);
    await clock.advance(120_000);
    assert.equal(cockpit.calls, 2);
    assert.deepEqual(clock.pending, []);
  });

  it("401 pendant une reprise : tentatives arrêtées", async () => {
    const { recovery, cockpit, clock } = await loaded();
    cockpit.state = "down";
    await recovery.load();
    cockpit.state = "401";
    await clock.advance(2_000);
    assert.equal(recovery.view.phase, "login");
    assert.deepEqual(clock.pending, []);
    await clock.advance(120_000);
    assert.equal(cockpit.calls, 3);
  });

  it("401 vu par une autre requête pendant une tentative : connexion, minuterie annulée, réponse en retard ignorée", async () => {
    const { recovery, cockpit, clock } = await loaded();
    cockpit.state = "down";
    await recovery.load();
    cockpit.hold = true;
    const pending = recovery.load();
    recovery.unauthorized();
    assert.equal(recovery.view.phase, "login");
    cockpit.release();
    await pending;
    assert.equal(recovery.view.phase, "login", "l'échec en retard ne relance rien");
    assert.deepEqual(clock.pending, []);
    // Connexion réussie : une nouvelle tentative part (jamais la réponse périmée).
    cockpit.state = "up";
    await recovery.load();
    assert.equal(recovery.view.phase, "ready");
    assert.equal(cockpit.calls, 4);
  });

  it("après un 401, un échec du chargement suivant montre l'écran d'erreur (les anciennes données ne reviennent pas)", async () => {
    const { recovery, cockpit } = await loaded();
    recovery.unauthorized();
    cockpit.state = "down";
    await recovery.load();
    assert.equal(recovery.view.phase, "error");
    assert.equal(recovery.view.data, null);
  });

  it("démontage : minuterie nettoyée, réponse en retard ignorée, plus rien ne part", async () => {
    const { recovery, cockpit, clock, views } = await loaded();
    cockpit.state = "down";
    await recovery.load();
    cockpit.hold = true;
    recovery.trigger("online");
    recovery.dispose();
    assert.deepEqual(clock.pending, []);
    const count = views.length;
    cockpit.state = "up";
    cockpit.release();
    await flush();
    assert.equal(views.length, count, "aucune vue après le démontage");
    await recovery.load();
    recovery.trigger("online");
    await clock.advance(120_000);
    assert.equal(cockpit.calls, 3);
  });

  it("démontage avec une minuterie programmée et aucune tentative en cours : minuterie nettoyée, plus rien ne part", async () => {
    const { recovery, cockpit, clock } = await loaded();
    cockpit.state = "down";
    await recovery.load();
    assert.deepEqual(clock.pending, [2_000], "reprise programmée, aucune tentative en cours");
    recovery.dispose();
    assert.deepEqual(clock.pending, [], "minuterie nettoyée par le démontage lui-même");
    await clock.advance(120_000);
    assert.equal(cockpit.calls, 2);
  });
});

describe("reprise de l'amorçage : branchement des événements", () => {
  function sources() {
    const network = new EventTarget();
    const page = Object.assign(new EventTarget(), { visibilityState: "visible" });
    const streamListeners = new Set<() => void>();
    return {
      network,
      page,
      streamListeners,
      sources: {
        network,
        page,
        onStreamReconnected: (listener: () => void) => {
          streamListeners.add(listener);
          return () => streamListeners.delete(listener);
        },
      },
    };
  }

  it("« online », onglet redevenu visible et reconnexion du flux déclenchent ; onglet caché, non ; tout se débranche", () => {
    const s = sources();
    const calls: RetryTrigger[] = [];
    const stop = watchRetryTriggers({ trigger: (reason) => calls.push(reason) } satisfies Pick<BootRecovery<unknown>, "trigger">, s.sources);
    s.network.dispatchEvent(new Event("online"));
    s.network.dispatchEvent(new Event("offline"));
    s.page.visibilityState = "hidden";
    s.page.dispatchEvent(new Event("visibilitychange"));
    s.page.visibilityState = "visible";
    s.page.dispatchEvent(new Event("visibilitychange"));
    for (const listener of s.streamListeners) listener();
    assert.deepEqual(calls, ["online", "visible", "stream"]);

    stop();
    s.network.dispatchEvent(new Event("online"));
    s.page.dispatchEvent(new Event("visibilitychange"));
    assert.equal(s.streamListeners.size, 0);
    assert.deepEqual(calls, ["online", "visible", "stream"], "plus rien après le débranchement");
  });
});

// Constat de la vérification de c630349 : useBootRecovery.ts n'était testé que par classifyBootError. Un mutant sans l'onglet
// caché (`hidden`) et sans l'écoute de « stream.reconnected » gardait tous les tests verts. Le branchement du crochet
// (startBootRecovery) est maintenant joué ici sur des factices de window, document, flux et 401.
describe("reprise de l'amorçage : branchement du crochet (window, document, flux, 401)", () => {
  function environnement() {
    const clock = new FakeClock();
    const cockpit = new FakeCockpit();
    const network = new EventTarget();
    const page = Object.assign(new EventTarget(), { visibilityState: "visible" });
    const streamListeners = new Set<(event: BrowserEvent) => void>();
    const unauthorizedListeners = new Set<() => void>();
    const flux = { connexions: 0, coupures: 0 };
    const views: Array<BootView<Boot>> = [];
    const started = startBootRecovery<Boot>({
      load: cockpit.load,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      network,
      page,
      stream: {
        subscribe: (listener) => {
          streamListeners.add(listener);
          return () => streamListeners.delete(listener);
        },
        connect: () => {
          flux.connexions++;
        },
        disconnect: () => {
          flux.coupures++;
        },
      },
      onUnauthorized: (listener) => {
        unauthorizedListeners.add(listener);
        return () => unauthorizedListeners.delete(listener);
      },
      onChange: (view) => views.push(view),
    });
    const emettre = (event: BrowserEvent) => {
      for (const listener of [...streamListeners]) listener(event);
    };
    const vue = () => views.at(-1);
    return { clock, cockpit, network, page, streamListeners, unauthorizedListeners, flux, started, emettre, vue };
  }

  /** Interface chargée, puis un rechargement en échec : reprise programmée dans 2 s. */
  async function enReprise() {
    const e = environnement();
    await flush();
    assert.equal(e.vue()?.phase, "ready");
    e.cockpit.state = "down";
    await e.started.load();
    assert.deepEqual(e.clock.pending, [2_000]);
    return e;
  }

  it("premier chargement tout de suite ; succès : flux d'événements connecté", async () => {
    const e = environnement();
    await flush();
    assert.equal(e.cockpit.calls, 1);
    assert.deepEqual(e.vue(), { phase: "ready", data: { n: 1 }, error: "", retry: null, recovered: false });
    assert.equal(e.flux.connexions, 1);
    e.started.stop();
  });

  it("onglet caché (document.visibilityState) : la tentative programmée ne part pas ; retour de l'onglet : aussitôt", async () => {
    const e = await enReprise();
    e.page.visibilityState = "hidden";
    e.page.dispatchEvent(new Event("visibilitychange"));
    await e.clock.advance(60_000);
    assert.equal(e.cockpit.calls, 2, "aucune tentative tant que l'onglet est caché");
    assert.deepEqual(e.clock.pending, [], "rien ne tourne en arrière-plan");
    e.cockpit.state = "up";
    e.page.visibilityState = "visible";
    e.page.dispatchEvent(new Event("visibilitychange"));
    await flush();
    assert.equal(e.cockpit.calls, 3);
    assert.equal(e.vue()?.retry, null);
    assert.equal(e.vue()?.recovered, true);
    e.started.stop();
  });

  it("reconnexion du flux (« stream.reconnected ») : reprise aussitôt ; un autre événement du flux ne relance rien", async () => {
    const e = await enReprise();
    e.emettre({ kind: "cockpit", type: "settings.updated", data: null });
    e.emettre({ kind: "opencode", event: { type: "stream.reconnected", properties: {} } });
    await flush();
    assert.equal(e.cockpit.calls, 2);
    e.cockpit.state = "up";
    e.emettre({ kind: "cockpit", type: "stream.reconnected", data: null });
    await flush();
    assert.equal(e.cockpit.calls, 3);
    assert.equal(e.vue()?.recovered, true);
    assert.deepEqual(e.clock.pending, []);
    assert.equal(e.flux.connexions, 2, "flux reconnecté après la reprise");
    e.started.stop();
  });

  it("« online » (window) : reprise aussitôt", async () => {
    const e = await enReprise();
    e.cockpit.state = "up";
    e.network.dispatchEvent(new Event("online"));
    await flush();
    assert.equal(e.cockpit.calls, 3);
    assert.equal(e.vue()?.retry, null);
    e.started.stop();
  });

  it("401 d'une autre requête pendant une reprise : flux coupé, connexion, plus aucune tentative", async () => {
    const e = await enReprise();
    for (const listener of [...e.unauthorizedListeners]) listener();
    assert.equal(e.flux.coupures, 1);
    assert.equal(e.vue()?.phase, "login");
    e.network.dispatchEvent(new Event("online"));
    e.emettre({ kind: "cockpit", type: "stream.reconnected", data: null });
    await e.clock.advance(120_000);
    assert.equal(e.cockpit.calls, 2);
    assert.deepEqual(e.clock.pending, []);
    e.started.stop();
  });

  it("arrêt (démontage du crochet) : flux et 401 débranchés, minuterie nettoyée, plus rien ne part", async () => {
    const e = await enReprise();
    e.started.stop();
    assert.deepEqual(e.clock.pending, []);
    assert.equal(e.streamListeners.size, 0);
    assert.equal(e.unauthorizedListeners.size, 0);
    e.cockpit.state = "up";
    e.network.dispatchEvent(new Event("online"));
    e.page.dispatchEvent(new Event("visibilitychange"));
    await e.clock.advance(120_000);
    await e.started.load();
    assert.equal(e.cockpit.calls, 2);
  });
});

describe("reprise de l'amorçage : erreurs et textes", () => {
  it("401 : session perdue ; réseau, 5xx et autres : repris avec leur message", () => {
    assert.deepEqual(classifyBootError(new ApiError(401, "unauthorized", "Session expirée.")), { unauthorized: true });
    assert.deepEqual(classifyBootError(new ApiError(0, "network", "Le cockpit ne répond pas (conteneur arrêté ?).")), {
      unauthorized: false,
      message: "Le cockpit ne répond pas (conteneur arrêté ?).",
    });
    assert.deepEqual(classifyBootError(new ApiError(502, "http", "Erreur 502")), { unauthorized: false, message: "Erreur 502" });
    assert.deepEqual(classifyBootError(new TypeError("Failed to fetch")), { unauthorized: false, message: "Failed to fetch" });
  });

  it("délai affiché en secondes entières, jamais un compte à rebours", () => {
    assert.equal(nextAttemptText(2_000), "Nouvelle tentative automatique dans 2 s.");
    assert.equal(nextAttemptText(30_000), "Nouvelle tentative automatique dans 30 s.");
    assert.equal(nextAttemptText(200), "Nouvelle tentative automatique dans 1 s.");
    assert.equal(TEXTES.partout.titre, "Le cockpit ne répond pas");
  });
});

describe("reprise de l'amorçage : interface", () => {
  /** Source sans commentaires (les règles portent sur le code). */
  const code = (fichier: string) =>
    fs
      .readFileSync(path.join(WEB_DIR, fichier), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

  /** Règles de mouvement de web-animations.test.ts appliquées au bandeau et à l'écran (hors de son périmètre 1.1). */
  function motionProblems(source: string): string[] {
    const rules: Array<[RegExp, string]> = [
      [/\binfinite\b/i, "animation infinie"],
      [/\banimation(?:Name)?\s*:/, "animation CSS en ligne"],
      [/\.animate\s*\(/, "WAAPI"],
      [/<Spinner\b|\bloading=/, "indicateur tournant (animation infinie de .spinner)"],
      [/\bsetInterval\s*\(|\brequestAnimationFrame\s*\(|\bInfinity\b/, "boucle"],
      [/\bautoFocus\b|\.focus\(/, "focus pris"],
    ];
    return rules.filter(([re]) => re.test(source)).map(([, rule]) => rule);
  }

  it("contrôle discriminant : indicateur tournant, animation infinie et focus pris sont refusés", () => {
    assert.deepEqual(motionProblems('<Button loading={busy}>Réessayer</Button>'), ["indicateur tournant (animation infinie de .spinner)"]);
    assert.deepEqual(motionProblems('<span style={{ animation: "pulse 1s infinite" }} />'), ["animation infinie", "animation CSS en ligne"]);
    assert.deepEqual(motionProblems("<Button autoFocus>Réessayer</Button>"), ["focus pris"]);
    assert.deepEqual(motionProblems("zone.current?.focus();"), ["focus pris"]);
    assert.deepEqual(motionProblems("const t = setInterval(tick, 1000);"), ["boucle"]);
  });

  /**
   * Seul déplacement de focus permis (constat de la vérification de c630349) : le bandeau disparaît avec « Réessayer », qui
   * avait le focus ; celui-ci retomberait sur body et un lecteur d'écran perdrait sa position. Il est alors posé sur la zone
   * d'annonce, à la même place, sans défilement. Jamais à l'apparition du bandeau, jamais ailleurs.
   */
  const RATTRAPAGE =
    /if \(!bandeau && focusARattraper\(focusDansLaZone\.current, document\.activeElement, document\.body\)\) zone\.current\?\.focus\(\{ preventScroll: true \}\);/;

  it("bandeau et écran : aucune animation, aucune boucle, annonce polie (role=\"status\"), focus jamais pris, seulement rattrapé", () => {
    const source = code("app/BootRecovery.tsx");
    assert.match(source, RATTRAPAGE, "focus rattrapé sur la zone d'annonce quand le bandeau disparaît avec lui");
    assert.equal(source.match(/\.focus\(/g)?.length, 1, "aucun autre déplacement de focus");
    assert.deepEqual(motionProblems(source.replace(RATTRAPAGE, "")), []);
    assert.match(source, /role="status"/);
    assert.match(source, /tabIndex=\{-1\}/, "zone d'annonce focalisable par programme seulement, hors de l'ordre de tabulation");
    assert.doesNotMatch(source, /role="alert"|aria-live="assertive"/);
  });

  it("focus rattrapé seulement s'il était dans la zone et qu'il est retombé sur body (ou nulle part)", () => {
    const corps = { nom: "body" };
    const autre = { nom: "champ Message" };
    assert.equal(focusARattraper(true, corps, corps), true);
    assert.equal(focusARattraper(true, null, corps), true);
    assert.equal(focusARattraper(true, autre, corps), false, "le focus est ailleurs : on n'y touche pas");
    assert.equal(focusARattraper(false, corps, corps), false, "il n'était pas dans la zone : on n'y touche pas");
  });

  it("App.tsx : amorçage, écran d'erreur et bandeau passent par la reprise ; plus aucune phase « error » posée à la main", () => {
    const source = code("app/App.tsx");
    assert.match(source, /useBootRecovery\(\)/);
    assert.match(source, /<BootErrorScreen\b/);
    assert.match(source, /<RecoveryBanner\b/);
    assert.doesNotMatch(source, /setPhase\(\s*"error"\s*\)/);
  });
});
