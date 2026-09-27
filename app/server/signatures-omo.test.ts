// Tests T3c : signatures À COMPORTEMENT CONSTANT posées pour la Salle OMO, et unions d'arrêt (D-2b-41).
// Plan d'exécution 2 bis-2 ter §4.3 et §1.3 (réservations 2 et 5) ; spécification §3.10 l.358, §3.12.1 l.403.
// Rien de la salle n'est branché ici : on vérifie seulement que, SANS option d'instance, tout se comporte exactement comme en
// 1.0.x, que l'instance posée à l'insertion n'est plus jamais réécrite, et que les unions élargies gardent leurs tables
// exhaustives valides.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { openMemoryDb } from "./db.ts";
import { type BrowserEvent, EventHub, type HubOmoEventMap } from "./hub.ts";
import { createLogger } from "./log.ts";
import { OMO_STOP_CAUSES } from "./omo-contracts.ts";
import type { OcSession, OpencodeClient } from "./opencode.ts";
import { EventProcessor, type ProcessorDeps } from "./processor.ts";
import { SessionTracker } from "./sessions.ts";
import type { SessionInstance } from "./shared/activity-types.ts";
import type { ConversationAutonomyView, RequestEnd } from "./shared/autonomy-types.ts";
import type { CockpitEventMap, StopCause } from "./shared/cockpit-event-types.ts";
import type { OmoEventMap, OmoStopCause } from "./shared/omo-types.ts";
import { REQUEST_END_OF_STOP, STATUT_CAUSE_OF_STOP } from "./stop-tree.ts";

const T = Date.UTC(2026, 8, 21, 9, 0, 0);

const session = (id: string, parentID?: string): OcSession => ({
  id,
  projectID: "p",
  directory: "/workspace/app",
  title: `Session ${id}`,
  time: { created: T, updated: T },
  ...(parentID ? { parentID } : {}),
});

/** Faux client : rend les sessions demandées par `ensure`, et compte les appels. */
function fauxClient(connues: Record<string, OcSession>) {
  const demandes: string[] = [];
  const client = {
    request: async <T>(_method: string, chemin: string): Promise<T> => {
      const id = decodeURIComponent(chemin.replace("/session/", ""));
      demandes.push(id);
      const info = connues[id];
      if (!info) throw new Error(`session ${id} inconnue`);
      return info as T;
    },
  } as unknown as OpencodeClient;
  return { client, demandes };
}

function tracker(connues: Record<string, OcSession> = {}) {
  const db = openMemoryDb();
  const { client, demandes } = fauxClient(connues);
  return { db, demandes, sessions: new SessionTracker(db, client) };
}

describe("T3c : sessions, instance posée à l'insertion seulement", () => {
  it("upsert sans option : « principale », exactement comme en 1.0.x", () => {
    const { sessions } = tracker();
    assert.equal(sessions.upsert(session("ses_a")).instance, "principale");
    assert.equal(sessions.upsert(session("ses_b", "ses_a")).instance, "principale");
    // Usage forcé sans option d'instance : inchangé lui aussi.
    assert.equal(sessions.upsert(session("ses_c"), "classifier").instance, "principale");
    assert.equal(sessions.upsert(session("ses_d"), undefined, {}).instance, "principale");
  });

  it("l'instance de l'insertion n'est JAMAIS modifiée par un second upsert, dans les deux sens", () => {
    const { sessions } = tracker();
    assert.equal(sessions.upsert(session("ses_omo"), undefined, { instance: "omo" }).instance, "omo");
    // Un événement de l'instance principale ne ramène pas la session dans « principale ».
    assert.equal(sessions.upsert(session("ses_omo")).instance, "omo");
    assert.equal(sessions.upsert(session("ses_omo"), "controle", { instance: "principale" }).instance, "omo");

    assert.equal(sessions.upsert(session("ses_principale")).instance, "principale");
    assert.equal(sessions.upsert(session("ses_principale"), undefined, { instance: "omo" }).instance, "principale");
    // Le reste de la mise à jour continue de passer (titre, agent, parenté) : seule l'instance est figée.
    const maj = sessions.upsert({ ...session("ses_principale"), title: "Titre revu", agent: "build" });
    assert.deepEqual({ instance: maj.instance, title: maj.title, agent: maj.agent }, { instance: "principale", title: "Titre revu", agent: "build" });
  });

  it("ensure sans instance : « principale » ; avec une instance, la lignée découverte la reçoit", async () => {
    const connues = { ses_mere: session("ses_mere"), ses_fille: session("ses_fille", "ses_mere") };
    const principale = tracker(connues);
    const fille = await principale.sessions.ensure("ses_fille", "/workspace/app");
    assert.equal(fille?.instance, "principale");
    assert.equal(principale.sessions.get("ses_mere")?.instance, "principale");
    assert.deepEqual(principale.demandes, ["ses_fille", "ses_mere"]);

    const salle = tracker(connues);
    const fille2 = await salle.sessions.ensure("ses_fille", "/workspace/app", 0, "omo");
    assert.equal(fille2?.instance, "omo");
    assert.equal(salle.sessions.get("ses_mere")?.instance, "omo");

    // `depth` garde sa place et son rôle : au-delà de 8, la remontée s'arrête sans interroger opencode.
    const profond = tracker(connues);
    assert.equal(await profond.sessions.ensure("ses_fille", "/workspace/app", 9), undefined);
    assert.deepEqual(profond.demandes, []);
  });

  it("session déjà suivie : ensure ne rappelle pas opencode et ne touche pas à l'instance", async () => {
    const { sessions, demandes } = tracker({ ses_seule: session("ses_seule") });
    sessions.upsert(session("ses_seule"), undefined, { instance: "omo" });
    const row = await sessions.ensure("ses_seule", "/workspace/app", 0, "principale");
    assert.equal(row?.instance, "omo");
    assert.deepEqual(demandes, []);
  });
});

describe("T3c : hub et processeur, instance absente = 1.0.x", () => {
  it("hub.cockpit sans instance : l'événement publié est exactement celui de la 1.0.x", () => {
    const hub = new EventHub();
    const vus: BrowserEvent[] = [];
    hub.subscribe((e) => vus.push(e));
    hub.cockpit("usage.updated", { sessionId: "ses_a" });
    hub.cockpit("usage.updated", { sessionId: "ses_b" }, "omo");
    hub.publish({ kind: "opencode", directory: "/workspace", event: { type: "session.idle", properties: {} } });
    assert.deepEqual(vus, [
      { kind: "cockpit", type: "usage.updated", data: { sessionId: "ses_a" } },
      { kind: "cockpit", type: "usage.updated", data: { sessionId: "ses_b" }, instance: "omo" },
      { kind: "opencode", directory: "/workspace", event: { type: "session.idle", properties: {} } },
    ]);
    assert.equal(Object.hasOwn(vus[0] as object, "instance"), false, "aucun champ instance quand elle n'est pas donnée");
  });

  it("EventProcessor : instance « principale » sans option ; l'option la change et, depuis L18a (V3), étiquette la salle", () => {
    const { db, sessions } = tracker();
    const deps = {
      db,
      client: {} as OpencodeClient,
      sessions,
      ledger: {} as ProcessorDeps["ledger"],
      archive: {} as ProcessorDeps["archive"],
      classifier: {} as ProcessorDeps["classifier"],
      hub: new EventHub(),
      log: createLogger("error"),
    } satisfies ProcessorDeps;
    assert.equal(new EventProcessor(deps).instance, "principale");
    assert.equal(new EventProcessor({ ...deps, instance: "principale" }).instance, "principale");
    assert.equal(new EventProcessor({ ...deps, instance: "omo" }).instance, "omo");
    // V3 (L18a) : le processeur étiquette ses écritures et ses publications avec SON instance. La règle de T3c qui tient
    // toujours est l'autre sens — sans option, rien n'est étiqueté : c'est ce que disent les trois égalités ci-dessus et les
    // tests « 1.0.x » de instances-events.test.ts. La forme du code garde deux garde-fous : l'instance vient toujours du
    // processeur (aucune valeur écrite en dur) et le rattrapage a une clé par instance.
    const source = fs.readFileSync(path.join(import.meta.dirname, "processor.ts"), "utf8");
    assert.equal(/upsert\(info, undefined, \{ instance \}\)/u.test(source), true, "le processeur étiquette la session avec SON instance");
    assert.equal(/instance: "omo"|"sync\.lastAt:omo"/u.test(source), false, "aucune instance écrite en dur dans le processeur");
    assert.equal(/syncKeyOf\(instance\)/u.test(source), true, "clé de rattrapage propre à l'instance");
  });
});

describe("T3c : unions d'arrêt (D-2b-41)", () => {
  it("StopCause INCHANGÉE : les deux tables exhaustives de stop-tree.ts gardent leurs six causes", () => {
    const causes: Record<StopCause, true> = {
      vous: true,
      "plafond-cout": true,
      "plafond-delegations": true,
      "non-controle": true,
      rechargement: true,
      equipe: true,
    };
    const attendues = ["vous", "plafond-cout", "plafond-delegations", "non-controle", "rechargement", "equipe"];
    assert.deepEqual(Object.keys(causes).sort((a, b) => a.localeCompare(b)), [...attendues].sort((a, b) => a.localeCompare(b)));
    assert.deepEqual(Object.keys(REQUEST_END_OF_STOP).sort((a, b) => a.localeCompare(b)), [...attendues].sort((a, b) => a.localeCompare(b)));
    assert.deepEqual(Object.keys(STATUT_CAUSE_OF_STOP).sort((a, b) => a.localeCompare(b)), [...attendues].sort((a, b) => a.localeCompare(b)));
    // Aucune cause de la salle n'est entrée dans les tables de l'instance principale.
    for (const cause of OMO_STOP_CAUSES) {
      if ((attendues as readonly string[]).includes(cause)) continue;
      assert.equal(Object.hasOwn(REQUEST_END_OF_STOP, cause), false, cause);
      assert.equal(Object.hasOwn(STATUT_CAUSE_OF_STOP, cause), false, cause);
    }
  });

  it("chaque OmoStopCause a une valeur de RequestEnd (contrôle de types et liste fermée de T3a)", () => {
    const finDe = {
      vous: "vous",
      "plafond-cout": "plafond-cout",
      "plafond-duree": "plafond-duree",
      "plafond-sessions": "plafond-sessions",
      "plafond-tentatives": "plafond-tentatives",
      "seuil-mensuel": "seuil-mensuel",
      "hors-controle": "hors-controle",
      "homme-mort": "homme-mort",
      "redemarrage-cockpit": "redemarrage-cockpit",
    } satisfies Record<OmoStopCause, RequestEnd>;
    assert.deepEqual(Object.keys(finDe).sort((a, b) => a.localeCompare(b)), [...OMO_STOP_CAUSES].sort((a, b) => a.localeCompare(b)));
    // « seuil-mensuel » est la seule valeur ajoutée à RequestEnd par T3c : les autres y étaient déjà.
    const ends: Record<RequestEnd, true> = {
      terminee: true,
      "plafond-cout": true,
      "plafond-actions": true,
      "plafond-duree": true,
      "plafond-fichiers": true,
      vous: true,
      "non-controle": true,
      rechargement: true,
      "redemarrage-cockpit": true,
      "hors-controle": true,
      "homme-mort": true,
      recreation: true,
      "plafond-tentatives": true,
      "plafond-sessions": true,
      "seuil-mensuel": true,
      interrompue: true,
    };
    assert.equal(Object.keys(ends).length, 16);
    for (const cause of OMO_STOP_CAUSES) assert.equal(Object.hasOwn(ends, cause), true, cause);
  });

  it("conversation.arretee accepte une cause de l'instance principale ET une cause de la salle", () => {
    const evenements: Array<CockpitEventMap["conversation.arretee"]> = [
      { rootId: "ses_a", cause: "vous", unconfirmed: [] },
      { rootId: "ses_b", cause: "equipe", unconfirmed: ["ses_c"] },
      { rootId: "ses_d", cause: "homme-mort", unconfirmed: [] },
      { rootId: "ses_e", cause: "seuil-mensuel", unconfirmed: [] },
    ];
    assert.equal(evenements.length, 4);
    // La donnée de « omo.connection » vient du contrat de la salle, jamais redéfinie dans le hub.
    const connexion: HubOmoEventMap["omo.connection"] = { connected: false, error: "flux terminé" };
    const memeForme: OmoEventMap["omo.connection"] = connexion;
    assert.deepEqual(memeForme, { connected: false, error: "flux terminé" });
  });

  it("réservation 2 : ConversationAutonomyView.instance est facultative (absente = instance principale)", () => {
    const vue: ConversationAutonomyView = {
      rootId: "ses_a",
      choix: "demander",
      plafonds: { plafondUsd: 1, actionsMax: 60, delegationsMax: 5, dureeMinutes: 30, fichiersMax: 25, controlesIaMax: 20 },
      depuis: null,
      retourCause: null,
      planSourceId: null,
      executionDePlanId: null,
      interrupteur: true,
      disponibles: [],
      demande: null,
    };
    assert.equal(Object.hasOwn(vue, "instance"), false);
    const salle: ConversationAutonomyView = { ...vue, instance: "omo" };
    assert.equal(salle.instance, "omo");
    const lue: SessionInstance = salle.instance ?? "principale";
    assert.equal(lue, "omo");
  });

  it("le contrat de la salle n'entre dans le produit que par des « import type » (effacés à la compilation)", () => {
    for (const fichier of ["hub.ts", path.join("shared", "cockpit-event-types.ts")]) {
      const source = fs.readFileSync(path.join(import.meta.dirname, fichier), "utf8");
      const citations = [...source.matchAll(/^.*omo-types\.ts.*$/gmu)].map((m) => m[0]);
      assert.ok(citations.length > 0, `${fichier} : aucune citation du contrat de la salle`);
      for (const ligne of citations) assert.match(ligne.trim(), /^import type /u, `${fichier} : ${ligne.trim()}`);
    }
  });
});
