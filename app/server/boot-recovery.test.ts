// Reprise de l'amorçage de l'interface (1.1, décision U4 ; défaut constaté pendant la mesure M25 de R105b, présent dans la 1.0.5) :
// un rechargement de /api/bootstrap qui échoue pendant une coupure ne doit plus laisser l'écran « Le cockpit ne répond pas »
// pour toujours. Minuterie factice et faux cockpit : aucun réseau, aucun navigateur ; le branchement réel (événements
// « online » et « visibilitychange », flux d'événements) est vérifié sur des EventTarget de Node, et de bout en bout par le
// scénario e2e/scenarios/010-reprise-apres-coupure.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { classifyBootError } from "../web/app/useBootRecovery.ts";
import { ApiError } from "../web/lib/api.ts";
import {
  type BootFailure,
  type BootRecovery,
  type BootView,
  createBootRecovery,
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
  #held: Array<() => void> = [];

  load = async (): Promise<Boot> => {
    this.calls++;
    const call = this.calls;
    if (this.hold) await new Promise<void>((resolve) => this.#held.push(resolve));
    if (this.state === "down") throw new ApiError(0, "network", "Le cockpit ne répond pas (conteneur arrêté ?).");
    if (this.state === "401") throw new ApiError(401, "unauthorized", "Session expirée.");
    return { n: call };
  };

  release(): void {
    this.hold = false;
    for (const resolve of this.#held.splice(0)) resolve();
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

  it("déclencheur pendant une tentative : partagée, jamais doublée ; « Réessayer » aussi", async () => {
    const { recovery, cockpit, clock } = await loaded();
    cockpit.state = "down";
    await recovery.load();
    cockpit.hold = true;
    const manual = recovery.load();
    recovery.trigger("online");
    recovery.trigger("stream");
    const again = recovery.load();
    assert.equal(cockpit.calls, 3, "une seule tentative en cours");
    cockpit.state = "up";
    cockpit.release();
    await Promise.all([manual, again]);
    assert.equal(cockpit.calls, 3);
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

  it("bandeau et écran : aucune animation, aucune boucle, annonce polie (role=\"status\"), focus jamais déplacé", () => {
    const source = code("app/BootRecovery.tsx");
    assert.deepEqual(motionProblems(source), []);
    assert.match(source, /role="status"/);
    assert.doesNotMatch(source, /role="alert"|aria-live="assertive"/);
  });

  it("App.tsx : amorçage, écran d'erreur et bandeau passent par la reprise ; plus aucune phase « error » posée à la main", () => {
    const source = code("app/App.tsx");
    assert.match(source, /useBootRecovery\(\)/);
    assert.match(source, /<BootErrorScreen\b/);
    assert.match(source, /<RecoveryBanner\b/);
    assert.doesNotMatch(source, /setPhase\(\s*"error"\s*\)/);
  });
});
