// Répondeur de la Salle OMO (L22d ; spécification §4.14.3 l.825-832, §4.2 l.603-604, §4.3 l.620 et l.634, G7 l.1221, JS-6 ; plan
// 2 bis et 2 ter §6 fiche L22d) : T-L22-a (corpus G7 de L22b rejoué : AUCUN « once » sur un interdit), T-L22-b (refus retenu tant
// qu'une autre demande de la session attend), inscription au registre AVANT l'envoi, aucune demande de l'instance principale
// répondue, journal `autonomy_decisions`, phrases du répondeur.
//
// Deux étages, tous dans `npm test` :
// 1. la fabrique sur un `c11` minimal, portillon de la salle en ESPION : une garde par test (origine, instance de la session et de
//    la racine, ligne `omo_rooms`, demande active, salle coupée, doublon, projet douteux), corpus entier en quelques millisecondes ;
// 2. le cockpit réel avec l'option `omo` du harnais : second faux opencode, processeur et portillon RÉELS de la salle. Le corpus
//    y est rejoué demande par demande (une délégation par cas, toutes en parallèle), chaque réponse relevée à son arrivée sur le
//    faux, avec l'état du registre à cet instant. `SALLE_OUVERTE` reste fausse : un module factice au nom réel pose la VRAIE
//    fabrique (`installOmoResponder`), sans la porte.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { Cockpit11, Cockpit11Module, PermissionGate, Registrar } from "./contracts-11.ts";
import { openMemoryDb } from "./db.ts";
import { EventHub } from "./hub.ts";
import { createLogger } from "./log.ts";
import type { OmoActiveRequest, OmoActivationPort, OmoPrecheckPort } from "./omo-contracts.ts";
import {
  createOmoResponder,
  installOmoResponder,
  lireDemandeSalle,
  messageInterdit,
  neutralOmoResponder,
  OMO_CHOIX_JOURNAL,
  OMO_REGLE_AUCUN_INTERDIT,
  omoResponderModule,
} from "./omo-responder.ts";
import type { OcSession, OpencodeClient } from "./opencode.ts";
import { SessionTracker } from "./sessions.ts";
import type { ActivityFact } from "./shared/activity-types.ts";
import type { RelayOutcome } from "./shared/autonomy-types.ts";
import { libelleInterdit, TEXTES } from "./shared/omo-room-texts.ts";
import type { OmoForbiddenCategory } from "./shared/omo-types.ts";
import { startCockpit } from "./test-support/cockpit-harness.ts";
import type { FakeToolScript } from "./test-support/fake-opencode.ts";
import { until } from "./test-support/helpers.ts";
import { SALLE_OUVERTE } from "./wiring-11.ts";

// --- Corpus G7 de L22b --------------------------------------------------------------------------------------------------------------

interface CorpusCas {
  nom: string;
  demande: { permission: string; metadata: Record<string, unknown> };
  attendu: { verdict: "once" | "interdit"; categorie?: OmoForbiddenCategory };
}

const CORPUS = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "test-support", "fixtures", "omo-forbidden-corpus.json"), "utf8"),
) as { projetOuvert: string; ideCiDynamiques: string[]; cas: CorpusCas[] };

/** Le corpus de L22b est écrit pour `/workspace/projet` : le dossier de travail de la salle est `/workspace`, le projet « projet ». */
const WORKSPACE = "/workspace";
const PROJET = "projet";
const DOSSIER = `${WORKSPACE}/${PROJET}`;
const MODEL = { providerID: "github-copilot", modelID: "gpt-5-mini" };

/** Relevés du pré-contrôle (L19b) : les cibles de la configuration git du projet ouvert, celles du corpus. */
const REFERENCES = {
  startId: "dem_1",
  at: 1,
  releves: [
    { racine: PROJET, ideCiDynamiques: CORPUS.ideCiDynamiques },
    { racine: "autre-projet", ideCiDynamiques: [] },
  ],
};

const precheckAvecReferences = (): OmoPrecheckPort & { references(): unknown } => ({
  check: async () => ({ ok: false, code: "salle-coupee" }),
  beforeStart: async (startId) => ({ ok: false, startId, code: "salle-coupee", resultats: [] }),
  references: () => REFERENCES,
});

// --- Banc unitaire ---------------------------------------------------------------------------------------------------------------

interface Appel {
  quoi: "once" | "reject";
  id: string;
  session?: string;
  dossier: string | null;
  message?: string;
  par: string;
}

interface OptionsBanc {
  /** Sort rendu par le portillon espion. */
  sort?: RelayOutcome | "retenu";
  /** Salle coupée : `instances.omo` à null. */
  salleCoupee?: boolean;
}

function banc(options: OptionsBanc = {}) {
  const db = openMemoryDb();
  const principal = {
    request: async () => {
      throw new Error("l'instance principale ne doit jamais être interrogée pour la salle");
    },
  } as unknown as OpencodeClient;
  const lecturesSalle: string[] = [];
  const sessionsSalle = new Map<string, OcSession>();
  const clientSalle = {
    request: async (_method: string, pathname: string) => {
      lecturesSalle.push(pathname);
      const id = decodeURIComponent(pathname.split("/")[2] ?? "");
      const session = sessionsSalle.get(id);
      if (!session) throw new Error("session inconnue de la salle");
      return session;
    },
  } as unknown as OpencodeClient;
  const sessions = new SessionTracker(db, principal);
  sessions.useClient("omo", clientSalle);
  const appels: Appel[] = [];
  const gate = {
    relayOnce: async (id: string, dossier: string | null, par: string) => {
      appels.push({ quoi: "once", id, dossier, par });
      return options.sort ?? "ok";
    },
    rejectWhenAlone: async (id: string, session: string, dossier: string | null, message: string, par: string) => {
      appels.push({ quoi: "reject", id, session, dossier, message, par });
      return options.sort ?? "ok";
    },
  } as unknown as PermissionGate;
  const etat = { demande: null as OmoActiveRequest | null };
  const faits: ActivityFact[] = [];
  const attentes: string[] = [];
  const hub = new EventHub();
  const evenements: Array<{ type: string; instance?: string; data: unknown }> = [];
  hub.subscribe((e) => {
    if (e.kind === "cockpit") evenements.push({ type: e.type, instance: e.instance, data: e.data });
  });
  const c11 = {
    db,
    sessions,
    hub,
    log: createLogger("error"),
    env: { workspaceDir: WORKSPACE },
    instances: { omo: options.salleCoupee ? null : { gate } },
    ports: {
      omoActivation: { activeRequest: () => etat.demande } satisfies Pick<OmoActivationPort, "activeRequest">,
      omoPrecheck: precheckAvecReferences(),
      facts: {
        append: (f: ActivityFact[]) => void faits.push(...f),
        work: { markWait: (w: { permissionId: string }, e: string, par: string) => (attentes.push(`${w.permissionId}:${e}:${par}`), true) },
      },
    },
  } as unknown as Cockpit11;
  const service = createOmoResponder(c11);
  const session = (id: string, instance: "omo" | "principale", parentID?: string) =>
    sessions.upsert({ id, projectID: "p", directory: DOSSIER, title: id, time: { created: 1, updated: 1 }, ...(parentID ? { parentID } : {}) }, undefined, { instance });
  const salle = (rootId: string, projet = PROJET) => db.prepare("INSERT INTO omo_rooms (root_id, projet, created_at) VALUES (?, ?, ?)").run(rootId, projet, 1);
  const activer = (rootId: string) => {
    etat.demande = { rootId, requestId: "req_1", startedAt: 1, plafondUsd: "1" };
  };
  let seq = 0;
  /** Publie une demande d'autorisation (`permission.asked`) et attend la fin de sa réponse. */
  const demander = async (
    sessionId: string,
    demande: { permission: string; metadata: Record<string, unknown> },
    /** null : événement SANS origine (processeur 1.0.x, lu comme l'instance principale). */
    origin: { instance: "omo" | "principale" } | null = { instance: "omo" },
  ): Promise<string> => {
    const id = `per_${++seq}`;
    service.derivation.onEvent(
      { directory: DOSSIER, payload: { id: `evt_${seq}`, type: "permission.asked", properties: { id, sessionID: sessionId, patterns: ["*"], always: ["*"], ...demande, tool: { messageID: "msg_1", callID: `call_${seq}` } } } },
      origin ?? undefined,
    );
    await service.settled();
    return id;
  };
  const decisions = () =>
    (db.prepare("SELECT request_id, root_id, session_id, permission_id, permission, choix, regle, verdict, par, raison, relais FROM autonomy_decisions ORDER BY id").all() as Array<Record<string, unknown>>).map((row) => ({ ...row }));
  // Racine de salle ouverte, enfant de délégation, et une racine de l'instance PRINCIPALE (avec une ligne omo_rooms piégée).
  session("ses_racine", "omo");
  session("ses_enfant", "omo", "ses_racine");
  salle("ses_racine");
  return { db, sessions, sessionsSalle, lecturesSalle, appels, etat, faits, attentes, evenements, c11, service, session, salle, activer, demander, decisions };
}

const BASH_ENV = { permission: "bash", metadata: { command: "cat .env" } };
const BASH_OK = { permission: "bash", metadata: { command: "npm test" } };

describe("L22d : répondeur de la salle, corpus G7 et gardes (portillon espion)", () => {
  it("T-L22-a (fabrique) : chaque cas du corpus → « once » par relayOnce ou refus par rejectWhenAlone avec sa catégorie ; AUCUN « once » sur un interdit", async () => {
    const b = banc();
    b.activer("ses_racine");
    assert.ok(CORPUS.cas.length >= 40);
    const attendus = new Map<string, CorpusCas>();
    for (const cas of CORPUS.cas) attendus.set(await b.demander("ses_enfant", cas.demande), cas);
    assert.equal(b.appels.length, CORPUS.cas.length, "une réponse par demande, jamais deux");
    for (const appel of b.appels) {
      const cas = attendus.get(appel.id);
      assert.ok(cas);
      assert.equal(appel.dossier, DOSSIER, cas.nom);
      assert.equal(appel.par, "cockpit", cas.nom);
      if (cas.attendu.verdict === "once") {
        assert.equal(appel.quoi, "once", cas.nom);
      } else {
        assert.equal(appel.quoi, "reject", `${cas.nom} : un interdit n'est JAMAIS relayé « once »`);
        assert.equal(appel.session, "ses_enfant", cas.nom);
        assert.equal(appel.message, messageInterdit(cas.attendu.categorie as OmoForbiddenCategory), cas.nom);
      }
    }
    const interdits = CORPUS.cas.filter((cas) => cas.attendu.verdict === "interdit").length;
    assert.equal(b.appels.filter((a) => a.quoi === "reject").length, interdits);
    // Journal : une ligne par décision, choix « omo », par « regles », règle = catégorie ou « aucun-interdit ».
    const lignes = b.decisions();
    assert.equal(lignes.length, CORPUS.cas.length);
    for (const ligne of lignes) {
      const cas = attendus.get(String(ligne.permission_id));
      assert.ok(cas);
      assert.equal(ligne.choix, OMO_CHOIX_JOURNAL);
      assert.equal(ligne.par, "regles");
      assert.equal(ligne.root_id, "ses_racine");
      assert.equal(ligne.request_id, "req_1");
      assert.equal(ligne.relais, "ok");
      if (cas.attendu.verdict === "once") {
        assert.deepEqual([ligne.verdict, ligne.regle], ["auto", OMO_REGLE_AUCUN_INTERDIT], cas.nom);
        assert.equal(ligne.raison, TEXTES.avance.activation.autorise.replace("{projet}", PROJET));
      } else {
        assert.deepEqual([ligne.verdict, ligne.regle, ligne.raison], ["refus-interdit", cas.attendu.categorie, ""], cas.nom);
      }
    }
    assert.equal(b.faits.filter((f) => f.kind === "decision").length, CORPUS.cas.length);
  });

  it("origine : une demande sans origine « omo » (instance principale, origine absente) n'est jamais répondue", async () => {
    const b = banc();
    b.activer("ses_racine");
    await b.demander("ses_enfant", BASH_OK, { instance: "principale" });
    await b.demander("ses_enfant", BASH_OK, null);
    assert.deepEqual([b.appels, b.decisions()], [[], []]);
    await b.demander("ses_enfant", BASH_OK);
    assert.equal(b.appels.length, 1, "témoin : la même demande, venue de la salle, est répondue");
  });

  it("aucune racine principale touchée : session ou racine suivies pour l'instance principale → rien, même avec une ligne omo_rooms", async () => {
    const b = banc();
    b.session("ses_principale", "principale");
    b.session("ses_principale_enfant", "principale", "ses_principale");
    b.salle("ses_principale");
    b.activer("ses_principale");
    await b.demander("ses_principale", BASH_OK);
    await b.demander("ses_principale_enfant", BASH_OK);
    assert.deepEqual([b.appels, b.decisions()], [[], []]);
    // Une session de la salle rattachée à une racine principale (conflit d'identifiant) : rien non plus.
    b.session("ses_salle_orpheline", "omo", "ses_principale");
    await b.demander("ses_salle_orpheline", BASH_OK);
    // Et une session de l'instance principale rattachée à une racine de la SALLE (identifiant forgé) : jamais répondue.
    b.activer("ses_racine");
    b.session("ses_principale_sous_salle", "principale", "ses_racine");
    await b.demander("ses_principale_sous_salle", BASH_OK);
    assert.deepEqual(b.appels, []);
  });

  it("racine sans ligne omo_rooms (pas ouverte par POST /api/omo/rooms), ou projet douteux → rien", async () => {
    const b = banc();
    b.session("ses_hors_salle", "omo");
    b.activer("ses_hors_salle");
    await b.demander("ses_hors_salle", BASH_OK);
    assert.deepEqual(b.appels, []);
    for (const projet of ["../autre", "/workspace/projet", "C:/projet", "."]) {
      const racine = `ses_projet_${b.appels.length}_${projet.length}`;
      b.session(racine, "omo");
      b.salle(racine, projet);
      b.activer(racine);
      await b.demander(racine, BASH_OK);
      assert.deepEqual(b.appels, [], projet);
    }
  });

  it("demande active : aucune, ou celle d'une autre racine → rien ; celle de la racine → répondue", async () => {
    const b = banc();
    await b.demander("ses_enfant", BASH_OK);
    b.session("ses_autre", "omo");
    b.salle("ses_autre");
    b.activer("ses_autre");
    await b.demander("ses_enfant", BASH_OK);
    assert.deepEqual(b.appels, []);
    b.activer("ses_racine");
    await b.demander("ses_enfant", BASH_OK);
    assert.equal(b.appels.length, 1);
  });

  it("salle coupée (aucune instance de la salle) → rien ; demande reçue deux fois → une seule réponse", async () => {
    const coupee = banc({ salleCoupee: true });
    coupee.activer("ses_racine");
    await coupee.demander("ses_enfant", BASH_OK);
    // Session inconnue, salle coupée : aucune recherche nulle part (sans client de la salle, elle partirait vers l'instance principale).
    coupee.sessionsSalle.set("ses_neuve", { id: "ses_neuve", parentID: "ses_racine", projectID: "p", directory: DOSSIER, title: "neuve", time: { created: 1, updated: 1 } });
    await coupee.demander("ses_neuve", BASH_OK);
    assert.deepEqual([coupee.appels, coupee.decisions(), coupee.lecturesSalle], [[], [], []]);

    const b = banc();
    b.activer("ses_racine");
    const evenement = { directory: DOSSIER, payload: { id: "evt_x", type: "permission.asked", properties: { id: "per_x", sessionID: "ses_enfant", ...BASH_ENV } } };
    b.service.derivation.onEvent(evenement, { instance: "omo" });
    b.service.derivation.onEvent(evenement, { instance: "omo" });
    await b.service.settled();
    assert.deepEqual(b.appels.map((a) => `${a.quoi}:${a.id}`), ["reject:per_x"]);
  });

  it("nom de permission d'un outil d'extension (majuscules, tiret) : lu et jugé ; nom illisible : laissé sans réponse", async () => {
    const b = banc();
    b.activer("ses_racine");
    await b.demander("ses_enfant", { permission: "Context7_resolve-library-id", metadata: {} });
    await b.demander("ses_enfant", { permission: "WebFetch", metadata: { url: "https://exemple.test" } });
    await b.demander("ses_enfant", { permission: "per mission", metadata: {} });
    await b.demander("ses_enfant", { permission: "x".repeat(129), metadata: {} });
    assert.deepEqual(b.appels.map((a) => a.quoi), ["once", "reject"]);
    assert.equal(b.appels[1]?.message, messageInterdit("web"));
    assert.deepEqual(b.decisions().map((l) => l.permission), ["Context7_resolve-library-id", "WebFetch"]);
    assert.equal(lireDemandeSalle({ id: "per_1", sessionID: "ses_1", permission: "bash" }, null)?.permission, "bash");
    assert.equal(lireDemandeSalle({ id: "per 1", sessionID: "ses_1", permission: "Outil-X" }, null), null);
  });

  it("session inconnue : cherchée sur le serveur de la SALLE (jamais l'instance principale), puis répondue", async () => {
    const b = banc();
    b.activer("ses_racine");
    b.sessionsSalle.set("ses_neuve", { id: "ses_neuve", parentID: "ses_racine", projectID: "p", directory: DOSSIER, title: "neuve", time: { created: 1, updated: 1 } });
    await b.demander("ses_neuve", BASH_ENV);
    assert.deepEqual(b.lecturesSalle, ["/session/ses_neuve"]);
    assert.deepEqual(b.appels.map((a) => a.quoi), ["reject"]);
    assert.equal(b.sessions.get("ses_neuve")?.instance, "omo");
  });

  it("refus retenu jusqu'à sa borne : journal « refus-interdit » sans relais, aucune attente close ; « once » parti : attente close par le cockpit", async () => {
    const retenu = banc({ sort: "retenu" });
    retenu.activer("ses_racine");
    await retenu.demander("ses_enfant", BASH_ENV);
    assert.deepEqual(retenu.decisions().map((l) => [l.verdict, l.regle, l.relais]), [["refus-interdit", "env", null]]);
    assert.deepEqual(retenu.attentes, []);

    const b = banc();
    b.activer("ses_racine");
    const once = await b.demander("ses_enfant", BASH_OK);
    const refus = await b.demander("ses_enfant", BASH_ENV);
    assert.deepEqual(b.attentes, [`${once}:once:cockpit`, `${refus}:reject:cockpit`]);
  });

  it("événement « autonomie.decision » étiqueté « omo » (jamais envoyé en mode Simple), sans texte de message", async () => {
    const b = banc();
    b.activer("ses_racine");
    const id = await b.demander("ses_enfant", BASH_ENV);
    assert.deepEqual(b.evenements, [
      {
        type: "autonomie.decision",
        instance: "omo",
        data: { rootId: "ses_racine", sessionId: "ses_enfant", permissionId: id, verdict: "refus-interdit", regle: "env", raison: "", par: "regles" },
      },
    ]);
  });

  it("phrases du répondeur : celles du module de textes (test « textes »), catégorie en clair, sans gabarit restant", () => {
    const categories = Object.keys(TEXTES.avance.interdits.categories) as OmoForbiddenCategory[];
    assert.ok(categories.length >= 11);
    for (const categorie of categories) {
      const message = messageInterdit(categorie);
      assert.equal(message, `Interdit absolu du cockpit : ${libelleInterdit(categorie)}. N'essayez pas de le contourner.`);
      assert.doesNotMatch(message, /[{}]/);
    }
    assert.doesNotMatch(TEXTES.avance.activation.autorise.replace("{projet}", PROJET), /[{}]/);
  });

  it("câblage : SALLE_OUVERTE fausse → aucune inscription ; ouverte → la seule dérivation « omoResponder » de la salle ; port neutre inchangé", () => {
    assert.equal(SALLE_OUVERTE, false);
    const inscriptions: string[] = [];
    const reg = {
      derivation: (d: { name: string; instances?: readonly string[] }) => inscriptions.push(`${d.name} ${d.instances?.join(",")}`),
      hook: () => inscriptions.push("hook"),
      hub: () => inscriptions.push("hub"),
      startup: () => inscriptions.push("startup"),
      routes: () => inscriptions.push("routes"),
    } as unknown as Registrar;
    const b = banc();
    omoResponderModule.install(reg, { ...b.c11, salleOuverte: false });
    assert.deepEqual(inscriptions, []);
    omoResponderModule.install(reg, { ...b.c11, salleOuverte: true });
    assert.deepEqual(inscriptions, ["omoResponder omo"]);
    assert.deepEqual(neutralOmoResponder(b.c11), {});
  });
});

// --- Cockpit réel ------------------------------------------------------------------------------------------------------------------

/** Module factice au nom réel : la VRAIE fabrique, sans la porte SALLE_OUVERTE (fausse dans le dépôt). */
const moduleRepondeur: Cockpit11Module = {
  name: "omoResponder",
  install(reg, c11) {
    installOmoResponder(reg, c11, { workspace: WORKSPACE });
  },
};

interface Envoi {
  id: string;
  reply: unknown;
  message: unknown;
  /** La réponse était inscrite au registre du portillon de la salle quand l'envoi est parti (JS-6). */
  inscrite: boolean;
}

/** Cockpit réel avec la salle : second faux opencode, portillon réel de la salle observé à chaque réponse envoyée. */
async function salleReelle(t: TestContext) {
  const etat: { demande: OmoActiveRequest | null } = { demande: null };
  const omoActivation: OmoActivationPort = {
    view: async () => null,
    put: async () => ({ ok: false, status: 409, code: "salle-coupee" }),
    consume: async () => ({ ok: false, code: "salle-coupee" }),
    activeRequest: () => etat.demande,
    endRequest: () => undefined,
  };
  const h = await startCockpit(t, { omo: true, modules: ["gate", moduleRepondeur], ports: { omoActivation, omoPrecheck: precheckAvecReferences() } });
  const salle = h.omo;
  assert.ok(salle);
  // Chaque réponse envoyée au faux de la salle est relevée au moment de l'envoi, avec l'état du registre (P9, JS-6).
  const envois: Envoi[] = [];
  const client = salle.deps.client;
  const requete = client.request.bind(client);
  client.request = (async (method: string, pathname: string, options?: Parameters<OpencodeClient["request"]>[2]) => {
    const id = method === "POST" ? /^\/permission\/([^/]+)\/reply$/.exec(pathname)?.[1] : undefined;
    if (id !== undefined) {
      const decode = decodeURIComponent(id);
      const corps = (options?.body ?? {}) as { reply?: unknown; message?: unknown };
      envois.push({ id: decode, reply: corps.reply, message: corps.message, inscrite: salle.deps.gate.emitted.has(decode) });
    }
    return requete(method, pathname, options);
  }) as OpencodeClient["request"];
  const racine = await salle.deps.client.request<OcSession>("POST", "/session", { directory: DOSSIER, body: { title: PROJET } });
  h.sessions.upsert(racine, undefined, { instance: "omo" });
  h.db.prepare("INSERT INTO omo_rooms (root_id, projet, created_at) VALUES (?, ?, ?)").run(racine.id, PROJET, Date.now());
  etat.demande = { rootId: racine.id, requestId: "req_1", startedAt: Date.now(), plafondUsd: "1" };
  /** Délégation de la racine (session enfant de la salle), suivie par le cockpit. */
  const enfant = async (titre: string): Promise<OcSession> => {
    const session = await salle.deps.client.request<OcSession>("POST", "/session", { directory: DOSSIER, body: { title: titre, parentID: racine.id } });
    h.sessions.upsert(session, undefined, { instance: "omo" });
    return session;
  };
  const lancer = (sessionId: string, tools: FakeToolScript[]) => {
    salle.fake.script(sessionId, { tools, followUp: { text: "fin" } });
    return salle.deps.client.request("POST", `/session/${sessionId}/prompt_async`, { directory: DOSSIER, body: { model: MODEL, parts: [{ type: "text", text: "Travaille." }] } });
  };
  /** Demande d'autorisation publiée par le faux de la salle pour cette session, dans l'ordre. */
  const demandes = (sessionId: string) =>
    salle.fake.emitted
      .map((w) => w.payload)
      .filter((p): p is { type: string; properties: Record<string, unknown> } => "properties" in p && p.type === "permission.asked" && p.properties.sessionID === sessionId)
      .map((p) => String(p.properties.id));
  return { h, salle, racine, etat, envois, enfant, lancer, demandes };
}

const outil = (demande: { permission: string; metadata: Record<string, unknown> }, extra: Partial<FakeToolScript> = {}): FakeToolScript => ({
  tool: "bash",
  input: {},
  ask: { permission: demande.permission, patterns: ["*"], metadata: demande.metadata },
  output: "ok",
  ...extra,
});

describe("L22d : répondeur sur le cockpit réel (processeur et portillon de la salle, second faux opencode)", () => {
  it("T-L22-a sur le faux : corpus G7 rejoué, une délégation par cas ; AUCUN « once » sur un interdit ; chaque réponse inscrite au registre AVANT l'envoi", async (t: TestContext) => {
    const s = await salleReelle(t);
    const parCas = new Map<string, CorpusCas>();
    await Promise.all(
      CORPUS.cas.map(async (cas, index) => {
        const session = await s.enfant(`cas-${index}`);
        parCas.set(session.id, cas);
        await s.lancer(session.id, [outil(cas.demande)]);
      }),
    );
    await until(() => s.envois.length >= CORPUS.cas.length, 15_000);
    assert.equal(s.envois.length, CORPUS.cas.length, "une réponse par demande, jamais deux");
    const reponses = new Map(s.envois.map((e) => [e.id, e]));
    for (const [sessionId, cas] of parCas) {
      const [id] = s.demandes(sessionId);
      assert.ok(id, cas.nom);
      const envoi = reponses.get(id);
      assert.ok(envoi, `${cas.nom} : aucune réponse`);
      assert.equal(envoi.inscrite, true, `${cas.nom} : réponse non inscrite au registre avant l'envoi`);
      if (cas.attendu.verdict === "once") {
        assert.deepEqual([envoi.reply, envoi.message], ["once", undefined], cas.nom);
      } else {
        assert.equal(envoi.reply, "reject", `${cas.nom} : un interdit n'est JAMAIS relayé « once »`);
        assert.equal(envoi.message, messageInterdit(cas.attendu.categorie as OmoForbiddenCategory), cas.nom);
      }
    }
    assert.equal(s.envois.filter((e) => e.reply === "once").length, CORPUS.cas.filter((c) => c.attendu.verdict === "once").length);
    assert.deepEqual(s.envois.filter((e) => e.reply !== "once" && e.reply !== "reject"), [], "jamais « always »");
    // Journal : une ligne par demande, et l'instance principale n'a rien reçu.
    await until(() => (s.h.db.prepare("SELECT COUNT(*) AS n FROM autonomy_decisions").get() as { n: number }).n >= CORPUS.cas.length);
    assert.deepEqual(s.h.fake.requests.filter((r) => r.pathname.startsWith("/permission/")), []);
  });

  it("T-L22-b : refus d'un interdit RETENU tant qu'un autre appel de la session peut encore demander ; parti seul, après le « once » voisin", async (t: TestContext) => {
    const s = await salleReelle(t);
    const session = await s.enfant("retenu");
    let libere: () => void = () => undefined;
    const voisin = new Promise<void>((resolve) => {
      libere = resolve;
    });
    await s.lancer(session.id, [outil(BASH_ENV, { callID: "call_interdit" }), outil(BASH_OK, { callID: "call_voisin", beforeAsk: () => voisin })]);
    const [interdit] = await until(() => {
      const ids = s.demandes(session.id);
      return ids.length >= 1 ? ids : null;
    });
    assert.ok(interdit);
    // L'appel voisin est « en cours » sans demande : le refus attend (un refus d'opencode emporterait sa demande à venir).
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(s.envois.length, 0, "refus retenu : rien n'est parti");
    libere();
    await until(() => s.envois.length >= 2, 5_000);
    const [premier, second] = s.envois;
    assert.equal(premier?.reply, "once", "le voisin autorisé passe d'abord");
    assert.deepEqual([second?.id, second?.reply, second?.message], [interdit, "reject", messageInterdit("env")]);
    assert.ok(s.envois.every((e) => e.inscrite));
  });

  it("aucune demande de l'instance principale répondue : ni le faux principal ni celui de la salle ne reçoivent de réponse", async (t: TestContext) => {
    const s = await salleReelle(t);
    const principale = await s.h.deps.client.request<OcSession>("POST", "/session", { body: { title: "principale" } });
    s.h.fake.script(principale.id, { tools: [outil(BASH_ENV), outil(BASH_OK)], followUp: { text: "fin" } });
    await s.h.deps.client.request("POST", `/session/${principale.id}/prompt_async`, { body: { model: MODEL, parts: [{ type: "text", text: "Travaille." }] } });
    await until(() => s.h.fake.pendingPermissions().filter((p) => p.sessionID === principale.id).length === 2);
    await s.h.processor.settled();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(s.h.fake.requests.filter((r) => r.method === "POST" && r.pathname.startsWith("/permission/")), []);
    assert.equal(s.h.fake.pendingPermissions().filter((p) => p.sessionID === principale.id).length, 2, "les demandes attendent l'utilisateur");
    assert.deepEqual(s.envois, []);
    assert.equal((s.h.db.prepare("SELECT COUNT(*) AS n FROM autonomy_decisions").get() as { n: number }).n, 0);
  });
});

