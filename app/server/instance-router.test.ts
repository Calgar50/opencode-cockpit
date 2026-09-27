// Routeur d'instances (L18b, plan 2 bis, fiche L18b ; spécification §3.8 l.325, §3.10 l.358, P11) : l'instance d'une session est
// lue dans la colonne `sessions.instance` (T3c), jamais devinée. Une session inconnue rend null, et c'est le proxy qui décide
// quoi en faire (404 croisé, 409 sur la salle). Aucun appel réseau ici : tout se joue sur la base.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openMemoryDb } from "./db.ts";
import { createInstanceRouter, type InstanceRouterSessions } from "./instance-router.ts";
import type { InstanceDeps } from "./omo-contracts.ts";
import type { OcSession, OpencodeClient } from "./opencode.ts";
import { SessionTracker } from "./sessions.ts";
import type { SessionInstance } from "./shared/activity-types.ts";

/** Dépendances d'instance réduites à ce que le routeur en fait : il les rend telles quelles, sans jamais les appeler. */
const deps = (instance: SessionInstance): InstanceDeps => ({ instance }) as unknown as InstanceDeps;

const PRINCIPALE = deps("principale");
const SALLE = deps("omo");

/** Suivi des sessions en mémoire : le routeur n'a besoin que de `get`. */
const suivi = (entrees: Record<string, SessionInstance>): InstanceRouterSessions => ({
  get: (id) => (Object.hasOwn(entrees, id) ? { instance: entrees[id] as SessionInstance } : undefined),
});

describe("routeur d'instances : of et instanceOf", () => {
  it("of : la salle absente (salle coupée) rend null, l'instance principale toujours elle-même", () => {
    const coupee = createInstanceRouter({ principale: PRINCIPALE, omo: null });
    assert.equal(coupee.of("principale"), PRINCIPALE);
    assert.equal(coupee.of("omo"), null);
    assert.equal(coupee.omo, null);
    const ouverte = createInstanceRouter({ principale: PRINCIPALE, omo: SALLE });
    assert.equal(ouverte.of("omo"), SALLE);
    assert.equal(ouverte.principale, PRINCIPALE);
  });

  it("instanceOf : rend l'instance écrite en base ; session inconnue ou identifiant hors motif → null", () => {
    const routeur = createInstanceRouter({
      principale: PRINCIPALE,
      omo: SALLE,
      sessions: suivi({ ses_principale: "principale", ses_salle: "omo" }),
    });
    assert.equal(routeur.instanceOf("ses_principale"), "principale");
    assert.equal(routeur.instanceOf("ses_salle"), "omo");
    assert.equal(routeur.instanceOf("ses_absente"), null);
    // Identifiants refusés par le motif partagé (shared/ids.ts) : jamais portés à la base.
    for (const identifiant of ["", "ses/1", "ses 1", "ses_1'", "../ses_1", "s".repeat(129)]) {
      assert.equal(routeur.instanceOf(identifiant), null, identifiant);
    }
  });

  it("instanceOf : sans suivi des sessions (squelette de T3b), aucune session n'est rattachée", () => {
    const routeur = createInstanceRouter({ principale: PRINCIPALE, omo: SALLE });
    assert.equal(routeur.instanceOf("ses_1"), null);
  });

  it("instanceOf : une valeur inattendue en base est lue comme inconnue, jamais comme « principale »", () => {
    const routeur = createInstanceRouter({
      principale: PRINCIPALE,
      omo: SALLE,
      sessions: { get: () => ({ instance: "autre" as SessionInstance }) },
    });
    assert.equal(routeur.instanceOf("ses_1"), null);
  });

  it("instanceOf sur SessionTracker : lit l'instance posée à l'insertion, et le changement d'instance est impossible", () => {
    const db = openMemoryDb();
    try {
      const client = { request: async () => ({}) } as unknown as OpencodeClient;
      const sessions = new SessionTracker(db, client);
      const routeur = createInstanceRouter({ principale: PRINCIPALE, omo: SALLE, sessions });
      const info = (id: string): OcSession => ({ id, title: "Conversation", directory: "/workspace/app" }) as OcSession;
      sessions.upsert(info("ses_a"));
      sessions.upsert(info("ses_b"), undefined, { instance: "omo" });
      assert.equal(routeur.instanceOf("ses_a"), "principale");
      assert.equal(routeur.instanceOf("ses_b"), "omo");
      // Second upsert avec l'autre instance : l'instance d'une session déjà connue ne change jamais (sessions.ts).
      sessions.upsert(info("ses_a"), undefined, { instance: "omo" });
      sessions.upsert(info("ses_b"), undefined, { instance: "principale" });
      assert.equal(routeur.instanceOf("ses_a"), "principale");
      assert.equal(routeur.instanceOf("ses_b"), "omo");
      assert.equal(routeur.instanceOf("ses_jamais_vue"), null);
    } finally {
      db.close();
    }
  });
});
