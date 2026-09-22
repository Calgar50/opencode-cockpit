// Tests L18a : ÉVÉNEMENTS par instance (plan 2 bis, fiche L18a ; spécification §3.10 l.358-359, §3.11 l.382, §3.13 l.412,
// P6 l.41, P11 l.46, §7.5 l.1146 ; D-2b-05, D-2b-20).
// Ce que chaque test garde :
// - T-L18-c : un événement de la salle n'est JAMAIS appliqué à une racine de l'instance principale, même à identifiant égal ;
// - conflit d'identifiant refusé, journalisé et annoncé (onInstanceConflict, qui alimente les détections de L23c) ;
// - publications étiquetées (BrowserEvent.instance) ; « omo.connection » pour la salle, jamais « opencode.connection » ;
// - coupure du flux de la salle → l'instance principale n'est JAMAIS mise en « synchro due », et une fin de réponse dans la
//   salle ne relance pas la synchro de l'adresse Copilot de l'instance principale (resyncOnIdle) ;
// - clé de rattrapage propre (sync.lastAt:omo) ;
// - P6 : la garde « ne redémarre jamais opencode » porte sur l'instance principale ;
// - T-L18-l : bornes du réducteur de faits sur une rafale de la salle, délais par horloge injectée ;
// - T-L18-d, autre sens : sans instance, tout est exactement ce qu'écrivait la 1.0.x.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { activityDerivation, ENSURE_TIMEOUT_MS, PENDING_EVENTS_MAX, PENDING_SESSIONS_MAX } from "./activity-deriver.ts";
import { ArchiveService } from "./archive.ts";
import type { Classifier } from "./classifier.ts";
import type { Cockpit11 } from "./contracts-11.ts";
import { openMemoryDb } from "./db.ts";
import { type BrowserEvent, EventHub } from "./hub.ts";
import { Ledger } from "./ledger.ts";
import { createLogger } from "./log.ts";
import { resyncOnIdle, resyncOnReconnect } from "./oc-copilot-config.ts";
import type { OcGlobalEvent, OcSession, OpencodeClient } from "./opencode.ts";
import { EventProcessor, syncKeyOf } from "./processor.ts";
import { type SessionInstanceConflict, SessionTracker } from "./sessions.ts";
import { SettingsStore } from "./settings.ts";
import type { SessionInstance } from "./shared/activity-types.ts";
import { createId } from "./test-support/fake-opencode.ts";
import { startCockpit } from "./test-support/cockpit-harness.ts";
import { until } from "./test-support/helpers.ts";

const T = Date.UTC(2026, 8, 21, 10, 0, 0);

const session = (id: string, extra: Partial<OcSession> = {}): OcSession => ({
  id,
  projectID: "p",
  directory: "/workspace/app",
  title: `Session ${id}`,
  time: { created: T, updated: T },
  ...extra,
});

const evenement = (type: string, properties: Record<string, unknown>, directory = "/workspace/app"): OcGlobalEvent => ({
  directory,
  payload: { id: createId("evt"), type, properties },
});

/** Client dont le flux est piloté à la main : aucun réseau, donc aucun aléa de temps. */
function clientPilote() {
  const demandes: string[] = [];
  const reponses = new Map<string, unknown>();
  let flux: { onEvent: (event: OcGlobalEvent) => void; onStatus: (status: "connected" | "disconnected", error?: string) => void } | null = null;
  const client = {
    subscribeGlobal: (onEvent: (event: OcGlobalEvent) => void, onStatus: (status: "connected" | "disconnected", error?: string) => void) => {
      flux = { onEvent, onStatus };
      return () => {
        flux = null;
      };
    },
    request: async <R>(method: string, chemin: string): Promise<R> => {
      demandes.push(`${method} ${chemin}`);
      const prevue = reponses.get(`${method} ${chemin}`);
      if (prevue === undefined) throw new Error("client piloté : aucune réponse");
      return prevue as R;
    },
  } as unknown as OpencodeClient;
  return {
    client,
    demandes,
    reponses,
    emettre: (event: OcGlobalEvent) => flux?.onEvent(event),
    statut: (status: "connected" | "disconnected", error?: string) => flux?.onStatus(status, error),
  };
}

/** Processeur réel bâti sur un client piloté, avec une base en mémoire. */
function montage(instance?: SessionInstance) {
  const db = openMemoryDb();
  const settings = new SettingsStore(db);
  const hub = new EventHub();
  const vus: BrowserEvent[] = [];
  hub.subscribe((event) => void vus.push(event));
  const pilote = clientPilote();
  const log = createLogger("error");
  const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), "l18a-archives-"));
  const sessions = new SessionTracker(db, pilote.client);
  const catalog = { list: () => [], prices: new Map(), loaded: true } as unknown as ConstructorParameters<typeof Ledger>[0]["catalog"];
  const ledger = new Ledger({ db, settings, catalog });
  const archive = new ArchiveService({
    db,
    client: pilote.client,
    settings,
    ledger,
    sessions,
    archiveDir,
    opencodeWorkspaceDir: "/workspace",
    log,
  });
  const classements: string[] = [];
  const classifier = { onIdle: (id: string) => void classements.push(`idle:${id}`), onBusy: (id: string) => void classements.push(`busy:${id}`) } as unknown as Classifier;
  const processor = new EventProcessor({ db, client: pilote.client, sessions, ledger, archive, classifier, hub, log, ...(instance ? { instance } : {}) });
  processor.start();
  /** Conversation archivée d'une racine, pour suivre le titre repris (ou non) par le processeur. */
  const archiver = (id: string, titre: string) =>
    db.prepare("INSERT INTO conversations (session_id, directory, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, "/workspace/app", titre, T, T);
  const titreArchive = (id: string) => (db.prepare("SELECT title FROM conversations WHERE session_id = ?").get(id) as { title: string } | undefined)?.title;
  const fermer = () => {
    processor.stop();
    db.close();
    fs.rmSync(archiveDir, { recursive: true, force: true });
  };
  return { db, hub, vus, pilote, sessions, ledger, archive, classifier, classements, processor, settings, archiver, titreArchive, fermer };
}

describe("L18a : le processeur de la salle n'écrit jamais sur une racine de l'instance principale", () => {
  it("T-L18-c : session.updated de la salle à identifiant ÉGAL — rien n'est repris, le conflit est annoncé", async () => {
    const principale = montage();
    principale.sessions.upsert(session("ses_meme", { title: "Conversation du cockpit" }));
    const conflits: SessionInstanceConflict[] = [];
    principale.sessions.onInstanceConflict((conflit) => void conflits.push(conflit));

    // Second processeur, même base, même suivi de sessions : exactement la disposition des deux instances.
    const salle = new EventProcessor({
      db: principale.db,
      client: principale.pilote.client,
      sessions: principale.sessions,
      ledger: principale.ledger,
      archive: principale.archive,
      classifier: principale.classifier,
      hub: principale.hub,
      log: createLogger("error"),
      instance: "omo",
    });
    salle.start();
    principale.pilote.emettre(evenement("session.updated", { info: session("ses_meme", { title: "Titre imposé par la salle" }) }));
    await salle.settled();
    await principale.processor.settled();

    const ligne = principale.sessions.get("ses_meme");
    assert.equal(ligne?.instance, "principale");
    assert.equal(ligne?.title, "Conversation du cockpit", "le titre de la salle n'a PAS été repris");
    assert.deepEqual(conflits, [{ sessionId: "ses_meme", enregistree: "principale", refusee: "omo" }]);
    salle.stop();
    principale.fermer();
  });

  it("conflit journalisé : le message nomme le refus, sans rien écrire (les deux sens)", () => {
    const db = openMemoryDb();
    const messages: Array<{ message: string; data: unknown }> = [];
    const log = { warn: (message: string, data?: unknown) => void messages.push({ message, data }) };
    const sessions = new SessionTracker(db, {} as OpencodeClient, { log });
    const conflits: SessionInstanceConflict[] = [];
    sessions.onInstanceConflict((conflit) => void conflits.push(conflit));

    sessions.upsert(session("ses_p", { title: "Principale" }));
    sessions.upsert(session("ses_o", { title: "Salle" }), undefined, { instance: "omo" });
    // La salle tente d'écrire une session de l'instance principale, puis l'inverse.
    assert.equal(sessions.upsert(session("ses_p", { title: "Volée" }), undefined, { instance: "omo" }).title, "Principale");
    assert.equal(sessions.upsert(session("ses_o", { title: "Volée" }), undefined, { instance: "principale" }).title, "Salle");
    assert.deepEqual(conflits, [
      { sessionId: "ses_p", enregistree: "principale", refusee: "omo" },
      { sessionId: "ses_o", enregistree: "omo", refusee: "principale" },
    ]);
    assert.deepEqual(
      messages.map((m) => m.message),
      ["session refusée : identifiant déjà suivi par l'autre instance", "session refusée : identifiant déjà suivi par l'autre instance"],
    );
    // Sans option d'instance, l'appelant ne prétend rien : le comportement 1.0.x est gardé (le titre passe).
    assert.equal(sessions.upsert(session("ses_o", { title: "Titre d'opencode" })).title, "Titre d'opencode");
    assert.equal(conflits.length, 2);
    // Un abonné qui lève n'empêche pas les autres.
    sessions.onInstanceConflict(() => {
      throw new Error("abonné en échec");
    });
    const derniers: SessionInstanceConflict[] = [];
    sessions.onInstanceConflict((conflit) => void derniers.push(conflit));
    sessions.upsert(session("ses_p"), undefined, { instance: "omo" });
    assert.equal(derniers.length, 1);
    db.close();
  });

  it("session.deleted et session.status de la salle sur une racine de l'instance principale : sans effet", async () => {
    const m = montage();
    m.sessions.upsert(session("ses_p"));
    m.db.prepare("INSERT INTO conversations (session_id, directory, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("ses_p", "/workspace/app", "T", T, T);
    const salle = new EventProcessor({
      db: m.db,
      client: m.pilote.client,
      sessions: m.sessions,
      ledger: m.ledger,
      archive: m.archive,
      classifier: m.classifier,
      hub: m.hub,
      log: createLogger("error"),
      instance: "omo",
    });
    salle.start();
    m.pilote.emettre(evenement("session.deleted", { info: session("ses_p") }));
    m.pilote.emettre(evenement("session.status", { sessionID: "ses_p", status: { type: "busy" } }));
    await salle.settled();
    await m.processor.settled();
    assert.equal(m.sessions.get("ses_p")?.deleted_at, null, "jamais marquée supprimée par la salle");
    assert.equal((m.db.prepare("SELECT deleted_in_opencode FROM conversations WHERE session_id = ?").get("ses_p") as { deleted_in_opencode: number }).deleted_in_opencode, 0);
    assert.deepEqual(m.classements, [], "aucun classement déclenché par la salle");
    salle.stop();
    m.fermer();
  });

  it("session.updated d'une racine de la SALLE reçue par l'instance principale : le titre archivé ne bouge pas", async () => {
    const m = montage();
    m.sessions.upsert(session("ses_salle", { title: "Titre de la salle" }), undefined, { instance: "omo" });
    m.archiver("ses_salle", "Titre archivé");
    m.pilote.emettre(evenement("session.updated", { info: session("ses_salle", { title: "Nouveau titre facturé" }) }));
    await m.processor.settled();
    assert.equal(m.titreArchive("ses_salle"), "Titre archivé", "le processeur de l'instance principale n'a rien repris de la salle");
    m.fermer();
  });

  it("D-2b-05 : le processeur de la salle ne reprend JAMAIS le titre d'archive (aucun titre facturé archivé)", async () => {
    const m = montage("omo");
    m.sessions.upsert(session("ses_salle", { title: "Titre de la salle" }), undefined, { instance: "omo" });
    m.archiver("ses_salle", "Titre archivé");
    m.pilote.emettre(evenement("session.updated", { info: session("ses_salle", { title: "Titre écrit par l'IA de titre" }) }));
    await m.processor.settled();
    assert.equal(m.titreArchive("ses_salle"), "Titre archivé");
    assert.deepEqual(
      m.vus.filter((e) => e.kind === "cockpit" && e.type === "conversation.updated"),
      [],
    );
    m.fermer();
  });

  it("message.updated d'une session de la SALLE reçu par l'instance principale : rien n'entre dans le relevé", async () => {
    const m = montage();
    m.sessions.upsert(session("ses_salle"), undefined, { instance: "omo" });
    m.pilote.emettre(
      evenement("message.updated", {
        info: {
          id: "msg_1",
          sessionID: "ses_salle",
          role: "assistant",
          time: { created: T, completed: T + 1 },
          cost: 0.5,
          tokens: { input: 10, output: 5 },
          modelID: "gpt-5-mini",
          providerID: "github-copilot",
        },
      }),
    );
    await m.processor.settled();
    assert.equal((m.db.prepare("SELECT COUNT(*) AS n FROM usage").get() as { n: number }).n, 0, "aucune ligne d'usage croisée");
    m.fermer();
  });

  it("rattrapage de la salle : les sessions relevées sont écrites « omo » et la clé de synchro est la sienne", async () => {
    const m = montage("omo");
    // Client piloté : la liste du rattrapage, puis les messages de la session relevée.
    m.pilote.reponses.set("GET /experimental/session", [session("ses_rattrapee", { time: { created: T, updated: Date.now() } })]);
    m.pilote.reponses.set("GET /session/ses_rattrapee/message", []);
    await m.processor.backfill();
    assert.equal(m.sessions.get("ses_rattrapee")?.instance, "omo");
    const cle = (key: string) => m.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    assert.ok(cle("sync.lastAt:omo"), "clé de rattrapage propre à la salle");
    assert.equal(cle("sync.lastAt"), undefined, "celle de l'instance principale n'a pas bougé");
    m.fermer();
  });
});

describe("L18a : publications étiquetées et clé de rattrapage", () => {
  it("1.0.x inchangé : sans instance, ni l'enveloppe opencode ni usage.updated ne portent de champ « instance »", async () => {
    const m = montage();
    m.pilote.statut("connected");
    m.pilote.emettre(evenement("session.idle", { sessionID: "ses_x" }));
    await m.processor.settled();
    const relaye = m.vus.find((e) => e.kind === "opencode");
    assert.ok(relaye);
    assert.equal(Object.hasOwn(relaye, "instance"), false);
    const connexion = m.vus.find((e) => e.kind === "cockpit" && e.type === "opencode.connection");
    assert.ok(connexion, "l'instance principale publie opencode.connection");
    assert.equal(Object.hasOwn(connexion, "instance"), false);
    assert.equal(syncKeyOf("principale"), "sync.lastAt");
    m.fermer();
  });

  it("la salle étiquette l'enveloppe, publie « omo.connection » et jamais « opencode.connection »", async () => {
    const m = montage("omo");
    m.pilote.statut("connected");
    m.pilote.statut("disconnected", "flux terminé");
    m.pilote.emettre(evenement("session.idle", { sessionID: "ses_x" }));
    await m.processor.settled();
    assert.deepEqual(
      m.vus.filter((e) => e.kind === "cockpit").map((e) => [e.type, e.instance, e.data]),
      [
        ["omo.connection", "omo", { connected: true }],
        ["omo.connection", "omo", { connected: false, error: "flux terminé" }],
      ],
    );
    const relaye = m.vus.find((e) => e.kind === "opencode");
    assert.equal(relaye?.instance, "omo");
    assert.equal(syncKeyOf("omo"), "sync.lastAt:omo");
    m.fermer();
  });
});

describe("L18a : l'adresse Copilot de l'instance principale ne suit jamais la salle (§3.13)", () => {
  /** Double de la synchro : on relève seulement ce qui serait déclenché. */
  const synchro = () => {
    const appels: string[] = [];
    return {
      appels,
      port: {
        deferredEpisode: true,
        markDue: (cause: string) => {
          appels.push(`markDue:${cause}`);
          return true;
        },
        sync: async () => {
          appels.push("sync");
          return { state: "a-jour" as const, message: null, at: 0, details: { checked: [] } };
        },
      },
    };
  };

  it("coupure et reconnexion du flux de la SALLE : aucune « synchro due », aucune synchro", async () => {
    const m = montage("omo");
    const s = synchro();
    resyncOnReconnect(m.hub, s.port as never);
    resyncOnIdle(m.hub, s.port as never);
    m.pilote.statut("connected");
    m.pilote.statut("disconnected", "flux coupé");
    m.pilote.statut("connected");
    // Fin de réponse dans la salle : rien non plus (sinon la configuration de l'instance principale serait réécrite).
    m.pilote.emettre(evenement("session.idle", { sessionID: "ses_salle" }));
    m.pilote.emettre(evenement("session.status", { sessionID: "ses_salle", status: { type: "idle" } }));
    await m.processor.settled();
    assert.deepEqual(s.appels, []);
    m.fermer();
  });

  it("la même coupure sur l'instance PRINCIPALE, elle, pose « synchro due » et relance la synchro (garde vérifiée)", async () => {
    const m = montage();
    const s = synchro();
    resyncOnReconnect(m.hub, s.port as never);
    resyncOnIdle(m.hub, s.port as never);
    m.pilote.statut("connected");
    m.pilote.statut("disconnected", "flux coupé");
    m.pilote.statut("connected");
    m.pilote.emettre(evenement("session.idle", { sessionID: "ses_principale" }));
    await m.processor.settled();
    assert.deepEqual(s.appels, [
      "markDue:flux d'événements d'opencode coupé",
      "markDue:flux d'événements d'opencode rétabli",
      "sync",
      "sync",
    ]);
    m.fermer();
  });
});

describe("L18a : harnais à deux instances", () => {
  it("P6 : la garde « ne redémarre jamais opencode » porte sur l'instance principale, pas sur la salle", async (t) => {
    const h = await startCockpit(t, { omo: true });
    assert.ok(h.omo);
    await h.omo.deps.client.request("PATCH", "/global/config", { body: { share: "disabled" } });
    await h.omo.deps.client.request("POST", "/global/dispose");
    h.assertNoGlobalRestart();
    await h.deps.client.request("POST", "/global/dispose");
    assert.throws(() => h.assertNoGlobalRestart(), /POST \/global\/dispose/);
  });

  it("le flux de la salle passe par son processeur réel : enveloppe étiquetée, session écrite « omo », rien côté principale", async (t) => {
    const h = await startCockpit(t, { omo: true });
    assert.ok(h.omo);
    const avant = h.fake.requests.length;
    const creee = await h.omo.deps.client.request<OcSession>("POST", "/session", { body: { title: "Salle" } });
    const ligne = await until(() => h.sessions.get(creee.id));
    assert.equal(ligne.instance, "omo");
    assert.equal(h.fake.requests.length, avant, "aucune requête au faux de l'instance principale");
    // Le rattrapage de la salle a sa propre clé : celle de l'instance principale n'a pas bougé.
    const cle = (key: string) => h.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    assert.ok(cle("sync.lastAt:omo"), "sync.lastAt:omo posée par le rattrapage de la salle");
  });

  it("les dérivations de l'instance principale ne voient jamais un événement de la salle (origine, T-L18-c)", async (t) => {
    const vus: string[] = [];
    const h = await startCockpit(t, { omo: true, modules: ["facts"] });
    assert.ok(h.omo);
    const detach = h.processor.addDerivation({ name: "temoin", onEvent: (event, origin) => void vus.push(`${event.payload.type}:${origin?.instance ?? "principale"}`) });
    t.after(detach);
    await h.emitOmo(evenement("session.idle", { sessionID: "ses_salle" }));
    assert.deepEqual(vus, [], "le processeur de l'instance principale n'a rien reçu de la salle");
  });
});

// Le test « conflit journalisé » ci-dessus ne prouve que la MÉCANIQUE du tracker : il construit lui-même le SessionTracker
// avec { log }. Ce qui suit prouve le CÂBLAGE — que le cockpit tel qu'il est livré passe bien ce journal, et qu'un
// franchissement de frontière laisse donc une trace chez l'exploitant (fiche L18a : « refusé, JOURNALISÉ, rappel
// onInstanceConflict » ; P11).
describe("L18a : le cockpit RÉEL journalise un conflit d'identifiant entre instances (câblage, P11)", () => {
  it("main.ts construit SessionTracker AVEC son journal", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "main.ts"), "utf8");
    const ligne = source.split("\n").find((l) => l.includes("new SessionTracker(")) ?? "(aucune construction de SessionTracker dans main.ts)";
    assert.match(ligne.trim(), /^const sessions = new SessionTracker\(db, client, \{ log \}\);$/, `sans { log }, un conflit d'instance est refusé mais reste invisible — vu : ${ligne.trim()}`);
  });

  it("session.updated de la salle sur une racine de l'instance principale : une ligne de journal sort du cockpit", async (t) => {
    const lignes: string[] = [];
    // Journal du cockpit détourné vers un tableau : c'est le MÊME objet que main.ts remet à SessionTracker.
    const h = await startCockpit(t, { omo: true, log: createLogger("warn", (ligne) => void lignes.push(ligne)) });
    assert.ok(h.omo);
    h.sessions.upsert(session("ses_meme", { title: "Conversation du cockpit" }));
    const avant = lignes.length;

    await h.emitOmo(evenement("session.updated", { info: session("ses_meme", { title: "Titre imposé par la salle" }) }));

    const refus = lignes.slice(avant).filter((l) => l.includes("session refusée : identifiant déjà suivi par l'autre instance"));
    assert.equal(refus.length, 1, `une ligne de journal attendue, vu : ${JSON.stringify(lignes.slice(avant))}`);
    const ligne = JSON.parse(refus[0] as string) as { level: string; sessionId: string; enregistree: string; refusee: string };
    assert.equal(ligne.level, "warn");
    assert.deepEqual({ sessionId: ligne.sessionId, enregistree: ligne.enregistree, refusee: ligne.refusee }, { sessionId: "ses_meme", enregistree: "principale", refusee: "omo" });
    // Et rien n'a été écrit : le refus reste un refus.
    assert.equal(h.sessions.get("ses_meme")?.title, "Conversation du cockpit");
    assert.equal(h.sessions.get("ses_meme")?.instance, "principale");
  });
});

describe("L18a : bornes du réducteur de faits (T-L18-l)", () => {
  it("rafale de la salle : au plus PENDING_SESSIONS_MAX recherches à la fois, toutes sur le client de la salle", async (t) => {
    const h = await startCockpit(t, { omo: true, modules: ["facts"] });
    assert.equal(ENSURE_TIMEOUT_MS, 5_000);
    let recherches = 0;
    const instances: Array<SessionInstance | undefined> = [];
    const avertissements: string[] = [];
    const sessions = {
      get: (id: string) => h.sessions.get(id),
      ensure: (_id: string, _dir: string | undefined, _depth: number, instance: SessionInstance) => {
        recherches++;
        instances.push(instance);
        return new Promise(() => undefined);
      },
    } as unknown as typeof h.sessions;
    const log = { ...h.deps.log, warn: (message: string) => void avertissements.push(message) };
    const c11: Cockpit11 = { ...h.cockpit.c11, sessions, log };
    let horloge = 2_000_000;
    const derivation = activityDerivation(c11, { instance: "omo", ensureTimeoutMs: 30, now: () => horloge });

    // Rafale synthétique : quatre fois la borne de sessions inconnues, d'un coup.
    for (let i = 0; i < PENDING_SESSIONS_MAX * 4; i++) {
      derivation.onEvent(evenement("session.status", { sessionID: `ses_rafale_${i}`, status: { type: "busy" } }), { instance: "omo" });
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(recherches, PENDING_SESSIONS_MAX, "la file des sessions inconnues est bornée");
    assert.ok(
      instances.every((instance) => instance === "omo"),
      "chaque recherche part sur le client de la salle",
    );
    assert.ok(avertissements.includes("faits d'activité : trop de sessions inconnues, événements non enregistrés"));
    // Horloge injectée (aucune attente réelle) : même passé le délai de nouvelle recherche, la borne tient tant que la file
    // est pleine — la rafale ne fait jamais partir plus de PENDING_SESSIONS_MAX recherches à la fois.
    horloge += 30_000;
    for (let i = 0; i < PENDING_SESSIONS_MAX; i++) {
      derivation.onEvent(evenement("session.status", { sessionID: `ses_rafale_tard_${i}`, status: { type: "busy" } }), { instance: "omo" });
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(recherches, PENDING_SESSIONS_MAX);
    // Aucun fait écrit : aucune de ces sessions n'est connue.
    assert.equal((h.db.prepare("SELECT COUNT(*) AS n FROM activity_facts").get() as { n: number }).n, 0);
  });

  it("rafale sur UNE session inconnue de la salle : au plus PENDING_EVENTS_MAX événements gardés, les suivants abandonnés", async (t) => {
    const h = await startCockpit(t, { omo: true, modules: ["facts"] });
    const ligne = {
      id: "ses_borne",
      parent_id: null,
      root_id: "ses_borne",
      directory: "/workspace/app",
      project_id: null,
      title: "Racine de la salle",
      purpose: "chat",
      agent: null,
      plancher: null,
      instance: "omo",
      created_at: T,
      updated_at: T,
      deleted_at: null,
    } as const;
    let connue = false;
    const sessions = {
      get: (id: string) => (connue && id === "ses_borne" ? ligne : h.sessions.get(id)),
      ensure: async () => {
        connue = true;
        return ligne;
      },
    } as unknown as typeof h.sessions;
    const c11: Cockpit11 = { ...h.cockpit.c11, sessions };
    const derivation = activityDerivation(c11, { instance: "omo" });

    // Chaque événement porte un nombre de tâches DIFFÉRENT : un fait distinct par événement gardé, donc un compte exact.
    const envoyes = PENDING_EVENTS_MAX + 20;
    for (let i = 0; i < envoyes; i++) {
      const todos = Array.from({ length: i + 1 }, () => ({ status: "pending" }));
      derivation.onEvent(evenement("todo.updated", { sessionID: "ses_borne", todos }), { instance: "omo" });
    }
    await until(() => connue, 2_000);
    await new Promise((resolve) => setImmediate(resolve));
    const faits = (h.db.prepare("SELECT COUNT(*) AS n FROM activity_facts WHERE root_id = ?").get("ses_borne") as { n: number }).n;
    assert.equal(faits, PENDING_EVENTS_MAX, `${envoyes} événements envoyés, ${PENDING_EVENTS_MAX} gardés`);
  });

  it("une dérivation de la salle écarte un événement d'origine principale, et inversement", async (t) => {
    const h = await startCockpit(t, { omo: true, modules: ["facts"] });
    const racine = h.sessions.upsert(session("ses_racine_salle"), undefined, { instance: "omo" });
    assert.equal(racine.instance, "omo");
    const salle = activityDerivation(h.cockpit.c11, { instance: "omo" });
    const cockpit = activityDerivation(h.cockpit.c11);
    const faits = () => (h.db.prepare("SELECT COUNT(*) AS n FROM activity_facts WHERE root_id = ?").get("ses_racine_salle") as { n: number }).n;
    // Origine « principale » sur la dérivation de la salle : écarté.
    salle.onEvent(evenement("session.status", { sessionID: "ses_racine_salle", status: { type: "busy" } }));
    // Session de la salle sur la dérivation du cockpit : écartée elle aussi (la session n'est pas la sienne).
    cockpit.onEvent(evenement("session.status", { sessionID: "ses_racine_salle", status: { type: "busy" } }), { instance: "principale" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(faits(), 0);
    // Même événement, bonne origine : le fait est écrit.
    salle.onEvent(evenement("session.status", { sessionID: "ses_racine_salle", status: { type: "busy" } }), { instance: "omo" });
    assert.equal(faits(), 1);
  });
});
