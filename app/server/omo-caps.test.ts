// Plafonds et fin de demande de la Salle OMO (L22d ; spécification §4.8.2 l.718-732, §4.14.3 l.832, G6 l.1220, JS-11, P5 ; plan
// 2 bis et 2 ter §6 fiche L22d, D-2b-29) : T-L22-c (plafond de coût atteint → omoStop), T-L22-k (durée 60 min, plus de 30 sessions,
// seuils mensuels 80 % et 100 %), guardRuns sur le message de l'utilisateur, guard-state.json écrit au plafond et lu par le filet
// de L24 (vecteurs de L17a), fin de demande (15 s au repos → endRequest puis relaunchAfterRequest ; tâche de fond ouverte →
// aucune fin), honnêteté des textes.
//
// Deux étages, tous dans `npm test`, sans conteneur ni attente réelle des délais :
// 1. la fabrique sur un `c11` minimal, HORLOGE INJECTÉE (60 minutes et 15 secondes franchies sans attendre), ports voisins en
//    espions (omoActivation de L22c, omoStop de L23b, omoControl de L17b) ;
// 2. le cockpit réel avec l'option `omo` du harnais (second faux opencode, processeur réel de la salle) : le coût d'un tour de la
//    salle remonte par `usage.updated` jusqu'à l'arrêt, et la fin de demande relit la salle par son portillon. `SALLE_OUVERTE`
//    reste fausse : un module factice au nom réel pose la VRAIE fabrique (`installOmoCaps`), sans la porte.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import * as garde from "../../docker/opencode-omo/guard/cockpit-guard.js";
import type { Cockpit11, Cockpit11Module, ProxyContext, Registrar } from "./contracts-11.ts";
import { openMemoryDb } from "./db.ts";
import { EventHub } from "./hub.ts";
import { createLogger } from "./log.ts";
import {
  createOmoCaps,
  installOmoCaps,
  modeleDuMessage,
  neutralOmoCaps,
  OMO_DUREE_MS,
  OMO_FIN_REPOS_MS,
  OMO_SEUILS_MENSUELS,
  omoCapsModule,
  plafondEnMicros,
} from "./omo-caps.ts";
import type { OmoActiveRequest, OmoActivationPort, OmoControlPort, OmoStopPort } from "./omo-contracts.ts";
import { createOmoControl, type OmoControlClock } from "./omo-control.ts";
import type { OcGlobalEvent, OcSession, OpencodeClient } from "./opencode.ts";
import { SessionTracker } from "./sessions.ts";
import type { StopResult } from "./shared/cockpit-event-types.ts";
import { analyserGuardState, ecrireGuardState, OMO_FICHIERS_CONTROLE } from "./shared/omo-control-protocol.ts";
import { OMO_LIMITES } from "./shared/omo-limits.ts";
import { phraseArret, phraseRefusActivation } from "./shared/omo-room-texts.ts";
import type { OmoGuardState, OmoStopCause } from "./shared/omo-types.ts";
import { startCockpit } from "./test-support/cockpit-harness.ts";
import { until } from "./test-support/helpers.ts";
import { SALLE_OUVERTE } from "./wiring-11.ts";

const T0 = 1_757_000_000_000;
const RACINE = "ses_racine";
const DOSSIER = "/workspace/projet";
const MODEL = { providerID: "github-copilot", modelID: "gpt-5-mini" };
const ARRET: StopResult = { rootId: RACINE, rejected: 0, aborted: [], unconfirmed: [], durationMs: 0 };

// --- Horloge simulée -------------------------------------------------------------------------------------------------------------

/** Minuteries déclenchées par `avancer`, jamais par le temps réel. */
function fausseHorloge(depart = T0) {
  let maintenant = depart;
  let seq = 0;
  const minuteries = new Map<number, { fn: () => void; echeance: number }>();
  const clock: OmoControlClock = {
    now: () => maintenant,
    setTimer: (fn, ms) => {
      seq++;
      minuteries.set(seq, { fn, echeance: maintenant + ms });
      return seq;
    },
    clearTimer: (handle) => void minuteries.delete(handle as number),
  };
  return {
    clock,
    maintenant: () => maintenant,
    enAttente: () => minuteries.size,
    /** Avance de `ms`, en déclenchant dans l'ordre chaque minuterie échue. */
    avancer(ms: number) {
      const fin = maintenant + ms;
      for (;;) {
        const due = [...minuteries.entries()].filter(([, m]) => m.echeance <= fin).sort((a, b) => a[1].echeance - b[1].echeance)[0];
        if (!due) break;
        minuteries.delete(due[0]);
        maintenant = Math.max(maintenant, due[1].echeance);
        due[1].fn();
      }
      maintenant = fin;
    },
  };
}

// --- Banc unitaire ---------------------------------------------------------------------------------------------------------------

interface OptionsBanc {
  plafondUsd?: string;
  pourcent?: number;
  /** Refus du garde-fou budgétaire (guardRuns). */
  refusBudget?: boolean;
  /** Lecture de la salle par son portillon : sessions occupées, demandes en attente, ou échec. */
  salleOccupee?: string[];
  salleAttentes?: string[];
  salleIllisible?: boolean;
}

function banc(options: OptionsBanc = {}) {
  const horloge = fausseHorloge();
  const db = openMemoryDb();
  const client = {
    request: async () => {
      throw new Error("aucune lecture d'opencode attendue");
    },
  } as unknown as OpencodeClient;
  const sessions = new SessionTracker(db, client);
  sessions.upsert({ id: RACINE, projectID: "p", directory: DOSSIER, title: "projet", time: { created: T0, updated: T0 } }, undefined, { instance: "omo" });
  /** Appels des ports voisins, dans l'ordre. */
  const journal: string[] = [];
  const etats: OmoGuardState[] = [];
  const gardes: Array<{ models: string[]; confirmed: boolean }> = [];
  const etat = {
    demande: null as OmoActiveRequest | null,
    depense: 0 as number | (() => number),
    pourcent: options.pourcent ?? 50,
    refusBudget: options.refusBudget ?? false,
    salleOccupee: options.salleOccupee ?? [],
    salleAttentes: options.salleAttentes ?? [],
    salleIllisible: options.salleIllisible ?? false,
    lecturesSalle: 0,
    /** Appelé une fois pendant la prochaine lecture de la salle (un événement du flux arrive pendant qu'elle est relue). */
    pendantLecture: null as (() => void) | null,
  };
  /**
   * La salle telle que son portillon la relit (relecture 2ter-vague-4) : d'office, une salle qui tient parole — ce que son flux a
   * dit (`emit` d'origine « omo »), plus `salleOccupee` et `salleAttentes`. `sansEvenement` la change SANS rien émettre : un
   * événement perdu (flux coupé, opencode tué pendant qu'un enfant travaillait).
   */
  const source = { occupees: new Set<string>(), attentes: new Set<string>() };
  const suivreSource = (type: string, p: Record<string, unknown>) => {
    const etatSession = typeof p.status === "object" && p.status !== null ? (p.status as { type?: unknown }).type : undefined;
    if (type === "session.status" && (etatSession === "busy" || etatSession === "retry")) source.occupees.add(String(p.sessionID));
    else if ((type === "session.status" && etatSession === "idle") || type === "session.idle") source.occupees.delete(String(p.sessionID));
    else if (type === "permission.asked") source.attentes.add(String(p.id));
    else if (type === "permission.replied") source.attentes.delete(String(p.requestID));
  };
  const omoActivation: Pick<OmoActivationPort, "activeRequest" | "endRequest"> = {
    activeRequest: () => etat.demande,
    endRequest: (rootId, fin) => {
      journal.push(`fin:${rootId}:${fin}`);
    },
  };
  const omoStop: OmoStopPort = {
    run: async (rootId, cause) => {
      journal.push(`arret:${rootId}:${cause}`);
      return ARRET;
    },
    relaunchAfterRequest: async (rootId) => {
      journal.push(`relance:${rootId}`);
    },
  };
  const omoControl: Pick<OmoControlPort, "writeGuardState"> = {
    writeGuardState: async (state) => {
      etats.push(state);
      journal.push(`garde:${state.bloquer.join(",")}`);
    },
  };
  const gate = {
    working: async () => {
      etat.lecturesSalle++;
      const pendant = etat.pendantLecture;
      etat.pendantLecture = null;
      pendant?.();
      if (etat.salleIllisible) throw new Error("salle injoignable");
      return new Set([...etat.salleOccupee, ...source.occupees]);
    },
    pending: async () => {
      if (etat.salleIllisible) throw new Error("salle injoignable");
      return [...new Set([...etat.salleAttentes, ...source.attentes])].map((id) => ({ id, sessionID: RACINE, tool: null }));
    },
  };
  const ledger = {
    spentSince: (rootId: string, since: number) => {
      assert.equal(rootId, RACINE);
      assert.equal(since, etat.demande?.startedAt);
      return typeof etat.depense === "function" ? etat.depense() : etat.depense;
    },
    percentUsed: () => etat.pourcent,
    guardRuns: (runs: Array<{ model: string }>, confirmed: boolean) => {
      gardes.push({ models: runs.map((run) => run.model), confirmed });
      return etat.refusBudget ? { error: "budget-guard" } : null;
    },
  };
  const c11 = {
    db,
    sessions,
    ledger,
    log: createLogger("error"),
    hub: new EventHub(),
    env: { workspaceDir: "/workspace" },
    instances: { omo: { gate } },
    ports: { omoActivation, omoStop, omoControl },
  } as unknown as Cockpit11;
  const service = createOmoCaps(c11, { clock: horloge.clock });
  const demande = (overrides: Partial<OmoActiveRequest> = {}): OmoActiveRequest => {
    etat.demande = { rootId: RACINE, requestId: "req_1", startedAt: horloge.maintenant(), plafondUsd: options.plafondUsd ?? "0.50", ...overrides };
    return etat.demande;
  };
  /** `origin` null : événement SANS origine (processeur 1.0.x, lu comme l'instance principale). */
  const emit = (type: string, properties: Record<string, unknown>, origin: { instance: "omo" | "principale" } | null = { instance: "omo" }) => {
    if (origin?.instance === "omo") suivreSource(type, properties);
    service.derivation.onEvent({ directory: DOSSIER, payload: { id: `evt_${type}`, type, properties } }, origin ?? undefined);
  };
  const statut = (sessionID: string, type: "busy" | "idle" | "retry") => emit("session.status", { sessionID, status: { type } });
  /** La salle change sans que son flux le dise : l'événement est perdu. */
  const sansEvenement = (type: string, properties: Record<string, unknown>) => suivreSource(type, properties);
  const usage = () => service.onUsage({ sessionId: RACINE, rootId: RACINE, monthSpentUsd: 1, percent: etat.pourcent, instance: "omo" });
  const envoi = (overrides: Partial<ProxyContext> = {}): ProxyContext => ({
    c: {} as ProxyContext["c"],
    method: "POST",
    sub: `/session/${RACINE}/prompt_async`,
    directory: DOSSIER,
    body: { model: MODEL, parts: [{ type: "text", text: "Travaille." }] },
    sessionId: RACINE,
    instance: "omo",
    ...overrides,
  });
  /** Avance l'horloge puis attend les travaux lancés (arrêt, fin de demande). */
  const avancer = async (ms: number) => {
    horloge.avancer(ms);
    await service.settled();
  };
  const fait = (kind: "consigne" | "resultat", callId: string, data: Record<string, unknown>, at = horloge.maintenant()) =>
    db
      .prepare("INSERT INTO activity_facts (root_id, session_id, kind, ref, data, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(RACINE, RACINE, kind, callId, JSON.stringify(data), at);
  return { horloge, db, sessions, journal, etats, gardes, etat, c11, service, demande, emit, statut, sansEvenement, usage, envoi, avancer, fait };
}

type Banc = ReturnType<typeof banc>;

/** Arrêts demandés, dans l'ordre (causes seulement). */
const arrets = (b: Banc) => b.journal.filter((l) => l.startsWith("arret:")).map((l) => l.split(":")[2] as OmoStopCause);

/** Demande ouverte et suivie : le crochet d'envoi l'a acceptée, la racine travaille. */
async function demandeEnCours(b: Banc, overrides: Partial<OmoActiveRequest> = {}) {
  b.demande(overrides);
  assert.equal(await b.service.beforeBilledSend(b.envoi()), null);
  b.statut(RACINE, "busy");
  b.journal.length = 0;
  b.etats.length = 0;
}

// --- Message de l'utilisateur ------------------------------------------------------------------------------------------------------

describe("L22d : garde-fou budgétaire du message de l'utilisateur (crochet beforeBilledSend de la salle)", () => {
  it("guardRuns sur l'IA du message, TOUJOURS sans confirmation ; accepté : délégations rouvertes (guard-state vide), surveillance ouverte", async () => {
    const b = banc();
    b.demande();
    const res = await b.service.beforeBilledSend(b.envoi());
    assert.equal(res, null);
    assert.deepEqual(b.gardes, [{ models: ["github-copilot/gpt-5-mini"], confirmed: false }]);
    assert.deepEqual(b.journal, ["garde:"]);
    assert.deepEqual(b.etats.map((s) => s.bloquer), [[]]);
    // La surveillance est ouverte : la durée court (une minuterie de durée, une de repos).
    assert.ok(b.horloge.enAttente() >= 1);
  });

  it("refus du garde-fou → 409 « budget-mensuel » avec la phrase de la salle, demande close « seuil-mensuel », rien d'écrit ni d'arrêté", async () => {
    const b = banc({ refusBudget: true });
    b.demande();
    const res = await b.service.beforeBilledSend(b.envoi());
    assert.ok(res instanceof Response);
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "budget-mensuel", message: phraseRefusActivation("budget-mensuel") });
    assert.deepEqual(b.journal, [`fin:${RACINE}:seuil-mensuel`]);
    assert.deepEqual(b.gardes[0]?.confirmed, false);
  });

  it("montant de la demande illisible → 409 « plafond-invalide », demande close, rien n'est envoyé", async () => {
    const b = banc({ plafondUsd: "beaucoup" });
    b.demande();
    const res = await b.service.beforeBilledSend(b.envoi());
    assert.equal(res?.status, 409);
    assert.deepEqual(await res?.json(), { error: "plafond-invalide", message: phraseRefusActivation("plafond-invalide") });
    assert.deepEqual(b.journal, [`fin:${RACINE}:interrompue`]);
  });

  it("aucune garde hors de la demande active de la salle : instance principale, autre racine, aucune demande", async () => {
    const b = banc({ refusBudget: true });
    assert.equal(await b.service.beforeBilledSend(b.envoi()), null, "aucune demande active");
    b.demande();
    assert.equal(await b.service.beforeBilledSend(b.envoi({ instance: undefined })), null, "contexte de l'instance principale");
    assert.equal(await b.service.beforeBilledSend(b.envoi({ sessionId: "ses_autre", sub: "/session/ses_autre/prompt_async" })), null, "autre racine");
    assert.deepEqual([b.gardes, b.journal], [[], []]);
  });

  it("IA du message lue dans la forme de chaque route (message, raccourci, résumé)", () => {
    assert.equal(modeleDuMessage("/session/ses_a/prompt_async", { model: MODEL })?.run.model, "github-copilot/gpt-5-mini");
    assert.equal(modeleDuMessage("/session/ses_a/command", { model: "github-copilot/gpt-5" })?.run.model, "github-copilot/gpt-5");
    assert.equal(modeleDuMessage("/session/ses_a/summarize", { providerID: "github-copilot", modelID: "gpt-5" })?.run.model, "github-copilot/gpt-5");
    assert.equal(modeleDuMessage("/session/ses_a/prompt_async", { model: "github-copilot/gpt-5" }), null);
    assert.equal(modeleDuMessage("/session/ses_a/command", { model: "sans-barre" }), null);
  });
});

// --- Plafonds ------------------------------------------------------------------------------------------------------------------------

describe("L22d : plafonds de la salle (T-L22-c, T-L22-k), constatés après coup", () => {
  it("T-L22-c : dépense ≥ montant saisi → guard-state « task, call_omo_agent » PUIS omoStop.run(racine, « plafond-cout »), une seule fois", async () => {
    const b = banc({ plafondUsd: "0.50" });
    await demandeEnCours(b);
    b.etat.depense = 0.49;
    b.usage();
    await b.service.settled();
    assert.deepEqual(b.journal, [], "sous le plafond : rien");
    b.etat.depense = 0.5;
    b.usage();
    await b.service.settled();
    assert.deepEqual(b.journal, ["garde:task,call_omo_agent", `arret:${RACINE}:plafond-cout`]);
    b.etat.depense = 3;
    b.usage();
    b.usage();
    await b.service.settled();
    assert.equal(arrets(b).length, 1, "un seul arrêt par demande");
  });

  it("comparaison en micro-dollars : une somme de flottants juste au plafond l'atteint, juste dessous non", async () => {
    // 0,7 + 0,1 vaut 0,7999999999999999 en flottant : sans l'arrondi au micro-dollar, le plafond de 0,80 $ ne serait pas atteint.
    const pile = banc({ plafondUsd: "0,80" });
    await demandeEnCours(pile);
    pile.etat.depense = 0.7 + 0.1;
    assert.ok(pile.etat.depense < 0.8);
    pile.usage();
    await pile.service.settled();
    assert.deepEqual(arrets(pile), ["plafond-cout"]);
    const dessous = banc({ plafondUsd: "0.29" });
    await demandeEnCours(dessous);
    dessous.etat.depense = 0.289_999;
    dessous.usage();
    await dessous.service.settled();
    assert.deepEqual(arrets(dessous), []);
    assert.equal(plafondEnMicros("0.29"), 290_000);
    assert.equal(plafondEnMicros("2"), 2_000_000);
    for (const illisible of ["", "0", "-1", "1,234", "1e3", " 1", null, 1]) assert.equal(plafondEnMicros(illisible), null, String(illisible));
  });

  it("fermé en cas de doute : montant illisible dans la demande suivie, ou dépense illisible → arrêt « plafond-cout »", async () => {
    const illisible = banc();
    illisible.demande({ plafondUsd: "n'importe quoi" });
    illisible.statut(RACINE, "busy");
    await illisible.service.settled();
    assert.deepEqual(arrets(illisible), ["plafond-cout"]);
    const depense = banc();
    await demandeEnCours(depense);
    depense.etat.depense = () => {
      throw new Error("base illisible");
    };
    depense.usage();
    await depense.service.settled();
    assert.deepEqual(arrets(depense), ["plafond-cout"]);
  });

  it("T-L22-k durée : 60 minutes après le début, par la seule minuterie (aucun événement) → « plafond-duree »", async () => {
    const b = banc();
    await demandeEnCours(b);
    assert.equal(OMO_DUREE_MS, OMO_LIMITES.dureeMinutes * 60_000);
    assert.equal(OMO_LIMITES.dureeMinutes, 60);
    await b.avancer(OMO_DUREE_MS - 1);
    assert.deepEqual(arrets(b), []);
    // Le repos de la racine ne doit pas terminer la demande avant : elle travaille.
    await b.avancer(1);
    assert.deepEqual(b.journal, ["garde:task,call_omo_agent", `arret:${RACINE}:plafond-duree`]);
  });

  it("T-L22-k sessions : 30 sessions créées passent, la 31e arrête « plafond-sessions » ; racine et doublons non comptés", async () => {
    const b = banc();
    await demandeEnCours(b);
    b.emit("session.created", { sessionID: RACINE, info: { id: RACINE } });
    for (let i = 1; i <= OMO_LIMITES.sessionsMax; i++) {
      b.emit("session.created", { sessionID: `ses_enfant_${i}`, info: { id: `ses_enfant_${i}`, parentID: RACINE } });
      b.emit("session.created", { sessionID: `ses_enfant_${i}`, info: { id: `ses_enfant_${i}`, parentID: RACINE } });
    }
    await b.service.settled();
    assert.equal(OMO_LIMITES.sessionsMax, 30);
    assert.deepEqual(arrets(b), []);
    b.emit("session.created", { sessionID: "ses_enfant_31", info: { id: "ses_enfant_31", parentID: RACINE } });
    await b.service.settled();
    assert.deepEqual(b.journal, ["garde:task,call_omo_agent", `arret:${RACINE}:plafond-sessions`]);
  });

  it("T-L22-k seuils mensuels : 80 % et 100 % franchis PENDANT la demande arrêtent « seuil-mensuel », jamais confirmés", async () => {
    assert.deepEqual([...OMO_SEUILS_MENSUELS], [80, 100]);
    const quatreVingts = banc({ pourcent: 79.5 });
    await demandeEnCours(quatreVingts);
    quatreVingts.etat.pourcent = 80;
    quatreVingts.usage();
    await quatreVingts.service.settled();
    assert.deepEqual(quatreVingts.journal, ["garde:task,call_omo_agent", `arret:${RACINE}:seuil-mensuel`]);

    const cent = banc({ pourcent: 85 });
    await demandeEnCours(cent);
    cent.etat.pourcent = 99.9;
    cent.usage();
    await cent.service.settled();
    assert.deepEqual(arrets(cent), [], "80 % déjà dépassé au début, 100 % pas encore atteint");
    cent.etat.pourcent = 100;
    cent.usage();
    await cent.service.settled();
    assert.deepEqual(arrets(cent), ["seuil-mensuel"]);

    const illisible = banc({ pourcent: 10 });
    await demandeEnCours(illisible);
    illisible.etat.pourcent = Number.NaN;
    illisible.usage();
    await illisible.service.settled();
    assert.deepEqual(arrets(illisible), ["seuil-mensuel"], "pourcentage illisible : seuil tenu pour franchi");
  });

  it("aucun plafond hors de la salle : un événement sans origine « omo » ne compte rien, un usage d'une autre instance n'arrête rien", async () => {
    const b = banc();
    await demandeEnCours(b);
    for (let i = 1; i <= 40; i++) b.emit("session.created", { sessionID: `ses_p_${i}`, info: { id: `ses_p_${i}` } }, { instance: "principale" });
    for (let i = 1; i <= 40; i++) b.emit("session.created", { sessionID: `ses_q_${i}`, info: { id: `ses_q_${i}` } }, null);
    b.etat.depense = 99;
    b.service.onUsage({ monthSpentUsd: 1, percent: 99, instance: "principale" });
    await b.service.settled();
    assert.deepEqual(b.journal, []);
  });

  it("un échec de l'état de garde n'empêche pas l'arrêt, et un arrêt en échec est journalisé sans lever", async () => {
    const b = banc();
    await demandeEnCours(b);
    (b.c11.ports.omoControl as { writeGuardState: OmoControlPort["writeGuardState"] }).writeGuardState = async () => {
      throw new Error("volume de contrôle en lecture seule");
    };
    (b.c11.ports.omoStop as { run: OmoStopPort["run"] }).run = async (rootId, cause) => {
      b.journal.push(`arret:${rootId}:${cause}`);
      throw new Error("salle injoignable");
    };
    b.etat.depense = 1;
    b.usage();
    await b.service.settled();
    assert.deepEqual(b.journal, [`arret:${RACINE}:plafond-cout`]);
  });
});

// --- guard-state.json ------------------------------------------------------------------------------------------------------------

interface Vecteur {
  nom: string;
  format: string;
  texte: string;
  attendu: unknown;
}

const VECTEURS_GARDE = (
  JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "test-support", "fixtures", "omo-control-vectors.json"), "utf8")) as { vecteurs: Vecteur[] }
).vecteurs.filter((v) => v.format === "garde");

describe("L22d : guard-state.json écrit au plafond, accepté par les vecteurs de L17a et lu par le filet de L24", () => {
  it("l'état écrit au plafond est celui du vecteur « délégation bloquée », relu à l'identique par le cockpit et par le filet", async () => {
    const b = banc();
    await demandeEnCours(b);
    b.etat.depense = 1;
    b.usage();
    await b.service.settled();
    const [etat] = b.etats;
    assert.ok(etat);
    const bloque = VECTEURS_GARDE.find((v) => JSON.stringify((v.attendu as OmoGuardState | null)?.bloquer) === JSON.stringify(["task", "call_omo_agent"]));
    assert.ok(bloque, "vecteur « délégation bloquée » absent de omo-control-vectors.json");
    assert.deepEqual({ ...etat, at: 0 }, { ...(bloque.attendu as OmoGuardState), at: 0 });
    assert.equal(etat.at, b.horloge.maintenant());
    const texte = ecrireGuardState(etat.at, etat.bloquer);
    assert.deepEqual(analyserGuardState(texte), etat);
    assert.deepEqual(garde.analyserEtatGarde(texte), etat);
    // Et l'état « rien de bloqué » écrit à l'envoi suivant, lui aussi relu à l'identique.
    const libre = VECTEURS_GARDE.find((v) => JSON.stringify((v.attendu as OmoGuardState | null)?.bloquer) === "[]");
    assert.ok(libre);
    assert.deepEqual(garde.analyserEtatGarde(ecrireGuardState(1, [])), { ...(libre.attendu as OmoGuardState), at: 1 });
  });

  it("bout à bout : le service réel de L17b écrit guard-state.json, le filet de L24 refuse alors task et call_omo_agent ; l'envoi suivant les rouvre", async (t: TestContext) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omo-caps-garde-"));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const dossier = (nom: string) => {
      const complet = path.join(tmp, nom);
      fs.mkdirSync(complet, { recursive: true });
      return complet;
    };
    const controle = dossier("control");
    const b = banc();
    const service = createOmoControl({
      controlDir: controle,
      stateDir: dossier("state"),
      authDir: dossier("auth"),
      opencodeDataDir: dossier("oc-data"),
      cockpitDataDir: dossier("data"),
      clock: b.horloge.clock,
      actif: () => true,
      log: createLogger("error"),
    });
    (b.c11.ports as unknown as { omoControl: OmoControlPort }).omoControl = service;
    const filet = garde.creerGarde({ dossier: DOSSIER, cheminEtat: path.join(controle, OMO_FICHIERS_CONTROLE.garde), reel: (chemin) => chemin });
    await demandeEnCours(b);
    assert.equal(filet.decider("task", {}), null, "état « rien de bloqué » écrit à l'envoi");
    b.etat.depense = 1;
    b.usage();
    await b.service.settled();
    await service.settled();
    assert.equal(filet.decider("task", {})?.categorie, "delegation");
    assert.equal(filet.decider("call_omo_agent", {})?.categorie, "delegation");
    // Demande suivante : le crochet d'envoi remet l'état à « rien de bloqué ».
    b.demande({ requestId: "req_2" });
    assert.equal(await b.service.beforeBilledSend(b.envoi()), null);
    await service.settled();
    assert.equal(filet.decider("task", {}), null);
  });
});

// --- Fin de demande ------------------------------------------------------------------------------------------------------------

describe("L22d : fin de demande (D-2b-29) — 15 s au repos, puis endRequest et relance à neuf", () => {
  it("au repos 15 s → endRequest(racine, « terminee ») PUIS relaunchAfterRequest(racine), une seule fois", async () => {
    const b = banc();
    await demandeEnCours(b);
    assert.equal(OMO_FIN_REPOS_MS, OMO_LIMITES.finDemandeReposS * 1_000);
    assert.equal(OMO_LIMITES.finDemandeReposS, 15);
    b.statut(RACINE, "idle");
    await b.avancer(OMO_FIN_REPOS_MS - 1);
    assert.deepEqual(b.journal, []);
    await b.avancer(1);
    assert.deepEqual(b.journal, [`fin:${RACINE}:terminee`, `relance:${RACINE}`]);
    assert.equal(b.etat.lecturesSalle, 1, "la salle est relue par son portillon avant de conclure");
    await b.avancer(OMO_FIN_REPOS_MS * 3);
    assert.deepEqual(b.journal, [`fin:${RACINE}:terminee`, `relance:${RACINE}`], "une seule fin");
  });

  it("travail repris avant 15 s : l'attente repart de zéro", async () => {
    const b = banc();
    await demandeEnCours(b);
    b.statut(RACINE, "idle");
    await b.avancer(10_000);
    b.statut("ses_enfant", "busy");
    await b.avancer(10_000);
    b.statut("ses_enfant", "idle");
    await b.avancer(OMO_FIN_REPOS_MS - 1);
    assert.deepEqual(b.journal, []);
    await b.avancer(1);
    assert.deepEqual(b.journal, [`fin:${RACINE}:terminee`, `relance:${RACINE}`]);
  });

  it("tâche de fond ouverte (faits de L25a : consigne « en tâche de fond » sans résultat) → PAS de fin ; résultat rendu → fin", async () => {
    const b = banc();
    await demandeEnCours(b);
    b.fait("consigne", "call_fond", { etat: "envoyee", callId: "call_fond", enfant: "ses_fond", fond: true });
    // Consigne d'une AUTRE demande, plus ancienne : ne retient rien.
    b.fait("consigne", "call_ancien", { etat: "envoyee", callId: "call_ancien", fond: true }, T0 - 60_000);
    b.statut(RACINE, "idle");
    await b.avancer(OMO_FIN_REPOS_MS * 2);
    assert.deepEqual(b.journal, [], "tâche de fond ouverte : aucune fin");
    b.fait("resultat", "call_fond", { etat: "rendu", callId: "call_fond", enfant: "ses_fond" });
    await b.avancer(OMO_FIN_REPOS_MS);
    assert.deepEqual(b.journal, [`fin:${RACINE}:terminee`, `relance:${RACINE}`]);
  });

  it("délégation en tâche de fond vue dans le flux, enfant encore « pending » → PAS de fin ; enfant connu puis au repos → fin", async () => {
    const b = banc();
    await demandeEnCours(b);
    const partie = (sessionId: string | "pending") => ({
      part: {
        type: "tool",
        tool: "task",
        callID: "call_bg",
        messageID: "msg_1",
        sessionID: RACINE,
        state: { status: "completed", input: { run_in_background: true }, metadata: { sessionId } },
      },
    });
    b.emit("message.part.updated", partie("pending"));
    b.statut(RACINE, "idle");
    await b.avancer(OMO_FIN_REPOS_MS * 2);
    assert.deepEqual(b.journal, []);
    b.emit("message.part.updated", partie("ses_bg"));
    b.statut("ses_bg", "busy");
    b.statut("ses_bg", "idle");
    await b.avancer(OMO_FIN_REPOS_MS);
    assert.deepEqual(b.journal, [`fin:${RACINE}:terminee`, `relance:${RACINE}`]);
  });

  it("demande d'autorisation en attente → PAS de fin ; répondue → fin après 15 s", async () => {
    const b = banc();
    await demandeEnCours(b);
    b.emit("permission.asked", { id: "per_1", sessionID: RACINE, permission: "bash" });
    b.statut(RACINE, "idle");
    await b.avancer(OMO_FIN_REPOS_MS * 2);
    assert.deepEqual(b.journal, []);
    b.emit("permission.replied", { sessionID: RACINE, requestID: "per_1", reply: "once" });
    await b.avancer(OMO_FIN_REPOS_MS);
    assert.deepEqual(b.journal, [`fin:${RACINE}:terminee`, `relance:${RACINE}`]);
  });

  it("la salle relue dit « occupée », « en attente » ou ne répond pas → PAS de fin (vérification refaite 15 s plus tard)", async () => {
    for (const options of [{ salleOccupee: ["ses_x"] }, { salleAttentes: ["per_x"] }, { salleIllisible: true }] satisfies OptionsBanc[]) {
      const b = banc(options);
      await demandeEnCours(b);
      b.statut(RACINE, "idle");
      for (let i = 0; i < 3; i++) await b.avancer(OMO_FIN_REPOS_MS);
      assert.deepEqual(b.journal, [], JSON.stringify(options));
      assert.ok(b.etat.lecturesSalle >= 2, "vérification refaite");
    }
  });

  it("état de session inconnu : compté comme occupé, aucune fin ; plafond atteint : aucune fin non plus", async () => {
    const inconnu = banc();
    await demandeEnCours(inconnu);
    inconnu.statut(RACINE, "idle");
    inconnu.emit("session.status", { sessionID: "ses_y", status: { type: "etrange" } });
    await inconnu.avancer(OMO_FIN_REPOS_MS * 2);
    assert.deepEqual(inconnu.journal, []);

    const arretee = banc();
    await demandeEnCours(arretee);
    arretee.etat.depense = 1;
    arretee.usage();
    arretee.statut(RACINE, "idle");
    await arretee.avancer(OMO_FIN_REPOS_MS * 2);
    assert.deepEqual(arretee.journal, ["garde:task,call_omo_agent", `arret:${RACINE}:plafond-cout`]);
  });

  // Relecture 2ter-vague-4 : les ensembles du flux (sessions occupées, demandes en attente) ne sont plus une vérité définitive.
  // Un « idle » perdu retenait la demande jusqu'au plafond de durée, puis TOUTES les suivantes jusqu'au redémarrage du cockpit.
  const FIN = [`fin:${RACINE}:terminee`, `relance:${RACINE}`];

  it("constat rejoué : enfant « busy » dont l'« idle » est perdu, salle relue au repos → la demande se termine, et la suivante aussi", async () => {
    const b = banc();
    await demandeEnCours(b);
    b.statut("ses_enfant", "busy");
    b.sansEvenement("session.status", { sessionID: "ses_enfant", status: { type: "idle" } });
    b.statut(RACINE, "idle");
    for (let i = 0; i < 2; i++) await b.avancer(OMO_FIN_REPOS_MS);
    assert.deepEqual(b.journal, FIN, "relue au repos : fin, jamais le plafond de 60 minutes");
    assert.ok(b.etat.lecturesSalle >= 2, "la salle a été relue avant de retirer l'enfant");

    await demandeEnCours(b, { requestId: "req_2" });
    b.statut(RACINE, "idle");
    for (let i = 0; i < 2; i++) await b.avancer(OMO_FIN_REPOS_MS);
    assert.deepEqual(b.journal, FIN, "la demande suivante n'hérite de rien");
  });

  it("flux de la salle reconnecté (server.connected : opencode relancé, ou coupure) : les ensembles du flux sont vidés, la fin arrive 15 s après le repos de la racine", async () => {
    const b = banc();
    await demandeEnCours(b);
    b.statut("ses_enfant", "busy");
    // opencode tué pendant que l'enfant travaille : la nouvelle instance est au repos, aucun « idle » n'est jamais émis.
    b.sansEvenement("session.status", { sessionID: "ses_enfant", status: { type: "idle" } });
    await b.avancer(1_000);
    b.emit("server.connected", {});
    b.statut(RACINE, "busy");
    await b.avancer(1_000);
    b.statut(RACINE, "idle");
    await b.avancer(OMO_FIN_REPOS_MS - 1);
    assert.deepEqual(b.journal, []);
    await b.avancer(1);
    assert.deepEqual(b.journal, FIN);
  });

  it("état inconnu : retient la demande en cours, même salle relue (fermé en cas de doute), jamais les suivantes : la reconnexion du flux le lève", async () => {
    const b = banc();
    await demandeEnCours(b);
    b.emit("session.status", { sessionID: "ses_y", status: { type: "etrange" } });
    b.statut(RACINE, "idle");
    for (let i = 0; i < 3; i++) await b.avancer(OMO_FIN_REPOS_MS);
    assert.deepEqual(b.journal, [], "état inconnu : aucune fin");
    assert.ok(b.etat.lecturesSalle >= 1, "relue, sans rien retirer");
    b.emit("server.connected", {});
    await b.avancer(OMO_FIN_REPOS_MS);
    assert.deepEqual(b.journal, FIN);
  });

  it("demande d'autorisation dont la réponse est perdue, salle relue sans attente → fin après la relecture", async () => {
    const b = banc();
    await demandeEnCours(b);
    b.emit("permission.asked", { id: "per_perdue", sessionID: RACINE, permission: "bash" });
    b.sansEvenement("permission.replied", { requestID: "per_perdue", reply: "once" });
    b.statut(RACINE, "idle");
    for (let i = 0; i < 2; i++) await b.avancer(OMO_FIN_REPOS_MS);
    assert.deepEqual(b.journal, FIN);
  });

  it("un enfant revu occupé PENDANT la relecture n'est pas retiré par elle", async () => {
    const b = banc();
    await demandeEnCours(b);
    b.statut("ses_enfant", "busy");
    b.sansEvenement("session.status", { sessionID: "ses_enfant", status: { type: "idle" } });
    b.statut(RACINE, "idle");
    // Son « busy » arrive dans le flux pendant que la salle est relue, avant la réponse, qui le dit encore au repos.
    b.etat.pendantLecture = () =>
      b.service.derivation.onEvent({ directory: DOSSIER, payload: { id: "evt_revu", type: "session.status", properties: { sessionID: "ses_enfant", status: { type: "busy" } } } }, { instance: "omo" });
    for (let i = 0; i < 2; i++) await b.avancer(OMO_FIN_REPOS_MS);
    assert.deepEqual(b.journal, [], "revu pendant la lecture : gardé, la relecture suivante décidera");
    for (let i = 0; i < 2; i++) await b.avancer(OMO_FIN_REPOS_MS);
    assert.deepEqual(b.journal, FIN, "relu ensuite sans nouvel événement : retiré");
  });

  it("salle relue illisible : rien n'est retiré, aucune fin, et le plafond de durée reste la limite", async () => {
    const b = banc({ salleIllisible: true });
    await demandeEnCours(b);
    b.statut("ses_enfant", "busy");
    b.sansEvenement("session.status", { sessionID: "ses_enfant", status: { type: "idle" } });
    b.statut(RACINE, "idle");
    for (let i = 0; i < 4; i++) await b.avancer(OMO_FIN_REPOS_MS);
    assert.deepEqual(b.journal, []);
    assert.ok(b.etat.lecturesSalle >= 2, "relue à chaque fois, sans rien retirer");
    await b.avancer(OMO_DUREE_MS);
    assert.deepEqual(arrets(b), ["plafond-duree"]);
  });

  it("sans demande active, rien ne se termine ni ne s'arrête", async () => {
    const b = banc();
    b.statut(RACINE, "busy");
    b.statut(RACINE, "idle");
    b.etat.depense = 10;
    b.usage();
    await b.avancer(OMO_DUREE_MS * 2);
    assert.deepEqual(b.journal, []);
  });
});

// --- Câblage et textes ---------------------------------------------------------------------------------------------------------------

describe("L22d : câblage du module et honnêteté des textes", () => {
  it("SALLE_OUVERTE fausse : aucune inscription ; ouverte : crochet, dérivation et abonnement de la salle seulement ; port neutre inchangé", () => {
    assert.equal(SALLE_OUVERTE, false);
    const inscriptions: string[] = [];
    const reg = {
      hook: (step: string, _fn: unknown, options?: { instances?: readonly string[] }) => inscriptions.push(`hook ${step} ${options?.instances?.join(",")}`),
      derivation: (d: { name: string; instances?: readonly string[] }) => inscriptions.push(`derivation ${d.name} ${d.instances?.join(",")}`),
      hub: (type: string, _fn: unknown, options?: { instances?: readonly string[] }) => inscriptions.push(`hub ${type} ${options?.instances?.join(",")}`),
      startup: () => inscriptions.push("startup"),
      routes: () => inscriptions.push("routes"),
    } as unknown as Registrar;
    const b = banc();
    omoCapsModule.install(reg, { ...b.c11, salleOuverte: false });
    assert.deepEqual(inscriptions, []);
    omoCapsModule.install(reg, { ...b.c11, salleOuverte: true });
    assert.deepEqual(inscriptions, ["hook beforeBilledSend omo", "derivation omoCaps omo", "hub usage.updated omo"]);
    assert.deepEqual(neutralOmoCaps(b.c11), {});
  });

  it("« un appel par session occupée » dit, « au plus » jamais écrit sur le coût ; la phrase d'arrêt au plafond n'en promet pas", () => {
    const sources = ["omo-caps.ts", "omo-responder.ts"].map((nom) => fs.readFileSync(path.join(import.meta.dirname, nom), "utf8"));
    assert.match(sources[0] ?? "", /un appel par session occupée/);
    for (const source of sources) assert.doesNotMatch(source, /(?<![\p{L}-])au plus(?![\p{L}])/iu);
    const phrase = phraseArret("plafond-cout");
    assert.doesNotMatch(phrase, /au plus/iu);
    assert.match(phrase, /peut l'avoir dépassé/);
    assert.match(phraseArret("seuil-mensuel"), /ne le confirme jamais automatiquement/);
  });
});

// --- Cockpit réel (harnais, second faux opencode) -------------------------------------------------------------------------------

/** Module factice au nom réel : la VRAIE fabrique, sans la porte SALLE_OUVERTE (fausse dans le dépôt). */
const modulePlafonds = (horloge?: OmoControlClock): Cockpit11Module => ({
  name: "omoCaps",
  install(reg, c11) {
    installOmoCaps(reg, c11, horloge ? { clock: horloge } : {});
  },
});

describe("L22d : plafonds et fin de demande sur le cockpit réel (processeur de la salle, portillon de la salle)", () => {
  it("T-L22-c bout à bout : le coût d'un tour de la SALLE remonte par usage.updated et arrête ; un tour coûteux de l'instance principale n'arrête rien", async (t: TestContext) => {
    const journal: string[] = [];
    const etat: { demande: OmoActiveRequest | null } = { demande: null };
    const h = await startCockpit(t, {
      omo: true,
      modules: [modulePlafonds()],
      ports: {
        omoActivation: { ...stubActivation(etat), endRequest: (rootId, fin) => void journal.push(`fin:${rootId}:${fin}`) },
        omoStop: { run: async (rootId, cause) => (journal.push(`arret:${rootId}:${cause}`), ARRET), relaunchAfterRequest: async () => undefined },
        omoControl: { ...stubControle(), writeGuardState: async (s) => void journal.push(`garde:${s.bloquer.join(",")}`) },
      },
    });
    const salle = h.omo;
    assert.ok(salle);
    const racine = await salle.deps.client.request<OcSession>("POST", "/session", { directory: DOSSIER, body: { title: "projet" } });
    h.sessions.upsert(racine, undefined, { instance: "omo" });
    etat.demande = { rootId: racine.id, requestId: "req_1", startedAt: Date.now() - 1_000, plafondUsd: "0.01" };

    // Instance principale : un tour à 5 $ ne touche pas la demande de la salle.
    const principale = await h.deps.client.request<OcSession>("POST", "/session", { body: { title: "principale" } });
    h.fake.script(principale.id, { text: "fait", cost: 5 });
    await h.deps.client.request("POST", `/session/${principale.id}/prompt_async`, { body: { model: MODEL, parts: [{ type: "text", text: "Va." }] } });
    await until(() => h.ledger.spentSince(principale.id, 0) >= 5);
    await h.processor.settled();
    assert.equal(journal.length, 0, journal.join(", "));

    // Salle : un tour à 0,02 $ pour un montant saisi de 0,01 $.
    salle.fake.script(racine.id, { text: "fait", cost: 0.02 });
    await salle.deps.client.request("POST", `/session/${racine.id}/prompt_async`, { directory: DOSSIER, body: { model: MODEL, parts: [{ type: "text", text: "Va." }] } });
    await until(() => journal.includes(`arret:${racine.id}:plafond-cout`), 5_000);
    assert.deepEqual(journal, ["garde:task,call_omo_agent", `arret:${racine.id}:plafond-cout`]);
  });

  it("fin de demande bout à bout : tour de la salle fini, 15 s au repos (horloge injectée), salle relue par son portillon → endRequest puis relance", async (t: TestContext) => {
    const horloge = fausseHorloge(Date.now());
    const journal: string[] = [];
    const etat: { demande: OmoActiveRequest | null } = { demande: null };
    const h = await startCockpit(t, {
      omo: true,
      modules: [modulePlafonds(horloge.clock)],
      ports: {
        omoActivation: { ...stubActivation(etat), endRequest: (rootId, fin) => void journal.push(`fin:${rootId}:${fin}`) },
        omoStop: { run: async (rootId, cause) => (journal.push(`arret:${rootId}:${cause}`), ARRET), relaunchAfterRequest: async (rootId) => void journal.push(`relance:${rootId}`) },
        omoControl: stubControle(),
      },
    });
    const salle = h.omo;
    assert.ok(salle);
    const racine = await salle.deps.client.request<OcSession>("POST", "/session", { directory: DOSSIER, body: { title: "projet" } });
    h.sessions.upsert(racine, undefined, { instance: "omo" });
    etat.demande = { rootId: racine.id, requestId: "req_1", startedAt: horloge.maintenant(), plafondUsd: "5" };
    salle.fake.script(racine.id, { text: "fait", cost: 0.001 });
    const lecturesAvant = salle.fake.requests.length;
    await salle.deps.client.request("POST", `/session/${racine.id}/prompt_async`, { directory: DOSSIER, body: { model: MODEL, parts: [{ type: "text", text: "Va." }] } });
    await salle.fake.settled(racine.id);
    await salle.deps.processor.settled();
    await until(() => salle.fake.statusOf(racine.id).type === "idle");
    // Repère émis APRÈS le repos sur le flux de la salle : quand le processeur de la salle l'a vu, il a vu le repos avant lui.
    await h.emitOmo({ directory: DOSSIER, payload: { type: "harnais.repere", properties: {} } } as OcGlobalEvent);
    const principaleAvant = h.fake.requests.length;
    horloge.avancer(OMO_FIN_REPOS_MS);
    await until(() => journal.length >= 2, 5_000);
    assert.deepEqual(journal, [`fin:${racine.id}:terminee`, `relance:${racine.id}`]);
    const lues = salle.fake.requests.slice(lecturesAvant).map((r) => `${r.method} ${r.pathname}`);
    assert.ok(lues.includes("GET /session/status") && lues.includes("GET /permission"), lues.join(", "));
    // Aucune lecture ni écriture sur l'instance principale pour la fin de demande de la salle.
    assert.deepEqual(h.fake.requests.slice(principaleAvant).map((r) => `${r.method} ${r.pathname}`), []);
  });
});

/** omoActivation minimal : la demande active vient du test. */
function stubActivation(etat: { demande: OmoActiveRequest | null }): OmoActivationPort {
  return {
    view: async () => null,
    put: async () => ({ ok: false, status: 409, code: "salle-coupee" }),
    consume: async () => ({ ok: false, code: "salle-coupee" }),
    activeRequest: () => etat.demande,
    endRequest: () => undefined,
  };
}

/** omoControl minimal : rien n'est écrit. */
function stubControle(): OmoControlPort {
  return {
    startHeartbeat: () => undefined,
    stopHeartbeat: () => undefined,
    requestStop: async () => undefined,
    writePrecheckOk: async () => undefined,
    writeGuardState: async () => undefined,
    publishAuth: async () => undefined,
    readState: async () => null,
    suspend: () => undefined,
    resume: () => undefined,
    suspended: () => false,
  };
}
