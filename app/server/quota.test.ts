// Synchronisation du solde réel (quota.ts) : un échec de la synchronisation AUTOMATIQUE est gardé (banc réseau v2 de la 1.1.0, A45).
// Avant : derrière un proxy qui refuse api.github.com, le minuteur de 60 s relançait un essai à chaque tour tant qu'aucun relevé
// récent n'existait (13 CONNECT refusés en 13 min). Maintenant : aucun essai automatique avant max(1 h, intervalle choisi) depuis la
// dernière tentative, réussie ou non ; au démarrage, un seul essai ; [Synchroniser maintenant] n'est jamais bloqué.
//
// Le banc du minuteur passe par start() et les minuteries simulées de node:test (setInterval et Date), avec fetch et la lecture
// d'auth.json remplacés : aucun appel réel, aucune attente réelle. Il ne dépend pas des options d'injection de QuotaSync.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { openMemoryDb } from "./db.ts";
import type { EventHub } from "./hub.ts";
import type { Logger } from "./log.ts";
import { QUOTA_FAILURE_RETRY_MS, QUOTA_TICK_MS, QuotaSync } from "./quota.ts";
import type { SettingsStore } from "./settings.ts";
import { startCockpit } from "./test-support/cockpit-harness.ts";

const T0 = Date.UTC(2026, 8, 28, 9, 0, 0);
const MINUTE = 60_000;
const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;
const AUTH = JSON.stringify({ "github-copilot": { type: "oauth", refresh: "jeton-de-test", access: "jeton-de-test" } });
const REPONSE = {
  copilot_plan: "business",
  quota_snapshots: { premium_interactions: { entitlement: 300, remaining: 120, percent_remaining: 40, unlimited: false, overage_count: 0 } },
};

interface Banc {
  quota: QuotaSync;
  /** Heure (simulée) de chaque appel réseau vers copilot_internal/user. */
  appels: number[];
  reglage: { enabled: boolean; intervalMinutes: number };
  /** true : le proxy refuse (erreur réseau) ; false : GitHub répond 200. */
  refus: { actif: boolean };
  /** Fait tourner le minuteur `n` minutes, une minute à la fois, travail asynchrone terminé à chaque tour. */
  minutes(n: number): Promise<void>;
  repos(): Promise<void>;
}

/** Microtâches vidées : lecture d'auth.json et fetch simulés ne font aucune entrée-sortie réelle. */
async function repos(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function banc(t: TestContext, options: { enabled?: boolean; intervalMinutes?: number; refus?: boolean } = {}): Banc {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: T0 });
  t.mock.method(fsp, "readFile", async () => AUTH);
  const appels: number[] = [];
  const refus = { actif: options.refus ?? true };
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.equal(url, "https://api.github.com/copilot_internal/user");
    appels.push(Date.now());
    if (refus.actif) throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    return { ok: true, status: 200, json: async () => REPONSE } as unknown as Response;
  });
  const reglage = { enabled: options.enabled ?? true, intervalMinutes: options.intervalMinutes ?? 15 };
  const quota = new QuotaSync({
    db: openMemoryDb(),
    settings: { get: () => ({ quotaSync: reglage }) } as unknown as SettingsStore,
    hub: { cockpit: () => undefined } as unknown as EventHub,
    log: quiet,
    opencodeDataDir: path.join(os.tmpdir(), "quota-banc-inexistant"),
    githubEnterpriseDomain: null,
  });
  t.after(() => quota.stop());
  return {
    quota,
    appels,
    reglage,
    refus,
    repos,
    async minutes(n) {
      for (let i = 0; i < n; i++) {
        t.mock.timers.tick(MINUTE);
        await repos();
      }
    },
  };
}

describe("synchronisation du solde : échec gardé (banc réseau v2, A45)", () => {
  it("constantes : minuteur de 60 s, échec gardé au moins une heure", () => {
    assert.equal(QUOTA_TICK_MS, MINUTE);
    assert.ok(QUOTA_FAILURE_RETRY_MS >= 60 * MINUTE);
  });

  it("proxy qui refuse : un seul essai au démarrage, 0 appel pendant 13 tours de 60 s, un seul à +1 h, puis rien avant +2 h", async (t) => {
    const b = banc(t);
    b.quota.start();
    await b.repos();
    assert.deepEqual(b.appels, [T0], "au démarrage : un seul essai");
    assert.match(b.quota.lastError ?? "", /fetch failed/);
    await b.minutes(13);
    assert.equal(b.appels.length, 1, "13 tours de 60 s après l'échec : aucun nouvel appel (avant : 13 CONNECT refusés)");
    await b.minutes(46);
    assert.equal(b.appels.length, 1, "59 minutes après l'échec : toujours aucun appel");
    await b.minutes(1);
    assert.deepEqual(b.appels, [T0, T0 + 60 * MINUTE], "une heure après l'échec : un appel, un seul");
    await b.minutes(59);
    assert.equal(b.appels.length, 2);
    await b.minutes(1);
    assert.equal(b.appels.length, 3, "toujours en échec : au plus un appel par heure");
    assert.match(b.quota.lastError ?? "", /fetch failed/, "l'erreur reste visible");
  });

  it("intervalle de 2 h : après un échec, rien avant 2 h (l'intervalle choisi l'emporte sur l'heure)", async (t) => {
    const b = banc(t, { intervalMinutes: 120 });
    b.quota.start();
    await b.repos();
    assert.equal(b.appels.length, 1);
    await b.minutes(119);
    assert.equal(b.appels.length, 1, "rien avant 2 h");
    await b.minutes(1);
    assert.deepEqual(b.appels, [T0, T0 + 120 * MINUTE]);
  });

  it("réussite : relevé suivant à l'intervalle ; puis un échec : rien pendant une heure", async (t) => {
    const b = banc(t, { refus: false });
    b.quota.start();
    await b.repos();
    assert.equal(b.appels.length, 1);
    assert.equal(b.quota.lastError, null);
    assert.equal(b.quota.latest()?.takenAt, T0);
    await b.minutes(14);
    assert.equal(b.appels.length, 1, "réussite : rien avant l'intervalle (15 min)");
    await b.minutes(1);
    assert.deepEqual(b.appels, [T0, T0 + 15 * MINUTE], "intervalle écoulé : un relevé");
    b.refus.actif = true;
    await b.minutes(15);
    assert.deepEqual(b.appels, [T0, T0 + 15 * MINUTE, T0 + 30 * MINUTE], "relevé dû à +30 min : il échoue");
    await b.minutes(59);
    assert.equal(b.appels.length, 3, "échec à +30 min : aucun essai automatique pendant une heure");
    await b.minutes(1);
    assert.equal(b.appels.length, 4, "une heure après l'échec : nouvel essai");
  });

  it("[Synchroniser maintenant] toujours possible après un échec, sans rafale : clics simultanés partagés, échec manuel gardé comme les autres", async (t) => {
    const b = banc(t);
    b.quota.start();
    await b.repos();
    await b.minutes(10);
    assert.equal(b.appels.length, 1);
    // Clic à +10 min, pendant la garde : l'appel part (jamais bloqué).
    await assert.rejects(b.quota.syncNow(), /fetch failed/);
    assert.deepEqual(b.appels, [T0, T0 + 10 * MINUTE]);
    // Double clic : une seule tentative, partagée.
    const premier = b.quota.syncNow();
    const second = b.quota.syncNow();
    assert.equal(premier, second, "tentative en cours partagée");
    await assert.rejects(premier);
    assert.equal(b.appels.length, 3, "deux clics simultanés : un seul appel");
    // L'échec manuel repousse l'essai automatique : pas de rafale derrière le clic, rien avant +10 min + 1 h.
    await b.minutes(59);
    assert.equal(b.appels.length, 3, "après un échec manuel : aucun essai automatique pendant une heure");
    await b.minutes(1);
    assert.equal(b.appels.length, 4);
    // Clic qui réussit : erreur effacée, relevé enregistré, l'intervalle reprend.
    b.refus.actif = false;
    const releve = await b.quota.syncNow();
    assert.equal(releve.remaining, 120);
    assert.equal(b.quota.lastError, null);
    assert.equal(b.appels.length, 5);
    await b.minutes(14);
    assert.equal(b.appels.length, 5);
    await b.minutes(1);
    assert.equal(b.appels.length, 6, "réussite manuelle : relevé automatique à l'intervalle");
  });

  it("synchronisation automatique coupée (défaut) : aucun appel du minuteur, même après des heures ; le bouton reste possible", async (t) => {
    const b = banc(t, { enabled: false });
    b.quota.start();
    await b.repos();
    await b.minutes(180);
    assert.equal(b.appels.length, 0);
    await assert.rejects(b.quota.syncNow());
    assert.equal(b.appels.length, 1);
    await b.minutes(180);
    assert.equal(b.appels.length, 1, "l'échec du bouton ne lance aucun essai automatique");
  });
});

describe("synchronisation du solde : prochain essai automatique annoncé (automaticRetryAt)", () => {
  function sync(reglage: { enabled: boolean; intervalMinutes: number }, clock: { now: number }, reponse: () => Promise<Response>) {
    return new QuotaSync({
      db: openMemoryDb(),
      settings: { get: () => ({ quotaSync: reglage }) } as unknown as SettingsStore,
      hub: { cockpit: () => undefined } as unknown as EventHub,
      log: quiet,
      opencodeDataDir: path.join(os.tmpdir(), "quota-inexistant"),
      githubEnterpriseDomain: null,
      now: () => clock.now,
      fetch: reponse,
    });
  }

  it("après un échec : début de la tentative + max(1 h, intervalle) ; null sans échec, après une réussite ou réglage coupé", async (t) => {
    t.mock.method(fsp, "readFile", async () => AUTH);
    const clock = { now: T0 };
    const reglage = { enabled: true, intervalMinutes: 15 };
    let refus = true;
    const quota = sync(reglage, clock, async () => {
      if (refus) return { ok: false, status: 403, json: async () => ({}) } as unknown as Response;
      return { ok: true, status: 200, json: async () => REPONSE } as unknown as Response;
    });
    assert.equal(quota.automaticRetryAt(), null, "aucune tentative");
    await quota.automaticTick();
    assert.match(quota.lastError ?? "", /GitHub a répondu 403/);
    assert.equal(quota.automaticRetryAt(), T0 + 60 * MINUTE);
    reglage.intervalMinutes = 120;
    assert.equal(quota.automaticRetryAt(), T0 + 120 * MINUTE, "intervalle plus long que l'heure");
    reglage.enabled = false;
    assert.equal(quota.automaticRetryAt(), null, "synchronisation automatique coupée : aucun essai prévu");
    reglage.enabled = true;
    reglage.intervalMinutes = 15;
    clock.now += 10 * MINUTE;
    await quota.automaticTick();
    assert.equal(quota.automaticRetryAt(), T0 + 60 * MINUTE, "tour pendant la garde : rien de lancé, échéance inchangée");
    refus = false;
    await quota.syncNow();
    assert.equal(quota.lastError, null);
    assert.equal(quota.automaticRetryAt(), null, "réussite : plus d'échec à annoncer");
  });

  it("GET /api/quota rend automaticRetryAt après un échec de [Synchroniser maintenant] (jeton absent : aucun appel réseau)", async (t) => {
    const clock = { now: T0 };
    const appels: string[] = [];
    const h = await startCockpit(t, {
      log: quiet,
      deps: (base) => ({
        quota: new QuotaSync({
          db: base.db,
          settings: base.settings,
          hub: base.hub,
          log: base.log,
          opencodeDataDir: path.join(os.tmpdir(), "quota-route-sans-auth"),
          githubEnterpriseDomain: null,
          now: () => clock.now,
          fetch: async (url) => {
            appels.push(url);
            throw new TypeError("fetch failed");
          },
        }),
      }),
    });
    const avant = await h.call("GET", "/api/quota", { headers: h.headers.authed });
    assert.equal(avant.status, 200);
    assert.deepEqual(avant.json(), { latest: null, lastError: null, enabled: false, automaticRetryAt: null });
    const sync = await h.call("POST", "/api/quota/sync", { headers: h.headers.mutating });
    assert.ok(sync.status >= 400, `échec rendu (${sync.status})`);
    assert.deepEqual(appels, [], "jeton absent : aucun appel réseau");
    h.settings.update({ quotaSync: { enabled: true, intervalMinutes: 30 } });
    const apres = await h.call("GET", "/api/quota", { headers: h.headers.authed });
    const corps = apres.json<{ lastError: string | null; enabled: boolean; automaticRetryAt: number | null }>();
    assert.equal(corps.enabled, true);
    assert.match(corps.lastError ?? "", /.+/);
    assert.equal(corps.automaticRetryAt, T0 + 60 * MINUTE);
  });
});
