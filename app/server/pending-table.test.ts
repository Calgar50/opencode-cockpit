// Tests de la table des attentes (GF5, D11, décision A31 a ; mesures/D11-permission.md §6.1 et §6.6 n° 2), module pur sans réseau :
// permission.asked, permission.replied, server.instance.disposed, global.disposed (« global » jamais normalisé), bornes et dossier
// « incertain », non fiable au démarrage et après une coupure, fiable après une lecture réussie ou une libération vue,
// resynchronisation sans course (événement reçu pendant la lecture rejoué), resynchronisation proactive, normalisation du dossier.
// Aucun appel facturé, aucun opencode.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { PERMISSION_MESSAGES } from "./oc-proxy.ts";
import type { OcGlobalEvent } from "./opencode.ts";
import {
  auFormatOpencode,
  cleDossier,
  createPendingTable,
  defautDansCorps,
  demandesEnCause,
  DOSSIERS_MAX,
  EN_CAUSE_MAX,
  lireDemande,
  METADONNEES_FACULTATIVES,
  METADONNEES_MAX,
  MOTIFS_MAX,
  premiereIllisible,
  SIGNATURE_DEFAUT,
  TABLE_MAX_PAR_DOSSIER,
  TABLE_MAX_PAR_INSTANCE,
  type TableDesAttentes,
} from "./pending-table.ts";
import { avertissementDeLecture, demandesDeLecture, outilDeCle, phraseListeBloquee, phraseListeIllisible, TEXTES } from "./shared/attentes-texts.ts";
import { verificationImpossible } from "./shared/delegation-texts.ts";
import { METADONNEES_FACULTATIVES as METADONNEES_DU_FAUX } from "./test-support/fake-opencode.ts";

const RACINE = "/workspace";
const P1 = "/workspace/p1";
const P2 = "/workspace/p2";
const NL = String.fromCharCode(10);

const evenement = (type: string, properties: Record<string, unknown>, directory: string | undefined = P1): OcGlobalEvent =>
  ({ ...(directory === undefined ? {} : { directory }), payload: { type, properties } }) as OcGlobalEvent;
const connecte = (): OcGlobalEvent => ({ payload: { type: "server.connected", properties: {} } }) as OcGlobalEvent;
const demande = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  sessionID: "ses_a",
  permission: "bash",
  patterns: ["ls"],
  metadata: { command: "ls" },
  always: ["ls *"],
  tool: { messageID: "msg_a", callID: `call_${id}` },
  ...over,
});
const demandee = (id: string, over: Record<string, unknown> = {}, directory = P1) => evenement("permission.asked", demande(id, over), directory);
const repondue = (requestID: string, directory = P1) => evenement("permission.replied", { sessionID: "ses_a", requestID, reply: "reject" }, directory);
const webSansDelai = (id: string) => demande(id, { permission: "webfetch", patterns: ["https://exemple.test"], metadata: { url: "https://exemple.test", format: "markdown" } });

/** Table dont les relectures proactives sont gardées (jamais lancées d'elles-mêmes). */
function table(): { t: TableDesAttentes; relectures: Array<string | null>; lancer: () => void } {
  const travaux: Array<() => void> = [];
  const relectures: Array<string | null> = [];
  const t = createPendingTable({ racine: RACINE, planifier: (travail) => travaux.push(travail) });
  t.poserRelecture(async (dir) => {
    relectures.push(dir);
  });
  return { t, relectures, lancer: () => travaux.splice(0).forEach((w) => w()) };
}

const on = (t: TableDesAttentes, e: OcGlobalEvent) => t.derivation.onEvent(e);
const ids = (t: TableDesAttentes, dir: string | null = P1) => t.etat(dir).demandes.map((d) => d.id);

/** Flux ouvert et dossier P1 rendu fiable par une lecture réussie de `liste`. */
function fiable(t: TableDesAttentes, liste: unknown[] = [], dir: string | null = P1): void {
  const lecture = t.debutLecture(dir);
  t.finLecture(lecture, liste);
}

describe("table des attentes : fiabilité", () => {
  it("au démarrage, rien n'est fiable ; après server.connected seul, pas davantage (aucune lecture ni libération vue)", () => {
    const { t } = table();
    assert.deepEqual(t.etat(P1), { fiable: false, demandes: [] });
    on(t, connecte());
    on(t, demandee("per_1"));
    assert.equal(t.etat(P1).fiable, false, "demandes vues, mais la table n'est pas prouvée complète");
    assert.deepEqual(ids(t), ["per_1"]);
  });

  it("lecture réussie depuis l'ouverture du flux : la liste remplace la table, le dossier devient fiable", () => {
    const { t } = table();
    on(t, connecte());
    on(t, demandee("per_perdue"));
    fiable(t, [demande("per_1"), demande("per_2")]);
    assert.deepEqual(t.etat(P1).fiable, true);
    assert.deepEqual(ids(t), ["per_1", "per_2"], "la liste d'opencode fait foi");
  });

  it("lecture commencée AVANT l'ouverture du flux en cours, ou flux fermé : elle ne prouve rien", () => {
    const { t } = table();
    const avant = t.debutLecture(P1);
    on(t, connecte());
    t.finLecture(avant, [demande("per_1")]);
    assert.equal(t.etat(P1).fiable, false);
    const pendant = t.debutLecture(P1);
    t.surConnexion();
    t.finLecture(pendant, [demande("per_1")]);
    assert.equal(t.etat(P1).fiable, false, "flux coupé pendant la lecture");
  });

  it("toute coupure (ou reconnexion annoncée) rend TOUS les dossiers non fiables ; le server.connected suivant n'y suffit pas", () => {
    const { t } = table();
    on(t, connecte());
    fiable(t, [], P1);
    fiable(t, [], P2);
    t.surConnexion();
    assert.deepEqual([t.etat(P1).fiable, t.etat(P2).fiable], [false, false]);
    on(t, connecte());
    assert.deepEqual([t.etat(P1).fiable, t.etat(P2).fiable], [false, false], "une reconnexion exige une nouvelle lecture");
    fiable(t, [], P1);
    assert.deepEqual([t.etat(P1).fiable, t.etat(P2).fiable], [true, false]);
  });

  it("libération vue sur le flux en cours : server.instance.disposed vide le dossier et le rend fiable, sans lecture", () => {
    const { t } = table();
    on(t, connecte());
    on(t, demandee("per_1"));
    on(t, evenement("server.instance.disposed", { directory: P1 }));
    assert.deepEqual(t.etat(P1), { fiable: true, demandes: [] });
    on(t, demandee("per_2"));
    assert.deepEqual(t.etat(P1).fiable, true);
    assert.deepEqual(ids(t), ["per_2"]);
  });

  it("libération vue AVANT l'ouverture du flux (ou flux coupé) : vidée, jamais fiable", () => {
    const { t } = table();
    on(t, demandee("per_1"));
    on(t, evenement("server.instance.disposed", { directory: P1 }));
    assert.deepEqual(t.etat(P1), { fiable: false, demandes: [] });
  });
});

describe("table des attentes : dérivation", () => {
  it("permission.asked ajoute ou remplace À SA PLACE (ordre d'opencode) ; permission.replied retire", () => {
    const { t } = table();
    on(t, connecte());
    fiable(t);
    on(t, demandee("per_1"));
    on(t, demandee("per_2"));
    on(t, demandee("per_1", { patterns: ["ls -la"] }));
    assert.deepEqual(ids(t), ["per_1", "per_2"], "remplacée à sa place");
    assert.deepEqual(t.etat(P1).demandes[0]?.patterns, ["ls -la"]);
    on(t, repondue("per_1"));
    assert.deepEqual(ids(t), ["per_2"]);
    assert.equal(t.etat(P1).fiable, true);
  });

  it("server.instance.disposed ne vide que SON dossier (propriété directory, sinon l'enveloppe)", () => {
    const { t } = table();
    on(t, connecte());
    fiable(t, [], P1);
    fiable(t, [], P2);
    on(t, demandee("per_1", {}, P1));
    on(t, demandee("per_2", {}, P2));
    on(t, evenement("server.instance.disposed", {}, P2));
    assert.deepEqual([ids(t, P1), ids(t, P2)], [["per_1"], []]);
  });

  it("global.disposed vide TOUTE l'instance ; « global » n'est jamais normalisé en dossier", () => {
    const { t } = table();
    on(t, connecte());
    on(t, demandee("per_1", {}, P1));
    on(t, demandee("per_2", {}, P2));
    on(t, evenement("global.disposed", {}, "global"));
    assert.deepEqual([t.etat(P1), t.etat(P2)], [
      { fiable: true, demandes: [] },
      { fiable: true, demandes: [] },
    ]);
    assert.equal(
      t.releve().some((d) => d.cle === "global" || d.cle === "/global"),
      false,
      "aucun dossier « global »",
    );
  });

  it("demande illisible (identifiant, permission, tool, motifs ou métadonnées hors bornes) : le dossier devient « incertain »", () => {
    const illisibles: Array<Record<string, unknown>> = [
      { id: "per x" },
      { sessionID: "" },
      { permission: "Web-Fetch" },
      { tool: { messageID: "msg a", callID: "c" } },
      { tool: "call_1" },
      { patterns: Array.from({ length: MOTIFS_MAX + 1 }, () => "x") },
      { patterns: ["x".repeat(5_000)] },
      { always: [1] },
      { metadata: "texte" },
      { metadata: { diff: "x".repeat(METADONNEES_MAX + 1) } },
    ];
    for (const over of illisibles) {
      const { t } = table();
      on(t, connecte());
      fiable(t);
      on(t, demandee("per_1", over));
      assert.equal(t.etat(P1).fiable, false, JSON.stringify(over).slice(0, 80));
      assert.equal(t.releve()[0]?.incertain, true);
    }
    // Réponse illisible : une demande pourrait rester à tort.
    const { t } = table();
    on(t, connecte());
    fiable(t, [demande("per_1")]);
    on(t, evenement("permission.replied", { requestID: 42 }));
    assert.equal(t.etat(P1).fiable, false);
    // Une lecture réussie lève le doute ; une libération aussi.
    fiable(t, [demande("per_1")]);
    assert.equal(t.etat(P1).fiable, true);
  });

  it("bornes : au-delà de TABLE_MAX_PAR_DOSSIER (ou d'une liste lue plus longue), le dossier est « incertain » ; au-delà de TABLE_MAX_PAR_INSTANCE aussi", () => {
    const { t } = table();
    on(t, connecte());
    fiable(t);
    for (let i = 0; i < TABLE_MAX_PAR_DOSSIER; i++) on(t, demandee(`per_${i}`));
    assert.equal(t.etat(P1).fiable, true, "à la borne : fiable");
    on(t, demandee("per_de_trop"));
    assert.equal(t.etat(P1).fiable, false, "au-delà : incertain");
    assert.equal(ids(t).includes("per_de_trop"), false);
    fiable(t, Array.from({ length: TABLE_MAX_PAR_DOSSIER + 1 }, (_, i) => demande(`per_${i}`)));
    assert.equal(t.etat(P1).fiable, false, "liste lue au-delà de la borne");

    const instance = table();
    on(instance.t, connecte());
    const dossiers = Math.ceil(TABLE_MAX_PAR_INSTANCE / TABLE_MAX_PAR_DOSSIER);
    for (let d = 0; d < dossiers; d++) {
      const dir = `/workspace/d${d}`;
      fiable(instance.t, [], dir);
      for (let i = 0; i < TABLE_MAX_PAR_DOSSIER; i++) on(instance.t, demandee(`per_${d}_${i}`, {}, dir));
    }
    fiable(instance.t, [], "/workspace/dernier");
    on(instance.t, demandee("per_x", {}, "/workspace/dernier"));
    assert.equal(instance.t.etat("/workspace/dernier").fiable, false, "borne de l'instance");
  });

  it("dossiers suivis bornés : au-delà de DOSSIERS_MAX, un dossier vide sort d'abord ; sinon le nouveau n'est pas suivi", () => {
    const { t } = table();
    on(t, connecte());
    for (let d = 0; d < DOSSIERS_MAX; d++) on(t, demandee(`per_${d}`, {}, `/workspace/d${d}`));
    on(t, demandee("per_n", {}, "/workspace/nouveau"));
    assert.deepEqual(t.etat("/workspace/nouveau"), { fiable: false, demandes: [] });
    assert.equal(t.releve().length, DOSSIERS_MAX);
  });

  it("autre instance : la table de la salle ignore un événement venu du processeur principal, et inversement", () => {
    const salle = createPendingTable({ instance: "omo", racine: RACINE, planifier: () => undefined });
    assert.deepEqual(salle.derivation.instances, ["omo"]);
    salle.derivation.onEvent(connecte(), { instance: "omo" });
    salle.derivation.onEvent(demandee("per_p"), { instance: "principale" });
    salle.derivation.onEvent(demandee("per_s"), { instance: "omo" });
    assert.deepEqual(ids(salle), ["per_s"]);
    const principale = createPendingTable({ racine: RACINE, planifier: () => undefined });
    assert.equal(principale.derivation.instances, undefined, "forme 1.0.x : champ absent pour l'instance principale");
    principale.derivation.onEvent(demandee("per_s"), { instance: "omo" });
    assert.deepEqual(ids(principale), []);
  });
});

describe("table des attentes : resynchronisation", () => {
  it("SANS COURSE : un événement reçu PENDANT la lecture est rejoué sur la liste lue (asked, replied, libération)", () => {
    const { t } = table();
    on(t, connecte());
    // Liste calculée par opencode AVANT l'arrivée de per_2 et de la réponse à per_1 : la table rejoue les deux.
    const lecture = t.debutLecture(P1);
    on(t, demandee("per_2"));
    on(t, repondue("per_1"));
    t.finLecture(lecture, [demande("per_1")]);
    assert.deepEqual(ids(t), ["per_2"]);
    assert.equal(t.etat(P1).fiable, true);
    // Libération pendant la lecture, puis une demande : vidé puis ajouté, dans l'ordre.
    const seconde = t.debutLecture(P1);
    on(t, evenement("server.instance.disposed", { directory: P1 }));
    on(t, demandee("per_3"));
    t.finLecture(seconde, [demande("per_2"), demande("per_vieille")]);
    assert.deepEqual(ids(t), ["per_3"]);
  });

  it("le rejeu ne touche QUE le dossier lu : une libération globale rejouée ne revide pas un autre dossier servi depuis", () => {
    const { t } = table();
    on(t, connecte());
    fiable(t, [], P2);
    const lecture = t.debutLecture(P1);
    on(t, evenement("global.disposed", {}, "global"));
    on(t, demandee("per_p2", {}, P2));
    on(t, evenement("server.instance.disposed", { directory: P2 }, P2));
    on(t, demandee("per_p2b", {}, P2));
    t.finLecture(lecture, [demande("per_p1")]);
    assert.deepEqual(ids(t, P2), ["per_p2b"], "P2 intact");
    assert.deepEqual(ids(t, P1), [], "P1 : liste lue puis libération globale rejouée");
  });

  it("PROACTIVE : à l'ouverture du flux pour chaque dossier connu, et à la première apparition d'un dossier (une fois par flux)", async () => {
    const { t, relectures, lancer } = table();
    on(t, demandee("per_1", {}, P1));
    on(t, connecte());
    lancer();
    assert.deepEqual(relectures, [P1], "dossier connu relu à l'ouverture");
    on(t, evenement("session.status", { sessionID: "ses_b", status: { type: "busy" } }, P2));
    on(t, evenement("session.idle", { sessionID: "ses_b" }, P2));
    on(t, evenement("session.status", { sessionID: "ses_r", status: { type: "busy" } }, RACINE));
    lancer();
    assert.deepEqual(relectures, [P1, P2, null], "P2 relu une fois ; la racine d'opencode relue sans dossier");
    t.surConnexion();
    on(t, evenement("session.status", { sessionID: "ses_b", status: { type: "idle" } }, P2));
    lancer();
    assert.deepEqual(relectures, [P1, P2, null], "flux coupé : aucune relecture");
    // Relectures précédentes terminées (une seule à la fois par dossier), puis réouverture : chaque dossier connu est relu.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(t.relecturesEnCours(), 0);
    on(t, connecte());
    assert.equal(t.relecturesEnCours(), 3);
    lancer();
    assert.deepEqual(new Set(relectures.slice(3)), new Set([P1, P2, null]));
  });

  it("une seule relecture proactive à la fois par dossier ; jamais pour « global »", () => {
    const travaux: Array<() => void> = [];
    let enCours = 0;
    let fin: () => void = () => undefined;
    const t = createPendingTable({ racine: RACINE, planifier: (w) => travaux.push(w) });
    t.poserRelecture(
      () =>
        new Promise<void>((resolve) => {
          enCours++;
          fin = resolve;
        }),
    );
    on(t, demandee("per_1"));
    on(t, connecte());
    on(t, connecte());
    travaux.splice(0).forEach((w) => w());
    assert.equal(enCours, 1);
    on(t, evenement("global.disposed", {}, "global"));
    assert.equal(travaux.length, 0);
    fin();
  });
});

describe("table des attentes : dossiers et formes", () => {
  it("normalisation comme le query.directory du portillon : racine → null, barre finale et « .. » résolus ; « global » intact", () => {
    assert.equal(cleDossier(null, RACINE), null);
    assert.equal(cleDossier("", RACINE), null);
    assert.equal(cleDossier("/workspace", RACINE), null);
    assert.equal(cleDossier("/workspace/", RACINE), null);
    assert.equal(cleDossier("/workspace/p1/", RACINE), P1);
    assert.equal(cleDossier("/workspace/x/../p1", RACINE), P1);
    assert.equal(cleDossier("/workspace/Remise 20%", RACINE), "/workspace/Remise 20%");
    assert.equal(cleDossier("global", RACINE), "global", "jamais résolu en chemin");
    const { t } = table();
    on(t, connecte());
    fiable(t, [], null);
    on(t, demandee("per_r", {}, "/workspace"));
    assert.deepEqual(ids(t, null), ["per_r"], "événement de la racine lu par gate.pending(null)");
    fiable(t, [], "/workspace/p1/");
    on(t, demandee("per_p", {}, P1));
    assert.deepEqual(ids(t, "/workspace/p1/"), ["per_p"]);
  });

  it("signature EXACTE du défaut (mesure D11) : 400 BadRequest, kind Body, message au format mesuré ; toute autre forme : null", () => {
    const corps = (message: string, over: Record<string, unknown> = {}) => ({ name: "BadRequest", data: { message, kind: "Body" }, ...over });
    const mesure = `Expected JSON value, got undefined${NL}  at [0]["metadata"]["timeout"]`;
    assert.deepEqual(defautDansCorps(400, corps(mesure)), { indice: 0, cle: "timeout" });
    assert.deepEqual(defautDansCorps(400, corps(`Expected JSON value, got undefined${NL}  at [12]["metadata"]["path"]`)), { indice: 12, cle: "path" });
    assert.equal(SIGNATURE_DEFAUT.test(mesure), true);
    const autres: Array<[number, unknown]> = [
      [500, corps(mesure)],
      [400, { ...corps(mesure), name: "NotFound" }],
      [400, { name: "BadRequest", data: { message: mesure, kind: "Query" } }],
      [400, corps(`Expected JSON value, got undefined at [0]["metadata"]["timeout"]`)],
      [400, corps(`${mesure} (extra)`)],
      [400, corps(`Expected JSON value, got undefined${NL}  at [0]["patterns"]["timeout"]`)],
      [400, corps(`Expected JSON value, got undefined${NL}  at [a]["metadata"]["timeout"]`)],
      [400, corps(`Expected JSON value, got undefined${NL}  at [0]["metadata"]["time-out"]`)],
      [400, "Bad Request"],
      [400, null],
    ];
    for (const [status, body] of autres) assert.equal(defautDansCorps(status, body), null, JSON.stringify(body).slice(0, 100));
  });

  it("premiereIllisible : comme opencode, première demande dont une clé facultative manque, dans l'ordre ; bash jamais", () => {
    assert.equal(premiereIllisible([demande("per_1"), demande("per_2", { permission: "bash", metadata: { command: "ls" } })]), null);
    assert.deepEqual(premiereIllisible([demande("per_1"), webSansDelai("per_w")]), { indice: 1, cle: "timeout" });
    assert.deepEqual(premiereIllisible([demande("per_g", { permission: "grep", metadata: { pattern: "TODO" } })]), { indice: 0, cle: "path" });
    assert.deepEqual(premiereIllisible([demande("per_g", { permission: "grep", metadata: { pattern: "TODO", path: "/workspace/p1" } })]), { indice: 0, cle: "include" });
    assert.equal(premiereIllisible([demande("per_w", { permission: "webfetch", metadata: { url: "u", format: "markdown", timeout: 30 } })]), null);
  });

  it("METADONNEES_FACULTATIVES : identique au faux opencode (mesure D11), bash absent", () => {
    assert.deepEqual(
      Object.fromEntries(Object.entries(METADONNEES_FACULTATIVES).map(([k, v]) => [k, [...v]])),
      Object.fromEntries(Object.entries(METADONNEES_DU_FAUX).map(([k, v]) => [k, [...v]])),
    );
    assert.equal(Object.hasOwn(METADONNEES_FACULTATIVES, "bash"), false);
  });

  it("lireDemande : copie validée (aucune référence gardée) ; auFormatOpencode rend la forme de GET /permission", () => {
    const brute = webSansDelai("per_w");
    const lue = lireDemande(brute);
    assert.ok(lue);
    (brute.metadata as Record<string, unknown>).url = "modifiée";
    assert.equal(lue.metadata.url, "https://exemple.test");
    assert.deepEqual(auFormatOpencode(lue), {
      id: "per_w",
      sessionID: "ses_a",
      permission: "webfetch",
      patterns: ["https://exemple.test"],
      metadata: { url: "https://exemple.test", format: "markdown" },
      always: ["ls *"],
      tool: { messageID: "msg_a", callID: "call_per_w" },
    });
    assert.deepEqual(Object.keys(auFormatOpencode({ ...lue, tool: null })).includes("tool"), false, "sans appel d'outil : champ absent");
  });
});

describe("page de chat et phrases : avertissement au lieu d'une liste vide (D11 §6.4)", () => {
  it("avertissementDeLecture : 503 « liste-bloquee » du proxy → outil nommé ; toute autre erreur → phrase sans cause ; jamais « opencode ne répond pas » pour la liste bloquée", () => {
    const bloquee = (outil: unknown) => ({ status: 503, code: "liste-bloquee", data: { error: "liste-bloquee", outil } });
    assert.equal(
      avertissementDeLecture(bloquee("web")),
      "Liste des demandes d'autorisation illisible : une demande web en attente l'en empêche. Refusez-la si elle est affichée ; sinon, arrêtez les réponses en cours, puis Diagnostic › Redémarrer opencode.",
    );
    assert.equal(avertissementDeLecture(bloquee("fichiers")), TEXTES.partout.avertissement.fichiers);
    assert.equal(avertissementDeLecture(bloquee("autre")), TEXTES.partout.avertissement.autre);
    for (const autre of [bloquee("inconnu"), { status: 502, code: "http" }, { status: 0, code: "network" }, new Error("x"), null, "texte"]) {
      assert.equal(avertissementDeLecture(autre), TEXTES.partout.avertissement.inconnue, JSON.stringify(autre));
    }
    assert.equal(outilDeCle("timeout"), "web");
    assert.equal(outilDeCle("contextMaxCharacters"), "web");
    assert.deepEqual([outilDeCle("path"), outilDeCle("include")], ["fichiers", "fichiers"]);
    assert.equal(outilDeCle("autreCle"), "autre");
    assert.equal(
      phraseListeBloquee("web"),
      "Une demande web en attente empêche opencode de lister ses demandes : refusez-la, puis réessayez. Si elle n'est pas affichée, arrêtez les réponses en cours, puis Diagnostic › Redémarrer opencode. Rien n'a été envoyé.",
    );
    for (const phrase of [PERMISSION_MESSAGES.listeBloquee, phraseListeBloquee("fichiers"), phraseListeBloquee("autre")]) {
      assert.notEqual(phrase, PERMISSION_MESSAGES.verificationImpossible);
      assert.notEqual(phrase, verificationImpossible());
      assert.doesNotMatch(phrase, /ne répond pas/);
    }
  });

  it("reste D11 (pré-publication 1.1.0) : demandesEnCause garde les seules demandes illisibles connues, dans l'ordre, bornées ; bash jamais", () => {
    const lues = [demande("per_b1"), webSansDelai("per_w1"), demande("per_g1", { permission: "glob", patterns: ["*"], metadata: { pattern: "*" } }), webSansDelai("per_w2")]
      .map((brut) => lireDemande(brut))
      .filter((d) => d !== null);
    assert.deepEqual(
      demandesEnCause(lues).map((d) => d.id),
      ["per_w1", "per_g1", "per_w2"],
    );
    const complet = lireDemande(demande("per_w3", { permission: "webfetch", metadata: { url: "https://exemple.test", format: "markdown", timeout: 30 } }));
    assert.ok(complet);
    assert.deepEqual(demandesEnCause([complet]), [], "webfetch avec délai : encodable, jamais « en cause »");
    const beaucoup = Array.from({ length: EN_CAUSE_MAX + 5 }, (_, i) => lireDemande(webSansDelai(`per_w${i}`))).filter((d) => d !== null);
    assert.equal(demandesEnCause(beaucoup).length, EN_CAUSE_MAX);
  });

  it("reste D11 : demandesDeLecture ne lit que le 503 « liste-bloquee » et ses entrées bien formées (bornées, copiées) ; toute autre erreur : rien", () => {
    const servie = auFormatOpencode(lireDemande(webSansDelai("per_w1")) as NonNullable<ReturnType<typeof lireDemande>>);
    const erreur = (demandes: unknown, over: Record<string, unknown> = {}) => ({
      status: 503,
      code: "liste-bloquee",
      data: { error: "liste-bloquee", outil: "web", message: phraseListeIllisible("web"), demandes },
      ...over,
    });
    assert.deepEqual(demandesDeLecture(erreur([servie])), [servie]);
    const lue = demandesDeLecture(erreur([servie]))[0];
    assert.notEqual(lue?.metadata, servie.metadata, "copie : aucune référence gardée");
    for (const autre of [erreur([servie], { status: 502 }), erreur([servie], { code: "http" }), erreur("x"), erreur(undefined), null, "texte", new Error("x")]) {
      assert.deepEqual(demandesDeLecture(autre), [], JSON.stringify(autre));
    }
    const malFormees = [
      { ...servie, id: "../x" },
      { ...servie, sessionID: 5 },
      { ...servie, permission: "Web Fetch" },
      { ...servie, patterns: [1] },
      { ...servie, always: "*" },
      null,
      "per_x",
    ];
    assert.deepEqual(demandesDeLecture(erreur([...malFormees, servie])), [servie], "entrée mal formée ignorée, jamais inventée");
    const sansOutil = demandesDeLecture(erreur([{ ...servie, tool: { messageID: "msg a", callID: "" } }]))[0];
    assert.equal(sansOutil !== undefined && "tool" in sansOutil, false, "appel d'outil illisible : champ absent");
    assert.equal(demandesDeLecture(erreur(Array.from({ length: 50 }, () => servie))).length, EN_CAUSE_MAX);
  });

  it("reste D11 : chaque phrase qui nomme la demande en cause dit le recours quand elle n'est pas affichée (Arrêter, puis Redémarrer opencode)", () => {
    const recours = "arrêtez les réponses en cours, puis Diagnostic › Redémarrer opencode";
    for (const outil of ["web", "fichiers", "autre"] as const) {
      for (const phrase of [TEXTES.partout.bloquee[outil], TEXTES.partout.listeIllisible[outil], TEXTES.partout.avertissement[outil]]) {
        assert.ok(phrase.includes(recours), phrase);
        assert.doesNotMatch(phrase, /rechargez dans un instant/, "tant que la demande attend, aucune lecture ne réussit");
      }
    }
    assert.equal(TEXTES.partout.avertissement.inconnue, "Liste des demandes d'autorisation illisible : rechargez dans un instant.");
  });

  it("ChatPage.tsx : un échec de la liste n'est plus ignoré en silence — avertissement non bloquant affiché, liste gardée", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "..", "web", "pages", "ChatPage.tsx"), "utf8");
    const compact = source.replace(/\s+/g, " ");
    assert.ok(
      compact.includes(
        'if (perms.status === "fulfilled") { setPermissions(perms.value); setListeIllisible(null); } else { setListeIllisible(avertissementDeLecture(perms.reason)); const enCause = demandesDeLecture(perms.reason) as unknown as PermissionRequest[]; if (enCause.length > 0) setPermissions((list) => enCause.reduce(upsertById, list)); }',
      ),
      "échec de la liste : avertissement posé et demandes en cause AJOUTÉES à celles déjà affichées (jamais la liste remplacée) ; réussite : levé",
    );
    assert.ok(compact.includes('listeIllisible !== null ? ( <div className="callout warning small" role="status" data-liste-illisible="">'), "avertissement rendu");
    assert.ok(compact.includes("|| listeIllisible !== null ? ("), "affiché même sans demande connue");
    assert.equal(compact.includes('if (perms.status === "fulfilled") setPermissions(perms.value);'), false, "plus d'échec avalé");
  });
});
